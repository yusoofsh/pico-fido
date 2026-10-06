"""
Emulated BOOT button tests (ENABLE_EMULATION only).

The emulator is driven through the control file named by the environment
variable PICOKEYS_EMULATION_BUTTON_FILE, which scripts/pipico/run-emu-tests.sh
sets for the emulator and for this module. See docs/pipico/EMULATION.md for
the exact command semantics. When the variable is missing (an emulator started
without the button control), the file-based tests skip themselves; the plain
auto-mode tests still run against any emulator.

Timing notes: the emulator polls the control file about every 10 ms and reads
the current file content, so write_cmd() settles after each rewrite to make
sure every command is observed. A request's user-presence wait becomes active
only after the CTAPHID handshake, so the tests synchronize on the first
UPNEEDED keepalive instead of sleeping a fixed delay.
"""

import os
import threading
import time

import pytest
from fido2.ctap import CtapError

BTN_ENV = "PICOKEYS_EMULATION_BUTTON_FILE"
ERR_OPERATION_DENIED = 0x27
ERR_NO_CREDENTIALS = 0x2E
ERR_KEEPALIVE_CANCEL = 0x2D
ERR_USER_ACTION_TIMEOUT = 0x2F
UPNEEDED = 0x02

# Command settle: comfortably above the emulator's 10 ms control-file poll.
CMD_SETTLE = 0.05


def btn_path():
    path = os.environ.get(BTN_ENV)
    if not path:
        pytest.skip(f"emulator started without {BTN_ENV}")
    return path


def write_cmd(text):
    path = btn_path()
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text + "\n")
    os.replace(tmp, path)  # atomic: exactly one new command by mtime
    time.sleep(CMD_SETTLE)  # let the emulator poll this command before the next


def remove_btn_file():
    try:
        os.remove(btn_path())
    except FileNotFoundError:
        pass


@pytest.fixture(autouse=True)
def auto_button():
    """Every test starts and ends in auto mode with no timeout override."""
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")
    yield
    if os.environ.get(BTN_ENV):
        write_cmd("timeout:0")
        write_cmd("auto")


def ctap2(device):
    return device.client()._backend.ctap2


def do_reset(device, **kwargs):
    return ctap2(device).reset(**kwargs)


def run_in_thread(fn):
    outcome = {}

    def wrapper():
        try:
            fn()
            outcome["ok"] = True
        except CtapError as e:
            outcome["err"] = e.code

    th = threading.Thread(target=wrapper, daemon=True)
    return th, outcome


def wait_for_keepalive(keepalives, deadline_s=5.0):
    """Block until the pending request reports UPNEEDED, proving the
    user-presence wait is active."""
    t0 = time.time()
    while UPNEEDED not in keepalives and time.time() - t0 < deadline_s:
        time.sleep(0.02)
    assert UPNEEDED in keepalives, keepalives


def auto_flow(device):
    """In auto mode every user-presence operation succeeds promptly and never
    reports UPNEEDED."""
    keepalives = []
    dt_mc, mc = timed(device.doMC, rk=True)
    assert dt_mc < 2.0
    cred = mc["res"].attestation_object.auth_data.credential_data.credential_id

    dt_ga, ga = timed(device.doGA, allow_list=[{"id": cred, "type": "public-key"}])
    assert dt_ga < 2.0

    dt_sel, _ = timed(ctap2(device).selection, on_keepalive=keepalives.append)
    assert dt_sel < 2.0
    assert all(s != UPNEEDED for s in keepalives), keepalives

    # U2F register and enforce-and-sign authenticate (CTAP1).
    dt_reg, reg = timed(device.doMC, ctap1=True)
    assert dt_reg < 2.0
    key_handle = reg["res"].attestation_object.auth_data.credential_data.credential_id
    dt_auth, _ = timed(device.doGA, ctap1=True, allow_list=[{"id": key_handle, "type": "public-key"}])
    assert dt_auth < 2.0
    return mc, ga, reg


def timed(fn, *args, **kwargs):
    t0 = time.time()
    result = fn(*args, **kwargs)
    return time.time() - t0, result


