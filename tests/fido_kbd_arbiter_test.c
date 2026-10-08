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

/* Host tests for the pure keyboard arbiter (src/pipico/kbd_arbiter.c).
 *
 * Every scenario is one process, selected by argv[1], so ctest names are
 * readable (ctest -R arbiter). The arbiter is driven with injected time and
 * injected input snapshots (no SDK, TinyUSB or hardware), exactly the way
 * the glue drives it: sample the busy inputs, kbd_arbiter_accept() the
 * gesture event, kbd_arbiter_poll() once and execute the returned action.
 *
 * Covered contract (VAL-COMP-023..031, VAL-COMP-034 mapping):
 *   - accept only when auth is idle, no UP wait is pending, OTP is not
 *     typing, the keyboard interface is enabled, mounted, not suspended
 *     and the transmitter is free;
 *   - one-deep pending, dropped after 100 ms (wraparound-safe) and never
 *     replayed;
 *   - pending event dropped on disconnect, suspend or an auth transition;
 *   - an accepted press always gets its release;
 *   - the F13..F16 -> 0x68..0x6B mapping (modifier 0, only keycode[0]
 *     nonzero) and NONE -> no send;
 *   - gestures starting during auth/OTP activity are discarded until
 *     release (the full parser+arbiter pipeline with the documented
 *     gesture_abort recipe).
 */

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "gesture.h"
#include "kbd_arbiter.h"

