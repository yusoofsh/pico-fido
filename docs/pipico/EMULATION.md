# Emulation build and the emulated BOOT button (M2)

Status of this document: **AUTOMATED TESTS PASSED** for the behavioral claims
below. They were observed by running `scripts/pipico/run-emu-tests.sh`
(315 passed, 3 skipped, 1 deselected, including
`tests/pipico/test_button_emulation.py`) and the SDK host tests on
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

### Examples

```sh
# The emulator is started with PICOKEYS_EMULATION_BUTTON_FILE=/run/button.cmd

# Upstream behavior: everything auto-accepts.
printf 'auto\n'      > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# A reset that never completes: the client sees CTAP2_ERR_USER_ACTION_TIMEOUT
# after 2 seconds.
printf 'none\ntimeout:2\n' > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# Deliver exactly one press into the next wait (for example the reset above).
printf 'press\n'     > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# A press 500 ms after the write, only while a wait is active.
printf 'press-after:500\n' > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd

# Abort the active wait (CTAP2_ERR_OPERATION_DENIED).
printf 'cancel\n'    > /run/button.cmd.tmp && mv /run/button.cmd.tmp /run/button.cmd
```

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
skipped upstream plus `tests/pipico/test_button_emulation.py` and
`tests/test_clock_override.py` (315 passed, 3 skipped, 1 deselected).
