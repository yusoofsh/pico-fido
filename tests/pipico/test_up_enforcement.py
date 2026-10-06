"""
UP enforcement tests (architecture.md section 4, VAL-UP).

Every user-presence operation waits for a real (emulated) BOOT press even
when the configured timeout is 0 (this is a FORCE_BUTTON_WAIT build);
silent operations complete with no wait and no UPNEEDED keepalive; and no
stale press authorizes a later request.

The emulator is driven through the control file named by the environment
variable PICOKEYS_EMULATION_BUTTON_FILE (see docs/pipico/EMULATION.md and
the btn.py helpers). `timeout:<s>` is the emulation-only UP timeout
override; `timeout:0` restores the default resolution, which makes the
forced operations (makeCredential, getAssertion with up=true, selection,
U2F register, U2F enforce-and-sign, reset) wait about 30 s in this build.
"""

import hashlib
import os
import time

import pytest
from fido2.attestation import Attestation
from fido2.ctap import CtapError
from fido2.ctap1 import ApduError, Ctap1
from fido2.ctap2 import ClientPin
from fido2.hid import CTAPHID
from fido2.webauthn import AttestedCredentialData

from btn import (
    BTN_ENV,
    ERR_KEEPALIVE_CANCEL,
    ERR_NO_CREDENTIALS,
    ERR_OPERATION_DENIED,
    ERR_USER_ACTION_TIMEOUT,
    FLAG_UV,
    FLAG_UP,
    UPNEEDED,
    resync,
    run_in_thread,
    timed,
    wait_for_keepalive,
    write_cmd,
)

RP_ID = "example.com"
TOV = 2  # the "short" emulation-only UP timeout override (seconds)
SW_OK = 0x9000
SW_CONDITIONS_NOT_SATISFIED = 0x6985
SW_WRONG_DATA = 0x6A80
SW_INCORRECT_P1P2 = 0x6A86
KEY_HANDLE_LEN = 64


def ctap2(device):
    return device.client()._backend.ctap2


@pytest.fixture(autouse=True)
def auto_button(device):
    """Every test starts and ends in auto mode with no timeout override.

    A fresh HID connection is opened per test: a previous test's cancelled
    transaction can leave stale response frames on the wire, and the fresh
    CTAPHID INIT resets the device channel (and its TX ring) so every test
    starts from a clean transport state."""
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")
        resync(device)
    yield
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")


@pytest.fixture(scope="module", autouse=True)
def fresh_device(device):
    """Start the module from a wiped device (the reset is auto-accepted)."""
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")
    ctap2(device).reset(on_keepalive=lambda s: None)
    return device


def refuted_within_tov(err, dt):
    """The wait ran for the configured timeout and returned the UP error."""
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT), err.value
    assert 0.8 * TOV <= dt < TOV + 5.0, dt


def raw_mc(device, keepalives=None, **kwargs):
    """Raw authenticatorMakeCredential (ES256), with keepalive capture."""
    params = dict(
        client_data_hash=os.urandom(32),
        rp={"id": RP_ID, "name": "Example RP"},
        user={"id": b"user_id", "name": "A. User"},
        key_params=[{"type": "public-key", "alg": -7}],
    )
    if keepalives is not None:
        params["on_keepalive"] = keepalives.append
    params.update(kwargs)
    return ctap2(device).make_credential(**params)


def raw_ga(device, keepalives=None, **kwargs):
    """Raw authenticatorGetAssertion, with keepalive capture."""
    params = dict(rp_id=RP_ID, client_data_hash=os.urandom(32))
    if keepalives is not None:
        params["on_keepalive"] = keepalives.append
    params.update(kwargs)
    return ctap2(device).get_assertion(**params)


def register_credential(device, rk=True):
    """Create a credential; the BOOT press is consumed by its UP wait."""
    write_cmd("press")
    mc = device.MC(options={"rk": True} if rk else None)
    return mc["res"].auth_data.credential_data


def verify_assertion(assertion, client_data_hash, credential_data):
    """Verify an AssertionResponse against the credential's P-256 key."""
    assertion.verify(client_data_hash, AttestedCredentialData(credential_data).public_key)


