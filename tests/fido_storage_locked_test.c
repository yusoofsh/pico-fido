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
#include "cbor.h"
#include "ctap.h"
#include "ctap2_cbor.h"
#include "crypto_utils.h"
#include "files.h"
#include "fido.h"
#include "hid/ctap_hid.h"
#include "mbedtls/aes.h"
#include "mbedtls/ecp.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
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

// CTAP2-over-APDU INS (the CTAP1/CCID command table in fido.c).
#define APDU_INS_CTAP_CBOR 0x10

// APDU CTAP2: select the FIDO application, then send a CTAP_CBOR APDU whose
// payload is the CTAP2 command (first byte = command).
static uint16_t apdu_cbor(const uint8_t *payload, size_t len) {
    uint8_t raw[300];
    size_t full_len = build_apdu(raw, APDU_INS_CTAP_CBOR, 0x00, 0x00, payload, len);
    return apdu_dispatch(raw, full_len);
}

// The response body of a successful CTAP2 APDU exchange: the CTAP2 status
// byte followed by the CBOR map.
static void assert_apdu_cbor_response(void) {
    assert(res_APDU_size >= 2);
    assert(res_APDU[0] == CTAP2_OK);
    assert((res_APDU[1] & 0xE0) == 0xA0); // a CBOR map
}

// ----- test seam: inject a storage-write failure -----
// The changePIN regression must fail exactly the new-PIN verifier write
// (file_put_data in cbor_client_pin.c) while every earlier step succeeds.
// The emulation-only force-locked hook cannot reach it: the cbor_parse gate
// refuses locked clientPIN requests before any handler runs. Instead the
// test binary links with -Wl,--wrap=file_put_data, so every production call
// lands here; when armed, the seam lets `pin_write_fail_skip` writes to the
// PIN file pass, then fails one with the same PICOKEYS_ERR_BLOCKED a locked
// storage returns.
extern int __real_file_put_data(file_t *file, const_byte_array_t data);
static bool pin_write_fail_armed = false;
static int pin_write_fail_skip = 0;

static void arm_pin_write_failure(int skip) {
    pin_write_fail_armed = true;
    pin_write_fail_skip = skip;
}

int __wrap_file_put_data(file_t *file, const_byte_array_t data) {
    if (pin_write_fail_armed && file == ef_pin) {
        if (pin_write_fail_skip > 0) {
            pin_write_fail_skip--;
        }
        else {
            pin_write_fail_armed = false;
            return PICOKEYS_ERR_BLOCKED;
        }
    }
    return __real_file_put_data(file, data);
}

// ----- minimal client side of the pinUvAuth protocol v1 -----
// Mirrors the production primitives in cbor_client_pin.c: the shared secret
// is SHA-256 over the ECDH shared point X, the request blobs are
// AES-256-CBC with a zero IV, and the signature is the first 16 bytes of an
// HMAC-SHA-256 over the message.
#define TEST_PIN_UV_AUTH_PROTOCOL 1
#define TEST_SUB_SET_PIN 0x3
#define TEST_SUB_CHANGE_PIN 0x4

typedef struct {
    mbedtls_ecp_group grp;
    mbedtls_mpi d;
    mbedtls_ecp_point Q;
    uint8_t shared_secret[32];
} client_pin_key_t;

static void test_sha256(const uint8_t *in, size_t len, uint8_t out[32]) {
    assert(mbedtls_sha256(in, len, out, 0) == 0);
}

static void test_aes_cbc_encrypt(const uint8_t key[32], const uint8_t *in, size_t len, uint8_t *out) {
    mbedtls_aes_context aes;
    uint8_t iv[IV_SIZE] = { 0 };
    mbedtls_aes_init(&aes);
    assert(mbedtls_aes_setkey_enc(&aes, key, 256) == 0);
    assert(mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, len, iv, in, out) == 0);
    mbedtls_aes_free(&aes);
}

static void test_hmac_sha256(const uint8_t key[32], const uint8_t *msg, size_t msg_len, uint8_t out[32]) {
    assert(mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32, msg, msg_len, out) == 0);
}

