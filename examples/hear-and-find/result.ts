// The result as the recording keeps it: the cited record, with the frame where the thing is first seen kept as a blob, Jev's
// box drawn on it, and cited beside the Jev look at its second and box (`#t=S&xywh=percent:`), so the viewer shows the frame.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoOptions } from '../reference/index.ts';
import type { Cited } from './tools.ts';

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const cited = record as Cited;
  const { seen } = cited.hear_and_find;
  if (!seen.frame || seen.at === null || !seen.box) return { json: cited, title: cited.title };
  const blob = keep(new Uint8Array(readFileSync(join(dir, 'work', seen.frame))), 'jpg');
  const picture = { blob, fragment: `#t=${seen.at}&xywh=percent:${seen.box.join(',')}`, note: 'the frame, with the box Jev drew' };
  const rows = cited.rows.map((row, i) => (i === cited.rows.length - 1 ? { ...row, cites: [picture, ...row.cites] } : row));
  return { json: { ...cited, rows }, title: cited.title };
};
