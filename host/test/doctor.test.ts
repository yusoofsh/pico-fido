/**
 * doctor (VAL-HOST-031, 032): read-only; prints a check line for config,
 * bun, platform, executable path and bindings guidance; passes on a healthy
 * fake-platform setup after install; exits 3 (config), 4 (platform) or 5
 * (executable missing) on problems; the USB presence check is informational
 * and never crashes or needs root.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { runInstallCommand, type InstallRuntime } from '../src/install.ts';
import { captureIo, fakeEnv, makeTempHome, snapshotDir, writeDefaultConfig } from './helpers.ts';

const RUNTIME: InstallRuntime = { bunPath: '/opt/bun/bin/bun', cliPath: '/opt/pipico/host/src/cli.ts' };

const tempHomes: string[] = [];
afterAll(() => {
  for (const home of tempHomes) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function newHome(): string {
  const home = makeTempHome();
  tempHomes.push(home);
  return home;
}

/** Valid config + fake platform + a completed install. */
async function healthyHome(): Promise<string> {
  const home = newHome();
  writeDefaultConfig(home);
  const { io } = captureIo();
  expect(await runInstallCommand(false, { HOME: home }, io, RUNTIME)).toBe(0);
  return home;
}

describe('doctor healthy path (VAL-HOST-031)', () => {
  it('exits 0 after install, prints every check line, and is read-only', async () => {
    const home = await healthyHome();
    const exe = join(home, '.local/bin/pipico');
    // The fake log points INSIDE home: doctor must not even create it
    // (it must not construct the fake platform, which truncates the log).
    const logPath = join(home, 'fake-platform.log');
    const before = snapshotDir(home);
    const r = await runCli(['doctor'], fakeEnv(home, { PIPICO_FAKE_LOG: logPath }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('config: ok');
    expect(r.stdout).toContain('bun: ok');
    expect(r.stdout).toContain('platform: ok');
    expect(r.stdout).toContain(`executable: ok (${exe})`);
    for (const [key, command] of [['F13', 'action'], ['F14', 'attention'], ['F15', 'incident'], ['F16', 'lock']]) {
      expect(r.stdout).toContain(`bindings: ${key}`);
      expect(r.stdout).toContain(`${exe} ${command}`);
    }
    expect(r.stdout).toMatch(/usb: (found|not found|skipped)/);
    expect(snapshotDir(home)).toBe(before);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('doctor failures (VAL-HOST-032)', () => {
  it('invalid config: exit 3, the failing check is named, HOME unchanged', async () => {
    const home = newHome();
    writeDefaultConfig(home, (c) => { c.extra = 1; });
    const before = snapshotDir(home);
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('config: FAIL');
    expect(r.stderr).toContain('unknown key "extra"');
    expect(snapshotDir(home)).toBe(before);
  });

  it('missing config: exit 3, HOME unchanged', async () => {
    const home = newHome();
    const before = snapshotDir(home);
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('config: FAIL');
    expect(snapshotDir(home)).toBe(before);
  });

  it('real (non-fake) Linux platform: exit 4 with "unsupported platform"', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const before = snapshotDir(home);
    const r = await runCli(['doctor'], { HOME: home });
    expect(r.code).toBe(4);
    expect(r.stdout).toContain('platform: FAIL');
    expect(`${r.stdout}${r.stderr}`).toContain('unsupported platform');
    expect(snapshotDir(home)).toBe(before);
  });

  it('executable missing (install not done): exit 5 naming the path', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const before = snapshotDir(home);
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.code).toBe(5);
    expect(r.stdout).toContain('executable: FAIL');
    expect(r.stdout).toContain(join(home, '.local/bin/pipico'));
    expect(r.stdout).toContain('pipico install');
    expect(snapshotDir(home)).toBe(before);
  });

  it('unknown PIPICO_PLATFORM value: the platform check fails with exit 4', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const r = await runCli(['doctor'], { HOME: home, PIPICO_PLATFORM: 'bogus' });
    expect(r.code).toBe(4);
    expect(r.stdout).toContain('platform: FAIL');
    expect(`${r.stdout}${r.stderr}`).toContain('PIPICO_PLATFORM');
  });

  it('usb: reports not found or skipped on this VM without crashing and without root', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.stdout).toMatch(/usb: (not found|skipped)/);
    // Informational only: the exit code is from the other checks (5 here).
    expect(r.code).toBe(5);
  });
});
