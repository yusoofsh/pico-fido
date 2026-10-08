/*
 * This file is part of the Pico FIDO distribution (https://github.com/polhenarejos/pico-fido).
 * Copyright (c) 2022 Pol Henarejos.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/* Pure, time-injected gesture parser for the USR button (GPIO24).
 *
 * The module includes no Pico SDK, hardware or OS header: it compiles on the
 * host and on the device unchanged. All timing is injected by the caller.
 *
 * Feed one sample per main-loop iteration (picokey_task) with
 * gesture_feed(now_ms, raw_level):
 *   - now_ms: millisecond timestamp, from to_ms_since_boot() on the device.
 *     It must never go backwards; it may wrap around (uint32 arithmetic, all
 *     comparisons are subtraction-based, so any span below 2^31 ms is safe).
 *   - raw_level: the raw GPIO level of the line, as read from the pin.
 *
 * Each call returns at most one event: NONE, F13, F14, F15 or F16. The enum
 * values of F13-F16 are the HID keyboard usages the companion sends, so the
 * event is the usage itself.
 *
 * Raw level and polarity: GPIO24 carries a pull-up on the YD-RP2040, so the
 * line idles high and reads low while pressed. A raw level equal to
 * PIPICO_GESTURE_PRESSED_LEVEL means pressed. A board with inverted wiring
 * overrides the macro in one place.
 *
 * Debounce: a raw level change is a candidate edge at the raw change time;
 * it confirms after PIPICO_GESTURE_DEBOUNCE_MS of stability. The confirmed
 * edge keeps the raw change time as its timestamp, so debounce shifts
 * confirmation, not the measured times. All gesture durations and windows
 * are differences of these raw edge timestamps, never sample counts, so a
 * stalled core0 that skips samples still classifies correctly.
 *
 * Gesture classification (hold classification happens on release, on the
 * debounced press-to-release time):
 *   - tap 30..500 ms: opens the second-tap window.
 *   - a second press starting at most 300 ms after the first release
 *     (inclusive) and lasting 30..500 ms: F14, and no F13.
 *   - a single tap with no second press: F13.
 *   - hold 1500..2999 ms: F15. Hold 3000..9999 ms: F16.
 *   - dead zone 501..1499 ms, shorter than 30 ms, and holds of 10000 ms or
 *     more: nothing. An invalid compound gesture (tap then anything that is
 *     not a valid second tap) gives nothing.
 *
 * F13 emission rule (stated for the tests and the reviewer):
 * After a valid tap is released at time R, F13 is emitted at the first
 * sample with now_ms - R > PIPICO_GESTURE_WINDOW_MS +
 * PIPICO_GESTURE_DEBOUNCE_MS (now - R >= 321 with the defaults) on which no
 * raw press edge is pending debounce confirmation. Rationale: a second press
 * starting exactly at the last inclusive window sample (R + 300 ms) is only
 * confirmable after 20 ms of stability, so the window can only be closed 20
 * ms after its last inclusive sample. Every sample up to then returns NONE.
 */

#ifndef PIPICO_GESTURE_H
#define PIPICO_GESTURE_H

#include <stdint.h>

/* Idle-high pull-up on GPIO24: the line reads 0 while pressed. */
#ifndef PIPICO_GESTURE_PRESSED_LEVEL
#define PIPICO_GESTURE_PRESSED_LEVEL 0
#endif

/* Contact bounce must stay stable this long to confirm a raw edge. */
#define PIPICO_GESTURE_DEBOUNCE_MS 20u

/* A tap lasts from the debounced press edge to the debounced release edge. */
#define PIPICO_GESTURE_TAP_MIN_MS 30u
#define PIPICO_GESTURE_TAP_MAX_MS 500u

/* A second press confirms a double tap when it starts at most this long
 * after the first release (the window is inclusive). */
#define PIPICO_GESTURE_WINDOW_MS 300u

/* Hold classification on release: [F15_MIN_MS, F16_MIN_MS) is F15,
 * [F16_MIN_MS, MAX_HOLD_MS] is F16, and anything longer emits nothing. */
#define PIPICO_GESTURE_F15_MIN_MS 1500u
#define PIPICO_GESTURE_F16_MIN_MS 3000u
#define PIPICO_GESTURE_MAX_HOLD_MS 9999u

enum pipico_gesture_event {
    PIPICO_GESTURE_NONE = 0,
    PIPICO_GESTURE_F13 = 0x68, /* HID keyboard usage F13 */
    PIPICO_GESTURE_F14 = 0x69, /* HID keyboard usage F14 */
    PIPICO_GESTURE_F15 = 0x6a, /* HID keyboard usage F15 */
    PIPICO_GESTURE_F16 = 0x6b, /* HID keyboard usage F16 */
};

/* Reset to the baseline state. The next gesture_feed() call establishes the
 * line baseline: a line already pressed at the first sample emits nothing
 * until a stable release. */
void gesture_init(void);

/* Advance the parser by one sample; returns at most one event. */
enum pipico_gesture_event gesture_feed(uint32_t now_ms, int raw_level);

/* Clear a partial gesture. The parser rearms only after the line has a
 * stable release: any press still in flight is ignored and emits nothing. */
void gesture_abort(void);

#endif
