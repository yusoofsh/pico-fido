/**
 * doctor: read-only checks. The skeleton checks the config (the strict
 * loader), the Bun runtime, the platform and the executable path. It exits
 * nonzero when a check fails: 3 for config problems, 4 for an unsupported
 * platform. The install feature extends doctor with USB presence and full
 * bindings guidance.
 */
import type { LoadedConfig } from '../config.ts';
import type { CliIo } from './context.ts';
import type { Platform } from '../platform/index.ts';

export interface DoctorConfigOutcome {
  ok: boolean;
  loaded?: LoadedConfig;
  errors?: string[];
}

export async function runDoctor(
  outcome: DoctorConfigOutcome,
  platform: Platform,
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

  if (platform.supported) {
    io.out(`platform: ok (${platform.name})`);
  } else {
    io.out(
      `platform: FAIL: unsupported platform: ${process.platform} (pipico performs actions only on macOS; set PIPICO_PLATFORM=fake for testing)`,
    );
    if (code === 0) code = 4;
  }

  io.out(`entry: ${Bun.main}`);
  io.out('bindings: see host/README.md ("Binding F13-F16 in macOS Shortcuts")');
  io.out('usb: not checked (planned for the m4 install feature)');
  return code;
}
