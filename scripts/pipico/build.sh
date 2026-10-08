#!/usr/bin/env bash
# Yusoofs Pipico build preset: pinned tuple per architecture.md section 2.
#
# Usage: build.sh [extra cmake -D flags...]
#   Extra flags are passed through to cmake after the pinned ones.
#
# Honours:
#   PIPICO_BUILD_DIR   build directory (default: <repo>/build-pipico)
#   PICO_SDK_PATH      Pico SDK 2.3.1 tree (exported by scripts/env.sh)
#   PICOTOOL_DIR       standalone picotool build dir (exported by scripts/env.sh)
#
# Behavior:
#   - configures with Ninja and the pinned Pipico flags (no EdDSA);
#   - exports compile_commands.json;
#   - fails on ANY CMake or compiler diagnostic, including unused
#     manually-specified cmake variables;
#   - records the resolved toolchain and dependency tuple in
#     <build dir>/pipico-build-tuple.txt;
#   - runs the post-build gates (check-clock.py, check-image-bounds.py and,
#     for companion builds, check-budget.sh) and exits nonzero if any gate
#     fails.

set -uo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$(dirname -- "$script_dir")")
build_dir=${PIPICO_BUILD_DIR:-$root/build-pipico}

# The budget gate compares against the PIPICO_COMPANION=OFF baseline and
# only makes sense for a companion build; building the baseline (passed as
# an extra -DPIPICO_COMPANION=OFF) skips it.
companion=ON
for arg in "$@"; do
  case "$arg" in
  -DPIPICO_COMPANION=OFF | PIPICO_COMPANION=OFF) companion=OFF ;;
  -DPIPICO_COMPANION=ON | PIPICO_COMPANION=ON) companion=ON ;;
  esac
done

fail() { echo "pipico-build: FAIL: $*" >&2; exit 1; }

[ -n "${PICO_SDK_PATH:-}" ] || fail "PICO_SDK_PATH is not set (source scripts/env.sh)"
[ -n "${PICOTOOL_DIR:-}" ] || fail "PICOTOOL_DIR is not set (source scripts/env.sh)"
command -v cmake >/dev/null 2>&1 || fail "cmake not in PATH"
command -v ninja >/dev/null 2>&1 || fail "ninja not in PATH"
command -v arm-none-eabi-gcc >/dev/null 2>&1 || fail "arm-none-eabi-gcc not in PATH"
[ -x "$PICOTOOL_DIR/picotool" ] || fail "picotool binary not found at $PICOTOOL_DIR/picotool"

mkdir -p -- "$build_dir"
configure_log="$build_dir/pipico-configure.log"
build_log="$build_dir/pipico-build.log"

echo "pipico-build: configuring $root into $build_dir"
cmake -S "$root" -B "$build_dir" -G Ninja \
  -DPICO_SDK_PATH="$PICO_SDK_PATH" \
  -DPICO_BOARD=vcc-gnd_yd-rp2040_4m \
  -DPICO_USE_FASTEST_SUPPORTED_CLOCK=0 \
  -DPICO_FLASH_SIZE_LIMIT_BYTES=0x200000 \
  -DFORCE_BUTTON_WAIT=ON \
  -DENABLE_OATH_APP=ON \
  -DENABLE_OTP_APP=ON \
  -DPIPICO_COMPANION=ON \
  -DPIPICO_REPRODUCIBLE_BUILD=ON \
  -Dpicotool_DIR="$PICOTOOL_DIR" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  "$@" 2>&1 | tee "$configure_log"
rc=${PIPESTATUS[0]}
[ $rc -eq 0 ] || { echo "pipico-build: configure failed (rc=$rc, log: $configure_log)"; exit 1; }

diagnostics=$(grep -in "warning" "$configure_log" || true)
if [ -n "$diagnostics" ]; then
  echo "pipico-build: CMake diagnostics in $configure_log:"
  printf '%s\n' "$diagnostics"
  echo "pipico-build: the Pipico preset does not allow CMake diagnostics"
  exit 1
fi
echo "pipico-build: configure log clean"

