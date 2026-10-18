// The result as the recording keeps it: the cited record, with each cite's picture or clip (the clip around a heard hit,
// the frame with Jev's box) kept as a blob of the recording and named on the cite beside its look and fragment, so the
// viewer shows the frame and plays the clip.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { DemoOptions } from '../reference/index.ts';
import type { Cite, Cited } from './tools.ts';

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const cited = record as Cited;
  const kept = ({ file, ...cite }: Cite): Cite => (file ? { ...cite, blob: keep(new Uint8Array(readFileSync(join(dir, 'work', file))), extname(file).slice(1)) } : cite);
  return { json: { ...cited, rows: cited.rows.map((row) => ({ ...row, cites: row.cites.map(kept) })) }, title: cited.title };
};
