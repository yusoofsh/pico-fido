#!/usr/bin/env python3
"""Pipico image bounds gate (architecture.md section 5).

Verifies that the Pipico firmware image never reaches the physical marker
sector at [0x10100000, 0x10101000), i.e. offset 0x100000 from XIP_BASE:

  - every PT_LOAD segment whose LMA (p_paddr) lies in the flash window,
    including the RAM-vaddr (.data style) segment whose LMA trails the
    image, writes [LMA, LMA + p_filesz) and must end at or below offset
    0x100000;
  - every UF2 block must carry the RP2040 family id 0xe48bff56 and its
    write [target_addr, target_addr + payload_size) must end at or below
    offset 0x100000;
  - the 4 KiB-sector-rounded erase footprint of everything written must
    end at or below offset 0x100000.

An image ending exactly at offset 0x100000 passes; anything past it fails.
build.sh runs this gate on the built pico_fido.elf/pico_fido.uf2 and fails
the build when it does not (the linker-assertion equivalent).

The gate prints a JSON size and write-range report on stdout and human
diagnostics on stderr. Exit code 0 = pass, 1 = gate failure, 2 = usage.

Usage: check-image-bounds.py [--self-test] [--elf PATH] [--uf2 PATH] [BUILD_DIR]

BUILD_DIR defaults to $PIPICO_BUILD_DIR, then ./build-pipico, and supplies
the default pico_fido.elf and pico_fido.uf2 inputs. --elf/--uf2 override
either input independently; when at least one of the flags is given, only
the given inputs are checked, so a lone synthetic file can be gated.

Python stdlib only. arm-none-eabi-readelf is used, when it is on PATH, to
cross-check the parsed program headers.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

XIP_BASE = 0x10000000
FLASH_WINDOW_BYTES = 0x10000000     # 16 MiB XIP window of the RP2040
FLASH_LIMIT_OFFSET = 0x100000       # code region end; the marker sector follows
FLASH_LIMIT_ABS = XIP_BASE + FLASH_LIMIT_OFFSET
SECTOR_BYTES = 4096

PT_LOAD = 1

UF2_BLOCK_SIZE = 512
UF2_DATA_MAX = 476
UF2_MAGIC_START0 = 0x0A324655       # "UF2\n"
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000   # boot/uf2.h of the pinned Pico SDK
UF2_FAMILY_RP2040 = 0xE48BFF56


class GateInputError(Exception):
    """An input file that itself fails to parse (malformed ELF/UF2)."""


def hx(value):
    return "0x%x" % value


def end_offset(abs_addr):
    return abs_addr - XIP_BASE


def in_flash_window(addr):
    return XIP_BASE <= addr < XIP_BASE + FLASH_WINDOW_BYTES


def bounds_error(label, write_end_abs):
    """Return an error string when a write range ends past the code region."""
    end = end_offset(write_end_abs)
    if end > FLASH_LIMIT_OFFSET:
        return ("%s ends at %s, offset %s > %s (marker sector at %s)" %
                (label, hx(write_end_abs), hx(end), hx(FLASH_LIMIT_OFFSET),
                 hx(FLASH_LIMIT_ABS)))
    return None


def parse_elf_pt_loads(path):
    """Parse the program headers of an ELF32/ELF64 little-endian file.

    Returns (segments, ei_class, e_machine) where segments carries the raw
    p_type/p_offset/p_vaddr/p_paddr/p_filesz/p_memsz of every segment.
    """
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 52 or data[:4] != b"\x7fELF":
        raise GateInputError("%s: not an ELF file" % path)
    ei_class, ei_data = data[4], data[5]
    if ei_data != 1:
        raise GateInputError("%s: big-endian ELF not supported" % path)
    if ei_class == 1:
        eh_fmt, ph_fmt = "<16sHHIIIIIHHHHHH", "<IIIIIIII"
        ph_struct_size = 32
    elif ei_class == 2:
        eh_fmt, ph_fmt = "<16sHHIQQQIHHHHHH", "<IIQQQQQQ"
        ph_struct_size = 56
    else:
        raise GateInputError("%s: unsupported ELF class %d" % (path, ei_class))
    header = struct.unpack_from(eh_fmt, data, 0)
    e_phoff, e_phentsize, e_phnum = header[5], header[9], header[10]
    if e_phoff == 0 or e_phnum == 0:
        raise GateInputError("%s: no program headers" % path)
    if e_phentsize < ph_struct_size:
        raise GateInputError("%s: e_phentsize %d too small for ELF%d" %
                             (path, e_phentsize, 32 if ei_class == 1 else 64))
    if e_phoff + e_phnum * e_phentsize > len(data):
        raise GateInputError("%s: program header table out of bounds" % path)
    segments = []
    for i in range(e_phnum):
        fields = struct.unpack_from(ph_fmt, data, e_phoff + i * e_phentsize)
        if ei_class == 1:
            p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz = fields[:6]
        else:
            p_type, _, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz = fields[:7]
        segments.append({
            "index": i, "type": p_type, "offset": p_offset, "vaddr": p_vaddr,
            "lma": p_paddr, "filesz": p_filesz, "memsz": p_memsz,
        })
    return segments, ei_class, header[2]


def analyse_elf(path):
    """Check every flash-LMA PT_LOAD of the ELF. Returns (summary, errors)."""
    errors = []
    summary = {"path": path}
    try:
        segments, ei_class, machine = parse_elf_pt_loads(path)
    except GateInputError as exc:
        return summary, [str(exc)]
    except OSError as exc:
        return summary, ["cannot read %s: %s" % (path, exc)]

    checked = []
    flash_ends = []
    for seg in segments:
        if seg["type"] != PT_LOAD or not in_flash_window(seg["lma"]):
            continue
        kind = ("flash" if in_flash_window(seg["vaddr"])
                else "ram-vaddr-flash-lma (.data style)")
        write_end = seg["lma"] + seg["filesz"]
        err = bounds_error("ELF PT_LOAD %d (%s: LMA %s + filesz %s)" %
                           (seg["index"], kind, hx(seg["lma"]), hx(seg["filesz"])),
                           write_end)
        if err:
            errors.append(err)
        flash_ends.append(write_end)
        checked.append({
            "index": seg["index"], "kind": kind,
            "vaddr": hx(seg["vaddr"]), "lma": hx(seg["lma"]),
            "filesz": hx(seg["filesz"]), "memsz": hx(seg["memsz"]),
            "write_end": hx(write_end), "end_offset": hx(end_offset(write_end)),
        })

    note, err = readelf_crosscheck(path, segments)
    if note:
        summary["crosscheck"] = note
    if err:
        errors.append(err)

    pt_load_count = sum(1 for s in segments if s["type"] == PT_LOAD)
    summary.update({
        "class": "elf32" if ei_class == 1 else "elf64",
        "machine": machine,
        "pt_load_count": pt_load_count,
        "flash_pt_load_count": len(checked),
        "segments": checked,
    })
    if checked:
        summary["max_write_end"] = hx(max(flash_ends))
        summary["max_end_offset"] = hx(end_offset(max(flash_ends)))
    else:
        errors.append("%s: no PT_LOAD segment has an LMA in the flash window [%s, %s)" %
                      (path, hx(XIP_BASE), hx(XIP_BASE + FLASH_WINDOW_BYTES)))
    return summary, errors


def parse_uf2(path):
    """Parse every 512-byte UF2 block of a file. Returns a block list."""
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) == 0 or len(data) % UF2_BLOCK_SIZE:
        raise GateInputError("%s: size %d is not a multiple of %d (not a UF2 file)" %
                             (path, len(data), UF2_BLOCK_SIZE))
    blocks = []
    for i in range(len(data) // UF2_BLOCK_SIZE):
        off = i * UF2_BLOCK_SIZE
        m0, m1, flags, target, psize, seq, total, family = struct.unpack_from("<8I", data, off)
        magic_end = struct.unpack_from("<I", data, off + 508)[0]
        if m0 != UF2_MAGIC_START0 or m1 != UF2_MAGIC_START1 or magic_end != UF2_MAGIC_END:
            raise GateInputError("%s: block %d magic mismatch (0x%x 0x%x .. 0x%x)" %
                                 (path, i, m0, m1, magic_end))
        blocks.append({
            "index": i, "flags": flags, "target": target,
            "payload_size": psize, "seq": seq, "total": total, "family": family,
        })
    return blocks


def analyse_uf2(path):
    """Check every UF2 block's family id and write range. Returns (summary, errors)."""
    errors = []
    summary = {"path": path}
    try:
        blocks = parse_uf2(path)
    except GateInputError as exc:
        return summary, [str(exc)]
    except OSError as exc:
        return summary, ["cannot read %s: %s" % (path, exc)]

    bad_family = []
    ends = []
    targets = []
    payload_bytes = 0
    for blk in blocks:
        if not (blk["flags"] & UF2_FLAG_FAMILY_ID_PRESENT) or blk["family"] != UF2_FAMILY_RP2040:
            bad_family.append("block %d flags 0x%x family 0x%x" %
                              (blk["index"], blk["flags"], blk["family"]))
            continue
        if blk["payload_size"] > UF2_DATA_MAX:
            errors.append("%s: block %d payload_size %d exceeds the %d-byte data field" %
                          (path, blk["index"], blk["payload_size"], UF2_DATA_MAX))
            continue
        target = blk["target"]
        if not in_flash_window(target):
            errors.append("%s: block %d target %s is outside the flash window [%s, %s)" %
                          (path, blk["index"], hx(target), hx(XIP_BASE),
                           hx(XIP_BASE + FLASH_WINDOW_BYTES)))
            continue
        write_end = target + blk["payload_size"]
        err = bounds_error("UF2 block %d (target %s + payload %d)" %
                           (blk["index"], hx(target), blk["payload_size"]), write_end)
        if err:
            errors.append(err)
        ends.append(write_end)
        targets.append(target)
        payload_bytes += blk["payload_size"]

    if bad_family:
        errors.append("%s: %d block(s) without the RP2040 family id %s: %s" %
                      (path, len(bad_family), hx(UF2_FAMILY_RP2040),
                       "; ".join(bad_family[:3])))
    summary.update({
        "block_count": len(blocks),
        "family_id": hx(UF2_FAMILY_RP2040),
        "payload_bytes": payload_bytes,
    })
    if ends:
        summary["min_target"] = hx(min(targets))
        summary["max_target"] = hx(max(targets))
        summary["max_write_end"] = hx(max(ends))
        summary["max_end_offset"] = hx(end_offset(max(ends)))
    return summary, errors


