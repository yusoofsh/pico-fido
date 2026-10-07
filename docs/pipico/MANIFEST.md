# Source and dependency manifest (M1 baseline)

This manifest separates **OBSERVED** facts — values produced by commands run
against the working trees and fork remotes on **2026-10-05** — from
**PROPOSED** items that are planned but not yet evidenced. Do not cite a
PROPOSED item as fact. The M5 release feature refreshes this file with
SHA-256 hashes of the built artifacts.

Scope of the observations: root `pipico/integration-v1` @
`5833bc23c2c5d70f40bd8733faa52be5380d4cea` (CI-green head; docs commits may
sit on top — see the push receipts below), SDK
`pipico/companion-hooks` @ `3201dbd0e6972a97510c08d21d1386de130c62e2`
(contains `pipico/storage-baseline` @ `a1eb8cf541bae2575985e1b18fb97ced670193bb`
as an ancestor). Layout ID: `yd4m-effective2m-marker-gap-v1` (see
`LAYOUT.md`).

## OBSERVED: source tuple

| Component | Value | Observed with |
|---|---|---|
| Root fork | `yusoofsh/pico-fido`, branch `pipico/integration-v1` @ `5833bc23c2c5d70f40bd8733faa52be5380d4cea` (origin head at this refresh) | `git -C $ROOT rev-parse HEAD`, `git ls-remote origin refs/heads/pipico/integration-v1` |
| Root base | `fix/rp2040-clock-override` @ `1cd988de0a3acdce47b2d732f9e9c92017595900` | `git -C $ROOT rev-parse fix/rp2040-clock-override` |
| Root base (advanced externally) | `fix/rp2040-clock-override` @ `7d08bf80353b6aa178d40d36092b0712bf7acfee`, merged into the mission branch as merge commit `ceff7019541a2df333426856301418c861b77224` (parents `80fa7f25…`, `7d08bf8…`) | `git -C $ROOT log --format='%H %P' -1 ceff7019541a2df333426856301418c861b77224` |
| Root reference | `main` @ `f01fa1e2817a845e44d788f3f633a1f122ce332e` (untouched) | `git -C $ROOT ls-remote origin` |
| SDK fork | `yusoofsh/pico-keys-sdk`, branch `pipico/companion-hooks` @ `3201dbd0e6972a97510c08d21d1386de130c62e2`, stacked on `pipico/storage-baseline` @ `a1eb8cf541bae2575985e1b18fb97ced670193bb` (ancestor-verified) | `git -C $SDK rev-parse HEAD`, `git -C $SDK merge-base --is-ancestor a1eb8cf 3201dbd` |
| SDK base | `fix/flash-size-limit` @ `a26c831ceb20d5d6c60e97cdc457e426d2abf3ed` | `git -C $SDK rev-parse fix/flash-size-limit` |
| SDK base (advanced externally) | `fix/flash-size-limit` @ `28cd6a428c54f5fc83c94bc06b4d1d9855b97451`, merged into the mission branch as merge commit `7973a9916d9f70717a69d1c50645c1d36e4bb52a` (parents `42e740a…`, `28cd6a4…`) | `git -C $SDK log --format='%H %P' -1 7973a9916d9f70717a69d1c50645c1d36e4bb52a` |
| SDK reference | `main` @ `50699e53e8ada214c27f6c9b66ea3b6f127fc655` (untouched) | `git -C $SDK ls-remote origin` |
| Root gitlink | `pico-keys-sdk` = `3201dbd0e6972a97510c08d21d1386de130c62e2`, equal to the `pipico/companion-hooks` head | `git -C $ROOT ls-tree HEAD pico-keys-sdk` |
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
| SDK host ctest | 14/14 passed: `object_store_test`, `object_crypto_provider_test`, `object_policy_test` (upstream), `flash_layout_test` (pure module), and 10 `low_flash_*` integration-harness variants (`capped4m`, `capped2m`, `cap_misaligned`, `cap_too_small`, `nolimit2m`, `nolimit4m`, `nolimit16m`, `nolimit1m`, `nolimit512k`, `locked_boot`) |
| SDK flash-size-limit python regression | `python3 tests/test_flash_size_limit.py` (adapted to the M1 design in `f48d23d`): 12/12 unittest cases passed |
| ARM build + gates | `build.sh` exit 0; clock gate PASS; image-bounds gate PASS (self-test 16/16 after the case (a) fixture fix in `2f2705c`) |
| Root clock-override regression | `python3 tests/test_clock_override.py` (merged from `7d08bf8` in merge `ceff701`): passes standalone and under pytest collection, 1 test with 20 subtests, no emulator needed |
| Root host ctest | 6/6 passed: `fido_object_provider_test`, `fido_object_authorization_test`, `fido_resident_container_test`, `fido_oath_container_test`, `fido_otp_container_test`, and the mission-added `fido_storage_locked_test` |

