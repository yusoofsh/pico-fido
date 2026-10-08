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

/* Host tests for the pure gesture parser (src/pipico/gesture.c).
 *
 * Every scenario is one process, selected by argv[1], so ctest names are
 * readable (ctest -R gesture). Traces are time-injected: the test feeds
 * (now_ms, raw_level) samples at 1 ms steps (or an explicit sample grid for
 * the stall scenarios) and records every non-NONE event with its sample
 * time. Durations are the debounced press-to-release times defined in
 * gesture.h; the expected F13 emission sample is the one stated there.
 *
 * Covered contract (VAL-COMP-010..022):
 *   tap boundaries 29/30, 500/501 and the 501..1499 dead zone;
 *   the inclusive 300 ms second-tap window and the F13 emission rule;
 *   holds 1499/1500, 2999/3000, 9999/10000 and rearm after an over-hold;
 *   20 ms debounce (bounce, 19 ms glitch, edge accepted at exactly 20 ms);
 *   timer wraparound; at most one event per gesture; invalid compounds;
 *   abort(); large sampling gaps classified by timestamps.
 */

#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include "gesture.h"

#define PRESSED_LEVEL (PIPICO_GESTURE_PRESSED_LEVEL)
#define IDLE_LEVEL (PIPICO_GESTURE_PRESSED_LEVEL ? 0 : 1)

#define MAX_EVENTS 8

struct ev {
    uint32_t t;
    enum pipico_gesture_event e;
};

static struct ev g_ev[MAX_EVENTS];
static int g_n_ev;

static void ev_reset(void) {
    g_n_ev = 0;
}

static void ev_record(uint32_t t, enum pipico_gesture_event e) {
    if (e == PIPICO_GESTURE_NONE) {
        return;
    }
    assert(g_n_ev < MAX_EVENTS);
    g_ev[g_n_ev].t = t;
    g_ev[g_n_ev].e = e;
    g_n_ev++;
}

/* A span of pressed time: the raw level reads pressed on [press, release). */
struct span {
    uint32_t press;
    uint32_t release;
};

static bool pressed_at(uint32_t t, const struct span *spans, int nspans) {
    for (int i = 0; i < nspans; i++) {
        /* Signed differences keep the comparison wraparound-safe. */
        if ((int32_t)(t - spans[i].press) >= 0 && (int32_t)(t - spans[i].release) < 0) {
            return true;
        }
    }
    return false;
}

static int level_for(uint32_t t, const struct span *spans, int nspans) {
    return pressed_at(t, spans, nspans) ? PRESSED_LEVEL : IDLE_LEVEL;
}

/* Feed dense 1 ms samples over [t0, t1] (t1 may be below t0 across the
 * wrap) and record every non-NONE event. Returns the event count. */
static int run(uint32_t t0, uint32_t t1, const struct span *spans, int nspans) {
    ev_reset();
    gesture_init();
    for (uint32_t t = t0; (int32_t)(t - t1) <= 0; t++) {
        ev_record(t, gesture_feed(t, level_for(t, spans, nspans)));
    }
    return g_n_ev;
}

static void expect_none(const char *name) {
    assert(g_n_ev == 0);
    printf("%s: PASS\n", name);
}

static void expect_one(const char *name, enum pipico_gesture_event e, uint32_t t) {
    assert(g_n_ev == 1);
    assert(g_ev[0].e == e);
    assert(g_ev[0].t == t);
    printf("%s: PASS\n", name);
}

/* VAL-COMP-010: a 29 ms press is too short; 30 ms is a tap. */
static void test_tap_29(void) {
    struct span sp[] = { { 1000, 1029 } };
    run(0, 2300, sp, 1);
    expect_none("tap_29");
}

static void test_tap_30(void) {
    struct span sp[] = { { 1000, 1030 } };
    run(0, 2350, sp, 1);
    /* F13 emission rule: release 1030 + WINDOW 300 + DEBOUNCE 20 + 1. */
    expect_one("tap_30", PIPICO_GESTURE_F13, 1351);
}

/* VAL-COMP-011: 500 ms is still a tap; 501 ms and the 501..1499 dead zone
 * produce nothing. */
static void test_tap_500(void) {
    struct span sp[] = { { 1000, 1500 } };
    run(0, 2900, sp, 1);
    expect_one("tap_500", PIPICO_GESTURE_F13, 1821);
}

static void test_tap_501(void) {
    struct span sp[] = { { 1000, 1501 } };
    run(0, 2900, sp, 1);
    expect_none("tap_501");
}