def u2f_app_param():
    return hashlib.sha256(b"pipico-u2f.example.test").digest()


def u2f_register(device, client_param, app_param):
    """CTAP1 REGISTER (INS 0x01); raises ApduError when SW != 0x9000."""
    return Ctap1(device.dev).register(client_param, app_param)


def u2f_register_raw(device, client_param, app_param, keepalives=None):
    """Raw CTAP1 REGISTER APDU (CTAPHID MSG) with keepalive capture; raises
    ApduError when SW != 0x9000, returns the response data otherwise."""
    data = client_param + app_param
    apdu = bytes([0x00, 0x01, 0x00, 0x00, len(data)]) + data
    resp = device.send_data(CTAPHID.MSG, apdu, timeout=15,
                            on_keepalive=keepalives.append if keepalives is not None else None)
    sw = int.from_bytes(resp[-2:], "big")
    if sw != SW_OK:
        raise ApduError(sw, resp[:-2])
    return resp[:-2]


def u2f_authenticate(device, client_param, app_param, key_handle, check_only=False):
    """CTAP1 AUTHENTICATE; P1=0x03 (enforce) or P1=0x07 (check-only)."""
    return Ctap1(device.dev).authenticate(client_param, app_param, key_handle, check_only=check_only)


def u2f_authenticate_p1(device, p1, client_param, app_param, key_handle, keepalives=None):
    """Raw CTAP1 AUTHENTICATE APDU with an arbitrary P1 byte (CTAPHID MSG)."""
    data = client_param + app_param + bytes([len(key_handle)]) + key_handle
    apdu = bytes([0x00, 0x02, p1, 0x00, len(data)]) + data
    resp = device.send_data(CTAPHID.MSG, apdu, timeout=15,
                            on_keepalive=keepalives.append if keepalives is not None else None)
    return resp


# --- CTAP2 makeCredential ------------------------------------------------------


def test_makecred_no_touch_refused(device):
    """VAL-UP-001: no PIN, no pinUvAuthParam, BOOT never pressed: refused,
    and nothing is created."""
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        device.MC(options={"rk": True})
    refuted_within_tov(err, time.time() - t0)
    # A pressed assertion for the same rpId finds no credential.
    write_cmd("press")
    with pytest.raises(CtapError) as err:
        device.GA()
    assert err.value.code == ERR_NO_CREDENTIALS


def test_makecred_press_succeeds(device):
    """VAL-UP-002: one BOOT press makes the credential, UP is set, and the
    attestation verifies with python-fido2."""
    write_cmd("press")
    _, mc = timed(device.MC, options={"rk": True})
    resp = mc["res"]  # raw AttestationResponse
    assert resp.auth_data.flags & FLAG_UP
    Attestation.for_type(resp.fmt)().verify(resp.att_stmt, resp.auth_data, mc["req"]["client_data_hash"])


# --- CTAP2 getAssertion --------------------------------------------------------


def test_getassert_up_no_touch_refused(device):
    """VAL-UP-004: up=true with BOOT never pressed is refused, and the
    refusal does not bump the sign counter."""
    cred = register_credential(device, rk=True)
    allow = [{"id": cred.credential_id, "type": "public-key"}]
    write_cmd("press")
    ga1 = device.GA(allow_list=allow, options={"up": True})
    count = ga1["res"].auth_data.counter
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        device.GA(allow_list=allow, options={"up": True})
    refuted_within_tov(err, time.time() - t0)
    write_cmd("press")
    ga2 = device.GA(allow_list=allow, options={"up": True})
    assert ga2["res"].auth_data.counter == count + 1


def test_getassert_default_up_requires_boot(device):
    """VAL-UP-005: up omitted defaults to requiring BOOT; the signature
    verifies against the registered P-256 key."""
    cred = register_credential(device, rk=True)
    allow = [{"id": cred.credential_id, "type": "public-key"}]
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        device.GA(allow_list=allow)  # no options: up defaults to true
    refuted_within_tov(err, time.time() - t0)
    write_cmd("press")
    cdh = os.urandom(32)
    ga = device.GA(allow_list=allow, client_data_hash=cdh)
    assert ga["res"].auth_data.flags & FLAG_UP
    verify_assertion(ga["res"], cdh, cred)


