# Test receipts (automated tests, 2026-10-07)

Every receipt below was produced by the command shown, run in this
session, against the built tuple: root
`b31a8ab969536d754a7737c3ffe12bf7c6e3da5f`, SDK
`654fbda1046c0dba3832ff520f7d1ea25d1df45b` (fresh recursive clones
`build-scratch/rb1`, `rb2`). Hardware/Mac receipts: none — HARDWARE
TESTED, HOST INSTALLED, FLASHED and ACCOUNT ENROLLED are **NOT_RUN**.

## Fresh-clone build and gates (both clones)

Command: `scripts/pipico/build.sh` (the documented single command).

- rb1: exit 0; rb2: exit 0. Zero CMake diagnostics, zero compiler
  warnings in both (the script fails the build on any diagnostic).
- Clock gate: `check-clock: PASS` — `SYS_CLK_HZ=125000000`,
  `USB_CLK_HZ=48000000`, `PICO_USE_FASTEST_SUPPORTED_CLOCK=0`,
  `PICO_FLASH_SIZE_LIMIT_BYTES=0x200000` and `FORCE_BUTTON_WAIT` defined
  in 211/211 TUs, no override.
- Image-bounds gate: `PASS: image write end 0x10085500 (offset 0x85500 of
  the 0x100000 limit; erase footprint end 0x10086000)` — both builds.
- Budget gate: `static RAM delta: 20 B … OK`, `linked flash delta:
  1200 B … OK`, `pipico-budget: OK` — both builds (fresh OFF baseline
  built inside each clone). Full output: `budget-fresh-clone.txt`.
- Bounds-gate negative self-test (rb1): `python3 scripts/pipico/
  check-image-bounds.py --self-test` → `self-test: 17/17 cases passed`.
- Rerun on the released (CI artifact) binaries: `python3
  scripts/pipico/check-image-bounds.py <build dir>` exits 0 and reprints
  the numbers committed in `image-bounds-report.json`.

## SDK host ctest (submodule at 654fbda)

Command (in the fresh clone, after the ARM configure cloned
`third-party/mbedtls`):

```
cmake -S pico-keys-sdk/tests -B pico-keys-sdk/build-tests -G Ninja
ninja -C pico-keys-sdk/build-tests -j2
(cd pico-keys-sdk/build-tests && ctest --output-on-failure -j2)
```

Result: **100% tests passed, 0 tests failed out of 47** (exit 0).

## Root host ctest (emulation build, b31a8ab)

Command (in the fresh clone):

```
cmake -S . -B emu -G Ninja -DENABLE_EMULATION=1 -DFORCE_BUTTON_WAIT=ON -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
ninja -C emu -j2
(cd emu && ctest --output-on-failure -j2)
```

Result: **100% tests passed, 0 tests failed out of 67** (exit 0)
(6 pre-existing + 33 gesture + 23 arbiter + 5 glue scenarios).

## Emulation python-fido2 suite (b31a8ab)

Setup: pcscd started first (`setsid sudo -n /usr/sbin/pcscd -f
--disable-polkit`, the mission-standard invocation), then:

```
PIPICO_EMULATOR="$PWD/emu/pico_fido" PIPICO_EMU_RUN_DIR="$PWD/emu-run" \
  PYTEST="$PYENV/bin/pytest" scripts/pipico/run-emu-tests.sh
```

The script starts the emulator on a fresh `memory.flash` and runs
`pytest tests` with the single deselect
`tests/pico-fido/test_080_vault.py::test_live_export_import_roundtrip`
(the upstream vault test that needs CI secrets), then stops the
emulator.

Result: **348 passed, 3 skipped, 1 deselected in 293.47s — 0 failed,
0 errors** (exit 0). This matches the baseline (306 upstream + Pipico
additions; the only non-passes are the 3 documented skips and the one
deselected vault test).

CI junit receipt (artifact of run `37685884106`, `pytest-receipt.xml`):
`tests=371, failures=0, errors=0, skipped=3`.

## Host CLI tests and typecheck (b31a8ab)

Commands (in `rb1/host`):

```
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
```

Result: `bun test` **315 pass, 0 fail** (1944 expect() calls, 15 files,
exit 0); `tsc --noEmit` clean (exit 0).

## CI runs on the pushed branches (observed with `gh run list` / `gh run view`)

| Run | Repo / workflow | Head SHA | Conclusion | Counts from the run's receipts |
|---|---|---|---|---|
| `37685874677` | pico-keys-sdk / `pipico-sdk-tests` | `654fbda1046c0dba3832ff520f7d1ea25d1df45b` | **success** (49 s) | SDK host ctest green |
| `37685884106` | pico-fido / `pipico` | `b31a8ab969536d754a7737c3ffe12bf7c6e3da5f` | **success** | root ctest 67/67; pytest 348 passed / 3 skipped / 1 deselected / 0 failed; bun 315 pass / 0 fail; bounds self-test 17/17; budget OK (20 B / 1192 B) |

Both runs also confirm the earlier observation on the same build inputs:
runs `37682443999` (source `5833bc2`) and `37685884106` uploaded
byte-identical firmware artifacts (verified by downloading both
artifacts and comparing `sha256sum`).