## OBSERVED: publication state

First M1 push (observed 2026-10-05, before the external-advance merges):

- Both mission branches were pushed: `pipico/storage-baseline` @
  `4ca0d2a40b565ac08e823328dac7f1b810c4ae73` on `yusoofsh/pico-keys-sdk` and
  `pipico/integration-v1` @ `eaeb9c25c96e6f4c01331fc7732e67297330eb29` on
  `yusoofsh/pico-fido`. The SDK branch was pushed first, then the root
  branch; no force-push.
- Push access was verified with `git push --dry-run` for both forks before
  the push (both returned success). Push access had become available through
  a user-provided credential; the credential itself is not recorded anywhere
  in this repository.
- The pre-mission branches were untouched at their recorded SHAs (`main`,
  `fix/*`, `plugin`, `preview_sign`, `development`,
  `copilot/fix-code-scanning-alerts-254`; see the validation contract,
  VAL-PUB-004), and the only new heads were the two `pipico/*` branches.
- G0 fresh-clone check passed at that state: `git clone --recurse-submodules
  -b pipico/integration-v1 https://github.com/yusoofsh/pico-fido` checks out
  the submodule at `4ca0d2a40b565ac08e823328dac7f1b810c4ae73`, `git
  submodule status --recursive` prints a leading space (no `-`, `+` or `U`
  marker), `git status --porcelain --ignore-submodules=none` is empty in the
  root and the submodule, and the submodule origin is
  `https://github.com/yusoofsh/pico-keys-sdk`.
