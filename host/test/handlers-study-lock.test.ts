/**
 * study and lock handler tests (VAL-HOST-024/025): study opens exactly the
 * configured URLs and never submits anything; lock records exactly one lock
 * call and nothing else.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { runCli } from '../src/cli.ts';
import { fakeEnv, makeTempHome, readLogLines, snapshotDir, writeDefaultConfig } from './helpers.ts';

function logPath(home: string): string {
  return join(home, 'fake-platform.log');
}

describe('study: opens only configured URLs (VAL-HOST-024)', () => {
  it('opens every configured study URL in order and nothing else', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => {
      c.study.urls = ['https://course.example/lesson-1', 'https://course.example/lesson-2'];
    });
    const env = fakeEnv(home);
    const r = await runCli(['study'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([
      { op: 'openUrl', url: 'https://course.example/lesson-1' },
      { op: 'openUrl', url: 'https://course.example/lesson-2' },
    ]);
  });

  it('exits 0 with no calls when no study URLs are configured', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home, (c) => { c.study.urls = []; });
    const env = fakeEnv(home);
    const r = await runCli(['study'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([]);
  });

  it('dry run prints the plan and records nothing', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const before = snapshotDir(home);
    const r = await runCli(['study', '--dry-run'], fakeEnv(home));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('https://course.example/lesson-1');
    expect(snapshotDir(home)).toBe(before);
    expect(readLogLines(logPath(home))).toEqual([]);
  });
});

describe('lock: only the lock action (VAL-HOST-025)', () => {
  it('records exactly one lock call and nothing else', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const env = fakeEnv(home);
    const r = await runCli(['lock'], env);
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([{ op: 'lock' }]);
  });

  it('dry run records nothing', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const r = await runCli(['lock', '--dry-run'], fakeEnv(home));
    expect(r.code).toBe(0);
    expect(readLogLines(logPath(home))).toEqual([]);
  });
});

describe('open handlers: failures contained via PIPICO_FAKE_FAIL (VAL-HOST-030)', () => {
  it('attention exits 1 with a short line when the URL open is forced to fail', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const r = await runCli(['attention'], fakeEnv(home, { PIPICO_FAKE_FAIL: 'openUrl' }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('openUrl');
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(r.stderr).not.toMatch(/\bat\s+\S+:\d+/);
  });

  it('action exits 1 with a short line when the app open is forced to fail', async () => {
    const home = makeTempHome();
    writeDefaultConfig(home);
    const r = await runCli(['action'], fakeEnv(home, { PIPICO_FAKE_CHOICE: 'devops', PIPICO_FAKE_FAIL: 'openApp' }));
    expect(r.code).toBe(1);
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    // The chooser call was recorded before the failing open; nothing after.
    const calls = readLogLines(logPath(home));
    expect(calls).toEqual([
      { op: 'choose', prompt: expect.any(String), options: ['devops', 'study'] },
    ]);
  });
});
