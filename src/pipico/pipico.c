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

/* Thin glue of the USR-button companion (architecture.md section 6.2).
 *
 * It provides the strong picokey_early_init()/picokey_task() hooks of
 * pico-keys-sdk main.c, plus its read-only runtime diagnostic hook:
 *
 *   - picokey_early_init(): GPIO24 (the YD-RP2040 USR button,
 *     VCC_GND_YD_RP2040_BUTTON_PIN in the board header) as an input with
 *     the internal pull-up. The line idles high and reads LOW while
 *     pressed (documented in docs/pipico/COMPANION.md). A busy_wait_us of
 *     at most 1000 us takes an initial held candidate; the main loop
 *     confirms it over 20 ms without blocking. USR held at boot keeps the companion off for that
 *     boot. Runtime only: no flash, PIN, credential, counter or USB
 *     identity change, and the UP policy is untouched.
 *
 *   - picokey_task(): sample GPIO24 and the SDK busy accessors by
 *     to_ms_since_boot timestamps (never loop counters, so a stalled
 *     core0 does not break the gesture timing), then run the pure
 *     pipeline gesture parser -> arbiter -> single-owner keyboard
 *     transmitter. The only usages it sends are F13..F16 (0x68..0x6B).
 *     A stable USR press requests one short LED pulse while idle, without
 *     waiting for gesture classification or changing the key pipeline.
 *
 * The companion never: allocates heap memory, sleeps or blocks (the only
 * busy_wait_us is the boot-time settle above), writes to flash, uses
 * core1, drives a LED, calls tusb_init(), or touches UP or credential
 * APIs (all accessor reads are read-only). Every HID report goes through
 * the single-owner transmitter; the glue never sends TinyUSB reports
 * directly.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "gesture.h"
#include "kbd_arbiter.h"
#include "pipico.h"

#ifdef PIPICO_DEVICE_BUILD
/* Non-sensitive, read-only runtime evidence for the rescue diagnostic. */
static volatile uint8_t diagnostic_press_edges;
static volatile uint8_t diagnostic_gestures;
static volatile uint8_t diagnostic_queued;
static volatile uint8_t diagnostic_last_event;
static volatile uint8_t diagnostic_press_flags;
static int diagnostic_last_raw;
#endif

/* ---- pure glue core (compiled on the host for the lifecycle tests) ---- */

void pipico_glue_init(void) {
    gesture_init();
    kbd_arbiter_init();
}

void pipico_glue_tick(uint32_t now_ms, int raw_level,
                      const struct pipico_glue_inputs *in,
                      const struct pipico_glue_ops *ops) {
    struct kbd_arbiter_inputs ain;

    ain.auth_busy = in->command_busy || in->cancel_unwind;
    ain.up_pending = in->up_pending;
    ain.otp_typing = in->otp_typing;
    ain.kb_enabled = in->kb_enabled;
    ain.mounted = in->mounted;
    ain.suspended = in->suspended;
    ain.tx_busy = in->tx_busy;
    ain.ready = in->ready;

    /* A gesture that started while auth or OTP is active is discarded;
     * the parser requires a stable release before it rearms. */
    if (ain.auth_busy || ain.up_pending || ain.otp_typing) {
        gesture_abort();
    }

    enum pipico_gesture_event ev = gesture_feed(now_ms, raw_level);
    if (ev != PIPICO_GESTURE_NONE) {
#ifdef PIPICO_DEVICE_BUILD
        diagnostic_gestures++;
        diagnostic_last_event = (uint8_t)ev;
#endif
        (void)kbd_arbiter_accept(ev, now_ms, &ain);
    }

    switch (kbd_arbiter_poll(now_ms, &ain)) {
    case KBD_ARBITER_SEND:
        if (ops != NULL && ops->tx_claim != NULL && ops->tx_claim()) {
            if (ops->tx_send != NULL) {
                /* One raw key-down; the transmitter emits the paired
                 * all-released report from its own release guarantee. */
                (void)ops->tx_send(kbd_arbiter_keycode());
            }
            if (ops->tx_release != NULL) {
                ops->tx_release();
            }
        }
        break;
    case KBD_ARBITER_RELEASE:
        /* The all-keys-released report is the transmitter's own
         * guarantee after every key-down it sent, so no transport call
         * belongs here. */
        break;
    default:
        /* NONE or DROP: nothing was sent for the event. */
        break;
    }
}

