import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import {
  fakeEnv,
  makeTempHome,
  readLogLines,
  snapshotDir,
  writeConfigFile,
  writeDefaultConfig,
} from './helpers.ts';

const tempHomes: string[] = [];
afterAll(() => {
  // Leave no temp homes behind; each is a mkdtemp dir created by these tests.
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

/** Env for snapshot tests: the fake log lives in a separate temp dir so the
 * snapshot of home shows exactly what the CLI itself created. */
function fakeEnvExternalLog(home: string, extra?: Record<string, string | undefined>): {
  env: Record<string, string | undefined>;
  logPath: string;
} {
  const logDir = makeTempHome();
  tempHomes.push(logDir);
  const logPath = join(logDir, 'fake.log');
  return { env: fakeEnv(home, { PIPICO_FAKE_LOG: logPath, ...extra }), logPath };
}

const ALL_COMMANDS = ['doctor', 'action', 'attention', 'incident', 'study', 'lock', 'install', 'uninstall'];

describe('usage', () => {
  it('--help exits 0 and lists every command and the --dry-run/--config options', async () => {
    const r = await runCli(['--help'], {});
    expect(r.code).toBe(0);
    for (const c of ALL_COMMANDS) expect(r.stdout).toContain(c);
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--config');
  });

  it('-h and "help" also print usage with exit 0', async () => {
    expect((await runCli(['-h'], {})).code).toBe(0);
    expect((await runCli(['help'], {})).code).toBe(0);
  });

  it('no arguments prints usage on stderr and exits 2', async () => {
    const r = await runCli([], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage');
  });

  it('an unknown command exits 2 with "unknown command" on stderr', async () => {
    const r = await runCli(['frobnicate'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command: frobnicate');
  });

  it('unknown options and stray positional arguments exit 2', async () => {
    expect((await runCli(['--nope'], {})).code).toBe(2);
    expect((await runCli(['attention', 'extra'], {})).code).toBe(2);
    expect((await runCli(['--config'], {})).code).toBe(2);
    expect((await runCli(['--config', ''], {})).code).toBe(2);
  });

  it('an unknown PIPICO_PLATFORM value is a usage error', async () => {
    const r = await runCli(['attention'], { PIPICO_PLATFORM: 'mac' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('PIPICO_PLATFORM');
  });
});

describe('attention with the fake platform', () => {
  it('opens exactly the configured attention URL', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const r = await runCli(['attention'], fakeEnv(home));
    expect(r.code).toBe(0);
    expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([
      { op: 'openUrl', url: 'https://attention.example/today' },
    ]);
  });

  it('exits 4 with "unsupported platform" on the real platform and does nothing', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const before = snapshotDir(home);
    const r = await runCli(['attention'], { HOME: home });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('unsupported platform');
    expect(snapshotDir(home)).toBe(before);
    expect(existsSync(join(home, 'fake-platform.log'))).toBe(false);
  });
});

describe('config rejection through handlers (fake platform, zero platform calls)', () => {
  it('rejects an unknown key at every level and names the key path', async () => {
    const cases: Array<[(cfg: any) => void, RegExp]> = [
      [(c) => { c.extra = 1; }, /config: unknown key "extra"/],
      [(c) => { c.workspaces.devops.extra = 1; }, /config\.workspaces\.devops: unknown key "extra"/],
      [(c) => { c.incident.extra = 1; }, /config\.incident: unknown key "extra"/],
      [(c) => { c.study.extra = 1; }, /config\.study: unknown key "extra"/],
    ];
    for (const [mutate, rx] of cases) {
      const home = newHome();
      writeDefaultConfig(home, mutate);
      const r = await runCli(['attention'], fakeEnv(home));
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(rx);
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
    }
  });

  it('rejects shell/command fields at every level for every gated handler', async () => {
    for (const key of ['shell', 'command', 'shell_command', 'cmd', 'exec', 'script', 'args']) {
      for (const mutate of [
        (c: any) => { c[key] = 'touch /tmp/pwned'; },
        (c: any) => { c.workspaces.devops[key] = 'touch /tmp/pwned'; },
        (c: any) => { c.incident[key] = 'touch /tmp/pwned'; },
      ]) {
        for (const command of ['action', 'attention', 'incident', 'study', 'lock']) {
          const home = newHome();
          writeDefaultConfig(home, mutate);
          const r = await runCli([command], fakeEnv(home));
          expect(r.code).toBe(3);
          expect(r.stderr).toContain(`"${key}" is not allowed`);
          expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
        }
      }
    }
  });

  it('rejects non-allowlisted app ids with no app-open call', async () => {
    for (const app of ['com.evil.Payload', '/bin/sh', 'Terminal; rm -rf ~']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.workspaces.devops.app = app; });
      const r = await runCli(['action'], fakeEnv(home));
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('not allowlisted');
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
    }
  });

  it('rejects relative, tilde and empty paths, naming the field', async () => {
    for (const p of ['relative/dir', './dir', '~/dir', '']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.workspaces.devops.paths = [p]; });
      const r = await runCli(['action'], fakeEnv(home));
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('paths[0]');
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
    }
  });

  it('rejects traversal and control-character paths without creating anything', async () => {
    for (const p of ['/home/x/../../etc', '/Users/yusoof/\u0000pwn', '/Users/yusoof/n\note', '/Users/yusoof/\u001bescape']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.workspaces.devops.paths = [p]; });
      const before = snapshotDir(home);
      const { env, logPath } = fakeEnvExternalLog(home);
      const r = await runCli(['action'], env);
      expect(r.code).toBe(3);
      expect(snapshotDir(home)).toBe(before);
      expect(readLogLines(logPath)).toEqual([]);
    }
  });

  it('rejects dangerous URL schemes in every URL field with zero open calls', async () => {
    const schemes = ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>', 'vbscript:x', 'ftp://example.com', 'chrome://settings'];
    const placements: Array<[(c: any, u: string) => void, string]> = [
      [(c, u) => { c.attentionUrl = u; }, 'attention'],
      [(c, u) => { c.workspaces.devops.urls.push(u); }, 'action'],
      [(c, u) => { c.incident.monitoringUrls.push(u); }, 'incident'],
      [(c, u) => { c.study.urls.push(u); }, 'study'],
    ];
    for (const scheme of schemes) {
      for (const [mutate, command] of placements) {
        const home = newHome();
        writeDefaultConfig(home, (c) => mutate(c, scheme));
        const r = await runCli([command], fakeEnv(home));
        expect(r.code).toBe(3);
        expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
      }
    }
  });

  it('rejects http on non-localhost hosts with zero open calls', async () => {
    for (const u of ['http://example.com/', 'http://localhost.evil.com/', 'http://127.0.0.1.nip.io/', 'http://10.0.0.1/']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.attentionUrl = u; });
      const r = await runCli(['attention'], fakeEnv(home));
      expect(r.code).toBe(3);
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
    }
  });

  it('accepts localhost http and https with exactly one URL-open call', async () => {
    for (const u of ['http://localhost:3000/', 'https://example.com/', 'http://127.0.0.1:8080/x', 'http://[::1]/']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.attentionUrl = u; });
      const r = await runCli(['attention'], fakeEnv(home));
      expect(r.code).toBe(0);
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([{ op: 'openUrl', url: u }]);
    }
  });

  it('rejects embedded credentials and never echoes the secret', async () => {
    for (const u of ['https://user:pass@example.com/', 'https://user@example.com/', 'https://:token@example.com/']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.attentionUrl = u; });
      const r = await runCli(['attention'], fakeEnv(home));
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('credentials');
      expect(r.stderr).not.toContain('pass@example.com');
      expect(r.stderr).not.toContain('token@example.com');
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
    }
  });
});

