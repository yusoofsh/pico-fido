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

/* Host tests for the companion glue core (src/pipico/pipico.c).
 *
 * Every scenario is one process, selected by argv[1], so ctest names are
 * readable (ctest -R glue). The tests drive the same per-tick pipeline the
 * device hook runs (sample -> gesture -> arbiter -> transmitter) with
 * injected time, injected busy inputs and a fake transmitter, and focus on
 * the glue-specific lifecycle:
 *
 *   - the auth-busy mapping: a gesture is suppressed while a command is
 *     busy (is_busy()) AND while a cancelled command is unwinding
 *     (exec_finished_cancelled), even though the latter is not "busy" in
 *     the command-timeout sense (VAL-COMP-042 mapping, orchestrator
 *     clarification);
 *   - UP pending and OTP typing suppress the same way;
 *   - normal rearming: once the busy source clears and the line is
 *     released, the next gesture is sent through the single-owner
 *     transmitter (claim -> one raw key-down -> release claim);
 *   - a suppressed gesture is never queued for later replay;
 *   - the event -> keycode mapping F13..F16 -> 0x68..0x6B, and NONE sends
 *     nothing (VAL-COMP-034);
 *   - the release owed after a send produces no direct transmitter call:
 *     the all-released report is the transmitter's own guarantee.
 */

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "gesture.h"
#include "kbd_arbiter.h"
#include "pipico.h"

/* ---- fake transmitter ------------------------------------------------- */

static int g_claims;
static int g_sends;
static int g_releases;
static uint8_t g_last_keycode;
static bool g_claim_allowed; /* set false to simulate a lost claim race */

static void tx_reset(void) {
    g_claims = 0;
    g_sends = 0;
    g_releases = 0;
    g_last_keycode = 0;
    g_claim_allowed = true;
}

static bool tx_claim(void) {
    if (!g_claim_allowed) {
        return false;
    }
    g_claims++;
    return true;
}

static bool tx_send(uint8_t keycode) {
    g_sends++;
    g_last_keycode = keycode;
    return true;
}

static void tx_release(void) {
    g_releases++;
}

static const struct pipico_glue_ops g_ops = {
    tx_claim,
    tx_send,
    tx_release,
};

/* ---- helpers ----------------------------------------------------------- */

/* An all-clear input snapshot: the keyboard interface is up, mounted,
 * unsuspended, idle, and the transport is ready. */
static struct pipico_glue_inputs clear_inputs(void) {
    struct pipico_glue_inputs in = {
        .command_busy = false,
        .cancel_unwind = false,
        .up_pending = false,
        .otp_typing = false,
        .kb_enabled = true,
        .mounted = true,
        .suspended = false,
        .tx_busy = false,
        .ready = true,
    };
    return in;
}

#define PRESSED (PIPICO_GESTURE_PRESSED_LEVEL)
#define RELEASED (!PIPICO_GESTURE_PRESSED_LEVEL)

/* Tick the glue every 10 ms from t0 to t1 (inclusive) with a fixed raw
 * level, the way picokey_task samples GPIO24 once per loop iteration. */
static void tick_range(uint32_t t0, uint32_t t1, int raw_level,
                       const struct pipico_glue_inputs *in) {
    for (uint32_t t = t0; t <= t1; t += 10) {
        pipico_glue_tick(t, raw_level, in, &g_ops);
    }
}

/* A tap: pressed on [press_ms, release_ms), then the line stays released
 * until end_ms so the parser can emit. */
static void run_tap(uint32_t press_ms, uint32_t release_ms, uint32_t end_ms,
                    const struct pipico_glue_inputs *in) {
    tick_range(0, press_ms - 10, RELEASED, in);
    tick_range(press_ms, release_ms - 10, PRESSED, in);
    tick_range(release_ms, end_ms, RELEASED, in);
}

/* ---- scenarios --------------------------------------------------------- */

/* While a cancelled command is unwinding (command_busy false, the
 * cancellation-unwind marker true), a full tap produces no transmitter
 * claim and no send. */
static void test_cancel_unwind_suppressed(void) {
    struct pipico_glue_inputs in = clear_inputs();
    in.cancel_unwind = true;

    run_tap(1000, 1100, 2000, &in);
    assert(g_claims == 0);
    assert(g_sends == 0);
    assert(g_releases == 0);
}

/* While UP is pending, or while OTP is typing, the same tap is suppressed
 * as well (the glue aborts the parser on any of the three busy sources). */
