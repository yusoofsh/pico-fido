# Pico FIDO
This project transforms your Raspberry Pi Pico or ESP32 microcontroller into an integrated FIDO Passkey, functioning like a standard USB Passkey for authentication.

If you are looking for a OpenPGP + Fido, see: https://github.com/polhenarejos/pico-fido2. Available through [PicoKey App](https://www.picokeys.com/picokeyapp/ "PicoKey App").

## Features
Pico FIDO includes the following features:

- CTAP 2.3 / CTAP 1
- Authenticated passkey export and import through the open-source Pico Vault
- FIDO 2.3 extensions, including UVM, third-party payments, and PIN complexity policy
- WebAuthn
- U2F
- HMAC-Secret extension
- CredProtect extension
- User presence enforcement through physical button
- User verification with PIN
- Discoverable credentials (resident keys)
- Configurable policy to deny creation of resident/discoverable credentials
- Credential expiration and revocation metadata
- Credential management
- ECDSA and EDDSA authentication
- Support for SECP256R1, SECP384R1, SECP521R1, SECP256K1 and Ed25519 curves
- App registration and login
- Device selection
- Support for vendor configuration
- Backup with 24 words
- Secure lock to protect the device from flash dumps
- Permissions support (MC, GA, CM, ACFG, LBW)
- Authenticator configuration
- minPinLength extension
- Self attestation
- Enterprise attestation
- credBlobs extension
- largeBlobKey extension
- Large blobs support (2048 bytes max)
- OATH (based on YKOATH protocol specification)
- TOTP / HOTP
- Yubikey One Time Password
- Challenge-response generation
- Emulated keyboard interface
- Button press generates an OTP that is directly typed
- Yubico Authenticator app compatible
- Yubico YKMAN compatible
- Nitrokey nitropy and nitroapp compatible
- Secure Boot and Secure Lock in RP2350 and ESP32-S3 MCUs
- One Time Programming to store the master key that encrypts all resident keys and seeds.
- Rescue interface to allow recovery of the device if it becomes unresponsive or undetectable.
- LED customization with PicoKey App.

