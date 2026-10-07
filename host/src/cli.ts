/**
 * pipico — host companion CLI for the Yusoofs Pipico FIDO key.
 *
 * Exit codes: 0 ok · 1 error · 2 usage · 3 invalid config · 4 unsupported
 * platform. The command surface and the config schema are documented in
 * host/README.md. All machine actions go through the Platform interface
 * (src/platform/); on non-macOS hosts every action handler exits 4 with
 * "unsupported platform" without doing anything.
 */
import { ConfigError, echoSafe, loadConfig } from './config.ts';
import { UsageError } from './errors.ts';
import { getPlatform, UnsupportedPlatformError } from './platform/index.ts';
import type { CliIo, HandlerCtx } from './handlers/context.ts';
import { runAttention } from './handlers/attention.ts';
import { runDoctor } from './handlers/doctor.ts';
import type { DoctorConfigOutcome } from './handlers/doctor.ts';
import { runInstall } from './handlers/install.ts';
import { runAction } from './handlers/action.ts';
import { runIncident } from './handlers/incident.ts';
import { runStudy } from './handlers/study.ts';
import { runLock } from './handlers/lock.ts';

const GATED: Record<string, (ctx: HandlerCtx) => Promise<number>> = {
  action: runAction,
  attention: runAttention,
  incident: runIncident,
  study: runStudy,
  lock: runLock,
};

export const USAGE = `pipico - host companion CLI for the Yusoofs Pipico FIDO key

Usage: pipico <command> [options]

Commands:
  doctor      Read-only checks: config, bun, platform, executable path
  action      Pick a workspace explicitly and open it (F13)
  attention   Open the configured attention URL (F14)
  incident    Scaffold a local incident folder and open monitoring pages (F15)
  study       Open the configured study URLs
  lock        Lock the workstation (F16, macOS only)
  install     Per-user install of the pipico config skeleton and wrappers
  uninstall   Remove only what "pipico install" created

Options:
  --config <path>  Config file; beats $PIPICO_CONFIG, which beats
                   $XDG_CONFIG_HOME|$HOME/.config/pipico/config.json
  --dry-run        Print the planned changes and change nothing (install/uninstall)
  --help, -h       Show this help

Platform: real actions run only on macOS; on other hosts every action handler
exits nonzero with "unsupported platform" without doing anything. Tests and
local experiments use PIPICO_PLATFORM=fake (see host/README.md).`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Env = Record<string, string | undefined>;

interface ParsedArgs {
  command: string | undefined;
  configFlag: string | undefined;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: undefined, configFlag: undefined, dryRun: false, help: false };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || value === '') {
        throw new UsageError('--config requires a file path (see "pipico --help")');
      }
      parsed.configFlag = value;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value === '') throw new UsageError('--config requires a file path (see "pipico --help")');
      parsed.configFlag = value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      throw new UsageError(`unknown option: ${arg} (see "pipico --help")`);
    }
    if (!commandSeen) {
      parsed.command = arg;
      commandSeen = true;
      continue;
    }
    throw new UsageError(`unexpected argument: ${arg} (see "pipico --help")`);
  }
  return parsed;
}

export async function runCli(argv: string[], env: Env): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line: string) => out.push(`${line}\n`),
    err: (line: string) => err.push(`${line}\n`),
  };

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }

  if (parsed.help || parsed.command === 'help') {
    return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
  }

  const command = parsed.command;
  if (command === undefined) {
    return { code: 2, stdout: '', stderr: `usage: pipico <command> [options] (see "pipico --help")\n` };
  }

  const isKnown =
    command === 'doctor' || command === 'install' || command === 'uninstall' || GATED[command] !== undefined;
  if (!isKnown) {
    return { code: 2, stdout: '', stderr: `unknown command: ${echoSafe(command)}\n\n${USAGE}\n` };
  }

  try {
    if (command === 'doctor') {
      // Read-only diagnostics: report every check instead of stopping at the
      // first problem. A broken config is exit 3, an unsupported platform 4.
      const platform = getPlatform(env);
      let outcome: DoctorConfigOutcome;
      try {
        outcome = { ok: true, loaded: loadConfig(parsed.configFlag, env) };
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        outcome = { ok: false, errors: e.errors };
      }
      const code = await runDoctor(outcome, platform, io);
      return { code, stdout: out.join(''), stderr: err.join('') };
    }

    if (command === 'install' || command === 'uninstall') {
      const code = await runInstall(command, parsed.dryRun, io);
      return { code, stdout: out.join(''), stderr: err.join('') };
    }

    // Action handlers: refuse an unsupported platform BEFORE touching
    // anything (no subprocess, no file), then load and validate the config
    // strictly, then run the handler.
    const handler = GATED[command]!;
    const platform = getPlatform(env);
    if (!platform.supported) {
      throw new UnsupportedPlatformError(
        `unsupported platform: ${process.platform} (pipico performs actions only on macOS; set PIPICO_PLATFORM=fake for testing)`,
      );
    }
    const loaded = loadConfig(parsed.configFlag, env);
    const ctx: HandlerCtx = { loaded, platform, io, dryRun: parsed.dryRun };
    const code = await handler(ctx);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } catch (e) {
    const stdout = out.join('');
    if (e instanceof ConfigError) {
      return { code: 3, stdout, stderr: e.errors.map((line) => `config error: ${line}\n`).join('') };
    }
    if (e instanceof UsageError) return { code: 2, stdout, stderr: `${e.message}\n` };
    if (e instanceof UnsupportedPlatformError) return { code: 4, stdout, stderr: `${e.message}\n` };
    const message = e instanceof Error ? e.message : String(e);
    return { code: 1, stdout, stderr: `error: ${message}\n` };
  }
}

export async function main(argv: string[], env: Env): Promise<number> {
  const result = await runCli(argv, env);
  if (result.stdout !== '') await Bun.write(Bun.stdout, result.stdout);
  if (result.stderr !== '') await Bun.write(Bun.stderr, result.stderr);
  return result.code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
