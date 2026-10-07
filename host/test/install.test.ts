/**
 * install (VAL-HOST-033, 034, 035, 036, 037): --dry-run changes nothing and
 * lists exact changes; the real form writes only under $HOME, records a
 * manifest of exactly the created resources, never overwrites, and is
 * idempotent. Binding instructions name F13-F16 with absolute executables.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { validateConfig } from '../src/config.ts';
import {
  configBaseFor,
  planInstall,
  realInstallFs,
  reverseClean,
  runInstallCommand,
  shQuote,
  type InstallFsOps,
  type InstallRuntime,
} from '../src/install.ts';
import { manifestPathFor, type ManifestResource } from '../src/manifest.ts';
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

/** A supported nested XDG layout: every ancestor below HOME is missing. */
const nestedEnv = (home: string): Record<string, string | undefined> => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'a/b/config'),
});

const NESTED_ANCESTORS = (home: string): string[] => [
  join(home, 'a'),
  join(home, 'a/b'),
  join(home, 'a/b/config'),
  join(home, 'a/b/config/pipico'),
];

/** The paths in "install: would create …" / "install: created …" output lines. */
function outputPaths(lines: string[]): string[] {
  return lines
    .map((l) => l.match(/^install: (?:would create|created) (?:directory|file) (\S+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]!);
}

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

describe('nested XDG config base (VAL-HOST-033, 035)', () => {
  const nestedManifest = (home: string): string => manifestPathFor(join(home, 'a/b/config'));

  it('--dry-run lists every missing ancestor before its children and changes nothing', async () => {
    const home = newHome();
    const before = snapshotDir(home);
    const r = await runCli(['install', '--dry-run'], nestedEnv(home));
    expect(r.code).toBe(0);

    // Each missing ancestor is explicitly planned, shallowest first, and no
    // step relies on an unlisted recursive mkdir.
    for (const p of NESTED_ANCESTORS(home)) {
      expect(r.stdout).toContain(`would create directory ${p}`);
    }
    const positions = NESTED_ANCESTORS(home).map((p) => r.stdout.indexOf(`would create directory ${p}`));
    expect(positions[0]!).toBeLessThan(positions[1]!);
    expect(positions[1]!).toBeLessThan(positions[2]!);
    expect(positions[2]!).toBeLessThan(positions[3]!);

    // The config, wrapper and manifest paths a real install would create.
    expect(r.stdout).toContain(`would create file ${join(home, 'a/b/config/pipico/config.json')}`);
    expect(r.stdout).toContain(`would create file ${join(home, '.local/bin/pipico')}`);
    expect(r.stdout).toContain(`would create file ${nestedManifest(home)}`);

    expect(snapshotDir(home)).toBe(before);
  });

  it('--dry-run with a pre-existing ancestor keeps it instead of planning to create it', async () => {
    const home = newHome();
    mkdirSync(join(home, 'a'));
    writeFileSync(join(home, 'a/CANARY.txt'), 'CANARY\n');
    const before = snapshotDir(home);
    const r = await runCli(['install', '--dry-run'], nestedEnv(home));
    expect(r.code).toBe(0);
    const kept = r.stdout.split('\n').filter((l) => l === `install: exists, keeping it (never overwritten, not listed in the manifest): ${join(home, 'a')}`);
    expect(kept.length).toBe(1);
    expect(r.stdout.split('\n')).not.toContain(`install: would create directory ${join(home, 'a')}`);
    // The deeper missing ancestors are still planned.
    expect(r.stdout).toContain(`would create directory ${join(home, 'a/b')}`);
    expect(snapshotDir(home)).toBe(before);
  });

  it('real install creates every missing ancestor, records each in the manifest, and matches the dry-run plan', async () => {
    const home = newHome();
    const base = join(home, 'a/b/config');

    const dry = ioCapture();
    expect(await runInstallCommand(true, nestedEnv(home), dry.io, RUNTIME)).toBe(0);
    const planned = outputPaths(dry.out);

    const before = snapshotDir(home);
    const { io, out } = ioCapture();
    const code = await runInstallCommand(false, nestedEnv(home), io, RUNTIME);
    expect(code).toBe(0);

    // The real created set (including the manifest) is exactly the dry-run plan.
    const createdPaths = outputPaths(out);
    expect(new Set(createdPaths)).toEqual(new Set(planned));

    // The snapshot diff is exactly the manifest entries plus the manifest itself.
    const manifestPath = nestedManifest(home);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const listed: string[] = manifest.resources.map((e: { path: string }) => e.path);
    const newPaths = snapshotDir(home).split('\n').filter((l) => !before.split('\n').includes(l));
    expect(newPaths.length).toBe(listed.length + 1);
    expect(new Set(listed)).toEqual(new Set(createdPaths.filter((p) => p !== manifestPath)));

    // Every invocation-created missing ancestor is individually recorded.
    for (const p of NESTED_ANCESTORS(home)) {
      expect(listed).toContain(p);
    }
  });

  it('real install with a pre-existing ancestor succeeds without listing it, and the canary is byte-identical', async () => {
    const home = newHome();
    mkdirSync(join(home, 'a'));
    writeFileSync(join(home, 'a/CANARY.txt'), 'CANARY\n');

    const { io } = ioCapture();
    const code = await runInstallCommand(false, nestedEnv(home), io, RUNTIME);
    expect(code).toBe(0);

    const listed: string[] = JSON.parse(readFileSync(nestedManifest(home), 'utf8')).resources.map(
      (e: { path: string }) => e.path,
    );
    expect(listed).not.toContain(join(home, 'a'));
    expect(listed).not.toContain(join(home, 'a/CANARY.txt'));
    expect(readFileSync(join(home, 'a/CANARY.txt'), 'utf8')).toBe('CANARY\n');
    expect(existsSync(join(home, 'a/b'))).toBe(true);
  });

  it('refuses to install through a symlinked planned directory, creating nothing', async () => {
    const home = newHome();
    const outside = join(tmpdir(), `pipico-symlink-target-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(home, 'a'));
    try {
      const before = snapshotDir(home);
      const { io, err } = ioCapture();
      const code = await runInstallCommand(false, nestedEnv(home), io, RUNTIME);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('symbolic link');
      expect(snapshotDir(home)).toBe(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('planInstall refuses a non-normalized config base (XDG with .. would create unrecorded ancestors)', () => {
    const env = { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/a/../b/config' };
    expect(configBaseFor(env).ok).toBe(false);
  });
});

describe('install failure rollback (VAL-HOST-036)', () => {
  it('ENOTDIR: a regular file at .local/bin fails the wrapper write; created resources are reverse-cleaned and the file is untouched', async () => {
    const home = newHome();
    mkdirSync(join(home, '.local'));
    writeFileSync(join(home, '.local/bin'), 'NOT-A-DIR\n');
    const before = snapshotDir(home);

    const { io, out, err } = ioCapture();
    const code = await runInstallCommand(false, freshEnv(home), io, RUNTIME);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(join(home, '.local/bin/pipico'));
    expect(err.join('\n')).not.toMatch(/\bat\s+\S+:\d+/); // contained error, no stack trace
    expect(out.join('\n')).toContain('rollback');

    // Everything this invocation created is gone...
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.config/pipico'))).toBe(false);
    expect(existsSync(join(home, '.config/pipico/config.json'))).toBe(false);
    expect(existsSync(manifestPathFor(join(home, '.config')))).toBe(false);
    // ...the obstructing regular file and its pre-existing parent are untouched...
    expect(readFileSync(join(home, '.local/bin'), 'utf8')).toBe('NOT-A-DIR\n');
    // ...and the tree is exactly as it was before the run.
    expect(snapshotDir(home)).toBe(before);
  });

  it('through the CLI, a failing install exits 1 with a contained error and no stack trace', async () => {
    const home = newHome();
    mkdirSync(join(home, '.local'));
    writeFileSync(join(home, '.local/bin'), 'NOT-A-DIR\n');
    const r = await runCli(['install'], freshEnv(home));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('.local/bin/pipico');
    expect(r.stderr).not.toMatch(/\bat\s+\S+:\d+/);
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  it('ENOTDIR with a nested XDG base also reverse-cleans the invocation-created ancestors', async () => {
    const home = newHome();
    mkdirSync(join(home, '.local'));
    writeFileSync(join(home, '.local/bin'), 'NOT-A-DIR\n');
    const before = snapshotDir(home);

    const { io } = ioCapture();
    const code = await runInstallCommand(false, nestedEnv(home), io, RUNTIME);
    expect(code).toBe(1);
    expect(snapshotDir(home)).toBe(before);
    expect(existsSync(join(home, 'a'))).toBe(false);
  });

  it('late manifest-write failure: earlier creations are rolled back; the pre-existing read-only pipico dir and user config survive', async () => {
    const home = newHome();
    const pipicoDir = join(home, '.config/pipico');
    mkdirSync(pipicoDir, { recursive: true });
    writeFileSync(join(pipicoDir, 'config.json'), 'USER-CONFIG\n');
    chmodSync(pipicoDir, 0o555); // creating the manifest fails with EACCES
    try {
      const { io, out, err } = ioCapture();
      const code = await runInstallCommand(false, freshEnv(home), io, RUNTIME);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('installed.json');
      expect(out.join('\n')).toContain('rollback');

      // Resources successfully created before the failure are reverse-cleaned.
      expect(existsSync(join(home, '.local/bin/pipico'))).toBe(false);
      expect(existsSync(join(home, '.local/bin'))).toBe(false);
      expect(existsSync(join(home, '.local'))).toBe(false);
      // No manifest was left behind.
      expect(existsSync(join(pipicoDir, 'installed.json'))).toBe(false);
      // The pre-existing directory and the user config are intact.
      expect(readFileSync(join(pipicoDir, 'config.json'), 'utf8')).toBe('USER-CONFIG\n');
    } finally {
      chmodSync(pipicoDir, 0o755); // let the test cleanup remove it
    }
  });

  it('creation is tracked before the later chmod: a chmod failure still rolls the created file back', async () => {
    const home = newHome();
    const wrapper = join(home, '.local/bin/pipico');
    const ops: InstallFsOps = {
      ...realInstallFs,
      chmod: (p) => {
        if (p === wrapper) throw new Error('chmod: operation not permitted');
      },
    };
    const { io, out } = ioCapture();
    const code = await runInstallCommand(false, freshEnv(home), io, RUNTIME, ops);
    expect(code).toBe(1);
    expect(existsSync(wrapper)).toBe(false);
    expect(existsSync(join(home, '.local/bin'))).toBe(false);
    expect(existsSync(join(home, '.local'))).toBe(false);
    expect(existsSync(manifestPathFor(join(home, '.config')))).toBe(false);
    expect(out.join('\n')).toContain('rollback');
  });

  it('reverseClean keeps a created directory that acquired a user file, and its ancestors, and never touches unlisted dirs', () => {
    const home = newHome();
    const a = join(home, 'a');
    const ab = join(a, 'b');
    const abc = join(ab, 'config');
    mkdirSync(abc, { recursive: true });
    const preExistingEmpty = join(home, 'pre-existing-empty');
    mkdirSync(preExistingEmpty);
    const createdFile = join(abc, 'pipico');
    writeFileSync(createdFile, 'CREATED\n');

    // Everything below was recorded as created by the invocation, but a user
    // file appeared in a/b before the cleanup ran.
    const userFile = join(ab, 'user.txt');
    writeFileSync(userFile, 'USER\n');
    const created: ManifestResource[] = [
      { path: a, type: 'dir' },
      { path: ab, type: 'dir' },
      { path: abc, type: 'dir' },
      { path: createdFile, type: 'file', sha256: sha256('CREATED\n'), mode: '0644' },
    ];

    const { io, out } = ioCapture();
    reverseClean(created, io);
    expect(out.join('\n')).toContain('not empty');

    expect(readFileSync(userFile, 'utf8')).toBe('USER\n'); // kept, byte-identical
    expect(existsSync(ab)).toBe(true); // its nonempty directory kept
    expect(existsSync(a)).toBe(true); // the ancestor still containing it kept
    expect(existsSync(createdFile)).toBe(false); // created file removed
    expect(existsSync(abc)).toBe(false); // empty created dir removed deepest-first
    expect(existsSync(preExistingEmpty)).toBe(true); // never created by the invocation → never touched
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
