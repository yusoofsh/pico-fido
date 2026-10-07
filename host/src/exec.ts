/**
 * The one subprocess runner for pipico. Every spawn in the CLI goes through
 * `run`:
 *
 * - argv arrays only; the arguments reach the child verbatim. No shell is
 *   ever involved and no string is ever split or interpolated into a
 *   command line.
 * - a finite `timeoutMs` is mandatory: `run()` always settles by the
 *   deadline, and the direct child is SIGKILLed at it. The deadline never
 *   waits for output pipe EOF or for the child's completion promise: a
 *   helper or grandchild that inherited the runner's pipes can hold them
 *   open long after the direct child is gone. Descendants are neither
 *   killed nor waited for.
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
  /** Mandatory finite deadline in milliseconds; run() settles by it and the direct child is SIGKILLed at it. */
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

/** The shape every spawn site goes through (injected in tests). */
export type SpawnFn = (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;

/** A spawn that never started, or a run that did not settle by its deadline. */
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

/**
 * Read one output pipe to EOF, collecting the text. The returned `text`
 * promise NEVER rejects: on a stream error (or after `stop()`) it resolves
 * to whatever was collected, so a promise left behind by the deadline can
 * never become an unhandled rejection. `stop()` cancels the reader; it is
 * the runner's owned output consumption, and nothing else reads this pipe
 * (stdin is ignored).
 */
interface OutputPipe {
  text: Promise<string>;
  stop: () => void;
}

function readPipe(stream: ReadableStream<Uint8Array>): OutputPipe {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = '';
  const consume = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  })();
  return {
    text: consume.catch(() => text),
    stop: () => {
      void reader.cancel().catch(() => {});
    },
  };
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

  const stdoutPipe = readPipe(proc.stdout);
  const stderrPipe = readPipe(proc.stderr);

  // The deadline path. It never awaits output EOF or the child-completion
  // promise: a helper or grandchild that inherited the runner's pipes can
  // hold them open indefinitely after the direct child is SIGKILLed, and
  // the deadline is a hard bound on settlement.
  let rejectDeadline: (e: SpawnError) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    try {
      proc.kill(9); // SIGKILL the direct child: the deadline is a hard bound
    } catch {
      // The child already exited on its own; that cannot unbound the deadline.
    }
    // Stop consuming output now; abandoned reads settle unobserved and never
    // reject (see readPipe). Descendants are NOT killed: no process-tree
    // killing, no claim of descendant termination.
    stdoutPipe.stop();
    stderrPipe.stop();
    rejectDeadline(new SpawnError(`timeout: ${argv[0]!} did not finish within ${opts.timeoutMs} ms`, 'timeout'));
  }, opts.timeoutMs);

  // The normal path: the direct child's exit code, then the collected
  // output. Both awaited promises never reject, so if the deadline wins the
  // race this promise is abandoned safely — it settles unobserved and is
  // collected, without ever surfacing an unhandled rejection.
  const settled = (async (): Promise<RunResult> => {
    const code = await proc.exited.then(
      (code) => code,
      () => -1,
    );
    const [stdout, stderr] = await Promise.all([stdoutPipe.text, stderrPipe.text]);
    return { code, stdout, stderr };
  })();

  try {
    return await Promise.race([settled, deadline]);
  } finally {
    // A normal settlement must disarm the deadline so it can never reject
    // later (which would be an unhandled rejection).
    clearTimeout(timer);
  }
}

/** First line of a child's output, for single-line error messages. */
export function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return oneLine(line);
}
