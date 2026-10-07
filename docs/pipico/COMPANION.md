# Pipico companion (USR button, F13–F16)

Status: SOURCE REVIEWED · BUILT · AUTOMATED TESTS PASSED (software level; hardware checks are NOT_RUN, see `HARDWARE-TESTS.md` when it lands).

The companion turns taps and holds of the YD-RP2040 USR button into fixed
F13–F16 key presses for the host CLI (`host/`). It runs from the SDK's
per-loop hook on core0, next to the FIDO firmware, and is gated by
`PIPICO_COMPANION` (ON in the Pipico preset; the OFF build is the budget
baseline).

## USR button: GPIO24, active low

- The board header names the button pin: `VCC_GND_YD_RP2040_BUTTON_PIN` = 24
  (Pico SDK board `vcc-gnd_yd-rp2040_4m`). The glue (`src/pipico/pipico.c`)
  uses that macro with a plain `24` fallback.
- The research report `button-hid-mainloop.md` found no external pull-up in
  any SDK or board code, so the glue enables the internal pull-up
  (`gpio_pull_up`) and treats **low = pressed** (the line idles high). The
  active level is `PIPICO_GESTURE_PRESSED_LEVEL` in `src/pipico/gesture.h`;
  a board with inverted wiring overrides it in one place.
- The SDK never reads GPIO24 (BOOT is BOOTSEL through the QPIO CS trick), so
  USR never counts as user presence.

## Boot latch

`picokey_early_init` (runs once, just before `usb_init()`):

1. configures GPIO24 as input with pull-up;
2. waits ≤ 1 ms with `busy_wait_us` (the only busy wait in the companion) so
   the pull-up settles;
3. samples the line three times 100 µs apart and latches "companion off for
   this boot" only if every sample reads pressed.

The latch is runtime-only RAM state: it changes no flash, PIN, credential,
counter or USB identity, and the UP policy is untouched. It resets on the
next power cycle or reset.

## Per-tick pipeline

`picokey_task` (runs once per core0 loop iteration, after `button_task()`):

1. returns immediately when the boot latch is set;
2. samples GPIO24 and the busy inputs once, by `to_ms_since_boot`
   timestamps, so a stalled core0 cannot break the gesture timing;
3. aborts a partial gesture while auth is busy, UP is pending or OTP is
   typing — the parser rearms only after a stable release;
4. feeds the gesture parser (tap → F13, double tap → F14, 1.5–3 s → F15,
   3–10 s → F16, ≥ 10 s → nothing; `gesture.h` states the emission rule);
5. offers the event to the pure keyboard arbiter, which drops it unless the
   FIDO/OTP side is idle, the keyboard interface is enabled, mounted,
   unsuspended and the transmitter is free; a pending event expires after
   100 ms and is never replayed;
6. executes the arbiter's action through the single-owner keyboard
   transmitter (`kb_tx_claim`/`kb_tx_add_buffer`/`kb_tx_release` with
   `KB_TX_OWNER_COMPANION`). The only usages ever sent are F13–F16
   (0x68–0x6B); the paired all-released report is the transmitter's own
   guarantee. The glue never sends TinyUSB reports directly.

## Busy mapping (auth busy)

The glue maps auth busy to `is_busy() || exec_finished_cancelled`
(read-only): a normal command completion consumes the busy timeout, while a
cancellation clears it before the old worker has finished unwinding, so the
cancellation marker must also suppress gestures during that interval. The
host glue tests (`ctest -R glue`) pin both the suppression and the normal
rearming after the busy source clears.

## Budget (observed)

`scripts/pipico/check-budget.sh` compares the companion build against a
same-tuple `PIPICO_COMPANION=OFF` baseline (built automatically when
missing) and fails above 8 KiB static RAM (`.data` + `.bss`) or 64 KiB
linked flash (`.text` + `.rodata` + `.data`). Observed on the current head
(ARM GNU 13.2.Rel1, Pico SDK 2.3.1, reported):

| Metric                      | Delta vs OFF baseline | Limit  |
|-----------------------------|-----------------------|--------|
| static RAM (`.data`+`.bss`) | 20 B                  | 8192 B |
| linked flash                | 1200 B                | 65536 B |

The gate self-test (synthetic size tables) fails at exactly +8193 B RAM and
+65537 B flash. Run it: `scripts/pipico/check-budget.sh --self-test`.

## Boundaries

The companion shares the core0 address space with FIDO by design; it is a
convenience input, not an isolation boundary. It never allocates, blocks,
writes flash, uses core1 or drives a LED, and it reads UP/credential state
only through the documented read-only accessors (`is_busy`,
`exec_finished_cancelled`, `is_req_button_pending`, `kb_tx_typing`,
`usb_kb_*`, `tud_hid_n_ready`). No security or tamper-resistance claim is
made for it. A keystroke is not authentication: F13–F16 can be produced by
any keyboard.
