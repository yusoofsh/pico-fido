/**
 * End-to-end tests: spawn `bun src/cli.ts` exactly the way validators and
 * users do, with a temp HOME, and compare the HOME tree before and after.
 */
import { existsSync, readFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { snapshotDir } from './helpers.ts';

const HOST_DIR = join(import.meta.dir, '..');
const CLI = join(HOST_DIR, 'src', 'cli.ts');
const BUN = process.execPath;

interface E2eResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawnCli(args: string[], env: Record<string, string | undefined>): Promise<E2eResult> {
  const proc = Bun.spawn([BUN, CLI, ...args], {
    env,
    cwd: HOST_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pipico-e2e-${prefix}-`));
}

/**
 * Snapshot of HOME that ignores `.bun`: bun's own runtime converts bun.lock
 * into `$HOME/.bun/install/cache/*.pile` on the first run of any project
 * script, which is bun behavior, not pipico's. pipico itself creates nothing
 * (asserted by the in-process runCli snapshot tests).
 */
function snapshotHome(home: string): string {
  return snapshotDir(home)
    .split('\n')
    .filter((line) => line === '' || !line.split(' ')[1]!.startsWith('.bun'))
    .join('\n');
}

function writeDefaultConfig(home: string, attentionUrl: string): string {
  const dir = join(home, '.config', 'pipico');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  // Same shape as the documented example in host/README.md.
  writeFileSync(path, `${JSON.stringify({
    workspaces: {
      devops: {
        label: 'DevOps',
        app: 'com.apple.Terminal',
        paths: ['/Users/yusoof/work/infra'],
        urls: ['https://grafana.internal.example/dash'],
      },
    },
    attentionUrl,
    incident: {
      notesRoot: '/Users/yusoof/incident-notes',
      monitoringUrls: ['https://status.example/internal'],
    },
    study: { urls: ['https://course.example/lesson-1'] },
  }, null, 2)}\n`);
  return path;
}

describe('subprocess CLI', () => {
  it('--help exits 0 and lists the commands', async () => {
    const r = await spawnCli(['--help'], { HOME: tempDir('home') });
    expect(r.code).toBe(0);
    for (const c of ['doctor', 'action', 'attention', 'incident', 'study', 'lock', 'install', 'uninstall', '--dry-run', '--config']) {
      expect(r.stdout).toContain(c);
    }
  });

  it('an unknown command exits nonzero with "unknown command" on stderr and leaves HOME unchanged', async () => {
    const home = tempDir('home');
    const before = snapshotHome(home);
    const r = await spawnCli(['frobnicate'], { HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('unknown command: frobnicate');
    expect(snapshotHome(home)).toBe(before);
  });

  it('attention opens exactly the configured URL through the fake platform', async () => {
    const home = tempDir('home');
    const log = join(tempDir('log'), 'fake.log');
    writeDefaultConfig(home, 'https://attention.example/today');
    const r = await spawnCli(['attention'], { HOME: home, PIPICO_PLATFORM: 'fake', PIPICO_FAKE_LOG: log });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual({
      op: 'openUrl',
      url: 'https://attention.example/today',
    });
  });

  it('attention on the real platform exits 4 with "unsupported platform" and leaves HOME unchanged', async () => {
    const home = tempDir('home');
    writeDefaultConfig(home, 'https://attention.example/today');
    const before = snapshotHome(home);
    const r = await spawnCli(['attention'], { HOME: home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('unsupported platform');
    expect(snapshotHome(home)).toBe(before);
  });

  it('a missing config fails with one clean line and never creates a config', async () => {
    const home = tempDir('home');
    const before = snapshotHome(home);
    const r = await spawnCli(['attention'], {
      HOME: home,
      PIPICO_PLATFORM: 'fake',
      PIPICO_CONFIG: join(home, 'nope.json'),
    });
    expect(r.code).toBe(3);
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(r.stderr).toContain('config file not found');
    expect(r.stderr).not.toMatch(/\bat\s+\S+:\d+/);
    expect(snapshotHome(home)).toBe(before);
    expect(existsSync(join(home, '.config', 'pipico', 'config.json'))).toBe(false);
  });

  it('a malformed config fails with one clean line and zero side effects', async () => {
    const home = tempDir('home');
    writeDefaultConfig(home, 'https://attention.example/today');
    const cfgPath = join(home, '.config', 'pipico', 'config.json');
    writeFileSync(cfgPath, '{oops');
    const log = join(tempDir('log'), 'fake.log');
    const r = await spawnCli(['attention'], { HOME: home, PIPICO_PLATFORM: 'fake', PIPICO_FAKE_LOG: log });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('not valid JSON');
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('doctor reports a valid config as ok with the fake platform (exit 5: not installed)', async () => {
    const home = tempDir('home');
    writeDefaultConfig(home, 'https://attention.example/today');
    const r = await spawnCli(['doctor'], { HOME: home, PIPICO_PLATFORM: 'fake' });
    expect(r.code).toBe(5); // only the executable check fails (no install yet)
    expect(r.stdout).toContain('config: ok');
    expect(r.stdout).toContain('executable: FAIL');
  });

  it('install, doctor and uninstall work end to end in a temp HOME', async () => {
    const home = tempDir('home');
    const exe = join(home, '.local', 'bin', 'pipico');
    const manifestPath = join(home, '.config', 'pipico', 'installed.json');

    // Install (the "fake platform" env is the validator standard; install
    // itself never uses the platform and writes only under HOME).
    const install = await spawnCli(['install'], { HOME: home, PIPICO_PLATFORM: 'fake' });
    expect(install.code).toBe(0);
    expect(existsSync(exe)).toBe(true);
    expect(statSync(exe).mode & 0o111).not.toBe(0);
    // The wrapper runs the very CLI that installed it, by absolute path.
    expect(readFileSync(exe, 'utf8')).toContain(CLI);
    // Binding instructions name F13-F16 with the absolute wrapper path.
    for (const [key, command] of [['F13', 'action'], ['F14', 'attention'], ['F15', 'incident'], ['F16', 'lock']]) {
      expect(install.stdout).toContain(`${exe} ${command}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.pipicoManifest).toBe(1);
    const listed: string[] = manifest.resources.map((e: { path: string }) => e.path);
    expect(listed).toContain(exe);
    expect(listed).toContain(join(home, '.config', 'pipico', 'config.json'));
    expect(listed).not.toContain(manifestPath);

    // doctor is healthy on the installed setup.
    const doctor = await spawnCli(['doctor'], { HOME: home, PIPICO_PLATFORM: 'fake' });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain(`executable: ok (${exe})`);

    // A user file that install/uninstall must never touch.
    writeFileSync(join(home, 'other.txt'), 'USER\n');

    // Dry-run removes nothing; uninstall removes only manifest resources.
    const dry = await spawnCli(['uninstall', '--dry-run'], { HOME: home, PIPICO_PLATFORM: 'fake' });
    expect(dry.code).toBe(0);
    expect(existsSync(exe)).toBe(true);
    const uninstall = await spawnCli(['uninstall'], { HOME: home, PIPICO_PLATFORM: 'fake' });
    expect(uninstall.code).toBe(0);
    expect(existsSync(exe)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
    expect(readFileSync(join(home, 'other.txt'), 'utf8')).toBe('USER\n');
  });
});
