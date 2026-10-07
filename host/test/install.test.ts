/**
 * install (VAL-HOST-033, 034, 035, 036, 037): --dry-run changes nothing and
 * lists exact changes; the real form writes only under $HOME, records a
 * manifest of exactly the created resources, never overwrites, and is
 * idempotent. Binding instructions name F13-F16 with absolute executables.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { validateConfig } from '../src/config.ts';
import {
  configBaseFor,
  planInstall,
  runInstallCommand,
  shQuote,
  type InstallRuntime,
} from '../src/install.ts';
import { manifestPathFor } from '../src/manifest.ts';
import { fakeEnv, makeTempHome, snapshotDir } from './helpers.ts';

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

/** Fixed runtime so the generated wrapper content is deterministic in tests. */
const RUNTIME: InstallRuntime = { bunPath: '/opt/bun/bin/bun', cliPath: '/opt/pipico/host/src/cli.ts' };

function ioCapture(): { io: { out(l: string): void; err(l: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function sha256(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

const freshEnv = (home: string): Record<string, string | undefined> => ({ HOME: home });

describe('install --dry-run (VAL-HOST-033)', () => {
  it('exits 0, lists every planned create with an absolute path under HOME, and changes nothing', async () => {
    const home = newHome();
    const before = snapshotDir(home);
    const r = await runCli(['install', '--dry-run'], freshEnv(home));
    expect(r.code).toBe(0);
    for (const rel of ['.config', '.config/pipico', '.config/pipico/config.json', '.local', '.local/bin', '.local/bin/pipico']) {
      expect(r.stdout).toContain(join(home, rel));
    }
    expect(r.stdout).toContain(manifestPathFor(join(home, '.config')));
    expect(r.stdout).toContain('dry run');
    expect(snapshotDir(home)).toBe(before);
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  it('also exits 0 with nothing written on the real (non-fake) Linux platform', async () => {
    const home = newHome();
    const before = snapshotDir(home);
    const r = await runCli(['install', '--dry-run'], { HOME: home }); // no PIPICO_PLATFORM
    expect(r.code).toBe(0);
    expect(snapshotDir(home)).toBe(before);
  });

  it('reports existing files as kept and still changes nothing', async () => {
    const home = newHome();
    mkdirSync(join(home, '.config', 'pipico'), { recursive: true });
    writeFileSync(join(home, '.config', 'pipico', 'config.json'), 'USER-CONFIG\n');
    const before = snapshotDir(home);
    const r = await runCli(['install', '--dry-run'], freshEnv(home));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('exists');
    expect(r.stdout).not.toContain(`would create file ${join(home, '.config', 'pipico', 'config.json')}`);
    expect(snapshotDir(home)).toBe(before);
  });

  it('prints the F13-F16 Shortcuts bindings with the absolute executable path (VAL-HOST-034)', async () => {
    const home = newHome();
    const r = await runCli(['install', '--dry-run'], freshEnv(home));
    const exe = join(home, '.local/bin/pipico');
    expect(exe.startsWith('/')).toBe(true);
    expect(r.stdout).toContain('manually');
    expect(r.stdout).toContain('F13');
    for (const [key, command] of [['F13', 'action'], ['F14', 'attention'], ['F15', 'incident'], ['F16', 'lock']]) {
      expect(r.stdout).toContain(`${key}`);
      expect(r.stdout).toContain(`${exe} ${command}`);
    }
    expect(r.stdout).not.toContain('~');
  });
});

describe('real install (VAL-HOST-035, 036, 037)', () => {
  it('writes only under HOME: config skeleton, executable wrapper, and a manifest of exactly those resources', async () => {
    const home = newHome();
    const before = snapshotDir(home);
    const { io, out } = ioCapture();
    const code = await runInstallCommand(false, freshEnv(home), io, RUNTIME);
    expect(code).toBe(0);

    // Every planned path exists; the snapshot diff is exactly the planned
    // resources plus the manifest itself.
    const created = [
      join(home, '.config'),
      join(home, '.config/pipico'),
      join(home, '.config/pipico/config.json'),
      join(home, '.local'),
      join(home, '.local/bin'),
      join(home, '.local/bin/pipico'),
    ];
    for (const p of created) expect(existsSync(p)).toBe(true);
    const after = snapshotDir(home);
    const newPaths = after.split('\n').filter((l) => !before.split('\n').includes(l));
    expect(newPaths.length).toBe(created.length + 1); // + installed.json

    // The manifest lists exactly the created resources (not itself).
    const manifestPath = manifestPathFor(join(home, '.config'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.pipicoManifest).toBe(1);
    expect(typeof manifest.createdAt).toBe('string');
    const listed: string[] = manifest.resources.map((e: { path: string }) => e.path);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(new Set(created));
    expect(listed).not.toContain(manifestPath);

    // File entries record the content hash and mode.
    for (const e of manifest.resources) {
      if (e.type === 'file') {
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(e.sha256).toBe(sha256(readFileSync(e.path)));
      }
    }

    // The wrapper is executable and runs the pinned bun + cli.ts only.
    const wrapper = join(home, '.local/bin/pipico');
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    expect(readFileSync(wrapper, 'utf8')).toContain(`exec ${shQuote(RUNTIME.bunPath)} ${shQuote(RUNTIME.cliPath)} "$@"`);

    // The skeleton is a valid config by the strict schema.
    const skeleton = JSON.parse(readFileSync(join(home, '.config/pipico/config.json'), 'utf8'));
    expect(validateConfig(skeleton)).toBeDefined();

    // Binding instructions with absolute paths are printed by a real install too.
    expect(out.join('\n')).toContain(`${join(home, '.local/bin/pipico')} action`);
  });

  it('never overwrites an existing config.json or wrapper, skips them, and does not list them (VAL-HOST-036)', async () => {
    const home = newHome();
    const userConfig = join(home, '.config/pipico/config.json');
    const userScript = join(home, '.local/bin/pipico');
    mkdirSync(join(home, '.config/pipico'), { recursive: true });
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(userConfig, 'USER-CONFIG\n');
    writeFileSync(userScript, 'USER-SCRIPT\n');

    const { io, out } = ioCapture();
    const code = await runInstallCommand(false, freshEnv(home), io, RUNTIME);
    expect(code).toBe(0);
    expect(readFileSync(userConfig, 'utf8')).toBe('USER-CONFIG\n');
    expect(readFileSync(userScript, 'utf8')).toBe('USER-SCRIPT\n');
    expect(out.join('\n')).toContain(userConfig);
    expect(out.join('\n')).toContain(userScript);

    const manifest = JSON.parse(readFileSync(manifestPathFor(join(home, '.config')), 'utf8'));
    const listed: string[] = manifest.resources.map((e: { path: string }) => e.path);
    expect(listed).not.toContain(userConfig);
    expect(listed).not.toContain(userScript);
  });

  it('is idempotent: a second run changes nothing and leaves the manifest untouched (VAL-HOST-037)', async () => {
    const home = newHome();
    const first = ioCapture();
    expect(await runInstallCommand(false, freshEnv(home), first.io, RUNTIME)).toBe(0);
    const manifestPath = manifestPathFor(join(home, '.config'));
    const snapshotAfterFirst = snapshotDir(home);
    const manifestAfterFirst = readFileSync(manifestPath, 'utf8');

    const second = ioCapture();
    expect(await runInstallCommand(false, freshEnv(home), second.io, RUNTIME)).toBe(0);
    expect(snapshotDir(home)).toBe(snapshotAfterFirst);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestAfterFirst);
  });

  it('with HOME unset exits 1 with a clean error and no stack trace', async () => {
    const { io, err } = ioCapture();
    const code = await runInstallCommand(false, {}, io, RUNTIME);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('HOME');
    expect(err.join('\n')).not.toMatch(/\bat\s+\S+:\d+/);
  });

  it('planInstall refuses a config base outside HOME (XDG guard)', () => {
    const env = { HOME: '/home/u', XDG_CONFIG_HOME: '/etc/pipico-config' };
    expect(configBaseFor(env).ok).toBe(false);
  });
});

describe('dispatch through runCli', () => {
  it('install exits 0 and writes the files; uninstall then removes them', async () => {
    const home = newHome();
    const r = await runCli(['install'], fakeEnv(home));
    expect(r.code).toBe(0);
    expect(existsSync(join(home, '.local/bin/pipico'))).toBe(true);
    const u = await runCli(['uninstall'], fakeEnv(home));
    expect(u.code).toBe(0);
    expect(existsSync(join(home, '.local/bin/pipico'))).toBe(false);
    expect(existsSync(manifestPathFor(join(home, '.config')))).toBe(false);
  });
});
