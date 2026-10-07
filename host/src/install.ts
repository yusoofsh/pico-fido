/**
 * install / uninstall command implementations.
 *
 * install writes ONLY under $HOME (per-user; no sudo, no cron, no launchd —
 * there is deliberately no privileged helper and no scheduler anywhere):
 *
 *   <base>/pipico/config.json      config skeleton (never overwritten)
 *   <base>/pipico/installed.json   the manifest of created resources
 *   <home>/.local/bin/pipico       the executable wrapper (never overwritten)
 *
 * where <base> is $XDG_CONFIG_HOME when set (it must resolve under $HOME or
 * install refuses), else $HOME/.config — the same base the config loader
 * uses. Every missing directory between $HOME and <base> is planned as its
 * own resource (never a recursive mkdir), so a nested XDG layout like
 * <base>=$HOME/a/b/config installs, the dry run lists each missing ancestor
 * shallowest-first, and the manifest records each one it created. Existing
 * files are never overwritten: they are kept untouched and unlisted, so
 * re-running is safe (idempotent) and uninstall never removes anything
 * pipico did not create. If an ordinary caught error strikes mid-install,
 * the resources this invocation successfully created are reverse-cleaned
 * (files unlinked, then directories rmdir'd deepest-first, only when empty)
 * and pre-existing resources are left untouched. A file counts as created
 * the moment its exclusive open succeeds — before any byte is written —
 * so a caught partial write is cleaned too, and a retry installs the full
 * file instead of keeping a truncated one. The manifest itself is written
 * only when absent: a manifest this invocation opened is removed on
 * failure (before the directories, so they are empty); a manifest whose
 * create never succeeded (EEXIST — a foreign one) is never read, compared
 * or unlinked. --dry-run prints the exact plan and writes nothing.
 *
 * install and uninstall never touch the Platform interface: they perform no
 * machine actions, only per-user file management.
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './handlers/context.ts';
import type { CliIo } from './handlers/context.ts';
import { echoSafe } from './config.ts';
import { executablePath, bindingInstructions } from './bindings.ts';
import {
  hashContent,
  MANIFEST_FILENAME,
  manifestPathFor,
  serializeManifest,
  type ManifestResource,
} from './manifest.ts';

export type { Env };

/**
 * The filesystem operations install performs, in one injectable object: the
 * real CLI uses the node:fs implementations below; tests inject failures
 * (a chmod error after a successful write, a mid-write failure after the
 * exclusive create) to exercise the rollback.
 * Every operation is flat: mkdir and rmdir are never recursive, so each
 * created directory is planned and recorded individually.
 */
export interface InstallFsOps {
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
  mkdir(path: string): void;
  /**
   * Exclusive create: fails when the path already exists (never truncates).
   * `onOpen` is the ownership point: it runs immediately after the exclusive
   * open succeeds, before any byte is written — the command records the file
   * as invocation-created there, so even a caught partial write (or a
   * failing chmod) is reverse-cleaned, and a retry writes the full file
   * instead of keeping a truncated one. onOpen never runs when the open
   * itself fails (e.g. EEXIST: a file that appeared concurrently is
   * foreign and not this invocation's to clean). The handle is closed on
   * every path.
   */
  writeFileNew(path: string, content: string, onOpen?: () => void): void;
  chmod(path: string, mode: number): void;
  unlink(path: string): void;
  /** Only removes an empty directory (plain rmdir). */
  rmdir(path: string): void;
}

export const realInstallFs: InstallFsOps = {
  exists: (p) => existsSync(p),
  isSymlink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  mkdir: (p) => mkdirSync(p),
  writeFileNew: (p, c, onOpen) => {
    const fd = openSync(p, 'wx'); // exclusive create: fails EEXIST, never truncates
    try {
      onOpen?.(); // ownership point: the file now exists, still empty
      writeSync(fd, c);
    } finally {
      closeSync(fd);
    }
  },
  chmod: (p, m) => chmodSync(p, m),
  unlink: (p) => unlinkSync(p),
  rmdir: (p) => rmdirSync(p),
};

