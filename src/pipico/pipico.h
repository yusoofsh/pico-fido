/*
 * This file is part of the Pico FIDO distribution (https://github.com/polhenarejos/pico-fido).
 * Copyright (c) 2022 Pol Henarejos.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

#ifndef PIPICO_PIPICO_H
#define PIPICO_PIPICO_H

#include <stdbool.h>
#include <stdint.h>

#include "kbd_arbiter.h"
#include "gesture.h"

/* Pure glue core of the USR-button companion: the per-tick pipeline that
 * connects the gesture parser, the keyboard arbiter and the single-owner
 * keyboard transmitter (architecture.md section 6.2).
 *
 * The core is free of Pico SDK, TinyUSB and hardware headers so it is
 * host-testable; the device side of pipico.c samples GPIO24 and the SDK
 * busy accessors once per loop iteration and feeds this core. */

/* One sample of the busy and transport inputs, taken by the device hook
 * from the SDK accessors (names in the comments; the core stays free of
 * SDK headers). All reads are read-only. */
struct pipico_glue_inputs {
    bool command_busy;      /* is_busy(): a CTAP/APDU command is executing */
    bool cancel_unwind; /* exec_finished_cancelled: a cancelled command is
                         * unwinding (read-only marker). Mapped into
                         * auth_busy below: cancellation clears the busy
                         * timeout before the old worker has finished, so
                         * the marker covers the remaining unwind. */
    bool up_pending;    /* is_req_button_pending(): a UP wait is active */
    bool otp_typing;    /* kb_tx_typing(): OTP keystrokes are going out */
    bool kb_enabled;    /* usb_kb_itf_enabled() */
    bool mounted;       /* usb_kb_mounted() */
    bool suspended;     /* usb_kb_suspended() */
    bool tx_busy;       /* kb_tx_busy() */
    bool ready;         /* tud_hid_n_ready(ITF_HID_KB) */
};

/* The transmitter actions of the SEND action, injected so the core is
 * testable without TinyUSB. On the device they map onto the single-owner
 * keyboard transmitter (kb_tx_claim/add_buffer/release with
 * KB_TX_OWNER_COMPANION); the glue never sends HID reports directly. */
struct pipico_glue_ops {
    bool (*tx_claim)(void);           /* claim the transmitter */
    bool (*tx_send)(uint8_t keycode); /* queue one raw key-down */
    void (*tx_release)(void);         /* release the claim */
};

/* Reset the pure core (gesture parser + arbiter). */
void pipico_glue_init(void);

/* Advance the pipeline by one tick; call once per loop iteration. Order:
 * (1) map the inputs (auth_busy = command_busy || cancel_unwind); (2) abort a
 * partial gesture while auth is busy, UP is pending or OTP is typing, so
 * a gesture that started during activity is discarded until a stable
 * release; (3) feed the parser; (4) offer the event to the arbiter;
 * (5) execute the arbiter action: SEND claims the transmitter, hands over
 * the single key-down (kbd_arbiter_keycode(), only F13..F16) and releases
 * the claim (the transmitter then emits the all-released report); RELEASE
 * and DROP require no transport call. Never blocks. */
void pipico_glue_tick(uint32_t now_ms, int raw_level,
                      const struct pipico_glue_inputs *in,
                      const struct pipico_glue_ops *ops);

#endif
