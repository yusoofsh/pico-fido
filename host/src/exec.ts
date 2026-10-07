/**
 * The one subprocess runner for pipico. Every spawn in the CLI goes through
 * `run`:
 *
 * - argv arrays only; the arguments reach the child verbatim. No shell is
 *   ever involved and no string is ever split or interpolated into a
 *   command line.
 * - a finite `timeoutMs` is mandatory; the child is killed at the deadline.
 * - the child gets an explicit minimal environment (`minimalEnv`), never the
 *   parent's environment; pipico never enumerates environment variables.
 * - stdin is ignored: nothing the user types (or the platform pipes) can
 *   reach the child, and the child cannot wait on a terminal.
 *
 * A nonzero child exit is a RESULT (returned, not thrown) so callers can
 * decide policy. The runner itself only rejects on misuse, spawn failure or
 * timeout — each with a single-line message.
 */

export interface RunOptions {
  /** Working directory for the child, when one is needed (already validated). */
  cwd?: string;
  /** Mandatory finite deadline in milliseconds; the child is killed at it. */
  timeoutMs: number;
  /** Explicit child environment; defaults to the minimal allowlisted env. */
  env?: Record<string, string>;
}

export interface RunResult {
  /** Child exit code (0..255; 128+signal when killed by a signal). */
  code: number;
  stdout: string;
  stderr: string;
}

/** A spawn that never started, or a child killed at the timeout. */
export class SpawnError extends Error {
  readonly reason: 'usage' | 'spawn' | 'timeout';

  constructor(message: string, reason: 'usage' | 'spawn' | 'timeout') {
    super(message);
    this.name = 'SpawnError';
    this.reason = reason;
  }
}

/** Environment variables a child may receive; everything else is dropped. */
const ENV_ALLOWLIST: readonly string[] = ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'TMPDIR', 'USER'];

/**
 * Build the child environment from an explicit allowlist. Values come from
 * the parent env by name only: there is no enumeration, no spreading and no
 * harvesting, so parent-only variables (tokens, secrets, PIPICO_* test
 * knobs) never reach a child.
 */
export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** Spawn `argv` verbatim. See the module comment for the contract. */
export async function run(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
  if (argv.length === 0 || !argv[0]!.startsWith('/')) {
    throw new SpawnError('run: the first argv element must be an absolute program path', 'usage');
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new SpawnError('run: timeoutMs must be a positive finite number', 'usage');
  }
  const env = opts.env ?? minimalEnv();

  const proc = (() => {
    try {
      return Bun.spawn([...argv], {
        cwd: opts.cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (e) {
      throw new SpawnError(`cannot start ${argv[0]!}: ${oneLine(e instanceof Error ? e.message : String(e))}`, 'spawn');
    }
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9); // SIGKILL: the deadline is a hard bound
  }, opts.timeoutMs);

  try {
    // Drain both pipes concurrently so a chatty child cannot deadlock on a
    // full pipe buffer.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) {
      throw new SpawnError(`timeout: ${argv[0]!} was killed after ${opts.timeoutMs} ms`, 'timeout');
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** First line of a child's output, for single-line error messages. */
export function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return oneLine(line);
}