/* An all-clear snapshot: the arbiter must accept an event against this. */
static struct kbd_arbiter_inputs clear_inputs(void) {
    struct kbd_arbiter_inputs in = {
        .auth_busy = false,
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

/* A snapshot that keeps an accepted event pending: everything is clear but
 * the transport is not ready, so the event cannot be sent yet. */
static struct kbd_arbiter_inputs hold_inputs(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.ready = false;
    return in;
}

/* Shared drop/interrupt scenario bodies, defined after the scenarios. */
static void test_drop_common(struct kbd_arbiter_inputs in);
static void test_interrupt_common(struct kbd_arbiter_inputs in);

#define MAX_ACTIONS 16

struct act {
    uint32_t t;
    enum kbd_arbiter_action a;
    uint8_t keycode;
};

static struct act g_act[MAX_ACTIONS];
static int g_n_act;

static void act_reset(void) {
    g_n_act = 0;
}

static void act_record(uint32_t t, enum kbd_arbiter_action a, uint8_t keycode) {
    if (a == KBD_ARBITER_NONE) {
        return;
    }
    assert(g_n_act < MAX_ACTIONS);
    g_act[g_n_act].t = t;
    g_act[g_n_act].a = a;
    g_act[g_n_act].keycode = keycode;
    g_n_act++;
}

static int count_actions(enum kbd_arbiter_action a) {
    int n = 0;
    for (int i = 0; i < g_n_act; i++) {
        if (g_act[i].a == a) {
            n++;
        }
    }
    return n;
}

static const struct act *find_action(enum kbd_arbiter_action a) {
    for (int i = 0; i < g_n_act; i++) {
        if (g_act[i].a == a) {
            return &g_act[i];
        }
    }
    return NULL;
}

/* Poll a single instant and record the returned action. */
static void poll_once(uint32_t t, const struct kbd_arbiter_inputs *in) {
    act_record(t, kbd_arbiter_poll(t, in), kbd_arbiter_keycode());
}

/* Poll every ms over [t0, t1] (t1 may be below t0 across the wrap) with
 * fixed inputs and record the returned actions. */
static void poll_range(uint32_t t0, uint32_t t1, const struct kbd_arbiter_inputs *in) {
    for (uint32_t t = t0; (int32_t)(t - t1) <= 0; t++) {
        act_record(t, kbd_arbiter_poll(t, in), kbd_arbiter_keycode());
    }
}

/* Accept an event and poll once at the same instant, the way the glue does
 * within one loop iteration. */
static enum kbd_arbiter_action accept_and_poll(enum pipico_gesture_event ev, uint32_t now,
                                               bool *accepted,
                                               const struct kbd_arbiter_inputs *in) {
    *accepted = kbd_arbiter_accept(ev, now, in);
    enum kbd_arbiter_action a = kbd_arbiter_poll(now, in);
    act_record(now, a, kbd_arbiter_keycode());
    return a;
}

/* Full pipeline for the started_during_busy scenarios: gesture parser plus
 * arbiter, driven with the glue recipe from kbd_arbiter.h. */
struct span {
    uint32_t press;
    uint32_t release;
};

static bool pressed_at(uint32_t t, const struct span *spans, int nspans) {
    for (int i = 0; i < nspans; i++) {
        if ((int32_t)(t - spans[i].press) >= 0 && (int32_t)(t - spans[i].release) < 0) {
            return true;
        }
    }
    return false;
}

static int level_for(uint32_t t, const struct span *spans, int nspans) {
    /* Idle-high pull-up on GPIO24: pressed reads 0. */
    return pressed_at(t, spans, nspans) ? PIPICO_GESTURE_PRESSED_LEVEL
                                        : (PIPICO_GESTURE_PRESSED_LEVEL ? 0 : 1);
}

static bool busy_at(uint32_t t, uint32_t from, uint32_t to) {
    return (int32_t)(t - from) >= 0 && (int32_t)(t - to) < 0;
}

static void pipeline_tick(uint32_t now, int level, bool busy, bool busy_is_otp) {
    struct kbd_arbiter_inputs in = clear_inputs();
    if (busy_is_otp) {
        in.otp_typing = busy;
    } else {
        in.auth_busy = busy;
    }
    if (busy) {
        /* Glue recipe: while auth is busy or OTP is typing, abort the
         * parser. A gesture that started while busy is discarded and the
         * parser waits for a stable release before it rearms. */
        gesture_abort();
    }
    enum pipico_gesture_event ev = gesture_feed(now, level);
    if (ev != PIPICO_GESTURE_NONE) {
        (void)kbd_arbiter_accept(ev, now, &in);
    }
    act_record(now, kbd_arbiter_poll(now, &in), kbd_arbiter_keycode());
}

static void run_pipeline(uint32_t t0, uint32_t t1, const struct span *spans, int nspans,
                         uint32_t busy_from, uint32_t busy_to, bool busy_is_otp) {
    gesture_init();
    kbd_arbiter_init();
    act_reset();
    for (uint32_t t = t0; (int32_t)(t - t1) <= 0; t++) {
        pipeline_tick(t, level_for(t, spans, nspans), busy_at(t, busy_from, busy_to),
                      busy_is_otp);
    }
}

/* A press that begins while busy (auth busy or OTP typing) and outlives the
 * busy window emits nothing at release; a later clean tap still yields a
 * sent F13. */
static void started_during_busy(bool busy_is_otp) {
    /* A would-be 500 ms tap from 100 to 600, with busy [0, 300) covering
     * its start and clearing mid-press; then a clean 100 ms tap at 2500. */
    const struct span spans[] = { { 100, 600 }, { 2500, 2600 } };
    run_pipeline(0, 3300, spans, 2, 0, 300, busy_is_otp);
    /* The discarded gesture produced no action at all: every recorded
     * action belongs to the clean tap (it cannot emit before 2500). */
    for (int i = 0; i < g_n_act; i++) {
        assert(g_act[i].t >= 2500u);
    }
    /* Exactly one key-down/release pair, for the clean tap's F13. */
    assert(count_actions(KBD_ARBITER_SEND) == 1);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
    const struct act *send = find_action(KBD_ARBITER_SEND);
    assert(send != NULL && send->keycode == 0x68);
    assert(send->t >= 2921u); /* F13 emission sample of the clean tap */
    const struct act *rel = find_action(KBD_ARBITER_RELEASE);
    assert(rel != NULL && rel->t == send->t + 1);
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

/* VAL-COMP-023: with every input clear an F13 event is accepted; the
 * arbiter returns send for keycode 0x68 and then a release, and is idle
 * and reusable afterwards. */
static void test_accept_all_clear(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    bool accepted = false;
    enum kbd_arbiter_action a = accept_and_poll(PIPICO_GESTURE_F13, 1000, &accepted, &in);
    assert(accepted);
    assert(a == KBD_ARBITER_SEND);
    assert(kbd_arbiter_keycode() == 0x68);
    a = kbd_arbiter_poll(1001, &in);
    act_record(1001, a, kbd_arbiter_keycode());
    assert(a == KBD_ARBITER_RELEASE);
    assert(kbd_arbiter_poll(1002, &in) == KBD_ARBITER_NONE);
    assert(count_actions(KBD_ARBITER_SEND) == 1);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
    /* Rearmed: the next event is accepted and completes the same way. */
    accepted = false;
    a = accept_and_poll(PIPICO_GESTURE_F14, 2000, &accepted, &in);
    assert(accepted);
    assert(a == KBD_ARBITER_SEND);
    assert(kbd_arbiter_keycode() == 0x69);
    assert(kbd_arbiter_poll(2001, &in) == KBD_ARBITER_RELEASE);
    assert(kbd_arbiter_poll(2002, &in) == KBD_ARBITER_NONE);
}

/* VAL-COMP-024: accept is refused while auth is busy, while an UP wait is
 * pending, and while both hold; the dropped event is never sent later. */
static void test_drop_auth_busy(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.auth_busy = true;
    test_drop_common(in);
}

static void test_drop_up_pending(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.up_pending = true;
    test_drop_common(in);
}

static void test_drop_auth_and_up(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.auth_busy = true;
    in.up_pending = true;
    test_drop_common(in);
}

/* VAL-COMP-025: OTP typing and a transmitter held by another owner each
 * cause a drop; neither is queued for later. */
static void test_drop_otp_typing(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.otp_typing = true;
    test_drop_common(in);
}

static void test_drop_tx_busy(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.tx_busy = true;
    test_drop_common(in);
}

/* VAL-COMP-026: keyboard interface disabled, unmounted and suspended each
 * cause a drop; a suspended state never produces a send. */
static void test_drop_kb_disabled(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.kb_enabled = false;
    test_drop_common(in);
}

static void test_drop_unmounted(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.mounted = false;
    test_drop_common(in);
}

static void test_drop_suspended(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.suspended = true;
    test_drop_common(in);
}

/* VAL-COMP-027: an event accepted while the transport is not ready stays
 * sendable at exactly +100 ms and is dropped at +101 ms; after the drop
 * nothing is ever sent for it. */
static void test_stale_100(void) {
    struct kbd_arbiter_inputs hold = hold_inputs();
    struct kbd_arbiter_inputs clear = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &hold) == true);
    poll_range(1000, 1099, &hold);
    assert(count_actions(KBD_ARBITER_SEND) == 0);
    /* At exactly +100 ms the pending event is still sendable. */
    assert(kbd_arbiter_poll(1100, &clear) == KBD_ARBITER_SEND);
    assert(kbd_arbiter_keycode() == 0x68);
    assert(kbd_arbiter_poll(1101, &clear) == KBD_ARBITER_RELEASE);
    assert(kbd_arbiter_poll(1102, &clear) == KBD_ARBITER_NONE);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
}

static void test_stale_101(void) {
    struct kbd_arbiter_inputs hold = hold_inputs();
    struct kbd_arbiter_inputs clear = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &hold) == true);
    poll_range(1000, 1100, &hold);
    assert(count_actions(KBD_ARBITER_SEND) == 0);
    /* One ms past the window: dropped even though the transport is ready. */
    assert(kbd_arbiter_poll(1101, &clear) == KBD_ARBITER_DROP);
    /* Never replayed once every condition is clear. */
    poll_range(1102, 1500, &clear);
    assert(count_actions(KBD_ARBITER_SEND) == 0);
    assert(count_actions(KBD_ARBITER_RELEASE) == 0);
}