describe('malformed and missing config through the CLI', () => {
  it('invalid JSON: exit 3, one actionable line, no stack trace, zero platform calls', async () => {
    const home = newHome();
    const dir = join(home, '.config', 'pipico');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{oops');
    const r = await runCli(['attention'], fakeEnv(home));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('config error:');
    expect(r.stderr).toContain('not valid JSON');
    const lines = r.stderr.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(r.stderr).not.toMatch(/\bat\s+\S+:\d+/); // no stack frames
    expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
  });

  it('a JSON array config fails cleanly', async () => {
    const home = newHome();
    const dir = join(home, '.config', 'pipico');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '[]');
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('top level must be a JSON object');
    expect(r.stderr).not.toMatch(/\bat\s+\S+:\d+/);
  });

  it('a missing PIPICO_CONFIG file fails cleanly for every handler and doctor', async () => {
    const missing = 'definitely-missing-config.json';
    for (const command of ['action', 'attention', 'incident', 'study', 'lock', 'doctor']) {
      const home = newHome();
      const before = snapshotDir(home);
      const { env } = fakeEnvExternalLog(home, { PIPICO_CONFIG: join(home, missing) });
      const r = await runCli([command], env);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('config file not found');
      const lines = r.stderr.split('\n').filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(1);
      expect(snapshotDir(home)).toBe(before);
    }
  });

  it('never creates a default config when none exists', async () => {
    const home = newHome();
    const r = await runCli(['attention'], fakeEnv(home));
    expect(r.code).toBe(3);
    expect(existsSync(join(home, '.config', 'pipico', 'config.json'))).toBe(false);
  });
});