static void client_key_init(client_pin_key_t *ck) {
    mbedtls_ecp_group_init(&ck->grp);
    mbedtls_mpi_init(&ck->d);
    mbedtls_ecp_point_init(&ck->Q);
    memset(ck->shared_secret, 0, sizeof(ck->shared_secret));
}

static void client_key_free(client_pin_key_t *ck) {
    mbedtls_ecp_group_free(&ck->grp);
    mbedtls_mpi_free(&ck->d);
    mbedtls_ecp_point_free(&ck->Q);
}

// Derive the client key pair and the shared secret for the device key
// published by getKeyAgreement (the COSE key's -2/-3 coordinates).
static void client_key_agreement(client_pin_key_t *ck, const uint8_t dev_x[32], const uint8_t dev_y[32]) {
    mbedtls_ecp_point dev_q, z;
    uint8_t z_buf[32];
    mbedtls_ecp_point_init(&dev_q);
    mbedtls_ecp_point_init(&z);
    assert(mbedtls_ecp_group_load(&ck->grp, MBEDTLS_ECP_DP_SECP256R1) == 0);
    assert(mbedtls_mpi_read_binary(&dev_q.X, dev_x, 32) == 0);
    assert(mbedtls_mpi_read_binary(&dev_q.Y, dev_y, 32) == 0);
    assert(mbedtls_mpi_lset(&dev_q.Z, 1) == 0);
    assert(mbedtls_ecp_gen_keypair(&ck->grp, &ck->d, &ck->Q, random_fill_iterator, NULL) == 0);
    assert(mbedtls_ecp_mul(&ck->grp, &z, &ck->d, &dev_q, random_fill_iterator, NULL) == 0);
    assert(mbedtls_mpi_write_binary(&z.X, z_buf, sizeof(z_buf)) == 0);
    test_sha256(z_buf, sizeof(z_buf), ck->shared_secret);
    mbedtls_ecp_point_free(&z);
    mbedtls_ecp_point_free(&dev_q);
}

// getKeyAgreement over the real dispatcher, then derive the shared secret
// from the device's COSE key ({1: {1: 2, 3: alg, -1: 1, -2: X, -3: Y}}).
static void device_key_agreement(client_pin_key_t *ck) {
    static const uint8_t req[] = { CTAP_CLIENT_PIN, 0xA2, 0x01, 0x01, 0x02, 0x02 }; // {1: 1, 2: 2}
    assert(cbor_dispatch(req) == CTAP2_OK);

    CborParser parser;
    CborValue it, elem, celem;
    int64_t key;
    size_t len;
    uint8_t dev_x[32] = { 0 }, dev_y[32] = { 0 };
    assert(cbor_parser_init(ctap_resp->init.data + 1, res_APDU_size, 0, &parser, &it) == CborNoError);
    assert(cbor_value_enter_container(&it, &elem) == CborNoError);
    while (!cbor_value_at_end(&elem)) {
        assert(cbor_value_get_int64(&elem, &key) == CborNoError);
        assert(cbor_value_advance(&elem) == CborNoError); // now at the value
        if (key == 1 && cbor_value_get_type(&elem) == CborMapType) {
            assert(cbor_value_enter_container(&elem, &celem) == CborNoError);
            while (!cbor_value_at_end(&celem)) {
                int64_t cose_key;
                assert(cbor_value_get_int64(&celem, &cose_key) == CborNoError);
                assert(cbor_value_advance(&celem) == CborNoError);
                if (cose_key == -2 || cose_key == -3) {
                    uint8_t *dst = (cose_key == -2) ? dev_x : dev_y;
                    len = 32;
                    assert(cbor_value_copy_byte_string(&celem, dst, &len, NULL) == CborNoError);
                    assert(len == 32);
                    assert(cbor_value_advance(&celem) == CborNoError);
                }
                else {
                    assert(cbor_value_advance(&celem) == CborNoError);
                }
            }
            assert(cbor_value_leave_container(&elem, &celem) == CborNoError);
        }
        else {
            assert(cbor_value_advance(&elem) == CborNoError);
        }
    }
    client_key_agreement(ck, dev_x, dev_y);
}