/* VAL-COMP-027: the same 100 ms boundary holds across the uint32 wrap. */
static void test_stale_wrap(void) {
    struct kbd_arbiter_inputs hold = hold_inputs();
    struct kbd_arbiter_inputs clear = clear_inputs();
    /* Sendable exactly at +100 ms across the wrap. */
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 0xFFFFFF00u, &hold) == true);
    assert(kbd_arbiter_poll(0xFFFFFF00u + 50, &hold) == KBD_ARBITER_NONE);
    assert(kbd_arbiter_poll(0xFFFFFF00u + 100, &clear) == KBD_ARBITER_SEND);
    assert(kbd_arbiter_keycode() == 0x68);
    assert(kbd_arbiter_poll(0xFFFFFF00u + 101, &clear) == KBD_ARBITER_RELEASE);
    assert(kbd_arbiter_poll(0xFFFFFF00u + 102, &clear) == KBD_ARBITER_NONE);
    /* Expired at +101 ms across the wrap: dropped, never replayed. */
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F14, 0xFFFFFF00u, &hold) == true);
    assert(kbd_arbiter_poll(0xFFFFFF00u + 100, &hold) == KBD_ARBITER_NONE);
    assert(kbd_arbiter_poll(0xFFFFFF00u + 101, &clear) == KBD_ARBITER_DROP);
    poll_range(0xFFFFFF00u + 102, 0xFFFFFF00u + 400, &clear);
    assert(count_actions(KBD_ARBITER_SEND) == 0);
}

