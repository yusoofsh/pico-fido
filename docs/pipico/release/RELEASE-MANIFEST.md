# Pipico V1 release manifest (`pipico/integration-v1`)

Status: **SOURCE REVIEWED**, **BUILT**, **AUTOMATED TESTS PASSED**.
HARDWARE TESTED / HOST INSTALLED / FLASHED / ACCOUNT ENROLLED: **NOT_RUN**
(no board and no Mac were attached to the build environment).

Companion files in this directory:
`image-bounds-report.json` (size and write-range report of the released
binaries), `clock-report.txt`, `budget-fresh-clone.txt`,
`reproducibility.md`, `test-receipts.md`.

## 1. Built-from source tuple

| Item | Value |
|---|---|
| Root commit (pico-fido, built SHA) | `b31a8ab969536d754a7737c3ffe12bf7c6e3da5f` |
| SDK commit (pico-keys-sdk gitlink == submodule) | `654fbda1046c0dba3832ff520f7d1ea25d1df45b` |
| Pico SDK | 2.3.1 @ `079c6f39023649b154152db30f1d781e884879bc` |
| TinyUSB (Pico SDK submodule) | `86ad6e56c1700e85f1c5678607a762cfe3aa2f47` |
| mbedtls | v3.6.7 @ `068ff080b369adfac81509f9b57b2afabaf82dc5` (configure-time clone into `pico-keys-sdk/third-party/mbedtls`) |
| tinycbor | v0.6.1 @ `c0aad2fb2137a31b9845fbaae3653540c410f215` (configure-time clone into `pico-keys-sdk/third-party/tinycbor`) |
| Toolchain | Arm GNU Toolchain 13.2.Rel1 — `arm-none-eabi-gcc (Arm GNU Toolchain 13.2.rel1 (Build arm-13.7)) 13.2.1 20231009` |
| picotool | 2.3.1 — `picotool v2.3.1 (Linux, GNU-13.3.0, Release)` |
| Layout ID | `yd4m-effective2m-marker-gap-v1` |

Every tuple value was re-resolved in a fresh recursive clone of the pushed
branch (`build-scratch/rb1`) after its configure, with:

```
git rev-parse HEAD
git -C pico-keys-sdk rev-parse HEAD
git -C pico-keys-sdk/third-party/mbedtls rev-parse HEAD
git -C pico-keys-sdk/third-party/tinycbor rev-parse HEAD
git -C "$PICO_SDK_PATH" rev-parse HEAD
git -C "$PICO_SDK_PATH/lib/tinyusb" rev-parse HEAD
arm-none-eabi-gcc --version | head -1
picotool version
```

All six rev-parses printed the values in the table (the same values the
build itself records in `pipico-build-tuple.txt`). `HANDOFF.md` names the
docs-only evidence commits made after the built SHA; they change no build
input.

## 2. Resolved build flags

The build command is the documented single command
(`scripts/pipico/build.sh`, prerequisites in the root `README.md`). Values
below are from `build-pipico/CMakeCache.txt` and
`build-pipico/pipico-build-tuple.txt` of the fresh clone after configure:

| Flag | Resolved value |
|---|---|
| `PICO_BOARD` | `vcc-gnd_yd-rp2040_4m` |
| `PICO_USE_FASTEST_SUPPORTED_CLOCK` | `0` |
| `PICO_FLASH_SIZE_LIMIT_BYTES` | `0x200000` |
| `FORCE_BUTTON_WAIT` | `ON` |
| `ENABLE_OATH_APP` | `ON` |
| `ENABLE_OTP_APP` | `ON` |
| `PIPICO_COMPANION` | `ON` |
| EdDSA | disabled (`ENABLE_EDDSA:BOOL=OFF`; standard mbedtls only) |
| `CMAKE_BUILD_TYPE` | `Release` (Pico SDK default set in `cmake/pico_pre_load_toolchain.cmake`; `build.sh` does not override it) |

## 3. Resolved clocks

From `scripts/pipico/check-clock.py` (see `clock-report.txt`, identical for
the released CI build and the local fresh-clone build):

```
SYS_CLK_HZ=125000000, USB_CLK_HZ=48000000, PICO_USE_FASTEST_SUPPORTED_CLOCK=0
PICO_FLASH_SIZE_LIMIT_BYTES=0x200000 and FORCE_BUTTON_WAIT defined in 211/211 TUs;
no -DSYS_CLK_* or -DPICO_USE_FASTEST_SUPPORTED_CLOCK=1 override  ->  PASS
```

## 4. Artifact hashes (SHA-256)

The build is **not** reproducible across build directories (diagnosed
cause and both comparison hashes: `reproducibility.md`), so each entry
names the file, its hash and the build (source SHA + build path) that
produced it.

Released artifacts are byte-identical across every successful run of
this branch since `5833bc2…` (docs-only and workflow-only commits change
no build input; verified by download each time). All of those runs built
on the same UTC date (2026-10-07): the Pico SDK embeds the compiler build
date (`__DATE__`, via `bi_program_build_date_string`) in the image, so
this is a same-path, same-date stability observation — not evidence about
different dates and not a reproducibility guarantee (`reproducibility.md`).
The hashes below were verified against the **actually downloaded files**
of run `37690147169` (workflow `pipico`, root
`aa09cf4f28ea63d909bf86bf780d6f4c857f1c6b`, the run that first uploaded
the `.bin`; the same three hashes are printed in that artifact's
`manifest.txt`):

