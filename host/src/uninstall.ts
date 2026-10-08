/**
 * uninstall: remove ONLY the resources listed in the install manifest.
 *
 * Safety rules:
 * - every entry is validated before anything is removed (absolute, inside
 *   $HOME, not a symlink, on disk of the recorded type, and for files the
 *   content hash recorded at creation); any refused entry aborts the whole
 *   uninstall with nothing removed;
 * - directories are removed only when empty (rmdir), so user files are
 *   never destroyed;
 * - without a manifest nothing is removed;
 * - --dry-run prints exactly the manifest entries as planned removals and
 *   changes nothing.
 */
import { existsSync, lstatSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CliIo, Env } from './handlers/context.ts';
import { echoSafe } from './config.ts';
import { configBaseFor } from './install.ts';
import { entryProblems, MANIFEST_FILENAME, manifestPathFor, parseManifest, type ManifestResource } from './manifest.ts';

interface OnDiskState {
  kind: 'absent' | 'symlink' | 'file' | 'dir' | 'other';
  sha256?: string;
  problem?: string;
}

/** Read-only on-disk facts about one entry (lstat: symlinks are never followed). */
function onDiskState(path: string): OnDiskState {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { kind: 'symlink' };
    if (st.isFile()) {
      try {
        return { kind: 'file', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
      } catch (e) {
        return { kind: 'file', problem: `cannot read the file: ${echoSafe(String(e instanceof Error ? e.message : e))}` };
      }
    }
    if (st.isDirectory()) return { kind: 'dir' };
    return { kind: 'other' };
  } catch {
    return { kind: 'absent' };
  }
}

/**
 * The refusal reason for one manifest entry given the on-disk state, or
 * null when the entry may be removed. Pure apart from the state passed in.
 */
export function onDiskProblem(entry: ManifestResource, state: OnDiskState): string | null {
  if (state.kind === 'absent') return null; // already gone: nothing to do
  if (state.kind === 'symlink') return 'is a symbolic link; refusing (pipico never follows or removes links)';
  if (state.problem !== undefined) return state.problem;
  if (entry.type === 'file') {
    if (state.kind !== 'file') return `manifest says a file, but it is not a regular file on disk`;
    if (state.sha256 !== entry.sha256) {
      return 'content changed since install (modified, or not created by pipico); refusing';
    }
    return null;
  }
  if (state.kind !== 'dir') return 'manifest says a directory, but it is not a directory on disk';
  return null;
}

export async function runUninstallCommand(dryRun: boolean, env: Env, io: CliIo): Promise<number> {
  const base = configBaseFor(env);
  if (!base.ok) {
    io.err(`error: uninstall: ${base.error}`);
    return 1;
  }
  const manifestPath = manifestPathFor(base.base);

  if (!existsSync(manifestPath)) {
    io.out(`uninstall: nothing to remove: no manifest at ${manifestPath} (pipico is not installed, or ${MANIFEST_FILENAME} was deleted)`);
    return 0;
  }

  let manifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath).toString('utf8'));
  } catch (e) {
    io.err(`error: uninstall: ${echoSafe(String(e instanceof Error ? e.message : e))}`);
    io.err('uninstall: the manifest is invalid; nothing was removed');
    return 1;
  }

  const home = env.HOME!.replace(/\/+$/, '');

  // Validate EVERY entry before removing anything.
  const refusals: string[] = [];
  const plan: Array<{ entry: ManifestResource; state: OnDiskState }> = [];
  for (const entry of manifest.resources) {
    for (const problem of entryProblems(entry, home)) refusals.push(`uninstall: refused: ${problem}`);
    const state = onDiskState(entry.path);
    const problem = onDiskProblem(entry, state);
    if (problem !== null) refusals.push(`uninstall: refused: ${echoSafe(entry.path)}: ${problem}`);
    else plan.push({ entry, state });
  }
  if (refusals.length > 0) {
    for (const line of refusals) io.err(line);
    io.err(`uninstall: refused to remove anything (${refusals.length} problem(s) above); inspect or fix ${echoSafe(manifestPath)}`);
    return 1;
  }

  if (dryRun) {
    io.out('uninstall: dry run; nothing will be removed (HOME unchanged)');
    for (const { entry } of plan) {
      io.out(`uninstall: would remove ${entry.type === 'file' ? 'file' : 'directory (only if empty)'} ${entry.path}`);
    }
    io.out(`uninstall: would remove the manifest itself: ${manifestPath}`);
    return 0;
  }

  // Files first, then the manifest, then directories deepest-first.
  for (const { entry, state } of plan) {
    if (entry.type !== 'file') continue;
    if (state.kind === 'absent') {
      io.out(`uninstall: already absent: ${entry.path}`);
      continue;
    }
    try {
      unlinkSync(entry.path);
      io.out(`uninstall: removed file ${entry.path}`);
    } catch (e) {
      io.err(`error: uninstall: cannot remove ${echoSafe(entry.path)}: ${echoSafe(String(e instanceof Error ? e.message : e))}`);
      return 1;
    }
  }

  try {
    unlinkSync(manifestPath);
    io.out(`uninstall: removed the manifest ${manifestPath}`);
  } catch (e) {
    io.err(`error: uninstall: cannot remove the manifest: ${echoSafe(String(e instanceof Error ? e.message : e))}`);
    return 1;
  }

  const dirs = plan
    .filter(({ entry }) => entry.type === 'dir' && existsSync(entry.path))
    .map(({ entry }) => entry.path)
    .sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
      io.out(`uninstall: removed directory ${dir}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOTEMPTY') io.out(`uninstall: kept (not empty): ${dir}`);
      else {
        io.err(`error: uninstall: cannot remove directory ${echoSafe(dir)}: ${echoSafe(String(e instanceof Error ? e.message : e))}`);
        return 1;
      }
    }
  }

  io.out('uninstall: done');
  return 0;
}
