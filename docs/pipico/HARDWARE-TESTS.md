# Pipico hardware and Mac test checklist (G1, G5–G13)

Status of this document: a checklist for the board owner to run on a real
YD-RP2040 board and a real Mac. **Every item below is NOT_RUN.** No board and
no Mac were attached where the Pipico firmware was built and tested, so
nothing in this document has been executed. The software-level results (build,
gates, host tests, emulation suite) are recorded in `HANDOFF.md`, `BASELINE.md`
and `MANIFEST.md`.

## How to read the statuses

- This mission achieved and evidenced exactly three statuses: **SOURCE
  REVIEWED**, **BUILT** and **AUTOMATED TESTS PASSED** (software level).
- **HARDWARE TESTED, HOST INSTALLED, FLASHED and ACCOUNT ENROLLED are
  NOT_RUN.** Executing a section below is the only way one of them changes;
  until then they stay NOT_RUN, including every item in this checklist.
- A check that produced no observation is recorded as "evidence not found",
  never as "failed".
- The 2 MiB effective flash limit (`PICO_FLASH_SIZE_LIMIT_BYTES=0x200000`) is
  a build-time decision, not evidence of the board's physical flash size.
- The flash is never described as defective.

## Gate map (G0–G13)

G0–G4 are the storage-baseline gates, G5–G6 the presence/FIDO gates; each has
a software-level status already evidenced. G1 and G5–G13 additionally have a
hardware/Mac level, which this checklist defines and which is entirely
NOT_RUN.

| Gate | Covers | Software status now | Hardware/Mac status |
|---|---|---|---|
| G0 | fresh recursive clone of `pipico/integration-v1` gets the exact pinned SDK SHA, clean status | AUTOMATED TESTS PASSED (receipt in `MANIFEST.md`, publication state) | n/a |
| G1 | live clock on the board (125 MHz system, 48 MHz USB) | build-time resolution AUTOMATED TESTS PASSED (clock gate) | **NOT_RUN** |
| G2 | storage layout and marker boot behavior (host flash harness) | AUTOMATED TESTS PASSED (SDK ctest) | n/a |
| G3 | ARM build with post-build gates (clock, image bounds, budget) | AUTOMATED TESTS PASSED | n/a |
| G4 | root host ctest and the storage-locked FIDO guard | AUTOMATED TESTS PASSED | n/a |
| G5 | user presence: BOOT-only UP, no stale touch | AUTOMATED TESTS PASSED (emulation, `tests/pipico/`) | **NOT_RUN** |
| G6 | FIDO regression (upstream python-fido2 suite plus additive tests) | AUTOMATED TESTS PASSED (emulation) | **NOT_RUN** |
| G7 | USB identity on a real host | SOURCE REVIEWED | **NOT_RUN** |
| G8 | companion gestures F13–F16 | AUTOMATED TESTS PASSED (gesture/arbiter host tests) | **NOT_RUN** |
| G9 | companion restraint (busy, quiet, disable) | AUTOMATED TESTS PASSED (host tests) | **NOT_RUN** |
| G10 | real-flash storage lifecycle on a disposable board | SOURCE REVIEWED + host harness | **NOT_RUN** |
| G11 | Mac: install, Shortcuts bindings, action/attention/incident/study | SOURCE REVIEWED + fake-platform tests | **NOT_RUN** (HOST INSTALLED) |
| G12 | Mac: native lock (F16) with permission prerequisites | SOURCE REVIEWED + fake-platform tests | **NOT_RUN** |
| G13 | enrollment and end-to-end use with disposable accounts | SOURCE REVIEWED | **NOT_RUN** (ACCOUNT ENROLLED) |

## Global safety preconditions (apply to every section)

1. **Disposable test credentials and accounts only.** Every account, passkey,
   PIN, OTP slot and credential used with the board must be disposable test
   data you are willing to lose. Never enroll a daily-driver account or a
   production login until G13 has passed on disposable data.