/* VAL-COMP-028: while an event is pending, unmount, suspend, auth busy and
 * an UP wait becoming true each drop it; restoring the condition never
 * replays the event. */
static void test_interrupt_unmount(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.mounted = false;
    test_interrupt_common(in);
}

static void test_interrupt_suspend(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.suspended = true;
    test_interrupt_common(in);
}

static void test_interrupt_auth_busy(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.auth_busy = true;
    test_interrupt_common(in);
}

static void test_interrupt_up_pending(void) {
    struct kbd_arbiter_inputs in = clear_inputs();
    in.up_pending = true;
    test_interrupt_common(in);
}

/* While pending, OTP typing or a busy transmitter only block the send (no
 * drop, no report): the event goes out as soon as they clear, unless the
 * 100 ms expiry hits first. */
static void test_pending_blocks_on_otp(void) {
    struct kbd_arbiter_inputs hold = hold_inputs();
    struct kbd_arbiter_inputs clear = clear_inputs();
    struct kbd_arbiter_inputs blocked = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &hold) == true);
    blocked.otp_typing = true;
    assert(kbd_arbiter_poll(1050, &blocked) == KBD_ARBITER_NONE);
    blocked.otp_typing = false;
    poll_once(1090, &blocked);
    const struct act *send = find_action(KBD_ARBITER_SEND);
    assert(send != NULL && send->keycode == 0x68);
    poll_once(1091, &clear);
    assert(count_actions(KBD_ARBITER_SEND) == 1);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
    /* Same for a transmitter that turns busy while pending. */
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F14, 1000, &hold) == true);
    blocked.tx_busy = true;
    assert(kbd_arbiter_poll(1080, &blocked) == KBD_ARBITER_NONE);
    blocked.tx_busy = false;
    poll_once(1090, &blocked);
    send = find_action(KBD_ARBITER_SEND);
    assert(send != NULL && send->keycode == 0x69);
    poll_once(1091, &clear);
    assert(count_actions(KBD_ARBITER_SEND) == 1);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
}

/* VAL-COMP-029: the queue is one deep. A second event while one is pending
 * is dropped; the first is still sent, or neither if the first expires. */
static void test_queue_depth_one(void) {
    struct kbd_arbiter_inputs hold = hold_inputs();
    struct kbd_arbiter_inputs clear = clear_inputs();
    /* First is sent, second dropped. */
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &hold) == true);
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F14, 1050, &clear) == false);
    poll_once(1100, &clear);
    const struct act *send = find_action(KBD_ARBITER_SEND);
    assert(send != NULL && send->keycode == 0x68);
    poll_once(1101, &clear);
    assert(find_action(KBD_ARBITER_RELEASE) != NULL);
    assert(count_actions(KBD_ARBITER_SEND) == 1);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
    /* Neither is sent when the first expires; the queue is free again. */
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &hold) == true);
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F14, 1050, &hold) == false);
    poll_once(1200, &clear);
    assert(find_action(KBD_ARBITER_DROP) != NULL);
    poll_range(1201, 1250, &clear);
    assert(count_actions(KBD_ARBITER_SEND) == 0);
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F15, 1300, &clear) == true);
    poll_once(1300, &clear);
    send = find_action(KBD_ARBITER_SEND);
    assert(send != NULL && send->keycode == 0x6a);
    poll_once(1301, &clear);
    assert(find_action(KBD_ARBITER_RELEASE) != NULL);
}

/* VAL-COMP-030: after the key-down has been issued, the release follows no
 * matter what changed (auth busy, UP pending, unmount, suspend, elapsed
 * time). No drop rule leaves a key down. */