def test_silent_assertion_up_false(device):
    """VAL-UP-006: up=false stays silent: prompt, UP=0, verified signature,
    no UPNEEDED keepalive."""
    cred = register_credential(device, rk=False)
    allow = [{"id": cred.credential_id, "type": "public-key"}]
    write_cmd("none")  # no timeout override: the default wait resolution
    keepalives = []
    cdh = os.urandom(32)
    t0 = time.time()
    resp = raw_ga(device, keepalives, allow_list=allow, options={"up": False}, client_data_hash=cdh)
    dt = time.time() - t0
    assert dt < 2.0, dt
    assert not (resp.auth_data.flags & FLAG_UP)
    verify_assertion(resp, cdh, cred)
    assert all(s != UPNEEDED for s in keepalives), keepalives


# --- CTAP2 reset ---------------------------------------------------------------


def test_reset_no_touch_refused(device):
    """VAL-UP-007: reset waits for BOOT under emulation and is refused
    without a press; the credential survives."""
    register_credential(device, rk=True)
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        ctap2(device).reset(on_keepalive=lambda s: None)
    refuted_within_tov(err, time.time() - t0)
    write_cmd("press")
    device.GA()  # the credential is still there


def test_reset_press_succeeds(device):
    """VAL-UP-008: a BOOT press authorizes the reset; credentials are gone."""
    register_credential(device, rk=True)
    write_cmd("press")
    ctap2(device).reset(on_keepalive=lambda s: None)
    # The reset consumed the armed press; arm a fresh one for the prompt
    # of the follow-up assertion (each wait needs its own touch).
    write_cmd("press")
    with pytest.raises(CtapError) as err:
        device.GA()
    assert err.value.code == ERR_NO_CREDENTIALS


def test_reset_zero_timeout_still_waits(device):
    """With no timeout override (configured timeout 0) a reset is refused
    too: FORCE_BUTTON_WAIT turns 0 into a ~30 s wait."""
    register_credential(device, rk=True)
    write_cmd("none")
    write_cmd("timeout:0")
    keepalives = []
    th, outcome = run_in_thread(lambda: ctap2(device).reset(on_keepalive=keepalives.append))
    th.start()
    wait_for_keepalive(keepalives)
    assert not outcome, "a reset must not complete without a touch"
    device.dev._send_cancel()
    th.join(timeout=5)
    assert outcome.get("err") in (ERR_KEEPALIVE_CANCEL, ERR_OPERATION_DENIED), outcome
    resync(device)  # the cancelled transaction leaves stale frames on the wire


# --- CTAP2 selection -----------------------------------------------------------


def test_selection_no_touch_refused(device):
    """VAL-UP-010: authenticatorSelection requires BOOT."""
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        ctap2(device).selection(on_keepalive=lambda s: None)
    refuted_within_tov(err, time.time() - t0)


def test_selection_press_succeeds(device):
    """VAL-UP-010: a BOOT press authorizes authenticatorSelection."""
    write_cmd("press")
    ctap2(device).selection()  # returns on CTAP2_OK (0x00)


# --- U2F (CTAP1) ---------------------------------------------------------------


def test_u2f_register_no_touch_refused(device):
    """VAL-UP-011: CTAP1 REGISTER without a BOOT press returns SW 0x6985."""
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    client_param, app_param = os.urandom(32), u2f_app_param()
    t0 = time.time()
    with pytest.raises(ApduError) as err:
        u2f_register(device, client_param, app_param)
    dt = time.time() - t0
    assert err.value.code == SW_CONDITIONS_NOT_SATISFIED
    assert 0.8 * TOV <= dt < TOV + 5.0, dt


