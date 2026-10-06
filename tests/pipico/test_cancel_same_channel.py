"""
Same-channel CTAPHID_CANCEL regression (VAL-UP-027).

A CTAPHID_CANCEL during a pending user-presence wait must leave the channel
usable. On ONE HID connection, with no resync and no reconnect:

  #1 the cancelled makeCredential is answered with exactly one 0x2D;
  #2 a no-touch makeCredential runs a genuine wait and then fails with a
     correctly framed 0x27/0x2F (never a leftover frame from #1);
  #3 a makeCredential with one fresh press succeeds exactly once;
  and no stale frames circulate afterwards.

This reproduces the user-testing round-1 failure, where the aborted
command's late worker completion was misdelivered as a malformed one-byte
0x00 frame and the retried request's own response stayed withheld.
"""

import os
import socket
import struct
import threading
import time

import pytest
from fido2.ctap import CtapError
from fido2 import cbor as raw_cbor

from btn import (
    BTN_ENV,
    ERR_KEEPALIVE_CANCEL,
    ERR_OPERATION_DENIED,
    ERR_USER_ACTION_TIMEOUT,
    FLAG_UP,
    UPNEEDED,
    write_cmd,
    wait_for_keepalive,
)

RP_ID = "cancel-same-channel.example.test"
TOV = 2  # the short emulation-only UP timeout override (seconds)


def ctap2(device):
    return device.client()._backend.ctap2


def run_broad(fn):
    """Run fn() on a thread; record CtapError codes AND anything else.

    A desynchronized transport surfaces as an arbitrary client exception
    (TypeError, ConnectionFailure, ...), not as a CtapError, so the runner
    must capture it to distinguish a framed CTAP error from stale frames.
    """
    outcome = {}

    def wrapper():
        try:
            outcome["res"] = fn()
        except CtapError as e:
            outcome["err"] = e.code
        except BaseException as e:
            outcome["unexpected"] = repr(e)

    th = threading.Thread(target=wrapper, daemon=True)
    return th, outcome


def raw_mc(device, keepalives=None, **kwargs):
    """Raw authenticatorMakeCredential (ES256), with keepalive capture."""
    params = dict(
        client_data_hash=os.urandom(32),
        rp={"id": RP_ID, "name": "Cancel RP"},
        user={"id": b"cancel_same_channel", "name": "Cancel Test"},
        key_params=[{"type": "public-key", "alg": -7}],
    )
    if keepalives is not None:
        params["on_keepalive"] = keepalives.append
    params.update(kwargs)
    return ctap2(device).make_credential(**params)


@pytest.fixture(scope="module", autouse=True)
def fresh_device(device):
    """Start the module from a wiped device (the reset is auto-accepted)."""
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")
    ctap2(device).reset(on_keepalive=lambda s: None)


@pytest.fixture(autouse=True)
def auto_mode(device):
    """Every test starts and ends in auto mode with no timeout override."""
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")
    yield
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")


def test_cancel_then_retries_on_one_channel(device):
    """VAL-UP-027: after CTAPHID_CANCEL the SAME channel stays usable."""
    # A credential exists from the start so the trailing discovery probe can
    # also rely on a populated authenticator.
    write_cmd("press")
    first = raw_mc(device, options={"rk": True})
    assert first.auth_data.flags & FLAG_UP

    # --- Request #1: pending makeCredential, cancelled by the host. ---
    write_cmd("none")
    write_cmd("timeout:30")
    keepalives = []
    th, outcome = run_broad(lambda: raw_mc(device, keepalives, options={"rk": True}))
    th.start()
    wait_for_keepalive(keepalives)
    t0 = time.time()
    device.dev._send_cancel()
    th.join(timeout=5)
    assert not th.is_alive(), outcome
    assert outcome.get("err") == ERR_KEEPALIVE_CANCEL, outcome
    assert time.time() - t0 < 2.0, "the cancel must be answered promptly"

    # --- Request #2 on the SAME connection (no resync): a no-touch
    # makeCredential must run a genuine wait and then fail with a correctly
    # framed 0x27/0x2F, never a leftover frame from #1. ---
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    keepalives2 = []
    t0 = time.time()
    th, outcome = run_broad(lambda: raw_mc(device, keepalives2, options={"rk": True}))
    th.start()
    th.join(timeout=15)
    assert not th.is_alive(), outcome
    assert outcome.get("unexpected") is None, outcome
    assert outcome.get("err") in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT), outcome
    dt = time.time() - t0
    assert dt >= 0.8 * TOV, dt  # the wait really ran
    assert UPNEEDED in keepalives2, keepalives2

    # --- Request #3 on the SAME connection: one fresh press succeeds. ---
    write_cmd("press")
    third = raw_mc(device, options={"rk": True})
    assert third.auth_data.flags & FLAG_UP

    # --- No stray frames afterwards: a silent discovery request on the same
    # channel gets its own correct response (a desync would shift frames). ---
    write_cmd("timeout:0")
    write_cmd("auto")
    info = ctap2(device).get_info()
    assert "FIDO_2_0" in info.versions