2. **Never flash over real credentials.** Only ever flash a board whose flash
   holds nothing you care about. Firmware updates can reformat or repair
   storage; treat every flash as destructive.
3. **Never cross-flash layouts.** Do not move a board between firmware
   layouts (uncapped 4 MiB, legacy uncapped 2 MiB, this build's
   `yd4m-effective2m-marker-gap-v1`) over existing data: a layout switch is
   re-enrollment, not a migration. See the migration table in `LAYOUT.md`.
4. **Unknown device state is read-only.** If the board is in a state you
   cannot explain (unexpected marker, unknown prior firmware), stop: no
   erase, no reset, no diagnostic or recovery writes. Recovery from a
   fail-closed state is operator-guided only (see `LAYOUT.md`).
5. **Expected USB identity.** The device must enumerate with the product
   string exactly **"Yusoofs Pipico"** (no apostrophe), VID/PID `2e8a:10fe`
   (unchanged from the base firmware; the mission changed only the product
   string). Any other identity is a failed check.
6. Layout ID of this build: `yd4m-effective2m-marker-gap-v1` — code ends
   below `0x100000`, marker sector `[0x100000,0x101000)`, data
   `[0x101000,0x200000)`, `[0x200000,0x400000)` unused (see `LAYOUT.md`).
   This build must never write to `[0x200000,0x400000)`.
7. Flashing, testing and enrolling happen only on the owner's own hardware
   and accounts. Nothing in this mission has touched any device or account.

## Flashing a disposable board (precondition; FLASHED = NOT_RUN)

Every board-side section below assumes this step. It is the only step that
carries the FLASHED status.

1. Build the release UF2 from the pinned tuple: run `scripts/pipico/build.sh`
   in the root repo (pins and prerequisites in `BASELINE.md` and the root
   `README.md`); the build must pass the clock, image-bounds and budget
   gates.
2. Put the board into bootloader mode: hold BOOTSEL while plugging in USB.
3. Copy `pico_fido.uf2` onto the mounted `RPI-RP2` drive (or use
   `picotool load pico_fido.uf2 -fx`), then let the board reboot.
4. Verify with `picotool info` that the device runs, then unplug and replug.
5. Confirm the board enumerates with the expected USB identity (precondition
   5) before continuing.

Pass criterion: the board boots the new firmware and enumerates as
"Yusoofs Pipico". Current status: **FLASHED = NOT_RUN** — no board was
flashed in this mission.

## G1 — live clock (125 MHz system, 48 MHz USB)

What this gate adds on hardware: the build-time clock resolution is already
proven by the clock gate (`SYS_CLK_HZ=125000000`, USB 48 MHz,
`PICO_USE_FASTEST_SUPPORTED_CLOCK=0` — see `check-clock.py`); here the real
board must actually run and enumerate at those clocks.

Preconditions: the disposable board is flashed (above); a test host with a
USB port; optionally a second and third host/OS.

Steps:

1. Confirm the build you flashed passed the clock gate (its output must show
   `SYS_CLK_HZ=125000000` and a `48000000` Hz USB clock; no `SYS_CLK_*`
   override in any TU).
2. Plug the board into the test host and wait 5 s.
3. Run `fido2-token -L` (libfido2) or open `chrome://settings/securityKeys`
   in Chrome — any of these lists the device. (`pipico doctor` is not used
   here: it is not a CTAP client — its optional USB check only reads the
   OS device list and never talks to the authenticator.)
4. Send a CTAPHID ping/getInfo round: `fido2-token -I <device>`, which must
   answer within 2 s.
5. Repeat steps 2–4 on two more cold boots, and once each on a second host
   OS if available.
6. Leave the board idle and connected for 10 minutes, then repeat the getInfo
   round.

Pass criterion (objective): the board enumerates as "Yusoofs Pipico" and
answers the getInfo round within 2 s on every cold boot and after the idle
soak, with no USB disconnect, stall or watchdog reset at any point. A direct
scope measurement of clk_sys is optional (it would require a debug build);
enumeration plus the soak is the pass criterion. Current status: **NOT_RUN**.

