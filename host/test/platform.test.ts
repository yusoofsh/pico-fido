import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { getPlatform, FakePlatform, RealPlatform } from '../src/platform/index.ts';
import { makeTempHome } from './helpers.ts';

describe('getPlatform', () => {
  it('selects the fake platform only via PIPICO_PLATFORM=fake', () => {
    expect(getPlatform({ PIPICO_PLATFORM: 'fake' })).toBeInstanceOf(FakePlatform);
    expect(getPlatform({})).toBeInstanceOf(RealPlatform);
    expect(getPlatform({ PIPICO_PLATFORM: '' })).toBeInstanceOf(RealPlatform);
  });

  it('rejects unknown PIPICO_PLATFORM values instead of guessing', () => {
    for (const v of ['mac', 'real', 'Fake', 'FAKE']) {
      expect(() => getPlatform({ PIPICO_PLATFORM: v })).toThrow(/PIPICO_PLATFORM/);
    }
  });
});

describe('FakePlatform', () => {
  it('records openUrl calls as JSON lines in PIPICO_FAKE_LOG', async () => {
    const home = makeTempHome();
    const log = join(home, 'fake.log');
    const fake = new FakePlatform({ PIPICO_FAKE_LOG: log });
    await fake.openUrl('https://x.example/today');
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ op: 'openUrl', url: 'https://x.example/today' }]);
    expect(fake.calls).toEqual([{ op: 'openUrl', url: 'https://x.example/today' }]);
  });

  it('records openApp with an optional target path', async () => {
    const home = makeTempHome();
    const log = join(home, 'fake.log');
    const fake = new FakePlatform({ PIPICO_FAKE_LOG: log });
    await fake.openApp('com.apple.Terminal');
    await fake.openApp('com.apple.Terminal', '/Users/x/repo');
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { op: 'openApp', app: 'com.apple.Terminal' },
      { op: 'openApp', app: 'com.apple.Terminal', path: '/Users/x/repo' },
    ]);
  });

  it('records lock calls', async () => {
    const home = makeTempHome();
    const log = join(home, 'fake.log');
    const fake = new FakePlatform({ PIPICO_FAKE_LOG: log });
    await fake.lock();
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual({ op: 'lock' });
  });

  it('creates and truncates the log file when constructed', () => {
    const home = makeTempHome();
    const log = join(home, 'fake.log');
    writeFileSync(log, 'stale content from a previous run\n');
    new FakePlatform({ PIPICO_FAKE_LOG: log });
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('records choose calls with their options and answers via PIPICO_FAKE_CHOICE', async () => {
    const home = makeTempHome();
    const log = join(home, 'fake.log');
    const fake = new FakePlatform({ PIPICO_FAKE_LOG: log, PIPICO_FAKE_CHOICE: 'devops' });
    const picked = await fake.choose('Pick a workspace', ['devops', 'study']);
    expect(picked).toBe('devops');
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual({
      op: 'choose',
      prompt: 'Pick a workspace',
      options: ['devops', 'study'],
    });
  });

  it('choose returns null on an explicit cancel', async () => {
    const home = makeTempHome();
    const fake = new FakePlatform({ PIPICO_FAKE_LOG: join(home, 'fake.log'), PIPICO_FAKE_CHOICE: 'cancel' });
    expect(await fake.choose('Pick', ['devops', 'study'])).toBeNull();
  });

  it('choose throws when PIPICO_FAKE_CHOICE is unset (never picks silently)', async () => {
    const fake = new FakePlatform({});
    await expect(fake.choose('Pick', ['devops'])).rejects.toThrow(/PIPICO_FAKE_CHOICE/);
  });

  it('choose throws when the choice is not among the offered options', async () => {
    const fake = new FakePlatform({ PIPICO_FAKE_CHOICE: 'nope' });
    await expect(fake.choose('Pick', ['devops', 'study'])).rejects.toThrow(/PIPICO_FAKE_CHOICE/);
  });

  it('PIPICO_FAKE_FAIL makes exactly that operation fail', async () => {
    const home = makeTempHome();
    const log = join(home, 'fake.log');
    const fake = new FakePlatform({ PIPICO_FAKE_LOG: log, PIPICO_FAKE_FAIL: 'openUrl' });
    await expect(fake.openUrl('https://x.example/')).rejects.toThrow(/PIPICO_FAKE_FAIL/);
    // The failed op is not recorded; other ops still work.
    expect(readFileSync(log, 'utf8')).toBe('');
    await fake.lock();
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual({ op: 'lock' });
  });

  it('records calls in memory when PIPICO_FAKE_LOG is unset', async () => {
    const fake = new FakePlatform({});
    await fake.openUrl('https://x.example/');
    expect(fake.calls).toHaveLength(1);
  });
});

describe('RealPlatform on a non-macOS host', () => {
  it('refuses every operation with "unsupported platform" without doing anything', async () => {
    const p = new RealPlatform();
    expect(p.supported).toBe(false);
    for (const attempt of [
      () => p.openApp('com.apple.Terminal'),
      () => p.openApp('com.apple.Terminal', '/Users/x/repo'),
      () => p.openUrl('https://x.example/'),
      () => p.choose('Pick', ['a', 'b']),
      () => p.lock(),
    ]) {
      let message = '';
      try {
        await attempt();
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toContain('unsupported platform');
    }
  });
});
