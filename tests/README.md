# Tests Documentation

This directory contains Pico Fido test code and conformance-related documentation.

## Windows launchers

The top-level test and Docker workflows have `.bat` launchers for Windows.
They use Docker Desktop and mount the checkout at `/workspace` in the Linux
test container. The `.sh` counterparts remain available for Linux and the
Ubuntu GitHub Actions jobs.

## FIDO Alliance conformance results

The current FIDO Alliance Conformance Test App results are documented in
[`fido-alliance-conformance-results.md`](./fido-alliance-conformance-results.md).

Those results show that the tested Pico Fido firmware passed the conformance
tests captured in that report.

## Important limitation

Passing the FIDO Alliance conformance tests does **not** mean Pico Fido is
FIDO Alliance certified.

Official certification requires the separate FIDO Alliance certification
process and any corresponding approval/listing from the FIDO Alliance. This
documentation only states that the firmware passed the conformance tests that
would be used as part of that certification path.

## Clock-option regression (no hardware)

Run `python3 tests/test_clock_override.py` with host CMake available. It evaluates
the actual top-level clock configuration with SDK imports stubbed out: 20 cases
cover RP2040, both RP2350 configurations, ESP32 and emulation with default, `0`,
`1` and `OFF` inputs. This does not build firmware or test clock stability.

Selection note: this file sits under `tests/`, so the emulation pytest run
(`pytest tests` from the repo root, `scripts/pipico/run-emu-tests.sh`) also
collects and runs it. It needs only host CMake, not the emulator, and passes
without one (observed: `pytest tests/test_clock_override.py` on the host).
Emulation pytest pass counts therefore grow by one test (with its 20
subtests) compared with the pre-merge baseline; this is additive coverage,
not a FIDO regression.
