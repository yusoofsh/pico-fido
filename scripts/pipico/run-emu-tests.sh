#!/usr/bin/env bash
# Runs the python-fido2 suite against the ENABLE_EMULATION emulator.
#
# Honours:
#   PIPICO_EMULATOR    emulator binary (default build/pico_fido)
#   PIPICO_EMU_RUN_DIR run directory (default build/emu-run); gets a fresh
#                      memory.flash on every run
#   PYTEST             pytest command (default pytest)
#
# The emulator runs with PICOKEYS_EMULATION_BUTTON_FILE pointing into the run
# directory, so the emulated BOOT button tests can drive it through the
# control file (see docs/pipico/EMULATION.md).
set -u
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
EMULATOR="${PIPICO_EMULATOR:-build/pico_fido}"
RUN_DIR="${PIPICO_EMU_RUN_DIR:-build/emu-run}"
PYTEST_BIN="${PYTEST:-pytest}"

case "$EMULATOR" in
    /*) ;;
    *) EMULATOR="$ROOT/$EMULATOR" ;;
esac
case "$RUN_DIR" in
    /*) ;;
    *) RUN_DIR="$ROOT/$RUN_DIR" ;;
esac

if [ ! -x "$EMULATOR" ]; then
    echo "run-emu-tests: emulator is not executable: $EMULATOR" >&2
    echo "run-emu-tests: build it with ENABLE_EMULATION=1 (see docs/pipico/EMULATION.md)" >&2
    exit 2
fi

mkdir -p "$RUN_DIR"
rm -f "$RUN_DIR/memory.flash" # fresh device on every run

EMU_PID=""
cleanup() {
    if [ -n "$EMU_PID" ]; then
        kill "$EMU_PID" 2>/dev/null
        wait "$EMU_PID" 2>/dev/null
    fi
}
trap cleanup EXIT INT TERM

export PICOKEYS_EMULATION_BUTTON_FILE="$RUN_DIR/button.cmd"
rm -f "$PICOKEYS_EMULATION_BUTTON_FILE"

(cd "$RUN_DIR" && exec "$EMULATOR") &
EMU_PID=$!

# Wait for the emulator's HID server (it listens on 127.0.0.1:35962).
port_up=0
for _ in $(seq 1 100); do
    if ss -ltn 2>/dev/null | grep -q ':35962 '; then
        port_up=1
        break
    fi
    if ! kill -0 "$EMU_PID" 2>/dev/null; then
        break
    fi
    sleep 0.2
done
if [ "$port_up" != 1 ]; then
    echo "run-emu-tests: emulator did not open port 35962" >&2
    exit 3
fi

# Upstream baseline (non-EdDSA emulation): 306 passed, 3 skipped. The vault
# round-trip test needs CI secrets and is deselected; anything else failing
# is a regression.
"$PYTEST_BIN" tests -p no:cacheprovider \
    --deselect tests/pico-fido/test_080_vault.py::test_live_export_import_roundtrip \
    "$@"
status=$?

exit "$status"