| File | SHA-256 |
|---|---|
| `pico_fido.uf2` | `cfbaa43088c307ef414f103cd2d9d989b60ea8a84846fff52f440f4ad845140e` |
| `pico_fido.elf` | `5e872a1cfd8f6e148f7aa40282bd45a8fca656598996a2e2a72af3fd67dce95e` |
| `pico_fido.bin` | `ce8b8be4c7fc9c58fee1de9051d21a2d2ca4ab43e9242469130ee3b85586eedf` |

Evidence provenance of the `.bin` hash, stated precisely: in runs
`37682443999`, `37685884106` and `37687857080` the `.bin` was **not
uploaded**; its hash was computed inside the run and recorded in the
artifact `manifest.txt` only (manifest-only evidence, no downloaded
file). From run `37690147169` on (workflow commit `6def65d` "ci: upload
pico_fido.bin with the release artifacts"), the `.bin` is part of the
uploaded artifact, and the hash above was recomputed from the downloaded
file — it equals the earlier in-run value. The build is **not**
reproducible across build paths (`reproducibility.md`); the CI-runner
build is cited as released because the released evidence (bounds report
below, `reproducibility.md` cross-checks) is that build's.

Fresh-clone comparison builds from the same source SHA
(`reproducibility.md` holds the full table):

| Build (path) | `pico_fido.uf2` | `pico_fido.elf` | `pico_fido.bin` |
|---|---|---|---|
| `rb1` (`/home/factory-user/work/build-scratch/rb1/build-pipico`) | `90ce93fe19d1a9b3b2a9323f84853dd999e48fe627d7df50b6ab4709dc1b0578` | `1f712c4f387d724a8e3acbacfbbdd15a31845f04ad8537d325d9a5094ac2bfbb` | `64345cce1eeb3c5fb996cd315a37387865add6f57253020a31294071fdfe52f7` |
| `rb2` (`/home/factory-user/work/build-scratch/rb2/build-pipico`) | `af3e4b5112463a211ce2d26bbaa24f6b090bbecae156bbd30b8adfc4d52bbcf8` | `81d38b981f871715837d086bc88c6fe371ee176e5daa765a9f6ee5299884c1a3` | `2b07cad88da7083f85b0e8bb63432c645480dce2c941b7a0fc64c692383fe7f0` |

## 5. Size and write-range report

`image-bounds-report.json` in this directory is the gate report of the
released (CI artifact) ELF/UF2. Key numbers (offsets from XIP_BASE
`0x10000000`):

- ELF: 6 `PT_LOAD` segments, 2 with flash LMA; the flash segment ends at
  offset `0x8371c`, the `.data`-style segment's flash LMA ends at offset
  `0x854bc`; cross-checked against `arm-none-eabi-readelf -lW`.
- UF2: 2133 blocks, family id `0xe48bff56`, min target `0x10000000`, max
  target `0x10085400`, max write end `0x10085500` (offset `0x85500`).
- Sector-rounded erase footprint end `0x10086000` (offset `0x86000`).
- Every end is at or below the `0x100000` limit; headroom `0x7ab00` bytes.

Re-running `python3 scripts/pipico/check-image-bounds.py <build dir>` on
the released ELF/UF2 reprints the same numbers and exits 0 (verified in
this session; see `test-receipts.md`).

## 6. Flash layout recorded by this build

Layout ID `yd4m-effective2m-marker-gap-v1` — identical ID and offsets in
`docs/pipico/LAYOUT.md` and `docs/pipico/HANDOFF.md` (offsets from
XIP_BASE, end exclusive):

| Offset range | Use |
|---|---|
| `[0x000000, 0x100000)` | code (all write ends ≤ `0x100000`) |
| `[0x100000, 0x101000)` | physical marker sector (4 KiB) |
| `[0x101000, 0x200000)` | SDK broad data region (not net credential capacity) |
| `[0x200000, 0x400000)` | unused by this build |

## 7. Companion budget

Fresh-clone budget gate (companion ON vs a fresh
`PIPICO_COMPANION=OFF` baseline built in the same clone from the same
tuple): static RAM delta **20 B**, linked flash delta **1200 B** — limits
8192 B / 65536 B (see `budget-fresh-clone.txt`; identical in `rb1` and
`rb2`, matching the M3 canonical fresh evidence). The CI runner path
builds print the same RAM delta (20 B) and flash delta 1192 B; the small
flash variance follows the same build-path string lengths diagnosed in
`reproducibility.md` and is far below the limit.

## 8. Release CI artifact

Run `37685884106` (workflow `pipico`, push to `pipico/integration-v1`,
head `b31a8ab…`) concluded **success** and uploaded the artifact
`pipico-release-evidence`: `pico_fido.uf2`, `pico_fido.elf`,
`pico_fido.elf.map`, `pipico-build-tuple.txt`, `clock-report.txt`,
`image-bounds-report.json`, `budget-report.txt`, and `receipts/`
(`roothost-ctest.log`, `pytest-receipt.xml`, `bun-test.log`). The counts
observed in that run's receipts are recorded in `test-receipts.md`.
Runs `37687857080` (head `5ba8b08…`) and `37690147169` (head `aa09cf4…`,
the first with the `.bin` uploaded — see §4) concluded **success** with
the same counts and byte-identical `uf2`/`elf` files (for run
`37687857080` the `.bin` was manifest-only, as in every run before
`37690147169`); the push run `37693278603` on the last documentation-only
head before the correction round (`0e74670…`) concluded **success** with
the same downloaded hashes. Docs-only commits and README-only SDK
gitlink bumps change no build input, so the artifact of the branch's
final head carries the same binaries as well (the final artifact
manifest of the final successful push run is the authoritative final
tuple).
