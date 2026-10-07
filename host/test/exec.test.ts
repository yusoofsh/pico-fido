/**
 * Subprocess runner (VAL-HOST-026/027/028): argv arrays with no shell, a
 * bounded timeout that kills the child, and a minimal allowlisted environment.
 *
 * The inherited-pipe probe below is a real Linux regression (VAL-HOST-027):
 * a direct child starts a long-lived helper that inherits the runner's
 * stdout/stderr pipes, so pipe EOF arrives only when the helper exits —
 * long after the direct child is dead. The runner's deadline must not wait
 * for that EOF.
 */
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { run } from '../src/exec.ts';

const INJECTION = '"; touch /tmp/pwn-x #';

/** Process state from /proc: null when the PID is gone. */
function procInfo(pid: number): { state: string; comm: string; fd1: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm is in parentheses and may contain spaces; state follows the last ')'.
    const close = stat.lastIndexOf(')');
    const state = stat.slice(close + 2).trim().split(' ')[0] ?? '?';
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    let fd1 = '';
    try {
      fd1 = readlinkSync(`/proc/${pid}/fd/1`);
    } catch {
      fd1 = 'unreadable';
    }
    return { state, comm, fd1 };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  const info = procInfo(pid);
  return info !== null && info.state !== 'Z';
}

/** Poll until the process is gone or a zombie (terminated, holds no fds); bounded. */
async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** PIDs recorded by the probe child; killed in a finally path. */
const probePids: number[] = [];

