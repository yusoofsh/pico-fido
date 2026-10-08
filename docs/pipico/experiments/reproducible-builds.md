# Reproducible firmware build experiment

This is a separate experiment based on the validated V1 source at
`880eaab4d474126f6807c3b14e1352cf892ede84`. The V1 draft PRs and the historical
evidence in `docs/pipico/release/` remain the release baseline until this patch
has been reviewed. This document describes the method; observed hashes and
pass/fail receipts are produced for each exact experiment commit by CI and
reported in the separate experiment PR.

## Changes

`PIPICO_REPRODUCIBLE_BUILD` defaults OFF for ordinary CMake builds. The Pipico
build preset enables it. In device builds it applies compiler options before
creating targets, including separately compiled SDK libraries and assembly:

| Input root | Stable compiler path |
|---|---|
| Firmware source, including the pinned pico-keys-sdk submodule | `.` |
| External Pico SDK source | `./pico-sdk` |
| Generated build files | `./build` |

The options use GCC `-ffile-prefix-map`, which normalizes both macro-expanded
source paths and debug paths. The existing pico-keys-sdk macro map remains
active; SDK diagnostic filenames may therefore use its existing `src/...`
form. The tested layout has independent firmware and Pico SDK source roots;
the build root can be independent or beneath the firmware source root.

`PICO_NO_BI_PROGRAM_BUILD_DATE=1` is a compiler definition, including on Pico
SDK's `standard_binary_info.c`. It omits the optional firmware build-date
record. Passing that name only as an unused CMake variable would not achieve
this and would fail the preset's diagnostics gate.

The existing SDK computes `PICO_BUILD_NUMBER` with `git rev-list --count HEAD`.
Full history is therefore a required build input. Reproducible mode rejects
shallow source checkouts, and both experiment-branch CI workflows check out
full history. The runner records and verifies the history count. This keeps
the SDK's build-number mechanism intact; it can change the reported build
number compared with V1's historical shallow CI checkout. Adding commits,
including documentation-only commits, also changes that number.

No SDK source or gitlink change is needed. The SDK pin remains
`e96e50208d6dcc78baa69c52de1e3340fd17749b`. The compiler, Pico SDK, TinyUSB,
mbedtls, tinycbor, picotool, board, clock, flash cap, user-presence settings,
USB identity, and storage layout are retained.

## Running the experiment

Use a clean, full-history checkout of the experiment commit and the same
toolchain installation as `.github/workflows/pipico-reproducibility.yml`.
The workflow verifies the Arm archive checksum and the dependency commits.
The runner also verifies the effective compiler/dependency tuple.

```bash
export PICO_SDK_PATH=/absolute/path/to/pico-sdk
export PICOTOOL_DIR=/absolute/path/to/picotool/picotool
export PICOTOOL_SOURCE_PATH=/absolute/path/to/picotool-src
# Add the pinned Arm GNU Toolchain 13.2.Rel1 bin directory to PATH.

python3 scripts/pipico/check-reproducibility.py \
  --work-dir /absolute/new/path/pipico-repro-work \
  --output-dir /absolute/new/path/pipico-repro-evidence
```

Both destination directories must be new. The runner works in its own fresh
clones; it never resets the supplied checkout or reuses compiled objects.
Local dependency repositories can supply committed Git objects, but each
variant gets independently checked out sources at the asserted commits.

The experiment uses GCC's supported `SOURCE_DATE_EPOCH` input and `TZ=UTC`
to set effective compiler dates to 7 and 8 October 2026. It records actual
`__DATE__` and `__TIME__` preprocessor probes from the pinned Arm compiler.
This controls compiler timestamps; it does not change the machine's clock.

