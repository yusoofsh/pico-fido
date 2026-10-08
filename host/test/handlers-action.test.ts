/**
 * action (F13) handler tests (VAL-HOST-017/018/019): explicit chooser over
 * all configured workspaces, cancel opens nothing, agent launch only on the
 * explicit allowlisted "<id>:<agent>" choice with no auto-approve flags.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { validateConfig, type LoadedConfig } from '../src/config.ts';
import { runAction } from '../src/handlers/action.ts';
import { CHOOSER_CANCEL_TAG, CHOOSER_SCRIPT, CHOOSER_SELECT_TAG, MacPlatform } from '../src/platform/mac.ts';
import type { RunOptions, RunResult } from '../src/exec.ts';
import { captureIo, fakeEnv, makeTempHome, readLogLines, snapshotDir, VALID_CONFIG, writeDefaultConfig } from './helpers.ts';

function logPath(home: string): string {
  return join(home, 'fake-platform.log');
}

describe('action: explicit chooser (VAL-HOST-017)', () => {
  it('offers every configured workspace exactly once and opens only the picked one', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([
      {
        op: 'choose',
        prompt: expect.any(String),
        options: ['devops', 'study'],
      },
      { op: 'openApp', app: 'com.apple.Terminal', path: '/Users/yusoof/work/infra' },
      { op: 'openUrl', url: 'https://grafana.internal.example/dash' },
    ]);
  });

  it('still shows the chooser with only one workspace (never auto-picks)', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => { delete c.workspaces.study; });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))[0]).toMatchObject({ op: 'choose', options: ['devops'] });
  });

  it('never records the invocation cwd in any call', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'study' });
    const cwd = process.cwd();
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    for (const call of readLogLines(logPath(home))) {
      expect(JSON.stringify(call)).not.toContain(cwd);
      expect(JSON.stringify(call)).not.toContain(import.meta.dir);
    }
  });

  it('fails cleanly with no calls when no workspace is configured', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => { c.workspaces = {}; });
    const env = fakeEnv(home);
    const r = await runCli(['action'], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no workspaces');
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(readLogLines(logPath(home))).toEqual([]);
  });
});

describe('action: cancel does nothing (VAL-HOST-018)', () => {
  it('exits 0 with the chooser call and no open, lock or agent call', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const log = join(makeTempHome(), 'fake.log'); // outside home: snapshots stay clean
    const before = snapshotDir(home);
    const env = fakeEnv(home, { PIPICO_FAKE_LOG: log, PIPICO_FAKE_CHOICE: 'cancel' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(log)).toEqual([
      { op: 'choose', prompt: expect.any(String), options: ['devops', 'study'] },
    ]);
    expect(snapshotDir(home)).toBe(before);
    expect(r.stdout).toContain('cancel');
  });
});

describe('action: agent launch only on explicit choice (VAL-HOST-019)', () => {
  const AUTO_APPROVE_FLAGS = ['--yes', '-y', '--auto', '--auto-approve', '--dangerously-skip-permissions', '--skip-permissions-unsafe', '--full-auto'];

  it('records no agent launch when the plain workspace is selected', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => { c.workspaces.devops.agent = 'claude'; });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    const calls = readLogLines(logPath(home));
    expect(calls.filter((c) => c.op === 'launchAgent')).toEqual([]);
    expect(calls.filter((c) => c.op === 'choose')).toHaveLength(1);
  });

  it('launches the agent only via the explicit "<id>:<agent>" option, last, with fixed argv', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => { c.workspaces.devops.agent = 'claude'; });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops:claude' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    const calls = readLogLines(logPath(home));
    expect(calls[0]).toMatchObject({ op: 'choose', options: ['devops', 'devops:claude', 'study'] });
    const launch = calls.find((c) => c.op === 'launchAgent');
    expect(launch).toMatchObject({
      agent: 'claude',
      argv: ['/usr/bin/env', 'claude'],
      cwd: '/Users/yusoof/work/infra',
    });
    for (const flag of AUTO_APPROVE_FLAGS) {
      expect(launch!.argv as string[]).not.toContain(flag);
    }
    // The launch comes after the workspace opens.
    expect(calls.indexOf(launch!)).toBe(calls.length - 1);
  });

  it('offers the agent option only for workspaces that configure one', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => { c.workspaces.devops.agent = 'codex'; });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'cancel' });
    await runCli(['action'], env);
    expect(readLogLines(logPath(home))[0]!.options).toEqual(['devops', 'devops:codex', 'study']);
  });

  it('refuses an agent choice for a workspace with no paths before opening anything', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => {
      c.workspaces.devops.agent = 'claude';
      c.workspaces.devops.paths = [];
    });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops:claude' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no paths');
    expect(readLogLines(logPath(home)).filter((c) => c.op !== 'choose')).toEqual([]);
  });

  it('agent options never carry arguments from config', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => {
      c.workspaces.devops.agent = 'claude';
      c.workspaces.devops.dangerousFlag = '--yaml-escape'; // unknown key must be rejected
    });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops:claude' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(3); // config validation rejects the unknown key outright
    expect(r.stderr).toContain('unknown key');
  });
});

describe('action via injected MacPlatform: CANCELED is selectable, cancel does nothing (VAL-HOST-029)', () => {
  interface RecordedCall { argv: string[]; opts: RunOptions; }

  /** A spawner that records every argv and answers with one fixed stdout. */
  function spawner(stdout: string) {
    const calls: RecordedCall[] = [];
    const spawn = async (argv: readonly string[], opts: RunOptions): Promise<RunResult> => {
      calls.push({ argv: [...argv], opts });
      return { code: 0, stdout, stderr: '' };
    };
    return { calls, spawn };
  }

  /** A schema-valid config whose workspaces include the id "CANCELED". */
  function canceledConfig(): LoadedConfig {
    const raw = JSON.parse(JSON.stringify(VALID_CONFIG));
    raw.workspaces.CANCELED = {
      label: 'Canceled-like workspace',
      app: 'com.apple.Terminal',
      paths: ['/Users/yusoof/work/infra'],
      urls: ['https://grafana.internal.example/dash'],
    };
    return { path: '/tmp/pipico-test/config.json', source: 'env' as const, config: validateConfig(raw) };
  }

  it('accepts a config with a workspace id CANCELED (no id is a reserved sentinel)', () => {
    expect(canceledConfig().config.workspaces.CANCELED).toBeDefined();
  });

  it('selecting CANCELED opens exactly that workspace\'s configured resources', async () => {
    const { calls, spawn } = spawner(`${CHOOSER_SELECT_TAG}\nCANCELED\n`);
    const platform = new MacPlatform(spawn, () => true);
    const { io, out, err } = captureIo();
    const code = await runAction({ loaded: canceledConfig(), platform, io, dryRun: false });
    expect(code).toBe(0);
    expect(out.join('')).toContain('CANCELED');
    expect(err.join('')).toBe('');
    // Exactly three spawns: the chooser, then only the CANCELED workspace's
    // app open and URL open. No lock, no agent launch.
    expect(calls).toHaveLength(3);
    const [chooser, appOpen, urlOpen] = calls.map((c) => c.argv);
    expect(chooser![0]).toBe('/usr/bin/osascript');
    expect(chooser![1]).toBe('-e');
    expect(chooser![2]).toBe(CHOOSER_SCRIPT);
    expect(chooser!.slice(3)).toContain('CANCELED');
    expect(appOpen).toEqual(['/usr/bin/open', '-a', 'com.apple.Terminal', '/Users/yusoof/work/infra']);
    expect(urlOpen).toEqual(['/usr/bin/open', 'https://grafana.internal.example/dash']);
  });

  it('cancellation (with CANCELED offered) performs no app-open, URL-open, lock or agent-launch', async () => {
    const { calls, spawn } = spawner(`${CHOOSER_CANCEL_TAG}\n`);
    const platform = new MacPlatform(spawn, () => true);
    const { io, out } = captureIo();
    const code = await runAction({ loaded: canceledConfig(), platform, io, dryRun: false });
    expect(code).toBe(0);
    expect(out.join('')).toContain('canceled');
    // Only the chooser ran; nothing was opened, locked or launched.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe('/usr/bin/osascript');
  });

  it('the fake CLI opens a workspace literally named CANCELED when it is chosen', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => {
      c.workspaces.CANCELED = {
        label: 'Canceled-like workspace',
        app: 'com.apple.Terminal',
        paths: ['/Users/yusoof/work/infra'],
        urls: ['https://grafana.internal.example/dash'],
      };
    });
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'CANCELED' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([
      { op: 'choose', prompt: expect.any(String), options: ['devops', 'study', 'CANCELED'] },
      { op: 'openApp', app: 'com.apple.Terminal', path: '/Users/yusoof/work/infra' },
      { op: 'openUrl', url: 'https://grafana.internal.example/dash' },
    ]);
  });
});
