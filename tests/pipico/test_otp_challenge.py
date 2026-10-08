"""
OTP challenge-response with the BOOT button trigger (CHAL_BTN_TRIG), over CCID.

A slot configured for HMAC-SHA1 challenge-response with CHAL_BTN_TRIG
(cfg_flags 0x08) must wait for a real (emulated) BOOT press when the
calculate-APDU (INS 0x01, P1 0x30) arrives over CCID (pcscd/vpcd):

- BTN=none: the APDU is refused with SW 0x6985
  (SW_CONDITIONS_NOT_SATISFIED) and no HMAC is returned, but only after
  the configured timeout ran out (a real wait, measured)  [VAL-UP-018].
- BTN=press: the response equals HMAC-SHA1(aes_key || uid, challenge)
  computed on the host with the slot's secret  [VAL-UP-019].
- A press is consumed by exactly one challenge-response; the next one
  without a fresh press is refused (the no-reuse rule over CCID).

The slot is configured over CCID with the same wire format as
tests/pico-fido/test_071_otp.py (52-byte config, YubiKey CRC16 0xF0B8).
The module starts from a wiped device (CTAP2 reset in auto mode) and
deletes the slot again when it finishes.
"""

import hashlib
import hmac
import os
import time

import pytest
from smartcard.CardType import AnyCardType
from smartcard.CardRequest import CardRequest
from smartcard.Exceptions import CardRequestTimeoutException

from btn import BTN_ENV, resync, write_cmd
from utils import APDUResponse, send_apdu, transmit_apdu

TOV = 2  # the "short" emulation-only UP timeout override (seconds)
SW1_CONDITIONS = 0x69
SW2_CONDITIONS = 0x85

OTP_AID = [0xA0, 0x00, 0x00, 0x05, 0x27, 0x20, 0x01]
INS_OTP = 0x01
SLOT_CONFIGURE = 0x01
CALCULATE_HMAC_SHA1 = 0x30
OTP_CONFIG_SIZE = 52
ACC_CODE_SIZE = 6

# otp_config_t flag bits (src/fido/otp.c).
TKT_CHAL_RESP = 0x40
CFG_CHAL_HMAC = 0x22  # SHORT_TICKET | 0x20: HMAC-SHA1 challenge-response
CFG_CHAL_BTN_TRIG = 0x08

# Slot secret: the HMAC key is aes_key || uid (16 + 6 bytes), exactly as
# cmd_otp builds it. The challenge is the full 64 bytes (HMAC_LT64 unset).
UID = bytes(range(1, 7))
AES_KEY = bytes(range(11, 27))


def _crc16(data):
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ (0x8408 if crc & 1 else 0)
    return crc & 0xFFFF


def _otp_config(cfg_flags):
    config = bytearray(OTP_CONFIG_SIZE)
    config[16:22] = UID
    config[22:38] = AES_KEY
    # acc_code (38:44) stays zero: the slot is configured without one.
    config[46] = TKT_CHAL_RESP
    config[47] = cfg_flags
    crc = _crc16(config[:-2])
    config[-2:] = ((~crc) & 0xFFFF).to_bytes(2, "little")
    assert _crc16(config) == 0xF0B8
    return list(config)


def _select_otp(card):
    send_apdu(card, 0xA4, p1=0x04, p2=0x00, data=OTP_AID)


def _delete_slot(card):
    # An all-zero config deletes the slot; it must be appended with the
    # slot's access code (zero here).
    send_apdu(card, INS_OTP, p1=SLOT_CONFIGURE, p2=0,
              data=[0] * OTP_CONFIG_SIZE + [0] * ACC_CODE_SIZE)


def _raw_apdu(card, apdu):
    response, sw1, sw2 = transmit_apdu(card, apdu)
    return bytes(response), sw1, sw2


def _calculate(card, challenge):
    """The calculate-APDU, following ISO 7816 GET RESPONSE (INS 0xC0)
    paging: the CHAL_BTN_TRIG branch publishes a status frame before the
    wait, which caps the first response at that status length, so the
    HMAC arrives paged. Returns (data, (sw1, sw2)) with the data of every
    response segment concatenated."""
    apdu = [0x00, INS_OTP, CALCULATE_HMAC_SHA1, 0x00] + [0x00] + list(len(challenge).to_bytes(2, "big")) \
        + list(challenge) + [0x00, 0x00]
    data, sw1, sw2 = _raw_apdu(card, apdu)
    while sw1 == 0x61:
        chunk, sw1, sw2 = _raw_apdu(card, [0x00, 0xC0, 0x00, 0x00, 0x00, 0x00])
        data += chunk
    return data, (sw1, sw2)


