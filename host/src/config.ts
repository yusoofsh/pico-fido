/**
 * Strict pipico config loading and validation.
 *
 * Precedence (documented in host/README.md): --config beats $PIPICO_CONFIG,
 * which beats the default $XDG_CONFIG_HOME|$HOME/.config/pipico/config.json.
 *
 * Unknown keys are rejected at every level. There is deliberately no
 * shell/command field anywhere: pipico never runs shell commands from
 * config. The loader never creates a config; a missing or malformed file
 * is a clean ConfigError.
 */
import { readFileSync } from 'node:fs';
import { CONTROL_CHARS, checkPath, checkUrl } from './validate.ts';

/** macOS app ids a workspace may open. Documented in host/README.md. */
export const APP_ALLOWLIST = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.apple.Safari',
  'com.google.Chrome',
  'com.apple.finder',
  'com.microsoft.VSCode',
] as const;

/**
 * Agent launcher names a workspace may request. Names only: the launcher
 * maps each name to fixed arguments, so config can never supply arguments.
 */
export const AGENT_ALLOWLIST = ['claude', 'codex', 'aider'] as const;

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorkspaceConfig {
  label: string;
  app: string;
  paths: string[];
  urls: string[];
  agent?: string;
}

export interface IncidentConfig {
  notesRoot: string;
  monitoringUrls: string[];
}

export interface StudyConfig {
  urls: string[];
}

export interface PipicoConfig {
  workspaces: Record<string, WorkspaceConfig>;
  attentionUrl: string;
  incident: IncidentConfig;
  study: StudyConfig;
}

export type ConfigSource = 'flag' | 'env' | 'default';

export interface LoadedConfig {
  path: string;
  source: ConfigSource;
  config: PipicoConfig;
}