static void test_release_guaranteed(void) {
    const struct {
        const char *what;
        struct kbd_arbiter_inputs in;
    } cases[] = {
        { "auth_busy", { .auth_busy = true, .kb_enabled = true, .mounted = true } },
        { "up_pending", { .up_pending = true, .kb_enabled = true, .mounted = true } },
        { "unmounted", { .kb_enabled = true, .mounted = false } },
        { "suspended", { .kb_enabled = true, .mounted = true, .suspended = true } },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        struct kbd_arbiter_inputs clear = clear_inputs();
        kbd_arbiter_init();
        act_reset();
        assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &clear) == true);
        poll_once(1000, &clear);
        assert(find_action(KBD_ARBITER_SEND) != NULL);
        /* The condition turns hostile after the key-down: the release is
         * still issued. */
        poll_once(1050, &cases[i].in);
        assert(find_action(KBD_ARBITER_RELEASE) != NULL);
        poll_once(1051, &clear);
        assert(count_actions(KBD_ARBITER_SEND) == 1);
        assert(count_actions(KBD_ARBITER_RELEASE) == 1);
        assert(count_actions(KBD_ARBITER_DROP) == 0);
    }
    /* And after more than 100 ms: still exactly one release. */
    struct kbd_arbiter_inputs clear = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &clear) == true);
    poll_once(1000, &clear);
    assert(find_action(KBD_ARBITER_SEND) != NULL);
    poll_once(5000, &clear);
    assert(find_action(KBD_ARBITER_RELEASE) != NULL);
    poll_once(5001, &clear);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
}

/* VAL-COMP-030: the unconditional release also holds across the wrap. */
static void test_release_after_wrap(void) {
    struct kbd_arbiter_inputs clear = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 0xFFFFFFF0u, &clear) == true);
    poll_once(0xFFFFFFF0u, &clear);
    assert(find_action(KBD_ARBITER_SEND) != NULL);
    /* 200 ms after the key-down, across the wrap: release, never a drop. */
    poll_once(0xFFFFFFF0u + 200, &clear);
    assert(find_action(KBD_ARBITER_RELEASE) != NULL);
    poll_once(0xFFFFFFF0u + 201, &clear);
    assert(count_actions(KBD_ARBITER_RELEASE) == 1);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
}

/* VAL-COMP-034: the event-to-usage mapping F13..F16 -> 0x68..0x6B with
 * modifier 0 and only keycode[0] nonzero; NONE sends nothing. */
static void test_mapping(void) {
    static const struct {
        enum pipico_gesture_event ev;
        uint8_t usage;
    } table[] = {
        { PIPICO_GESTURE_F13, 0x68 },
        { PIPICO_GESTURE_F14, 0x69 },
        { PIPICO_GESTURE_F15, 0x6a },
        { PIPICO_GESTURE_F16, 0x6b },
    };
    struct kbd_arbiter_inputs in = clear_inputs();
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        kbd_arbiter_init();
        bool accepted = false;
        enum kbd_arbiter_action a = accept_and_poll(table[i].ev, 1000, &accepted, &in);
        assert(accepted);
        assert(a == KBD_ARBITER_SEND);
        assert(kbd_arbiter_keycode() == table[i].usage);
        uint8_t report[8];
        kbd_arbiter_report(report);
        assert(report[0] == 0); /* the modifier is always 0 */
        assert(report[1] == 0); /* reserved */
        assert(report[2] == table[i].usage); /* only keycode[0] is nonzero */
        for (size_t k = 3; k < sizeof(report); k++) {
            assert(report[k] == 0);
        }
        assert(kbd_arbiter_poll(1001, &in) == KBD_ARBITER_RELEASE);
        assert(kbd_arbiter_poll(1002, &in) == KBD_ARBITER_NONE);
    }
    /* NONE sends nothing, and neither does an unknown usage. */
    kbd_arbiter_init();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_NONE, 1000, &in) == false);
    assert(kbd_arbiter_accept((enum pipico_gesture_event)0x70, 1000, &in) == false);
    assert(kbd_arbiter_poll(1000, &in) == KBD_ARBITER_NONE);
}

/* VAL-COMP-031: gestures starting during auth or OTP activity are
 * discarded until release (pipeline of the parser, the glue recipe and the
 * arbiter). */
static void test_started_during_busy_auth(void) {
    started_during_busy(false);
}

static void test_started_during_busy_otp(void) {
    started_during_busy(true);
}

/* ------------------------------------------------------------------ */

/* Shared drop scenario body: accept is refused while `in` denies it, no
 * report is ever produced for the dropped event once the condition clears,
 * and the arbiter stays usable. */
