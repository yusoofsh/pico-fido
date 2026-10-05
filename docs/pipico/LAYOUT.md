# Flash layout: `yd4m-effective2m-marker-gap-v1`

Status: **SOURCE REVIEWED**. The layout constants are code in
`pico-keys-sdk/src/fs/flash_layout.{c,h}` at
`4ca0d2a40b565ac08e823328dac7f1b810c4ae73` (the pushed SDK tip; the files are
unchanged since the review commit `9256c2b`); the build numbers below were
printed by the image-bounds gate during this session's ARM build
(AUTOMATED TESTS PASSED). No hardware observation is behind this document.

The layout ID identifies the on-flash arrangement on this build. It is
recorded here and in `MANIFEST.md`; it is **not** a firmware field. The
firmware computes the layout at boot from the JEDEC ID, the build-time
`PICO_FLASH_SIZE_BYTES` and `PICO_FLASH_SIZE_LIMIT_BYTES`.

## Ranges (offsets from XIP_BASE, end exclusive)

| Offset range | Size | Use |
|---|---|---|
| `[0x000000, 0x100000)` | 1,024 KiB | **Code.** Every ELF PT_LOAD segment with a flash LMA (including the `.data` LMA), every UF2 block target, and the 4 KiB-sector-rounded erase footprint must end at or below `0x100000`. |
| `[0x100000, 0x101000)` | 4 KiB | **Physical marker sector.** `__phymarker_start` is a C *variable* holding `0x10100000` (absolute XIP address). Use its VALUE, never `&__phymarker_start`. |
| `[0x101000, 0x200000)` | 1,020 KiB | **SDK broad data region.** This is NOT the net credential capacity: records grow down from the end of the region, and the journal keeps up to 7 sectors below the lowest record. |
| `[0x200000, 0x400000)` | 2,048 KiB | **Unused by this build.** NOT free space for the companion. |

Absolute (XIP) addresses for a chip that reports at least the capped size:
marker sector `[0x10100000, 0x10101000)`; data region
`[0x10101000, 0x10200000)`. The capped data region is asserted by the
`low_flash_capped4m_test` harness variant (passed in this session's ctest
run; see `MANIFEST.md`).

Observed image numbers (ARM build at the SHAs above, bounds-gate report):
image write end `0x10084b00` (offset `0x84b00`), erase footprint end
`0x10085000` (offset `0x85000`), headroom `0x7b500` bytes below the
`0x100000` limit. The end address varies slightly with the build path; the
gate enforces the limit on every build.

## How the firmware picks the layout (RP2040 boot order)

1. JEDEC ID read (`0x9F`). The capacity byte is validated **before any
   shift**; the accepted exponent window is 2^16..2^24
   (`FLASH_LAYOUT_JEDEC_EXP_MIN/MAX` in `flash_layout.h`). An abnormal byte
   is never read as a large capacity.
2. `compute_layout`: clamp to the build-time `PICO_FLASH_SIZE_BYTES`; apply
   `PICO_FLASH_SIZE_LIMIT_BYTES` only when defined, positive,
   sector-aligned and not larger than the clamped capacity; the RP2040 data
   region is the upper half of the effective size; in capped builds only,
   move the data start above the marker sector; require `start < end`,
   sector alignment and at least `FLASH_LAYOUT_MIN_DATA_SECTORS` (12) sectors
   of pool + journal headroom. Every failure mode returns an explicit error
   code; the boot stage then sets **storage-locked** (flash writers refuse
   every write; nothing is wiped).
3. Marker stage: classify the sector, then at most one erase plus one
   256-byte full-page program and a readback compare. If the marker sector
   lies beyond the chip (for example a 1 MiB chip), all marker handling is
   skipped (`marker_skipped`); nothing is written outside the chip.
4. `flash_set_bounds` last, only after all checks pass.

## Marker sector classes (`classify_marker_sector`)

| Class | Content | Boot behaviour |
|---|---|---|
| BLANK | all `0xFF` | program one full 256-byte page, read back and compare |
| VALID | magic `0x5049434F4B455953` ("PICOKEYS"), version 1, CRC-32 over the first 20 bytes, UID matching the board, remainder `0xFF` | zero writes |
| LEGACY_TRUNCATED | exactly the bytes `53 59 45 4B`, then `0xFF` to the end of the sector | erase the sector, program one full page, read back |
| FOREIGN | anything else | no erase, no program; **storage-locked** (fail closed) |

