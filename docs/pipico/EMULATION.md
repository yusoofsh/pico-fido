# Emulation build and the emulated BOOT button (M2)

Status of this document: **AUTOMATED TESTS PASSED** for the behavioral claims
below. They were observed by running `scripts/pipico/run-emu-tests.sh`
(346 passed, 3 skipped, 1 deselected, including
`tests/pipico/test_button_emulation.py`, `tests/pipico/test_up_enforcement.py`,
`tests/pipico/test_otp_challenge.py` and
`tests/pipico/test_p256_regression.py`) and the SDK host tests on
**2026-10-06**. Nothing here is evidence of hardware behavior; the emulated
button does not exist in firmware builds.

## The emulation build

The Pipico test build is configured with:

```sh
cmake -S . -B build -G Ninja -DENABLE_EMULATION=1 -DFORCE_BUTTON_WAIT=ON
```

- `ENABLE_EMULATION=1` replaces USB with TCP transports (CTAPHID on
  127.0.0.1:35962, CCID through pcscd/vpcd) and enables the emulation-only
  code described here. The emulator opens no other ports.
- `FORCE_BUTTON_WAIT=ON` is the Pipico UP policy: operations that require
  user presence wait for a real (or emulated) BOOT press even when the
  configured timeout is 0. The forced set is CTAP2 makeCredential (always,
  even with a valid pinUvAuthParam), getAssertion with up=true or up
  omitted, authenticatorReset, authenticatorSelection, U2F register and
  U2F enforce-and-sign; silent operations (up=false assertions, U2F
  check-only, getInfo, discovery) never wait.
- Standard mbedtls; EdDSA is off.

## The emulated BOOT button

Upstream emulation auto-accepts every user-presence wait. The emulated
button keeps that behavior as the default and adds a controlled mode for
tests that must exercise waiting, pressing, timing out and cancelling.

The control file is selected by an environment variable, set for the
emulator process:

```sh
export PICOKEYS_EMULATION_BUTTON_FILE=/path/to/button.cmd
```

When the variable is unset, the file does not exist, or the file holds
`auto`, user presence is auto-accepted exactly like plain upstream
emulation.

The file holds one command. Rewrite it atomically (write a temporary file,
then rename) to issue a new command. Commands are recognized by the file
modification time and consumed once. The emulator polls the file about every
10 ms while the main loop runs, so allow roughly 50 ms between consecutive
commands; a command written and overwritten inside one poll interval is
never observed.

### Commands

| Command | Meaning |
|---|---|
| `auto` | Upstream auto-accept (default mode). |
| `none` | The user never touches the button. Waits end in a timeout or a cancel. |
| `press` | The simulated user presses during the next wait. The press is delivered only after a wait has started, and it is consumed by exactly one wait. |
| `press-after:<ms>` | A press that happens `<ms>` after this command was written. It is delivered only if a wait is active at that moment; otherwise it is discarded (the no-stale rule: a press that belonged to no request never authorizes a later request). |
| `cancel` | Aborts the active wait (the client sees CTAP2_ERR_OPERATION_DENIED). Discarded when no wait is active. |
| `timeout:<seconds>` | Emulation-only override of the user-presence wait timeout in seconds (see below). |

The file holds one command per write; writing two commands into one file
(for example `none\ntimeout:2`) parses as nothing and is ignored entirely. A
`press-after` command is delivered only if a wait is active when its
deadline passes: the delivery deadline is compared against the time the wait
started, so a deadline that passes while no wait is active is discarded even
when no idle poll observed it (a press that happened before a request never
authorizes that request).

### Timeout override

`button_timeout_seconds()` normally returns the firmware configuration
(`up_btn`). Under emulation it returns, in order:

1. the last parsed `timeout:<seconds>` file command, when one is in force;
2. otherwise the `PICOKEYS_EMULATION_BUTTON_TIMEOUT` environment variable
   (seconds), when set to a positive integer;
3. otherwise 0, the fresh-device default.

The `timeout:0` command restores that default resolution. The wait then
follows the firmware rules for the configured timeout of 0: forced
operations (CTAP2 makeCredential — always, even with a valid
pinUvAuthParam; getAssertion with up=true or up omitted, whatever the
credential's require_button flag says; authenticatorReset;
authenticatorSelection; U2F register; U2F enforce-and-sign) wait about
30 s because the build has `FORCE_BUTTON_WAIT`. A CTAP2 reset with no
configured timeout waits too, like every other forced operation.
Set `timeout:2` (or the environment variable) to make no-touch resets and
other tests finish quickly.

### What waits run through the emulated button

Under `ENABLE_EMULATION` the CTAP2 reset UP wait and the OTP
challenge-response `CHAL_BTN_TRIG` wait go through the emulated button, like
every other user-presence wait. The reset power-on window (a reset refused
within the first 10 s after boot) stays bypassed under emulation, exactly as
upstream. Firmware builds are unchanged: the button emulation lives in
`src/usb/emulation/button_emul.c` (SDK), is compiled only under
`ENABLE_EMULATION`, and no firmware ELF contains it.