export interface InstallRuntime {
  /** Absolute path of the bun binary the wrapper must exec. */
  bunPath: string;
  /** Absolute path of the cli.ts entry the wrapper must run. */
  cliPath: string;
}

/** The runtime the real CLI runs under (used unless a test injects one). */
export function defaultRuntime(): InstallRuntime {
  return { bunPath: process.execPath, cliPath: Bun.main };
}

export interface PlannedDir {
  kind: 'dir';
  path: string;
}

export interface PlannedFile {
  kind: 'file';
  path: string;
  content: string;
  mode: number;
  what: string;
}

export type PlannedResource = PlannedDir | PlannedFile;

/** The per-user wrapper: a tiny POSIX script running the pinned bun+cli. */
export function wrapperScript(runtime: InstallRuntime): string {
  return [
    '#!/usr/bin/env sh',
    '# pipico wrapper generated by "pipico install" (per-user; safe to delete).',
    '# It only ever execs the pinned bun and cli.ts recorded below, passing',
    '# arguments through verbatim. No shell evaluation of the arguments.',
    `exec ${shQuote(runtime.bunPath)} ${shQuote(runtime.cliPath)} "$@"`,
    '',
  ].join('\n');
}

/** Quote one path for the wrapper script (POSIX single-quote rule). */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The config skeleton written when no config exists yet (a valid config). */
export function configSkeleton(home: string): string {
  const skeleton = {
    workspaces: {
      devops: {
        label: 'DevOps',
        app: 'com.apple.Terminal',
        paths: [join(home, 'work')],
        urls: [],
      },
    },
    attentionUrl: 'https://attention.example/today',
    incident: {
      notesRoot: join(home, 'incidents'),
      monitoringUrls: ['https://status.example/internal'],
    },
    study: { urls: ['https://course.example/lesson-1'] },
  };
  return `${JSON.stringify(skeleton, null, 2)}\n`;
}

/**
 * The config base directory: $XDG_CONFIG_HOME when set (must be an absolute,
 * normalized path under $HOME — a `..` or `.` segment would make install
 * create directories its plan does not name), else $HOME/.config — the same
 * base as the config loader.
 */
export function configBaseFor(env: Env): { ok: true; base: string } | { ok: false; error: string } {
  const home = env.HOME;
  if (home === undefined || home === '') {
    return { ok: false, error: 'HOME is not set; refusing to guess an install location' };
  }
  const homeNorm = home.replace(/\/+$/, '');
  if (homeNorm === '' || homeNorm === '/') {
    return { ok: false, error: 'HOME is empty or "/"; refusing to install' };
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '') {
    const base = xdg.replace(/\/+$/, '');
    const segments = base.split('/').filter((s) => s !== '');
    const notNormalized = segments.some((s) => s === '..' || s === '.');
    if (!base.startsWith('/') || base === '/' || notNormalized) {
      return {
        ok: false,
        error: `XDG_CONFIG_HOME (${echoSafe(xdg)}) must be an absolute, normalized path (no ".." or ".") under HOME: pipico writes only under $HOME`,
      };
    }
    if (!base.startsWith(`${homeNorm}/`)) {
      return {
        ok: false,
        error: `XDG_CONFIG_HOME (${echoSafe(xdg)}) must be an absolute path under HOME: pipico writes only under $HOME`,
      };
    }
    return { ok: true, base };
  }
  return { ok: true, base: join(homeNorm, '.config') };
}

/**
 * Every directory install plans for this layout — existing or missing — in
 * shallow-first order (each path sorts before its descendants): the config
 * base and every directory between HOME and it (a nested XDG base like
 * $HOME/a/b/config contributes $HOME/a, $HOME/a/b, $HOME/a/b/config), then
 * <base>/pipico, $HOME/.local and $HOME/.local/bin. HOME itself is never a
 * resource. Which of them actually need creating is decided at run time;
 * they are all created as individual plain mkdirs so the manifest can list
 * exactly what this invocation created.
 */