## G5 — user presence with the real BOOT button

What this gate adds on hardware: the UP rules proven in emulation
(`tests/pipico/`) must hold with a physical BOOT button and real timing.

Preconditions: flashed disposable board; `fido2-cred`/`fido2-token` from
libfido2 (or a browser + disposable account); no credentials you care about
on the board; the USR button identified on the board silkscreen.

Steps (time each step):

1. Start a makeCredential with `fido2-cred` (or a browser passkey creation)
   for a disposable rpId/user, and do not touch anything. The device must
   wait (its "press to confirm" LED pattern), and the request must fail with
   a user-action timeout after roughly 30 s (the forced wait; a configured
   timeout of 0 still waits). No credential is created.
2. Repeat and press BOOT during the wait. The credential is created.
3. Press and release BOOT while no request is pending, then immediately start
   a makeCredential and do not touch. The earlier press must not authorize
   it: the device still waits for a fresh press (release-before-rearm).
4. Start a makeCredential, press and hold BOOT through its timeout, and let
   the request time out. Start another makeCredential without releasing and
   re-pressing. The held level must not authorize the new request.
5. Start a makeCredential and press the USR (GPIO24) button instead of BOOT.
   The request must not complete: USR never counts as user presence.
6. Start a getAssertion with `up: false` configured in the client (or the
   silent path of your tool): it must return promptly with no wait and no
   touch prompt.
7. With a disposable credential present, run `authenticatorReset`. It must
   wait for a BOOT press and refuse without one (the credential survives).

Pass criterion (objective): every numbered expectation holds; the no-touch
refusals take about the forced wait (~30 s) and never succeed silently; the
silent operation completes in under 2 s without a touch prompt. Current
status: **NOT_RUN**.

## G6 — FIDO regression on the real board

What this gate adds on hardware: the same accept/refuse behavior proven in
emulation, with a real browser and real credential storage.

Preconditions: flashed disposable board; a browser (Chrome or Safari) and a
disposable test account; `fido2-token` for health checks.

Steps:

1. Register a passkey for the disposable account: the browser prompts, the
   device waits, a BOOT press completes the registration.
2. Sign in with the passkey twice; each sign-in requires a fresh BOOT press.
3. Re-register for the same account with a second credential: registration
   requires a touch again and both credentials then assert successfully.
4. Start a registration and let it time out without touching; the account
   gains no credential, and a following registration with a touch works.
5. After the flow, `fido2-token -I` still lists the device (no crash, no
   re-enumeration).

Pass criterion (objective): registrations and sign-ins succeed exactly when
BOOT is pressed, the timeout path creates nothing, and the device stays
enumerated throughout. Compare the accept/refuse matrix with the emulation
receipts in `MANIFEST.md`; any difference is a failed check. Current status:
**NOT_RUN**.

## G7 — USB identity on a real host

Preconditions: flashed disposable board; macOS (`system_profiler`), Linux
(`lsusb`) or Windows (`Device Manager`).

Steps:

1. On macOS run `/usr/sbin/system_profiler SPUSBDataType` and find the
   device; on Linux run `lsusb`.
2. Read back the product string, VID and PID.
3. Check the device exposes its CTAPHID interface: `fido2-token -L` lists it.

Pass criterion (objective): the product string is exactly `Yusoofs Pipico`
(no apostrophe), VID/PID are `2e8a:10fe`, and the device is listed as a CTAP
authenticator. Current status: **NOT_RUN**.

## G8 — companion gestures (F13–F16)

The firmware maps gestures to fixed HID usages (see `src/pipico/gesture.h`):
tap → F13 (`0x68`), double tap → F14 (`0x69`), a 1.5–3 s hold → F15
(`0x6a`), a 3–10 s hold → F16 (`0x6b`); holds of 10 s or more send nothing.

