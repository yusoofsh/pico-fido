# Source and dependency manifest (M1 baseline)

This manifest separates **OBSERVED** facts — values produced by commands run
against the working trees and fork remotes on **2026-10-05** — from
**PROPOSED** items that are planned but not yet evidenced. Do not cite a
PROPOSED item as fact. The M5 release feature refreshes this file with
SHA-256 hashes of the built artifacts.

Scope of the observations: root `pipico/integration-v1` @
`dcd7e8321ae6ac97fd0baf0742bacf1c17b6853d`, SDK `pipico/storage-baseline` @
`d0ed4c35bcefb3601ee81eb0b981a15bd87022ef`. Layout ID:
`yd4m-effective2m-marker-gap-v1` (see `LAYOUT.md`).

## OBSERVED: source tuple

| Component | Value | Observed with |
|---|---|---|
| Root fork | `yusoofsh/pico-fido`, branch `pipico/integration-v1` @ `dcd7e8321ae6ac97fd0baf0742bacf1c17b6853d` | `git -C $ROOT rev-parse HEAD` |
| Root base | `fix/rp2040-clock-override` @ `1cd988de0a3acdce47b2d732f9e9c92017595900` | `git -C $ROOT rev-parse fix/rp2040-clock-override` |
| Root reference | `main` @ `f01fa1e2817a845e44d788f3f633a1f122ce332e` (untouched) | `git -C $ROOT ls-remote origin` |
| SDK fork | `yusoofsh/pico-keys-sdk`, branch `pipico/storage-baseline` @ `d0ed4c35bcefb3601ee81eb0b981a15bd87022ef` | `git -C $SDK rev-parse HEAD` |
| SDK base | `fix/flash-size-limit` @ `a26c831ceb20d5d6c60e97cdc457e426d2abf3ed` | `git -C $SDK rev-parse fix/flash-size-limit` |
| SDK reference | `main` @ `50699e53e8ada214c27f6c9b66ea3b6f127fc655` (untouched) | `git -C $SDK ls-remote origin` |
| Root gitlink | `pico-keys-sdk` = `d0ed4c35bcefb3601ee81eb0b981a15bd87022ef`, equal to the SDK branch HEAD | `git -C $ROOT ls-tree HEAD pico-keys-sdk` |
| Submodule URL | `https://github.com/yusoofsh/pico-keys-sdk` | `$ROOT/.gitmodules` |

## OBSERVED: build dependencies

| Dependency | Ref / version | SHA | Where it resolves from |
|---|---|---|---|
| Arm GNU Toolchain | 13.2.rel1 — `arm-none-eabi-gcc 13.2.1 20231009` | n/a (binary tarball) | local toolchain dir (`arm-none-eabi-gcc --version`) |
| Pico SDK | tag `2.3.1` | `079c6f39023649b154152db30f1d781e884879bc` | `$PICO_SDK_PATH` (`git rev-parse HEAD`, `git describe --tags`) |
| TinyUSB | Pico SDK submodule | `86ad6e56c1700e85f1c5678607a762cfe3aa2f47` | `$PICO_SDK_PATH/lib/tinyusb` |
| picotool | `v2.3.1` standalone | n/a | `$PICOTOOL_DIR` (`picotool version`) |
| mbedtls | `mbedtls-3.6.7` | `068ff080b369adfac81509f9b57b2afabaf82dc5` | configure-time clone `pico-keys-sdk/third-party/mbedtls` (`git rev-parse HEAD`) |
| tinycbor | tag `v0.6.1` | `c0aad2fb2137a31b9845fbaae3653540c410f215` | configure-time clone `pico-keys-sdk/third-party/tinycbor` |
| CMake / Ninja | 3.28.3 / 1.13.2 | n/a | system / toolchain venv |

`third-party/` is created by the configure step and is **never committed**
(verified: 0 tracked `third-party/` files in both repos).

## OBSERVED: resolved build configuration

From `pipico-build-tuple.txt`, written by `scripts/pipico/build.sh` at the
last ARM build, and from the clock gate:

- `PICO_BOARD=vcc-gnd_yd-rp2040_4m`
- `PICO_USE_FASTEST_SUPPORTED_CLOCK=0` → `SYS_CLK_HZ=125000000`
- USB clock `48000000`
- `PICO_FLASH_SIZE_LIMIT_BYTES=0x200000`
- `FORCE_BUTTON_WAIT=ON`
- `ENABLE_OATH_APP=ON`, `ENABLE_OTP_APP=ON`
- EdDSA: not enabled
- `compile_commands.json` exported
- Cap and `FORCE_BUTTON_WAIT` compile definitions present in 206/206 TUs;
  no `SYS_CLK_*` override in any TU

Image (bounds-gate report, same build): write end `0x10084b00`, UF2 blocks
2123 (family `0xe48bff56`), erase footprint end `0x10085000`, headroom
`0x7b500` bytes below the `0x100000` code limit.

## OBSERVED: automated tests (2026-10-05)

`bash $MISSION_DIR/scripts/gate.sh lint sdk arm roothost` — exit 0, all
requested stages passed.

| Suite | Result |
|---|---|
| SDK host ctest | 13/13 passed: `object_store_test`, `object_crypto_provider_test`, `object_policy_test` (upstream), `flash_layout_test` (pure module), and 9 `low_flash_*` integration-harness variants (`capped4m`, `capped2m`, `cap_misaligned`, `cap_too_small`, `nolimit2m`, `nolimit4m`, `nolimit16m`, `nolimit1m`, `nolimit512k`) |
| ARM build + gates | `build.sh` exit 0; clock gate PASS; image-bounds gate PASS |
| Root host ctest | 5/5 passed: `fido_object_provider_test`, `fido_object_authorization_test`, `fido_resident_container_test`, `fido_oath_container_test`, `fido_otp_container_test` |

## OBSERVED: publication state

- No `pipico/*` branch exists on either fork remote (`git ls-remote`).
- `git push --dry-run` returns HTTP 403 on both forks (observed
  2026-10-05). Push is first needed at the end of M1; the mission-readiness
  note attributes the 403 to the missing Factory GitHub App authorization.
  Reported as-is.
- Consequently no CI run exists on either fork: for any CI query the current
  answer is "evidence not found", not "failed".

## PROPOSED (not yet evidenced)

- **Reproducible build**: two clean builds from fresh recursive clones with
  identical UF2/ELF/bin SHA-256 — planned in M5. No reproducibility claim is
  made now.
- **CI runs** (`pipico-sdk-tests.yml`, root `pipico.yml`) and the branch
  pushes that trigger them — M1 publication / M5.
- **Release evidence** with SHA-256 hashes of the UF2/ELF/bin, map file,
  size and write-range report and test receipts — M5.
- **HARDWARE TESTED / HOST INSTALLED / FLASHED / ACCOUNT ENROLLED** — NOT_RUN
  for the whole mission (no board, no Mac).
- **Emulation python-fido2 gate** — starts in M2.
- USB product string "Yusoofs Pipico": the compile definition
  (`USB_PRODUCT_STRING`, root `CMakeLists.txt:89`) is SOURCE REVIEWED and the
  image is BUILT with it; USB enumeration with that string on a real host is
  HARDWARE TESTED = NOT_RUN.
