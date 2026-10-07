/**
 * attention (F14): open exactly the configured attention URL. Nothing else:
 * no fallback URL, no discovery, no environment reading.
 */
import type { HandlerCtx } from './context.ts';

export async function runAttention(ctx: HandlerCtx): Promise<number> {
  await ctx.platform.openUrl(ctx.loaded.config.attentionUrl);
  ctx.io.out(`attention: opened ${ctx.loaded.config.attentionUrl}`);
  return 0;
}