Preconditions: flashed disposable board with the companion enabled
(`PIPICO_COMPANION=ON`, the preset default); a macOS test account where the
on-screen **Keyboard Viewer** is enabled (System Settings > Keyboard > Edit >
Show Keyboard Viewer, or the input-menu flag).

Steps:

1. Open the Keyboard Viewer so pressed keys are visible on screen.
2. Tap the USR button once (a press of roughly 30–500 ms followed by release
   with no second press). The viewer must highlight F13 exactly once.
3. Double-tap (the second press starts within 300 ms of the first release).
   The viewer must highlight F14 exactly once (no F13 first).
4. Hold USR for about 2 s and release. The viewer must highlight F15 once.
5. Hold USR for about 5 s and release. The viewer must highlight F16 once.
6. Hold USR for 11 s or longer and release. No F-key may appear.
7. Tap, then within the window start a long hold instead of releasing
   (tap-then-hold). Nothing may be sent.

Pass criterion (objective): each gesture produces exactly its F-key, exactly
once, at the documented thresholds; ambiguous compounds and holds ≥ 10 s
send nothing. Current status: **NOT_RUN**.

## G9 — companion restraint

What this gate adds on hardware: the companion stays quiet when it must
(see `docs/pipico/COMPANION.md` and `THREAT-MODEL.md`).

Preconditions: flashed disposable board; Keyboard Viewer open (as in G8); a
disposable credential registered so a FIDO touch-wait can be started on
demand.

Steps:

1. Hold USR while plugging in the board (companion disabled for that boot).
   Tap, double-tap and hold gestures must send nothing for the whole boot.
2. Power-cycle normally, then start a makeCredential touch wait. While it is
   pending, tap and double-tap USR: no F-key may be sent, and the BOOT touch
   still completes the request normally afterwards.
3. While the board is typing an OTP challenge-response (if an OTP slot is
   configured), tap USR: the gesture must not interleave into the typed
   output.
4. Observe the status LED during gestures: the companion must not drive it
   (no new LED pattern beyond the upstream ones).

Pass criterion (objective): gestures are silent in every restrained case,
FIDO behavior is unaffected by companion input, and the LED shows no
companion-driven pattern. Current status: **NOT_RUN**.

## G10 — real-flash storage lifecycle (disposable board only)

What this gate adds on hardware: the marker/boot behavior proven by the host
flash harness on real flash, on a board holding nothing valuable.

Preconditions: a disposable board whose flash holds no credentials you care
about; the release UF2; `picotool` for inspection.

Steps:

1. Flash the release UF2 (see the flashing precondition). First boot on a
   blank or previously-used device initializes storage per `LAYOUT.md`.
2. Register one disposable credential (G6 steps).
3. Power-cycle the board 10 times (full unplug each time). After each boot,
   `fido2-token -I` must list the device and the credential must still
   assert.
4. Re-flash the SAME release UF2 over the used device once (an identical
   image, not a layout change), power-cycle, and verify the credential
   survives.
5. If any boot behaves unexpectedly (device missing, credentials gone,
   storage refusing writes), STOP: treat the device as read-only from then
   on (precondition 4) and do not erase or reflash to "fix" it.

Pass criterion (objective): the credential survives all 10 power cycles and
the identical re-flash; every boot enumerates; no wipe, repair prompt or
storage error appears. Current status: **NOT_RUN**.

## G11 — Mac: install, bindings and the F13–F15 handlers

Preconditions: the flashed board; a macOS test account (disposable data
only); Bun 1.4.x; the `pipico` CLI from this repo's `host/` directory.

Steps:

1. Run `pipico install` (real, not `--dry-run`) and check the printed plan
   against `host/README.md`: per-user files only, under `$HOME`, with the
   manifest `~/.config/pipico/installed.json`.
2. Run `pipico install --dry-run` again: it must report nothing new to do
   (idempotent).
3. Bind F13–F16 in Shortcuts exactly as `pipico install` printed (Run Shell
   Script actions calling the absolute wrapper path), one shortcut per key.
4. Tap USR once: the workspace chooser must appear; cancel it (nothing
   opens), then pick a test workspace: exactly its configured opens run.