def test_auto_mode_without_control_file(device):
    """No control file (fresh run dir, or after it disappears): upstream
    auto-accept, everything succeeds promptly with no UPNEEDED keepalive."""
    remove_btn_file()
    auto_flow(device)


def test_auto_mode_with_auto_command(device):
    """The control file holding `auto` behaves exactly like the unset case,
    and a reset succeeds and wipes the credentials."""
    write_cmd("auto")
    mc, ga, reg = auto_flow(device)

    dt_reset, _ = timed(do_reset, device)
    assert dt_reset < 2.0
    cred = mc["res"].attestation_object.auth_data.credential_data.credential_id

    with pytest.raises(CtapError) as err:
        device.doGA(allow_list=[{"id": cred, "type": "public-key"}])
    assert err.value.code == ERR_NO_CREDENTIALS


def test_press_delivered_once(device):
    """A written press is delivered during the next wait and consumed by
    exactly one wait."""
    write_cmd("none")
    write_cmd("timeout:5")
    write_cmd("press")
    dt, _ = timed(do_reset, device)
    assert dt < 2.0

    # The same command is consumed: the second wait ends in a timeout.
    write_cmd("timeout:2")
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        do_reset(device)
    dt = time.time() - t0
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)
    assert 1.6 <= dt < 4.0


def test_press_after_during_wait(device):
    """press-after:<ms> written while a wait is active is delivered after the
    delay, and the request succeeds."""
    write_cmd("none")
    write_cmd("timeout:10")
    keepalives = []
    th, outcome = run_in_thread(lambda: do_reset(device, on_keepalive=keepalives.append))
    t0 = time.time()
    th.start()
    wait_for_keepalive(keepalives)  # the wait is now active
    write_cmd("press-after:500")
    th.join(timeout=10)
    dt = time.time() - t0
    assert outcome.get("ok"), outcome
    assert 0.5 <= dt < 5.0


def test_press_after_discarded_when_idle(device):
    """A press-after that fires with no wait active is discarded and never
    authorizes a later request."""
    write_cmd("none")
    write_cmd("timeout:2")
    write_cmd("press-after:100")
    time.sleep(0.5)  # the press fires while idle and is discarded
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        do_reset(device)
    dt = time.time() - t0
    assert err.value.code in (ERR_OPERATION_DENIED, ERR_USER_ACTION_TIMEOUT)
    assert 1.6 <= dt < 4.0


def test_cancel_aborts_the_active_wait(device):
    write_cmd("none")
    write_cmd("timeout:10")
    keepalives = []
    th, outcome = run_in_thread(lambda: do_reset(device, on_keepalive=keepalives.append))
    th.start()
    wait_for_keepalive(keepalives)  # the wait is now active
    write_cmd("cancel")
    th.join(timeout=5)
    assert outcome.get("err") == ERR_OPERATION_DENIED, outcome


def test_cancel_while_idle_is_discarded(device):
    write_cmd("none")
    write_cmd("timeout:2")
    write_cmd("cancel")  # no wait active: discarded
    time.sleep(0.2)
    t0 = time.time()
    with pytest.raises(CtapError) as err:
        do_reset(device)
    dt = time.time() - t0
    assert err.value.code == ERR_USER_ACTION_TIMEOUT  # timed out, not cancelled
    assert 1.6 <= dt < 4.0


def test_long_wait_sends_keepalives_and_cancel_aborts(device):
    """A controlled wait with a long timeout keeps the client informed with
    UPNEEDED keepalives and CTAPHID_CANCEL aborts it. (The timeout:0 default
    resolution and the FORCE_BUTTON_WAIT 0->30 s rule are covered by the SDK
    unit tests; a reset with no override and no configured timeout
    auto-completes, like the firmware with no UP timeout.)"""
    write_cmd("none")
    write_cmd("timeout:30")
    keepalives = []
    th, outcome = run_in_thread(lambda: do_reset(device, on_keepalive=keepalives.append))
    t0 = time.time()
    th.start()
    wait_for_keepalive(keepalives)
    assert not outcome, "the request must still be waiting"
    device.dev._send_cancel()
    th.join(timeout=5)
    assert outcome.get("err") in (ERR_KEEPALIVE_CANCEL, ERR_OPERATION_DENIED), outcome
    assert time.time() - t0 < 10.0
