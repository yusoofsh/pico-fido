/**
 * MacPlatform: the real macOS execution behind the Platform interface.
 *
 * Every operation is one fixed argv through the shared runner (src/exec.ts):
 * argv arrays, no shell, a finite per-operation timeout, minimal env.
 *
 * - openUrl:    /usr/bin/open <url>
 * - openApp:    /usr/bin/open -a <appId> [<path>]
 * - lock:       /usr/bin/open /System/Library/CoreServices/ScreenSaverEngine.app
 *               (starting the screen saver locks the workstation under the
 *               user's own existing settings; this platform never changes
 *               any setting and never reverses a lock)
 * - launchAgent: the fixed allowlisted argv from src/agents.ts
 * - choose:     /usr/bin/osascript -e <static script> <prompt> <options...>
 *
 * The chooser is injection-safe by construction: CHOOSER_SCRIPT is a source
 * constant, and the prompt and every option are passed as separate argv
 * items that the script reads via "on run argv". No data is ever
 * interpolated into the script text.
 *
 * The spawner and the platform check are constructor-injectable so tests can
 * record argv without a Mac. Real macOS execution is NOT_RUN in this
 * mission (no Mac is attached).
 */
import { AGENT_ALLOWLIST, APP_ALLOWLIST, echoSafe } from '../config.ts';
import { agentArgv } from '../agents.ts';
import { firstLine, run, type RunOptions, type RunResult } from '../exec.ts';
import { checkPath, checkUrl } from '../validate.ts';
import { UnsupportedPlatformError, type Platform } from './index.ts';

export const OPEN_BIN = '/usr/bin/open';
export const OSASCRIPT_BIN = '/usr/bin/osascript';
/** Starting the screen saver is the native lock action; one fixed argv. */
export const LOCK_TARGET = '/System/Library/CoreServices/ScreenSaverEngine.app';

/** Long enough for `open` to hand off to LaunchServices; still finite. */
export const OPEN_TIMEOUT_MS = 15_000;
/** The chooser dialog waits for the user; the bound must still be finite. */
export const CHOOSER_TIMEOUT_MS = 300_000;
/** pipico waits for the agent to exit; hard stop after six hours. */
export const AGENT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export const CHOOSER_CANCEL_SENTINEL = 'CANCELED';

/** The static chooser script. Data never appears in this text. */
export const CHOOSER_SCRIPT = `on run argv
  set dlgPrompt to "pipico"
  set choices to {}
  set n to count of argv
  if n > 0 then set dlgPrompt to (item 1 of argv) as text
  if n > 1 then
    repeat with i from 2 to n
      copy (item i of argv) as text to end of choices
    end repeat
  end if
  set picked to choose from list choices with prompt dlgPrompt
  if picked is false then return "${CHOOSER_CANCEL_SENTINEL}"
  return item 1 of picked
end run`;

export type SpawnFn = (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;

/** Control characters never travel into an osascript dialog. */
const CONTROL_FREE = /^[^\u0000-\u001f\u007f]*$/;

export class MacPlatform implements Platform {
  readonly name = 'mac';

  constructor(
    private readonly spawnFn: SpawnFn = run,
    private readonly isMac: () => boolean = () => process.platform === 'darwin',
  ) {}

  get supported(): boolean {
    return this.isMac();
  }

  private requireMac(op: string): void {
    if (!this.isMac()) {
      throw new UnsupportedPlatformError(
        `unsupported platform: ${process.platform} (${op} acts only on macOS; set PIPICO_PLATFORM=fake for testing)`,
      );
    }
  }

  private async runChecked(argv: readonly string[], opts: RunOptions, what: string): Promise<RunResult> {
    const result = await this.spawnFn(argv, opts);
    if (result.code !== 0) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout) || `(exit ${result.code})`;
      throw new Error(`${what}: failed (exit ${result.code}): ${echoSafe(detail)}`);
    }
    return result;
  }

  async openApp(appId: string, targetPath?: string): Promise<void> {
    this.requireMac('openApp');
    if (!(APP_ALLOWLIST as readonly string[]).includes(appId)) {
      throw new Error(`openApp: app id ${JSON.stringify(appId)} is not allowlisted (allowed: ${APP_ALLOWLIST.join(', ')})`);
    }
    const argv: string[] = [OPEN_BIN, '-a', appId];
    if (targetPath !== undefined) {
      const problem = checkPath(targetPath);
      if (problem !== null) throw new Error(`openApp: configured path is invalid: ${problem}`);
      argv.push(targetPath);
    }
    await this.runChecked(argv, { timeoutMs: OPEN_TIMEOUT_MS }, 'openApp');
  }

  async openUrl(url: string): Promise<void> {
    this.requireMac('openUrl');
    const problem = checkUrl(url);
    if (problem !== null) throw new Error(`openUrl: configured URL is invalid: ${problem}`);
    await this.runChecked([OPEN_BIN, url], { timeoutMs: OPEN_TIMEOUT_MS }, 'openUrl');
  }

  async choose(prompt: string, options: string[]): Promise<string | null> {
    this.requireMac('choose');
    if (options.length === 0) throw new Error('choose: no options were offered');
    if (!CONTROL_FREE.test(prompt)) throw new Error('choose: prompt must be free of control characters');
    for (const opt of options) {
      if (!CONTROL_FREE.test(opt)) throw new Error('choose: options must be free of control characters');
    }
    // Data travels as argv only; CHOOSER_SCRIPT is a constant.
    const argv = [OSASCRIPT_BIN, '-e', CHOOSER_SCRIPT, prompt, ...options];
    const result = await this.runChecked(argv, { timeoutMs: CHOOSER_TIMEOUT_MS }, 'choose');
    const picked = result.stdout.trim();
    if (picked === CHOOSER_CANCEL_SENTINEL) return null;
    if (!options.includes(picked)) {
      throw new Error(`choose: the chooser returned an unknown option (${echoSafe(picked)})`);
    }
    return picked;
  }

  async lock(): Promise<void> {
    this.requireMac('lock');
    await this.runChecked([OPEN_BIN, LOCK_TARGET], { timeoutMs: OPEN_TIMEOUT_MS }, 'lock');
  }

  async launchAgent(agent: string, cwd: string): Promise<void> {
    this.requireMac('launchAgent');
    if (!(AGENT_ALLOWLIST as readonly string[]).includes(agent)) {
      throw new Error(`launchAgent: agent ${JSON.stringify(agent)} is not allowlisted (allowed: ${AGENT_ALLOWLIST.join(', ')})`);
    }
    const problem = checkPath(cwd);
    if (problem !== null) throw new Error(`launchAgent: configured cwd is invalid: ${problem}`);
    await this.runChecked([...agentArgv(agent)], { cwd, timeoutMs: AGENT_TIMEOUT_MS }, 'launchAgent');
  }
}