/* ---- device build: the SDK hooks -------------------------------------- */

/* The device part is compiled only when the CMakeLists sets
 * PIPICO_DEVICE_BUILD=1 on this file, which it does exactly for the device
 * builds (neither ENABLE_EMULATION nor ESP_PLATFORM). The Pico SDK does
 * not export a PICO_PLATFORM preprocessor macro in this configuration, so
 * the build system carries the device/host distinction instead. */

#ifdef PIPICO_DEVICE_BUILD

#include "pico/time.h"
#include "hardware/gpio.h"
#include "tusb.h"

#include "button.h"
#include "kb_tx.h"
#include "led/led.h"
#include "usb.h"

/* The USR button of the board header (GPIO24 on the YD-RP2040), with a
 * plain 24 fallback for boards whose header names no button. */
#ifndef PIPICO_USR_PIN
#ifdef VCC_GND_YD_RP2040_BUTTON_PIN
#define PIPICO_USR_PIN VCC_GND_YD_RP2040_BUTTON_PIN
#else
#define PIPICO_USR_PIN 24
#endif
#endif

/* Pull-up settle time in the early hook. The contract allows at most
 * 1000 us of busy wait, and only here. */
#ifndef PIPICO_USR_SETTLE_US
#define PIPICO_USR_SETTLE_US 700u
#endif

/* Spacing of the boot-latch samples inside the settle window. */
#ifndef PIPICO_USR_SAMPLE_US
#define PIPICO_USR_SAMPLE_US 100u
#endif

#define PIPICO_LATCH_SAMPLES 3u

/* Boot latch: USR held at boot keeps the companion off for this boot. */
static bool companion_off;
static bool companion_latch_pending;
static bool companion_held_candidate;
static uint32_t companion_latch_started_ms;
static int feedback_raw;
static int feedback_stable;
static uint32_t feedback_changed_ms;

static bool glue_tx_claim(void) {
    return kb_tx_claim(KB_TX_OWNER_COMPANION);
}

static bool glue_tx_send(uint8_t keycode) {
    bool queued = kb_tx_add_buffer(KB_TX_OWNER_COMPANION, &keycode, 1, false);
    if (queued) {
        diagnostic_queued++;
    }
    return queued;
}

static void glue_tx_release(void) {
    (void)kb_tx_release(KB_TX_OWNER_COMPANION);
}

static const struct pipico_glue_ops device_glue_ops = {
    glue_tx_claim,
    glue_tx_send,
    glue_tx_release,
};

void picokey_early_init(void) {
    gpio_init(PIPICO_USR_PIN);
    gpio_set_dir(PIPICO_USR_PIN, GPIO_IN);
    gpio_pull_up(PIPICO_USR_PIN);

    /* Let the pull-up charge the line before the latch sample (never
     * sleep_ms; the SDK main loop is not running yet). */
    busy_wait_us(PIPICO_USR_SETTLE_US);

    /* A few samples inside the settle window must all read pressed: a
     * floating line or a bounce does not latch. */
    bool held = true;
    for (unsigned i = 0; i < PIPICO_LATCH_SAMPLES; i++) {
        if (gpio_get(PIPICO_USR_PIN) != PIPICO_GESTURE_PRESSED_LEVEL) {
            held = false;
        }
        if (i + 1 < PIPICO_LATCH_SAMPLES) {
            busy_wait_us(PIPICO_USR_SAMPLE_US);
        }
    }
    /* GPIO24 has an RC network on the board. The initial sample can be low
     * while the released line settles. Confirm a continuously held button
     * asynchronously before latching the companion off for this boot. */
    companion_off = false;
    companion_held_candidate = held;
    companion_latch_pending = true;
    companion_latch_started_ms = to_ms_since_boot(get_absolute_time());
    diagnostic_last_raw = gpio_get(PIPICO_USR_PIN);
}