| Configuration | Paths | Effective compiler date | Reproducible mode |
|---|---|---|---|
| Patched A | Source, SDK, and build roots A | 7 October | ON |
| Patched B | Different-length source, SDK, and build roots B | 7 October | ON |
| Patched B, fresh again | Identical absolute roots B, newly cloned and built | 8 October | ON |
| Date control 1 | Roots B, newly cloned and built | 7 October | OFF |
| Date control 2 | Identical roots B, newly cloned and built | 8 October | OFF |

Each configuration builds a fresh `PIPICO_COMPANION=OFF` budget baseline and
then the companion-ON firmware with matching reproducibility settings. The
existing `build.sh` runs its diagnostics, clock, image-bounds, and budget
gates. All three patched UF2, BIN, and ELF files must be byte-identical;
SHA-256 is recorded separately for every artifact. Logs, link maps, and
absolute-path build receipts are evidence, not reproducible output targets.

The full firmware date controls must differ. The runner preprocesses the
actual SDK metadata translation unit using its recorded compiler command and
inspects the firmware metadata, proving the date record is present and changes
in the controls and absent with the patch. It also checks that the selected
source, SDK, and build roots are absent from the patched firmware and ELF.

## Gates and receipts

Two workflows run on the experiment branch:

| Workflow | Coverage |
|---|---|
| `pipico` | Existing ARM ON/OFF build gates, image-bounds self-tests, root host ctest, python-fido2 emulation/security suite with the same single secret-dependent vault deselection, Bun host tests, and TypeScript typecheck |
| `pipico-reproducibility` | Fresh-build comparison, positive date controls, clock/budget self-tests, clock override regression, standalone SDK host tests, and flash-size-limit regression with UBSan |

The supplementary workflow uploads `pipico-reproducibility-evidence`, including
its experiment manifest, SHA-256 checksums, preserved binaries, compile commands,
metadata evidence, and gate logs. It attempts evidence upload on failure too.
The existing `pipico-release-evidence` artifact belongs to its workflow run;
an experiment-branch run does not replace the V1 branch or any historical
release artifact. Use the source SHA and run URL in each manifest when citing
results; an earlier run's hashes are not the hashes of a later commit.

The flash acceptance boundary remains offset `0x100000`: every flash-LMA
ELF load, UF2 write end, and sector-rounded erase footprint must stop at or
before it. The marker sector remains `[0x100000, 0x101000)`, with SDK data
below the effective `0x200000` cap. The companion budget remains at most
8192 bytes static RAM and 65536 bytes linked flash above its matching OFF
baseline. The system and USB clocks remain 125 MHz and 48 MHz.

## Impact and scope

Runtime diagnostic paths become stable and shorter, and the optional build-date
field disappears from `picotool info`. Firmware bytes, sizes, and addresses
can change relative to V1. The gate receipts establish the new limits and
headroom; historical V1 hashes are not expected to match the patched image.

Debug information is retained. A debugger may need its source search path or
`set substitute-path` configured for `./pico-sdk` and `./build`. No stripping
or post-build byte editing is used to obtain equality.

A passing experiment establishes reproducibility for the tested exact source
SHA, full Git history, pinned dependency/toolchain tuple, configuration, paths,
and controlled compiler dates. It does not establish equality across compiler
versions, operating systems, arbitrary source nesting, different inputs, or
hardware behavior. Hardware testing, flashing, account enrollment, and host
installation are outside this experiment and are not implied by CI success.

## Source references

- [V1 reproducibility diagnosis](../release/reproducibility.md)
- [Pico SDK metadata source at the pinned commit](https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2_common/pico_standard_binary_info/standard_binary_info.c)
- [GCC prefix-map option](https://gcc.gnu.org/onlinedocs/gcc-13.2.0/gcc/Overall-Options.html)
- [GCC SOURCE_DATE_EPOCH input](https://gcc.gnu.org/onlinedocs/gcc-13.2.0/gcc/Environment-Variables.html)
- [Unchanged SDK build-number implementation](https://github.com/yusoofsh/pico-keys-sdk/blob/e96e50208d6dcc78baa69c52de1e3340fd17749b/cmake/version.cmake)