# --- Raw-socket fast-retry regression (scrutiny round 3) ---------------------
#
# Raw CTAPHID framing over the emulator's TCP transport: each report is
# exactly 64 bytes on the wire, prefixed with its 2-byte big-endian length
# (0x0040). The fido2 client stack is too slow between the cancel response
# and the next request to hit the device's 10 ms button-poll window; the raw
# socket writes the retry within microseconds of reading the 0x2D.

_EMU_HOST = "127.0.0.1"
_EMU_PORT = 35962  # upstream-hardcoded emulation CTAPHID port
_TYPE_INITFLAG = 0x80
_HID_INIT = _TYPE_INITFLAG | 0x06
_HID_CBOR = _TYPE_INITFLAG | 0x10
_HID_CANCEL = _TYPE_INITFLAG | 0x11
_HID_KEEPALIVE = _TYPE_INITFLAG | 0x3B
_BROADCAST = 0xFFFFFFFF


def _recv_report(sock, timeout):
    sock.settimeout(timeout)
    hdr = sock.recv(2)
    assert len(hdr) == 2, "transport closed"
    size = int.from_bytes(hdr, "big")
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        assert chunk, "transport closed mid-report"
        data += chunk
    return data


def _send_report(sock, frame):
    assert len(frame) <= 64
    sock.sendall(b"\x00\x40" + frame.ljust(64, b"\x00"))


def _packet(cid, cmd, payload=b""):
    return struct.pack(">IB", cid, cmd) + len(payload).to_bytes(2, "big") + payload


def _cbor_packets(cid, payload):
    """Split a CBOR message into CTAPHID init + continuation reports.

    The init frame's bcnt carries the FULL message length (the device
    assembles across reports until it reaches it); continuation frames
    carry only a sequence byte. """
    reports = [struct.pack(">IB", cid, _HID_CBOR) + len(payload).to_bytes(2, "big") + payload[: 64 - 7]]
    payload = payload[64 - 7:]
    seq = 0
    while payload:
        chunk = payload[: 64 - 5]
        reports.append(struct.pack(">IB", cid, seq & 0x7F) + chunk)
        payload = payload[64 - 5:]
        seq += 1
    return reports


def _init_channel(sock):
    nonce = b"cnclfast"
    _send_report(sock, _packet(_BROADCAST, _HID_INIT, nonce))
    resp = _recv_report(sock, 5.0)
    assert resp[4] == _HID_INIT, f"unexpected INIT response: cmd=0x{resp[4]:02x}"
    return struct.unpack(">I", resp[7 + 8:7 + 12])[0]