afterAll(() => {
  // Belt and braces: the tests kill these in their own finally paths, but a
  // failed assertion must not leave a pipe-holding helper behind either.
  for (const pid of probePids.splice(0)) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

describe('run(): argv arrays, never a shell', () => {
  it('passes a hostile argument as one literal argv element', async () => {
    const r = await run(['/bin/echo', INJECTION], { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${INJECTION}\n`);
    expect(r.stderr).toBe('');
    expect(existsSync('/tmp/pwn-x')).toBe(false);
  });

  it('reports argv verbatim through a child that prints its argv as JSON', async () => {
    const script = 'console.log(JSON.stringify(Bun.argv.slice(1)))';
    const r = await run([process.execPath, '-e', script, INJECTION, 'second arg'], {
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([INJECTION, 'second arg']);
  });

  it('rejects a relative program path so no PATH guessing happens in pipico', async () => {
    let message = '';
    try {
      await run(['echo', 'hi'], { timeoutMs: 10_000 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('absolute');
  });

  it('rejects an empty argv and a non-finite timeout before spawning anything', async () => {
    await expect(run([], { timeoutMs: 10_000 })).rejects.toThrow(/argv/);
    await expect(run(['/bin/echo'], { timeoutMs: 0 })).rejects.toThrow(/timeout/);
    await expect(run(['/bin/echo'], { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(/timeout/);
  });
});

describe('run(): bounded timeout', () => {
  it('kills a sleeping child and rejects within the bound', async () => {
    const started = Date.now();
    let caught: unknown;
    try {
      await run(['/bin/sleep', '30'], { timeoutMs: 500 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('timeout');
    // The test itself must finish far below the 30 s child runtime.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it('still returns normally when the child finishes before the timeout', async () => {
    const r = await run(['/bin/echo', 'fast'], { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('fast\n');
  });

  it('settles at the deadline even when a helper inherits the pipes (real Linux probe)', async () => {
    // Regression for VAL-HOST-027. A direct child writes both PIDs to an
    // evidence file, starts `/bin/sleep 30` as a helper that inherits the
    // runner's stdout/stderr pipes, then stays alive well past the deadline.
    // The helper keeps the pipes open for 30 s unless this test kills it by
    // PID, so pipe EOF cannot arrive before then. The runner must settle
    // with a timeout error far earlier, killing the direct child; the helper
    // is NOT guaranteed to be killed (no process-tree killing).
    const scratch = mkdtempSync(join(tmpdir(), 'pipico-exec-probe-'));
    const evidence = join(scratch, 'pids');
    const probePath = join(scratch, 'probe.sh');
    const probe = [
      '#!/bin/bash',
      // Record the direct child PID first so cleanup can always find it.
      'printf \'child %s\\n\' "$$" > "$EVIDENCE"',
      '/bin/sleep 30 &',
      'helper=$!',
      'printf \'helper %s\\n\' "$helper" >> "$EVIDENCE"',
      'echo "probe: helper $helper started with inherited pipes"',
      // Stay alive well past the 250 ms deadline.
      'exec /bin/sleep 60',
      '',
    ].join('\n');
    await Bun.write(probePath, probe);

    let childPid = 0;
    let helperPid = 0;
    const started = Date.now();
    let caught: unknown;
    try {
      await run(['/bin/bash', probePath], {
        timeoutMs: 250,
        env: { PATH: '/usr/bin:/bin', EVIDENCE: evidence },
      });
    } catch (e) {
      caught = e;
    } finally {
      // Read the PIDs the probe recorded and stop the helper by PID.
      try {
        const lines = readFileSync(evidence, 'utf8').trim().split('\n');
        for (const line of lines) {
          const [kind, pid] = line.split(' ');
          if (kind === 'child') childPid = Number(pid);
          if (kind === 'helper') helperPid = Number(pid);
        }
      } catch {
        // The probe never got far enough to write evidence.
      }
      probePids.push(...[childPid, helperPid].filter((p) => p > 0));
      for (const pid of [childPid, helperPid]) {
        if (pid > 0 && isAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      if (helperPid > 0) await waitDead(helperPid, 2_000);
      if (childPid > 0) await waitDead(childPid, 2_000);
    }
    const elapsed = Date.now() - started;

    expect(childPid, 'probe recorded its own PID').toBeGreaterThan(0);
    expect(helperPid, 'probe recorded its helper PID').toBeGreaterThan(0);
    // The runner rejected with a timeout error...
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('timeout');
    // ...under a generous 5 s return ceiling, long before the helper's
    // 30 s pipe EOF. (The test timeout is 40 s only so a regression shows
    // the true elapsed time instead of aborting the test harness.)
    expect(elapsed).toBeLessThan(5_000);
    // The direct child was SIGKILLed: gone or a reaped zombie.
    expect(await waitDead(childPid, 2_000)).toBe(true);
    // Evidence of the pipe inheritance the runner must survive: the helper
    // is a sleep whose stdout is a pipe. (Checked while it is still alive;
    // if it already exited on its own this only weakens the probe.)
    const helperInfo = procInfo(helperPid);
    if (helperInfo !== null) {
      expect(helperInfo.comm).toBe('sleep');
      expect(helperInfo.fd1).toContain('pipe');
    }
  }, 40_000);
});

describe('run(): minimal environment', () => {
  it('gives the child only allowlisted variables, never the parent env', async () => {
    const script = 'console.log(JSON.stringify(process.env))';
    const r = await run([process.execPath, '-e', script], {
      timeoutMs: 10_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/fake-home',
        LANG: 'C',
        // Canaries that must NOT cross into the child:
        // PIPICO_CANARY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY
      } as Record<string, string>,
    });
    expect(r.code).toBe(0);
    const childEnv = JSON.parse(r.stdout) as Record<string, string>;
    expect(childEnv.PATH).toBe('/usr/bin:/bin');
    expect(childEnv.HOME).toBe('/tmp/fake-home');
    expect(childEnv.PIPICO_CANARY).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('builds the default environment from the allowlist only', async () => {
    const script = 'console.log(JSON.stringify(process.env))';
    const r = await run([process.execPath, '-e', script], { timeoutMs: 10_000 });
    const childEnv = JSON.parse(r.stdout) as Record<string, string>;
    for (const name of Object.keys(childEnv)) {
      expect(['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']).toContain(name);
    }
    expect(childEnv.PATH).not.toBeUndefined();
  });

  it('never passes stdin through to the child', async () => {
    // The child reads stdin; with stdin ignored it must see EOF immediately.
    const script = 'const t = await Bun.readableStreamToText(Bun.stdin.stream()); console.log(JSON.stringify(t))';
    const r = await run([process.execPath, '-e', script], { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toBe('');
  });
});

describe('run(): failures are contained', () => {
  it('reports a missing program as a single-line spawn error', async () => {
    let message = '';
    try {
      await run(['/no/such/program/anywhere', 'x'], { timeoutMs: 10_000 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('/no/such/program/anywhere');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('returns (never throws on) a nonzero child exit, with the child output', async () => {
    // /usr/bin/env with a name that cannot exist prints to stderr and exits 127.
    const r = await run(['/usr/bin/env', 'pipico-no-such-binary-xyz'], { timeoutMs: 10_000 });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('pipico-no-such-binary-xyz');
  });
});
