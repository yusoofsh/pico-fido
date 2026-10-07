# Yusoofs Pipico V1: handoff and gate statuses

Status snapshot written **2026-10-07** by the release docs feature. It states
the mission's gate statuses in the status vocabulary below, with the evidence
for every claim. Numbers in this file were re-verified in the writing session
(`git rev-parse`, `gh run list`, `gh run view --log` greps); the receipts they
come from are in `MANIFEST.md`.

## Status vocabulary (whole mission)

| Status | State | Evidence |
|---|---|---|
| SOURCE REVIEWED | achieved | every mission commit reviewed on `pipico/storage-baseline` / `pipico/companion-hooks` (SDK) and `pipico/integration-v1` (root); docs in `docs/pipico/` cite SHAs, not claims |
| BUILT | achieved | `scripts/pipico/build.sh` exit 0, zero CMake/compiler warnings; root CI run [`37685884106`](https://github.com/yusoofsh/pico-fido/actions/runs/37685884106) (build + gates) green on `b31a8ab969536d754a7737c3ffe12bf7c6e3da5f`; also green on `5833bc2…` (run `37682443999`) and on every later evidence-only head — `5ba8b08…` (run `37687857080`), `aa09cf4…` (run `37690147169`) and the final head's run (see "Final SHAs", definitive runs) — and reproduced in two fresh-clone builds (`docs/pipico/release/`) |
| AUTOMATED TESTS PASSED | achieved | same CI run `37685884106`: SDK ctest 47/47 (run [`37685874677`](https://github.com/yusoofsh/pico-keys-sdk/actions/runs/37685874677) on SDK `654fbda1046c0dba3832ff520f7d1ea25d1df45b`), root host ctest 67/67, emulation pytest 348 passed / 3 skipped / 1 deselected / 0 failed, `bun test` 315 pass / 0 fail, image-bounds self-test 17/17, budget gate OK (RAM delta 20 B ≤ 8192, flash delta 1192 B ≤ 65536); the same counts were re-observed on runs `37687857080` and `37690147169` (final heads: see "Final SHAs"); full commands and counts: `docs/pipico/release/test-receipts.md` |
| HARDWARE TESTED | **NOT_RUN** | no YD-RP2040 board attached; the board-side checklist lives in `HARDWARE-TESTS.md` (G1, G5–G10) |
| HOST INSTALLED | **NOT_RUN** | no Mac attached; the Mac-side checklist lives in `HARDWARE-TESTS.md` (G11, G12); the CLI was exercised only on Linux with the fake platform and a temp `$HOME` |
| FLASHED | **NOT_RUN** | no device writes in this mission; no board was ever flashed |
| ACCOUNT ENROLLED | **NOT_RUN** | no account, credential or enrollment was touched; `HARDWARE-TESTS.md` G13 is the (disposable-credentials) procedure |

## Gate statuses (G0–G13, same vocabulary)

The gate definitions are in `HARDWARE-TESTS.md` ("Gate map"). Software levels
are evidenced; hardware/Mac levels are NOT_RUN. The receipts cited below come
from CI run `37682443999` (source `5833bc2…`); the later run `37685884106`
(source `b31a8ab…`, the release-evidence built SHA) concluded success with
the same counts (its artifact receipts were downloaded and checked), so the
software levels stand on the final tuple too.

| Gate | Software level | Evidence | Hardware/Mac level |
|---|---|---|---|
| G0 fresh recursive clone gets the exact pinned SDK SHA | AUTOMATED TESTS PASSED | G0 clone checks recorded in `MANIFEST.md` publication state (M1, re-verified at the merged head `adbab28`) | n/a |
| G1 live clock (125 MHz sys / 48 MHz USB) | AUTOMATED TESTS PASSED (build-time resolution; clock gate, every TU carries the cap and `FORCE_BUTTON_WAIT`) | clock-gate receipts in `MANIFEST.md`; CI run `37682443999` | **NOT_RUN** |
| G2 storage layout + marker boot behavior | AUTOMATED TESTS PASSED | SDK ctest 47/47 (flash_layout unit tests + `low_flash_*` harness variants), CI run `37615375963` | n/a (real-flash level is G10) |
| G3 ARM build + post-build gates | AUTOMATED TESTS PASSED | CI run `37682443999`: bounds + self-test 17/17, clock PASS, budget OK (RAM +20 B, flash +1192 B) | n/a |
| G4 root host ctest + storage-locked guard | AUTOMATED TESTS PASSED | root host ctest 67/67, CI run `37682443999` | n/a |
| G5 user presence (BOOT-only UP, no stale touch) | AUTOMATED TESTS PASSED (emulation: `tests/pipico/` UP matrix) | pytest 348 passed / 3 skipped / 1 deselected / 0 failed, CI run `37682443999` | **NOT_RUN** |
| G6 FIDO regression | AUTOMATED TESTS PASSED (upstream python-fido2 suite + additive tests) | same receipts as G5 | **NOT_RUN** |
| G7 USB identity on a real host | SOURCE REVIEWED | `strings` of the built ELF contains `Yusoofs Pipico`; VID/PID unchanged (below) | **NOT_RUN** |
| G8 companion gestures F13–F16 | AUTOMATED TESTS PASSED | gesture parser + arbiter host tests (inside the 67/67 root ctest) | **NOT_RUN** |
| G9 companion restraint | AUTOMATED TESTS PASSED | arbiter/glue host tests (same ctest receipt); `COMPANION.md` | **NOT_RUN** |
| G10 real-flash storage lifecycle | SOURCE REVIEWED + host flash harness (AUTOMATED TESTS PASSED at SDK ctest level) | SDK ctest receipts | **NOT_RUN** |
| G11 Mac install/bindings/handlers | SOURCE REVIEWED + fake-platform tests (AUTOMATED TESTS PASSED: `bun test` 315 pass / 0 fail) | CI run `37682443999` | **NOT_RUN** (HOST INSTALLED) |
| G12 Mac native lock (F16) | SOURCE REVIEWED + fake-platform tests | same `bun test` receipt | **NOT_RUN** |
| G13 enrollment end-to-end | SOURCE REVIEWED | `HARDWARE-TESTS.md` G13 | **NOT_RUN** (ACCOUNT ENROLLED) |

## Final SHAs, PRs and publication state

- **Root built SHA** (all build inputs, the SHA the release evidence was
  built from): `b31a8ab969536d754a7737c3ffe12bf7c6e3da5f` — CI run
  `37685884106` was green on it. The commits after it on the branch are
  **evidence-only**, named explicitly: `6499200` + `5ba8b08` (the
  release-evidence docs bundle), `6def65d` ("ci: upload pico_fido.bin",
  an artifact-collection-only workflow change), `aa09cf4` (the
  `MANIFEST.md` push-receipt row) and this documentation commit —
  `git log b31a8ab..HEAD` enumerates them exactly. Each touches only
  `docs/` or the artifact-collection lines of
  `.github/workflows/pipico.yml`: **no build input changes** (observed
  directly: the CI artifacts of runs `37682443999` (source `5833bc2`),
  `37685884106` (`b31a8ab`), `37687857080` (`5ba8b08`) and `37690147169`
  (`aa09cf4`) were downloaded and re-hashed in the handoff session —
  `uf2`/`elf` are byte-identical across all four; the `bin` file was not
  uploaded before run `37690147169` (its hash was recorded in each
  artifact's `manifest.txt` only) and the downloaded `bin` of run
  `37690147169` hashes exactly to that recorded value). The definitive root head is the branch tip; its
  green run and push receipt are recorded in the mission publication
  record (a commit cannot contain the run id of its own push).
- **SDK SHA**: `654fbda1046c0dba3832ff520f7d1ea25d1df45b` (head of
  `pipico/companion-hooks`, CI run `37685874677` green on it; a README-only
  commit on top of `3201dbd0e6972a97510c08d21d1386de130c62e2`); the root
  gitlink points there, and the fresh-clone builds resolved exactly it.
  `pipico/storage-baseline` remains a separate remote branch at
  `a1eb8cf541bae2575985e1b18fb97ced670193bb`; it is an **ancestor** of
  the tested `pipico/companion-hooks` head (`git merge-base
  --is-ancestor` verified) and its own head also has a successful run
  ([`37562735185`](https://github.com/yusoofsh/pico-keys-sdk/actions/runs/37562735185)).
- **Draft PR URLs** (created 2026-10-07, both **draft**, both into the
  fork's own `main`, **never merged, never marked ready**):
  - pico-fido: <https://github.com/yusoofsh/pico-fido/pull/1>
    (`pipico/integration-v1` → `main`)
  - pico-keys-sdk: <https://github.com/yusoofsh/pico-keys-sdk/pull/1>
    (`pipico/companion-hooks` → `main`)
  Each PR's `headRefOid` equals the remote branch head at handoff (the
  PR head tracks the branch), and each body describes everything the
  branch adds relative to `main`, with the status vocabulary and the
  four NOT_RUN items.
- **Upstream PRs**: the mission opened none. `gh pr list --author @me`
  against the upstream `polhenarejos/*` repos lists the user's own
  pre-existing PRs (pico-fido
  [#295](https://github.com/polhenarejos/pico-fido/pull/295), pico-keys-sdk
  [#37](https://github.com/polhenarejos/pico-keys-sdk/pull/37)); both were
  created 2026-10-05T03:59Z, about four hours before the first mission
  commit (`9256c2b`, 2026-10-05T08:03Z), and carry exactly the user's
  `fix/*` patches the mission builds on. The mission's gh identity is the
  user's account, so those queries are not empty — recorded here so the
  distinction is explicit.
- **Publication receipts** (every push of the mission branches, M2–M5, with
  old..new ranges and CI run ids): `MANIFEST.md`, "OBSERVED: push receipts".

## Upstream workflow guards on the fork (scope and limits)

`git diff 1cd988d..5833bc2 -- .github/workflows/{test,nightly,codeql}.yml`
contains exactly one job-level line per file, added by commit `5833bc2`
("ci: guard upstream workflow jobs to the upstream repository"):
`if: github.repository == 'polhenarejos/pico-fido'` on `jobs.build`
(`test.yml`), `jobs.nightly` (`nightly.yml`) and `jobs.analyze`
(`codeql.yml`). Triggers, steps, permissions and `pipico.yml` are unchanged.

Scope and limits, stated plainly:

- The guards live on the **mission branch only**. They do not change the
  fork's `main`, where the three upstream files remain unguarded.
- Today those three workflows are **unregistered with Actions** on
  `yusoofsh/pico-fido` (the workflow API lists only `pipico`; observed
  2026-10-07), so nothing runs from `main`. `gh workflow disable` for each
  returned HTTP 404 ("not found on the default branch") while they stay
  unregistered — attempts recorded 2026-10-07. API disable is therefore
  currently impossible, not "done".
- If they ever register again (an Actions-tab enable or a default-branch
  change), the followup is: `gh workflow disable "Emulation and test"`,
  `gh workflow disable "Nightly deploy"` and `gh workflow disable "CodeQL"`
  against `yusoofsh/pico-fido`, then record the new states. Scheduled
  upstream runs would execute against `main` regardless of any guard
  committed on `pipico/*` branches — **branch edits are never a permanent,
  fork-wide suppression**.
- `yusoofsh/pico-keys-sdk` has no `.github/workflows` on `main` at all; only
  `pipico-sdk-tests.yml` exists, on the `pipico/*` branches (registered,
  active). Nothing to disable there.

## Identity and string consistency

- USB product string **"Yusoofs Pipico"** (no apostrophe): present in the
  built ELF (`strings` on the CI artifact image), set by the compile
  definition `USB_PRODUCT_STRING` in the root `CMakeLists.txt`; the SDK
  default stays "Pico Key" when the define is absent and a phy-config
  override still wins. The host `doctor` USB check searches for exactly this
  string (`host/src/usb.ts`), and every doc uses the same spelling.
- **VID/PID are unchanged from the base tuple**: root `CMakeLists.txt` sets
  `USB_VID 0x2E8A` / `USB_PID 0x10FE` at the base `1cd988d` and identically
  at the mission head (`git show` verified); `git diff a26c831..3201dbd --
  src/usb/usb_descriptors.c` contains no VID/PID change. The serial-number
  mechanism and all credential identity are untouched; the product-string
  change cannot trigger a factory reset.
- Firmware F-key usages match the host binding instructions: tap → F13,
  double tap → F14, 1.5–3 s hold → F15, 3–10 s hold → F16 (firmware
  `src/pipico/gesture.h`, usages `0x68`–`0x6b`); F13 → `pipico action`,
  F14 → `pipico attention`, F15 → `pipico incident`, F16 → `pipico lock` in
  `host/src/bindings.ts`, `host/README.md`, the root `README.md` Pipico
  section and `HARDWARE-TESTS.md`.
- Flash layout ID **`yd4m-effective2m-marker-gap-v1`** for this build: code
  ends below `0x100000`, marker sector `[0x100000,0x101000)`, data
  `[0x101000,0x200000)`, `[0x200000,0x400000)` unused (same values as
  `LAYOUT.md` and the manifest).
- The host CLI never talks to the authenticator: `host/src` contains no
  CTAP/HID/APDU/PCSC code; its only USB interaction is the read-only,
  informational presence check of the product string. See `host/README.md`
  ("doctor") and the isolation notes in `THREAT-MODEL.md`.

## Honesty rules and label usage in this handoff

- Commit-message-only observations are labelled **"reported"** (for example
  the on-hardware legacy marker pattern in `BASELINE.md`, inferred from
  source, never observed on a device).
- An empty CI query is **"evidence not found"**, never "failed" (applied
  above to the PR URLs; no other empty query remains).
- The 2 MiB effective limit is a build-time cap, **not** evidence of the
  board's physical flash size; the flash is nowhere described as defective.
- **Reproducibility**: the two-clean-build comparison was performed
  (2026-10-07, two fresh recursive clones, documented single command) and
  the hashes **differ**: 11 bytes, all characters of the absolute build
  path embedded in error-diagnostic strings (`__FILE__`-style source
  paths); the CI runner path has a different length, so its string
  constants also change size. Both hash sets and the diagnosis are
  recorded in `docs/pipico/release/reproducibility.md`, and **no document
  in `docs/pipico/`, the README or the PR bodies claims a reproducible
  build**.
- The release evidence bundle is delivered: source tuple re-resolved from
  a fresh clone+configure, resolved flags, SHA-256 of the released and
  fresh-clone UF2/ELF/bin, size/write-range report, budget evidence and
  test receipts in `docs/pipico/release/` (`RELEASE-MANIFEST.md` et al.),
  and as the CI artifact `pipico-release-evidence` of the branch's green
  runs (release-evidence source `b31a8ab…`: run `37685884106`; from run
  `37690147169` on head `aa09cf4…` the artifact also contains the actual
  `pico_fido.bin`, whose downloaded hash matches the recorded value).
