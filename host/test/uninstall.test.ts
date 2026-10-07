/**
 * uninstall (VAL-HOST-038, 039, 040): --dry-run prints exactly the manifest
 * entries and changes nothing; the real form removes only manifest resources
 * (directories only when empty), and refuses tampered entries — outside
 * $HOME, relative, symlinks, or files modified since install — without
 * removing anything.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { runInstallCommand, type InstallRuntime } from '../src/install.ts';
import { runUninstallCommand } from '../src/uninstall.ts';
import { manifestPathFor } from '../src/manifest.ts';
import { captureIo, makeTempHome } from './helpers.ts';

const RUNTIME: InstallRuntime = { bunPath: '/opt/bun/bin/bun', cliPath: '/opt/pipico/host/src/cli.ts' };

const tempHomes: string[] = [];
const outsideCanaries: string[] = [];
afterAll(() => {
  for (const p of [...tempHomes, ...outsideCanaries]) {
    try {
      rmSync(p, { recursive: true, force: true });
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

const freshEnv = (home: string): Record<string, string | undefined> => ({ HOME: home });

/** A home with a completed install (deterministic wrapper content). */
async function installedHome(): Promise<string> {
  const home = newHome();
  const { io } = captureIo();
  expect(await runInstallCommand(false, freshEnv(home), io, RUNTIME)).toBe(0);
  return home;
}

function readManifest(home: string): { resources: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(manifestPathFor(join(home, '.config')), 'utf8'));
}