export function candidateDirs(home: string, configBase: string): string[] {
  const homeNorm = home.replace(/\/+$/, '');
  const base = configBase.replace(/\/+$/, '');
  const dirs = new Set<string>();
  if (base.startsWith(`${homeNorm}/`)) {
    let cur = homeNorm;
    for (const seg of base.slice(homeNorm.length + 1).split('/')) {
      if (seg === '' || seg === '.') continue;
      cur = `${cur}/${seg}`;
      dirs.add(cur);
    }
  } else {
    dirs.add(base);
  }
  dirs.add(join(base, 'pipico'));
  dirs.add(join(homeNorm, '.local'));
  dirs.add(join(homeNorm, '.local/bin'));
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** The ordered install plan: directories first (shallow), then files. */
export function planInstall(home: string, configBase: string, runtime: InstallRuntime): PlannedResource[] {
  const homeNorm = home.replace(/\/+$/, '');
  const dirs = candidateDirs(homeNorm, configBase);
  return [
    ...dirs.map((path) => ({ kind: 'dir' as const, path })),
    {
      kind: 'file' as const,
      path: join(configBase, 'pipico/config.json'),
      content: configSkeleton(homeNorm),
      mode: 0o644,
      what: 'config skeleton',
    },
    {
      kind: 'file' as const,
      path: executablePath(homeNorm),
      content: wrapperScript(runtime),
      mode: 0o755,
      what: 'per-user wrapper',
    },
  ];
}

function describeEntry(r: PlannedResource): string {
  return r.kind === 'dir' ? `directory ${r.path}` : `file ${r.path} (${r.what})`;
}

/**
 * Reverse-order cleanup of ONLY the resources this invocation created
 * (passed in creation order). Created files are unlinked first (they were
 * created after the directories), then the created directories deepest-first,
 * each with a plain rmdir: a directory that acquired a file pipico did not
 * create is kept, never recursed into, and so are the ancestors still needed
 * to contain it. Directories that were pre-existing are not in the list and
 * are never touched. Best effort: every outcome is reported, failures do not
 * stop the remaining cleanup.
 */
export function reverseClean(created: ManifestResource[], io: CliIo, ops: InstallFsOps = realInstallFs): void {
  const files = created.filter((r) => r.type === 'file').map((r) => r.path);
  const dirs = created
    .filter((r) => r.type === 'dir')
    .map((r) => r.path)
    .sort((a, b) => b.split('/').length - a.split('/').length);
  for (const path of [...files].reverse()) {
    try {
      ops.unlink(path);
      io.out(`install: rollback: removed file ${path}`);
    } catch (e) {
      io.err(`install: rollback: could not remove file ${echoSafe(path)}: ${echoSafe(String(e instanceof Error ? e.message : e))}`);
    }
  }
  for (const path of dirs) {
    try {
      ops.rmdir(path);
      io.out(`install: rollback: removed empty directory ${path}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOTEMPTY') {
        io.out(`install: rollback: kept directory ${path} (not empty; it holds resources pipico did not create)`);
      } else {
        io.err(`install: rollback: could not remove directory ${echoSafe(path)}: ${echoSafe(String(e instanceof Error ? e.message : e))}`);
      }
    }
  }
}

export async function runInstallCommand(
  dryRun: boolean,
  env: Env,
  io: CliIo,
  runtime: InstallRuntime = defaultRuntime(),
  ops: InstallFsOps = realInstallFs,
): Promise<number> {
  const base = configBaseFor(env);
  if (!base.ok) {
    io.err(`error: install: ${base.error}`);
    return 1;
  }
  const home = env.HOME!.replace(/\/+$/, '');
  const manifestPath = manifestPathFor(base.base);

  io.out(dryRun ? 'install: dry run; nothing will be created (HOME unchanged)' : `install: writing only under ${home}`);

  // Preflight: a planned directory that exists as a symbolic link would
  // redirect every write below it (possibly outside $HOME). Refuse before
  // creating anything, in dry runs too (the real run would refuse there).
  for (const dir of candidateDirs(home, base.base)) {
    if (ops.isSymlink(dir)) {
      io.err(`error: install: ${echoSafe(dir)} is a symbolic link; refusing to create resources below it (pipico never follows links, and writes only under $HOME)`);
      return 1;
    }
  }

  const created: ManifestResource[] = [];
  // Whether this invocation exclusively opened the manifest. Only an owned
  // manifest — one whose create succeeded, even if the write then failed
  // midway — is ever unlinked during rollback; a manifest that appears
  // without this invocation's create succeeding (EEXIST) is foreign.
  let manifestOwned = false;

  try {
    for (const entry of planInstall(home, base.base, runtime)) {
      if (ops.exists(entry.path)) {
        io.out(`install: exists, keeping it (never overwritten, not listed in the manifest): ${entry.path}`);
        continue;
      }
      if (dryRun) {
        io.out(`install: would create ${describeEntry(entry)}`);
        continue;
      }
      if (entry.kind === 'dir') {
        ops.mkdir(entry.path); // plain mkdir: every ancestor is its own planned entry
        created.push({ path: entry.path, type: 'dir' });
      } else {
        // Ownership is recorded in the exclusive-open callback: the moment
        // the create succeeds the file is this invocation's to clean up —
        // before any byte is written, so a caught partial write (or a
        // failing chmod) is reverse-cleaned and a retry writes the full
        // file instead of keeping a truncated one.
        ops.writeFileNew(entry.path, entry.content, () => {
          created.push({
            path: entry.path,
            type: 'file',
            sha256: hashContent(entry.content),
            mode: entry.mode.toString(8).padStart(4, '0'),
          });
        });
        ops.chmod(entry.path, entry.mode);
      }
      io.out(`install: created ${describeEntry(entry)}`);
    }

    if (ops.exists(manifestPath)) {
      io.out(`install: manifest already exists, keeping it (never overwritten): ${manifestPath}`);
    } else if (dryRun) {
      io.out(`install: would create file ${manifestPath} (${MANIFEST_FILENAME}, listing the created resources)`);
    } else {
      const content = serializeManifest(created); // serialized once: the same bytes are written
      ops.writeFileNew(manifestPath, content, () => {
        manifestOwned = true; // the exclusive open succeeded: the manifest is ours to clean
      });
      io.out(`install: created file ${manifestPath} (${created.length} resources listed)`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    io.err(`error: install: ${echoSafe(message)}`);
    io.err('error: install: rolling back the resources this invocation created (pre-existing files and directories are left untouched)');
    // The manifest this invocation exclusively opened is ours even when the
    // write failed midway. Remove it BEFORE the directories: it usually
    // lives in a directory created just before it, which only becomes empty
    // without it. A manifest whose exclusive open failed (EEXIST — someone
    // else created it between the check and the open) is foreign: it is
    // never read, compared or unlinked; content resemblance is not
    // ownership.
    if (manifestOwned) {
      try {
        ops.unlink(manifestPath);
        io.out(`install: rollback: removed partial manifest ${manifestPath}`);
      } catch {
        /* best effort */
      }
    }
    reverseClean(created, io, ops);
    return 1;
  }

  // Binding guidance, with the absolute path install creates — both in the
  // dry run and in the real run (VAL-HOST-034).
  for (const line of bindingInstructions(executablePath(home))) io.out(line);

  if (!dryRun) io.out(`install: done${created.length === 0 ? ' (already installed; nothing changed)' : ''}`);
  return 0;
}
