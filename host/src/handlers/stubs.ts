/**
 * Handlers that land with the m4 handlers/install features. The skeleton
 * dispatches to them after the config and platform checks and then refuses
 * honestly instead of pretending something happened.
 */
import type { CliIo } from './context.ts';
import type { HandlerCtx } from './context.ts';

async function runNotImplemented(name: string, note: string, io: CliIo): Promise<number> {
  io.err(`error: ${name}: not implemented yet (${note}); nothing was changed`);
  return 1;
}

export async function runAction(ctx: HandlerCtx): Promise<number> {
  return runNotImplemented('action', 'planned for the m4 handlers feature', ctx.io);
}

export async function runIncident(ctx: HandlerCtx): Promise<number> {
  return runNotImplemented('incident', 'planned for the m4 handlers feature', ctx.io);
}

export async function runStudy(ctx: HandlerCtx): Promise<number> {
  return runNotImplemented('study', 'planned for the m4 handlers feature', ctx.io);
}

export async function runLock(ctx: HandlerCtx): Promise<number> {
  return runNotImplemented('lock', 'planned for the m4 handlers feature', ctx.io);
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
