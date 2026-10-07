/**
 * MacPlatform tests with an injected spawner (real macOS execution stays
 * NOT_RUN). VAL-HOST-029: workspace names reach osascript as separate argv
 * items consumed by "on run argv", never interpolated into the script text.
 * VAL-HOST-025: the lock action is one fixed argv.
 */
import { describe, expect, it } from 'bun:test';
import { CHOOSER_SCRIPT, CHOOSER_TIMEOUT_MS, LOCK_SCRIPT, LOCK_TIMEOUT_MS, MacPlatform, OSASCRIPT_BIN } from '../src/platform/mac.ts';
import { SpawnError, type RunOptions, type RunResult } from '../src/exec.ts';
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

  it('launchAgent runs the fixed allowlisted argv with the configured cwd', async () => {    const { calls, spawn } = recordingSpawner([]);
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

describe('MacPlatform.lock: the fixed native session lock (VAL-HOST-025)', () => {
  it('runs exactly [osascript, -e, LOCK_SCRIPT] once, with a bounded timeout', async () => {
    const { calls, spawn } = recordingSpawner([]);
    const p = new MacPlatform(spawn, () => true);
    await p.lock();
    expect(calls).toHaveLength(1);
    const { argv, opts } = calls[0]!;
    expect(argv).toEqual([OSASCRIPT_BIN, '-e', LOCK_SCRIPT]);
    expect(opts.timeoutMs).toBe(LOCK_TIMEOUT_MS);
    expect(Number.isFinite(opts.timeoutMs)).toBe(true);
    expect(opts.timeoutMs).toBeGreaterThan(0);
  });

  it('the script is a static constant: Control-Command-Q via System Events, no screensaver, no data', () => {
    // Apple's documented "Lock Screen" shortcut, dispatched through System Events.
    expect(LOCK_SCRIPT).toContain('System Events');
    expect(LOCK_SCRIPT).toContain('keystroke "q"');
    expect(LOCK_SCRIPT).toContain('{command down, control down}');
    // Static text: no template holes, no data, no `open`, no screensaver fallback.
    expect(LOCK_SCRIPT).not.toContain('${');
    expect(LOCK_SCRIPT.toLowerCase()).not.toContain('screensaver');
    expect(LOCK_SCRIPT).not.toContain('/usr/bin/open');
  });

  it('propagates a timeout as an error and never falls back to a second spawn', async () => {
    let calls = 0;
    const p = new MacPlatform(async () => {
      calls++;
      throw new SpawnError('timeout: /usr/bin/osascript was killed after 60000 ms', 'timeout');
    }, () => true);
    let message = '';
    try {
      await p.lock();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('lock');
    expect(message).toContain('timeout');
    expect(calls).toBe(1); // no fallback, no retry
  });

  it('maps an Accessibility denial to one clear actionable permission error, without a fallback', async () => {
    let calls = 0;
    const p = new MacPlatform(async () => {
      calls++;
      return {
        code: 1,
        stdout: '',
        stderr: 'execution error: System Events got an error: osascript is not allowed assistive access. (-1719)',
      };
    }, () => true);
    let message = '';
    try {
      await p.lock();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('permission');
    expect(message).toContain('Accessibility');
    expect(message).toContain('System Events');
    expect(message.split('\n')).toHaveLength(1);
    expect(calls).toBe(1); // no screensaver fallback, no retry
  });

  it('maps an Automation denial (user authorization failed) to the same clear permission error', async () => {
    const p = new MacPlatform(async () => ({
      code: 1,
      stdout: '',
      stderr: 'execution error: System Events got an error: User authorization failed. (-1743)',
    }), () => true);
    let message = '';
    try {
      await p.lock();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('permission');
    expect(message).toContain('Automation');
    expect(message).not.toContain('failed (exit'); // not the generic failure line
  });

  it('surfaces a plain osascript failure with the exit code and detail, on one line', async () => {
    const p = new MacPlatform(async () => ({
      code: 2,
      stdout: '',
      stderr: 'execution error: System Events got an error: bogus-internal-condition.',
    }), () => true);
    let message = '';
    try {
      await p.lock();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('exit 2');
    expect(message).toContain('bogus-internal-condition');
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