// Encode the client's COSE key as a nested map (the value of request key 3).
static void client_encode_cose_key(const client_pin_key_t *ck, CborEncoder *map) {
    CborEncoder cose_map;
    uint8_t x[32], y[32];
    assert(mbedtls_mpi_write_binary(&ck->Q.X, x, sizeof(x)) == 0);
    assert(mbedtls_mpi_write_binary(&ck->Q.Y, y, sizeof(y)) == 0);
    assert(cbor_encoder_create_map(map, &cose_map, 5) == CborNoError);
    assert(cbor_encode_uint(&cose_map, 1) == CborNoError); // kty: EC2
    assert(cbor_encode_uint(&cose_map, 2) == CborNoError);
    assert(cbor_encode_uint(&cose_map, 3) == CborNoError); // alg: ECDH-ES+HKDF-256
    assert(cbor_encode_int(&cose_map, FIDO2_ALG_ECDH_ES_HKDF_256) == CborNoError);
    assert(cbor_encode_int(&cose_map, -1) == CborNoError); // crv: P-256
    assert(cbor_encode_uint(&cose_map, FIDO2_CURVE_P256) == CborNoError);
    assert(cbor_encode_int(&cose_map, -2) == CborNoError);
    assert(cbor_encode_byte_string(&cose_map, x, sizeof(x)) == CborNoError);
    assert(cbor_encode_int(&cose_map, -3) == CborNoError);
    assert(cbor_encode_byte_string(&cose_map, y, sizeof(y)) == CborNoError);
    assert(cbor_encoder_close_container(map, &cose_map) == CborNoError);
}

