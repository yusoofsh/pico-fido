/**
 * MacPlatform tests with an injected spawner (real macOS execution stays
 * NOT_RUN). VAL-HOST-029: workspace names reach osascript as separate argv
 * items consumed by "on run argv", never interpolated into the script text.
 * VAL-HOST-025: the lock action is one fixed argv.
 */
import { describe, expect, it } from 'bun:test';
import { CHOOSER_SCRIPT, CHOOSER_TIMEOUT_MS, MacPlatform } from '../src/platform/mac.ts';
import type { RunOptions, RunResult } from '../src/exec.ts';
import { UnsupportedPlatformError } from '../src/platform/index.ts';

interface RecordedCall {
  argv: string[];
  opts: RunOptions;
}

function recordingSpawner(results: Partial<RunResult>[]) {
  const calls: RecordedCall[] = [];
  const spawn = async (argv: readonly string[], opts: RunOptions): Promise<RunResult> => {
    calls.push({ argv: [...argv], opts });
    const next = results.shift();
    return { code: 0, stdout: '', stderr: '', ...next };
  };
  return { calls, spawn };
}

/** The hostile name from VAL-HOST-029. */
const HOSTILE = 'x" & (do shell script "touch /tmp/p") & "';

describe('MacPlatform.choose with an injected spawner', () => {
  it('passes the script and every option as separate argv items, never interpolated', async () => {
    const { calls, spawn } = recordingSpawner([{ stdout: 'devops\n' }]);
    const p = new MacPlatform(spawn, () => true);
    const picked = await p.choose('pick a workspace', ['devops', HOSTILE]);
    expect(picked).toBe('devops');
    expect(calls).toHaveLength(1);
    const { argv, opts } = calls[0]!;
    expect(argv[0]).toBe('/usr/bin/osascript');
    expect(argv[1]).toBe('-e');
    // The static script arrives byte-for-byte unchanged.
    expect(argv[2]).toBe(CHOOSER_SCRIPT);
    // The prompt and the names are separate argv elements.
    expect(argv[3]).toBe('pick a workspace');
    expect(argv.slice(4)).toEqual(['devops', HOSTILE]);
    expect(opts.timeoutMs).toBe(CHOOSER_TIMEOUT_MS);
    // The script text itself never contains the injected name...
    expect(CHOOSER_SCRIPT).not.toContain('devops');
    expect(CHOOSER_SCRIPT).not.toContain(HOSTILE);
    // ...and the only "do shell script" occurrence is the hostile argv element.
    const joined = argv.join('\u0000');
    expect(joined.split('do shell script')).toHaveLength(2); // once, in the name only
  });

  it('maps the CANCELED sentinel to null', async () => {
    const { spawn } = recordingSpawner([{ stdout: 'CANCELED\n' }]);
    const p = new MacPlatform(spawn, () => true);
    expect(await p.choose('pick', ['a', 'b'])).toBeNull();
  });

  it('rejects a picked option that was never offered (defensive)', async () => {
    const { spawn } = recordingSpawner([{ stdout: 'ghost\n' }]);
    const p = new MacPlatform(spawn, () => true);
    let message = '';
    try {
      await p.choose('pick', ['a', 'b']);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('unknown option');
  });

  it('rejects a nonzero osascript exit with a single-line message', async () => {
    const { spawn } = recordingSpawner([{ code: 1, stdout: '', stderr: 'execution error: bad\nmore\n' }]);
    const p = new MacPlatform(spawn, () => true);
    let message = '';
    try {
      await p.choose('pick', ['a']);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('choose: failed');
    expect(message).toContain('exit 1');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('refuses to offer an empty option list', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    let message = '';
    try {
      await p.choose('pick', []);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('no options');
    expect(calls).toHaveLength(0);
  });
});

describe('MacPlatform fixed argv for open and lock', () => {
  it('openUrl runs exactly [open, url]', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    await p.openUrl('https://attention.example/today');
    expect(calls[0]!.argv).toEqual(['/usr/bin/open', 'https://attention.example/today']);
    expect(calls[0]!.opts.timeoutMs).toBeGreaterThan(0);
  });

  it('openApp runs exactly [open, -a, appId] plus the optional path', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    await p.openApp('com.apple.Terminal');
    await p.openApp('com.apple.Terminal', '/Users/yusoof/work/infra');
    expect(calls[0]!.argv).toEqual(['/usr/bin/open', '-a', 'com.apple.Terminal']);
    expect(calls[1]!.argv).toEqual(['/usr/bin/open', '-a', 'com.apple.Terminal', '/Users/yusoof/work/infra']);
  });

  it('openApp rejects an app id outside the allowlist before spawning', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    let message = '';
    try {
      await p.openApp('com.apple.ScriptEditor2');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('allowlist');
    expect(calls).toHaveLength(0);
  });

  it('openApp rejects a target path that fails path validation', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    for (const bad of ['relative/path', '/Users/x/../escape', '/Users/x/\u0000']) {
      let message = '';
      try {
        await p.openApp('com.apple.Terminal', bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
    }
    expect(calls).toHaveLength(0);
  });

  it('lock runs one fixed argv and nothing else', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    await p.lock();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['/usr/bin/open', '/System/Library/CoreServices/ScreenSaverEngine.app']);
    expect(calls[0]!.opts.timeoutMs).toBeGreaterThan(0);
  });

  it('launchAgent runs the fixed allowlisted argv with the configured cwd', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    await p.launchAgent('claude', '/Users/yusoof/work/infra');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(['/usr/bin/env', 'claude']);
    expect(calls[0]!.opts.cwd).toBe('/Users/yusoof/work/infra');
    expect(calls[0]!.opts.timeoutMs).toBeGreaterThan(0);
  });

  it('launchAgent rejects an agent outside the allowlist and a bad cwd', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    await expect(p.launchAgent('skynet', '/Users/yusoof/work')).rejects.toThrow(/allowlist/);
    await expect(p.launchAgent('claude', 'not/absolute')).rejects.toThrow(/absolute/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a nonzero child exit as a single-line error', async () => {
    const { spawn } = recordingSpawner([{ code: 5, stdout: '', stderr: 'open: file did not open\n' }]);
    const p = new MacPlatform(spawn, () => true);
    let message = '';
    try {
      await p.openUrl('https://x.example/');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('open');
    expect(message.split('\n')).toHaveLength(1);
  });
});

describe('MacPlatform platform gating', () => {
  it('is unsupported and refuses everything on Linux before spawning anything', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn);
    expect(p.supported).toBe(false);
    for (const attempt of [
      () => p.openApp('com.apple.Terminal'),
      () => p.openUrl('https://x.example/'),
      () => p.choose('pick', ['a']),
      () => p.lock(),
      () => p.launchAgent('claude', '/Users/yusoof/work'),
    ]) {
      let message = '';
      try {
        await attempt();
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toContain('unsupported platform');
    }
    expect(calls).toHaveLength(0);
    expect(p.name).toBe('mac');
  });

  it('exposes UnsupportedPlatformError (not a generic Error) off macOS', async () => {
    const p = new MacPlatform(async () => ({ code: 0, stdout: '', stderr: '' }));
    try {
      await p.lock();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedPlatformError);
    }
  });
});
