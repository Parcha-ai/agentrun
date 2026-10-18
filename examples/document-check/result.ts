// The result as the recording keeps it: the cited record, with the PDF that was checked kept as a blob and named by
// every cite, so the viewer's document panel opens the page a row cites and draws its box over it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoOptions } from '../reference/index.ts';
import type { Cited } from './tools.ts';

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const cited = record as Cited;
  const blob = keep(new Uint8Array(readFileSync(join(dir, 'work', cited.document_check.document))), 'pdf');
  const rows = cited.rows.map((row) => ({ ...row, cites: row.cites.map((cite) => ({ blob, ...cite })) }));
  return { json: { ...cited, rows }, title: cited.title };
};
