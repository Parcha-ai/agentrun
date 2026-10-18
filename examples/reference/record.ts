// A recorder for agentrun.recording/1 (see the format's page): one directory a static viewer replays with no key and no
// server. Each process of a run writes its live and host lines to a spool of its own; one watcher (the process that
// holds the run) writes the durable lines of its commits from inside, stamping each with the time it observed it; the
// supervisor, outside every process, writes the host lines (`process.started`, `kill`). `finishRecording` joins the
// spools into `events.jsonl`, scans the recording (scan.ts), and writes the manifest only when nothing was found.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachInput, CommitRecorder, DurableLine } from './record-store.ts';
import { credentialInFile, scanRecording } from './scan.ts';

export const FORMAT = 'agentrun.recording/1';
type Meta = { path?: string; conv?: number; blobs?: string[] };
export type Redact = (text: string) => string;

export type Recorder = {
  /** The process's generation, known once it has opened the run; lines written before it carry it too. */
  generation(lease: number): void;
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

/** Keeps a file whole in `blobs/` under its SHA-256 and returns the hash. The bytes go to a temporary file in the recording's `.spool/` (which the scan and the validator ignore), are fsynced, and are renamed into
 *  `blobs/` (one filesystem, so the rename is atomic): a process killed while it writes leaves a temporary file in `.spool/` and never a torn blob under a name that says it is whole. */
export function keepBlob(dir: string, buffer: Buffer, extension: string): string {
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const hash = createHash('sha256').update(buffer).digest('hex');
  const at = join(dir, 'blobs', `${hash}.${extension}`);
  if (existsSync(at)) return hash;
  mkdirSync(spool(dir), { recursive: true });
  const temporary = join(spool(dir), `blob-${hash}.${extension}.tmp-${process.pid}`);
  const descriptor = openSync(temporary, 'w');
  // `writeSync` may write fewer bytes than asked (a full disk, a signal): every byte is written before the sync and the rename, or the call throws.
  try { for (let offset = 0; offset < buffer.length;) offset += writeSync(descriptor, buffer, offset); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, at);
  return hash;
}

/** A recorder for this process. Every line passes `redact` before it is written. */
/** The supervisor's writer: the host lines (`process.started`, `kill`, `result`) of a run's processes, written from outside them so
 *  they survive every kill. Its lines carry no `gen` (no run process wrote them) and number a `seq` of their own; the process a
 *  line is about is in its data (`process.started` `{ gen }`, `kill` `{ gen, label, crossing }`). */
export type Supervisor = { host(kind: string, data: unknown, meta?: Meta): void };

/** A supervisor for the recording in `dir`. A run in one process may be its own supervisor: pass this to `openRecorder`. */
export function openSupervisor(options: { dir: string; redact?: Redact }): Supervisor {
  const { dir } = options;
  const started = Date.parse(startedAt(dir));
  const file = join(spool(dir), `supervisor-${process.pid}-${Date.now()}.jsonl`);
  const redact = options.redact ?? ((text: string) => text);
  let seq = 0;
  return {
    host(kind, data, meta = {}) {
      const moved = moveImages(data === undefined ? null : data, (bytes, extension) => keepBlob(dir, bytes, extension));
      const blobs = [...new Set([...(meta.blobs ?? []), ...moved.blobs])];
      const line = { channel: 'live', source: 'host', kind, t: Math.max(0, Date.now() - started), seq: seq++, ...(meta.path !== undefined ? { path: meta.path } : {}), ...(meta.conv !== undefined ? { conv: meta.conv } : {}), data: moved.data, ...(blobs.length ? { blobs } : {}) };
      appendFileSync(file, `${redact(JSON.stringify(line))}\n`);
    },
  };
}

/** pi's agent events a recording keeps as live `pi` lines: where a turn starts and ends, a message starts and ends, a tool starts and ends. Streaming
 *  deltas, updates and snapshots are dropped. */
export const PI_LIVE_EVENTS = ['run_start', 'turn_start', 'turn_end', 'message_start', 'message_end', 'tool_execution_start', 'tool_execution_end'] as const;
/** One conversation's agent events: pi-durable's `watchEvents`, or a stand-in in a test. */
export type WatchEvents = (session: unknown, conv: number) => Promise<{ start(listener: (events: readonly { type: string }[]) => Promise<void>): void; stop(): Promise<unknown> }>;
const piWatch: WatchEvents = async (session, conv) => {
  const [{ watchEvents }, { BACKGROUND_CONTEXT }] = await Promise.all([import('@earendil-works/pi-durable'), import('@earendil-works/chord/context')]);
  return watchEvents(session as never, conv as never, BACKGROUND_CONTEXT) as never;
};

export function openRecorder(options: { dir: string; redact?: Redact; commits?: CommitRecorder; supervisor?: Supervisor; watch?: WatchEvents }): Recorder {
  const { dir } = options;
  const started = Date.parse(startedAt(dir));
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const file = join(spool(dir), `live-${process.pid}-${Date.now()}.jsonl`);
  const redact = options.redact ?? ((text: string) => text);
  // A process's number in THIS recording: how many processes have opened it, this one included. The run's own lease generation is not it (a
  // directory resumed into a fresh recording is already at 2), and the manifest, the live lines and process.started all count the recording's.
  appendFileSync(file, '');
  let gen = readdirSync(spool(dir)).filter((name) => name.startsWith('live-')).length;
  let seq = 0;
  let latest = 0;
  let stop: (() => Promise<void>) | undefined;
  const watching = new Map<number, Promise<Awaited<ReturnType<WatchEvents>> | undefined>>();
  const durableFile = join(spool(dir), `durable-${process.pid}-${Date.now()}.jsonl`);
  const keep = (bytes: Buffer, extension: string) => keepBlob(dir, bytes, extension);
  const write = (source: string, kind: string, data: unknown, meta: Meta = {}) => {
    const moved = moveImages(data === undefined ? null : data, keep);
    const blobs = [...new Set([...(meta.blobs ?? []), ...moved.blobs])];
    const line = { channel: 'live', source, kind, gen, t: Math.max(0, Date.now() - started), seq: seq++, ...(meta.path !== undefined ? { path: meta.path } : {}), ...(meta.conv !== undefined ? { conv: meta.conv } : {}), data: moved.data, ...(blobs.length ? { blobs } : {}) };
    appendFileSync(file, `${redact(JSON.stringify(line))}\n`);
  };
  return {
    generation() { options.supervisor?.host('process.started', { gen, pid: process.pid }); },
    async attach(input) {
      if (!options.commits) throw new Error('A recording needs the store export: no commit recorder was given.');
      const clock = () => Math.max(0, Date.now() - started);
      // Each conversation the store names gets its agent events recorded as live lines: the recorder sees a conversation in the
      // commit that creates it (or in the snapshot of a run that has it), and the events it watches begin from there.
      const follow = (conv: number) => {
        if (watching.has(conv)) return;
        const attached = (options.watch ?? piWatch)(input.session, conv).then((stream) => {
          stream.start(async (events) => {
            for (const event of events) if ((PI_LIVE_EVENTS as readonly string[]).includes(event.type)) { try { write('pi', event.type, event, { conv }); } catch { /* a recording line never fails the run */ } }
          });
          return stream;
        });
        // The setup promise is kept, so detach waits for a watcher still being set up and stops it.
        watching.set(conv, attached.catch(() => undefined));
      };
      stop = await options.commits({ ...input, clock }, (line) => {
        if (typeof line.conv === 'number') follow(line.conv);
        const moved = moveImages(line.data, keep);
        const blobs = [...new Set([...(line.blobs ?? []), ...moved.blobs])];
        latest = Math.max(latest, line.commit);
        appendFileSync(durableFile, `${redact(JSON.stringify({ ...line, data: moved.data, ...(blobs.length ? { blobs } : {}), t: line.t ?? clock() }))}\n`);
      });
    },
    async detach() { const end = stop; stop = undefined; await end?.(); for (const setup of [...watching.values()]) await (await setup)?.stop(); watching.clear(); },
    memo(key, value, meta = {}) {
      const moved = moveImages({ memo: key, value }, keep);
      const line = { channel: 'durable', source: 'pi', kind: 'pi.memo', gen, t: Math.max(0, Date.now() - started), commit: latest, order: null, ...(meta.path !== undefined ? { path: meta.path } : {}), ...(meta.conv !== undefined ? { conv: meta.conv } : {}), data: moved.data, ...(moved.blobs.length ? { blobs: moved.blobs } : {}) };
      appendFileSync(file, `${redact(JSON.stringify(line))}\n`);
    },
    live: (source, kind, data, meta) => write(source, kind, data, meta),
    // The payoff (`result`) is the supervisor's line: a process with no supervisor writes none. The supervisor's lines have no event-level gen, so the process they are about goes in the data (a `result`: `{ gen, blob, title }`).
    host: (kind, data, meta) => (!options.supervisor && kind === 'result' ? undefined : options.supervisor ? options.supervisor.host(kind, data !== null && typeof data === 'object' && !Array.isArray(data) && !('gen' in data) ? { gen, ...data } : data, meta) : write('host', kind, data, meta)),
    blob: (bytes, extension) => keepBlob(dir, typeof bytes === 'string' ? Buffer.from(redact(bytes)) : Buffer.from(bytes), extension),
  };
}

export type Header = {
  title: string; task: string; model: string; /** Default: the recording's own count of `process.started` lines. */ generations?: number; kills: number;
  code: { repo: string; commit: string; packages: Record<string, string> };
  /** The cost, or a function of the merged lines (fold.ts's cost: `null` while any part is unknown, never 0). */
  cost: { usd: number | null; parts: Record<string, number | null> } | ((lines: Record<string, unknown>[]) => { usd: number | null; parts: Record<string, number | null> });
  source: { run: string; store: string };
  result?: { blob: string; title: string };
  /** `real` when every priced part (model, eyes, browser, a door's outside call) is a real provider's; `scripted` when any is served by a fake, a cassette or a script. Default `scripted`: the reference example's parts are the faux's. */
  providers?: 'real' | 'scripted';
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
 *  the spool. Before the manifest it scans the recording (its lines, its blobs and the manifest's own text): a credential's
 *  shape or a machine path anywhere throws, and no manifest is written, so the directory is never a finished recording.
 *  A directory that already holds a finished recording is refused before anything in it changes. */
export function finishRecording(dir: string, header: Header): { lines: number } {
  // A finished recording is never written over: its events would change beside a manifest that no longer describes them.
  if (existsSync(join(dir, 'manifest.json'))) throw new Error(`${dir} already holds a finished recording; record into an empty directory.`);
  const files = existsSync(spool(dir)) ? readdirSync(spool(dir)).filter((name) => name.endsWith('.jsonl')) : [];
  const all = files.flatMap((name) => readLines(join(spool(dir), name)));
  // One total order for lines that tie on `t` (a millisecond): the supervisor's kill of one process, then the next process's start, then the
  // lines that process writes (durable, then live), and the payoff last. It agrees with the supervisor's own `seq` (a kill precedes the next
  // start) and puts a process's snapshot after its start, so no tie can form a cycle.
  const rank = (line: Record<string, unknown>) => (line.source === 'host' && line.channel === 'live' ? ({ kill: -2, 'process.started': -1, result: 2 } as Record<string, number>)[line.kind as string] ?? 1 : line.channel === 'durable' ? 0 : 1);
  const orderOf = (line: Record<string, unknown>) => (line.order === null ? Infinity : (line.order as number) ?? 0);
  all.sort((a, b) => (a.t as number) - (b.t as number) || rank(a) - rank(b) || ((a.commit as number) ?? 0) - ((b.commit as number) ?? 0) || orderOf(a) - orderOf(b) || ((a.seq as number) ?? 0) - ((b.seq as number) ?? 0));
  // A memo has no place inside its commit of its own: it follows the lines the store gave that commit.
  const next = new Map<number, number>();
  for (const line of all) if (line.channel === 'durable' && line.order !== null) next.set(line.commit as number, Math.max(next.get(line.commit as number) ?? 0, (line.order as number) + 1));
  for (const line of all) if (line.channel === 'durable' && line.order === null) { line.order = next.get(line.commit as number) ?? 0; next.set(line.commit as number, (line.order as number) + 1); }
  writeFileSync(join(dir, 'events.jsonl'), all.map((line) => JSON.stringify(line)).join('\n') + (all.length ? '\n' : ''));
  const store = existsSync(header.source.store) ? createHash('sha256').update(readFileSync(header.source.store)).digest('hex') : '0'.repeat(64);
  const started = readFileSync(startedFile(dir), 'utf8');
  const { source, cost, generations, ...rest } = header;
  const started_ = all.filter((line) => line.source === 'host' && line.kind === 'process.started').length;
  const manifest = JSON.stringify({ format: FORMAT, providers: 'scripted', ...rest, generations: generations ?? Math.max(1, started_), cost: typeof cost === 'function' ? cost(all) : cost, recorded: { started, ended: new Date().toISOString() }, source: { run: source.run, store_sha256: store } }, null, 2) + '\n';
  const inManifest = credentialInFile('manifest.json', manifest);
  const found = [...scanRecording(dir), ...(inManifest ? [{ file: 'manifest.json', found: inManifest }] : [])];
  if (found.length) {
    throw new Error(`${dir} is not finished: it holds ${found.map((each) => `a ${each.found} in ${each.file}`).join(', ')}. A recording is never published with one; redact it where it is written and record again.`);
  }
  writeFileSync(join(dir, 'manifest.json'), manifest);
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
  // The pi packages the run loaded: what a recording's pi lines are the lines of (section 2 lists them beside ours).
  for (const name of ['pi-durable', 'chord', 'pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui']) {
    try { packages[`@earendil-works/${name}`] = JSON.parse(readFileSync(join(root, 'node_modules', '@earendil-works', name, 'package.json'), 'utf8')).version; } catch { /* not installed here */ }
  }
  return { repo: 'Parcha-ai/agentrun', commit: git.status === 0 ? git.stdout.trim() : 'unknown', packages };
}