def _expected_hmac(challenge):
    return hmac.new(AES_KEY + UID, challenge, hashlib.sha1).digest()


@pytest.fixture(scope="module")
def otp_card():
    """A CC/PC-SC connection of module scope (one card for the module)."""
    try:
        cardrequest = CardRequest(timeout=10, cardType=AnyCardType())
        card = cardrequest.waitforcard()
        card.connection.connect()
    except CardRequestTimeoutException:
        pytest.skip("no CCID card appeared within 10 s (pcscd/vpcd up?)")
    return card


@pytest.fixture(scope="module", autouse=True)
def otp_btn_slot(device, otp_card):
    """Wipe the device, then configure OTP slot 1 as the CHAL_BTN_TRIG
    HMAC-SHA1 slot. Deletes the slot again at module end."""
    if not os.environ.get(BTN_ENV):
        pytest.skip(f"emulator started without {BTN_ENV}")
    write_cmd("timeout:0")
    write_cmd("auto")
    resync(device)
    device.client()._backend.ctap2.reset(on_keepalive=lambda s: None)
    _select_otp(otp_card)
    send_apdu(otp_card, INS_OTP, p1=SLOT_CONFIGURE, p2=0,
              data=_otp_config(CFG_CHAL_HMAC | CFG_CHAL_BTN_TRIG))
    yield
    write_cmd("timeout:0")
    write_cmd("auto")
    _select_otp(otp_card)
    _delete_slot(otp_card)


def test_otp_chal_btn_no_touch_refused(otp_card):
    """VAL-UP-018: BOOT never pressed -> SW 0x6985, no HMAC, but only
    after the configured timeout (a real wait)."""
    challenge = os.urandom(64)
    # The timeout override first, the mode command last: parsing a new
    # command resets any pending press, so the mode must be the final write.
    write_cmd(f"timeout:{TOV}")
    write_cmd("none")
    t0 = time.time()
    data, (sw1, sw2) = _calculate(otp_card, challenge)
    dt = time.time() - t0
    assert (sw1, sw2) == (SW1_CONDITIONS, SW2_CONDITIONS), (sw1, sw2)
    assert data == b"", data
    assert 0.8 * TOV <= dt < TOV + 5.0, dt
    print(f"\nno-touch refusal after {dt:.2f} s (TOV={TOV})")


def test_otp_chal_btn_press_succeeds(otp_card):
    """VAL-UP-019: with one BOOT press the response equals the host-computed
    HMAC-SHA1(aes_key || uid, challenge)."""
    challenge = os.urandom(64)
    write_cmd(f"timeout:{TOV}")
    write_cmd("press")
    t0 = time.time()
    data, (sw1, sw2) = _calculate(otp_card, challenge)
    dt = time.time() - t0
    assert (sw1, sw2) == (0x90, 0x00), (sw1, sw2)
    assert data == _expected_hmac(challenge)
    print(f"\npressed challenge-response completed in {dt:.2f} s")


def test_otp_chal_btn_press_single_use(otp_card):
    """One press authorizes exactly one challenge-response: a second one
    without a fresh press is refused after the timeout."""
    challenge = os.urandom(64)
    write_cmd(f"timeout:{TOV}")
    write_cmd("press")
    data, (sw1, sw2) = _calculate(otp_card, challenge)
    assert (sw1, sw2) == (0x90, 0x00), (sw1, sw2)
    assert data == _expected_hmac(challenge)

    write_cmd("none")  # no new press; the previous one is consumed
    t0 = time.time()
    data, (sw1, sw2) = _calculate(otp_card, challenge)
    dt = time.time() - t0
    assert (sw1, sw2) == (SW1_CONDITIONS, SW2_CONDITIONS), (sw1, sw2)
    assert data == b"", data
    assert 0.8 * TOV <= dt < TOV + 5.0, dt
