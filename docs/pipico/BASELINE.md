# Yusoofs Pipico V1: source baseline (M1)

Status of this document: **SOURCE REVIEWED** for the source claims below.
Every SHA, version and count in this file was observed by running commands
against the working clones and the fork remotes on **2026-10-05**; the exact
commands are recorded in `MANIFEST.md`. Nothing in this file is evidence of
hardware behaviour.

## Status vocabulary

- This mission targets exactly three statuses: **SOURCE REVIEWED**,
  **BUILT** and **AUTOMATED TESTS PASSED**.
- **HARDWARE TESTED, HOST INSTALLED, FLASHED and ACCOUNT ENROLLED are
  NOT_RUN.** No YD-RP2040 board and no Mac are attached to this environment.
- Commit-message claims are labelled **"reported"** unless a receipt in this
  document or in `MANIFEST.md` backs them.

## Forks, branches and SHAs (observed 2026-10-05)

| Fork | Ref | SHA | Role |
|---|---|---|---|
| `yusoofsh/pico-fido` | `fix/rp2040-clock-override` | `1cd988de0a3acdce47b2d732f9e9c92017595900` | original base of the mission branch |
| `yusoofsh/pico-fido` | `fix/rp2040-clock-override` (advanced) | `7d08bf80353b6aa178d40d36092b0712bf7acfee` | advanced externally during the mission; merged into the mission branch by user decision |
| `yusoofsh/pico-fido` | `main` | `f01fa1e2817a845e44d788f3f633a1f122ce332e` | reference; future draft-PR target |
| `yusoofsh/pico-fido` | `pipico/integration-v1` | merge commit `ceff7019541a2df333426856301418c861b77224` | mission branch (tip advances with docs commits; see `MANIFEST.md` publication state) |
| `yusoofsh/pico-keys-sdk` | `fix/flash-size-limit` | `a26c831ceb20d5d6c60e97cdc457e426d2abf3ed` | original base of the mission branch |
| `yusoofsh/pico-keys-sdk` | `fix/flash-size-limit` (advanced) | `28cd6a428c54f5fc83c94bc06b4d1d9855b97451` | advanced externally during the mission; merged into the mission branch by user decision |
| `yusoofsh/pico-keys-sdk` | `main` | `50699e53e8ada214c27f6c9b66ea3b6f127fc655` | reference (upstream layout); future draft-PR target |
| `yusoofsh/pico-keys-sdk` | `pipico/storage-baseline` | merge commit `7973a9916d9f70717a69d1c50645c1d36e4bb52a`, tip `f48d23ddb55add5fb3118884e64f7456a29b70bd` | mission branch |

- The externally advanced heads were merged into the mission branches with
  merge commits (user decision, recorded in `architecture.md` section 1; no
  rebase, no force-push, the `fix/*` refs themselves were never written):
  - `pipico/integration-v1`: merge `ceff7019541a2df333426856301418c861b77224`
    with parents `80fa7f25c39539e9f2eb158d86ecb67a2f65a8b7` and
    `7d08bf80353b6aa178d40d36092b0712bf7acfee`. The merged head only adds
    `tests/test_clock_override.py` and its `tests/README.md` section.
  - `pipico/storage-baseline`: merge `7973a9916d9f70717a69d1c50645c1d36e4bb52a`
    with parents `42e740ab9b7a8c6e90ebfaa0849372c53f188263` and
    `28cd6a428c54f5fc83c94bc06b4d1d9855b97451`. Where 28cd6a4 overlapped the
    M1 storage work, the M1 design stayed authoritative and the compatible
    protections (configure-time rejection of the cap on ESP32/emulation, the
    compile-time RP2040-only guard, the unsigned shift, the marker-size
    static assertion) were kept; the merge commit message records each
    supersession. `tests/test_flash_size_limit.py` was adapted to the M1
    code shapes in `f48d23d` (reasons documented there and in
    `tests/README.flash-size-limit.md`).
- The root gitlink `pico-keys-sdk` resolves to
  `f48d23ddb55add5fb3118884e64f7456a29b70bd`, identical to the SDK mission
  branch HEAD (observed: `git ls-tree HEAD pico-keys-sdk`).
- `.gitmodules` URL is `https://github.com/yusoofsh/pico-keys-sdk` (observed).
- The fork `main` and `fix/*` SHAs were cross-checked with `git ls-remote`
  and match the local refs; they are never modified by this mission.
- Nothing is merged into `main` and no mission PR exists. The only merges on
  the mission branches are the two user-decided merges of the externally
  advanced `fix/*` heads recorded above. After the merges, the mission
  branches are pushed again (SDK first, then the root branch), with push
  access that became available through a user-provided credential. `git
  ls-remote` shows the two `pipico/*` refs as the only new heads; every
  pre-mission branch is unchanged at its recorded SHA (see `MANIFEST.md`
  publication state and VAL-PUB-004).

## Pinned build tuple (observed)

The values below come from the working toolchain and from
`pipico-build-tuple.txt`, which `scripts/pipico/build.sh` writes on every
build. See `MANIFEST.md` for the per-item source of each value.

