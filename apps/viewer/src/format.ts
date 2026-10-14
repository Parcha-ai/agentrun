// agentrun.recording/1 (RECORDING.md): the types, the line order, and the validator of section 3's invariants.

export const FORMAT = 'agentrun.recording/1';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Source = 'workflow' | 'pi' | 'browser' | 'vision' | 'transport' | 'host';

export type Line = {
  channel: 'durable' | 'live';
  source: Source;
  kind: string;
  /** Live: the process that wrote it. Durable: the journal opens before its commit, absent before the first. */
  gen?: number;
  t: number;
  commit?: number;
  order?: number;
  seq?: number;
  path?: string;
  conv?: number;
  data: Json;
  blobs?: string[];
  /** A copy of a document's value taken when a process opened the run: it replaces the value per (doc, key), and is
   *  outside the commits' strict order. */
  snapshot?: boolean;
};

export type Manifest = {
  format: string;
  title: string;
  task: string;
  recorded: { started: string; ended: string };
  code: { repo: string; commit: string; packages: Record<string, string> };
  model: string;
  generations: number;
  kills: number;
  cost: { usd: number | null; parts: Record<string, number | null> };
  source: { run: string; store_sha256: string };
  result?: { blob: string; title: string };
};

/** A recording as the viewer holds it: its manifest, its lines in file order, and where a blob's bytes are. */
export type Recording = { id: string; manifest: Manifest; lines: Line[]; blobUrl(sha: string): string | undefined };

const SOURCES = new Set(['workflow', 'pi', 'browser', 'vision', 'transport', 'host']);
const isInt = (value: unknown, min = 0) => Number.isInteger(value) && (value as number) >= min;

/** `events.jsonl`'s lines, in file order. */
export function parseLines(text: string): Line[] {
  return text.split('\n').filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) as Line; } catch { throw new Error(`events.jsonl line ${index + 1} does not parse`); }
  });
}

/** What breaks the format in a recording, at most `limit` problems; empty when it obeys sections 2 and 3. */
export function validate(manifest: unknown, lines: Line[], blobs?: Set<string>, limit = 20): string[] {
  const problems: string[] = [];
  const note = (problem: string) => { if (problems.length < limit) problems.push(problem); };
  const m = manifest as Partial<Manifest> | null;
  if (!m || m.format !== FORMAT) note(`manifest.format is not ${FORMAT}`);
  if (typeof m?.title !== 'string') note('manifest.title is missing');
  if (!isInt(m?.generations, 1)) note('manifest.generations is not a whole number from 1');
  if (!isInt(m?.kills)) note('manifest.kills is not a whole number');
  const parts = Object.values(m?.cost?.parts ?? {});
  if (m?.cost && parts.some((part) => part === null) && m.cost.usd !== null) note('manifest.cost.usd is a number though a part is unknown');
  if (m?.result && blobs && !blobs.has(m.result.blob)) note(`manifest.result.blob ${m.result.blob} is not in blobs/`);

  let last: { commit: number; order: number } | undefined;
  let lastT = -Infinity;
  const seqs = new Map<number, number>();
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (line.channel !== 'durable' && line.channel !== 'live') note(`${at}: channel is ${String(line.channel)}`);
    if (!SOURCES.has(line.source)) note(`${at}: source is ${String(line.source)}`);
    if (typeof line.kind !== 'string' || line.kind === '') note(`${at}: no kind`);
    if (line.gen !== undefined ? !isInt(line.gen, 1) : line.channel === 'live') note(`${at}: gen is not a whole number from 1`);
    if (typeof line.t !== 'number' || !Number.isFinite(line.t)) note(`${at}: t is not a number`);
    else { if (line.t < lastT) note(`${at}: t goes back`); lastT = line.t; }
    if (line.path !== undefined && typeof line.path !== 'string') note(`${at}: path is not a string`);
    if (line.conv !== undefined && !isInt(line.conv)) note(`${at}: conv is not a whole number`);
    for (const sha of line.blobs ?? []) if (blobs && !blobs.has(sha)) note(`${at}: blob ${sha} is not in blobs/`);
    if (line.channel === 'durable') {
      if (!isInt(line.commit) || !isInt(line.order)) { note(`${at}: a durable line needs commit and order`); return; }
      if (line.seq !== undefined) note(`${at}: a durable line has no seq`);
      if (line.snapshot === true) return;
      if (last && line.commit! < last.commit) note(`${at}: commit ${line.commit} after commit ${last.commit}`);
      else if (last && line.commit === last.commit && line.order! <= last.order) note(`${at}: (commit, order) does not increase`);
      last = { commit: line.commit!, order: line.order! };
    } else if (line.channel === 'live') {
      if (!isInt(line.seq)) { note(`${at}: a live line needs seq`); return; }
      if (line.commit !== undefined || line.order !== undefined) note(`${at}: a live line has no commit or order`);
      const before = seqs.get(line.gen!);
      if (before !== undefined && line.seq! <= before) note(`${at}: seq does not increase in process ${line.gen}`);
      seqs.set(line.gen!, line.seq!);
    }
  });
  return problems;
}

/** Whether `path` is `focus` or under it, as execution paths nest. */
export const under = (path: string | undefined, focus: string | undefined) =>
  focus === undefined || (path !== undefined && (path === focus || path.startsWith(`${focus}/`)));
