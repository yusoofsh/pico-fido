#!/usr/bin/env python3
"""Pipico clock gate (architecture.md section 5).

Verifies, from the compile_commands.json of a Pipico build:

  - the clocks resolved by the hardware_clocks/clocks.c translation unit:
    SYS_CLK_HZ is 125000000, PICO_USE_FASTEST_SUPPORTED_CLOCK is 0 and
    USB_CLK_HZ is 48000000. The macros are read by preprocessing clocks.c
    with -dM -E using that TU's own command from compile_commands.json;
  - no translation unit carries a -DSYS_CLK_* override or a
    -DPICO_USE_FASTEST_SUPPORTED_CLOCK=1 override;
  - every translation unit defines PICO_FLASH_SIZE_LIMIT_BYTES=0x200000
    and FORCE_BUTTON_WAIT. Command-line -D/-U flags (attached and
    two-token forms) are processed in order per TU with the last one
    winning, so a -U cannot hide behind an earlier -D of the same macro.

Python stdlib only. Exit code 0 = pass, 1 = gate failure.

Usage: check-clock.py [--self-test] [BUILD_DIR]

BUILD_DIR defaults to $PIPICO_BUILD_DIR, then ./build-pipico.
"""

import json
import os
import re
import shlex
import subprocess
import sys

CLOCKS_TU_SUFFIX = "hardware_clocks/clocks.c"
EXPECTED_SYS_CLK_HZ = 125000000
EXPECTED_USB_CLK_HZ = 48000000
EXPECTED_FASTEST_CLOCK = 0
EXPECTED_CAP = 0x200000

# Preprocessor flags that only affect code generation or depfiles and must
# not leak into the -dM -E run.
STRIP_FLAGS = {"-c", "-MD", "-MMD", "-MG", "-MP"}
STRIP_WITH_VALUE = {"-o", "-MF", "-MT", "-MQ"}


def fail_messages(errors):
    return ["check-clock: FAIL: " + e for e in errors]


def tu_arguments(entry):
    """Return the argument list of a compile_commands.json entry."""
    args = entry.get("arguments")
    if args:
        return [str(a) for a in args]
    return shlex.split(entry["command"])


def tu_defines(args):
    """Parse -D/-U flags from an argument list into {name: value_or_None}.

    Both the attached (-DX, -UX) and the two-token (-D X, -U X) forms are
    processed in command order, so the result is the effective macro set
    the compiler sees: the last -D or -U for a macro wins, and a -U
    removes a definition made earlier on the same command line.
    """
    defines = {}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-D", "-U"):
            flag = arg
            i += 1
            if i >= len(args):
                break
            token = args[i]
        elif arg.startswith("-D") or arg.startswith("-U"):
            flag = arg[:2]
            token = arg[2:]
        else:
            i += 1
            continue
        if flag == "-U":
            defines.pop(token, None)
        else:
            name, sep, value = token.partition("=")
            defines[name] = value if sep else None
        i += 1
    return defines


def as_int(text):
    """Parse a C integer literal (decimal or 0x...), ignoring quotes."""
    t = text.strip().strip('"').strip("'")
    try:
        return int(t, 0)
    except ValueError:
        return None


def scan_tus(entries):
    """Check every TU for the required defines and forbidden overrides."""
    errors = []
    cap_missing = []
    cap_wrong = []
    wait_missing = []
    overrides = []
    for entry in entries:
        name = entry.get("file", "?")
        defines = tu_defines(tu_arguments(entry))
        if "PICO_FLASH_SIZE_LIMIT_BYTES" not in defines:
            cap_missing.append(name)
        else:
            cap = as_int(defines["PICO_FLASH_SIZE_LIMIT_BYTES"] or "")
            if cap != EXPECTED_CAP:
                cap_wrong.append("%s (%s)" % (name, defines["PICO_FLASH_SIZE_LIMIT_BYTES"]))
        if "FORCE_BUTTON_WAIT" not in defines:
            wait_missing.append(name)
        for dname, dvalue in defines.items():
            if dname.startswith("SYS_CLK_"):
                overrides.append("%s: -D%s%s" % (name, dname, "" if dvalue is None else "=" + dvalue))
            elif dname == "PICO_USE_FASTEST_SUPPORTED_CLOCK":
                val = as_int(dvalue or "")
                if dvalue is None or val != 0:
                    overrides.append("%s: -D%s%s" % (name, dname, "" if dvalue is None else "=" + dvalue))
    if cap_missing:
        errors.append("PICO_FLASH_SIZE_LIMIT_BYTES missing from %d TU(s): %s" % (
            len(cap_missing), ", ".join(cap_missing[:3]) + ("..." if len(cap_missing) > 3 else "")))
    if cap_wrong:
        errors.append("PICO_FLASH_SIZE_LIMIT_BYTES != 0x200000 in %d TU(s): %s" % (
            len(cap_wrong), "; ".join(cap_wrong[:3]) + ("..." if len(cap_wrong) > 3 else "")))
    if wait_missing:
        errors.append("FORCE_BUTTON_WAIT missing from %d TU(s): %s" % (
            len(wait_missing), ", ".join(wait_missing[:3]) + ("..." if len(wait_missing) > 3 else "")))
    if overrides:
        errors.append("forbidden clock override(s) in %d TU(s): %s" % (
            len(overrides), "; ".join(overrides[:3]) + ("..." if len(overrides) > 3 else "")))
    return errors