uint16_t picokey_read_diagnostics(uint8_t *buffer, uint16_t capacity) {
    if (buffer == NULL || capacity < 8) {
        return 0;
    }
    buffer[0] = 0x50; /* Pipico */
    buffer[1] = 1; /* format version */
    buffer[2] = (uint8_t)(gpio_get(PIPICO_USR_PIN) != 0) |
                (uint8_t)(companion_off ? 2 : 0);
    buffer[3] = diagnostic_press_flags;
    buffer[4] = diagnostic_press_edges;
    buffer[5] = diagnostic_gestures;
    buffer[6] = diagnostic_queued;
    buffer[7] = diagnostic_last_event;
    return 8;
}

void picokey_task(void) {
    if (companion_latch_pending) {
        int raw_level = gpio_get(PIPICO_USR_PIN);
        if (raw_level != PIPICO_GESTURE_PRESSED_LEVEL) {
            companion_held_candidate = false;
        }
        if ((uint32_t)(to_ms_since_boot(get_absolute_time()) -
                       companion_latch_started_ms) < 20u) {
            return;
        }
        companion_off = companion_held_candidate;
        companion_latch_pending = false;
        diagnostic_last_raw = raw_level;
        feedback_raw = feedback_stable = raw_level;
        feedback_changed_ms = to_ms_since_boot(get_absolute_time());
        pipico_glue_init();
    }
    if (companion_off) {
        /* USR was held at boot: the companion is off for this boot. */
        return;
    }

    /* One sample of every input, read-only, once per loop iteration. */
    struct pipico_glue_inputs in;
    in.command_busy = is_busy();
    in.cancel_unwind = exec_finished_cancelled;
    in.up_pending = is_req_button_pending();
    in.otp_typing = kb_tx_typing();
    in.kb_enabled = usb_kb_itf_enabled();
    in.mounted = usb_kb_mounted();
    in.suspended = usb_kb_suspended();
    in.tx_busy = kb_tx_busy();
    in.ready = usb_kb_itf_enabled() && tud_hid_n_ready(ITF_HID_KB);

    int raw_level = gpio_get(PIPICO_USR_PIN);
    if (raw_level != diagnostic_last_raw &&
        raw_level == PIPICO_GESTURE_PRESSED_LEVEL) {
        diagnostic_press_edges++;
        diagnostic_press_flags =
            (in.command_busy || in.cancel_unwind ? 1u : 0u) |
            (in.up_pending ? 2u : 0u) | (in.otp_typing ? 4u : 0u) |
            (in.kb_enabled ? 8u : 0u) | (in.mounted ? 16u : 0u) |
            (in.suspended ? 32u : 0u) | (in.tx_busy ? 64u : 0u) |
            (in.ready ? 128u : 0u);
    }
    diagnostic_last_raw = raw_level;

    uint32_t now_ms = to_ms_since_boot(get_absolute_time());
    if (raw_level != feedback_raw) {
        feedback_raw = raw_level;
        feedback_changed_ms = now_ms;
    }
    if (feedback_stable != feedback_raw &&
        (uint32_t)(now_ms - feedback_changed_ms) >= PIPICO_GESTURE_DEBOUNCE_MS) {
        feedback_stable = feedback_raw;
        if (feedback_stable == PIPICO_GESTURE_PRESSED_LEVEL &&
            !in.command_busy && !in.cancel_unwind && !in.up_pending &&
            !in.otp_typing && in.mounted && !in.suspended) {
            (void)led_try_blink_n_times(1, LED_COLOR_CYAN, 80, 60);
        }
    }

    pipico_glue_tick(now_ms,
                     raw_level, &in, &device_glue_ops);
}

#endif /* PIPICO_DEVICE_BUILD */
