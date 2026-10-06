"""
Shared helpers for the emulated BOOT button tests (tests/pipico/).

The emulator is driven through the control file named by the environment
variable PICOKEYS_EMULATION_BUTTON_FILE, which scripts/pipico/run-emu-tests.sh
sets for the emulator and for the test modules. See docs/pipico/EMULATION.md
for the exact command semantics. When the variable is missing (an emulator
started without the button control), the file-based tests skip themselves.

Timing notes: the emulator polls the control file about every 10 ms and reads
the current file content, so write_cmd() settles after each rewrite to make
sure every command is observed. A request's user-presence wait becomes active
only after the CTAPHID handshake, so tests synchronize on the first UPNEEDED
keepalive instead of sleeping a fixed delay.
"""

import os
import threading
import time

import pytest
from fido2.ctap import CtapError
from fido2.ctap1 import ApduError

BTN_ENV = "PICOKEYS_EMULATION_BUTTON_FILE"

# CTAP2 error codes and the CTAPHID keepalive status used by the firmware.
ERR_OPERATION_DENIED = 0x27
ERR_KEEPALIVE_CANCEL = 0x2D
ERR_NO_CREDENTIALS = 0x2E
ERR_USER_ACTION_TIMEOUT = 0x2F
UPNEEDED = 0x02

# authenticatorData flag bits (CTAP 2.x flags byte).
FLAG_UP = 0x01
FLAG_UV = 0x04

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


def resync(device):
    """Reopen the HID connection.

    A CTAPHID_CANCEL makes the firmware answer with a fabricated
    keepalive-cancel response while the aborted command may still emit its
    own frames plus pending keepalives; those stale frames desynchronize
    the next call's reassembly. A fresh connection performs a new CTAPHID
    INIT, which resets the device channel (and its TX ring) and starts a
    clean socket.
    """
    from fido2.hid import CtapHidDevice
    from fido2.ctap2 import Ctap2

    dev = next(CtapHidDevice.list_devices(), None)
    assert dev is not None, "no CTAP HID device to resync"
    device.dev = dev
    device.client()._backend.ctap2 = Ctap2(dev)


def run_in_thread(fn):
    """Run fn() on a thread; collect its result or CtapError/ApduError code."""
    outcome = {}

    def wrapper():
        try:
            outcome["res"] = fn()
            outcome["ok"] = True
        except (CtapError, ApduError) as e:
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


def timed(fn, *args, **kwargs):
    t0 = time.time()
    result = fn(*args, **kwargs)
    return time.time() - t0, result
