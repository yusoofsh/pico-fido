/**
 * action (F13) handler tests (VAL-HOST-017/018/019): explicit chooser over
 * all configured workspaces, cancel opens nothing, agent launch only on the
 * explicit allowlisted "<id>:<agent>" choice with no auto-approve flags.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { fakeEnv, makeTempHome, readLogLines, snapshotDir, writeDefaultConfig } from './helpers.ts';

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
    const before = snapshotDir(home);
    const env = fakeEnv(home, { PIPICO_FAKE_CHOICE: 'cancel' });
    const r = await runCli(['action'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([
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
