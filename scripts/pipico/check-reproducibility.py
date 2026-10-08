#!/usr/bin/env python3
r"""Compare clean Pipico builds across paths and controlled compiler dates.

Requires the pinned Arm toolchain on PATH, a complete PICO_SDK_PATH checkout,
and PICOTOOL_DIR. Run from a clean, committed, full-history source checkout:

    python3 scripts/pipico/check-reproducibility.py \
        --work-dir /tmp/pipico-repro-work \
        --output-dir /tmp/pipico-repro-evidence

Both directories must be new and disjoint. Independent local git clones copy
committed source objects, never worktree changes or build products. Every
configuration builds its own companion-OFF budget baseline before companion-ON.
The five configurations (ten firmware builds) are patched A/day1, patched
B/day1, patched B/day2, and unpatched B/day1 and B/day2. B is re-created at
identical absolute paths between configurations, isolating the date variable.
All logs and evidence survive failures; only this run's B worktree is replaced.
Security/host/emulation suites remain separate gates in the experiment CI.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time


PICO_SDK_SHA = "079c6f39023649b154152db30f1d781e884879bc"
TINYUSB_SHA = "86ad6e56c1700e85f1c5678607a762cfe3aa2f47"
PICOTOOL_SHA = "2041936441b48a3cc53ae3da9e805229fe8f4e18"
DEPS = {
    "mbedtls": ("068ff080b369adfac81509f9b57b2afabaf82dc5",
                "https://github.com/Mbed-TLS/mbedtls.git", "v3.6.7"),
    "tinycbor": ("c0aad2fb2137a31b9845fbaae3653540c410f215",
                 "https://github.com/intel/tinycbor.git", "v0.6.1"),
}
ARTIFACTS = ("pico_fido.uf2", "pico_fido.bin", "pico_fido.elf")
DAYS = (dt.datetime(2026, 10, 7, 12, tzinfo=dt.timezone.utc),
        dt.datetime(2026, 10, 8, 12, tzinfo=dt.timezone.utc))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


class Experiment:
    def __init__(self, args):
        self.source = args.source_dir.resolve()
        self.work = args.work_dir.resolve()
        self.output = args.output_dir.resolve()
        self.sdk_seed = Path(os.environ["PICO_SDK_PATH"]).resolve()
        self.picotool = Path(os.environ["PICOTOOL_DIR"]).resolve() / "picotool"
        for path in (self.work, self.output):
            require(not path.exists(), f"directory must not already exist: {path}")
        for left, right in ((self.work, self.output), (self.work, self.source),
                            (self.work, self.sdk_seed), (self.output, self.source),
                            (self.output, self.sdk_seed)):
            require(not left.is_relative_to(right) and not right.is_relative_to(left),
                    f"unsafe overlapping directories: {left} and {right}")
        self.output.mkdir(parents=True)
        self.work.mkdir(parents=True)
        self.env = os.environ.copy()
        self.env.update({"LC_ALL": "C", "TZ": "UTC", "CCACHE_DISABLE": "1"})
        self.env.pop("SOURCE_DATE_EPOCH", None)
        self.manifest = {"schema": 1, "status": "running", "variants": [],
                         "comparisons": [], "work_dir": str(self.work),
                         "output_dir": str(self.output),
                         "scope": "pinned RP2040 firmware; host/security suites are separate CI gates"}
        self.dep_seeds = {}
        self.source_ref = args.source_ref

    def run(self, argv, *, cwd=None, env=None, log=None, stdin=None):
        argv = [str(arg) for arg in argv]
        active_env = env or self.env
        record = {"argv": argv, "cwd": str(cwd) if cwd else None,
                  "SOURCE_DATE_EPOCH": active_env.get("SOURCE_DATE_EPOCH"),
                  "TZ": active_env["TZ"], "log": str(log) if log else None}
        with (self.output / "commands.jsonl").open("a") as stream:
            stream.write(json.dumps(record) + "\n")
        if log:
            with Path(log).open("w") as stream:
                result = subprocess.run(argv, cwd=cwd, env=active_env, input=stdin,
                                        text=True, stdout=stream, stderr=subprocess.STDOUT)
            output = Path(log).read_text(errors="replace")
        else:
            result = subprocess.run(argv, cwd=cwd, env=active_env, input=stdin,
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            output = result.stdout
            with (self.output / "setup.log").open("a") as stream:
                stream.write(f"$ {shlex.join(argv)}\n" + output.replace("\0", "\n") + "\n")
        require(result.returncode == 0,
                f"command exited {result.returncode}: {shlex.join(argv)}\n"
                + "\n".join(output.splitlines()[-25:]))
        return output

    def git(self, repo, *args):
        return self.run(["git", "-C", repo, *args])

    def state(self, repo, *, untracked=False, recursive=True):
        status = self.git(repo, "status", "--porcelain=v1",
                          "--untracked-files=all" if untracked else "--untracked-files=no",
                          "--ignore-submodules=untracked")
        require(not status, f"source checkout is not clean: {repo}\n{status}")
        state = {"sha": self.git(repo, "rev-parse", "HEAD").strip(),
                 "shallow": self.git(repo, "rev-parse", "--is-shallow-repository").strip(),
                 "tracked_status": status}
        if recursive:
            modules = self.git(repo, "submodule", "status", "--recursive")
            require(all(line.startswith(" ") for line in modules.splitlines()),
                    f"missing, conflicted, or mismatched recursive gitlinks: {repo}\n{modules}")
            state["recursive_submodules"] = modules
            # A superproject alone can hide nested worktree edits.
            for module_path, _ in self.gitlinks(repo):
                self.state(repo / module_path, untracked=untracked)
        return state

    def gitlinks(self, repo):
        entries = self.git(repo, "ls-tree", "-r", "-z", "HEAD").split("\0")
        return [(entry.split("\t", 1)[1], entry.split()[2])
                for entry in entries if entry.startswith("160000 ")]

    def clone(self, seed, destination, sha, *, recursive=True):
        require((seed / ".git").exists(), f"initialize the source checkout first: {seed}")
        self.git(seed, "cat-file", "-e", f"{sha}^{{commit}}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.run(["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", seed, destination])
        self.git(destination, "checkout", "--quiet", "--detach", sha)
        require(not (destination / ".git/objects/info/alternates").exists(),
                f"clone unexpectedly shares an object store: {destination}")
        if recursive:
            self.git(destination, "submodule", "init")
            for module_path, module_sha in self.gitlinks(destination):
                self.clone(seed / module_path, destination / module_path, module_sha)
        state = self.state(destination, untracked=True, recursive=recursive)
        require(state["sha"] == sha, f"clone SHA changed: {destination}")
        return state

    def preflight(self):
        source_state = self.state(self.source)
        require(source_state["shallow"] == "false", "full source history is required (fetch-depth: 0)")
        self.sha = self.git(self.source, "rev-parse", "--verify", f"{self.source_ref}^{{commit}}").strip()
        self.build_number = self.git(self.source, "rev-list", "--count", self.sha).strip()
        link = self.git(self.source, "ls-tree", self.sha, "pico-keys-sdk").split()
        require(len(link) >= 4 and link[0] == "160000", "pico-keys-sdk gitlink missing")
        self.keys_sha = link[2]
        sdk_state = self.state(self.sdk_seed)
        require(sdk_state["sha"] == PICO_SDK_SHA, "PICO_SDK_PATH is not the pinned 2.3.1 SHA")
        require(self.git(self.sdk_seed / "lib/tinyusb", "rev-parse", "HEAD").strip() == TINYUSB_SHA,
                "Pico SDK TinyUSB gitlink differs from the pinned tuple")
        gcc = self.run(["arm-none-eabi-gcc", "--version"]).splitlines()[0]
        require(self.run(["arm-none-eabi-gcc", "-dumpfullversion", "-dumpversion"]).strip() == "13.2.1"
                and "20231009" in gcc, f"wrong Arm GNU 13.2.Rel1 compiler: {gcc}")
        picotool = self.run([self.picotool, "version"]).strip()
        require(re.search(r"\bv?2\.3\.1\b", picotool), f"wrong picotool version: {picotool}")
        tools = {"gcc": gcc, "picotool": picotool, "picotool_sha256": digest(self.picotool),
                 "gcc_sha256": digest(shutil.which("arm-none-eabi-gcc")),
                 "cmake": self.run(["cmake", "--version"]).splitlines()[0],
                 "ninja": self.run(["ninja", "--version"]).strip(),
                 "python": sys.version.splitlines()[0]}
        if os.environ.get("PICOTOOL_SOURCE_PATH"):
            state = self.state(Path(os.environ["PICOTOOL_SOURCE_PATH"]).resolve(), recursive=False)
            require(state["sha"] == PICOTOOL_SHA, "picotool source SHA differs from pinned tuple")
            tools["picotool_source"] = state
        self.manifest.update({"source_sha": self.sha, "source_input": source_state,
                              "pico_keys_sdk_sha": self.keys_sha, "pico_sdk_input": sdk_state,
                              "git_ancestry_count": int(self.build_number), "tools": tools,
                              "dates": [], "environment": {"LC_ALL": "C", "TZ": "UTC",
                                                            "CCACHE_DISABLE": "1"}})
        for index, date in enumerate(DAYS):
            env = self.date_env(index)
            probe = self.run(["arm-none-eabi-gcc", "-E", "-P", "-x", "c", "-"], env=env,
                             stdin="const char date[] = __DATE__;\nconst char time[] = __TIME__;\n",
                             log=self.output / f"date-probe-{index + 1}.txt")
            expected_date = f"Oct {date.day:2d} {date.year}"
            require(f'"{expected_date}"' in probe and '"12:00:00"' in probe,
                    f"compiler does not honor SOURCE_DATE_EPOCH for date {date.isoformat()}")
            self.manifest["dates"].append({"utc": date.isoformat(), "macro_date": expected_date,
                                           "macro_time": "12:00:00",
                                           "SOURCE_DATE_EPOCH": env["SOURCE_DATE_EPOCH"]})
        for name in DEPS:
            seed = self.source / "pico-keys-sdk/third-party" / name
            if (seed / ".git").exists():
                self.dep_seeds[name] = seed

    def date_env(self, index):
        return {**self.env, "SOURCE_DATE_EPOCH": str(int(DAYS[index].timestamp()))}

    def provision_deps(self, source):
        for name, seed in self.dep_seeds.items():
            sha, url, ref = DEPS[name]
            require(self.state(seed, recursive=False)["sha"] == sha,
                    f"local {name} source does not match the pinned tuple")
            destination = source / "pico-keys-sdk/third-party" / name
            self.clone(seed, destination, sha, recursive=False)
            # This marker is deps.cmake's documented input cache identity.
            (destination / ".picokeys_dep_source").write_text(f"REPO={url}\nREF={ref}\n")

    def effective_flags(self, source, sdk, build, output, reproducible):
        entries = json.loads((build / "compile_commands.json").read_text())
        require(entries, "compile_commands.json contains no translation units")
        expected_maps = [f"-ffile-prefix-map={source}=.",
                         f"-ffile-prefix-map={sdk}=./pico-sdk",
                         f"-ffile-prefix-map={build}=./build"] if reproducible else []
        expected_date = ["-DPICO_NO_BI_PROGRAM_BUILD_DATE=1"] if reproducible else []
        counts, macro_maps, build_numbers = {}, {}, 0
        fido_build_number = False
        for entry in entries:
            args = entry.get("arguments") or shlex.split(entry["command"])
            filename = entry["file"]
            suffix = Path(filename).suffix.lower()
            require(suffix in (".c", ".cc", ".cpp", ".cxx", ".s", ".asm"),
                    f"unrecognized translation-unit language: {filename}")
            counts[suffix] = counts.get(suffix, 0) + 1
            maps = [arg for arg in args if arg.startswith("-ffile-prefix-map=")]
            dates = [arg for arg in args if arg.startswith("-DPICO_NO_BI_PROGRAM_BUILD_DATE")]
            require(maps == expected_maps and dates == expected_date,
                    f"effective reproducibility flags differ in {filename}: maps={maps}, date={dates}")
            # Preserve and report the SDK's existing macro-only path mapping.
            for arg in args:
                if arg.startswith("-fmacro-prefix-map="):
                    macro_maps[arg] = macro_maps.get(arg, 0) + 1
            numbers = [arg for arg in args if arg.startswith("-DPICO_BUILD_NUMBER=")]
            if numbers:
                require(numbers == [f"-DPICO_BUILD_NUMBER={self.build_number}"],
                        f"effective git-derived build number differs in {filename}: {numbers}")
                build_numbers += 1
                if Path(filename).is_relative_to(source / "src/fido"):
                    fido_build_number = True
        require(fido_build_number, "no FIDO TU proves the expected full-history PICO_BUILD_NUMBER")
        report = {"translation_units": len(entries), "by_suffix": counts,
                  "file_prefix_maps": expected_maps, "date_definitions": expected_date,
                  "all_translation_units_match": True, "existing_macro_prefix_maps": macro_maps,
                  "build_number": int(self.build_number), "build_number_tus": build_numbers,
                  "fido_build_number_verified": fido_build_number}
        write_json(output / "effective-flags.json", report)
        return report

    def metadata(self, build, output, env, reproducible, day):
        entries = json.loads((build / "compile_commands.json").read_text())
        matches = [entry for entry in entries
                   if Path(entry["file"]).name == "standard_binary_info.c"]
        require(len(matches) == 1, "expected exactly one Pico SDK standard_binary_info.c command")
        entry = matches[0]
        args = entry.get("arguments") or shlex.split(entry["command"])
        # Replay the actual TU's compiler and flags; remove output/dependency
        # generation so this probe cannot change any build artifacts.
        filtered = []
        skip = False
        for arg in args:
            if skip:
                skip = False
            elif arg in ("-o", "-MF", "-MT", "-MQ"):
                skip = True
            elif arg not in ("-c", "-MD", "-MMD", "-MP"):
                filtered.append(arg)
        preprocessed = self.run([*filtered, "-E", "-P"], cwd=entry["directory"], env=env,
                                log=output / "standard-binary-info.i")
        macro_date = self.manifest["dates"][day]["macro_date"]
        macro_present = f'"{macro_date}"' in preprocessed
        require(macro_present == (not reproducible),
                "SDK metadata TU did not omit/retain the expected controlled date")
        metadata = self.run([self.picotool, "info", "-a", build / "pico_fido.uf2"], env=env,
                            log=output / "picotool-info.txt")
        dates = re.findall(r"^\s*build date:\s*(.*?)\s*$", metadata, re.MULTILINE | re.IGNORECASE)
        require(dates == ([] if reproducible else [macro_date]),
                f"unexpected decoded firmware build date: {dates}")
        return {"preprocessed_date_present": macro_present, "decoded_build_dates": dates}

    def variant(self, name, slot_name, day, reproducible):
        print(f"pipico-repro: {name}: fresh sources and two gated firmware builds", flush=True)
        started = time.monotonic()
        slot = self.work / slot_name
        if slot.exists():
            require(slot.parent == self.work and not slot.is_symlink(), "refusing unsafe worktree removal")
            shutil.rmtree(slot)
        slot.mkdir()
        if slot_name == "a":
            source, sdk, objects = slot / "src", slot / "sdk", slot / "obj"
        else:
            source = slot / "source-with-extra-components/pico-fido"
            sdk = slot / "another-independent-sdk-root/pico-sdk"
            objects = slot / "build-directory-with-a-different-length"
        build, baseline = objects / "firmware", objects / "baseline"
        evidence = self.output / name
        evidence.mkdir()
        record = {"name": name, "status": "running", "reproducible": reproducible,
                  "day": day + 1, "paths": {"source": str(source), "pico_sdk": str(sdk),
                                            "build": str(build), "baseline": str(baseline)}}
        self.manifest["variants"].append(record)
        self.save()
        record["fresh_source"] = self.clone(self.source, source, self.sha)
        record["fresh_pico_sdk"] = self.clone(self.sdk_seed, sdk, PICO_SDK_SHA)
        require(record["fresh_source"]["shallow"] == "false", "experiment clone is shallow")
        record["git_ancestry_count"] = int(self.git(source, "rev-list", "--count", "HEAD").strip())
        require(record["git_ancestry_count"] == int(self.build_number), "git build number changed")
        require(self.git(source / "pico-keys-sdk", "rev-parse", "HEAD").strip() == self.keys_sha,
                "pico-keys-sdk gitlink changed")
        self.provision_deps(source)
        env = {**self.date_env(day), "PICO_SDK_PATH": str(sdk),
               "PIPICO_BASELINE_BUILD_DIR": str(baseline)}
        flag = f"-DPIPICO_REPRODUCIBLE_BUILD={'ON' if reproducible else 'OFF'}"
        for label, directory, companion in (("baseline", baseline, "OFF"), ("firmware", build, "ON")):
            destination = evidence / label
            destination.mkdir()
            self.run(["bash", source / "scripts/pipico/build.sh", flag, f"-DPIPICO_COMPANION={companion}"],
                     cwd=source, env={**env, "PIPICO_BUILD_DIR": str(directory)},
                     log=destination / "build-gates.log")
            for name_, (sha, _, _) in DEPS.items():
                dep = source / "pico-keys-sdk/third-party" / name_
                require(self.state(dep, recursive=False)["sha"] == sha,
                        f"resolved {name_} SHA differs from pinned tuple")
                self.dep_seeds.setdefault(name_, dep)
            self.state(source)
            self.state(sdk)
            for filename in (*ARTIFACTS, "compile_commands.json", "CMakeCache.txt",
                             "pipico-build-tuple.txt", "pipico-configure.log", "pipico-build.log",
                             "pico_fido.elf.map"):
                require((directory / filename).is_file(), f"missing build output: {directory / filename}")
                shutil.copy2(directory / filename, destination / filename)
            info = {"artifacts": {}}
            record[label] = info
            for filename in ARTIFACTS:
                artifact = destination / filename
                info["artifacts"][filename] = {"sha256": digest(artifact), "size": artifact.stat().st_size}
            self.save()
            info["effective_flags"] = self.effective_flags(source, sdk, directory, destination, reproducible)
            info["metadata"] = self.metadata(directory, destination, env, reproducible, day)
            for filename in ARTIFACTS:
                if reproducible:
                    content = (destination / filename).read_bytes()
                    for path in (source, sdk, directory):
                        require(str(path).encode() not in content,
                                f"absolute input root remains in {name}/{label}/{filename}: {path}")
            self.run([sys.executable, source / "scripts/pipico/check-clock.py", directory], env=env,
                     log=destination / "clock-report.txt")
            self.run([sys.executable, source / "scripts/pipico/check-image-bounds.py", directory], env=env,
                     log=destination / "image-bounds-report.json")
            if companion == "ON":
                self.run(["bash", source / "scripts/pipico/check-budget.sh"],
                         env={**env, "PIPICO_BUILD_DIR": str(directory)},
                         log=destination / "budget-report.txt")
            self.save()
        record["resolved_dependencies"] = {
            key: self.state(source / "pico-keys-sdk/third-party" / key, recursive=False) for key in DEPS}
        record.update({"status": "passed", "elapsed_seconds": round(time.monotonic() - started, 2)})
        self.save()
        print(f"pipico-repro: {name}: passed ({record['elapsed_seconds']} s)", flush=True)

    def compare(self, left, right, *, identical):
        comparisons = []
        for label in ("baseline", "firmware"):
            for filename in ARTIFACTS:
                a = (self.output / left / label / filename).read_bytes()
                b = (self.output / right / label / filename).read_bytes()
                same = a == b
                differences = sum(x != y for x, y in zip(a, b)) + abs(len(a) - len(b))
                comparisons.append({"file": f"{label}/{filename}", "byte_identical": same,
                                    "different_bytes_including_length": differences})
        result = {"left": left, "right": right, "expected_identical": identical, "files": comparisons}
        self.manifest["comparisons"].append(result)
        self.save()
        require(all(item["byte_identical"] == identical for item in comparisons),
                f"unexpected binary comparison: {left} versus {right}; see manifest.json")

    def save(self):
        write_json(self.output / "manifest.json", self.manifest)
        lines = []
        for variant in self.manifest["variants"]:
            for label in ("baseline", "firmware"):
                for filename, entry in variant.get(label, {}).get("artifacts", {}).items():
                    lines.append(f"{entry['sha256']}  {variant['name']}/{label}/{filename}")
        (self.output / "SHA256SUMS").write_text("\n".join(lines) + ("\n" if lines else ""))

    def execute(self):
        try:
            self.preflight()
            long_slot = "directory-with-a-deliberately-longer-name"
            self.variant("patched-a-day1", "a", 0, True)
            self.variant("patched-b-day1", long_slot, 0, True)
            self.compare("patched-a-day1", "patched-b-day1", identical=True)
            self.variant("patched-b-day2", long_slot, 1, True)
            self.compare("patched-b-day1", "patched-b-day2", identical=True)
            self.variant("control-b-day1", long_slot, 0, False)
            self.variant("control-b-day2", long_slot, 1, False)
            self.compare("control-b-day1", "control-b-day2", identical=False)
            self.manifest["status"] = "passed"
            self.save()
            print(f"pipico-repro: PASS; evidence: {self.output}", flush=True)
        except BaseException as error:
            self.manifest.update({"status": "failed", "error": str(error)})
            self.save()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--source-ref", default="HEAD", help="committed source ref available in --source-dir")
    parser.add_argument("--work-dir", type=Path, required=True, help="new directory for owned disposable worktrees")
    parser.add_argument("--output-dir", type=Path, required=True, help="new directory for retained evidence")
    args = parser.parse_args()
    try:
        for key in ("PICO_SDK_PATH", "PICOTOOL_DIR"):
            require(os.environ.get(key), f"{key} is required")
        Experiment(args).execute()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"pipico-repro: FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
