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
import threading
import time

import pytest
from fido2.ctap import CtapError

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
