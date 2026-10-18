// The result as the recording keeps it: the cited record, with each chapter's keyframe kept as a blob and cited beside its
// looks at the second it was taken (`#t=`), and each look's window frame kept as a blob on that look's cite, so the viewer
// shows the frames and the cited panel opens the film there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoOptions } from '../reference/index.ts';
import type { Cite, Cited } from './tools.ts';

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const cited = record as Cited;
  const byTitle = new Map(cited.video_chapters.chapters.map((chapter) => [chapter.title, chapter]));
  const kept = ({ file, ...cite }: Cite): Cite => (file ? { ...cite, blob: keep(new Uint8Array(readFileSync(join(dir, 'work', file))), 'jpg') } : cite);
  const rows = cited.rows.map((row) => {
    const chapter = byTitle.get(row.label);
    const cites = row.cites.map(kept);
    if (!chapter?.keyframe) return { ...row, cites };
    const blob = keep(new Uint8Array(readFileSync(join(dir, 'work', chapter.keyframe))), 'jpg');
    // The keyframe cites the look whose window holds its second.
    const holds = cites.find((cite) => { const [from, to] = (cite.fragment ?? '').replace('#t=', '').split(',').map(Number); return chapter.at_s >= from! && chapter.at_s < to!; }) ?? cites[0];
    return { ...row, cites: [{ ...(holds?.look ? { look: holds.look } : {}), blob, fragment: `#t=${chapter.at_s}`, note: 'keyframe' }, ...cites] };
  });
  return { json: { ...cited, rows }, title: cited.title };
};