// Full clientPIN exchange over the real dispatcher: getKeyAgreement, then
// the requested subcommand with protocol-v1 blobs for (old_pin, new_pin).
// setPIN omits the old-pin blob; changePIN authenticates over both blobs
// and sends the encrypted old-pin hash in pinHashEnc.
static int client_pin_exchange(uint8_t subcommand, const char *old_pin, const char *new_pin) {
    client_pin_key_t ck;
    size_t new_len = strlen(new_pin);
    uint8_t padded[64] = { 0 };
    uint8_t new_enc[64];
    uint8_t msg[sizeof(new_enc) + IV_SIZE];
    size_t msg_len = sizeof(new_enc);
    uint8_t pin_hash_enc[IV_SIZE] = { 0 };
    uint8_t sig[16], hmac[32];
    uint8_t req[300];
    CborEncoder enc, map;
    int ret;

    assert(new_len > 0 && new_len < sizeof(padded));
    client_key_init(&ck);
    device_key_agreement(&ck);

    memcpy(padded, new_pin, new_len);
    test_aes_cbc_encrypt(ck.shared_secret, padded, sizeof(padded), new_enc);
    memcpy(msg, new_enc, sizeof(new_enc));
    if (subcommand == TEST_SUB_CHANGE_PIN) {
        uint8_t old_hash[32];
        size_t old_len = strlen(old_pin);
        assert(old_len > 0 && old_len < 64);
        test_sha256((const uint8_t *)old_pin, old_len, old_hash);
        test_aes_cbc_encrypt(ck.shared_secret, old_hash, sizeof(pin_hash_enc), pin_hash_enc);
        memcpy(msg + sizeof(new_enc), pin_hash_enc, sizeof(pin_hash_enc));
        msg_len += sizeof(pin_hash_enc);
    }
    test_hmac_sha256(ck.shared_secret, msg, msg_len, hmac);
    memcpy(sig, hmac, sizeof(sig));
    memset(msg, 0, sizeof(msg));

    cbor_encoder_init(&enc, req + 1, sizeof(req) - 1, 0);
    assert(cbor_encoder_create_map(&enc, &map, subcommand == TEST_SUB_CHANGE_PIN ? 6 : 5) == CborNoError);
    assert(cbor_encode_uint(&map, 1) == CborNoError); // pinUvAuthProtocol
    assert(cbor_encode_uint(&map, TEST_PIN_UV_AUTH_PROTOCOL) == CborNoError);
    assert(cbor_encode_uint(&map, 2) == CborNoError); // subcommand
    assert(cbor_encode_uint(&map, subcommand) == CborNoError);
    assert(cbor_encode_uint(&map, 3) == CborNoError); // key agreement
    client_encode_cose_key(&ck, &map);
    assert(cbor_encode_uint(&map, 4) == CborNoError); // pinUvAuthParam
    assert(cbor_encode_byte_string(&map, sig, sizeof(sig)) == CborNoError);
    assert(cbor_encode_uint(&map, 5) == CborNoError); // newPinEnc
    assert(cbor_encode_byte_string(&map, new_enc, sizeof(new_enc)) == CborNoError);
    if (subcommand == TEST_SUB_CHANGE_PIN) {
        assert(cbor_encode_uint(&map, 6) == CborNoError); // pinHashEnc
        assert(cbor_encode_byte_string(&map, pin_hash_enc, sizeof(pin_hash_enc)) == CborNoError);
    }
    assert(cbor_encoder_close_container(&enc, &map) == CborNoError);
    req[0] = CTAP_CLIENT_PIN;
    ret = cbor_dispatch_n(req, 1 + cbor_encoder_get_buffer_size(&enc, req + 1));
    client_key_free(&ck);
    return ret;
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

    // CTAP2 over APDU/CCID: getInfo is discovery and must answer while
    // locked (SELECT then `00 10 00 00 01 04`); every other CTAP2 payload
    // stays refused at this outer gate (cbor_parse refuses it again).
    assert(apdu_select(fido_aid) == CTAP_SW_NO_ERROR);
    assert(apdu_cbor(NULL, 0) == LOCKED_SW); // no payload: not discovery
    static const uint8_t locked_make_cred[] = { CTAP_MAKE_CREDENTIAL };
    assert(apdu_cbor(locked_make_cred, sizeof(locked_make_cred)) == LOCKED_SW);
    static const uint8_t locked_get_info[] = { CTAP_GET_INFO };
    assert(apdu_cbor(locked_get_info, sizeof(locked_get_info)) == CTAP_SW_NO_ERROR);
    assert_apdu_cbor_response();

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
    static const uint8_t apdu_get_info[] = { CTAP_GET_INFO };
    assert(apdu_cbor(apdu_get_info, sizeof(apdu_get_info)) == CTAP_SW_NO_ERROR);
    assert_apdu_cbor_response();
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

static void test_unlocked_change_pin(void) {
    // Fresh device: setPIN first (a full clientPIN exchange over the real
    // dispatcher).
    assert(client_pin_exchange(TEST_SUB_SET_PIN, NULL, "1234") == CTAP2_OK);

    // Control: an unlocked changePIN succeeds and the stored verifier
    // really changes (the old PIN no longer verifies, the new one does).
    // These run before the write-failure injection below: a changePIN that
    // fails mid-way leaves the device keys re-wrapped for the rejected new
    // PIN, so the device refuses later changes until a reset.
    assert(client_pin_exchange(TEST_SUB_CHANGE_PIN, "1234", "23456789") == CTAP2_OK);
    assert(client_pin_exchange(TEST_SUB_CHANGE_PIN, "1234", "3456789a") == CTAP2_ERR_PIN_INVALID);
    assert(client_pin_exchange(TEST_SUB_CHANGE_PIN, "23456789", "1234") == CTAP2_OK);

    // Injected PIN-write failure: the seam lets the retry-counter write and
    // the counter-restore write pass and fails the new-PIN verifier write
    // with the file layer's blocked error. changePIN must return a CTAP
    // error instead of reporting success while the old verifier stays
    // stored.
    arm_pin_write_failure(2);
    assert(client_pin_exchange(TEST_SUB_CHANGE_PIN, "1234", "23456789") == CTAP2_ERR_NOT_ALLOWED);
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
    test_unlocked_change_pin();

    assert(chdir(cwd_backup) == 0);
    printf("fido_storage_locked_test: all assertions passed\n");
    return 0;
}
