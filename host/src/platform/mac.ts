/**
 * MacPlatform: the real macOS execution behind the Platform interface.
 *
 * Every operation is one fixed argv through the shared runner (src/exec.ts):
 * argv arrays, no shell, a finite per-operation timeout, minimal env.
 *
 * - openUrl:    /usr/bin/open <url>
 * - openApp:    /usr/bin/open -a <appId> [<path>]
 * - lock:       /usr/bin/osascript -e <LOCK_SCRIPT>
 *               One static AppleScript that sends Apple's documented
 *               Control-Command-Q "Lock Screen" shortcut through System
 *               Events. This locks the session immediately and does not
 *               depend on any screensaver or password-delay setting; pipico
 *               never changes any setting and never reverses a lock.
 * - launchAgent: the fixed allowlisted argv from src/agents.ts
 * - choose:     /usr/bin/osascript -e <static script> <prompt> <options...>
 *               The script's answer is tagged (cancel tag, or a select tag
 *               plus the picked option on the next line) so cancellation is
 *               distinguishable from selecting any workspace id, including
 *               one literally named CANCELED.
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
import { firstLine, run, type RunOptions, type RunResult, type SpawnFn } from '../exec.ts';
import { checkPath, checkUrl } from '../validate.ts';
import { UnsupportedPlatformError, type Platform } from './index.ts';

export type { SpawnFn };

export const OPEN_BIN = '/usr/bin/open';
export const OSASCRIPT_BIN = '/usr/bin/osascript';

/**
 * The one fixed native lock operation: a static AppleScript that sends
 * Apple's documented Control-Command-Q "Lock Screen" shortcut through
 * System Events. The keystroke locks the session immediately, independent
 * of any screensaver or password-delay setting. The text is a source
 * constant: no config or user data is ever interpolated, and there is no
 * screensaver fallback.
 */
export const LOCK_SCRIPT =
  'tell application "System Events" to keystroke "q" using {command down, control down}';

/** Long enough for `open` to hand off to LaunchServices; still finite. */
export const OPEN_TIMEOUT_MS = 15_000;
/** Long enough for a first-use permission dialog to be answered; still finite. */
export const LOCK_TIMEOUT_MS = 60_000;
/** The chooser dialog waits for the user; the bound must still be finite. */
export const CHOOSER_TIMEOUT_MS = 300_000;
/** pipico waits for the agent to exit; hard stop after six hours. */
export const AGENT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export const CHOOSER_CANCEL_TAG = 'pipico-chooser-cancel';
export const CHOOSER_SELECT_TAG = 'pipico-chooser-selected';

/**
 * The static chooser script. Data never appears in this text.
 *
 * The answer is tagged so cancellation stays distinguishable from every
 * selection, including a workspace id that happens to equal a tag or the
 * word CANCELED (no schema-valid id is a reserved sentinel):
 * - cancel:    the script returns exactly the cancel tag;
 * - selection: the script returns "<select tag><linefeed><picked option>".
 * MacPlatform decodes the tag FIRST and only then reads the picked option,
 * so the picked id round-trips byte-for-byte.
 */
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
  if picked is false then return "${CHOOSER_CANCEL_TAG}"
  return "${CHOOSER_SELECT_TAG}" & linefeed & ((item 1 of picked) as text)
end run`;

/** Control characters never travel into an osascript dialog. */
const CONTROL_FREE = /^[^\u0000-\u001f\u007f]*$/;

/**
 * What osascript prints when macOS refuses the lock keystroke because the
 * Automation (control System Events) or Accessibility (send keystrokes)
 * permission was not granted. Matched case-insensitively against the
 * child's first output line.
 */
const LOCK_PERMISSION_PATTERN =
  /not allowed assistive access|not allowed to send keystrokes|user authorization failed|not authorized|assistive access/i;

/**
 * One clear, actionable line for a refused lock keystroke. It names the
 * exact permission to grant and states that nothing fell back and nothing
 * was changed. Detail is already single-line; it is echoed safely.
 */
function lockPermissionLine(code: number, detail: string): string {
  return (
    `lock: macOS denied permission to send the lock keystroke (exit ${code}: ${echoSafe(detail)}). ` +
    'Grant the app that runs pipico permission to control System Events: ' +
    'System Settings > Privacy & Security > Accessibility, and ' +
    'System Settings > Privacy & Security > Automation for the host app. ' +
    'Nothing was locked, no fallback was attempted and no setting was changed.'
  );
}

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
    // Decode the tag BEFORE looking at the picked option, so no offered id
    // (CANCELED included) can ever be mistaken for a cancellation.
    const out = result.stdout;
    if (out === `${CHOOSER_CANCEL_TAG}\n` || out === CHOOSER_CANCEL_TAG) return null;
    const selectPrefix = `${CHOOSER_SELECT_TAG}\n`;
    if (out.startsWith(selectPrefix)) {
      // osascript terminates the answer with one newline; the payload is
      // everything after the tag line, byte-for-byte.
      const picked = out.slice(selectPrefix.length).replace(/\n$/, '');
      if (!options.includes(picked)) {
        throw new Error(`choose: the chooser returned an unknown option (${echoSafe(picked)})`);
      }
      return picked;
    }
    throw new Error(`choose: unrecognized chooser response (${echoSafe(out)})`);
  }

  async lock(): Promise<void> {
    this.requireMac('lock');
    // One fixed static AppleScript through osascript: Control-Command-Q via
    // System Events. No screensaver, no fallback: whatever happens, exactly
    // one spawn is attempted and its failure is surfaced.
    let result: RunResult;
    try {
      result = await this.spawnFn([OSASCRIPT_BIN, '-e', LOCK_SCRIPT], { timeoutMs: LOCK_TIMEOUT_MS });
    } catch (e) {
      // Timeout or the child could not start: keep the runner's single-line
      // message, scoped to the lock operation.
      throw new Error(`lock: ${firstLine(e instanceof Error ? e.message : String(e))}`);
    }
    if (result.code !== 0) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout) || `(exit ${result.code})`;
      if (LOCK_PERMISSION_PATTERN.test(detail)) {
        throw new Error(lockPermissionLine(result.code, detail));
      }
      throw new Error(`lock: failed (exit ${result.code}): ${echoSafe(detail)}`);
    }
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
