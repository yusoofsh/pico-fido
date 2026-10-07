/**
 * Shared fixtures for the pipico host CLI tests.
 * Config paths in fixtures intentionally point at macOS-style absolute paths
 * (/Users/...): structural validation must not require the paths to exist.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line
export type AnyConfig = Record<string, any>;

export const VALID_CONFIG: AnyConfig = {
  workspaces: {
    devops: {
      label: 'DevOps',
      app: 'com.apple.Terminal',
      paths: ['/Users/yusoof/work/infra'],
      urls: ['https://grafana.internal.example/dash'],
    },
    study: {
      label: 'Study',
      app: 'com.google.Chrome',
      paths: ['/Users/yusoof/study'],
      urls: [],
    },
  },
  attentionUrl: 'https://attention.example/today',
  incident: {
    notesRoot: '/Users/yusoof/incident-notes',
    monitoringUrls: ['https://status.example/internal'],
  },
  study: { urls: ['https://course.example/lesson-1'] },
};

export function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pipico-test-'));
}

/** Write a (possibly mutated) valid config to the default location under home. */
export function writeDefaultConfig(home: string, mutate?: (cfg: AnyConfig) => void): string {
  const dir = join(home, '.config', 'pipico');
  mkdirSync(dir, { recursive: true });
  return writeConfigFileSync(join(dir, 'config.json'), mutate);
}

/** Write a (possibly mutated) valid config to an arbitrary file. */
export function writeConfigFile(home: string, name: string, mutate?: (cfg: AnyConfig) => void): string {
  return writeConfigFileSync(join(home, name), mutate);
}

function writeConfigFileSync(path: string, mutate?: (cfg: AnyConfig) => void): string {
  const cfg = JSON.parse(JSON.stringify(VALID_CONFIG));
  mutate?.(cfg);
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return path;
}

/** Env for a fake-platform run whose fake log lives under home. */
export function fakeEnv(
  home: string,
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    HOME: home,
    PIPICO_PLATFORM: 'fake',
    PIPICO_FAKE_LOG: join(home, 'fake-platform.log'),
    ...extra,
  };
}

export function readLogLines(path: string): any[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Recursive snapshot of a directory tree (names, sizes, hashes). */
export function snapshotDir(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        lines.push(`l ${relPath}`);
      } else if (entry.isDirectory()) {
        lines.push(`d ${relPath}`);
        walk(abs, relPath);
      } else if (entry.isFile()) {
        const content = readFileSync(abs);
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
        lines.push(`f ${relPath} ${content.length} ${hash}`);
      } else {
        lines.push(`? ${relPath}`);
      }
    }
  };
  walk(root, '');
  return lines.join('\n');
}

