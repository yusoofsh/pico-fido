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

/* Implementation of the pure keyboard arbiter declared in kbd_arbiter.h. */

#include "kbd_arbiter.h"

enum arb_state {
    ST_IDLE,    /* nothing pending and no key held */
    ST_PENDING, /* one accepted event waits to be handed over */
    ST_DOWN,    /* the key-down was issued; the release is owed */
};

static enum arb_state state;
static uint8_t pending_keycode; /* the accepted usage while PENDING or DOWN */
static uint32_t pending_since;  /* accept time of the pending event */

void kbd_arbiter_init(void) {
    state = ST_IDLE;
    pending_keycode = 0;
    pending_since = 0;
}

/* The accept conditions of architecture.md §6.2: nothing busy anywhere and
 * the keyboard interface usable and free. */
static bool may_accept(const struct kbd_arbiter_inputs *in) {
    return !in->auth_busy && !in->up_pending && !in->otp_typing &&
           in->kb_enabled && in->mounted && !in->suspended && !in->tx_busy;
}

bool kbd_arbiter_accept(enum pipico_gesture_event ev, uint32_t now_ms,
                        const struct kbd_arbiter_inputs *in) {
    if (state != ST_IDLE) {
        /* One-deep queue: a pending or not-yet-released event blocks a
         * new one. */
        return false;
    }
    if (ev < PIPICO_GESTURE_F13 || ev > PIPICO_GESTURE_F16) {
        /* NONE, or anything that is not F13..F16: nothing to send. */
        return false;
    }
    if (!may_accept(in)) {
        /* Dropped, not queued: the event never interrupts a busy session
         * and is not sent once the condition clears. */
        return false;
    }
    pending_keycode = (uint8_t)ev;
    pending_since = now_ms;
    state = ST_PENDING;
    return true;
}

enum kbd_arbiter_action kbd_arbiter_poll(uint32_t now_ms, const struct kbd_arbiter_inputs *in) {
    switch (state) {
    case ST_PENDING:
        if (!in->mounted || in->suspended || in->auth_busy || in->up_pending) {
            /* Interrupted by a disconnect, a suspend or an auth
             * transition: dropped and never replayed. */
            state = ST_IDLE;
            pending_keycode = 0;
            return KBD_ARBITER_DROP;
        }
        if ((uint32_t)(now_ms - pending_since) > PIPICO_KBD_ARBITER_PENDING_MS) {
            /* Not sent within the 100 ms window: dropped and never
             * replayed. Subtraction-based, so a wrapped timer is safe. */
            state = ST_IDLE;
            pending_keycode = 0;
            return KBD_ARBITER_DROP;
        }
        if (in->ready && !in->otp_typing && !in->tx_busy) {
            /* Hand the key-down over; the release is owed from now on. */
            state = ST_DOWN;
            return KBD_ARBITER_SEND;
        }
        return KBD_ARBITER_NONE;
    case ST_DOWN:
        /* The release is owed no matter what changed: no drop rule leaves
         * a key down. */
        state = ST_IDLE;
        pending_keycode = 0;
        return KBD_ARBITER_RELEASE;
    default:
        return KBD_ARBITER_NONE;
    }
}

uint8_t kbd_arbiter_keycode(void) {
    return pending_keycode;
}

void kbd_arbiter_report(uint8_t out[8]) {
    out[0] = 0; /* modifier: always 0 */
    out[1] = 0; /* reserved */
    out[2] = pending_keycode;
    for (int i = 3; i < 8; i++) {
        out[i] = 0;
    }
}
