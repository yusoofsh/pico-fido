# Fresh-venv emulation pytest receipt (README validation)

Purpose: validation of the emulation-pytest Python setup documented in the
root `README.md` ("Emulation pytest suite"), executed exactly as
documented there, in a brand-new virtual environment. The mission
environment (`scripts/env.sh`) was **not** sourced, the mission `$PYENV`
was **not** used, and the venv was created with default options (no
system site packages). Date: **2026-10-08** (UTC). This receipt claims
nothing about hardware; HARDWARE TESTED / HOST INSTALLED / FLASHED and
ACCOUNT ENROLLED remain **NOT_RUN**.

## Steps (commands, in order)

1. **Venv**: `python3 -m venv /home/factory-user/work/build-scratch/r2b1-venv`.
   Python `3.12.3` (system `/usr/bin/python3`), pip `24.0`;
   `sys.prefix != sys.base_prefix` verified (isolated from system site
   packages).
2. **CI pins** (the six packages from
   `.github/workflows/pipico.yml`, "Run the emulation python-fido2
   suite"): `…/r2b1-venv/bin/python -m pip install fido2==2.2.1
   pytest==9.1.1 pyscard==2.3.1 pyelftools==0.33 inputimeout==1.0.4
   cryptography==50.0.2` → exit 0 (`tests/conftest.py` imports
   `inputimeout` at load time; the CCID tests need `pyscard`).
3. **Vault enroller** (imported by the vault test module at collection
   time, although the vault test itself is deselected): `…/r2b1-venv/bin/
   python -m pip install "pico-vault-enroller @ git+https://github.com/
   polhenarejos/pico-vault-enroller.git@79b1f1552d8f3824b7b7c81d19c37e7466fcbcc2"`
   → exit 0 (`pico-vault-enroller-2.3`).
4. **TCP transport copy** (from the repo root): `cp tests/docker/fido2/*.py
   "$(.../r2b1-venv/bin/python -c 'import fido2, os; print(os.path.join(
   os.path.dirname(fido2.__file__), "hid"))')"/` → copied `__init__.py`
   and `emulation.py` over the installed `fido2/hid` modules (without
   this, fido2 does not reach the emulator on TCP 35962).
5. **pcscd**: `setsid sudo -n /usr/sbin/pcscd -f --disable-polkit &` →
   PID `351704` (verified with `pgrep -x pcscd`); no socket-activated
   pcscd was active on this host. After the run, stopped by PID
   (`sudo -n kill 351704`; verified gone).
6. **Suite** (from the repo root): `PIPICO_EMULATOR=
   /home/factory-user/work/build/emu/pico_fido
   PIPICO_EMU_RUN_DIR=/home/factory-user/work/build-scratch/r2b1-emu-run
   PYTEST=/home/factory-user/work/build-scratch/r2b1-venv/bin/pytest
   scripts/pipico/run-emu-tests.sh` → exit 0. The script started the
   emulator with a fresh `memory.flash` and stopped it by its PID.

## Result

```
348 passed, 3 skipped, 1 deselected in 292.44s (0:04:52)
```

Exit 0; **0 failed, 0 errors**. Matches the baseline and the CI/prior
receipts: 306 upstream tests plus the Pipico additions, the only
non-passes being the 3 documented skips and the single deselected vault
test (`tests/pico-fido/test_080_vault.py::test_live_export_import_roundtrip`,
which needs CI secrets). The emulator's startup
`Tss2_TctiLdr_Initialize failed` TPM log line is the known harmless noise.

## Environment facts

- **Emulator** (existing local build, not rebuilt in this session):
  `/home/factory-user/work/build/emu/pico_fido`, mtime 2026-10-07 23:33
  UTC (the preceding session's full-gate run on root `ecb5608…` /
  gitlink `e96e502…` built it through the mission's emulation gate),
  SHA-256
  `660c22bebec70e148e72d5b1d692f7985561c0a7613140b3aa7ed4e0a01ae0e9`.
- **Installed versions** (`pip freeze` subset): `cryptography==50.0.2`,
  `fido2==2.2.1`, `inputimeout==1.0.4`, `pyelftools==0.33`,
  `pyscard==2.3.1`, `pytest==9.1.1`, `pico-vault-enroller` @
  `git+https://github.com/polhenarejos/pico-vault-enroller.git@79b1f1552d8f3824b7b7c81d19c37e7466fcbcc2`.
- Scratch (venv, emulator run directory, logs) was created under
  `/home/factory-user/work/build-scratch/` and removed after this
  receipt was written; nothing outside the documented steps was written
  into the repositories.
