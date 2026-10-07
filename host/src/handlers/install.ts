/**
 * install/uninstall land with the m4 doctor/install feature. Until then the
 * CLI dispatches here and refuses honestly instead of pretending something
 * happened.
 */
import type { CliIo } from './context.ts';

async function runNotImplemented(name: string, note: string, io: CliIo): Promise<number> {
  io.err(`error: ${name}: not implemented yet (${note}); nothing was changed`);
  return 1;
}

/** install/uninstall do not need a valid config or a supported platform yet. */
export async function runInstall(
  command: 'install' | 'uninstall',
  dryRun: boolean,
  io: CliIo,
): Promise<number> {
  return runNotImplemented(
    dryRun ? `${command} --dry-run` : command,
    'planned for the m4 install feature',
    io,
  );
}
