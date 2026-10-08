/**
 * study: open the configured study URLs, in order, and nothing else. The
 * handler never fills in forms, never submits, never answers and never
 * marks attendance; it opens pages and the operator does the rest.
 */
import type { HandlerCtx } from './context.ts';

export async function runStudy(ctx: HandlerCtx): Promise<number> {
  const urls = ctx.loaded.config.study.urls;

  if (ctx.dryRun) {
    ctx.io.out('study: dry run; nothing is opened');
    for (const url of urls) ctx.io.out(`study: would open ${url}`);
    return 0;
  }

  if (urls.length === 0) {
    ctx.io.out('study: no study URLs are configured; nothing opened');
    return 0;
  }
  for (const url of urls) await ctx.platform.openUrl(url);
  ctx.io.out(`study: opened ${urls.length} URL(s)`);
  return 0;
}