def test_u2f_register_press_succeeds(device):
    """VAL-UP-012: CTAP1 REGISTER with one BOOT press returns 0x9000 and the
    registration data verifies."""
    write_cmd("press")
    client_param, app_param = os.urandom(32), u2f_app_param()
    reg = u2f_register(device, client_param, app_param)
    reg.verify(app_param, client_param)


def test_u2f_enforce_no_touch_refused(device):
    """VAL-UP-013: U2F enforce-and-sign (P1=0x03) without BOOT returns
    0x6985 and does not bump the signature counter."""
    write_cmd("press")
    client_param, app_param = os.urandom(32), u2f_app_param()
    reg = u2f_register(device, client_param, app_param)
    write_cmd("press")
    count = u2f_authenticate(device, client_param, app_param, reg.key_handle).counter
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    t0 = time.time()
    with pytest.raises(ApduError) as err:
        u2f_authenticate(device, client_param, app_param, reg.key_handle)
    dt = time.time() - t0
    assert err.value.code == SW_CONDITIONS_NOT_SATISFIED
    assert 0.8 * TOV <= dt < TOV + 5.0, dt
    write_cmd("press")
    auth2 = u2f_authenticate(device, client_param, app_param, reg.key_handle)
    assert auth2.counter == count + 1


def test_u2f_enforce_press_succeeds(device):
    """VAL-UP-014: U2F enforce-and-sign with a BOOT press returns 0x9000
    with the user-presence byte set and a verifying signature."""
    write_cmd("press")
    client_param, app_param = os.urandom(32), u2f_app_param()
    reg = u2f_register(device, client_param, app_param)
    write_cmd("press")
    auth = u2f_authenticate(device, client_param, app_param, reg.key_handle)
    assert auth.user_presence == 0x01
    auth.verify(app_param, client_param, reg.public_key)


def test_u2f_check_only_silent(device):
    """VAL-UP-015: P1=0x07 never waits: own handle 0x6985, foreign handle
    0x6A80, both promptly."""
    write_cmd("press")
    client_param, app_param = os.urandom(32), u2f_app_param()
    reg = u2f_register(device, client_param, app_param)
    write_cmd("none")  # no timeout override
    t0 = time.time()
    with pytest.raises(ApduError) as err:
        u2f_authenticate(device, client_param, app_param, reg.key_handle, check_only=True)
    own_dt = time.time() - t0
    assert err.value.code == SW_CONDITIONS_NOT_SATISFIED
    t0 = time.time()
    with pytest.raises(ApduError) as err:
        u2f_authenticate(device, client_param, app_param, os.urandom(KEY_HANDLE_LEN), check_only=True)
    foreign_dt = time.time() - t0
    assert err.value.code == SW_WRONG_DATA
    assert own_dt < 2.0 and foreign_dt < 2.0, (own_dt, foreign_dt)


def test_u2f_dont_enforce_6a86_immediate(device):
    """VAL-UP-016: P1=0x08 keeps returning SW 0x6A86 immediately, without
    waiting and without any keepalive."""
    write_cmd("press")
    client_param, app_param = os.urandom(32), u2f_app_param()
    reg = u2f_register(device, client_param, app_param)
    write_cmd("none")  # no timeout override
    keepalives = []
    t0 = time.time()
    resp = u2f_authenticate_p1(device, 0x08, client_param, app_param, reg.key_handle, keepalives)
    dt = time.time() - t0
    assert resp[-2:] == b"\x6a\x86", resp[-2:]
    assert dt < 2.0, dt
    assert all(s != UPNEEDED for s in keepalives), keepalives


# --- discovery -----------------------------------------------------------------


def test_getinfo_silent(device):
    """VAL-UP-017: getInfo and CTAPHID INIT stay silent; U2F_V2 and FIDO_2_0
    are advertised; alwaysUv is absent or false."""
    write_cmd("none")  # no timeout override
    t0 = time.time()
    info = ctap2(device).get_info()
    dt_info = time.time() - t0
    assert dt_info < 2.0, dt_info
    assert "U2F_V2" in info.versions
    assert "FIDO_2_0" in info.versions
    assert info.options.get("alwaysUv") in (None, False)
    nonce = b"\x12\x34\x56\x78\x9a\xbc\xde\xf0"
    t0 = time.time()
    resp = device.send_data(CTAPHID.INIT, nonce, timeout=5)
    dt_init = time.time() - t0
    assert dt_init < 2.0, dt_init
    assert resp[:8] == nonce  # the INIT response echoes the nonce