Transports served on the main loop (CCID, keyboard HID) run their waits on
the main-loop thread (`emul_button_wait_local`); CTAP2 HID runs its waits on
the CBOR thread and synchronizes with the main loop through the existing
button queues.

The CCID `CHAL_BTN_TRIG` wait is pinned by `tests/pipico/test_otp_challenge.py`:
a HMAC-SHA1 challenge-response slot over CCID is refused with SW `0x6985`
only after the configured timeout when the button is never touched, and
returns the host-computed `HMAC-SHA1(aes_key || uid, challenge)` with one
press (a press is consumed by exactly one challenge-response). In firmware
builds the keyboard-HID variant of this wait is refused instead of blocking
core0 — the decision and its reason are in `THREAT-MODEL.md`
("OTP challenge-response with the button trigger").

### Examples

```sh
# The emulator is started with PICOKEYS_EMULATION_BUTTON_FILE=/run/button.cmd

# Upstream behavior: everything auto-accepts.
printf 'auto\n'      > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# A reset that never completes: the client sees CTAP2_ERR_USER_ACTION_TIMEOUT
# after 2 seconds. One command per write, each write allowed to settle
# (alternatively, export PICOKEYS_EMULATION_BUTTON_TIMEOUT=2 for the
# emulator process before it starts).
printf 'timeout:2\n' > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd
sleep 0.1
printf 'none\n'      > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# Deliver exactly one press into the next wait (for example the reset above).
printf 'press\n'     > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# A press 500 ms after the write, only while a wait is active.
printf 'press-after:500\n' > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# Abort the active wait (CTAP2_ERR_OPERATION_DENIED).
printf 'cancel\n'    > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd
```

## Same-channel CTAPHID_CANCEL leaves the channel usable (fixed)

Status: **SOURCE REVIEWED** and **AUTOMATED TESTS PASSED** in this build
(`tests/pipico/test_cancel_same_channel.py`, raw CTAPHID probe,
2026-10-06).

Upstream behavior (recorded in an earlier revision of this section as an
inherited "known limitation", and reproduced by user-testing round 1): a
client that cancelled a pending CTAP2 request with `CTAPHID_CANCEL` and
then reused the SAME channel without a fresh `CTAPHID_INIT` read a
malformed one-byte `0x00` frame - the aborted command's late worker
completion, drained first once the next command re-armed the response
timeout and delivered as the answer to that new request, with its status
byte already zeroed by the new request's `cbor_process()` - while the new
request's own response stayed withheld until a further command re-armed
the timeout. The channel desynchronized until a resync, so `tests/pipico`
carried `btn.resync()` workarounds after every cancel.

Pipico fixes this in the shared SDK transport code (`src/usb/hid/hid.c`,
`src/usb/usb.c` - identical code paths in firmware and emulation builds):

1. The `CTAPHID_CANCEL` branch still answers with exactly one fabricated
   `CTAPHID_CBOR` response carrying the single byte `0x2D`
   (`CTAPHID_KEEPALIVE_CANCEL_STATUS`), resets the TX ring and stops the
   response timeout. It now also marks the cancelled transaction
   (`exec_finished_cancelled` in `src/usb/usb.h`).
2. When the aborted command's CBOR worker unwinds, it still completes the
   queue handshake by queueing its late `EV_EXEC_FINISHED`. `card_status()`
   consumes that marked event and drops it: no frame is written for it,
   and the timeout state is left untouched, so the next request re-arms
   the timeout normally and receives its own completion.
3. `card_exit()` (a fresh `CTAPHID_INIT`, or a transport switch) clears
   the marker together with the drained queues.

Observed on one channel with no resync (raw CTAPHID probe): the cancel is
answered with exactly one `CTAPHID_CBOR len=1 payload=2d`; a following
no-touch makeCredential runs its wait and returns a correctly framed
one-byte `0x27`/`0x2F` error; a following pressed makeCredential returns
one full attestation; a following getInfo returns its own correctly
sequenced response. The CTAP1 (CTAPHID MSG) and CCID paths are untouched:
their cancels neither fabricate a response nor stop the timeout, and
their completion frames flow as before. `btn.resync()` stays available
for legitimate reconnects (for example module-boundary hygiene), but no
test needs it after a cancel any more.

## Running the tests

```sh
pcscd -f --disable-polkit &          # CCID transport (once)
cmake -S . -B build -G Ninja -DENABLE_EMULATION=1 -DFORCE_BUTTON_WAIT=ON
ninja -C build
scripts/pipico/run-emu-tests.sh
```

`run-emu-tests.sh` honours `PIPICO_EMULATOR`, `PIPICO_EMU_RUN_DIR` and
`PYTEST`, starts the emulator with a fresh `memory.flash` in the run
directory (with `PICOKEYS_EMULATION_BUTTON_FILE` exported for it), runs
`pytest tests` from the repository root with only the known vault
deselection, and stops the emulator. Expected baseline: 306 passed, 3
skipped upstream plus the `tests/pipico` modules (button emulation, UP
enforcement, same-channel cancel regression, OTP challenge-response,
P-256 register/sign/verify regression) and `tests/test_clock_override.py`
(347 passed, 3 skipped, 1 deselected).
