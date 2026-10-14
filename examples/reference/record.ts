// A recorder for agentrun.recording/1 (see the format's page): one directory a static viewer replays with no key and no
// server. Each process of a run writes its live and host lines to a spool of its own; one watcher (the process that
// holds the run) writes the durable lines of its commits from inside, stamping each with the time it observed it; the
// supervisor, outside every process, writes the host lines (`process.started`, `kill`). `finishRecording` joins the
// spools into `events.jsonl` and writes the manifest.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachInput, CommitRecorder, DurableLine } from './record-store.ts';

export const FORMAT = 'agentrun.recording/1';
type Meta = { path?: string; conv?: number; blobs?: string[] };
export type Redact = (text: string) => string;

export type Recorder = {
  /** The process's generation, known once it has opened the run; lines written before it carry it too. */
  generation(n: number): void;
  /** Starts recording the open run's commits (a snapshot of every document first), from inside this process. Called from
   *  the disk package's `beforeResume` hook, which has the Harness, the Storage and the head; `clock` is the recorder's. */
  attach(input: Omit<AttachInput, 'clock'>): Promise<void>;
  /** Stops recording commits and waits for the queued writes. */
  detach(): Promise<void>;
  /** A line of what is in flight. It never changes a count. */
  live(source: 'workflow' | 'pi' | 'browser' | 'vision' | 'transport', kind: string, data: unknown, meta?: Meta): void;
  /** A line about the process itself: `process.started`, `kill`, `result`. */
  host(kind: string, data: unknown, meta?: Meta): void;
  /** A task memo pi keeps, captured while its task runs (a post-run export has none). It is placed after the lines of the
   *  store's latest commit at the moment it is seen: `latestCommit` says which that is. */
  memo(key: string, value: unknown, meta?: Meta): void;
  /** Keeps a file whole under its hash and returns the hash. */
  blob(bytes: Uint8Array | string, extension: string): string;
};

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Moves every image block inside `data` into `blobs/`, leaving `{ type: 'image', mimeType, blob }`: the SHA-256 of the file. A
 *  block that already names a blob is left alone. Returns the data and the hashes it now points at. */
export function moveImages(data: unknown, keep: (bytes: Buffer, extension: string) => string): { data: unknown; blobs: string[] } {
  const blobs: string[] = [];
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.type === 'image' && typeof record.data === 'string') {
      const mimeType = typeof record.mimeType === 'string' ? record.mimeType : 'image/png';
      const { data: encoded, ...rest } = record;
      const blob = keep(Buffer.from(encoded as string, 'base64'), EXTENSIONS[mimeType] ?? 'bin');
      blobs.push(blob);
      return { ...rest, mimeType, blob };
    }
    if (record.type === 'image' && typeof record.blob === 'string') blobs.push(record.blob);
    return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, walk(inner)]));
  };
  return { data: walk(data), blobs };
}

const spool = (dir: string) => join(dir, '.spool');
const startedFile = (dir: string) => join(spool(dir), 'started');

/** The recording's clock: ISO text of the moment the first recorder opened it. */
export function startedAt(dir: string): string {
  mkdirSync(spool(dir), { recursive: true });
  try { writeFileSync(startedFile(dir), new Date().toISOString(), { flag: 'wx' }); } catch { /* another process opened it first */ }
  return readFileSync(startedFile(dir), 'utf8');
}

/** Keeps a file whole in `blobs/` under its SHA-256 and returns the hash. */
function keepBlob(dir: string, buffer: Buffer, extension: string): string {
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const hash = createHash('sha256').update(buffer).digest('hex');
  const at = join(dir, 'blobs', `${hash}.${extension}`);
  if (!existsSync(at)) writeFileSync(at, buffer);
  return hash;
}

