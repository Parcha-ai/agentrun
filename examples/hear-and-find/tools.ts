// The job's `answer` tool: every hit of the phrase resolved to the transcript look that heard it, the sighting resolved to
// the Jev look that checked its frame, that frame cut from the best copy with Jev's box drawn on it, and the cited result
// built from them. It reads only what the run filed under its directory; a receipt that is not an ok look there is left
// out, and a row with nothing to cite says so.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LookRecord } from '@parcha/pi-vision';

export type Hit = { at: number; cite: string; said: string; before: string; after: string };
export type Found = {
  heard: { hits: Hit[]; picked: number; why: string; receipts: string[] };
  seen: { found: boolean; at: number | null; cite: string | null; noul: number | null; confidence: number | null; spent_usd: number | null };
};
export type Cite = { look?: string; blob?: string; fragment?: string; note?: string };
export type Row = { label: string; value: string; note?: string; cites: Cite[] };
/** The part of the result only this example writes: what was heard and seen, and the frame with its box in the workspace. */
export type HearAndFind = {
  format: 'hear-and-find/1'; film: string; phrase: string; heard_question: string; thing: string; seen_question: string;
  heard: Found['heard']; seen: Found['seen'] & { box: number[] | null; frame: string; look: string | null };
};
export type Cited = { format: 'agentrun.cited/1'; title: string; rows: Row[]; hear_and_find: HearAndFind };

/** A record the run filed, read back: the record, when the path is a file under the run's `evidence/` that parses as an ok
 *  look or transcript. */
export function filedAt(root: string, path: string): LookRecord | undefined {
  const at = resolve(root, path);
  if (!path.startsWith('evidence/') || relative(resolve(root), at).startsWith('..') || !existsSync(at)) return undefined;
  try {
    const record = JSON.parse(readFileSync(at, 'utf8')) as LookRecord;
    return (record.tool === 'look' || record.tool === 'transcribe') && record.status === 'ok' && typeof record.facts?.key === 'string' ? record : undefined;
  } catch { return undefined; }
}

/** Every receipt the run filed under `evidence/`, with its record. */
function filed(root: string): { receipt: string; record: LookRecord }[] {
  const dir = join(root, 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const receipt = `evidence/${name}`;
    const record = filedAt(root, receipt);
    return record ? [{ receipt, record }] : [];
  });
}

/** `m:ss` (or `h:mm:ss`) of a second. */
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const [h, m, r] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

/** The seconds of the film a transcript look heard (`film#t=S,E`), or undefined. */
const spanOf = (record: LookRecord): [number, number] | undefined => {
  const match = /#t=([\d.]+),([\d.]+)/.exec(String(record.args.path));
  return match ? [Number(match[1]), Number(match[2])] : undefined;
};

/** The box of a citation (`#...&xywh=percent:x,y,w,h`), or null. */
export const boxOf = (cite: string | null): number[] | null => {
  const values = /xywh=percent:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(cite ?? '')?.slice(1).map(Number);
  return values && values.every(Number.isFinite) ? values : null;
};

/** The frame of `best` at `at` seconds, shown at its display shape, with the box drawn on it, as a JPEG in the workspace. */
export function frameWithBox(work: string, best: string, at: number, box: number[]): string {
  const [x, y, w, h] = box.map((value) => value / 100);
  const path = '.find/answer-frame.jpg';
  mkdirSync(join(work, '.find'), { recursive: true });
  const draw = `scale=trunc(iw*sar/2)*2:ih,setsar=1,drawbox=x=iw*${x}:y=ih*${y}:w=iw*${w}:h=ih*${h}:color=orange@0.95:t=3`;
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', best, '-frames:v', '1', '-vf', draw, '-q:v', '3', path], { cwd: work, stdio: 'ignore' }); } catch { return ''; }
  return existsSync(join(work, path)) ? path : '';
}

/** The cited result: the phrase's every hit (the one the question means first), then the sighting. */
export function citedOf(root: string, args: { film: string; best: string; phrase: string; heard_question: string; thing: string; seen_question: string; found: Found }): Cited {
  const { heard, seen } = args.found;
  const records = filed(root);
  const transcripts = heard.receipts.flatMap((receipt) => { const record = filedAt(root, receipt); return record?.tool === 'transcribe' ? [record] : []; });
  // A hit cites the transcript look whose piece of the film holds its second.
  const heardBy = (at: number): Cite[] => transcripts.filter((record) => { const span = spanOf(record); return !span || (at >= span[0] && at < span[1]); })
    .map((record) => ({ look: record.facts.key, fragment: `#t=${at}`, note: args.film }));
  const order = heard.hits.map((_, i) => i).sort((a, b) => Number(b === heard.picked) - Number(a === heard.picked) || heard.hits[a]!.at - heard.hits[b]!.at);
  const rows: Row[] = order.map((i) => {
    const hit = heard.hits[i]!;
    const picked = i === heard.picked;
    return {
      label: picked ? `Heard, ${args.heard_question}: "${args.phrase}"` : `Also heard: "${args.phrase}"`,
      value: `${clock(hit.at)} (${hit.at} s)`,
      note: picked ? heard.why : `before it: "${hit.before}"`,
      cites: heardBy(hit.at),
    };
  });
  if (!heard.hits.length) rows.push({ label: `Heard: "${args.phrase}"`, value: 'not in the transcript', cites: [] });

  const box = boxOf(seen.cite);
  const at = seen.found && seen.at !== null ? seen.at : null;
  // The Jev look that checked the frame at that second: the one whose image is named by that second of the film.
  const checked = at === null ? undefined : records.findLast(({ record }) => record.args.via === 'jev' && record.args.path === `${args.film}#t=${at}`);
  const frame = at !== null && box ? frameWithBox(join(root, 'work'), args.best, at, box) : '';
  rows.push(at === null
    ? { label: `Seen, ${args.seen_question}`, value: 'not found', note: `the search spent $${seen.spent_usd ?? 'unknown'} and stopped by the find skill's rules`, cites: [] }
    : {
      label: `Seen, ${args.seen_question}: ${args.thing}`, value: `${clock(at)} (${at} s)`,
      note: `Jev: ${seen.noul} that it is there, box confidence ${seen.confidence}`,
      cites: checked ? [{ look: checked.record.facts.key, fragment: seen.cite?.slice(seen.cite.indexOf('#')) ?? `#t=${at}`, note: args.film }] : [],
    });
  return {
    format: 'agentrun.cited/1', title: `${args.film}: "${args.phrase}" heard ${heard.hits.length} time${heard.hits.length === 1 ? '' : 's'}, ${args.thing} ${at === null ? 'not found' : `first seen at ${clock(at)}`}`,
    rows,
    hear_and_find: { format: 'hear-and-find/1', film: args.film, phrase: args.phrase, heard_question: args.heard_question, thing: args.thing, seen_question: args.seen_question, heard, seen: { ...seen, box, frame, look: checked?.record.facts.key ?? null } },
  };
}

/** The run's directory: the place the reference entry hands every tool. */
const rootOf = (context?: { place?: { root: string } }) => {
  if (!context?.place) throw new Error('the reference entry hands every tool the run\'s place');
  return context.place.root;
};

export const tools = {
  answer: (args: Record<string, unknown>, context?: { place?: { root: string } }) => citedOf(rootOf(context), args as Parameters<typeof citedOf>[1]),
};