- The SDK CI workflow ran on the fork and succeeded at that state: run
  `37304456019`
  (https://github.com/yusoofsh/pico-keys-sdk/actions/runs/37304456019),
  workflow `pipico-sdk-tests`, event `push`, branch
  `pipico/storage-baseline`, headSha `4ca0d2a40b565ac08e823328dac7f1b810c4ae73`,
  job `host-tests` completed with conclusion **success** (`gh run list` /
  `gh run view`).

Re-push with the external-advance merges (observed 2026-10-05):

- Both mission branches were pushed again, SDK first: `pipico/storage-baseline`
  fast-forwarded `42e740ab9b7a8c6e90ebfaa0849372c53f188263..f48d23ddb55add5fb3118884e64f7456a29b70bd`
  and `pipico/integration-v1` fast-forwarded
  `80fa7f25c39539e9f2eb158d86ecb67a2f65a8b7..f163038eac2ff48c46357f53654355114c11d44b`
  (`git push` exit 0 on both; no force-push, and the `fix/*` refs were never
  written). `git ls-remote` confirms the two heads, and the root gitlink
  (`f48d23d…`) equals the SDK remote head.
- The SDK CI workflow ran on the new SDK head and succeeded: run `37387049402`
  (https://github.com/yusoofsh/pico-keys-sdk/actions/runs/37387049402),
  workflow `pipico-sdk-tests`, event `push`, branch `pipico/storage-baseline`,
  headSha `f48d23ddb55add5fb3118884e64f7456a29b70bd`, job `host-tests`
  completed with conclusion **success**, including the new
  `Run the flash-size-limit python regression` step (`gh run list` /
  `gh run view`).
- Nothing is merged into `main` and no mission PR exists yet; draft PRs are
  the M5 release feature.

## OBSERVED: push receipts (M2–M5)

Every push of the mission branches after the M1 publications above, in
chronological order. All were fast-forward pushes (SDK first, then root; no
force-push; `main` and `fix/*` never written). Every SHA below was verified
to exist with `git cat-file -e <sha>^{commit}` in the SDK or root clone
during this refresh (25/25 resolve). CI conclusions were observed with
`gh run list`; the SDK CI workflow is `pipico-sdk-tests`. No root workflow
existed before M5, so early root pushes name none.

| When (UTC) | Feature | Branch and push range (old..new) | CI run |
|---|---|---|---|
| 2026-10-06 | m2-emulated-boot-button | SDK `pipico/storage-baseline` `f48d23d…fe1be45ff68aab65b7ac2831860320d058e07687` | `37394112027` success |
| 2026-10-06 | m2-emulated-boot-button | root `pipico/integration-v1` `0f68e1d7a77a0223bf160aa1e945a8373599b123..89a7f0392c04a3d959af33e6daff64c2498d6227` | none yet on root |
| 2026-10-06 | m2-publish-presence-fido | SDK `pipico/storage-baseline` `fe1be45…069b95b8c5cf871b667be0c3ce58f328257436e8` | `37410861807` success |
| 2026-10-06 | m2-publish-presence-fido | root `pipico/integration-v1` `89a7f03…2510f7f84b450e2b7af90d6254b5885fc7f8d023` | none yet on root |
| 2026-10-06 | m2-fix-stale-touch-boundaries | SDK `pipico/storage-baseline` `069b95b…75dc0e063548a4b92ea0d0b46bf61264f661ac75` | `37413595243` success |
| 2026-10-06 | m2-fix-stale-touch-boundaries | root `pipico/integration-v1` `2510f7f…f028f0d74109935532be10cad1a631dc96250e12` | none yet on root |
| 2026-10-06 | m2-fix-ctaphid-cancel-same-channel | SDK `pipico/storage-baseline` `75dc0e0…462660a74ba72ab24ed10f1b8ae634ac96ee13b2` | `37421823560` success |
| 2026-10-06 | m2-fix-ctaphid-cancel-same-channel | root `pipico/integration-v1` `f028f0d…7e1749acc76327a05058a353a833d4acb6c5a4e1` | none yet on root |
| 2026-10-06 | m2-fix-cancel-fast-retry-race | SDK `pipico/storage-baseline` `462660a…13ba59e7c5db69cc56a422a43e703a974b9f4a6d` | `37440459162` success |
| 2026-10-06 | m2-fix-cancel-fast-retry-race | root `pipico/integration-v1` `7e1749a…61007929de4fa94c21dabf9c7f65517c3f3d62db` | none yet on root |
| 2026-10-06 | m2-fix-cancel-retry-fragmented | SDK `pipico/storage-baseline` `13ba59e…42c19433c783903730bb1006a4e8c09cddcf1307` | `37451538536` success |
| 2026-10-06 | m2-fix-cancel-retry-fragmented | root `pipico/integration-v1` `6100792…7eed77805b9b5f9df35bb00dd1827801e39bba95` | none yet on root |
| 2026-10-06 | m2-fix-cancel-path-consolidated | SDK `pipico/storage-baseline` `42c1943…78c7d07c4421a3a037c04a9877e995e38c5536dd` | `37482931099` success |
| 2026-10-06 | m2-fix-cancel-path-consolidated | root `pipico/integration-v1` `7eed778…e122bedbd95f9179f259c37525f95670facb038a` | none yet on root |
| 2026-10-06 | m2-cancel-path-randomized-test | SDK `pipico/storage-baseline` `78c7d07…5ea02ba2fc218beae750a5c692799319b2fb0672` | `37499923753`, `37499923591` success |
| 2026-10-06 | m2-cancel-path-randomized-test | root `pipico/integration-v1` `e122bed…550350c038733d0eb0f107048232852274f9f35c` | none yet on root |
| 2026-10-07 | m2-deflake-randomized-cancel-test | SDK `pipico/storage-baseline` `5ea02ba…a1eb8cf541bae2575985e1b18fb97ced670193bb` | `37562735185` success |
| 2026-10-07 | m2-deflake-randomized-cancel-test | root `pipico/integration-v1` `550350c…bb6144193f87facbb81f9eb5009a5e4a479d1e7c` | none yet on root |
| 2026-10-07 | m3-sdk-hooks-and-kb-transmitter | SDK new branch `pipico/companion-hooks` @ `3201dbd0e6972a97510c08d21d1386de130c62e2` (6 commits, stacked on `pipico/storage-baseline` `a1eb8cf…`) | `37615375963` success on `3201dbd…` |
| 2026-10-07 | m3-sdk-hooks-and-kb-transmitter | root `pipico/integration-v1` `bb61441…068212bcd81946572f77f360bb06acfb7e61d654` | none yet on root |
| 2026-10-07 | M4 host-CLI commits + m5-ci-workflows | root `pipico/integration-v1` `068212b…5833bc23c2c5d70f40bd8733faa52be5380d4cea` (the M4 host-CLI commits plus the CI workflow commits `eb5aa19…5833bc2`; recorded receipts are the workflow runs) | `37678066567` success on `dd6d9a9…`, `37679411045` success on `3d45c53…`, **`37682443999` success on `5833bc2…` (final)** |

Notes:

- The final root CI run `37682443999` (workflow `pipico.yml`, branch
  `pipico/integration-v1`, head `5833bc23c2c5d70f40bd8733faa52be5380d4cea`)
  concluded success with the release-evidence artifact; its log showed
  root host ctest 67/67, pytest 348 passed / 3 skipped / 1 deselected /
  0 failed, `bun test` 315 pass / 0 fail, bounds self-test 17/17 and the
  budget gate OK (RAM +20 B / 8192, flash +1192 B / 65536). Observed with
  `gh run list` / `gh run view --log` at this refresh.
- The last SDK CI observation is run `37615375963` (success) on
  `pipico/companion-hooks` @ `3201dbd…`, the exact gitlink of the root head
  above.
- Docs-only commits pushed after a built/cited SHA are named in
  `HANDOFF.md`; they change no build input.

## PROPOSED (not yet evidenced)

- **Reproducible build**: two clean builds from fresh recursive clones with
  identical UF2/ELF/bin SHA-256 — planned in M5. No reproducibility claim is
  made now.
- **Draft PRs** into each fork's `main` — M5 release feature. The **root CI
  workflow** (`pipico.yml`) is now OBSERVED: pushed and green on
  `5833bc2…` (run `37682443999`, see the push receipts above).
- **Release evidence** with SHA-256 hashes of the UF2/ELF/bin, map file,
  size and write-range report and test receipts — M5.
- **HARDWARE TESTED / HOST INSTALLED / FLASHED / ACCOUNT ENROLLED** — NOT_RUN
  for the whole mission (no board, no Mac).
- **Emulation python-fido2 gate** — OBSERVED since M2: the receipts above
  (CI run `37682443999`: 348 passed / 3 skipped / 1 deselected / 0 failed).
- USB product string "Yusoofs Pipico": the compile definition
  (`USB_PRODUCT_STRING`, root `CMakeLists.txt:99`) is SOURCE REVIEWED and the
  image is BUILT with it; USB enumeration with that string on a real host is
  HARDWARE TESTED = NOT_RUN.