The marker format is the unchanged v1 format (24-byte packed
`flash_marker_t`, static-asserted; CRC-32, polynomial `0xEDB88320`, via the
existing SDK `crc32c()` algorithm). Changing the CRC or the format would be
a layout break, not a fix.

## Forbidden migrations

Cross-flashing any of these layouts over real credentials is **forbidden**
without an explicit migration procedure (none exists in V1):

| Existing layout | Target layout | Why it is forbidden over real credentials |
|---|---|---|
| uncapped 4 MiB | effective-2 MiB (`yd4m-effective2m-marker-gap-v1`) | the data region moves; records written above the new data end are orphaned |
| legacy uncapped 2 MiB | effective-2 MiB (`yd4m-effective2m-marker-gap-v1`) | the marker sector and the data start both move; the marker would read as foreign or blank and the records would not be found where expected |
| effective-2 MiB (`yd4m-effective2m-marker-gap-v1`) | uncapped 4 MiB | the data region moves; the old records are not where the new layout looks |

Rules:

- A layout switch on a device holding real credentials is **re-enrollment,
  not a migration**. V1 ships no migration path.
- Unknown device state means read-only: no flash, no reset, no diagnostic
  writes.
- An invalid nonblank marker means fail closed (storage-locked), with
  operator-guided recovery only. The firmware never erases on its own.
- The companion has no partition in this layout and makes no flash writes.

## Storage-locked behaviour (application gate)

When the boot layout/marker stages leave the device **storage-locked**
(bad layout, foreign marker, or any fail-closed path), the storage layer
already refuses every write (`PICOKEYS_ERR_BLOCKED`) and the boot scan is
skipped, so the auth-token files were never read and the device keys are
absent. To keep handlers from running against that half-initialised state
(they would fault on the NULL token keys, or report false success after a
refused write), pico-fido checks one central gate,
`fido_storage_locked_reject()` in `src/fido/fido.c`, at every application
entry point **before any handler runs**:

| Entry point | While locked | Allowed (discovery) requests |
|---|---|---|
| `cbor_parse` (CTAP2 dispatch, both the CTAPHID and the CCID/APDU transport) | `CTAP1_ERR_OTHER` (`0x7F`) | `getInfo` only (first payload byte `CTAP_GET_INFO`); it omits the encrypted dev-state fields (`0x19`/`0x1E`) so it answers without crypto or storage |
| `fido_process_apdu` (CTAP1/CTAP2 APDU entry, CCID) | SW `0x6A84` | `VERSION` and CTAP2 `getInfo` (INS `0x10` with first payload byte `CTAP_GET_INFO`); other CTAP2 payloads are refused here and again in `cbor_parse` |
| `u2f_process_apdu` (FIDO/U2F) | SW `0x6A84` | `VERSION` only |
| `oath_process_apdu` (OATH) | SW `0x6A84` | none (non-SELECT commands; SELECT is answered centrally in the SDK) |
| `otp_process_apdu` (OTP/keyboard) | SW `0x6A84` | none |

CTAPHID `INIT`/`PING`/`WINK`/`CANCEL` and app `SELECT` are handled before
these entry points (transport/handler layers in the SDK) and still answer.

Defense in depth: if a locked write ever slips through, `clientPIN`
`setPIN`/`changePIN` propagate the `file_put_data` failure
(`PICOKEYS_ERR_BLOCKED` → `CTAP2_ERR_NOT_ALLOWED`) instead of reporting
success and skipping the commit. The changePIN propagation is covered by an
injected write-failure regression (an emulation-only hook on the new-PIN
verifier write in the test below, so the seam is portable and never relies
on GNU linker `--wrap`), together with successful unlocked changePIN
controls.

The gate is a plain runtime check (`low_flash_storage_locked()`): builds
without the storage-locked state are unaffected, and the regression test
`tests/fido_storage_locked_test.c` (emulation build, `ctest` case
`fido_storage_locked_test`) drives the real dispatcher while forced-locked
and unlocked and asserts the table above plus zero flash writes.