def test_cancel_fast_retry_before_button_poll_raw(device):
    """A same-channel retry written to the socket IMMEDIATELY after the 0x2D
    (well before the next 10 ms button poll) is processed exactly once with
    a correctly framed response, and no stale frame of the cancelled
    request leaks. The retry is authenticatorGetInfo: it needs no user
    presence, so its 0x00-status info map can only be its own answer.

    The emulator's TCP round trip always loses to the device's cancellation
    observation, so THIS test pins the end-to-end same-channel behavior
    rather than the race itself; the deterministic retry-before-poll
    regression (the retry admitted before any button poll) lives in the SDK
    host ctest hid_cancel_retry_test scene fast_retry.

    Runs LAST in this module: the emulator serves one HID client at a time,
    so this connection replaces the fido2 fixture's transport."""
    write_cmd("none")
    write_cmd(f"timeout:{TOV}")
    sock = socket.create_connection((_EMU_HOST, _EMU_PORT), timeout=10)
    try:
        cid = _init_channel(sock)

        # Raw CTAP2 makeCredential (0x01), minimal ES256 rk=true request.
        request = {
            0x01: os.urandom(32),
            0x02: {"id": RP_ID, "name": "Cancel RP"},
            0x03: {"id": b"cancel_fast_retry", "name": "Cancel Fast Retry"},
            0x04: [{"type": "public-key", "alg": -7}],
            0x07: {"rk": True},
        }
        payload = b"\x01" + raw_cbor.encode(request)
        for rep in _cbor_packets(cid, payload):
            _send_report(sock, rep)

        # Wait until the UP wait is actually pending: skip the admission
        # keepalive (status 0x01, sent before the wait starts) and break on
        # the first UPNEEDED keepalive (status 0x02), then cancel.
        while True:
            frame = _recv_report(sock, 10.0)
            fcmd = frame[4]
            if fcmd == _HID_KEEPALIVE:
                if frame[7] == UPNEEDED:
                    break
                continue
            assert fcmd == _HID_KEEPALIVE, f"unexpected frame cmd 0x{fcmd:02x}"
        t_cancel = time.time()
        _send_report(sock, _packet(cid, _HID_CANCEL))

        # The fabricated keepalive-cancel response: one CTAPHID_CBOR frame
        # carrying the single byte 0x2D.
        cancel_resp = _recv_report(sock, 5.0)
        assert frame[0:4] == cancel_resp[0:4], "cancel response for another channel"
        assert cancel_resp[4] == _HID_CBOR, f"expected CBOR cancel status, got 0x{cancel_resp[4]:02x}"
        assert cancel_resp[5] == 0 and cancel_resp[6] == 1, f"bad length {cancel_resp[5:7].hex()}"
        assert cancel_resp[7] == ERR_KEEPALIVE_CANCEL, f"bad status 0x{cancel_resp[7]:02x}"

        # THE RACE WINDOW: write the retry with no settling at all, so it is
        # admitted before the next 10 ms button poll. The probe is
        # authenticatorGetInfo: it needs no user presence, so its response
        # can only be ITS OWN info map. On the pre-fix device the retry's
        # queue event is swallowed by the still-blocked old wait (the retry
        # admission cleared cancel_button before the poll observed it), the
        # old wait then times out and its 1-byte 0x2F completion is
        # misdelivered as the retry's answer two seconds later.
        retry_payload = b"\x04"  # authenticatorGetInfo
        _send_report(sock, _packet(cid, _HID_CBOR, retry_payload))

        # The retry must be handled exactly once with its own correctly
        # framed response - never a stale 1-byte frame from the cancelled
        # request, and never silence.
        while True:
            frame = _recv_report(sock, 15.0)
            if frame[4] == _HID_KEEPALIVE:
                continue
            assert frame[4] == _HID_CBOR, f"unexpected frame cmd 0x{frame[4]:02x}"
            break
        rlen = (frame[5] << 8) | frame[6]
        # CTAP2 CBOR response framing: the status byte (0x00 = OK) followed
        # by the response map. The retry's own getInfo map is large; a stale
        # late completion of the cancelled request would be a 1-byte frame.
        assert rlen >= 8, f"retry answered with a {rlen}-byte frame (stale completion, len={rlen})"
        assert frame[7] == 0x00, f"retry status 0x{frame[7]:02x}, expected CTAP2_OK"
        assert frame[8] & 0xE0 == 0xA0, f"retry payload 0x{frame[8]:02x}, expected its own getInfo map"
        assert time.time() - t_cancel < 1.0, "the retry was not answered promptly"
    finally:
        sock.close()
