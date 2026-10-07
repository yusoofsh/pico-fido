/** Shared handler plumbing: output sinks and the handler context. */
import type { LoadedConfig } from '../config.ts';
import type { Platform } from '../platform/index.ts';

/** The environment the CLI runs with (always explicit; never process.env). */
export type Env = Record<string, string | undefined>;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface HandlerCtx {
  loaded: LoadedConfig;
  platform: Platform;
  io: CliIo;
  dryRun: boolean;
}
