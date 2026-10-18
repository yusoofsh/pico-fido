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

// EF_KEY_DEV binding to the SRAM PUF root key (formats 0x11/0x13): a legacy
// keydev (0x01, or PIN-wrapped 0x03) keeps decrypting to the same device key
// and is re-wrapped to the PUF format on first use once puf_key exists; a
// PUF-bound keydev refuses to load without puf_key; new keydevs are written
// PUF-bound directly. The emulation build has no PUF, so the test sets
// puf_key itself.

#include "picokeys.h"
#include "crypto_utils.h"
#include "files.h"
#include "fido.h"
#include "flash.h"
#include "puf.h"
#include "random.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// <unistd.h> clashes with a FIDO declaration of encrypt(); declare only what is needed.
extern int chdir(const char *path);
extern char *mkdtemp(char *tmpl);

// The SDK main.c (and its weak default) is not linked into this test.
uint16_t picokey_read_diagnostics(uint8_t *buffer, uint16_t capacity) {
    (void)buffer;
    (void)capacity;
    return 0;
}

static uint8_t puf_a[PUF_ROOT_KEY_SIZE], puf_b[PUF_ROOT_KEY_SIZE];

static uint8_t format(void) {
    assert(file_has_data(ef_keydev));
    return *file_get_data(ef_keydev);
}

static void load(uint8_t key[32]) {
    assert(load_keydev(key) == PICOKEYS_OK);
}

// What check_keydev_encrypted() does when a PIN is set.
static void pin_wrap(const uint8_t pin_token[32]) {
    uint8_t f = format();
    assert(f == 0x01 || f == 0x11);
    uint8_t tmp[61];
    tmp[0] = (uint8_t)((f & 0x10) | 0x03);
    assert(encrypt_with_aad(pin_token, CONST_BYTE_ARRAY(file_get_data(ef_keydev) + 1, 32), 2, tmp + 1) == PICOKEYS_OK);
    assert(file_put_data(ef_keydev, CONST_BYTE_ARRAY(tmp, sizeof(tmp))) == PICOKEYS_OK);
}

int main(void) {
    static char dir[] = "/tmp/fido_puf_keydev_test.XXXXXX";
    assert(mkdtemp(dir) != NULL);
    assert(chdir(dir) == 0);
    for (size_t i = 0; i < sizeof(puf_a); i++) {
        puf_a[i] = (uint8_t)(0xA5 ^ i);
        puf_b[i] = (uint8_t)(0x5A ^ (i * 7));
    }

    random_init();
    low_flash_init();
    file_scan_flash();
    puf_key = NULL;
    init_fido();

    uint8_t k0[32], k[32];
    assert(format() == 0x01);
    load(k0);

    // No PIN: the first load with the PUF key re-wraps 0x01 to 0x11.
    puf_key = puf_a;
    load(k);
    assert(memcmp(k, k0, 32) == 0);
    assert(format() == 0x11);
    const uint8_t *bound = file_get_data(ef_keydev);
    uint8_t snapshot[33];
    memcpy(snapshot, bound, sizeof(snapshot));
    load(k);
    assert(memcmp(k, k0, 32) == 0);
    assert(memcmp(file_get_data(ef_keydev), snapshot, sizeof(snapshot)) == 0); // no rewrite once bound

    // The inner layer really depends on the PUF key.
    puf_key = NULL;
    assert(load_keydev(k) == PICOKEYS_EXEC_ERROR);
    puf_key = puf_b;
    load(k);
    assert(memcmp(k, k0, 32) != 0);
    puf_key = puf_a;

    // PIN set on a PUF-bound keydev: 0x13, loads with the session PIN.
    random_fill_buffer(BYTE_ARRAY(session_pin, 32));
    pin_wrap(session_pin);
    assert(format() == 0x13);
    keydev_unlocked = false;
    load(k);
    assert(memcmp(k, k0, 32) == 0);
    assert(keydev_unlocked);
    assert(format() == 0x13);

    // Legacy PIN-wrapped keydev (0x03) migrates to 0x13 under the same PIN.
    puf_key = NULL;
    assert(encrypt_keydev_f1(k0) == PICOKEYS_OK);
    assert(format() == 0x01);
    pin_wrap(session_pin);
    assert(format() == 0x03);
    puf_key = puf_a;
    load(k);
    assert(memcmp(k, k0, 32) == 0);
    assert(format() == 0x13);
    load(k);
    assert(memcmp(k, k0, 32) == 0);

    // New keydevs are written PUF-bound directly.
    assert(encrypt_keydev_f1(k0) == PICOKEYS_OK);
    assert(format() == 0x11);
    load(k);
    assert(memcmp(k, k0, 32) == 0);

    // Unknown formats fail instead of returning an unset key.
    uint8_t bogus[33] = { 0x12 };
    assert(file_put_data(ef_keydev, CONST_BYTE_ARRAY(bogus, sizeof(bogus))) == PICOKEYS_OK);
    assert(load_keydev(k) == PICOKEYS_EXEC_ERROR);

    printf("fido_puf_keydev_test: OK\n");
    return 0;
}
