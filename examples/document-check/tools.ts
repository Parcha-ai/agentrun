// The job's `cite` tool: one row a mark of the checklist, in its order: its short id, its label in words, its value yes or
// no, citing the look and the place on the page (`page=N` and, for a mark that is there, `&xywh=percent:x,y,w,h` of the
// page's crop box). The rows are the ones the verify skill's step 2 wrote to `.verify/<document>/marks.json` in the
// workspace, so a lead that submits other rows changes nothing; each row it submitted otherwise is listed in
// `differences`. Beside the rows: each page by its index in the file with its kind, and each look the scripts made with a
// short title, its takeaway in words and the places it read, so a step-by-step view of the run needs nothing else. It reads only
// what the run filed under its directory; a receipt that is not an ok look there is dropped, and a row left with no look
// keeps its places, said so.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LookRecord } from '@parcha/pi-vision';

export type Row = { id: string; mark: string; value: 'yes' | 'no'; p: number; note: string; cites: { fragment: string; receipts: string[] }[] };
export type Cite = { look?: string; blob?: string; fragment: string; note?: string };
/** The check itself, beside the cited rows: the document, the checklist, whether every mark is there, and each mark's
 *  short name with Jev's probability that it is there. */
export type DocumentCheck = {
  format: 'document-check/1'; document: string; checklist: string; every: boolean; marks: { id: string; value: 'yes' | 'no'; p: number }[]; differences: string[];
  /** Each page by its index in the file (the number every `page=N` cites), with its kind. */
  pages: { page: number; kind: string }[];
  /** Each look the scripts made, in the order they made them: its key, a short title, its takeaway, and the places it read. */
  looks: { look: string; title: string; takeaway: string; fragments: string[] }[];
};
export type Cited = { format: 'agentrun.cited/1'; title: string; rows: { id: string; label: string; value: string; note?: string; cites: Cite[] }[]; document_check: DocumentCheck };

/** A receipt the run filed, read back: the record, when the path is a file under the run's `evidence/` that parses as an ok look. */
export function lookAt(root: string, path: string): LookRecord | undefined {
  const at = resolve(root, path);
  if (!path.startsWith('evidence/') || relative(resolve(root), at).startsWith('..') || !existsSync(at)) return undefined;
  try {
    const record = JSON.parse(readFileSync(at, 'utf8')) as LookRecord;
    return record.tool === 'look' && record.status === 'ok' && typeof record.facts?.key === 'string' ? record : undefined;
  } catch { return undefined; }
}

/** `file.pdf#page=1&xywh=...` as the cited format writes a place in a document it keeps as a blob: the fragment alone,
 *  `page=1&xywh=...`, as pi-vision's formatFragment writes it. */
const placeOf = (fragment: string) => fragment.slice(fragment.lastIndexOf('#') + 1);

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

type Checklist = { pages: Record<string, string>; marks: { id: string; mark: string; page?: string; same?: string[] }[] };
type Pages = { pages: { page: number; kind: string; marks: Record<string, { p: number }>; receipts: string[] }[] };
const readJson = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; } };
/** A list in words; `;` between items whose own words hold an `and`. */
const listed = (items: string[], between = ', ') => (items.length > 1 ? `${items.slice(0, -1).join(between)}${between === ', ' ? ' and ' : '; and '}${items.at(-1)}` : items[0] ?? '');
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The pages with their kinds, and a title and takeaway for each look the scripts made, from the files they wrote:
 *  `pages.json` (step 1) and `marks.json` (step 2). */
function stepsOf(root: string, folder: string, list: Checklist, written: Row[]): Pick<DocumentCheck, 'pages' | 'looks'> {
  const { pages } = readJson<Pages>(join(folder, 'pages.json'), { pages: [] });
  const keyOf = (receipts: string[]) => receipts.map((receipt) => lookAt(root, receipt)).find(Boolean);
  const looks: DocumentCheck['looks'] = [];
  for (const { page, kind, marks, receipts } of pages) {
    const record = keyOf(receipts);
    if (!record) continue;
    const expected = list.marks.filter((mark) => mark.page === kind);
    const there = expected.filter((mark) => (marks[mark.id]?.p ?? 0) >= 0.5).map((mark) => lower(mark.mark));
    const missing = expected.filter((mark) => (marks[mark.id]?.p ?? 0) < 0.5).map((mark) => lower(mark.mark));
    looks.push({
      look: record.facts.key,
      title: `Checked page ${page}${kind === 'other' ? '' : `, the ${kind} page`}`,
      takeaway: kind === 'other' ? 'Not a page the checklist names, so no mark is looked for on it.'
        : [there.length ? `There: ${listed(there, '; ')}.` : '', missing.length ? `Not there: ${listed(missing, '; ')}.` : ''].filter(Boolean).join(' '),
      fragments: [`page=${page}`],
    });
  }
  for (const mark of list.marks.filter((m) => m.same)) {
    const row = written.find((each) => each.id === mark.id);
    const compared = row && keyOf(row.cites.flatMap((cite) => cite.receipts));
    // A comparison that was asked has a look of its own, whose path names its two cut-outs; one skipped has none.
    if (!row || !compared || !String(compared.args.path).includes('xywh=')) continue;
    looks.push({
      look: compared.facts.key, title: `Compared the two cut-outs: ${lower(mark.mark)}?`,
      takeaway: row.value === 'yes' ? `Yes: ${row.note}` : `No: ${row.note}`,
      fragments: String(compared.args.path).split(', ').filter((part) => part.includes('#')).map(placeOf),
    });
  }
  return { pages: pages.map(({ page, kind }) => ({ page, kind })), looks };
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
    return { id: row.id, label: row.mark, value: row.value, note: row.note, cites };
  });
  const there = written.filter((row) => row.value === 'yes').length;
  return {
    format: 'agentrun.cited/1', title: `${args.document}: ${there} of ${written.length} marks there`, rows,
    document_check: {
      format: 'document-check/1', document: args.document, checklist: args.checklist, every: there === written.length, marks: written.map(({ id, value, p }) => ({ id, value, p })), differences,
      ...stepsOf(root, join(root, 'work', '.verify', args.document.replace(/[^\w.-]+/g, '_')), JSON.parse(readFileSync(join(root, 'work', args.checklist), 'utf8')) as Checklist, written),
    },
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
