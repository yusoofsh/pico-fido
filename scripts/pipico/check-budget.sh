#!/usr/bin/env bash
# Companion budget gate (architecture.md section 5): compares the Pipico
# companion build (PIPICO_COMPANION=ON) against a baseline built from the
# same tuple without the companion (PIPICO_COMPANION=OFF) and fails when
# the deltas exceed the mission limits:
#   - static RAM (.data + .bss):        at most    8 KiB (8192 bytes)
#   - linked flash (.text + .rodata + .data LMA): at most 64 KiB (65536 bytes)
#
# Usage: check-budget.sh [--self-test]
#
# Honours:
#   PIPICO_BUILD_DIR           the companion-ON build directory
#                              (default: <repo>/build-pipico); must already
#                              contain pico_fido.elf (build.sh builds it).
#   PIPICO_BASELINE_BUILD_DIR  the OFF baseline directory (default:
#                              <repo>/build-pipico-nocompanion); built here
#                              with build.sh -DPIPICO_COMPANION=OFF when
#                              its pico_fido.elf is missing.
#   PIPICO_SIZE_CMD            size tool override (default
#                              arm-none-eabi-size). Self-test seam; not a
#                              production knob.
#
# Exit code 0 = within budget, 1 = over budget or broken inputs.

set -uo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$(dirname -- "$script_dir")")
build_dir=${PIPICO_BUILD_DIR:-$root/build-pipico}
baseline_dir=${PIPICO_BASELINE_BUILD_DIR:-$root/build-pipico-nocompanion}
size_cmd=${PIPICO_SIZE_CMD:-arm-none-eabi-size}

RAM_LIMIT=8192    # .data + .bss delta above the OFF baseline
FLASH_LIMIT=65536 # .text + .rodata + .data delta above the OFF baseline

fail() { echo "pipico-budget: FAIL: $*" >&2; exit 1; }

# Parse one ELF into the globals S_DATA, S_BSS, S_TEXT, S_RODATA; an
# absent section counts 0. Must be called directly (not in a command
# substitution): fail() has to exit the whole script on a broken input.
S_DATA=0
S_BSS=0
S_TEXT=0
S_RODATA=0
parse_sizes() {
  local elf=$1 table
  table=$("$size_cmd" -A "$elf" 2>/dev/null) || fail "size failed for $elf"
  S_DATA=$(awk -v sec=".data" '$1==sec && !seen {seen=1; print $2} END {if (!seen) print 0}' <<<"$table")
  S_BSS=$(awk -v sec=".bss" '$1==sec && !seen {seen=1; print $2} END {if (!seen) print 0}' <<<"$table")
  S_TEXT=$(awk -v sec=".text" '$1==sec && !seen {seen=1; print $2} END {if (!seen) print 0}' <<<"$table")
  S_RODATA=$(awk -v sec=".rodata" '$1==sec && !seen {seen=1; print $2} END {if (!seen) print 0}' <<<"$table")
}

run_gate() {
  local on_elf="$build_dir/pico_fido.elf" off_elf="$baseline_dir/pico_fido.elf"
  [ -f "$on_elf" ] || fail "companion build not found ($on_elf); run build.sh first"
  if [ ! -f "$off_elf" ]; then
    mkdir -p -- "$baseline_dir"
    local log="$baseline_dir/pipico-baseline-build.log"
    echo "pipico-budget: building the PIPICO_COMPANION=OFF baseline in $baseline_dir"
    PIPICO_BUILD_DIR="$baseline_dir" bash "$script_dir/build.sh" -DPIPICO_COMPANION=OFF >"$log" 2>&1 \
      || { tail -20 "$log" >&2; fail "baseline build failed (log: $log)"; }
  fi
  [ -f "$off_elf" ] || fail "baseline build did not produce $off_elf"

  parse_sizes "$on_elf"
  local on_data=$S_DATA on_bss=$S_BSS on_text=$S_TEXT on_rodata=$S_RODATA
  parse_sizes "$off_elf"
  local off_data=$S_DATA off_bss=$S_BSS off_text=$S_TEXT off_rodata=$S_RODATA

  local on_ram=$((on_data + on_bss)) off_ram=$((off_data + off_bss))
  local on_flash=$((on_text + on_rodata + on_data)) off_flash=$((off_text + off_rodata + off_data))
  local ram_delta=$((on_ram - off_ram)) flash_delta=$((on_flash - off_flash))
  local ram_ok=0 flash_ok=0
  [ "$ram_delta" -le "$RAM_LIMIT" ] && ram_ok=1
  [ "$flash_delta" -le "$FLASH_LIMIT" ] && flash_ok=1

  echo "pipico-budget: companion build:  .data=$on_data .bss=$on_bss .text=$on_text .rodata=$on_rodata"
  echo "pipico-budget: baseline build:   .data=$off_data .bss=$off_bss .text=$off_text .rodata=$off_rodata"
  echo "pipico-budget: static RAM (.data+.bss) delta: $ram_delta B (limit $RAM_LIMIT B): $([ $ram_ok -eq 1 ] && echo OK || echo OVER)"
  echo "pipico-budget: linked flash (.text+.rodata+.data) delta: $flash_delta B (limit $FLASH_LIMIT B): $([ $flash_ok -eq 1 ] && echo OK || echo OVER)"
  printf '{"ram": {"companion": %d, "baseline": %d, "delta": %d, "limit": %d, "ok": %s}, "flash": {"companion": %d, "baseline": %d, "delta": %d, "limit": %d, "ok": %s}}\n' \
    "$on_ram" "$off_ram" "$ram_delta" "$RAM_LIMIT" "$([ $ram_ok -eq 1 ] && echo true || echo false)" \
    "$on_flash" "$off_flash" "$flash_delta" "$FLASH_LIMIT" "$([ $flash_ok -eq 1 ] && echo true || echo false)"

  [ $ram_ok -eq 1 ] || fail "static RAM delta $ram_delta exceeds the ${RAM_LIMIT} B budget"
  [ $flash_ok -eq 1 ] || fail "linked flash delta $flash_delta exceeds the ${FLASH_LIMIT} B budget"
  echo "pipico-budget: OK"
  return 0
}

