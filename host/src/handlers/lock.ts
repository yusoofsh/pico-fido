/**
 * lock (F16): the native macOS lock action and nothing else. The platform
 * implementation runs one fixed argv (see src/platform/mac.ts); pipico never
 * changes any setting and never reverses a lock.
 */
import type { HandlerCtx } from './context.ts';

export async function runLock(ctx: HandlerCtx): Promise<number> {
  if (ctx.dryRun) {
    ctx.io.out('lock: dry run; the native lock action would run');
    return 0;
  }
  await ctx.platform.lock();
  ctx.io.out('lock: done');
  return 0;
}
