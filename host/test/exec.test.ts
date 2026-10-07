/**
 * Subprocess runner (VAL-HOST-026/027/028): argv arrays with no shell, a
 * bounded timeout that kills the child, and a minimal allowlisted environment.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { run } from '../src/exec.ts';

const INJECTION = '"; touch /tmp/pwn-x #';

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