export class ConfigError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.length === 1 ? errors[0] : `${errors.length} config problems, first: ${errors[0]}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/** Control-char-free rendering for messages that quote operator input. */
export function echoSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

const TOP_KEYS = ['workspaces', 'attentionUrl', 'incident', 'study'];
const WORKSPACE_KEYS = ['agent', 'app', 'label', 'paths', 'urls'];
const INCIDENT_KEYS = ['monitoringUrls', 'notesRoot'];
const STUDY_KEYS = ['urls'];

/** Keys that would allow command execution if they were ever accepted. */
const DANGEROUS_KEYS = new Set(['shell', 'command', 'shell_command', 'cmd', 'exec', 'script', 'args']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function collectUnknownKeys(scope: string, obj: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      errors.push(`${scope}: key "${echoSafe(key)}" is not allowed (pipico never runs shell commands from config)`);
    } else if (!allowed.includes(key)) {
      // echoSafe keeps the diagnostic one line long and control-free even
      // when the key's JSON source escaped a newline, ESC or DEL: raw
      // control bytes must never reach the terminal, while the scope path
      // stays readable.
      errors.push(`${scope}: unknown key "${echoSafe(key)}" (allowed keys: ${allowed.join(', ')})`);
    }
  }
}

function collectRequiredString(value: unknown, where: string, what: string, errors: string[]): string {
  if (typeof value === 'string' && value.length > 0 && !CONTROL_CHARS.test(value)) return value;
  errors.push(`${where}: ${what}`);
  return '';
}

function collectValidatedValue(value: unknown, where: string, check: (v: string) => string | null, errors: string[]): string {
  if (typeof value !== 'string') {
    errors.push(`${where}: must be a string`);
    return '';
  }
  const problem = check(value);
  if (problem !== null) {
    errors.push(`${where}: ${problem}`);
    return '';
  }
  return value;
}

function collectStringArray(value: unknown, where: string, what: string, check: (v: string) => string | null, errors: string[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) {
    errors.push(`${where}: must be an array (${what})`);
    return out;
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string') {
      errors.push(`${where}[${i}]: must be a string`);
      return;
    }
    const problem = check(item);
    if (problem !== null) {
      errors.push(`${where}[${i}]: ${problem}`);
      return;
    }
    out.push(item);
  });
  return out;
}

/** Validate an already-parsed config object. Throws ConfigError with
 * path-qualified, single-line messages on any problem. */
export function validateConfig(raw: unknown): PipicoConfig {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    throw new ConfigError(['config: top level must be a JSON object']);
  }

  collectUnknownKeys('config', raw, TOP_KEYS, errors);
  for (const key of TOP_KEYS) {
    if (!Object.hasOwn(raw, key)) errors.push(`config: missing required key "${key}"`);
  }
  if (errors.length > 0) throw new ConfigError(errors);

  const workspaces: Record<string, WorkspaceConfig> = {};
  const wsRaw = raw.workspaces;
  if (!isPlainObject(wsRaw)) {
    errors.push('config.workspaces: must be a JSON object mapping workspace ids to settings');
  } else {
    for (const [id, wsValue] of Object.entries(wsRaw)) {
      const scope = `config.workspaces.${echoSafe(id)}`;
      if (!WORKSPACE_ID_PATTERN.test(id)) {
        errors.push(`${scope}: workspace ids must match ${WORKSPACE_ID_PATTERN.source} (start with a letter or digit)`);
        continue;
      }
      if (!isPlainObject(wsValue)) {
        errors.push(`${scope}: must be a JSON object`);
        continue;
      }
      collectUnknownKeys(scope, wsValue, WORKSPACE_KEYS, errors);

      const workspace: WorkspaceConfig = { label: '', app: '', paths: [], urls: [] };
      workspace.label = collectRequiredString(
        wsValue.label,
        `${scope}.label`,
        'must be a nonempty string without control characters',
        errors,
      );

      const app = wsValue.app;
      if (typeof app !== 'string') {
        errors.push(`${scope}.app: must be a string (an allowlisted macOS app id)`);
      } else if (!(APP_ALLOWLIST as readonly string[]).includes(app)) {
        errors.push(`${scope}.app: app id ${JSON.stringify(app)} is not allowlisted (allowed: ${APP_ALLOWLIST.join(', ')}; see host/README.md)`);
      } else {
        workspace.app = app;
      }

      workspace.paths = collectStringArray(wsValue.paths, `${scope}.paths`, 'local paths', checkPath, errors);
      workspace.urls = collectStringArray(wsValue.urls, `${scope}.urls`, 'URLs', checkUrl, errors);

      if (wsValue.agent !== undefined) {
        const agent = wsValue.agent;
        if (typeof agent !== 'string' || !(AGENT_ALLOWLIST as readonly string[]).includes(agent)) {
          errors.push(`${scope}.agent: must be an allowlisted agent name (allowed: ${AGENT_ALLOWLIST.join(', ')})`);
        } else {
          workspace.agent = agent;
        }
      }
      workspaces[id] = workspace;
    }
  }

  const attentionUrl = collectValidatedValue(raw.attentionUrl, 'config.attentionUrl', checkUrl, errors);

  const incident: IncidentConfig = { notesRoot: '', monitoringUrls: [] };
  const incRaw = raw.incident;
  if (!isPlainObject(incRaw)) {
    errors.push('config.incident: must be a JSON object with notesRoot and monitoringUrls');
  } else {
    collectUnknownKeys('config.incident', incRaw, INCIDENT_KEYS, errors);
    incident.notesRoot = collectValidatedValue(incRaw.notesRoot, 'config.incident.notesRoot', checkPath, errors);
    incident.monitoringUrls = collectStringArray(incRaw.monitoringUrls, 'config.incident.monitoringUrls', 'URLs', checkUrl, errors);
  }

  const study: StudyConfig = { urls: [] };
  const stRaw = raw.study;
  if (!isPlainObject(stRaw)) {
    errors.push('config.study: must be a JSON object with urls');
  } else {
    collectUnknownKeys('config.study', stRaw, STUDY_KEYS, errors);
    study.urls = collectStringArray(stRaw.urls, 'config.study.urls', 'URLs', checkUrl, errors);
  }

  if (errors.length > 0) throw new ConfigError(errors);
  return { workspaces, attentionUrl, incident, study };
}

export function resolveConfigPath(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): { path: string; source: ConfigSource } {
  if (flag !== undefined && flag !== '') return { path: flag, source: 'flag' };
  const fromEnv = env.PIPICO_CONFIG;
  if (fromEnv !== undefined && fromEnv !== '') return { path: fromEnv, source: 'env' };
  const home = env.HOME;
  if (home === undefined || home === '') {
    throw new ConfigError(['cannot determine the default config location: HOME is not set']);
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : `${home}/.config`;
  return { path: `${base}/pipico/config.json`, source: 'default' };
}

/** Load and validate the config. Throws ConfigError (never creates a file). */
export function loadConfig(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): LoadedConfig {
  const { path, source } = resolveConfigPath(flag, env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new ConfigError([
        source === 'default'
          ? `no config file found at ${echoSafe(path)} (create one as described in host/README.md, or point --config or $PIPICO_CONFIG at it)`
          : `config file not found: ${echoSafe(path)}`,
      ]);
    }
    throw new ConfigError([`cannot read config file ${echoSafe(path)}: ${echoSafe(String(e instanceof Error ? e.message : e))}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message.replace(/[\r\n]+/g, ' ') : 'parse error';
    throw new ConfigError([`${echoSafe(path)}: config file is not valid JSON (${reason})`]);
  }
  return { path, source, config: validateConfig(raw) };
}
