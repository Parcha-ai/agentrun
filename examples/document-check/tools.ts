// The job's `cite` tool: one row a mark of the checklist, in its order, its value yes or no, citing the look and the place
// on the page (`#page=N` and, for a mark that is there, `&xywh=percent:x,y,w,h` of the page's crop box). The rows are the
// ones the verify skill's step 2 wrote to `.verify/<document>/marks.json` in the workspace, so a lead that submits other
// rows changes nothing; each row it submitted otherwise is listed in `differences`. It reads only what the run filed under
// its directory; a receipt that is not an ok look there is dropped, and a row left with no look keeps its places, said so.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LookRecord } from '@parcha/pi-vision';

export type Row = { id: string; mark: string; value: 'yes' | 'no'; p: number; note: string; cites: { fragment: string; receipts: string[] }[] };
export type Cite = { look?: string; blob?: string; fragment: string; note?: string };
/** The check itself, beside the cited rows: the document, the checklist, whether every mark is there, and each mark's
 *  short name with Jev's probability that it is there. */
export type DocumentCheck = { format: 'document-check/1'; document: string; checklist: string; every: boolean; marks: { id: string; value: 'yes' | 'no'; p: number }[]; differences: string[] };
export type Cited = { format: 'agentrun.cited/1'; title: string; rows: { label: string; value: string; note?: string; cites: Cite[] }[]; document_check: DocumentCheck };

/** A receipt the run filed, read back: the record, when the path is a file under the run's `evidence/` that parses as an ok look. */
export function lookAt(root: string, path: string): LookRecord | undefined {
  const at = resolve(root, path);
  if (!path.startsWith('evidence/') || relative(resolve(root), at).startsWith('..') || !existsSync(at)) return undefined;
  try {
    const record = JSON.parse(readFileSync(at, 'utf8')) as LookRecord;
    return record.tool === 'look' && record.status === 'ok' && typeof record.facts?.key === 'string' ? record : undefined;
  } catch { return undefined; }
}

/** `file.pdf#page=1&xywh=...` as the cited format writes a place in a document it keeps as a blob: `#page=1&xywh=...`. */
const placeOf = (fragment: string) => fragment.slice(fragment.lastIndexOf('#'));

/** The rows step 2 wrote for `document` (the folder name is the skill's), each mark of the checklist once in its order. */
function writtenRows(work: string, document: string, checklist: string): Row[] {
  const marks = JSON.parse(readFileSync(join(work, checklist), 'utf8')) as { marks: { id: string }[] };
  const written = JSON.parse(readFileSync(join(work, '.verify', document.replace(/[^\w.-]+/g, '_'), 'marks.json'), 'utf8')) as { rows: Row[] };
  return marks.marks.map((mark) => {
    const row = written.rows.find((each) => each.id === mark.id);
    if (!row) throw new Error(`step 2 wrote no row for the mark ${mark.id}: run the verify skill's two steps first`);
    return row;
  });
}

export function citedOf(root: string, args: { document: string; checklist: string; every: boolean; rows: Row[] }): Cited {
  const written = writtenRows(join(root, 'work'), args.document, args.checklist);
  const differences = [
    ...args.rows.filter((row) => !written.some((each) => each.id === row.id && each.value === row.value)).map((row) => `the lead submitted ${row.id || row.mark}: ${row.value}, which step 2 did not write`),
    ...written.filter((row) => !args.rows.some((each) => each.id === row.id)).map((row) => `the lead left out ${row.id}`),
  ];
  const rows = written.map((row) => {
    const cites = row.cites.flatMap((cite): Cite[] => {
      const looks = cite.receipts.flatMap((receipt) => { const record = lookAt(root, receipt); return record ? [record.facts.key] : []; });
      return looks.length ? looks.map((look) => ({ look, fragment: placeOf(cite.fragment) })) : [{ fragment: placeOf(cite.fragment), note: 'no look this run filed backs this place' }];
    });
    return { label: row.mark, value: row.value, note: row.note, cites };
  });
  const there = written.filter((row) => row.value === 'yes').length;
  return {
    format: 'agentrun.cited/1', title: `${args.document}: ${there} of ${written.length} marks there`, rows,
    document_check: { format: 'document-check/1', document: args.document, checklist: args.checklist, every: there === written.length, marks: written.map(({ id, value, p }) => ({ id, value, p })), differences },
  };
}

/** The run's directory: the place the reference entry hands every tool. */
const rootOf = (context?: { place?: { root: string } }) => {
  if (!context?.place) throw new Error('the reference entry hands every tool the run\'s place');
  return context.place.root;
};

export const tools = {
  cite: (args: Record<string, unknown>, context?: { place?: { root: string } }) => citedOf(rootOf(context), args as Parameters<typeof citedOf>[1]),
};
