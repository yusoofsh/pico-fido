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

## Known upstream limitation: stale frames after CTAPHID_CANCEL

Status: **SOURCE REVIEWED** against both mission bases and **AUTOMATED TESTS
PASSED** as an observation in this build (raw CTAPHID probe, 2026-10-06).
This is upstream behavior, not a Pipico regression, and the mission code
leaves it unchanged.

When a client cancels a pending CTAP2 request with `CTAPHID_CANCEL` during
an active user-presence wait, the next request **on the same channel**
without a fresh `CTAPHID_INIT` does not read a correctly framed response:

1. The cancel is answered with exactly one fabricated `CTAPHID_CBOR`
   response carrying the single byte `0x2D`
   (`CTAP2_ERR_KEEPALIVE_CANCEL`): the `CTAPHID_CANCEL` branch of
   `src/usb/hid/hid.c` (SDK). That branch also calls `timeout_stop()`.
2. The aborted command's CBOR worker then unwinds (for example
   `CTAP2_ERR_OPERATION_DENIED` from the UP check) and queues its own
   `EV_EXEC_FINISHED`. While no command is running, the response timeout is
   0, and `card_status()` (SDK `src/usb/usb.c`) refuses to drain
   `card_to_usb_q` while its timeout is 0, so the late response is withheld.
3. The next command re-arms the timeout (`usb_send_event(EV_CMD_AVAILABLE)`
   → `timeout_start()`), and `card_status()` then drains the *stale*
   `EV_EXEC_FINISHED` first: the client receives the aborted command's late
   response (observed as a one-byte frame) as the answer to its new request.
   Because the new command's `cbor_process()` zeroes the shared response
   status byte before the stale event is drained, the stale frame is not
   even a valid error status. The new command's own response is withheld
   again (`EV_EXEC_FINISHED` handling calls `timeout_stop()`), so the shift
   cascades until the client resynchronizes.

A python-fido2 client sees `ConnectionFailure: Wrong sequence number` or a
shifted response. A fresh `CTAPHID_INIT` resets the device channel and its
TX ring, which is why the `tests/pipico` helpers (`btn.resync()`) reopen the
connection after every cancel; the upstream suite never exercises cancel on
a reused channel, so it is unaffected.

Why this is judged upstream behavior, not an M2 regression:

- Every frame-emitting path in the mechanism is unchanged upstream code:
  `git diff a26c831..HEAD -- src/usb/hid/hid.c` is empty (the `[0x2D]`
  fabrication, the TX-ring reset and the keepalive rules are upstream), the
  `timeout == 0` gate and the `EV_EXEC_FINISHED`/`timeout_stop()` handling
  in `src/usb/usb.c` are upstream, and the root `src/fido/cbor.c` worker
  differs from `1cd988d` only by the M1 storage-locked gate. The same
  sequence is therefore what the upstream firmware would produce on
  hardware after a cancel during an UP wait.
- The scenario is unreachable on the pre-mission base emulation build
  (pico-fido `1cd988d` + SDK `a26c831`): upstream emulation auto-accepts
  every user-presence wait, because `wait_button_pressed_timeout()` never
  blocks without `PICO_PLATFORM`/`ESP_PLATFORM` and `button_task()` is
  compiled out. Measured on the base emulator: a CTAP2 makeCredential
  returns its full attestation object immediately, with no `UPNEEDED`
  keepalive and no window in which a cancel could race a wait. This holds
  with `FORCE_BUTTON_WAIT=ON` as well (re-built and re-measured): the
  forced wait only changes the timeout value, never the blocking.
- The M2 emulated button adds real waits to the emulation (its purpose), so
  a cancellable wait exists here for the first time. Its cancellation
  semantics intentionally mirror the firmware button state machine
  (`EV_BUTTON_CANCELLED` through the same button queues), which is what
  exposes this upstream firmware behavior in emulation.

The two obvious local "fixes" were evaluated and rejected: removing the
`timeout == 0` gate in `card_status()` delivers the stale frames even
faster (reported by the m2-up-enforcement-ctap-u2f worker), and suppressing
the worker's late response in `src/fido/cbor.c` deadlocks the emulator
(worker and main loop both block in `futex_wait`, reported by the same
worker). Both paths are upstream code; "fixing" them would diverge the
emulation from upstream firmware behavior. The limitation is recorded here
instead, and `tests/pipico` keeps the `btn.resync()` workaround.

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
enforcement, OTP challenge-response, P-256 register/sign/verify
regression) and `tests/test_clock_override.py`
(346 passed, 3 skipped, 1 deselected).
