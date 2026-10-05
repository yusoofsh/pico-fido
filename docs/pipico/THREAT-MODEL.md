# Threat model (V1, software scope)

Status: **SOURCE REVIEWED**. This document states design boundaries and
their limits. No hardware observation supports it: HARDWARE TESTED, HOST
INSTALLED, FLASHED and ACCOUNT ENROLLED are NOT_RUN in this mission.

## Scope and assets

Software-level claims for the Yusoofs Pipico V1 firmware and its `pipico`
host CLI.

- Assets: FIDO2/U2F/OATH/OTP credentials, PIN and counter state in the SDK
  data region of flash (see `LAYOUT.md`), and the host machine the device is
  plugged into.
- Considered at software level:
  - a remote party or web page that tries to obtain silent credential use
    from the plugged-in device;
  - a buggy or hostile **companion** component inside the same firmware.
- Out of scope: physical attacks, fault injection, firmware extraction,
  side channels, and a compromised host.

## No hardware-security claims

The board is a general-purpose RP2040 microcontroller with an external SPI
flash chip. **No secure element, tamper resistance or certification is
claimed, implied or designed for.** A person with the device in hand and the
means to read the flash can read the firmware image and the flash contents.
Nothing in V1 defends against that.

## User presence

- BOOT (BOOTSEL, sensed through the QSPI chip-select) is the **only**
  user-presence (UP) source.
- **USR (GPIO24) is never UP.** It feeds the F13–F16 companion only. A touch
  on USR can never authorize makeCredential, getAssertion with `up=true`,
  authenticatorReset, authenticatorSelection, U2F register, U2F
  enforce-user-presence-and-sign, or an OTP challenge-response. UP
  enforcement is a M2 deliverable; its detailed rules live in the
  architecture document.
- Silent operations (getAssertion with `up=false`, U2F check-only, getInfo)
  stay silent.

## The companion is a design boundary, not hardware isolation

- The companion (gesture parser, keyboard arbiter, transmitter) runs on
  core0, inside the same firmware image, at the same privilege level, in the
  same address space as the FIDO code. There is no memory separation and no
  privilege separation between them.
- It is a **design boundary**, not isolation: the companion never calls
  credential APIs, never writes flash, never uses core1 and never drives the
  LEDs. That rule is enforced by code review, host tests and the build-time
  budget — not by any hardware mechanism.
- If the companion (or any firmware component) is compromised, it can do
  anything the firmware can do. Nothing in this design prevents that.
- Holding USR at boot turns the companion off for that boot (runtime state
  only; it never touches flash, credentials or the UP policy).

## F13–F16 are forgeable by any keyboard

- F13–F16 reach the host as ordinary HID keyboard usage codes (`0x68`–
  `0x6B`). Any keyboard, HID utility or scripted USB device can send them.
  The device cannot authenticate the sender, and the host cannot tell the
  Pipico companion from any other keyboard. **Do not build anything
  security-relevant on top of F13–F16.**
- Consequence for the host CLI: every handler stays low-risk and local.
  - `action`: opens a workspace the user explicitly chose; it never guesses.
  - `attention`: opens the configured URL.
  - `incident`: creates local notes/scaffolding and opens configured pages;
    no SSH, no remote commands, no history, environment or clipboard access.
  - `study`: opens URLs; it never submits, answers or marks attendance.
  - `lock`: locks the macOS session; it never unlocks and never changes
    authentication settings.
- USB identity — VID/PID, the product string "Yusoofs Pipico", the serial
  mechanism — is **not authentication**. It identifies a device to a human;
  it never proves who sent a key or which key was sent.

## Data at rest and failure posture

- Credentials live in the SDK data region. On any layout or marker anomaly
  the boot stage sets storage-locked: flash writers refuse every write and
  nothing is wiped (fail closed; see `LAYOUT.md`).
- This mission publishes no raw flash dumps and keeps logs and tokens out of
  the repositories.

## Non-goals

- No defence against a compromised host, a malicious OS, or a user who
  approves a bad request.
- No anti-forensics, no secure-element key storage, no tamper evidence, no
  certification claims.
- No claim that the companion improves FIDO security; its only job is
  sending F13–F16.