static void test_tap_dead_zone_800(void) {
    struct span sp[] = { { 1000, 1800 } };
    run(0, 3200, sp, 1);
    expect_none("tap_dead_zone_800");
}

/* VAL-COMP-012: with the tap released at R = 1100, no sample at or before
 * R+300 returns anything (a second press could still start at R+300), and
 * F13 comes exactly once at the first sample past R+300+DEBOUNCE, never
 * later. */
static void test_single_tap_window(void) {
    struct span sp[] = { { 1000, 1100 } };
    run(0, 2600, sp, 1);
    expect_one("single_tap_window", PIPICO_GESTURE_F13, 1421);
}

/* VAL-COMP-013: a second 100 ms tap starting 299 ms after the first release
 * gives exactly one F14 and no F13. */
static void test_double_tap_299(void) {
    struct span sp[] = { { 1000, 1100 }, { 1399, 1499 } };
    run(0, 2800, sp, 2);
    expect_one("double_tap_299", PIPICO_GESTURE_F14, 1519);
}

/* The window is inclusive: a second press starting exactly 300 ms after the
 * first release still counts. */
static void test_double_tap_300(void) {
    struct span sp[] = { { 1000, 1100 }, { 1400, 1500 } };
    run(0, 2800, sp, 2);
    expect_one("double_tap_300", PIPICO_GESTURE_F14, 1520);
}

/* One ms past the window: no F14. The first tap is a plain F13 and the
 * second tap is classified as a new gesture (its own F13). */
static void test_double_tap_301(void) {
    struct span sp[] = { { 1000, 1100 }, { 1401, 1501 } };
    run(0, 3100, sp, 2);
    assert(g_n_ev == 2);
    assert(g_ev[0].e == PIPICO_GESTURE_F13 && g_ev[0].t == 1421);
    assert(g_ev[1].e == PIPICO_GESTURE_F13 && g_ev[1].t == 1822);
    printf("double_tap_301: PASS\n");
}

/* VAL-COMP-014: 1499 ms is a dead-zone press; 1500 ms is F15, emitted at
 * the release confirmation (the release edge timestamp + DEBOUNCE). */
static void test_hold_1499(void) {
    struct span sp[] = { { 1000, 2499 } };
    run(0, 3700, sp, 1);
    expect_none("hold_1499");
}

static void test_hold_1500(void) {
    struct span sp[] = { { 1000, 2500 } };
    run(0, 3800, sp, 1);
    expect_one("hold_1500", PIPICO_GESTURE_F15, 2520);
}

/* VAL-COMP-015: 2999 ms is still F15; 3000 ms is F16 and never F15. */
static void test_hold_2999(void) {
    struct span sp[] = { { 1000, 3999 } };
    run(0, 5300, sp, 1);
    expect_one("hold_2999", PIPICO_GESTURE_F15, 4019);
}

static void test_hold_3000(void) {
    struct span sp[] = { { 1000, 4000 } };
    run(0, 5400, sp, 1);
    expect_one("hold_3000", PIPICO_GESTURE_F16, 4020);
}

/* VAL-COMP-016: 9999 ms is F16; a hold of 10000 ms or more emits nothing,
 * and after its stable release the parser rearms. */
static void test_hold_9999(void) {
    struct span sp[] = { { 1000, 10999 } };
    run(0, 12400, sp, 1);
    expect_one("hold_9999", PIPICO_GESTURE_F16, 11019);
}

static void test_hold_10000(void) {
    struct span sp[] = { { 1000, 11000 } };
    run(0, 12500, sp, 1);
    expect_none("hold_10000");
}

/* A 15 s hold released stably emits nothing, and a clean tap afterwards
 * emits F13: the parser rearms only after a stable release. */
static void test_overhold_rearm(void) {
    struct span sp[] = { { 1000, 16000 }, { 17500, 17600 } };
    run(0, 19000, sp, 2);
    expect_one("overhold_rearm", PIPICO_GESTURE_F13, 17921);
}

/* VAL-COMP-017: a 100 ms tap whose press and release edges each bounce for
 * 8 ms (toggles every 2 ms) before settling emits exactly one F13 and never
 * F14. The edge timestamps are the settle times (1008, 1104). */
