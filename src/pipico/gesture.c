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

/* Implementation of the pure gesture parser declared in gesture.h. */

#include "gesture.h"

#include <stdbool.h>

/* Two layers:
 *   - a raw-edge debouncer: a level change becomes a candidate edge at the
 *     raw change time; it confirms once the level is provably stable for
 *     PIPICO_GESTURE_DEBOUNCE_MS. The confirmed edge carries the raw change
 *     time as its timestamp.
 *   - the gesture layer: consumes confirmed press/release edges and
 *     classifies taps, double taps and holds from timestamp differences
 *     only, so large sampling gaps (a stalled core0) classify correctly.
 */

enum gstate {
    GS_BASELINE,     /* no sample yet: the first feed() sets the level baseline */
    GS_IDLE,         /* rearmed, line released */
    GS_WAIT_RELEASE, /* indeterminate or aborted press: presses are ignored
                      * until a stable release, nothing is emitted */
    GS_PRESSED,      /* first press confirmed at press_ts */
    GS_WINDOW,       /* valid tap released at release_ts: waiting for a second
                      * press inside the window, or close the window with F13 */
    GS_PRESSED2,     /* second press confirmed at press_ts, inside the window */
};

static enum gstate state;
static uint8_t stable_level;  /* last confirmed line level, 1 = pressed */
static uint8_t last_raw;      /* last sampled raw level, normalized */
static uint32_t pending_time; /* raw time of the candidate edge; only
                               * meaningful while last_raw != stable_level */
static uint32_t press_ts;     /* confirmed press edge time (GS_PRESSED,
                               * GS_PRESSED2) */
static uint32_t release_ts;   /* confirmed first-tap release time (GS_WINDOW) */

/* Normalize a raw GPIO level to 1 = pressed, 0 = released. */
static uint8_t normalize(int raw_level) {
    return (uint8_t)(raw_level == (int)PIPICO_GESTURE_PRESSED_LEVEL);
}

void gesture_init(void) {
    state = GS_BASELINE;
    stable_level = 0;
    last_raw = 0;
    pending_time = 0;
    press_ts = 0;
    release_ts = 0;
}

enum pipico_gesture_event gesture_feed(uint32_t now_ms, int raw_level) {
    uint8_t level = normalize(raw_level);
    enum pipico_gesture_event event = PIPICO_GESTURE_NONE;

    if (state == GS_BASELINE) {
        stable_level = level;
        last_raw = level;
        pending_time = now_ms;
        /* A line already pressed at the first sample has no known start
         * time: wait for a stable release before rearming. */
        state = (level != 0) ? GS_WAIT_RELEASE : GS_IDLE;
        return PIPICO_GESTURE_NONE;
    }

    /* Debounce: confirm at most one candidate edge per sample, keeping the
     * raw change time as the edge timestamp. */
    uint8_t edge_level = 0;
    uint32_t edge_time = 0;
    bool have_edge = false;
    if ((uint32_t)(now_ms - pending_time) >= PIPICO_GESTURE_DEBOUNCE_MS &&
        last_raw != stable_level) {
        /* The candidate level (last_raw, since pending_time) is provably
         * stable, whether the line still holds it or has moved on: a coarse
         * sample grid must not lose edges. */
        stable_level = last_raw;
        edge_level = last_raw;
        edge_time = pending_time;
        have_edge = true;
    }
    if (level != last_raw) {
        last_raw = level;
        pending_time = now_ms;
    }

    if (have_edge) {
        if (edge_level != 0) { /* confirmed press edge */
            switch (state) {
            case GS_IDLE:
                press_ts = edge_time;
                state = GS_PRESSED;
                break;
            case GS_WINDOW:
                if ((uint32_t)(edge_time - release_ts) <= PIPICO_GESTURE_WINDOW_MS) {
                    /* Second press inside the inclusive window. */
                    press_ts = edge_time;
                    state = GS_PRESSED2;
                } else {
                    /* The window closed before this press started: the first
                     * tap is a plain F13 and this press starts a new
                     * gesture. The confirmation sample necessarily satisfies
                     * now - release_ts > WINDOW + DEBOUNCE. */
                    event = PIPICO_GESTURE_F13;
                    press_ts = edge_time;
                    state = GS_PRESSED;
                }
                break;
            default:
                /* Press edges while a press is already tracked (or while
                 * waiting for a release) are ignored. */
                break;
            }
        } else { /* confirmed release edge */
            switch (state) {
            case GS_PRESSED: {
                uint32_t duration = (uint32_t)(edge_time - press_ts);
                if (duration >= PIPICO_GESTURE_TAP_MIN_MS &&
                    duration <= PIPICO_GESTURE_TAP_MAX_MS) {
                    /* Valid tap: open the second-tap window. */
                    release_ts = edge_time;
                    state = GS_WINDOW;
                } else if (duration >= PIPICO_GESTURE_F15_MIN_MS &&
                           duration < PIPICO_GESTURE_F16_MIN_MS) {
                    event = PIPICO_GESTURE_F15;
                    state = GS_IDLE;
                } else if (duration >= PIPICO_GESTURE_F16_MIN_MS &&
                           duration <= PIPICO_GESTURE_MAX_HOLD_MS) {
                    event = PIPICO_GESTURE_F16;
                    state = GS_IDLE;
                } else {
                    /* Too short, in the dead zone, or a hold of 10 s or
                     * more: nothing. The stable release rearms the parser. */
                    state = GS_IDLE;
                }
                break;
            }
            case GS_PRESSED2: {
                uint32_t duration = (uint32_t)(edge_time - press_ts);
                if (duration >= PIPICO_GESTURE_TAP_MIN_MS &&
                    duration <= PIPICO_GESTURE_TAP_MAX_MS) {
                    event = PIPICO_GESTURE_F14;
                }
                /* Any other second-press duration is an invalid compound
                 * gesture: nothing. Either way the parser rearms. */
                state = GS_IDLE;
                break;
            }
            case GS_WAIT_RELEASE:
                state = GS_IDLE;
                break;
            default:
                break;
            }
        }
        return event;
    }

    if (state == GS_WINDOW && last_raw == stable_level &&
        (uint32_t)(now_ms - release_ts) >
            PIPICO_GESTURE_WINDOW_MS + PIPICO_GESTURE_DEBOUNCE_MS) {
        /* F13 emission rule (see gesture.h): the first sample past the
         * inclusive window plus one debounce time, with no raw press edge
         * pending confirmation. */
        state = GS_IDLE;
        event = PIPICO_GESTURE_F13;
    }
    return event;
}

void gesture_abort(void) {
    if (state == GS_BASELINE) {
        return;
    }
    /* Drop the partial gesture. A press still in flight (the confirmed level
     * is pressed, or a raw press edge is pending confirmation) is ignored
     * until a stable release; an already-released line rearms immediately. */
    if (stable_level != 0 || last_raw != stable_level) {
        state = GS_WAIT_RELEASE;
    } else {
        state = GS_IDLE;
    }
    press_ts = 0;
    release_ts = 0;
}
