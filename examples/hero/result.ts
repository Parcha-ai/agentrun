// What the hero's run leaves: the cited result a recording carries (`agentrun.cited/1`), and `snapshot.html` with each cited screenshot beside it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Record_ = { at: string; grids: number; read: number; failed: number; closeWithinOnePoint?: number; meanGap?: number; rows: Array<Record<string, unknown>>; html: string };

/** The result a recording carries (`agentrun.cited/1`): rows of a label, a value and the cites behind it. Each cite names the screenshot the number was read
 *  from (`blob`, the image's SHA-256) and the look that read it (`look`, the LookRecord's `facts.key`). A grid that was not read has a row and no cite. */
export type Cited = { format: 'agentrun.cited/1'; title?: string; rows: Array<{ label: string; value: string | number; note?: string; cites: Array<{ blob?: string; look?: string; fragment?: string; note?: string }> }> };
export function citedOf(record: Record_, cites: ReadonlyArray<{ receipt: string; look: string; blob: string | null }>): Cited {
  const rows: Cited['rows'] = [];
  for (const row of record.rows) {
    const at = typeof row.screenshot === 'string' ? cites.find((cite) => cite.receipt === row.screenshot) : undefined;
    const cite = (note: string) => (at ? [{ ...(at.blob ? { blob: at.blob } : {}), look: at.look, note }] : []);
    if (row.status !== 'read') { rows.push({ label: String(row.operator), value: `not read: ${String(row.note)}`, cites: [] }); continue; }
    rows.push({ label: `${String(row.operator)}: renewable share now`, value: `${String(row.share)}%`, note: `the operator publishes ${String(row.published)}% (gap ${String(row.gap)} points)`, cites: cite('read from the chart') });
    rows.push({ label: `${String(row.operator)}: peak`, value: `${String(row.peak)} ${String(row.peakUnit)}`, note: String(row.peakOf), cites: cite('read from the chart') });
  }
  return { format: 'agentrun.cited/1', title: `${record.grids} grids, read from the chart`, rows };
}

/** What a delivered snapshot is made of: `snapshot.html`, and each cited screenshot copied beside it as an image the page links to. */
export function deliverSnapshot(root: string, record: Record_): void {
  const out = join(root, 'out');
  mkdirSync(join(out, 'screenshots'), { recursive: true });
  let html = record.html;
  for (const row of record.rows) {
    const path = typeof row.screenshot === 'string' ? row.screenshot : '';
    if (row.status !== 'read' || !path) continue;
    const receipt = JSON.parse(readFileSync(join(root, path), 'utf8')) as { body: string; ext?: string };
    const name = `screenshots/${String(row.id)}.${receipt.ext ?? 'jpg'}`;
    writeFileSync(join(out, name), Buffer.from(receipt.body, 'base64'));
    html = html.split(path).join(name);
    row.screenshotFile = name;
  }
  writeFileSync(join(out, 'snapshot.html'), html);
}

const cites = (dir: string): Array<{ receipt: string; look: string; blob: string | null }> => {
  try { return readFileSync(join(dir, 'cites.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
};

/** The entry's `result` hook: writes the snapshot beside the run's records, and returns the cited result the recording carries. */
export function result(record: unknown, context: { dir: string }): { json: Cited; title: string } {
  deliverSnapshot(context.dir, record as Record_);
  return { json: citedOf(record as Record_, cites(context.dir)), title: `${(record as Record_).grids} grids, read from the chart` };
}