| Item | Value |
|---|---|
| Toolchain | Arm GNU Toolchain 13.2.rel1, `arm-none-eabi-gcc 13.2.1 20231009` |
| Build tools | CMake 3.28.3, Ninja 1.13.2 |
| Pico SDK | 2.3.1 @ `079c6f39023649b154152db30f1d781e884879bc` |
| TinyUSB (Pico SDK submodule) | `86ad6e56c1700e85f1c5678607a762cfe3aa2f47` |
| picotool | v2.3.1 (standalone build) |
| mbedtls (configure-time clone) | `068ff080b369adfac81509f9b57b2afabaf82dc5` (`mbedtls-3.6.7`) |
| tinycbor (configure-time clone) | `c0aad2fb2137a31b9845fbaae3653540c410f215` (tag `v0.6.1`) |
| EdDSA | not enabled (standard mbedtls only) |

Resolved flags: `PICO_BOARD=vcc-gnd_yd-rp2040_4m`,
`PICO_USE_FASTEST_SUPPORTED_CLOCK=0`, `PICO_FLASH_SIZE_LIMIT_BYTES=0x200000`,
`FORCE_BUTTON_WAIT=ON`, `ENABLE_OATH_APP=ON`, `ENABLE_OTP_APP=ON`.

## Observed status (2026-10-05)

| Area | Status | Evidence |
|---|---|---|
| SDK storage work (flash layout module, reordered `low_flash_init`, harness) | SOURCE REVIEWED | commits `9256c2b..d0ed4c3` on `pipico/storage-baseline`, one concern each, plus merge `7973a99` of the externally advanced fix head and the adapted regression `f48d23d` |
| Root integration work (submodule URL, gitlinks, build preset, clock gate, product string, bounds gate) | SOURCE REVIEWED | commits `6d9b989..eaeb9c2` on `pipico/integration-v1`, one concern each, plus merge `ceff701` of the externally advanced fix head, the gitlink bump `a27a51a` and the bounds self-test fix `2f2705c` |
| ARM firmware, Pipico preset | BUILT | `scripts/pipico/build.sh` exit 0; no CMake or compiler warnings; clock and image-bounds gates PASS |
| Clock gate | AUTOMATED TESTS PASSED | `SYS_CLK_HZ=125000000`, `USB_CLK_HZ=48000000`, `PICO_USE_FASTEST_SUPPORTED_CLOCK=0`; cap and `FORCE_BUTTON_WAIT` present in 206/206 TUs |
| Image-bounds gate | AUTOMATED TESTS PASSED | image write end `0x10084b00` (offset `0x84b00` of the `0x100000` limit); erase footprint end `0x85000`; headroom `0x7b500` bytes |
| SDK host tests | AUTOMATED TESTS PASSED | ctest 14/14: 3 upstream object tests, `flash_layout_test`, 10 `low_flash_*` harness variants (including `locked_boot`) |
| SDK flash-size-limit python regression | AUTOMATED TESTS PASSED | `python3 tests/test_flash_size_limit.py`: 12/12 unittest cases (observed 2026-10-05, after the M1 adaptation) |
| Root clock-override regression | AUTOMATED TESTS PASSED | `tests/test_clock_override.py` (merged from `7d08bf8`): passes standalone (`python3`) and under pytest collection (1 test, 20 subtests), host CMake only, no emulator needed |
| Root host tests | AUTOMATED TESTS PASSED | ctest 6/6: the 5 upstream `fido_*_test` suites plus the mission-added `fido_storage_locked_test` |
| Emulation python-fido2 suite | NOT_RUN in M1 (gate starts in M2) | the collected set now includes `tests/test_clock_override.py` (host-only), so the emulation pass counts will grow by one test with 20 subtests once this gate runs |
| Live clock on the board | HARDWARE TESTED = NOT_RUN | no board attached |
| Host CLI | HOST INSTALLED = NOT_RUN | M4 deliverable |
| Flashing the board | FLASHED = NOT_RUN | no device writes in this mission |
| Account enrollment | ACCOUNT ENROLLED = NOT_RUN | no enrollment in this mission |

## Reported (claims accepted from commits/messages, not verified here)

- "The old firmware programmed a 4-byte marker (`53 59 45 4B`) because of a
  `sizeof(pointer)` bug" is **reported**: it is inferred from source review
  and reproduced only in the host flash harness. The on-hardware pattern was
  never observed (no board is attached).
- "125 MHz is stable on this board" is **reported** by the base commit
  `1cd988d` author; this mission resolves the clock at build time
  (AUTOMATED TESTS PASSED) but has not observed the board (HARDWARE TESTED
  = NOT_RUN).
- CI: the SDK workflow `pipico-sdk-tests` ran on the fork and concluded
  success twice: on the SDK SHA pushed in the first M1 push, before the
  external-advance merges (run `37304456019`, job `host-tests`), and on the
  re-pushed head `f48d23d…` after the merges (run `37387049402`, job
  `host-tests`, including the flash-size-limit python regression step); both
  observed 2026-10-05 (see `MANIFEST.md`). The root workflow does not exist
  yet (M5); there is no CI evidence for the root fork, which stays "evidence
  not found", not "failed".

## Honesty rules applied in these documents

- The effective 2 MiB limit (`PICO_FLASH_SIZE_LIMIT_BYTES=0x200000`) is a
  build-time decision. It is **not evidence** of the physical chip size.
- The flash is never described as defective.
- Claims about CI runs, reproducibility and release artifacts are not made
  before the evidence exists (see the PROPOSED section of `MANIFEST.md`).
