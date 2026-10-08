/**
 * incident (F15) handler tests (VAL-HOST-021/022/023/030): a timestamped
 * local notes folder from a template, an empty evidence dir, a handoff
 * scaffold, monitoring URL opens only; never overwrites, no remote or
 * destructive commands, failures are contained.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { INCIDENT_DIR_PATTERN, incidentFolderName } from '../src/handlers/incident.ts';
import { runCli } from '../src/cli.ts';
import { fakeEnv, makeTempHome, readLogLines, snapshotDir, writeConfigFile } from './helpers.ts';

function logPath(home: string): string {
  return join(home, 'fake-platform.log');
}

/** A temp home with a config whose incident notesRoot lives inside it. */
function incidentHome(): string {
  const home = makeTempHome();
  writeConfigFile(home, 'config.json', (c) => {
    c.incident.notesRoot = join(home, 'notes');
    c.incident.monitoringUrls = ['https://status.example/internal', 'https://metrics.example/dash'];
  });
  return home;
}

function env(home: string, extra?: Record<string, string | undefined>) {
  return fakeEnv(home, { PIPICO_CONFIG: join(home, 'config.json'), ...extra });
}

describe('incident: local scaffold + monitoring opens (VAL-HOST-021)', () => {
  it('creates exactly one timestamped folder with notes, empty evidence and handoff', async () => {
    const home = incidentHome();
    const r = await runCli(['incident'], env(home));
    expect(r.code).toBe(0);

    const notesRoot = join(home, 'notes');
    expect(existsSync(notesRoot)).toBe(true);
    const folders = readdirSync(notesRoot);
    expect(folders).toHaveLength(1);
    const folder = folders[0]!;
    expect(folder).toMatch(INCIDENT_DIR_PATTERN);

    const inside = readdirSync(join(notesRoot, folder)).sort();
    expect(inside).toEqual(['evidence', 'handoff.md', 'notes.md']);
    const evidence = readdirSync(join(notesRoot, folder, 'evidence'));
    expect(evidence).toEqual([]);
    const notes = readFileSync(join(notesRoot, folder, 'notes.md'), 'utf8');
    expect(notes).toContain(folder);      // the timestamp is rendered in
    expect(notes).toContain('Incident');  // template heading
    expect(notes).not.toContain('{');     // no unrendered placeholder
    const handoff = readFileSync(join(notesRoot, folder, 'handoff.md'), 'utf8');
    expect(handoff).toContain('Handoff');

    // Exactly one URL-open per monitoring URL, in order, no other call kind.
    expect(readLogLines(logPath(home))).toEqual([
      { op: 'openUrl', url: 'https://status.example/internal' },
      { op: 'openUrl', url: 'https://metrics.example/dash' },
    ]);
  });

  it('creates nothing outside the notes root', async () => {
    const home = incidentHome();
    // The fake log (created at platform construction) lives outside home so
    // the before/after comparison sees only pipico's own file effects.
    const log = joinLog();
    const before = snapshotDir(home);
    const r = await runCli(['incident'], env(home, { PIPICO_FAKE_LOG: log }));
    expect(r.code).toBe(0);
    const after = snapshotDir(home);
    const beforeLines = new Set(before.split('\n'));
    for (const line of after.split('\n')) {
      if (beforeLines.has(line)) continue;
      expect(line.split(' ')[1]!).toMatch(/^notes($|\/)/);
    }
  });
});

describe('incident: never overwrites (VAL-HOST-022)', () => {
  it('refuses with a clean error when the timestamped folder already exists', async () => {
    const home = incidentHome();
    const root = join(home, 'notes');
    const expected = join(root, incidentFolderName(new Date()));
    mkdirSync(expected, { recursive: true });
    writeFileSync(join(expected, 'notes.md'), 'operator content');
    const before = snapshotDir(root);

    const r = await runCli(['incident'], env(home));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('exists');
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    // The pre-existing folder is untouched and no second folder appeared.
    expect(snapshotDir(root)).toBe(before);
    expect(readLogLines(logPath(home))).toEqual([]);
  });
});

describe('incident: failures are contained (VAL-HOST-030)', () => {
  it('keeps the scaffold in place and reports one short line when a URL open fails', async () => {
    const home = incidentHome();
    const r = await runCli(['incident'], env(home, { PIPICO_FAKE_FAIL: 'openUrl' }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('openUrl');
    expect(r.stderr.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(r.stderr).not.toMatch(/\bat\s+\S+:\d+/); // no uncaught stack trace
    // The scaffold is NOT rolled back.
    const root = join(home, 'notes');
    const folders = readdirSync(root);
    expect(folders).toHaveLength(1);
    const created = join(root, folders[0]!);
    expect(statSync(join(created, 'evidence')).isDirectory()).toBe(true);
    expect(existsSync(join(created, 'handoff.md'))).toBe(true);
  });
});

describe('incident: no env/history/clipboard capture (VAL-HOST-023)', () => {
  it('writes no canary env values into any created file or the log', async () => {
    const home = incidentHome();
    const r = await runCli(['incident'], env(home, {
      AWS_SECRET_ACCESS_KEY: 'CANARY_ENV_7f3a',
      GITHUB_TOKEN: 'CANARY_ENV_7f3a',
    }));
    expect(r.code).toBe(0);
    const root = join(home, 'notes');
    for (const folder of readdirSync(root)) {
      for (const file of ['notes.md', 'handoff.md']) {
        expect(readFileSync(join(root, folder, file), 'utf8')).not.toContain('CANARY_');
      }
    }
    expect(readFileSync(logPath(home), 'utf8')).not.toContain('CANARY_');
  });
});

describe('incident: dry run', () => {
  it('prints the plan and changes nothing', async () => {
    const home = incidentHome();
    const log = joinLog();
    const before = snapshotDir(home);
    const r = await runCli(['incident', '--dry-run'], env(home, { PIPICO_FAKE_LOG: log }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(join(home, 'notes'));
    expect(snapshotDir(home)).toBe(before);
    expect(readLogLines(log)).toEqual([]);
  });
});

/** A log path OUTSIDE any temp home, so home snapshots stay clean. */
let logCounter = 0;
function joinLog(): string {
  logCounter += 1;
  return join(makeTempHome(), `fake-${logCounter}.log`);
}
