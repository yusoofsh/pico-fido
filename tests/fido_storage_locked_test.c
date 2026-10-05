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

// Storage-locked dispatch regression: while the storage is locked, every
// non-discovery request must be refused at the application entry points
// (cbor_parse, the FIDO/U2F APDU entries, OATH and OTP) before any handler
// runs: the documented error, no crash, no flash write. getInfo, the U2F
// version command and app SELECT still answer. An unlocked control runs the
// same requests against a freshly initialized storage and must never see the
// locked errors (the guard is a no-op unless locked).

#include "picokeys.h"
#include "apdu.h"
#include "ctap.h"
#include "ctap2_cbor.h"
#include "files.h"
#include "fido.h"
#include "hid/ctap_hid.h"
#include "random.h"
#include "serial.h"
#include "usb.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// The locked errors documented in docs/pipico/LAYOUT.md: CTAP2 requests are
// refused with CTAP1_ERR_OTHER, APDU applications with SW 0x6A84.
#define LOCKED_CTAP_ERROR CTAP1_ERR_OTHER
#define LOCKED_SW 0x6A84

extern const uint8_t fido_aid[];
extern const uint8_t u2f_aid[];
extern const uint8_t oath_aid[];
extern const uint8_t otp_aid[];

static char locked_dir[] = "/tmp/fido_locked_test.XXXXXX";
static char unlocked_dir[] = "/tmp/fido_unlocked_test.XXXXXX";
static char cwd_backup[512];

static uint8_t response_buffer[USB_BUFFER_SIZE];
static uint8_t apdu_buffer[300];

static void enter_fresh_dir(char *dir) {
    assert(mkdtemp(dir) != NULL);
    assert(chdir(dir) == 0);
}

// CTAP2: mirror the CTAPHID path (driver_init_hid binds the response buffer,
// cbor_process stages the request, cbor_parse is the dispatcher the cbor
// thread runs) and frame the result like cbor_thread does.
static int cbor_dispatch_n(const uint8_t *payload, size_t len) {
    driver_init_hid();
    cbor_process(CTAPHID_CBOR, payload, len);
    int ret = cbor_parse(CTAPHID_CBOR, payload, len);
    if (ret != 0) {
        assert(ret > 0 && ret <= UINT8_MAX);
        return (uint8_t)ret;
    }
    return CTAP2_OK;
}

#define cbor_dispatch(payload) cbor_dispatch_n(payload, sizeof(payload))

static size_t build_apdu(uint8_t *buf, uint8_t ins, uint8_t p1, uint8_t p2, const uint8_t *data, size_t nc) {
    buf[0] = 0x00;
    buf[1] = ins;
    buf[2] = p1;
    buf[3] = p2;
    buf[4] = (uint8_t)nc;
    if (nc > 0) {
        memcpy(buf + 5, data, nc);
    }
    return 5 + nc;
}

// APDU apps: mirror the CTAPHID MSG path (select the application, then run
// the central dispatcher) and report the response SW.
static uint16_t apdu_dispatch(const uint8_t *raw, size_t len) {
    assert(len <= sizeof(apdu_buffer));
    memcpy(apdu_buffer, raw, len);
    apdu.rdata = response_buffer;
    uint16_t parsed = apdu_process(0, CONST_BYTE_ARRAY(apdu_buffer, len));
    assert(parsed == 1);
    return process_apdu();
}

static uint16_t apdu_select(const uint8_t *aid) {
    uint8_t apdu[64];
    size_t len = build_apdu(apdu, 0xA4, 0x04, 0x00, aid + 1, aid[0]);
    return apdu_dispatch(apdu, len);
}

static uint16_t apdu_simple(uint8_t ins, uint8_t p1, uint8_t p2) {
    uint8_t apdu[8];
    size_t len = build_apdu(apdu, ins, p1, p2, NULL, 0);
    return apdu_dispatch(apdu, len);
}

static void test_locked_ctap2(void) {
    // makeCredential, getAssertion and setPIN payloads (any parse result is
    // fine: the gate refuses them before any handler runs).
    static const uint8_t make_cred[] = { CTAP_MAKE_CREDENTIAL, 0xA1, 0x01, 0x62, 0x72, 0x70 }; // {1: "rp"}
    static const uint8_t get_assertion[] = { CTAP_GET_ASSERTION, 0xA0 }; // {}
    static const uint8_t set_pin[] = { CTAP_CLIENT_PIN, 0xA2, 0x01, 0x02, 0x02, 0x03 }; // {1: 2, 2: 3} (protocol 2, setPIN)
    // credentialManagement (credsMetadata) and config requests shaped like
    // the scrutiny round-3 reproduction (see the ordering note below).
    static const uint8_t cred_mgmt[] = { CTAP_CREDENTIAL_MGMT, 0xA3, 0x01, 0x01, 0x03, 0x01, 0x04, 0x58, 0x20,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }; // {1: 1, 3: 1, 4: h'^32$'}
    static const uint8_t config[] = { CTAP_CONFIG, 0xA3, 0x01, 0x01, 0x03, 0x02, 0x04, 0x58, 0x20,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 }; // {1: 1, 3: 2, 4: h'^32$'}
    static const uint8_t reset[] = { CTAP_RESET };
    static const uint8_t get_info[] = { CTAP_GET_INFO };

    // The scrutiny round-3 blockers first: credentialManagement and config
    // requests shaped like the round-3 reproduction. With the gate disabled
    // they reach verify() with the NULL token keys of a locked boot and
    // fault; the gate must refuse them first.
    assert(cbor_dispatch(cred_mgmt) == LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(config) == LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(make_cred) == LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(get_assertion) == LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(set_pin) == LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(reset) == LOCKED_CTAP_ERROR);

    // Discovery still answers while locked.
    assert(cbor_dispatch(get_info) == CTAP2_OK);
    assert(res_APDU_size > 0);
}