def parse_defines(dm_text):
    """Parse `#define NAME VALUE` lines from a -dM preprocessor dump."""
    defines = {}
    for line in dm_text.splitlines():
        m = re.match(r"^#define\s+(\S+)\s+(.*)$", line)
        if m:
            defines[m.group(1)] = m.group(2).strip()
    return defines


def _paren_wraps_whole(t):
    depth = 0
    for i, ch in enumerate(t):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(t) - 1:
                return False
    return depth == 0


def _split_top_level_mult(t):
    depth = 0
    for i, ch in enumerate(t):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "*" and depth == 0:
            return t[:i], t[i + 1:]
    return None


def eval_expr(text, defines, depth):
    """Evaluate a restricted integer macro expression."""
    if depth > 12:
        return None
    t = text.strip()
    if re.fullmatch(r"[+-]?\d+", t):
        return int(t)
    try:
        return int(t, 0)
    except ValueError:
        pass
    m = re.fullmatch(r"_u\(\s*(.+?)\s*\)", t)
    if m:
        return eval_expr(m.group(1), defines, depth + 1)
    if t.startswith("(") and t.endswith(")") and _paren_wraps_whole(t):
        return eval_expr(t[1:-1], defines, depth + 1)
    m = _split_top_level_mult(t)
    if m is not None:
        left = eval_expr(m[0], defines, depth + 1)
        right = eval_expr(m[1], defines, depth + 1)
        if left is None or right is None:
            return None
        return left * right
    if re.fullmatch(r"\w+", t) and t in defines:
        return eval_expr(defines[t], defines, depth + 1)
    return None


def macro_int(name, defines, depth=0):
    """Resolve a macro to an integer, unwrapping _u(...) and (X) * _u(N)."""
    if name not in defines:
        return None
    return eval_expr(defines[name], defines, depth)


def check_clock_macros(defines):
    """Assert the resolved clock macros of the clocks.c TU."""
    errors = []
    resolved = []
    for name, expected in (("SYS_CLK_HZ", EXPECTED_SYS_CLK_HZ),
                           ("USB_CLK_HZ", EXPECTED_USB_CLK_HZ),
                           ("PICO_USE_FASTEST_SUPPORTED_CLOCK", EXPECTED_FASTEST_CLOCK)):
        value = macro_int(name, defines)
        if value is None:
            errors.append("%s not resolvable from the -dM dump of %s" % (name, CLOCKS_TU_SUFFIX))
        elif value != expected:
            errors.append("%s is %d, expected %d" % (name, value, expected))
        else:
            resolved.append("%s=%d" % (name, value))
    if not errors:
        print("check-clock: resolved clocks: %s" % ", ".join(resolved))
    return errors


def preprocess_command(entry):
    """Build the -dM -E preprocessing command for a TU entry."""
    out = []
    skip_next = False
    for arg in tu_arguments(entry):
        if skip_next:
            skip_next = False
            continue
        if arg in STRIP_WITH_VALUE:
            skip_next = True
            continue
        if arg in STRIP_FLAGS:
            continue
        out.append(arg)
    out += ["-dM", "-E"]
    return out