# --- zero configured timeout ---------------------------------------------------


def test_zero_timeout_waits_for_press_and_cancel(device):
    """VAL-UP-021: a configured timeout of 0 still waits (FORCE_BUTTON_WAIT,
    about 30 s): no completion within 5 s, UPNEEDED keepalives are received,
    and CTAPHID_CANCEL ends the wait with 0x2D."""
    write_cmd("none")
    write_cmd("timeout:0")
    keepalives = []
    th, outcome = run_in_thread(lambda: raw_mc(device, keepalives, options={"rk": True}))
    th.start()
    wait_for_keepalive(keepalives)
    time.sleep(5.0)
    assert not outcome, "makeCredential must not complete without a touch"
    device.dev._send_cancel()
    th.join(timeout=5)
    assert outcome.get("err") == ERR_KEEPALIVE_CANCEL, outcome


# --- no stale completion -------------------------------------------------------


def test_press_after_delayed_assertion(device):
    """VAL-UP-023: a press delayed 1 s into the active wait succeeds after
    the delay."""
    cred = register_credential(device, rk=True)
    allow = [{"id": cred.credential_id, "type": "public-key"}]
    write_cmd("none")
    write_cmd("timeout:3")
    keepalives = []
    th, outcome = run_in_thread(lambda: raw_ga(device, keepalives, allow_list=allow, options={"up": True}))
    t0 = time.time()
    th.start()
    wait_for_keepalive(keepalives)
    write_cmd("press-after:1000")
    th.join(timeout=10)
    dt = time.time() - t0
    assert outcome.get("ok"), outcome
    assert 1.0 <= dt < 3.0, dt
    assert outcome["res"].auth_data.flags & FLAG_UP


def test_cancel_cmd_aborts_makecred_and_u2f(device):
    """VAL-UP-024: the emulated `cancel` command aborts the active wait of a
    CTAP2 makeCredential and of a U2F register."""
    write_cmd("none")
    write_cmd("timeout:30")
    keepalives = []
    th, outcome = run_in_thread(lambda: raw_mc(device, keepalives, options={"rk": True}))
    th.start()
    wait_for_keepalive(keepalives)
    write_cmd("cancel")
    th.join(timeout=5)
    assert outcome.get("err") in (ERR_KEEPALIVE_CANCEL, ERR_OPERATION_DENIED), outcome

    write_cmd("none")
    write_cmd("timeout:30")
    # The U2F (CTAP1) path sends no UPNEEDED keepalives (send_keepalive is
    # gated on thread_type), so sync on a fixed settle instead.
    th, outcome = run_in_thread(lambda: u2f_register_raw(device, os.urandom(32), u2f_app_param()))
    th.start()
    time.sleep(0.5)  # the register's user-presence wait is active by now
    write_cmd("cancel")
    th.join(timeout=5)
    assert outcome.get("err") == SW_CONDITIONS_NOT_SATISFIED, outcome


def test_ctaphid_cancel_aborts_getassertion(device):
    """VAL-UP-024: a real CTAPHID_CANCEL aborts a pending up=true assertion
    with 0x2D within 2 s."""
    cred = register_credential(device, rk=True)
    allow = [{"id": cred.credential_id, "type": "public-key"}]
    write_cmd("none")
    write_cmd("timeout:30")
    keepalives = []
    th, outcome = run_in_thread(lambda: raw_ga(device, keepalives, allow_list=allow, options={"up": True}))
    th.start()
    wait_for_keepalive(keepalives)
    t0 = time.time()
    device.dev._send_cancel()
    th.join(timeout=5)
    dt = time.time() - t0
    assert outcome.get("err") == ERR_KEEPALIVE_CANCEL, outcome
    assert dt < 2.0, dt
    resync(device)  # the cancelled transaction leaves stale frames on the wire