static bool bounce_pressed(uint32_t t) {
    if ((int32_t)(t - 1000) < 0) {
        return false;
    }
    if ((int32_t)(t - 1008) < 0) {
        return (t % 4) < 2; /* press bounce: down 1000-1, up 1002-3, ... */
    }
    if ((int32_t)(t - 1100) < 0) {
        return true;
    }
    if ((int32_t)(t - 1108) < 0) {
        return (t % 4) >= 2; /* release bounce: up 1100-1, down 1102-3, ... */
    }
    return false;
}

static void test_bounce_tap(void) {
    ev_reset();
    gesture_init();
    for (uint32_t t = 0; t <= 2500; t++) {
        ev_record(t, gesture_feed(t, bounce_pressed(t) ? PRESSED_LEVEL : IDLE_LEVEL));
    }
    expect_one("bounce_tap", PIPICO_GESTURE_F13, 1429);
}

/* A single 19 ms low glitch on an idle line emits nothing. */
static void test_glitch_19(void) {
    struct span sp[] = { { 5000, 5019 } };
    run(0, 6500, sp, 1);
    expect_none("glitch_19");
}

/* The same 19 ms glitch inside the second-tap window is rejected as bounce,
 * so the first tap still closes its window with one F13. */
static void test_glitch_in_window_19(void) {
    struct span sp[] = { { 1000, 1100 }, { 1200, 1219 } };
    run(0, 2600, sp, 2);
    expect_one("glitch_in_window_19", PIPICO_GESTURE_F13, 1421);
}

/* A change that stays stable for exactly 20 ms is accepted as an edge: the
 * tap-then-20-ms-press compound consumes the window and, being shorter than
 * 30 ms, gives nothing (VAL-COMP-020 too-short case). */
static void test_debounce_edge_20(void) {
    struct span sp[] = { { 1000, 1100 }, { 1200, 1220 } };
    run(0, 2600, sp, 2);
    expect_none("debounce_edge_20");
}

/* VAL-COMP-018: traces near UINT32_MAX crossing zero. A press at
 * 0xFFFFFF00 released 1600 ms later (at 0x540) emits exactly one F15. */
static void test_wrap_hold_1600(void) {
    struct span sp[] = { { 0xFFFFFF00u, 0x540 } };
    run(0xFFFFFE00u, 0x79B, sp, 1);
    expect_one("wrap_hold_1600", PIPICO_GESTURE_F15, 0x554);
}

/* A 100 ms tap straddling the wrap emits exactly one F13 after the window. */
static void test_wrap_tap(void) {
    struct span sp[] = { { 0xFFFFFFF0u, 0x54 } };
    run(0xFFFFFF00u, 0x68C, sp, 1);
    expect_one("wrap_tap", PIPICO_GESTURE_F13, 0x195);
}

/* A double tap straddling the wrap emits exactly one F14 (the second press
 * starts 299 ms after the first release) and no spurious event. */
static void test_wrap_double_tap(void) {
    struct span sp[] = { { 0xFFFFFF00u, 0xFFFFFF64u }, { 0x8F, 0xF3 } };
    run(0xFFFFFE00u, 0x400, sp, 2);
    expect_one("wrap_double_tap", PIPICO_GESTURE_F14, 0x107);
}

/* VAL-COMP-020: invalid compounds give nothing. */
static void test_compound_tap_hold(void) {
    struct span sp[] = { { 1000, 1100 }, { 1300, 3300 } };
    run(0, 4500, sp, 2);
    expect_none("compound_tap_hold");
}

static void test_compound_tap_dead_zone(void) {
    struct span sp[] = { { 1000, 1100 }, { 1300, 2000 } };
    run(0, 3200, sp, 2);
    expect_none("compound_tap_dead_zone");
}

static void test_compound_tap_too_short(void) {
    struct span sp[] = { { 1000, 1100 }, { 1300, 1325 } };
    run(0, 2600, sp, 2);
    expect_none("compound_tap_too_short");
}

/* VAL-COMP-021: abort() clears a partial gesture and requires a release to
 * rearm. */

/* Abort 1000 ms into a press, release at 3000: nothing. A clean tap after
 * the stable release emits F13. */
static void test_abort_mid_press(void) {
    ev_reset();
    gesture_init();
    for (uint32_t t = 0; t <= 6000; t++) {
        if (t == 2000) {
            gesture_abort();
        }
        bool pressed = ((int32_t)(t - 1000) >= 0 && (int32_t)(t - 3000) < 0) ||
                       ((int32_t)(t - 5000) >= 0 && (int32_t)(t - 5100) < 0);
        ev_record(t, gesture_feed(t, pressed ? PRESSED_LEVEL : IDLE_LEVEL));
    }
    expect_one("abort_mid_press", PIPICO_GESTURE_F13, 5421);
}