5. Double-tap: the configured attention URL opens in the browser.
6. Hold 1.5–3 s: a timestamped incident folder appears under the configured
   `notesRoot` with `notes.md`, `evidence/` and `handoff.md`, and the
   monitoring pages open. Nothing else is touched (no SSH, no remote
   commands).
7. Run `pipico study`: exactly the configured study URLs open.
8. Run `pipico uninstall --dry-run` and then `pipico uninstall`: exactly the
   manifest resources disappear; files you created yourself stay.

Pass criterion (objective): every step behaves as `host/README.md`
documents; `uninstall` removes only what `install` created; no handler ever
runs anything from config. This is the step that earns **HOST INSTALLED**
for the Mac. Current status: **NOT_RUN** (nothing was installed on a Mac in
this mission).

## G12 — Mac: the native lock (F16)

What this gate adds on hardware: the F16 native lock on a real Mac,
including its permission prerequisites and denial behavior.

Preconditions (all from `host/README.md`, "Lock permissions"):

- The per-user wrapper is installed (`pipico install`, absolute path) and a
  Shortcuts binding maps F16 to it (G11 steps 1–3).
- One-time macOS grants for the app that hosts pipico (Terminal or the
  Shortcuts runner):
  1. **Automation:** System Settings > Privacy & Security > Automation >
     `<host app>` > System Events → allow.
  2. **Accessibility:** System Settings > Privacy & Security >
     Accessibility → allow the host app.

Steps:

1. With the screen unlocked and permissions granted, press F16 (or run
   `pipico lock`). The session must lock immediately.
2. Note the **existing** "Require password after" value in System Settings >
   Lock Screen (do not change it), unlock, and press F16 again. The session
   must still lock immediately under whatever password-delay setting is
   already in effect: the lock keystroke does not rely on the screensaver
   locking. Optionally repeat on a second test account whose existing
   setting differs. Pipico never changes authentication, screensaver or
   power settings — this gate only observes what is already set.
3. Revoke both permissions (Automation and Accessibility for the host app),
   unlock, and press F16 again. The command must exit nonzero with one clear
   error naming both permission panes, attempt no fallback (no
   screensaver/`ScreenSaverEngine` path), change nothing, and not retry.
4. Confirm `pipico lock` never unlocks a locked session and never changes
   any authentication, screensaver or power setting (it only ever sends the
   one Control-Command-Q keystroke through System Events).

Pass criterion (objective): step 1 and step 2 lock immediately regardless of
the password-delay setting; step 3 exits nonzero with the actionable
permission error, no fallback and no change. Current status: **NOT_RUN**
(real-Mac execution of the lock has never been observed in this mission).

## G13 — enrollment and end-to-end use (disposable accounts)

What this gate adds on hardware: the full ownership loop — enroll, use,
reset, re-enroll — with disposable accounts only.

Preconditions: flashed disposable board; a disposable test account on a
site or service that accepts external security keys; the G5/G6 checks
passed on this board.

Steps:

1. Enroll the board as a passkey for the disposable account (browser
   WebAuthn flow; BOOT press required).
2. Sign in with the passkey twice (each with a BOOT press).
3. Reset the authenticator (`authenticatorReset` via `fido2-token` or the
   browser; BOOT press required), confirm the disposable credential is gone.
4. Re-enroll the same board for a fresh disposable account.

Pass criterion (objective): enrollment succeeds, both sign-ins succeed, the
reset removes the credential, and the re-enrollment succeeds — all with
disposable accounts, all requiring BOOT presses. Only after this step may
**ACCOUNT ENROLLED** be recorded, and only for disposable accounts.
Current status: **NOT_RUN** (no enrollment happened in this mission).

## What this document is not

Nothing here is evidence of hardware, flashing, install or enrollment. The
mission's achieved statuses and their receipts are in `HANDOFF.md`. If you
run these checks, record per-item results with the same vocabulary: a check
with no observation is "evidence not found", never "failed".
