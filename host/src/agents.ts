/**
 * The agent launcher: allowlisted agent name → one fixed argv. Config can
 * only NAME an agent (see AGENT_ALLOWLIST in config.ts); it can never supply
 * a path, an argument or a flag. The launch argv therefore contains no
 * auto-approve or any other flag, by construction.
 */
import { AGENT_ALLOWLIST } from './config.ts';

export const AGENT_ARGV: Readonly<Record<string, readonly string[]>> = {
  claude: ['/usr/bin/env', 'claude'],
  codex: ['/usr/bin/env', 'codex'],
  aider: ['/usr/bin/env', 'aider'],
};

/** The fixed argv for an allowlisted agent; throws for anything else. */
export function agentArgv(agent: string): readonly string[] {
  const argv = AGENT_ARGV[agent];
  if (argv === undefined) {
    throw new Error(`agent ${JSON.stringify(agent)} is not allowlisted (allowed: ${AGENT_ALLOWLIST.join(', ')})`);
  }
  return argv;
}