def test_no_press_reuse_across_requests(device):
    """VAL-UP-025: one press authorizes exactly one request."""
    write_cmd("press")
    device.MC(options={"rk": True})  # consumed the press
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    with pytest.raises(CtapError) as err:
        device.GA(options={"up": True})  # must not reuse the press
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)


def test_late_press_after_timeout_discarded(device):
    """VAL-UP-026: a press arriving after a timeout never authorizes a later
    request."""
    cred = register_credential(device, rk=True)
    allow = [{"id": cred.credential_id, "type": "public-key"}]
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    write_cmd(f"press-after:{int((TOV + 1.5) * 1000)}")  # fires after the timeout
    with pytest.raises(CtapError) as err:
        device.GA(allow_list=allow, options={"up": True})
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)
    time.sleep(TOV + 2.5)  # the delayed press fires with no wait active
    with pytest.raises(CtapError) as err:
        device.GA(allow_list=allow, options={"up": True})
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)
    write_cmd("press")
    ga = device.GA(allow_list=allow, options={"up": True})
    assert ga["res"].auth_data.flags & FLAG_UP


def test_stale_after_cancel(device):
    """VAL-UP-027: a cancelled request leaves no press or cancel behind."""
    write_cmd("none")
    write_cmd("timeout:30")
    keepalives = []
    th, outcome = run_in_thread(lambda: raw_mc(device, keepalives, options={"rk": True}))
    th.start()
    wait_for_keepalive(keepalives)
    write_cmd("cancel")
    th.join(timeout=5)
    assert outcome.get("err") in (ERR_KEEPALIVE_CANCEL, ERR_OPERATION_DENIED), outcome

    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    with pytest.raises(CtapError) as err:
        device.MC(options={"rk": True})
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)

    write_cmd("press")
    mc = device.MC(options={"rk": True})
    assert mc["res"].auth_data.flags & FLAG_UP


def test_press_before_request_discarded(device):
    """VAL-UP-028: a press while no request is pending never authorizes a
    later one."""
    write_cmd("press-after:100")  # fires while idle and is discarded
    time.sleep(1.0)
    write_cmd(f"timeout:{TOV}")  # the mode stays press-after, but it is consumed
    with pytest.raises(CtapError) as err:
        device.GA(options={"up": True})
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)


# --- pinUvAuthParam ------------------------------------------------------------


def test_makecred_pin_still_requires_boot(device):
    """VAL-UP-003: a valid pinUvAuthParam does not replace the BOOT touch.
    This test leaves a PIN on the device and therefore runs last."""
    ctap2(device).reset(on_keepalive=lambda s: None)  # wipe earlier state
    client_pin = ClientPin(ctap2(device))
    client_pin.set_pin("12345678")
    token = client_pin.get_pin_token("12345678", ClientPin.PERMISSION.MAKE_CREDENTIAL)
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    cdh = os.urandom(32)
    pin_uv_param = client_pin.protocol.authenticate(token, cdh)
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        device.MC(client_data_hash=cdh, options={"rk": True}, pin_uv_param=pin_uv_param,
                  pin_uv_protocol=client_pin.protocol.VERSION)
    refuted_within_tov(err, time.time() - t0)
    # No credential was created.
    write_cmd("press")
    with pytest.raises(CtapError) as err:
        device.GA()
    assert err.value.code == ERR_NO_CREDENTIALS
    # The same request with a press succeeds and reports UP=1, UV=1. The
    # refused attempt invalidates the token session, so fetch a fresh one.
    token = client_pin.get_pin_token("12345678", ClientPin.PERMISSION.MAKE_CREDENTIAL)
    write_cmd("press")
    cdh = os.urandom(32)
    mc = device.MC(client_data_hash=cdh, options={"rk": True},
                   pin_uv_param=client_pin.protocol.authenticate(token, cdh),
                   pin_uv_protocol=client_pin.protocol.VERSION)
    flags = mc["res"].auth_data.flags
    assert flags & FLAG_UP
    assert flags & FLAG_UV