static void test_busy_kinds_suppress(void) {
    struct pipico_glue_inputs in = clear_inputs();

    in.up_pending = true;
    run_tap(1000, 1100, 2000, &in);
    assert(g_claims == 0);
    assert(g_sends == 0);

    in = clear_inputs();
    in.otp_typing = true;
    run_tap(1000, 1100, 2000, &in);
    assert(g_claims == 0);
    assert(g_sends == 0);
}

/* Normal rearming: a command is busy during a first gesture (suppressed);
 * the command completes normally (busy clears), and a fresh tap after the
 * release is accepted and sent exactly once, as claim -> key-down ->
 * release claim. The later release action sends nothing directly. */
static void test_normal_completion_rearm(void) {
    struct pipico_glue_inputs in = clear_inputs();
    in.command_busy = true;

    run_tap(1000, 1100, 2000, &in);
    assert(g_sends == 0);

    /* Normal completion: the timeout was consumed, busy clears. */
    in = clear_inputs();
    run_tap(3000, 3100, 4000, &in);
    assert(g_claims == 1);
    assert(g_sends == 1);
    assert(g_last_keycode == 0x68);
    assert(g_releases == 1);

    /* Letting the arbiter run on (the owed RELEASE action, further polls)
     * must not add transmitter traffic: the all-released report is the
     * transmitter's own guarantee. */
    tick_range(4000, 5000, RELEASED, &in);
    assert(g_claims == 1);
    assert(g_sends == 1);
}

/* Rearming after a cancellation unwind completes, and the no-replay rule:
 * once the marker clears, nothing is sent until a NEW gesture finishes. */
static void test_cancel_clear_rearm(void) {
    struct pipico_glue_inputs in = clear_inputs();
    in.cancel_unwind = true;

    run_tap(1000, 1100, 2000, &in);
    assert(g_sends == 0);

    /* The unwind finished; the line is idle. No stale send may appear. */
    in = clear_inputs();
    tick_range(2000, 3000, RELEASED, &in);
    assert(g_sends == 0);

    /* A fresh gesture after the clear is sent normally. */
    run_tap(3000, 3100, 4000, &in);
    assert(g_claims == 1);
    assert(g_sends == 1);
    assert(g_last_keycode == 0x68);
}

/* The event -> keycode mapping through the glue: tap F13 -> 0x68, double
 * tap F14 -> 0x69, hold 1500..2999 ms F15 -> 0x6A, hold 3000..9999 ms
 * F16 -> 0x6B, and a hold of 10 s or more (NONE) sends nothing. */
static void test_mapping_f13_f16(void) {
    struct pipico_glue_inputs in = clear_inputs();

    pipico_glue_init();
    tx_reset();
    run_tap(1000, 1100, 2000, &in); /* tap -> F13 */
    assert(g_sends == 1 && g_last_keycode == 0x68);

    pipico_glue_init();
    tx_reset();
    /* Double tap: second press starts 200 ms after the first release. */
    tick_range(0, 990, RELEASED, &in);
    tick_range(1000, 1090, PRESSED, &in);
    tick_range(1100, 1290, RELEASED, &in);
    tick_range(1300, 1390, PRESSED, &in);
    tick_range(1400, 2000, RELEASED, &in);
    assert(g_sends == 1 && g_last_keycode == 0x69);

    pipico_glue_init();
    tx_reset();
    run_tap(1000, 2600, 4000, &in); /* hold 1.6 s -> F15 */
    assert(g_sends == 1 && g_last_keycode == 0x6a);

    pipico_glue_init();
    tx_reset();
    run_tap(1000, 4600, 6000, &in); /* hold 3.6 s -> F16 */
    assert(g_sends == 1 && g_last_keycode == 0x6b);

    pipico_glue_init();
    tx_reset();
    run_tap(1000, 12500, 16000, &in); /* hold >= 10 s -> nothing */
    assert(g_sends == 0 && g_claims == 0);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s SCENARIO\n", argv[0]);
        return 2;
    }
    const char *scene = argv[1];
    tx_reset();
    pipico_glue_init();
    if (strcmp(scene, "cancel_unwind_suppressed") == 0) {
        test_cancel_unwind_suppressed();
    }
    else if (strcmp(scene, "busy_kinds_suppress") == 0) {
        test_busy_kinds_suppress();
    }
    else if (strcmp(scene, "normal_completion_rearm") == 0) {
        test_normal_completion_rearm();
    }
    else if (strcmp(scene, "cancel_clear_rearm") == 0) {
        test_cancel_clear_rearm();
    }
    else if (strcmp(scene, "mapping_f13_f16") == 0) {
        test_mapping_f13_f16();
    }
    else {
        fprintf(stderr, "unknown scenario %s\n", scene);
        return 2;
    }
    return 0;
}