The authenticated credential export and import design is described in Pol
Henarejos, [*Vaulted Passkeys: A Device-Bound Proposal for Authenticated
Credential Export and Import*](https://arxiv.org/abs/2608.13806). The proposal
and implementation notes are also available in
[`docs/vault`](docs/vault/vaulted_passkeys_proposal.md).

All features comply with the specifications. If you encounter unexpected behavior or deviations from the specifications, please open an issue.

## Security Considerations
Microcontrollers RP2350 and ESP32-S3 are designed to support secure environments when Secure Boot is enabled, and optionally, Secure Lock. These features allow a master key encryption key (MKEK) to be stored in a one-time programmable (OTP) memory region, which is inaccessible from outside secure code. This master key is then used to encrypt all private and secret keys on the device, protecting sensitive data from potential flash memory dumps.

**However**, the RP2040 microcontroller lacks this level of security hardware, meaning that it cannot provide the same protection. Data stored on its flash memory, including private or master keys, can be easily accessed or dumped, as encryption of the master key itself is not feasible. Consequently, if an RP2040 device is stolen, any stored private or secret keys may be exposed.

## Yusoofs Pipico V1 (this fork)

This fork carries the **Yusoofs Pipico V1** work: a corrected and pinned
flash-storage baseline (layout ID `yd4m-effective2m-marker-gap-v1`), enforced
BOOT-button user presence, a small USR-button companion that types fixed
F13–F16 keys, the `pipico` host CLI (see [`host/README.md`](host/README.md)),
CI workflows and release evidence. It is built for the VCC-GND YD-RP2040
board. Full documentation: [`docs/pipico/`](docs/pipico/) — start with
[`BASELINE.md`](docs/pipico/BASELINE.md),
[`LAYOUT.md`](docs/pipico/LAYOUT.md),
[`HARDWARE-TESTS.md`](docs/pipico/HARDWARE-TESTS.md) and
[`HANDOFF.md`](docs/pipico/HANDOFF.md).

**Status: SOURCE REVIEWED · BUILT · AUTOMATED TESTS PASSED (software
level). The firmware has NOT been flashed and NOT been hardware-tested
(FLASHED and HARDWARE TESTED are NOT_RUN); the host CLI has not been
installed on a Mac (HOST INSTALLED = NOT_RUN); nothing was enrolled
(ACCOUNT ENROLLED = NOT_RUN).** Never flash this firmware over a device
holding real credentials: flashing can reformat or repair storage and
cross-flashing between layouts is forbidden (see
[`docs/pipico/LAYOUT.md`](docs/pipico/LAYOUT.md)); a layout switch is
re-enrollment, not a migration.

### Build (one command)

Prerequisites and pins: Arm GNU Toolchain 13.2.Rel1
(`arm-none-eabi-gcc 13.2.1 20231009`), Pico SDK 2.3.1 (`079c6f39`, TinyUSB
`86ad6e56`), picotool 2.3.1, CMake + Ninja; the build clones mbedtls 3.6.7
and tinycbor 0.6.1 at configure time (network needed once). The Pipico
preset builds for `PICO_BOARD=vcc-gnd_yd-rp2040_4m` with
`PICO_USE_FASTEST_SUPPORTED_CLOCK=0`, `PICO_FLASH_SIZE_LIMIT_BYTES=0x200000`,
`FORCE_BUTTON_WAIT=ON`, `ENABLE_OATH_APP=ON`, `ENABLE_OTP_APP=ON`; the USB
product string is "Yusoofs Pipico".

```sh
git clone --recurse-submodules -b pipico/integration-v1 https://github.com/yusoofsh/pico-fido
cd pico-fido
PICO_SDK_PATH=/path/to/pico-sdk/2.3.1 scripts/pipico/build.sh
```

`build.sh` honours `PIPICO_BUILD_DIR` (default `build-pipico`), passes extra
arguments through to CMake, exports `compile_commands.json`, and **exits
nonzero on any CMake/compiler warning or failed gate**. Gates: image bounds
(every write below the 2 MiB code limit), clocks (125 MHz system, 48 MHz
USB) and the companion budget (≤ 8 KiB static RAM, ≤ 64 KiB flash).

### Tests

- **SDK host tests**: in `pico-keys-sdk/`, `cmake -S tests -B build-tests -G
  Ninja && ninja -C build-tests && ctest --test-dir build-tests
  --output-on-failure` (configures mbedtls 3.6.7 into `third-party/` first).
- **Root host tests**: configure an emulation build (`cmake -S . -B
  build-emu -G Ninja -DENABLE_EMULATION=1 -DFORCE_BUTTON_WAIT=ON && ninja -C
  build-emu`) and run `ctest --test-dir build-emu --output-on-failure`.
- **Emulation pytest suite** (needs the emulator on TCP 35962/35963 and
  pcscd): `scripts/pipico/run-emu-tests.sh` starts both, runs the upstream
  python-fido2 suite plus `tests/pipico/`, deselecting only the vault test
  that needs CI secrets, and stops everything.
- **Host CLI**: in `host/`, `bun test` and `bunx tsc --noEmit`.

`HARDWARE-TESTS.md` is the checklist for the board and Mac checks (G1,
G5–G13), all of which are NOT_RUN here.

### Companion key bindings

The USR button gestures type fixed keys; bind them on the Mac with Shortcuts
(`pipico install` prints the steps with absolute paths — created manually,
never by the CLI): tap → **F13** → `pipico action`, double tap → **F14** →
`pipico attention`, hold 1.5–3 s → **F15** → `pipico incident`, hold 3–10 s
→ **F16** → `pipico lock`. A hold of 10 s or more sends nothing.

## Download
**If you own an ESP32-S3 board, go to [ESP32 Flasher](https://www.picokeys.com/esp32-flasher/) for flashing your Pico FIDO.**

If you own a Raspberry Pico (RP2040 or RP2350), go to [Download page](https://www.picokeys.com/getting-started/), select your vendor and model and download the proper firmware; or go to [Release page](https://www.github.com/polhenarejos/pico-fido/releases/) and download the UF2 file for your board.

UF2 files are shiped with a VID/PID granted by RaspberryPi (2E8A:10FE). If you plan to use it with OpenSC or similar tools, you should modify Info.plist of CCID driver to add these VID/PID or use the [PicoKey App](https://www.picokeys.com/picokeyapp/ "PicoKey App").

You can use whatever VID/PID for internal purposes, but remember that you are not authorized to distribute the binary with a VID/PID that you do not own.

Note that the [PicoKey App](https://www.picokeys.com/picokeyapp/ "PicoKey App") is the most recommended.

## Build for Raspberry Pico
Before building, ensure you have installed the toolchain for the Pico and that the Pico SDK is properly located on your drive.

```sh
git clone https://github.com/polhenarejos/pico-fido
git submodule update --init --recursive
cd pico-fido
mkdir build
cd build
PICO_SDK_PATH=/path/to/pico-sdk cmake .. -DPICO_BOARD=board_type -DUSB_VID=0x1234 -DUSB_PID=0x5678
make
```
Note that `PICO_BOARD`, `USB_VID` and `USB_PID` are optional. If not provided, `pico` board and VID/PID `FEFF:FCFD` will be used.

Additionally, you can pass the `VIDPID=value` parameter to build the firmware with a known VID/PID. The supported values are:

- `NitroHSM`
- `NitroFIDO2`
- `NitroStart`
- `NitroPro`
- `Nitro3`
- `Yubikey5`
- `YubikeyNeo`
- `YubiHSM`
- `Gnuk`
- `GnuPG`

After running `make`, the binary file `pico_fido.uf2` will be generated. To load this onto your Pico board:

1. Put the Pico board into loading mode by holding the `BOOTSEL` button while plugging it in.
2. Copy the `pico_fido.uf2` file to the new USB mass storage device that appears.
3. Once the file is copied, the Pico mass storage device will automatically disconnect, and the Pico board will reset with the new firmware.
4. A blinking LED will indicate that the device is ready to work.

## Led blink
Pico FIDO uses the led to indicate the current status. Four states are available:
### Press to confirm
The Led is almost on all the time. It goes off for 100 miliseconds every second.

![Press to confirm](https://user-images.githubusercontent.com/55573252/162008917-6a730eac-396c-44cc-890e-802294be30a3.gif)

### Idle mode
In idle mode, the Pico FIDO goes to sleep. It waits for a command and it is awaken by the driver. The Led is almost off all the time. It goes on for 500 milliseconds every second.

![Idle mode](https://user-images.githubusercontent.com/55573252/162008980-d5a5caad-072e-400c-98e3-2c606b4b2af9.gif)

### Active mode
In active mode, the Pico FIDO is awaken and ready to receive a command. It blinks four times in a second.

![Active](https://user-images.githubusercontent.com/55573252/162008997-1ea8cd7e-5384-4893-9dcb-b473153fc375.gif)

### Processing
While processing, the Pico FIDO is busy and cannot receive additional commands until the current is processed. In this state, the Led blinks 20 times in a second.

![Processing](https://user-images.githubusercontent.com/55573252/162009007-df45111e-2473-4a92-97c5-15c3cd19babd.gif)

## Driver

Pico FIDO uses the `HID` driver, which is present in all operating systems. It should be detected by all OS and browser/applications just like normal USB FIDO keys.

## Tests

Tests can be found in the `tests` folder. They are based on [FIDO2 tests](https://github.com/solokeys/fido2-tests "FIDO2 tests") from Solokeys but adapted to the [python-fido2](https://github.com/Yubico/python-fido2 "python-fido2") v1.0 package, which is a major refactor from the previous 0.8 version and includes the latest improvements from CTAP 2.1.

To run all tests, use:

```sh
pytest
```

To run a subset of tests, use the `-k <test>` flag:

```sh
pytest -k test_credprotect
```

## License and Commercial Use

This project is available under two editions:

**Community Edition (FOSS)**
- Released under the GNU Affero General Public License v3 (AGPLv3).
- You are free to study, modify, and run the code, including for internal evaluation.
- If you distribute modified binaries/firmware, OR if you run a modified version of this project as a network-accessible service, you must provide the corresponding source code to the users of that binary or service, as required by AGPLv3.
- No warranty. No SLA. No guaranteed support.

**Enterprise / Commercial Edition**
- Proprietary license for organizations that want to:
  - run this in production with multiple users/devices,
  - integrate it into their own product/appliance,
  - enforce corporate policies (PIN policy, admin/user roles, revocation),
  - deploy it as an internal virtualized / cloud-style service,
  - and *not* be required to publish derivative source code.
- Base package includes:
  - commercial license (no AGPLv3 disclosure obligation for your modifications / integration)
  - onboarding call
  - access to officially signed builds
- Optional / on-demand enterprise components that can be added case-by-case:
  - ability to operate in multi-user / multi-device environments
  - device inventory, traceability and secure revocation/offboarding
  - custom attestation, per-organization device identity / anti-cloning
  - virtualization / internal "HSM or auth backend" service for multiple teams or tenants
  - post-quantum (PQC) key material handling and secure PQC credential storage
  - hierarchical deterministic key derivation (HD wallet–style key trees for per-user / per-tenant keys, firmware signing trees, etc.)
  - cryptographically signed audit trail / tamper-evident logging
  - dual-control / two-person approval for high-risk operations
  - secure key escrow / disaster recovery strategy
  - release-signing / supply-chain hardening toolchain
  - policy-locked hardened mode ("FIPS-style profile")
  - priority security-response SLA
  - white-label demo / pre-sales bundle

Typical licensing models:
- Internal use (single legal entity, including internal private cloud / virtualized deployments).
- OEM / Redistribution / Service (ship in your product OR offer it as a service to third parties).

These options are scoped and priced individually depending on which components you actually need.

For commercial licensing and enterprise features, email pol@henarejos.me
Subject: `ENTERPRISE LICENSE <your company name>`

See `ENTERPRISE.md` for details.

## Credits
Pico FIDO uses the following libraries or portion of code:
- MbedTLS for cryptographic operations.
- TinyUSB for low level USB procedures.
- TinyCBOR for CBOR parsing and formatting.
