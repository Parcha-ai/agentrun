// The job's `cite` tool: every chapter's receipts resolved to the looks that back them, each chapter's keyframe taken at the
// second the agent chose for it (inside the chapter, one picture a chapter), and the cited result built from them. It reads only
// what the run filed under its directory; a receipt that is not an ok look there is dropped, and a chapter left with none is
// dropped too, each with the reason.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { LookRecord } from '@parcha/pi-vision';

export type Chapter = { title: string; start_s: number; end_s: number; note: string; at_s: number; receipts: string[] };
/** The video part of the result: each chapter with the looks it rests on (their keys) and its keyframe's path in the workspace
 *  (empty when none could be taken). */
export type VideoChapters = {
  format: 'video-chapters/1'; film: string; summary: string;
  chapters: (Omit<Chapter, 'receipts'> & { keyframe: string; looks: string[] })[];
  dropped: { chapter: string; why: string }[];
};
export type Cite = { look?: string; blob?: string; fragment?: string; note?: string };
export type Cited = { format: 'agentrun.cited/1'; title: string; rows: { label: string; value: string; note?: string; cites: Cite[] }[]; video_chapters: VideoChapters };

/** A receipt the run filed, read back: the record, when the path is a file under the run's `evidence/` that parses as a look. */
export function lookAt(root: string, path: string): LookRecord | undefined {
  const at = resolve(root, path);
  if (!path.startsWith('evidence/') || relative(resolve(root), at).startsWith('..') || !existsSync(at)) return undefined;
  try {
    const record = JSON.parse(readFileSync(at, 'utf8')) as LookRecord;
    return record.tool === 'look' && record.status === 'ok' && typeof record.facts?.key === 'string' ? record : undefined;
  } catch { return undefined; }
}

/** `m:ss` (or `h:mm:ss`) of a second. */
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const [h, m, r] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

/** The window a look saw, as its fragment names it (`film#t=S,E`): `#t=S,E`. */
const windowOf = (record: LookRecord) => /#t=[\d.]+(?:,[\d.]+)?/.exec(String(record.args.path))?.[0];

/** A frame's mean brightness (0 to 255), or undefined when ffmpeg could not read it. */
function brightnessAt(work: string, film: string, second: number): number | undefined {
  try {
    const printed = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(second), '-i', basename(film), '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { cwd: work, encoding: 'utf8' });
    const mean = Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(printed)?.[1]);
    return Number.isFinite(mean) ? mean : undefined;
  } catch { return undefined; }
}

/** At or below this mean brightness a frame is black (video black is 16; a fade, a gap between cuts): a keyframe is taken a
 *  little later instead. */
const BLACK = 20;

/** One frame of the film at a second inside [from, to), as a JPEG in the workspace: the second asked, or the first one after
 *  it, two seconds apart, whose frame is not black. The path and the second taken, or '' when ffmpeg could take none. */
export function keyframeAt(work: string, film: string, index: number, second: number, to = second + 1): { path: string; at: number } {
  let at = second;
  for (let next = second; next < to && next <= second + 10; next += 2) {
    const mean = brightnessAt(work, film, next);
    if (mean === undefined) break;
    if (mean > BLACK) { at = next; break; }
  }
  const path = `.look/keys/${index + 1}-${at}.jpg`;
  mkdirSync(join(work, '.look', 'keys'), { recursive: true });
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', basename(film), '-frames:v', '1', '-q:v', '3', path], { cwd: work, stdio: 'ignore' }); } catch { return { path: '', at }; }
  return { path: existsSync(join(work, path)) ? path : '', at };
}

/** The cited result: a summary row, then one row a chapter (its title, its start, its note), citing the looks of its windows. */
export function citedOf(root: string, args: { film: string; summary: string; chapters: Chapter[] }): Cited {
  const dropped: VideoChapters['dropped'] = [];
  const chapters: VideoChapters['chapters'] = [];
  const rows: Cited['rows'] = [];
  for (const chapter of args.chapters) {
    const looks = chapter.receipts.flatMap((receipt) => { const record = lookAt(root, receipt); return record ? [record] : []; });
    if (!looks.length) { dropped.push({ chapter: chapter.title, why: 'none of its receipts is an ok look this run filed' }); continue; }
    // The keyframe's second is inside the chapter: one the agent chose outside it is the chapter's middle.
    const chosen = chapter.at_s >= chapter.start_s && chapter.at_s < chapter.end_s ? chapter.at_s : Math.round((chapter.start_s + chapter.end_s) / 2);
    const { path: keyframe, at } = keyframeAt(join(root, 'work'), args.film, chapters.length, chosen, chapter.end_s);
    if (!keyframe) dropped.push({ chapter: chapter.title, why: `no keyframe could be taken at ${at} s` });
    const { receipts: _receipts, ...kept } = chapter;
    chapters.push({ ...kept, at_s: at, keyframe, looks: looks.map((record) => record.facts.key) });
    rows.push({
      label: chapter.title, value: `${clock(chapter.start_s)} to ${clock(chapter.end_s)}`, note: chapter.note,
      cites: looks.map((record) => ({ look: record.facts.key, fragment: windowOf(record) ?? `#t=${chapter.start_s},${chapter.end_s}`, note: args.film })),
    });
  }
  return {
    format: 'agentrun.cited/1', title: `${args.film}, in ${rows.length} chapter${rows.length === 1 ? '' : 's'}`,
    rows: [{ label: 'Summary', value: args.summary, cites: [] }, ...rows],
    video_chapters: { format: 'video-chapters/1', film: args.film, summary: args.summary, chapters, dropped },
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
