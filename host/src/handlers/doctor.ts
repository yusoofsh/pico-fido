/**
 * doctor: read-only diagnostics. It never writes (it does not even construct
 * the fake platform, whose constructor truncates the log) and reports every
 * check instead of stopping at the first problem:
 *
 *   config      the strict loader (exit 3 on problems)
 *   bun         the runtime version this CLI is running on
 *   platform    real (macOS only) or fake (exit 4 when unsupported)
 *   executable  the per-user wrapper install creates (exit 5 when missing
 *               or unusable — run "pipico install")
 *   bindings    the F13-F16 → command mappings with absolute executable paths
 *   usb         OPTIONAL presence of the "Yusoofs Pipico" USB device —
 *               strictly informational; it never changes the exit code
 *
 * Exit codes: 0 all good; 3 config; 4 platform; 5 executable. The first
 * failing check in that order determines the code.
 */
import { existsSync, statSync } from 'node:fs';
import type { LoadedConfig } from '../config.ts';
import { bindingLines, executablePath, WRAPPER_RELATIVE } from '../bindings.ts';
import type { CliIo, Env } from './context.ts';
import type { PlatformSelection } from '../platform/index.ts';
import { checkUsbPresence } from '../usb.ts';

export interface DoctorConfigOutcome {
  ok: boolean;
  loaded?: LoadedConfig;
  errors?: string[];
}

export async function runDoctor(
  outcome: DoctorConfigOutcome,
  selection: PlatformSelection,
  env: Env,
  io: CliIo,
): Promise<number> {
  let code = 0;

  if (outcome.ok && outcome.loaded !== undefined) {
    const { config, path, source } = outcome.loaded;
    io.out(`config: ok (${path} via ${source}, ${Object.keys(config.workspaces).length} workspaces)`);
  } else {
    io.out('config: FAIL');
    for (const e of outcome.errors ?? []) io.err(`config error: ${e}`);
    code = 3;
  }

  io.out(`bun: ok (${Bun.version})`);

  if (selection.supported) {
    io.out(`platform: ok (${selection.name})`);
  } else {
    io.out(`platform: FAIL: ${selection.problem}`);
    if (code === 0) code = 4;
  }

  const home = env.HOME;
  if (home === undefined || home === '') {
    io.out('executable: FAIL: HOME is not set; cannot check the installed executable');
    if (code === 0) code = 5;
  } else {
    const exe = executablePath(home);
    const exeProblem = executableProblem(exe);
    if (exeProblem === null) {
      io.out(`executable: ok (${exe})`);
    } else {
      io.out(`executable: FAIL: ${exeProblem} (run "pipico install" to create ${exe})`);
      if (code === 0) code = 5;
    }
  }

  for (const line of bindingLines(home !== undefined && home !== '' ? executablePath(home) : `$HOME/${WRAPPER_RELATIVE}`)) {
    io.out(line);
  }

  const usb = await checkUsbPresence();
  io.out(`usb: ${usb.status === 'not-found' ? 'not found' : usb.status}${usb.detail !== '' ? `: ${usb.detail}` : ''}`);
  return code;
}

/** Why the installed wrapper is not usable, or null when it is. */
function executableProblem(exe: string): string | null {
  if (!existsSync(exe)) return `${exe} is not installed`;
  try {
    const st = statSync(exe);
    if (!st.isFile()) return `${exe} exists but is not a regular file`;
    if ((st.mode & 0o111) === 0) return `${exe} exists but is not executable`;
    return null;
  } catch {
    return `${exe} exists but cannot be inspected`;
  }
}