# Negative self-test: synthetic ELF pairs with a fake size tool, one case
# within budget and one over each limit by exactly one byte. Each over-budget
# case must exit nonzero.
self_test() {
  local tmp rc total=0 failed=0
  tmp=$(mktemp -d) || fail "mktemp"
  cat > "$tmp/fake-size" <<'EOF'
#!/bin/sh
# Minimal stand-in for `size -A <elf>`: the section table sits in a
# <path>.size file next to the (ignored) ELF argument.
for last in "$@"; do :; done
cat "$last.size"
EOF
  chmod +x "$tmp/fake-size"

  # write_case <dir> <data> <bss> <text> <rodata>: a fake ELF plus the
  # size -A table the fake tool prints for it.
  write_case() {
    local dir=$1 data=$2 bss=$3 text=$4 rodata=$5
    mkdir -p -- "$dir"
    : > "$dir/pico_fido.elf"
    {
      echo "$dir/pico_fido.elf  :"
      echo "section          size        addr"
      printf '.text      %10d   268435712\n' "$text"
      printf '.rodata    %10d   268864872\n' "$rodata"
      printf '.data      %10d   536871136\n' "$data"
      printf '.bss       %10d   536878720\n' "$bss"
      printf 'Total      %10d\n' "$((text + rodata + data + bss))"
    } > "$dir/pico_fido.elf.size"
  }

  expect() { # <label> <expected-rc: ok|fail> <rc>
    local label=$1 want=$2 rc=$3
    total=$((total + 1))
    if { [ "$want" = ok ] && [ "$rc" -eq 0 ]; } ||
       { [ "$want" = fail ] && [ "$rc" -ne 0 ]; }; then
      echo "self-test: $label ok"
    else
      echo "self-test: $label FAIL (rc=$rc, want $want)"
      failed=$((failed + 1))
    fi
  }

  # Within budget: RAM delta 416, flash delta 416.
  write_case "$tmp/ok/on" 8000 100000 429156 107692
  write_case "$tmp/ok/off" 7584 100000 429156 107692
  PIPICO_SIZE_CMD="$tmp/fake-size" PIPICO_BUILD_DIR="$tmp/ok/on" \
    PIPICO_BASELINE_BUILD_DIR="$tmp/ok/off" bash "$script_dir/check-budget.sh" >"$tmp/ok.out" 2>&1
  expect "within_budget_exits_zero" ok $?

  # RAM over by one byte: .data+.bss delta exactly 8193.
  write_case "$tmp/ram/on" 100 8293 100 50
  write_case "$tmp/ram/off" 100 100 100 50
  PIPICO_SIZE_CMD="$tmp/fake-size" PIPICO_BUILD_DIR="$tmp/ram/on" \
    PIPICO_BASELINE_BUILD_DIR="$tmp/ram/off" bash "$script_dir/check-budget.sh" >"$tmp/ram.out" 2>&1
  expect "ram_delta_8193_fails" fail $?

  # Flash over by one byte: .text+.rodata+.data delta exactly 65537.
  write_case "$tmp/flash/on" 50 100 65637 100
  write_case "$tmp/flash/off" 50 100 100 100
  PIPICO_SIZE_CMD="$tmp/fake-size" PIPICO_BUILD_DIR="$tmp/flash/on" \
    PIPICO_BASELINE_BUILD_DIR="$tmp/flash/off" bash "$script_dir/check-budget.sh" >"$tmp/flash.out" 2>&1
  expect "flash_delta_65537_fails" fail $?

  rm -rf -- "$tmp"
  echo "self-test: $((total - failed))/$total cases passed"
  [ $failed -eq 0 ]
}

case "${1:-}" in
--self-test)
  self_test
  ;;
"")
  command -v "$size_cmd" >/dev/null 2>&1 || fail "size tool not found: $size_cmd (set PIPICO_SIZE_CMD or source scripts/env.sh)"
  run_gate
  ;;
*)
  fail "usage: check-budget.sh [--self-test]"
  ;;
esac