echo "pipico-build: building"
ninja -C "$build_dir" -j"${PIPICO_JOBS:-$(nproc 2>/dev/null || echo 2)}" 2>&1 | tee "$build_log"
rc=${PIPESTATUS[0]}
[ $rc -eq 0 ] || { echo "pipico-build: build failed (rc=$rc, log: $build_log)"; exit 1; }
diagnostics=$(grep -in "warning" "$build_log" || true)
if [ -n "$diagnostics" ]; then
  echo "pipico-build: compiler diagnostics in $build_log:"
  printf '%s\n' "$diagnostics"
  echo "pipico-build: the Pipico preset does not allow compiler diagnostics"
  exit 1
fi
echo "pipico-build: build log clean"

for f in pico_fido.elf pico_fido.uf2 compile_commands.json; do
  [ -f "$build_dir/$f" ] || fail "missing build output $build_dir/$f"
done

# Record the resolved tuple (recorded, not enforced; check the values).
gcc_ver=$(arm-none-eabi-gcc --version | head -1)
sdk_sha=$(git -C "$PICO_SDK_PATH" rev-parse HEAD 2>/dev/null || echo unknown)
tusb_sha=$(git -C "$PICO_SDK_PATH/lib/tinyusb" rev-parse HEAD 2>/dev/null || echo unknown)
pt_ver=$("$PICOTOOL_DIR/picotool" version 2>/dev/null | head -1)
[ -n "${pt_ver:-}" ] || pt_ver=unknown
mb_sha=$(git -C "$root/pico-keys-sdk/third-party/mbedtls" rev-parse HEAD 2>/dev/null || echo unknown)
cb_sha=$(git -C "$root/pico-keys-sdk/third-party/tinycbor" rev-parse HEAD 2>/dev/null || echo unknown)

tuple_file="$build_dir/pipico-build-tuple.txt"
{
  echo "arm-none-eabi-gcc: $gcc_ver"
  echo "pico-sdk: $sdk_sha ($PICO_SDK_PATH)"
  echo "tinyusb: $tusb_sha"
  echo "picotool: $pt_ver"
  echo "mbedtls: $mb_sha"
  echo "tinycbor: $cb_sha"
  echo "PICO_BOARD=vcc-gnd_yd-rp2040_4m"
  echo "PICO_USE_FASTEST_SUPPORTED_CLOCK=0"
  echo "PICO_FLASH_SIZE_LIMIT_BYTES=0x200000"
  echo "FORCE_BUTTON_WAIT=ON"
  echo "ENABLE_OATH_APP=ON"
  echo "ENABLE_OTP_APP=ON"
  echo "PIPICO_COMPANION=$companion"
  grep '^PIPICO_REPRODUCIBLE_BUILD:BOOL=' "$build_dir/CMakeCache.txt"
  echo "ENABLE_EDDSA: not enabled (off by default)"
} | tee "$tuple_file"

gates_failed=0
clock_gate="$script_dir/check-clock.py"
[ -x "$clock_gate" ] || fail "missing clock gate $clock_gate"
echo "pipico-build: running clock gate"
python3 "$clock_gate" "$build_dir" || gates_failed=1
bounds_gate="$script_dir/check-image-bounds.py"
[ -x "$bounds_gate" ] || fail "missing bounds gate $bounds_gate"
echo "pipico-build: running image bounds gate"
python3 "$bounds_gate" "$build_dir" || gates_failed=1
if [ "$companion" = ON ]; then
  budget_gate="$script_dir/check-budget.sh"
  [ -x "$budget_gate" ] || fail "missing budget gate $budget_gate"
  echo "pipico-build: running companion budget gate"
  PIPICO_BUILD_DIR="$build_dir" bash "$budget_gate" || gates_failed=1
else
  echo "pipico-build: PIPICO_COMPANION=OFF (budget baseline): budget gate skipped"
fi
[ $gates_failed -eq 0 ] || { echo "pipico-build: gate(s) failed"; exit 1; }

echo "pipico-build: OK"
exit 0