describe('config precedence through the CLI', () => {
  it('--config beats PIPICO_CONFIG beats the default; each run opens exactly one URL', async () => {
    const home = newHome();
    writeDefaultConfig(home, (c) => { c.attentionUrl = 'https://a.example/'; });
    const envPath = writeConfigFile(home, 'b.json', (c) => { c.attentionUrl = 'https://b.example/'; });
    const flagPath = writeConfigFile(home, 'c.json', (c) => { c.attentionUrl = 'https://c.example/'; });
    const log = join(home, 'fake-platform.log');
    const mkEnv = (extra: Record<string, string | undefined>) => fakeEnv(home, extra);

    const withFlag = await runCli(['attention', '--config', flagPath], mkEnv({ PIPICO_CONFIG: envPath }));
    expect(withFlag.code).toBe(0);
    expect(readLogLines(log)).toEqual([{ op: 'openUrl', url: 'https://c.example/' }]);

    const withEnv = await runCli(['attention'], mkEnv({ PIPICO_CONFIG: envPath }));
    expect(withEnv.code).toBe(0);
    expect(readLogLines(log)).toEqual([{ op: 'openUrl', url: 'https://b.example/' }]);

    const withDefault = await runCli(['attention'], mkEnv({}));
    expect(withDefault.code).toBe(0);
    expect(readLogLines(log)).toEqual([{ op: 'openUrl', url: 'https://a.example/' }]);
  });
});

describe('every gated handler refuses on the real platform (Linux)', () => {
  it('exits 4 with "unsupported platform" and changes nothing', async () => {
    for (const command of ['action', 'attention', 'incident', 'study', 'lock']) {
      const home = newHome();
      writeDefaultConfig(home);
      const before = snapshotDir(home);
      const r = await runCli([command], { HOME: home });
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('unsupported platform');
      expect(snapshotDir(home)).toBe(before);
    }
  });
});

describe('handlers validate config before running on the fake platform', () => {
  it('rejects a bad config for every gated handler with zero platform calls', async () => {
    for (const command of ['action', 'attention', 'incident', 'study', 'lock']) {
      const home = newHome();
      writeDefaultConfig(home, (c) => { c.workspaces.study.paths = ['not-absolute']; });
      const r = await runCli([command], fakeEnv(home));
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('paths[0]');
      expect(readLogLines(join(home, 'fake-platform.log'))).toEqual([]);
    }
  });

  it('not-yet-implemented handlers say so honestly and change nothing', async () => {
    for (const command of ['action', 'incident', 'study', 'lock', 'install', 'uninstall']) {
      const home = newHome();
      writeDefaultConfig(home);
      const before = snapshotDir(home);
      const { env } = fakeEnvExternalLog(home);
      const r = await runCli([command], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not implemented');
      expect(snapshotDir(home)).toBe(before);
    }
  });

  it('install --dry-run reports that nothing was changed', async () => {
    const home = newHome();
    const before = snapshotDir(home);
    const r = await runCli(['install', '--dry-run'], { HOME: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('nothing was changed');
    expect(snapshotDir(home)).toBe(before);
  });
});

describe('doctor', () => {
  it('reports a valid config as ok with the fake platform (exit 0)', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('config: ok');
  });

  it('reports config problems with the key path and exits 3', async () => {
    const home = newHome();
    writeDefaultConfig(home, (c) => { c.extra = 1; });
    const r = await runCli(['doctor'], fakeEnv(home));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('config error:');
    expect(r.stderr).toContain('unknown key "extra"');
  });

  it('reports the unsupported platform on Linux without the fake platform (exit 4)', async () => {
    const home = newHome();
    writeDefaultConfig(home);
    const r = await runCli(['doctor'], { HOME: home });
    expect(r.code).toBe(4);
    expect(r.stdout).toContain('platform');
    expect(`${r.stdout}${r.stderr}`).toContain('unsupported platform');
  });

  it('honors --config', async () => {
    const home = newHome();
    const p = writeConfigFile(home, 'ok.json');
    const r = await runCli(['doctor', '--config', p], { HOME: home, PIPICO_PLATFORM: 'fake' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('config: ok');
    expect(r.stdout).toContain(p);
  });
});
