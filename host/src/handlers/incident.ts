/**
 * incident (F15): scaffold a timestamped LOCAL notes folder and open the
 * configured monitoring pages. Nothing else:
 *
 * - the folder is created under the configured notes root, from a template
 *   in this file, and is never overwritten (an existing folder is a clean
 *   refusal; files are written with exclusive-create flags);
 * - the platform calls are exactly one URL-open per configured monitoring
 *   URL, in order;
 * - there is no SSH, no remote command, no restart, no deploy, no cleanup
 *   and no capture of history, environment or clipboard. The folder the run
 *   created stays in place even when a later URL open fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerCtx } from './context.ts';

export const NOTES_FILE = 'notes.md';
export const EVIDENCE_DIR = 'evidence';
export const HANDOFF_FILE = 'handoff.md';

/** The timestamped folder name pattern (local time). */
export const INCIDENT_DIR_PATTERN = /^[0-9]{8}-[0-9]{6}$/;

/** The timestamped folder name for a moment, e.g. 20260102-030405. */
export function incidentFolderName(now: Date): string {
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  const date = `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1, 2)}${p(now.getDate(), 2)}`;
  const time = `${p(now.getHours(), 2)}${p(now.getMinutes(), 2)}${p(now.getSeconds(), 2)}`;
  return `${date}-${time}`;
}

const NOTES_TEMPLATE = `# Incident notes — {TIMESTAMP}

One-line summary:



## Timeline (UTC or local, be consistent)

- 

## What we know

- 

## What we do NOT know yet

- 

## Evidence

Drop files into ./evidence/ (starts empty). Nothing here is ever uploaded
anywhere by pipico.

## Monitoring pages

Opened by pipico at scaffold time (see the config's incident.monitoringUrls).
`;

const HANDOFF_TEMPLATE = `# Handoff — {TIMESTAMP}

## Status right now

- 

## Who is affected

- 

## Next steps

1. 
2. 

## Where things live

- Notes and evidence: this folder (local only).
`;

function render(template: string, timestamp: string): string {
  return template.replaceAll('{TIMESTAMP}', timestamp);
}

function asSingleLine(e: unknown): string {
  return String(e instanceof Error ? e.message : e).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

export async function runIncident(ctx: HandlerCtx): Promise<number> {
  const { notesRoot, monitoringUrls } = ctx.loaded.config.incident;

  if (ctx.dryRun) {
    ctx.io.out('incident: dry run; nothing is created or opened');
    ctx.io.out(`incident: would create ${join(notesRoot, incidentFolderName(new Date()))} with ${NOTES_FILE}, ${EVIDENCE_DIR}/ (empty) and ${HANDOFF_FILE}`);
    ctx.io.out(`incident: would open ${monitoringUrls.length} monitoring page(s)`);
    return 0;
  }

  // Create the scaffold first, so a later URL-open failure cannot leave the
  // operator without notes (and nothing here is ever deleted or rewritten).
  let dir: string;
  try {
    mkdirSync(notesRoot, { recursive: true });
    dir = join(notesRoot, incidentFolderName(new Date()));
    mkdirSync(dir); // no recursive flag: an existing folder is a refusal
    writeFileSync(join(dir, NOTES_FILE), render(NOTES_TEMPLATE, incidentFolderName(new Date())), { flag: 'wx' });
    mkdirSync(join(dir, EVIDENCE_DIR)); // deliberately empty
    writeFileSync(join(dir, HANDOFF_FILE), render(HANDOFF_TEMPLATE, incidentFolderName(new Date())), { flag: 'wx' });
  } catch (e) {
    ctx.io.err(`error: incident: not overwritten, refusing (${asSingleLine(e)})`);
    return 1;
  }

  for (const url of monitoringUrls) await ctx.platform.openUrl(url);

  ctx.io.out(`incident: created ${dir} (notes, empty evidence/, handoff)`);
  ctx.io.out(`incident: opened ${monitoringUrls.length} monitoring page(s)`);
  return 0;
}
