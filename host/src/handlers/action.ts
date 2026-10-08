/**
 * action (F13): pick a workspace EXPLICITLY and open it. The handler never
 * looks at the terminal cwd, never auto-picks a repo and never runs a
 * command: the chooser offers every configured workspace id (and, for
 * workspaces that configure an allowlisted agent, one explicit
 * "<id>:<agent>" option) and only the picked workspace's configured opens
 * and agent launch are performed.
 */
import type { HandlerCtx } from './context.ts';
import { echoSafe } from '../config.ts';

/** The chooser prompt sent to the platform (data travels as argv). */
export const ACTION_PROMPT = 'pipico: pick a workspace (cancel opens nothing)';
/** Separator between a workspace id and its agent in a chooser option. */
export const AGENT_OPTION_SEP = ':';

export function workspaceOptions(
  workspaces: Record<string, { agent?: string }>,
): string[] {
  const options: string[] = [];
  for (const id of Object.keys(workspaces)) {
    options.push(id);
    const agent = workspaces[id]!.agent;
    if (agent !== undefined) options.push(`${id}${AGENT_OPTION_SEP}${agent}`);
  }
  return options;
}

/** Split a picked option back into a workspace id and an optional agent. */
export function parseOption(option: string): { id: string; agent?: string } {
  const sep = option.indexOf(AGENT_OPTION_SEP);
  if (sep === -1) return { id: option };
  return { id: option.slice(0, sep), agent: option.slice(sep + AGENT_OPTION_SEP.length) };
}

export async function runAction(ctx: HandlerCtx): Promise<number> {
  const workspaces = ctx.loaded.config.workspaces;
  const ids = Object.keys(workspaces);
  if (ids.length === 0) {
    ctx.io.err('error: action: no workspaces are configured (see host/README.md "Config")');
    return 1;
  }

  if (ctx.dryRun) {
    ctx.io.out('action: dry run; nothing is opened or launched');
    ctx.io.out(`action: would show the workspace chooser with options: ${workspaceOptions(workspaces).join(', ')}`);
    return 0;
  }

  const options = workspaceOptions(workspaces);
  const picked = await ctx.platform.choose(ACTION_PROMPT, options);
  if (picked === null) {
    ctx.io.out('action: canceled; nothing was opened');
    return 0;
  }

  const { id, agent } = parseOption(picked);
  const ws = workspaces[id];
  if (ws === undefined) {
    // Defensive: the platform returned an option that was never offered.
    ctx.io.err(`error: action: unknown choice ${echoSafe(picked)}`);
    return 1;
  }

  // An agent needs a configured working directory; refuse before any open.
  if (agent !== undefined && ws.paths.length === 0) {
    ctx.io.err(`error: action: workspace ${id} has no paths; cannot launch the agent there`);
    return 1;
  }

  for (const path of ws.paths) await ctx.platform.openApp(ws.app, path);
  for (const url of ws.urls) await ctx.platform.openUrl(url);
  if (ws.paths.length === 0 && ws.urls.length === 0) {
    // Nothing to aim at: still open the configured app itself.
    await ctx.platform.openApp(ws.app);
  }
  if (agent !== undefined) await ctx.platform.launchAgent(agent, ws.paths[0]!);

  ctx.io.out(`action: opened workspace ${id}${agent !== undefined ? ` with agent ${agent}` : ''}`);
  return 0;
}