function writeManifest(home: string, manifest: unknown): void {
  writeFileSync(manifestPathFor(join(home, '.config')), `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe('uninstall --dry-run (VAL-HOST-038)', () => {
  it('exits 0, prints exactly the manifest entries as planned removals, and changes nothing', async () => {
    const home = await installedHome();
    const manifestPath = manifestPathFor(join(home, '.config'));
    const manifest = readManifest(home);
    const before = readFileSync(manifestPath, 'utf8');

    const { io, out } = captureIo();
    const code = await runUninstallCommand(true, freshEnv(home), io);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('dry run');

    // The set of paths in "would remove" lines is exactly the manifest
    // entries plus the manifest itself.
    const listed: string[] = manifest.resources.map((e) => e.path as string);
    const removalPaths = out
      .filter((l) => l.includes('would remove'))
      .map((l) => l.split(' ').find((t) => t.startsWith('/')))
      .filter((p) => p !== undefined);
    expect(new Set(removalPaths)).toEqual(new Set([...listed, manifestPath]));

    // Nothing changed on disk (manifest byte-identical, files still there).
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
    for (const p of listed) expect(existsSync(p)).toBe(true);
  });
});

describe('real uninstall (VAL-HOST-039)', () => {
  it('removes exactly the manifest resources and keeps unrelated user files', async () => {
    // Pre-existing user config: install must skip it and never list it.
    const home = newHome();
    mkdirSync(join(home, '.config/pipico'), { recursive: true });
    writeFileSync(join(home, '.config/pipico/config.json'), 'USER-CONFIG\n');
    const { io: installIo } = captureIo();
    expect(await runInstallCommand(false, freshEnv(home), installIo, RUNTIME)).toBe(0);

    // Unrelated user files, as a validator would add them.
    const notesDir = join(home, 'notes/20260102-030405');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, 'notes.md'), 'NOTES\n');
    writeFileSync(join(home, 'other.txt'), 'OTHER\n');

    const userConfigBefore = readFileSync(join(home, '.config/pipico/config.json'), 'utf8');
    const notesBefore = readFileSync(join(notesDir, 'notes.md'), 'utf8');
    const listed: string[] = readManifest(home).resources.map((e) => e.path as string);

    const { io, out } = captureIo();
    const code = await runUninstallCommand(false, freshEnv(home), io);
    expect(code).toBe(0);

    // Every manifest entry is gone...
    for (const p of listed) {
      expect(existsSync(p)).toBe(false);
    }
    // ...the manifest itself is removed...
    expect(existsSync(manifestPathFor(join(home, '.config')))).toBe(false);
    // ...and unrelated files are byte-identical.
    expect(readFileSync(join(home, '.config/pipico/config.json'), 'utf8')).toBe(userConfigBefore);
    expect(readFileSync(join(notesDir, 'notes.md'), 'utf8')).toBe(notesBefore);
    expect(readFileSync(join(home, 'other.txt'), 'utf8')).toBe('OTHER\n');
    // A non-empty directory containing user files is not removed.
    expect(existsSync(join(home, '.config/pipico'))).toBe(true);
    expect(existsSync(notesDir)).toBe(true);
    // Directories pipico created and emptied are removed.
    expect(existsSync(join(home, '.local/bin'))).toBe(false);
    expect(out.join('\n')).not.toContain('removed file /etc');
  });
});

describe('nested XDG uninstall (VAL-HOST-039)', () => {
  const nestedEnv = (home: string): Record<string, string | undefined> => ({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'a/b/config'),
  });
  const nestedManifestPath = (home: string): string => manifestPathFor(join(home, 'a/b/config'));
  const readNestedManifest = (home: string): { resources: Array<Record<string, unknown>> } =>
    JSON.parse(readFileSync(nestedManifestPath(home), 'utf8'));

  async function installNested(home: string): Promise<void> {
    const { io } = captureIo();
    expect(await runInstallCommand(false, nestedEnv(home), io, RUNTIME)).toBe(0);
  }

  it('removes invocation-created ancestors deepest-first when they end up empty', async () => {
    const home = newHome();
    await installNested(home);
    const listed: string[] = readNestedManifest(home).resources.map((e) => e.path as string);
    for (const p of [join(home, 'a'), join(home, 'a/b'), join(home, 'a/b/config'), join(home, 'a/b/config/pipico')]) {
      expect(listed).toContain(p);
    }

    const { io } = captureIo();
    const code = await runUninstallCommand(false, nestedEnv(home), io);
    expect(code).toBe(0);
    for (const p of listed) expect(existsSync(p)).toBe(false);
    expect(existsSync(nestedManifestPath(home))).toBe(false);
    expect(existsSync(join(home, 'a'))).toBe(false);
    expect(existsSync(join(home, '.local'))).toBe(false);
    expect(existsSync(home)).toBe(true); // HOME itself is never a manifest resource
  });

  it('keeps a pre-existing ancestor and its canary', async () => {
    const home = newHome();
    mkdirSync(join(home, 'a'));
    writeFileSync(join(home, 'a/CANARY.txt'), 'CANARY\n');
    await installNested(home);

    const { io } = captureIo();
    const code = await runUninstallCommand(false, nestedEnv(home), io);
    expect(code).toBe(0);
    expect(existsSync(join(home, 'a'))).toBe(true);
    expect(readFileSync(join(home, 'a/CANARY.txt'), 'utf8')).toBe('CANARY\n');
    expect(existsSync(join(home, 'a/b'))).toBe(false);
    expect(existsSync(nestedManifestPath(home))).toBe(false);
  });

  it('keeps an invocation-created ancestor that acquired a user file, and the ancestor containing it', async () => {
    const home = newHome();
    await installNested(home);
    writeFileSync(join(home, 'a/b/user.txt'), 'USER\n');

    const { io, out } = captureIo();
    const code = await runUninstallCommand(false, nestedEnv(home), io);
    expect(code).toBe(0);
    expect(readFileSync(join(home, 'a/b/user.txt'), 'utf8')).toBe('USER\n');
    expect(existsSync(join(home, 'a/b'))).toBe(true);
    expect(existsSync(join(home, 'a'))).toBe(true); // still needed to contain a/b
    expect(existsSync(join(home, 'a/b/config'))).toBe(false);
    expect(existsSync(join(home, 'a/b/config/pipico'))).toBe(false);
    expect(existsSync(nestedManifestPath(home))).toBe(false);
    expect(out.join('\n')).toContain('not empty');
  });
});

describe('tampered manifests (VAL-HOST-040)', () => {
  it('refuses entries outside HOME, with .. traversal, relative paths, and symlinks — removing nothing', async () => {
    const home = await installedHome();
    const manifest = readManifest(home);

    // Canaries.
    const outside = join(tmpdir(), `pipico-canary-outside-${Date.now()}-${process.pid}`);
    writeFileSync(outside, 'CANARY\n');
    outsideCanaries.push(outside);
    const outsideViaDotDot = `${home}/../pipico-canary-dotdot-${process.pid}`;
    writeFileSync(outsideViaDotDot, 'CANARY\n');
    outsideCanaries.push(outsideViaDotDot);
    const link = join(home, 'escape-link');
    symlinkSync(outside, link);

    writeManifest(home, {
      ...manifest,
      resources: [
        ...manifest.resources,
        { path: outside, type: 'file', sha256: sha256File(outside), mode: '0644' },
        { path: outsideViaDotDot, type: 'file', sha256: sha256File(outsideViaDotDot), mode: '0644' },
        { path: 'relative/path.txt', type: 'file', sha256: '0'.repeat(64), mode: '0644' },
        { path: link, type: 'file', sha256: sha256File(outside), mode: '0644' },
      ],
    });
    // The uninstall must not rewrite the manifest either.
    const tamperedManifestOnDisk = readFileSync(manifestPathFor(join(home, '.config')), 'utf8');

    const { io, out, err } = captureIo();
    const code = await runUninstallCommand(false, freshEnv(home), io);
    expect(code).not.toBe(0);
    const messages = `${out.join('\n')}${err.join('\n')}`;
    for (const canary of [outside, outsideViaDotDot, 'relative/path.txt', link]) {
      expect(messages).toContain(canary === 'relative/path.txt' ? 'relative' : canary);
    }
    expect(messages).toContain('refused');

    // Nothing was removed: canaries, symlink, manifest and pipico files all intact.
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(outsideViaDotDot)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(manifestPathFor(join(home, '.config')))).toBe(true);
    expect(readFileSync(manifestPathFor(join(home, '.config')), 'utf8')).toBe(tamperedManifestOnDisk);
    expect(existsSync(join(home, '.local/bin/pipico'))).toBe(true);
  });

  it('refuses a manifest file that was modified after install', async () => {
    const home = await installedHome();
    const wrapper = join(home, '.local/bin/pipico');
    const before = readFileSync(wrapper, 'utf8');
    writeFileSync(wrapper, `${before}\n# user edit\n`);

    const { io, err } = captureIo();
    const code = await runUninstallCommand(false, freshEnv(home), io);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain(wrapper);
    expect(readFileSync(wrapper, 'utf8')).toBe(`${before}\n# user edit\n`);
    expect(existsSync(manifestPathFor(join(home, '.config')))).toBe(true);
  });

  it('refuses a corrupt manifest with a clean error, removing nothing', async () => {
    const home = await installedHome();
    writeFileSync(manifestPathFor(join(home, '.config')), '{oops');
    const wrapper = join(home, '.local/bin/pipico');
    const { io, err } = captureIo();
    const code = await runUninstallCommand(false, freshEnv(home), io);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain('manifest');
    expect(existsSync(wrapper)).toBe(true);
  });

  it('without a manifest removes nothing and says so', async () => {
    const home = newHome();
    writeFileSync(join(home, 'unrelated.txt'), 'X\n');
    const { io, out } = captureIo();
    const code = await runUninstallCommand(false, freshEnv(home), io);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('nothing to remove');
    expect(readFileSync(join(home, 'unrelated.txt'), 'utf8')).toBe('X\n');
  });
});