/* Abort during the second-tap window: neither F13 nor F14 for the aborted
 * gesture; the next clean tap emits its own F13. */
static void test_abort_window(void) {
    ev_reset();
    gesture_init();
    for (uint32_t t = 0; t <= 4500; t++) {
        if (t == 1200) {
            gesture_abort();
        }
        bool pressed = ((int32_t)(t - 1000) >= 0 && (int32_t)(t - 1100) < 0) ||
                       ((int32_t)(t - 3000) >= 0 && (int32_t)(t - 3100) < 0);
        ev_record(t, gesture_feed(t, pressed ? PRESSED_LEVEL : IDLE_LEVEL));
    }
    expect_one("abort_window", PIPICO_GESTURE_F13, 3421);
}

/* Abort while the line is held, hold 4000 ms more, release: nothing; the
 * next clean tap emits F13. */
static void test_abort_held(void) {
    ev_reset();
    gesture_init();
    for (uint32_t t = 0; t <= 9000; t++) {
        if (t == 2000) {
            gesture_abort();
        }
        bool pressed = ((int32_t)(t - 1000) >= 0 && (int32_t)(t - 6000) < 0) ||
                       ((int32_t)(t - 8000) >= 0 && (int32_t)(t - 8100) < 0);
        ev_record(t, gesture_feed(t, pressed ? PRESSED_LEVEL : IDLE_LEVEL));
    }
    expect_one("abort_held", PIPICO_GESTURE_F13, 8421);
}

/* VAL-COMP-022: a stalled core0 skips samples; classification uses the
 * timestamps, never the sample count. */

/* The press is seen once at t=1000 and the next samples, from t+2000 on,
 * show the line released: the 2000 ms press is F15. */
static void test_stall_gap(void) {
    ev_reset();
    gesture_init();
    ev_record(0, gesture_feed(0, IDLE_LEVEL));
    ev_record(1000, gesture_feed(1000, PRESSED_LEVEL));
    for (uint32_t t = 3000; t <= 4200; t++) {
        ev_record(t, gesture_feed(t, IDLE_LEVEL));
    }
    expect_one("stall_gap", PIPICO_GESTURE_F15, 3020);
}

/* The same stall with a 20 s gap is an over-hold: nothing, and after the
 * stable release the parser rearms for the next tap. */
static void test_stall_gap_overhold(void) {
    ev_reset();
    gesture_init();
    ev_record(0, gesture_feed(0, IDLE_LEVEL));
    ev_record(1000, gesture_feed(1000, PRESSED_LEVEL));
    for (uint32_t t = 21000; t <= 24600; t++) {
        bool pressed = (int32_t)(t - 23000) >= 0 && (int32_t)(t - 23100) < 0;
        ev_record(t, gesture_feed(t, pressed ? PRESSED_LEVEL : IDLE_LEVEL));
    }
    expect_one("stall_gap_overhold", PIPICO_GESTURE_F13, 23421);
}

/* A line already pressed at the first sample has no known start: nothing
 * until a stable release, then a clean tap emits F13. */
static void test_start_pressed(void) {
    ev_reset();
    gesture_init();
    for (uint32_t t = 0; t <= 9000; t++) {
        bool pressed = ((int32_t)(t - 6000) < 0) ||
                       ((int32_t)(t - 8000) >= 0 && (int32_t)(t - 8100) < 0);
        ev_record(t, gesture_feed(t, pressed ? PRESSED_LEVEL : IDLE_LEVEL));
    }
    expect_one("start_pressed", PIPICO_GESTURE_F13, 8421);
}

