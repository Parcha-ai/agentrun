// The result as the recording keeps it: the cited record, with each chapter's keyframe kept as a blob and cited beside its
// looks at the second it was taken (`#t=`), so the viewer shows the frame and the cited panel opens the film there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoOptions } from '../reference/index.ts';
import type { Cited } from './tools.ts';

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const cited = record as Cited;
  const byTitle = new Map(cited.video_chapters.chapters.map((chapter) => [chapter.title, chapter]));
  const rows = cited.rows.map((row) => {
    const chapter = byTitle.get(row.label);
    if (!chapter?.keyframe) return row;
    const blob = keep(new Uint8Array(readFileSync(join(dir, 'work', chapter.keyframe))), 'jpg');
    return { ...row, cites: [{ blob, fragment: `#t=${chapter.at_s}`, note: 'keyframe' }, ...row.cites] };
  });
  return { json: { ...cited, rows }, title: cited.title };
};
