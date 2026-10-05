# Flash layout: `yd4m-effective2m-marker-gap-v1`

Status: **SOURCE REVIEWED**. The layout constants are code in
`pico-keys-sdk/src/fs/flash_layout.{c,h}` at
`d0ed4c35bcefb3601ee81eb0b981a15bd87022ef`; the build numbers below were
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