/* VAL-COMP-019: at most one event per gesture across the whole population. */
static void test_event_counts(void) {
    struct span tap[] = { { 1000, 1100 } };
    assert(run(0, 2600, tap, 1) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F13);

    struct span d299[] = { { 1000, 1100 }, { 1399, 1499 } };
    assert(run(0, 2800, d299, 2) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F14); /* never also F13 */

    struct span d300[] = { { 1000, 1100 }, { 1400, 1500 } };
    assert(run(0, 2800, d300, 2) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F14); /* never also F13 */

    struct span h1500[] = { { 1000, 2500 } };
    assert(run(0, 3800, h1500, 1) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F15);

    struct span h2999[] = { { 1000, 3999 } };
    assert(run(0, 5300, h2999, 1) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F15);

    struct span h3000[] = { { 1000, 4000 } };
    assert(run(0, 5400, h3000, 1) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F16); /* never also F15 */

    struct span h9999[] = { { 1000, 10999 } };
    assert(run(0, 12400, h9999, 1) == 1);
    assert(g_ev[0].e == PIPICO_GESTURE_F16);

    /* Every invalid trace of VAL-COMP-020/021 emits nothing at all. */
    struct span cth[] = { { 1000, 1100 }, { 1300, 3300 } };
    assert(run(0, 4500, cth, 2) == 0);
    struct span ctd[] = { { 1000, 1100 }, { 1300, 2000 } };
    assert(run(0, 3200, ctd, 2) == 0);
    struct span cts[] = { { 1000, 1100 }, { 1300, 1325 } };
    assert(run(0, 2600, cts, 2) == 0);
    printf("event_counts: PASS\n");
}

int main(int argc, char **argv) {
    const char *scene = argc > 1 ? argv[1] : "";
    if (strcmp(scene, "tap_29") == 0) {
        test_tap_29();
    }
    else if (strcmp(scene, "tap_30") == 0) {
        test_tap_30();
    }
    else if (strcmp(scene, "tap_500") == 0) {
        test_tap_500();
    }
    else if (strcmp(scene, "tap_501") == 0) {
        test_tap_501();
    }
    else if (strcmp(scene, "tap_dead_zone_800") == 0) {
        test_tap_dead_zone_800();
    }
    else if (strcmp(scene, "single_tap_window") == 0) {
        test_single_tap_window();
    }
    else if (strcmp(scene, "double_tap_299") == 0) {
        test_double_tap_299();
    }
    else if (strcmp(scene, "double_tap_300") == 0) {
        test_double_tap_300();
    }
    else if (strcmp(scene, "double_tap_301") == 0) {
        test_double_tap_301();
    }
    else if (strcmp(scene, "hold_1499") == 0) {
        test_hold_1499();
    }
    else if (strcmp(scene, "hold_1500") == 0) {
        test_hold_1500();
    }
    else if (strcmp(scene, "hold_2999") == 0) {
        test_hold_2999();
    }
    else if (strcmp(scene, "hold_3000") == 0) {
        test_hold_3000();
    }
    else if (strcmp(scene, "hold_9999") == 0) {
        test_hold_9999();
    }
    else if (strcmp(scene, "hold_10000") == 0) {
        test_hold_10000();
    }
    else if (strcmp(scene, "overhold_rearm") == 0) {
        test_overhold_rearm();
    }
    else if (strcmp(scene, "bounce_tap") == 0) {
        test_bounce_tap();
    }
    else if (strcmp(scene, "glitch_19") == 0) {
        test_glitch_19();
    }
    else if (strcmp(scene, "glitch_in_window_19") == 0) {
        test_glitch_in_window_19();
    }
    else if (strcmp(scene, "debounce_edge_20") == 0) {
        test_debounce_edge_20();
    }
    else if (strcmp(scene, "wrap_hold_1600") == 0) {
        test_wrap_hold_1600();
    }
    else if (strcmp(scene, "wrap_tap") == 0) {
        test_wrap_tap();
    }
    else if (strcmp(scene, "wrap_double_tap") == 0) {
        test_wrap_double_tap();
    }
    else if (strcmp(scene, "compound_tap_hold") == 0) {
        test_compound_tap_hold();
    }
    else if (strcmp(scene, "compound_tap_dead_zone") == 0) {
        test_compound_tap_dead_zone();
    }
    else if (strcmp(scene, "compound_tap_too_short") == 0) {
        test_compound_tap_too_short();
    }
    else if (strcmp(scene, "abort_mid_press") == 0) {
        test_abort_mid_press();
    }
    else if (strcmp(scene, "abort_window") == 0) {
        test_abort_window();
    }
    else if (strcmp(scene, "abort_held") == 0) {
        test_abort_held();
    }
    else if (strcmp(scene, "stall_gap") == 0) {
        test_stall_gap();
    }
    else if (strcmp(scene, "stall_gap_overhold") == 0) {
        test_stall_gap_overhold();
    }
    else if (strcmp(scene, "start_pressed") == 0) {
        test_start_pressed();
    }
    else if (strcmp(scene, "event_counts") == 0) {
        test_event_counts();
    }
    else {
        fprintf(stderr, "unknown scenario: %s\n", scene);
        return 2;
    }
    return 0;
}
