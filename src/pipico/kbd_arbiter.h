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

#ifndef PIPICO_KBD_ARBITER_H
#define PIPICO_KBD_ARBITER_H

#include <stdbool.h>
#include <stdint.h>

#include "gesture.h"

/* Pure keyboard arbiter for the companion (architecture.md §6.2).
 *
 * The module includes no Pico SDK, TinyUSB or hardware header: it compiles
 * on the host and on the device unchanged. Time and every busy or
 * availability input are injected by the caller.
 *
 * The arbiter decides whether a gesture event may leave the device as a
 * keystroke, and paces the key-down / all-released pair:
 *
 *   - An event is accepted only when all of these hold at accept time:
 *     not auth busy, no UP wait pending, OTP not typing, the keyboard
 *     interface enabled, mounted, not suspended, and the transmitter
 *     free. Anything else is dropped and not queued: a busy FIDO or OTP
 *     session is never interrupted by a companion keystroke.
 *
 *   - An accepted event that cannot be handed over yet (the transport is
 *     not ready) is held as the single pending event for at most
 *     PIPICO_KBD_ARBITER_PENDING_MS. Once the pending time exceeds that,
 *     the event is dropped and never replayed, even when every condition
 *     clears afterwards. All timing is wraparound-safe uint32
 *     subtraction.
 *
 *   - While an event is pending, a disconnect (unmount), a suspend or an
 *     auth transition (auth busy or UP pending becoming true) drops it
 *     immediately and never replays it. OTP typing that starts meanwhile
 *     only blocks the send until it stops or the event expires; it does
 *     not interrupt.
 *
 *   - The queue is one deep: an event is accepted only in the idle state,
 *     so a second event while one is pending (or while its release is
 *     still owed) is dropped.
 *
 *   - An accepted press always gets its release: after the SEND action,
 *     the RELEASE action follows on the next poll no matter what changed
 *     (busy, unmount, suspend, elapsed time). No drop rule leaves a key
 *     down.
 *
 * Per-loop recipe for the glue (picokey_task), in this order:
 *   1. sample the inputs into struct kbd_arbiter_inputs (the SDK
 *      accessors are named in the field comments below);
 *   2. while auth is busy or OTP is typing, call gesture_abort(): a
 *      gesture that started while busy is discarded, and the parser waits
 *      for a stable release before it rearms;
 *   3. feed the gesture parser; on an event, call kbd_arbiter_accept();
 *   4. call kbd_arbiter_poll() once and execute the returned action:
 *      KBD_ARBITER_SEND (the key-down, through the keyboard transmitter,
 *      keycode from kbd_arbiter_keycode() and the report layout from
 *      kbd_arbiter_report()), then KBD_ARBITER_RELEASE (the
 *      all-keys-released report), or KBD_ARBITER_DROP (nothing was sent
 *      for the event).
 */

/* A pending event that has not been sent within this window is dropped
 * and never replayed (still sendable at exactly +100 ms, dropped from
 * +101 ms). */
#define PIPICO_KBD_ARBITER_PENDING_MS 100u

enum kbd_arbiter_action {
    KBD_ARBITER_NONE = 0, /* nothing to do this tick */
    KBD_ARBITER_SEND,     /* send the key-down report for kbd_arbiter_keycode() */
    KBD_ARBITER_RELEASE,  /* send the all-keys-released report */
    KBD_ARBITER_DROP,     /* the pending event was dropped; nothing was sent for it */
};

/* One sample of every condition the arbiter gates on, taken by the caller
 * from the SDK accessors (names in the comments; the module itself stays
 * free of SDK headers). `in` must not be NULL. */
struct kbd_arbiter_inputs {
    bool auth_busy;  /* is_busy(): a CTAP/APDU command is being processed */
    bool up_pending; /* is_req_button_pending(): a UP wait is active */
    bool otp_typing; /* OTP keystrokes are going out (kb_tx_typing()) */
    bool kb_enabled; /* the keyboard HID interface is enabled (ITF_HID_KB
                      * valid; usb_kb_itf_enabled()) */
    bool mounted;    /* the device is mounted (usb_kb_mounted()) */
    bool suspended;  /* the bus is suspended (usb_kb_suspended()) */
    bool tx_busy;    /* the transmitter is claimed or reports are in flight
                      * (kb_tx_busy()) */
    bool ready;      /* the keyboard endpoint can take a report right now
                      * (tud_hid_n_ready(ITF_HID_KB)) */
};

/* Reset to the idle state. */
void kbd_arbiter_init(void);

/* Offer a gesture event (the parser output) at time now_ms. Returns true
 * when the event was accepted; false when it was dropped (busy conditions,
 * a full one-deep queue, or NONE / a non-F13..F16 event). A dropped event
 * is never queued. */
bool kbd_arbiter_accept(enum pipico_gesture_event ev, uint32_t now_ms,
                        const struct kbd_arbiter_inputs *in);

/* Advance the arbiter by one tick; call once per loop iteration. Returns
 * the action to execute: KBD_ARBITER_SEND for the key-down of the accepted
 * event, KBD_ARBITER_RELEASE for the owed all-released report,
 * KBD_ARBITER_DROP when a pending event was just dropped, KBD_ARBITER_NONE
 * otherwise. */
enum kbd_arbiter_action kbd_arbiter_poll(uint32_t now_ms, const struct kbd_arbiter_inputs *in);

/* The HID keyboard usage of the accepted event (F13..F16, 0x68..0x6B);
 * meaningful after a KBD_ARBITER_SEND until the next accept. */
uint8_t kbd_arbiter_keycode(void);

/* Build the 8-byte HID boot-protocol keyboard report for the key-down:
 * modifier 0, reserved 0, keycode[0] = the accepted usage, keycodes[1..5]
 * = 0. The modifier is always 0 and only keycode[0] is ever nonzero. */
void kbd_arbiter_report(uint8_t out[8]);

#endif