def readelf_load_rows(path):
    """Parse `arm-none-eabi-readelf -lW` LOAD rows as an independent parse.

    Returns (rows, note, error); rows is None when readelf is not on PATH.
    Each row is (offset, vaddr, paddr, filesz, memsz).
    """
    exe = shutil.which("arm-none-eabi-readelf")
    if exe is None:
        return None, "arm-none-eabi-readelf not on PATH; cross-check skipped", None
    try:
        proc = subprocess.run([exe, "-lW", path], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, None, "could not run arm-none-eabi-readelf: %s" % exc
    if proc.returncode != 0:
        return None, None, "arm-none-eabi-readelf -lW failed rc=%d: %s" % (
            proc.returncode, proc.stderr.strip()[-200:])
    rows = []
    for line in proc.stdout.splitlines():
        tok = line.split()
        if len(tok) >= 6 and tok[0] == "LOAD":
            try:
                rows.append(tuple(int(t, 16) for t in tok[1:6]))
            except ValueError:
                return None, None, "could not parse readelf LOAD row: %r" % line
    if not rows:
        return None, None, "arm-none-eabi-readelf -lW printed no LOAD rows for %s" % path
    return rows, "cross-checked %d PT_LOAD row(s) against arm-none-eabi-readelf -lW" % len(rows), None


def readelf_crosscheck(path, segments):
    """Compare the struct-based PT_LOAD parse with readelf. Returns (note, error)."""
    rows, note, err = readelf_load_rows(path)
    if err is not None:
        return None, err
    if rows is None:
        return note, None
    mine = sorted((s["offset"], s["vaddr"], s["lma"], s["filesz"], s["memsz"])
                  for s in segments if s["type"] == PT_LOAD)
    if mine != sorted(rows):
        return note, ("%s: PT_LOAD parse disagrees with arm-none-eabi-readelf -lW "
                      "(%d vs %d rows, or values differ)" % (path, len(mine), len(rows)))
    return note + "; values match", None


def run_gate(elf_path, uf2_path):
    """Run the gate on the given inputs (either may be None).

    Returns (errors, report); report is JSON-serialisable.
    """
    errors = []
    report = {
        "gate": "check-image-bounds",
        "limits": {
            "xip_base": hx(XIP_BASE),
            "code_region_end_offset": hx(FLASH_LIMIT_OFFSET),
            "marker_sector_abs": [hx(FLASH_LIMIT_ABS), hx(FLASH_LIMIT_ABS + SECTOR_BYTES)],
            "sector_bytes": SECTOR_BYTES,
        },
    }
    write_ends = []
    if elf_path is not None:
        elf_summary, elf_errors = analyse_elf(elf_path)
        errors.extend(elf_errors)
        report["elf"] = elf_summary
        if elf_summary.get("max_write_end"):
            write_ends.append(int(elf_summary["max_write_end"], 16))
    if uf2_path is not None:
        uf2_summary, uf2_errors = analyse_uf2(uf2_path)
        errors.extend(uf2_errors)
        report["uf2"] = uf2_summary
        if uf2_summary.get("max_write_end"):
            write_ends.append(int(uf2_summary["max_write_end"], 16))
    if elf_path is None and uf2_path is None:
        errors.append("no input file given")
    if write_ends:
        raw_end = max(write_ends)
        rounded = ((raw_end + SECTOR_BYTES - 1) // SECTOR_BYTES) * SECTOR_BYTES
        end = end_offset(raw_end)
        err = bounds_error("erase footprint (4 KiB-rounded write end)", rounded)
        if err:
            errors.append(err)
        report["image"] = {
            "write_end": hx(raw_end),
            "end_offset": hx(end),
            "limit_offset": hx(FLASH_LIMIT_OFFSET),
            "within_limit": end <= FLASH_LIMIT_OFFSET,
            "erase_footprint_end": hx(rounded),
            "erase_footprint_end_offset": hx(end_offset(rounded)),
            "headroom_bytes": hx(max(0, FLASH_LIMIT_OFFSET - end)),
        }
    report["errors"] = errors
    report["verdict"] = "fail" if errors else "pass"
    return errors, report


# ---------------------------------------------------------------------------
# Self-test: synthetic ELFs and UF2s, including the oversized negative cases.
# ---------------------------------------------------------------------------

def build_elf32(segments):
    """Build a minimal ELF32 little-endian EXEC with the given PT_LOAD segments.

    segments: list of dicts with vaddr, lma, filesz, memsz.
    """
    ehdr_size, ph_size = 52, 32
    phoff = ehdr_size
    off = ehdr_size + len(segments) * ph_size
    placements = []
    for seg in segments:
        placements.append(off)
        off += seg["filesz"]
    out = bytearray(off)
    ident = b"\x7fELF" + bytes([1, 1, 1, 0]) + b"\x00" * 8
    struct.pack_into("<16sHHIIIIIHHHHHH", out, 0, ident,
                     2, 40, 1, 0x10000100, phoff, 0, 0,
                     ehdr_size, ph_size, len(segments), 0, 0, 0)
    for i, (seg, foff) in enumerate(zip(segments, placements)):
        struct.pack_into("<IIIIIIII", out, phoff + i * ph_size,
                         PT_LOAD, foff, seg["vaddr"], seg["lma"],
                         seg["filesz"], seg["memsz"], 5, 4)
    return bytes(out)


def build_uf2(blocks, family=UF2_FAMILY_RP2040, family_flag=True):
    """Build a UF2 file from (target, payload_bytes) pairs."""
    out = bytearray()
    for i, (target, payload) in enumerate(blocks):
        blk = bytearray(UF2_BLOCK_SIZE)
        struct.pack_into("<8I", blk, 0,
                         UF2_MAGIC_START0, UF2_MAGIC_START1,
                         UF2_FLAG_FAMILY_ID_PRESENT if family_flag else 0,
                         target, len(payload), i, len(blocks), family)
        blk[32:32 + len(payload)] = payload
        struct.pack_into("<I", blk, 508, UF2_MAGIC_END)
        out += blk
    return bytes(out)


def real_shape_elf():
    """Mirror the real image shape: flash text+rodata, .data LMA trailing, RAM-only."""
    text_size = 0x82af4
    return [
        {"vaddr": 0x10000000, "lma": 0x10000000, "filesz": text_size, "memsz": text_size},
        {"vaddr": 0x200000e0, "lma": 0x10000000 + text_size, "filesz": 0x1da0, "memsz": 0x171f8},
        {"vaddr": 0x20000000, "lma": 0x20000000, "filesz": 0, "memsz": 0xe0},
        {"vaddr": 0x20040000, "lma": 0x20040000, "filesz": 0, "memsz": 0x800},
    ]


def self_test():
    """Run the gate on synthetic inputs; the oversized ones must fail."""
    tmp = tempfile.mkdtemp(prefix="check-image-bounds-selftest-")
    cases = []

    def run_case(label, want_pass, elf_bytes=None, uf2_bytes=None):
        elf_path = uf2_path = None
        if elf_bytes is not None:
            elf_path = os.path.join(tmp, "input.elf")
            with open(elf_path, "wb") as fh:
                fh.write(elf_bytes)
        if uf2_bytes is not None:
            uf2_path = os.path.join(tmp, "input.uf2")
            with open(uf2_path, "wb") as fh:
                fh.write(uf2_bytes)
        errors, report = run_gate(elf_path, uf2_path)
        ok = (not errors) if want_pass else bool(errors)
        cases.append((label, ok, report, errors))

    # Positive cases.
    run_case("elf real-shaped (flash + .data LMA + ram-only)", True,
             elf_bytes=build_elf32(real_shape_elf()))
    run_case("elf ends exactly at offset 0x100000", True, elf_bytes=build_elf32([
        {"vaddr": 0x10000000, "lma": 0x10000000, "filesz": 0xFF000, "memsz": 0xFF000},
        {"vaddr": 0x200000e0, "lma": 0x100FF000, "filesz": 0x1000, "memsz": 0x1000},
    ]))
    run_case("uf2 real-shaped rp2040 family", True,
             uf2_bytes=build_uf2([(0x10000000, b"\x00" * 256), (0x10000100, b"\x00" * 256)]))
    run_case("uf2 ends exactly at offset 0x100000", True,
             uf2_bytes=build_uf2([(0x10000000 + i * 256, b"\x00" * 256) for i in range(4096)]))
    # Contract VAL-BUILD-007 (d) reads "last block ends at 0x100FFF01 so that
    # the 4 KiB-rounded erase footprint reaches 0x101000"; the rounded
    # footprint of an end at offset 0xFFF01 is exactly 0x100000 (the limit is
    # 4 KiB-aligned), so per the normative "ends <= 0x100000" rule this passes.
    run_case("uf2 last block ends 0x100FFF01 (rounded footprint 0x100000)", True,
             uf2_bytes=build_uf2([(0x10000000, b"\x00" * 256),
                                  (0x100FFE01, b"\x00" * 0x100)]))

    # Negative cases: VAL-BUILD-007 (a)-(e) and malformed inputs.
    run_case("(a) elf PT_LOAD LMA range ends 0x10100001", False, elf_bytes=build_elf32([
        {"vaddr": 0x10000000, "lma": 0x10000000, "filesz": 0x100001, "memsz": 0x100001},
    ]))
    run_case("(b) elf .data LMA crosses the marker, text below", False, elf_bytes=build_elf32([
        {"vaddr": 0x10000000, "lma": 0x10000000, "filesz": 0x80000, "memsz": 0x80000},
        {"vaddr": 0x200000e0, "lma": 0x100FF000, "filesz": 0x2000, "memsz": 0x2000},
    ]))
    run_case("(c) uf2 block targets 0x10100000", False,
             uf2_bytes=build_uf2([(0x10100000, b"\x00" * 256)]))
    run_case("(d) uf2 write end 0x10100001, rounded footprint 0x101000", False,
             uf2_bytes=build_uf2([(0x10000000, b"\x00" * 256),
                                  (0x10100000, b"\x00")]))
    run_case("(e) uf2 block family id 0x1a2b3c4d", False,
             uf2_bytes=build_uf2([(0x10000000, b"\x00" * 256)], family=0x1A2B3C4D))
    run_case("uf2 block without the family flag", False,
             uf2_bytes=build_uf2([(0x10000000, b"\x00" * 256)], family_flag=False))
    run_case("elf with no flash-resident PT_LOAD", False, elf_bytes=build_elf32([
        {"vaddr": 0x20000000, "lma": 0x20000000, "filesz": 0, "memsz": 0x100},
    ]))
    run_case("input is not an ELF file", False, elf_bytes=b"garbage garbage garbage")
    run_case("uf2 truncated (not a 512-byte multiple)", False, uf2_bytes=b"\x00" * 500)
    corrupt = bytearray(build_uf2([(0x10000000, b"\x00" * 256)]))
    corrupt[4] ^= 0xFF
    run_case("uf2 block with corrupted magic", False, uf2_bytes=bytes(corrupt))
    oversized_payload = bytearray(UF2_BLOCK_SIZE)
    struct.pack_into("<8I", oversized_payload, 0,
                     UF2_MAGIC_START0, UF2_MAGIC_START1, UF2_FLAG_FAMILY_ID_PRESENT,
                     0x10000000, UF2_DATA_MAX + 1, 0, 1, UF2_FAMILY_RP2040)
    struct.pack_into("<I", oversized_payload, 508, UF2_MAGIC_END)
    run_case("uf2 payload_size exceeds the 476-byte data field", False,
             uf2_bytes=bytes(oversized_payload))

    # readelf cross-check on a synthetic ELF, when readelf is available.
    if shutil.which("arm-none-eabi-readelf"):
        elf_path = os.path.join(tmp, "crosscheck.elf")
        with open(elf_path, "wb") as fh:
            fh.write(build_elf32(real_shape_elf()))
        rows, _, err = readelf_load_rows(elf_path)
        ok = err is None and rows is not None and len(rows) == len(real_shape_elf())
        cases.append(("readelf cross-check parses the synthetic ELF", ok, {}, [err or "no rows"]))

    failed = 0
    try:
        for label, ok, report, errors in cases:
            print("self-test: %-58s %s" % (label, "ok" if ok else "FAIL: %s" % (errors or report)))
            failed += 0 if ok else 1
        print("self-test: %d/%d cases passed" % (len(cases) - failed, len(cases)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if failed == 0 else 1


def main(argv):
    if "--self-test" in argv:
        rest = [a for a in argv if a != "--self-test"]
        if rest:
            print("check-image-bounds: --self-test takes no other arguments")
            return 2
        return self_test()

    elf_path = uf2_path = None
    build_dir = None
    it = iter(argv)
    while True:
        try:
            arg = next(it)
        except StopIteration:
            break
        if arg == "--elf":
            elf_path = next(it, None)
            if elf_path is None:
                print("check-image-bounds: --elf needs a path")
                return 2
        elif arg == "--uf2":
            uf2_path = next(it, None)
            if uf2_path is None:
                print("check-image-bounds: --uf2 needs a path")
                return 2
        elif arg.startswith("-"):
            print("check-image-bounds: unknown option: %s" % arg)
            return 2
        elif build_dir is None:
            build_dir = arg
        else:
            print("usage: check-image-bounds.py [--self-test] [--elf PATH] [--uf2 PATH] [BUILD_DIR]")
            return 2

    if elf_path is None and uf2_path is None:
        build_dir = build_dir or os.environ.get("PIPICO_BUILD_DIR") or "build-pipico"
        elf_path = os.path.join(build_dir, "pico_fido.elf")
        uf2_path = os.path.join(build_dir, "pico_fido.uf2")

    errors, report = run_gate(elf_path, uf2_path)
    print(json.dumps(report, indent=2))
    if errors:
        for line in errors:
            print("check-image-bounds: FAIL: %s" % line, file=sys.stderr)
        return 1
    image = report.get("image", {})
    print("check-image-bounds: PASS: image write end %s (offset %s of the %s limit; "
          "erase footprint end %s)" % (image.get("write_end"), image.get("end_offset"),
                                       image.get("limit_offset"), image.get("erase_footprint_end")),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