def preprocess_clocks(entry):
    """Run the clocks.c TU command with -dM -E and return its macro dict."""
    cmd = preprocess_command(entry)
    try:
        proc = subprocess.run(cmd, cwd=entry.get("directory") or ".",
                              capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, "could not run the clocks.c preprocessor command: %s" % exc
    if proc.returncode != 0:
        return None, "preprocessing %s failed (rc=%d): %s" % (
            CLOCKS_TU_SUFFIX, proc.returncode, proc.stderr.strip()[-300:])
    return parse_defines(proc.stdout), None


def run_gate(build_dir):
    """Run the clock gate on a build dir. Returns (errors, resolved dict)."""
    cc_path = os.path.join(build_dir, "compile_commands.json")
    if not os.path.isfile(cc_path):
        return ["compile_commands.json not found at %s (run build.sh first)" % cc_path], {}
    with open(cc_path, "r") as fh:
        entries = json.load(fh)
    if not isinstance(entries, list) or not entries:
        return ["%s contains no translation units" % cc_path], {}

    errors = []
    resolved = {}
    clocks_entries = [e for e in entries if e.get("file", "").endswith(CLOCKS_TU_SUFFIX)]
    if not clocks_entries:
        errors.append("no %s TU found in compile_commands.json" % CLOCKS_TU_SUFFIX)
    else:
        defines, err = preprocess_clocks(clocks_entries[0])
        if err is not None:
            errors.append(err)
        else:
            errors.extend(check_clock_macros(defines))
            for name in ("SYS_CLK_HZ", "USB_CLK_HZ", "PICO_USE_FASTEST_SUPPORTED_CLOCK"):
                resolved[name] = macro_int(name, defines)

    errors.extend(scan_tus(entries))
    if not errors:
        print("check-clock: PICO_FLASH_SIZE_LIMIT_BYTES=0x200000 and FORCE_BUTTON_WAIT "
              "defined in %d/%d TUs; no -DSYS_CLK_* or -DPICO_USE_FASTEST_SUPPORTED_CLOCK=1 override" % (
                  len(entries), len(entries)))
    return errors, resolved


def self_test():
    """Exercise the parsing and checking logic on synthetic data."""
    dm_ok = "\n".join([
        "#define SYS_CLK_HZ _u(125000000)",
        "#define PICO_USE_FASTEST_SUPPORTED_CLOCK 0",
        "#define USB_CLK_HZ _u(48000000)",
        "#define PLL_SYS_VCO_FREQ_HZ (1500 * MHZ)",
        "#define UNRELATED 1",
    ])
    dm_khz = dm_ok.replace(
        "#define USB_CLK_HZ _u(48000000)",
        "#define USB_CLK_KHZ 48000\n#define USB_CLK_HZ ((USB_CLK_KHZ) * _u(1000))")

    def tu(extra=(), cap=True, wait=True, suffix="src/foo.c"):
        args = ["arm-none-eabi-gcc", "-O3", "-I/inc"]
        if cap:
            args.append("-DPICO_FLASH_SIZE_LIMIT_BYTES=0x200000")
        if wait:
            args.append("-DFORCE_BUTTON_WAIT=1")
        args += list(extra) + ["-c", "/sdk/" + suffix, "-o", "foo.o", "-MD", "-MT", "foo.d", "-MF", "foo.d"]
        return {"file": "/sdk/" + suffix, "arguments": args, "directory": "/build"}

    def tus(extra=()):
        return [tu(suffix="hardware_clocks/clocks.c"), tu(), tu(), tu(extra=extra)]

    cases = []
    errors = check_clock_macros(parse_defines(dm_ok))
    cases.append(("dm positive macros", errors, []))
    errors = check_clock_macros(parse_defines(dm_khz))
    cases.append(("dm USB_CLK_HZ via USB_CLK_KHZ expression", errors, []))
    for label, text, want in [
        ("dm SYS_CLK_HZ override", dm_ok.replace("_u(125000000)", "_u(200000000)"), "SYS_CLK_HZ is 200000000"),
        ("dm fastest clock set", dm_ok.replace("_u(125000000)", "_u(200000000)").replace(
            "#define PICO_USE_FASTEST_SUPPORTED_CLOCK 0", "#define PICO_USE_FASTEST_SUPPORTED_CLOCK 1"),
            "PICO_USE_FASTEST_SUPPORTED_CLOCK is 1"),
        ("dm USB clock wrong", dm_ok.replace("_u(48000000)", "_u(47000000)"), "USB_CLK_HZ is 47000000"),
        ("dm SYS_CLK_HZ missing", "#define OTHER 1\n", "SYS_CLK_HZ not resolvable"),
        ("dm USB_CLK_HZ missing", "#define OTHER 1\n", "USB_CLK_HZ not resolvable"),
    ]:
        errors = check_clock_macros(parse_defines(text))
        cases.append((label, errors, [want]))

    cases.append(("tu positive set", scan_tus(tus()), []))
    cases.append(("tu -D as two tokens", scan_tus([
        tu(), tu(["-D", "FORCE_BUTTON_WAIT=1"]), tu()]), []))
    cases.append(("tu -DSYS_CLK_HZ override", scan_tus(
        tus(extra=("-DSYS_CLK_HZ=200000000",))), ["forbidden clock override"]))
    cases.append(("tu -DSYS_CLK_KHZ override", scan_tus(
        tus(extra=("-DSYS_CLK_KHZ=200000",))), ["forbidden clock override"]))
    cases.append(("tu fastest clock =1", scan_tus(
        tus(extra=("-DPICO_USE_FASTEST_SUPPORTED_CLOCK=1",))), ["forbidden clock override"]))
    cases.append(("tu fastest clock =0 allowed", scan_tus(
        tus(extra=("-DPICO_USE_FASTEST_SUPPORTED_CLOCK=0",))), []))
    cases.append(("tu cap missing", scan_tus(
        [tu(), tu(cap=False), tu()]), ["PICO_FLASH_SIZE_LIMIT_BYTES missing"]))
    cases.append(("tu cap wrong value", scan_tus(
        [tu(), tu(), {"file": "/sdk/x.c", "arguments": [
            "cc", "-DPICO_FLASH_SIZE_LIMIT_BYTES=0x400000", "-DFORCE_BUTTON_WAIT=1"],
            "directory": "/b"}]), ["PICO_FLASH_SIZE_LIMIT_BYTES != 0x200000"]))
    cases.append(("tu FORCE_BUTTON_WAIT missing", scan_tus(
        [tu(), tu(wait=False), tu()]), ["FORCE_BUTTON_WAIT missing"]))
    cases.append(("tu FORCE_BUTTON_WAIT bare allowed", scan_tus([
        tu(), {"file": "/sdk/x.c", "arguments": [
            "cc", "-DPICO_FLASH_SIZE_LIMIT_BYTES=0x200000", "-DFORCE_BUTTON_WAIT"],
            "directory": "/b"}, tu()]), []))

    # -U handling: a TU may undefine a required macro (attached or two-token
    # form) or a later -D may override an earlier -U; the gate must look at
    # the effective macro set, in command order, with the last flag winning.
    for label, extra, wants in [
        ("tu -U cap attached", ("-UPICO_FLASH_SIZE_LIMIT_BYTES",),
         ["PICO_FLASH_SIZE_LIMIT_BYTES missing"]),
        ("tu -U cap two tokens", ("-U", "PICO_FLASH_SIZE_LIMIT_BYTES"),
         ["PICO_FLASH_SIZE_LIMIT_BYTES missing"]),
        ("tu -U wait attached", ("-UFORCE_BUTTON_WAIT",),
         ["FORCE_BUTTON_WAIT missing"]),
        ("tu -U wait two tokens", ("-U", "FORCE_BUTTON_WAIT"),
         ["FORCE_BUTTON_WAIT missing"]),
        ("tu -D cap then -U cap", ("-DPICO_FLASH_SIZE_LIMIT_BYTES=0x200000",
                                   "-UPICO_FLASH_SIZE_LIMIT_BYTES"),
         ["PICO_FLASH_SIZE_LIMIT_BYTES missing"]),
        ("tu -U then -DSYS_CLK_HZ override", ("-USYS_CLK_HZ", "-DSYS_CLK_HZ=200000000"),
         ["forbidden clock override"]),
        ("tu -DSYS_CLK_HZ two tokens", ("-D", "SYS_CLK_HZ=200000000"),
         ["forbidden clock override"]),
        ("tu cap redefinition last wins", ("-DPICO_FLASH_SIZE_LIMIT_BYTES=0x400000",
                                           "-DPICO_FLASH_SIZE_LIMIT_BYTES=0x200000"), []),
        ("tu wait -U then -D last wins", ("-UFORCE_BUTTON_WAIT", "-DFORCE_BUTTON_WAIT=1"), []),
    ]:
        cases.append((label, scan_tus(tus(extra=extra)), wants))

    cmd = preprocess_command(tu(suffix="hardware_clocks/clocks.c"))
    problems = []
    if "-dM" not in cmd or "-E" not in cmd:
        problems.append("-dM -E not appended")
    if "-c" in cmd or "-MD" in cmd or "foo.o" in cmd or "foo.d" in cmd:
        problems.append("code-generation or depfile flags not stripped: %s" % cmd)
    if "/sdk/hardware_clocks/clocks.c" not in cmd:
        problems.append("source file dropped from the preprocessing command")
    cases.append(("preprocess command transform", problems, []))

    failed = 0
    for label, errors, wants in cases:
        ok = False
        if not wants:
            ok = not errors
        else:
            ok = bool(errors) and all(any(w in e for e in errors) for w in wants)
        print("self-test: %-38s %s" % (label, "ok" if ok else "FAIL: %s" % (errors,)))
        failed += 0 if ok else 1
    print("self-test: %d/%d cases passed" % (len(cases) - failed, len(cases)))
    return 0 if failed == 0 else 1


def main(argv):
    if "--self-test" in argv:
        return self_test()
    args = [a for a in argv if a != "--self-test"]
    unknown = [a for a in args if a.startswith("-")]
    if unknown:
        print("check-clock: unknown option(s): %s" % " ".join(unknown))
        return 2
    if len(args) > 1:
        print("usage: check-clock.py [--self-test] [BUILD_DIR]")
        return 2
    build_dir = args[0] if args else (
        os.environ.get("PIPICO_BUILD_DIR") or "build-pipico")
    errors, _ = run_gate(build_dir)
    if errors:
        for line in fail_messages(errors):
            print(line)
        return 1
    print("check-clock: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