static void test_drop_common(struct kbd_arbiter_inputs in) {
    struct kbd_arbiter_inputs clear = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    in.ready = true; /* irrelevant: the accept-time drop happens first */
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &in) == false);
    /* The condition has cleared: still nothing is sent for the event. */
    poll_range(1000, 1400, &clear);
    assert(g_n_act == 0);
    assert(count_actions(KBD_ARBITER_DROP) == 0);
    /* The arbiter stayed idle and accepts a fresh event. */
    bool accepted = false;
    enum kbd_arbiter_action a = accept_and_poll(PIPICO_GESTURE_F13, 1401, &accepted, &clear);
    assert(accepted);
    assert(a == KBD_ARBITER_SEND);
    assert(kbd_arbiter_keycode() == 0x68);
}

/* Shared interrupt scenario body: an event pending (accepted but not yet
 * sent) is dropped by the given condition and never replayed. */
static void test_interrupt_common(struct kbd_arbiter_inputs in) {
    struct kbd_arbiter_inputs hold = hold_inputs();
    struct kbd_arbiter_inputs clear = clear_inputs();
    kbd_arbiter_init();
    act_reset();
    assert(kbd_arbiter_accept(PIPICO_GESTURE_F13, 1000, &hold) == true);
    assert(kbd_arbiter_poll(1010, &hold) == KBD_ARBITER_NONE);
    /* The condition turns hostile while the event is pending. */
    assert(kbd_arbiter_poll(1020, &in) == KBD_ARBITER_DROP);
    /* Restored: nothing is sent for the dropped event, ever. */
    poll_range(1030, 1300, &clear);
    assert(count_actions(KBD_ARBITER_SEND) == 0);
    assert(count_actions(KBD_ARBITER_RELEASE) == 0);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <scenario>\n", argv[0]);
        return 2;
    }
    const char *scene = argv[1];
    if (strcmp(scene, "accept_all_clear") == 0) {
        test_accept_all_clear();
    }
    else if (strcmp(scene, "drop_auth_busy") == 0) {
        test_drop_auth_busy();
    }
    else if (strcmp(scene, "drop_up_pending") == 0) {
        test_drop_up_pending();
    }
    else if (strcmp(scene, "drop_auth_and_up") == 0) {
        test_drop_auth_and_up();
    }
    else if (strcmp(scene, "drop_otp_typing") == 0) {
        test_drop_otp_typing();
    }
    else if (strcmp(scene, "drop_tx_busy") == 0) {
        test_drop_tx_busy();
    }
    else if (strcmp(scene, "drop_kb_disabled") == 0) {
        test_drop_kb_disabled();
    }
    else if (strcmp(scene, "drop_unmounted") == 0) {
        test_drop_unmounted();
    }
    else if (strcmp(scene, "drop_suspended") == 0) {
        test_drop_suspended();
    }
    else if (strcmp(scene, "stale_100") == 0) {
        test_stale_100();
    }
    else if (strcmp(scene, "stale_101") == 0) {
        test_stale_101();
    }
    else if (strcmp(scene, "stale_wrap") == 0) {
        test_stale_wrap();
    }
    else if (strcmp(scene, "interrupt_unmount") == 0) {
        test_interrupt_unmount();
    }
    else if (strcmp(scene, "interrupt_suspend") == 0) {
        test_interrupt_suspend();
    }
    else if (strcmp(scene, "interrupt_auth_busy") == 0) {
        test_interrupt_auth_busy();
    }
    else if (strcmp(scene, "interrupt_up_pending") == 0) {
        test_interrupt_up_pending();
    }
    else if (strcmp(scene, "pending_blocks_on_otp") == 0) {
        test_pending_blocks_on_otp();
    }
    else if (strcmp(scene, "queue_depth_one") == 0) {
        test_queue_depth_one();
    }
    else if (strcmp(scene, "release_guaranteed") == 0) {
        test_release_guaranteed();
    }
    else if (strcmp(scene, "release_after_wrap") == 0) {
        test_release_after_wrap();
    }
    else if (strcmp(scene, "mapping") == 0) {
        test_mapping();
    }
    else if (strcmp(scene, "started_during_busy_auth") == 0) {
        test_started_during_busy_auth();
    }
    else if (strcmp(scene, "started_during_busy_otp") == 0) {
        test_started_during_busy_otp();
    }
    else {
        fprintf(stderr, "unknown scenario: %s\n", scene);
        return 2;
    }
    return 0;
}