static void test_locked_apdu_apps(void) {
    // App SELECT (discovery) works for every application while locked.
    assert(apdu_select(u2f_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_select(fido_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_select(oath_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_select(otp_aid) == CTAP_SW_NO_ERROR);

    // U2F: register and authenticate are refused, version (discovery) answers.
    assert(apdu_select(u2f_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(CTAP_REGISTER, 0x00, 0x00) == LOCKED_SW);
    assert(apdu_simple(CTAP_AUTHENTICATE, CTAP_AUTH_ENFORCE, 0x00) == LOCKED_SW);
    assert(apdu_simple(CTAP_VERSION, 0x00, 0x00) == CTAP_SW_NO_ERROR);

    // FIDO application entry (CTAP1 over CCID).
    assert(apdu_select(fido_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(CTAP_REGISTER, 0x00, 0x00) == LOCKED_SW);
    assert(apdu_simple(0x41, 0x00, 0x00) == LOCKED_SW); // vendor

    // OATH: every request is non-discovery (SELECT is central).
    assert(apdu_select(oath_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(0xA1, 0x00, 0x00) == LOCKED_SW); // LIST

    // OTP: same, including the configure command the keyboard path uses.
    assert(apdu_select(otp_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(0x01, 0x01, 0x00) == LOCKED_SW); // configure slot
}

static void test_locked_zero_writes(void) {
    // The file layer refuses every write while locked (this is the funnel
    // all storage writes go through), and the emulation flash file was never
    // created because nothing could have written.
    file_t *ef = file_search(EF_COUNTER);
    assert(ef != NULL);
    const uint8_t byte = 0;
    assert(file_put_data(ef, CONST_BYTE_ARRAY(&byte, sizeof(byte))) == PICOKEYS_ERR_BLOCKED);
    struct stat st;
    assert(stat("memory.flash", &st) != 0);
}

static void test_unlocked_control(void) {
    // Fresh storage: the guard is a no-op unless locked, so the same
    // requests reach the handlers and fail with their own protocol errors,
    // never the locked ones.
    assert(apdu_select(u2f_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(CTAP_VERSION, 0x00, 0x00) == CTAP_SW_NO_ERROR);
    assert(apdu_select(fido_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_select(oath_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_select(otp_aid) == CTAP_SW_NO_ERROR);

    static const uint8_t get_info[] = { CTAP_GET_INFO };
    static const uint8_t make_cred[] = { CTAP_MAKE_CREDENTIAL, 0xA1, 0x01, 0x62, 0x72, 0x70 };
    static const uint8_t get_assertion[] = { CTAP_GET_ASSERTION, 0xA0 };
    static const uint8_t set_pin[] = { CTAP_CLIENT_PIN, 0xA2, 0x01, 0x02, 0x02, 0x03 };
    static const uint8_t cred_mgmt[] = { CTAP_CREDENTIAL_MGMT, 0xA1, 0x01, 0x01 };
    static const uint8_t config[] = { CTAP_CONFIG, 0xA1, 0x01, 0x01 };

    assert(cbor_dispatch(get_info) == CTAP2_OK);
    assert(cbor_dispatch(make_cred) != LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(get_assertion) != LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(set_pin) != LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(cred_mgmt) != LOCKED_CTAP_ERROR);
    assert(cbor_dispatch(config) != LOCKED_CTAP_ERROR);

    assert(apdu_select(u2f_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(CTAP_REGISTER, 0x00, 0x00) != LOCKED_SW);
    assert(apdu_select(oath_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(0xA1, 0x00, 0x00) != LOCKED_SW); // LIST
    assert(apdu_select(otp_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_simple(0x01, 0x01, 0x00) != LOCKED_SW); // configure slot
}

int main(void) {
    assert(getcwd(cwd_backup, sizeof(cwd_backup)) != NULL);

    // Shared init: the interface numbers, HID buffers and queues that
    // usb_init() sets up in-process (no sockets are opened).
    usb_init();

    // Storage-locked phase: no storage initialization at all, mirroring a
    // locked boot (main() skips the flash scan, no bounds are published).
    enter_fresh_dir(locked_dir);
    low_flash_storage_force_locked(true);
    assert(low_flash_storage_locked() == true);
    test_locked_ctap2();
    test_locked_apdu_apps();
    test_locked_zero_writes();

    // Unlocked control: freshly initialized storage, guard inactive.
    enter_fresh_dir(unlocked_dir);
    low_flash_storage_force_locked(false);
    assert(low_flash_storage_locked() == false);
    serial_init();
    random_init();
    low_flash_init();
    file_scan_flash();
    init_fido();
    test_unlocked_control();

    assert(chdir(cwd_backup) == 0);
    printf("fido_storage_locked_test: all assertions passed\n");
    return 0;
}
