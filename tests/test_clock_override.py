#!/usr/bin/env python3
"""Test the actual top-level clock configuration with SDK imports stubbed out.

Host CMake test only: does not build firmware or establish hardware stability.
Run: python3 tests/test_clock_override.py (requires cmake in PATH).
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "CMakeLists.txt").read_text()
# Stop before project()/compiler setup, closing the outer platform conditional.
PREAMBLE = SOURCE[:SOURCE.index("    project(pico_fido C CXX ASM)")] + "endif()\n"

class ClockOverrideTests(unittest.TestCase):
    def test_platform_defaults_and_explicit_overrides(self):
        for platform in ["rp2040", "rp2350-arm-s", "rp2350-riscv", "esp32", "emulation"]:
            for value in [None, "0", "1", "OFF"]:
                with self.subTest(platform=platform, value=value), tempfile.TemporaryDirectory() as tmp:
                    tmp = Path(tmp)
                    (tmp / "pico_sdk_import.cmake").write_text('set(TEST_IMPORTED pico)\n')
                    idf = tmp / "tools/cmake"; idf.mkdir(parents=True)
                    (idf / "project.cmake").write_text('set(TEST_IMPORTED esp)\n')
                    script = tmp / "test.cmake"
                    script.write_text(PREAMBLE + '\nfile(WRITE "${CMAKE_CURRENT_LIST_DIR}/result.txt" '
                                      '"${PICO_USE_FASTEST_SUPPORTED_CLOCK}|${TEST_IMPORTED}")\n')
                    args = ["cmake"]
                    if platform == "esp32":
                        args += ["-DESP_PLATFORM=1"]
                    elif platform == "emulation":
                        args += ["-DENABLE_EMULATION=1"]
                    else:
                        args += ["-DPICO_PLATFORM=" + platform]
                    if value is not None:
                        args += ["-DPICO_USE_FASTEST_SUPPORTED_CLOCK=" + value]
                    args += ["-P", str(script)]
                    env = dict(os.environ, IDF_PATH=str(tmp))
                    result = subprocess.run(args, cwd=tmp, env=env, text=True, capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    clock, imported = (tmp / "result.txt").read_text().split("|")
                    pico = platform not in ("esp32", "emulation")
                    self.assertEqual(clock, value if value is not None else ("1" if pico else ""))
                    self.assertEqual(imported, "pico" if pico else ("esp" if platform == "esp32" else ""))

if __name__ == "__main__":
    unittest.main(verbosity=2)