/** A recorder for this process. Every line passes `redact` before it is written. */
export function openRecorder(options: { dir: string; redact?: Redact; commits?: CommitRecorder }): Recorder {
  const { dir } = options;
  const started = Date.parse(startedAt(dir));
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const file = join(spool(dir), `live-${process.pid}-${Date.now()}.jsonl`);
  const redact = options.redact ?? ((text: string) => text);
  let gen = 1;
  let seq = 0;
  let latest = 0;
  let stop: (() => Promise<void>) | undefined;
  const durableFile = join(spool(dir), `durable-${process.pid}-${Date.now()}.jsonl`);
  const keep = (bytes: Buffer, extension: string) => keepBlob(dir, bytes, extension);
  const write = (source: string, kind: string, data: unknown, meta: Meta = {}) => {
    const moved = moveImages(data === undefined ? null : data, keep);
    const blobs = [...new Set([...(meta.blobs ?? []), ...moved.blobs])];
    const line = { channel: 'live', source, kind, gen, t: Math.max(0, Date.now() - started), seq: seq++, ...(meta.path !== undefined ? { path: meta.path } : {}), ...(meta.conv !== undefined ? { conv: meta.conv } : {}), data: moved.data, ...(blobs.length ? { blobs } : {}) };
    appendFileSync(file, `${redact(JSON.stringify(line))}\n`);
  };
  return {
    generation(n) { gen = n; },
    async attach(input) {
      if (!options.commits) throw new Error('A recording needs the store export: no commit recorder was given.');
      const clock = () => Math.max(0, Date.now() - started);
      stop = await options.commits({ ...input, clock }, (line) => {
        const moved = moveImages(line.data, keep);
        const blobs = [...new Set([...(line.blobs ?? []), ...moved.blobs])];
        latest = Math.max(latest, line.commit);
        appendFileSync(durableFile, `${redact(JSON.stringify({ ...line, data: moved.data, ...(blobs.length ? { blobs } : {}), t: line.t ?? clock() }))}\n`);
      });
    },
    async detach() { const end = stop; stop = undefined; await end?.(); },
    memo(key, value, meta = {}) {
      const moved = moveImages({ memo: key, value }, keep);
      const line = { channel: 'durable', source: 'pi', kind: 'pi.memo', gen, t: Math.max(0, Date.now() - started), commit: latest, order: null, ...(meta.path !== undefined ? { path: meta.path } : {}), ...(meta.conv !== undefined ? { conv: meta.conv } : {}), data: moved.data, ...(moved.blobs.length ? { blobs: moved.blobs } : {}) };
      appendFileSync(file, `${redact(JSON.stringify(line))}\n`);
    },
    live: (source, kind, data, meta) => write(source, kind, data, meta),
    host: (kind, data, meta) => write('host', kind, data, meta),
    blob: (bytes, extension) => keepBlob(dir, typeof bytes === 'string' ? Buffer.from(redact(bytes)) : Buffer.from(bytes), extension),
  };
}

export type Header = {
  title: string; task: string; model: string; generations: number; kills: number;
  code: { repo: string; commit: string; packages: Record<string, string> };
  cost: { usd: number | null; parts: Record<string, number | null> };
  source: { run: string; store: string };
  result?: { blob: string; title: string };
};

const readLines = (path: string): Record<string, unknown>[] => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').split('\n');
  const out: Record<string, unknown>[] = [];
  text.forEach((line, index) => {
    if (!line) return;
    try { out.push(JSON.parse(line)); } catch { if (index !== text.length - 1) throw new Error(`${path} line ${index + 1} is not JSON`); /* a process killed mid-write leaves a torn last line */ }
  });
  return out;
};

/** Merges the spools into `events.jsonl` (by `t`, a tie by (commit, order), then seq), writes `manifest.json`, and removes
 *  the spool. */
export function finishRecording(dir: string, header: Header): { lines: number } {
  const files = existsSync(spool(dir)) ? readdirSync(spool(dir)).filter((name) => name.endsWith('.jsonl')) : [];
  const all = files.flatMap((name) => readLines(join(spool(dir), name)));
  const rank = (line: Record<string, unknown>) => (line.channel === 'durable' ? 0 : 1);
  const orderOf = (line: Record<string, unknown>) => (line.order === null ? Infinity : (line.order as number) ?? 0);
  all.sort((a, b) => (a.t as number) - (b.t as number) || rank(a) - rank(b) || ((a.commit as number) ?? 0) - ((b.commit as number) ?? 0) || orderOf(a) - orderOf(b) || ((a.seq as number) ?? 0) - ((b.seq as number) ?? 0));
  // A memo has no place inside its commit of its own: it follows the lines the store gave that commit.
  const next = new Map<number, number>();
  for (const line of all) if (line.channel === 'durable' && line.order !== null) next.set(line.commit as number, Math.max(next.get(line.commit as number) ?? 0, (line.order as number) + 1));
  for (const line of all) if (line.channel === 'durable' && line.order === null) { line.order = next.get(line.commit as number) ?? 0; next.set(line.commit as number, (line.order as number) + 1); }
  writeFileSync(join(dir, 'events.jsonl'), all.map((line) => JSON.stringify(line)).join('\n') + (all.length ? '\n' : ''));
  const store = existsSync(header.source.store) ? createHash('sha256').update(readFileSync(header.source.store)).digest('hex') : '0'.repeat(64);
  const started = readFileSync(startedFile(dir), 'utf8');
  const { source, ...rest } = header;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: FORMAT, ...rest, recorded: { started, ended: new Date().toISOString() }, source: { run: source.run, store_sha256: store } }, null, 2) + '\n');
  rmSync(spool(dir), { recursive: true, force: true });
  return { lines: all.length };
}

export type { DurableLine };

/** The code a recording was cut from: the repository, its commit, and the version of each workspace package. */
export function codeOf(root: string): Header['code'] {
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const packages: Record<string, string> = {};
  for (const entry of readdirSync(join(root, 'packages'))) {
    try { const manifest = JSON.parse(readFileSync(join(root, 'packages', entry, 'package.json'), 'utf8')); packages[manifest.name] = manifest.version; } catch { /* not a package */ }
  }
  return { repo: 'Parcha-ai/agentrun', commit: git.status === 0 ? git.stdout.trim() : 'unknown', packages };
}
