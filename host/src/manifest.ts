/**
 * The install manifest: the record of every resource pipico created, so
 * uninstall can remove exactly those and nothing else.
 *
 * Location: <config base>/pipico/installed.json, where <config base> is
 * $XDG_CONFIG_HOME when set (it must resolve under $HOME — install refuses
 * otherwise), else $HOME/.config. Same base the config loader uses.
 *
 * Shape (strict; unknown keys anywhere are refused, like the config):
 *
 *   {
 *     "pipicoManifest": 1,
 *     "createdAt": "<ISO-8601>",
 *     "resources": [
 *       {"path": "/home/u/.config/pipico", "type": "dir"},
 *       {"path": "/home/u/.local/bin/pipico", "type": "file",
 *        "sha256": "<64 hex chars>", "mode": "0755"}
 *     ]
 *   }
 *
 * File entries carry the SHA-256 of the content at creation time, so
 * uninstall can refuse entries that were modified afterwards (or were never
 * created by pipico). Directory entries never carry a hash.
 */
import { createHash } from 'node:crypto';
import { echoSafe } from './config.ts';
import { checkPath } from './validate.ts';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = 'installed.json';

export type ResourceType = 'file' | 'dir';

export interface ManifestResource {
  path: string;
  type: ResourceType;
  /** Files only: sha256 of the content at creation time. */
  sha256?: string;
  /** Files only: octal mode at creation time, e.g. "0755". */
  mode?: string;
}

export interface Manifest {
  pipicoManifest: number;
  createdAt: string;
  resources: ManifestResource[];
}

/** A manifest that is missing, unreadable, or fails validation. */
export class ManifestError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.length === 1 ? errors[0] : `${errors.length} manifest problems, first: ${errors[0]}`);
    this.name = 'ManifestError';
    this.errors = errors;
  }
}

export function manifestPathFor(configBase: string): string {
  return `${configBase.replace(/\/+$/, '')}/pipico/${MANIFEST_FILENAME}`;
}

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Render the manifest file content (stable key order, 2-space indent). */
export function serializeManifest(resources: ManifestResource[]): string {
  const manifest: Manifest = {
    pipicoManifest: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    resources: resources.map((r) =>
      r.type === 'file'
        ? { path: r.path, type: r.type, sha256: r.sha256, mode: r.mode }
        : { path: r.path, type: r.type },
    ),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const RESOURCE_KEYS = ['path', 'type', 'sha256', 'mode'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function where(path: string): string {
  return `manifest entry "${echoSafe(path)}"`;
}

/**
 * Validate one resource entry's path rules: absolute, normalized,
 * control-char-free, and inside $HOME. Pure; the entry is already
 * structurally valid (parseManifest checked that). Returns the problems
 * (empty when the entry is acceptable). Uninstall refuses the whole run
 * while any entry has a problem.
 */
export function entryProblems(entry: ManifestResource, home: string): string[] {
  const problems: string[] = [];
  const pathProblem = checkPath(entry.path);
  if (pathProblem !== null) {
    problems.push(`${where(entry.path)}: ${pathProblem}`);
    return problems; // further checks need a parseable path
  }
  const homeNorm = home.replace(/\/+$/, '');
  if (homeNorm === '' || homeNorm === '/') {
    problems.push(`${where(entry.path)}: HOME is empty or "/", refusing to remove anything`);
    return problems;
  }
  if (entry.path === homeNorm) {
    problems.push(`${where(entry.path)}: refusing to remove HOME itself`);
  } else if (!entry.path.startsWith(`${homeNorm}/`)) {
    problems.push(`${where(entry.path)}: outside HOME; pipico removes only what it created under $HOME`);
  }
  return problems;
}

/** Parse and validate manifest file text (structure and entry shape).
 * Throws ManifestError; path rules are checked separately per entry. */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message.replace(/[\r\n]+/g, ' ') : 'parse error';
    throw new ManifestError([`manifest is not valid JSON (${reason})`]);
  }
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    throw new ManifestError(['manifest: top level must be a JSON object']);
  }
  for (const key of Object.keys(raw)) {
    if (!['pipicoManifest', 'createdAt', 'resources'].includes(key)) {
      errors.push(`manifest: unknown key "${key}"`);
    }
  }
  if (raw.pipicoManifest !== MANIFEST_VERSION) {
    errors.push(`manifest: "pipicoManifest" must be ${MANIFEST_VERSION}`);
  }
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) {
    errors.push('manifest: "createdAt" must be a string');
  }
  if (!Array.isArray(raw.resources)) {
    errors.push('manifest: "resources" must be an array');
    throw new ManifestError(errors);
  }
  const resources: ManifestResource[] = [];
  raw.resources.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`manifest resource ${i}: must be a JSON object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!RESOURCE_KEYS.includes(key)) {
        errors.push(`manifest resource ${i}: unknown key "${key}"`);
      }
    }
    const path = entry.path;
    if (typeof path !== 'string' || path.length === 0) {
      errors.push(`manifest resource ${i}: "path" must be a nonempty string`);
      return;
    }
    if (entry.type !== 'file' && entry.type !== 'dir') {
      errors.push(`${where(path)}: "type" must be "file" or "dir"`);
      return;
    }
    if (entry.type === 'file') {
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        errors.push(`${where(path)}: a file entry must have a 64-hex-char "sha256"`);
      }
      if (entry.mode !== undefined && (typeof entry.mode !== 'string' || !/^0?[0-7]{3}$/.test(entry.mode))) {
        errors.push(`${where(path)}: "mode" must be an octal string like "0755"`);
      }
    } else if (entry.sha256 !== undefined) {
      errors.push(`${where(path)}: a directory entry must not carry a "sha256"`);
    }
    resources.push({
      path,
      type: entry.type,
      ...(typeof entry.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
      ...(typeof entry.mode === 'string' ? { mode: entry.mode } : {}),
    });
  });
  if (errors.length > 0) throw new ManifestError(errors);
  const createdAt: string = typeof raw.createdAt === 'string' ? raw.createdAt : '';
  return { pipicoManifest: MANIFEST_VERSION, createdAt, resources };
}
