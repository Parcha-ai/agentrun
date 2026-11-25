// A pool of worker threads that read a home's locators ahead of parseHome, each through a `seen` of its own
// (pool-worker.ts). parseHome still takes each read in the import's order and keeps it only when it is the read it would
// have made itself; any other it makes again, so the totals are the same whatever the pool does.
//
// A read made ahead of the import's order waits, whole, until parseHome takes it, so what the pool reads ahead is what it
// holds. The read parseHome waits for is always made next. Past it, while the reads waiting stay under the read-ahead
// (readAheadBytes()), the pool reads large files first (BIG_FILE and over, the largest first: they set the time), then
// the rest in the import's order; at the read-ahead it reads only the one parseHome waits for. A worker's heap is bounded (OLD_MB): one that
// runs out gives up its file, which parseHome reads itself, and another worker takes its place.
import { totalmem } from "node:os";
import { Worker } from "node:worker_threads";
import type { Locator, SessionRead } from "./reader.js";
import type { RecordIndex } from "./record-index.js";

/** A read the pool made: its sessions, the records it added, those it asked for and did not hold. Not ok: make it again. */
export type PoolRead = { ok: true; sessions: SessionRead[]; mine: RecordIndex; missed: RecordIndex } | { ok: false };

/** Each worker's young generation: the default lets eight workers' garbage add up to more than the reads themselves. The
 *  workers take none of this process's flags (a caller's `--input-type=module -e` would stop them loading). */
const YOUNG_MB = 16;

/** Each worker's old generation. Unbounded, each grows to several times what it holds (eight workers: 0.5 GiB of heap
 *  for 0.12 GiB in use, on a 24 GB home). A worker past it ends; its file is read by parseHome. */
export const OLD_MB = 64;

/** The share of a worker's old generation one line may take: a line past it is read by parseHome. A capped worker
 *  whose one native call (a line's decoding, JSON.parse) outgrows its heap does not end alone: V8 ends the process. At a
 *  64 MB heap, a 90 MB line of text, or a 15.9 MB line of empty objects (`[{},{},...]`, parsed to some 13 times its
 *  size), ends it; 14 MB of empty objects ends the worker alone. An eighth, 8 MB, leaves that margin. */
const LINE_SHARE = 8;

/** A file this large or larger is read ahead of the import's order, the largest first: such files set the time. */
export const BIG_FILE = 64 * 2 ** 20;

/** The most bytes of finished reads that may wait to be taken by default; at the read-ahead, the pool reads only the one
 *  parseHome waits for. A cap on finished reads waiting, plus at most one read in flight per thread; not on the process's
 *  memory. */
export const READ_AHEAD_BYTES = 2 ** 30;

/** The memory this process may use: its container's limit (process.constrainedMemory) when one is set below the
 *  machine's, else the machine's. A 2 GiB container on a 512 GiB host has 2 GiB. */
export const memoryLimit = (total = totalmem(), constrained = process.constrainedMemory()): number => (constrained > 0 && constrained < total ? constrained : total);

/** The default read-ahead: READ_AHEAD_BYTES, or a sixteenth of the memory this process may use when that is less (512 MiB
 *  at 8 GiB, 128 MiB in a 2 GiB container). */
export const readAheadBytes = (memory = memoryLimit()): number => Math.min(READ_AHEAD_BYTES, Math.floor(memory / 16));

/** Workers lost (out of memory, or ended) past this many times the threads: the pool stops, and parseHome reads the rest. */
const LOSSES_PER_THREAD = 2;

/** A session's objects beyond its typed arrays and its strings, as the budget counts them. */
const SESSION_BYTES = 1024;

/** A string past U+00FF: V8 holds it at two bytes a UTF-16 code unit, any other at one. */
const WIDE = /[^\u0000-\u00ff]/;

/** A session's strings (its first prompt and title can run to megabytes) as V8 holds them. */
export const stringBytes = (session: object): number =>
  Object.values(session).reduce((sum: number, value) => sum + (typeof value === "string" ? (WIDE.test(value) ? 2 : 1) * value.length : 0), 0);

type Job = { id: number; source: string; locator: Locator; size: number; state: "queued" | "running" | "waiting" | "taken"; read?: PoolRead; bytes: number };

const indexBytes = (index: RecordIndex): number =>
  [index.uuids.slots, index.uuids.owners, index.uuids.words, index.others.slots, index.others.owners, index.others.ends, index.others.bytes].reduce((sum, a) => sum + a.byteLength, 0);

/** What a read holds while it waits: its indexes' and counts' arrays, and its sessions with their strings. */
function heldBytes(read: PoolRead): number {
  if (!read.ok) return 0;
  let bytes = indexBytes(read.mine) + indexBytes(read.missed);
  for (const { session, counts } of read.sessions) bytes += SESSION_BYTES + stringBytes(session) + (counts ? counts.model.byteLength + counts.values.byteLength + counts.has.byteLength : 0);
  return bytes;
}

export class ReadPool {
  private readonly live = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly running = new Map<Worker, Job>();
  private readonly jobs: Job[] = [];
  /** Queued jobs, the largest first (the import's order among equals). */
  private bySize: Job[] = [];
  /** The job parseHome waits for (or last took): no job before it is read for it. */
  private cursor = 0;
  /** The first job, in the import's order, that may still be queued. */
  private nextInOrder = 0;
  /** The job parseHome waits for, and how it is handed over. */
  private wanted: { job: Job; done: (read: PoolRead) => void } | undefined;
  private waiting = 0;
  private losses = 0;
  private broken = false;
  /** The most bytes of reads waiting at once, and the workers lost (for measuring). The read-ahead is checked before a
   *  read is sent, so the reads in flight then (at most `threads`) may land past it. */
  peakWaiting = 0;
  lost = 0;

  constructor(private readonly threads: number, private readonly aheadBytes = readAheadBytes(), private readonly oldMb = OLD_MB) {
    // A worker that cannot start (no file descriptors, no memory) stops the pool: parseHome reads every file itself.
    try {
      for (let i = 0; i < threads; i += 1) this.spawn();
    } catch {
      this.fail();
    }
  }

  /** The bytes of reads waiting to be taken now. */
  get held(): number {
    return this.waiting;
  }

  /** Queues each locator; a job's id is its place in the import's order, so `items` come in that order. The ids, for take. */
  readAll(items: readonly { source: string; locator: Locator; size: number }[]): number[] {
    const ids = items.map(({ source, locator, size }) => {
      const job: Job = { id: this.jobs.length, source, locator, size, state: this.broken ? "taken" : "queued", bytes: 0 };
      this.jobs.push(job);
      return job.id;
    });
    this.bySize = this.jobs.filter((job) => job.state === "queued").sort((a, b) => b.size - a.size || a.id - b.id);
    this.dispatch();
    return ids;
  }

  /** The read of job `id`, made next when it is not made yet. Each id is taken once; a second take, or a pool that broke,
   *  gives a read that is not ok (parseHome makes it itself). */
  take(id: number): Promise<PoolRead> {
    const job = this.jobs[id]!;
    if (id > this.cursor) this.cursor = id;
    if (job.state === "waiting") {
      const read = job.read!;
      job.state = "taken";
      job.read = undefined;
      this.waiting -= job.bytes;
      this.dispatch();
      return Promise.resolve(read);
    }
    if (job.state === "taken") return Promise.resolve({ ok: false });
    return new Promise((done) => {
      this.wanted = { job, done };
      this.dispatch();
    });
  }

  /** Gives up jobs parseHome will not take (a source it reads again whole): their reads waiting are let go, those queued
   *  are not read, those running are let go when they end. */
  drop(ids: readonly number[]): void {
    for (const id of ids) {
      const job = this.jobs[id]!;
      if (job.state === "waiting") this.waiting -= job.bytes;
      job.state = "taken";
      job.read = undefined;
    }
    this.dispatch();
  }

  close(): void {
    this.fail();
  }

  private spawn(): void {
    const worker = new Worker(new URL("./pool-worker.js", import.meta.url), { execArgv: [], workerData: { maxLine: Math.floor((this.oldMb * 2 ** 20) / LINE_SHARE) }, resourceLimits: { maxYoungGenerationSizeMb: YOUNG_MB, maxOldGenerationSizeMb: this.oldMb } });
    worker.unref();
    worker.on("message", (read: PoolRead) => this.finished(worker, read));
    worker.on("error", () => this.gone(worker));
    worker.on("exit", () => this.gone(worker));
    this.live.add(worker);
    this.idle.push(worker);
  }

  /** The next job to read: the one parseHome waits for; else, while the reads waiting are under the budget, the largest
   *  file left if it is large, or the first queued past the cursor. */
  private pick(): Job | undefined {
    if (this.wanted?.job.state === "queued") return this.wanted.job;
    if (this.waiting >= this.aheadBytes) return undefined;
    while (this.bySize.length && this.bySize[0]!.state !== "queued") this.bySize.shift();
    if (this.bySize.length && this.bySize[0]!.size >= BIG_FILE) return this.bySize[0];
    if (this.nextInOrder < this.cursor) this.nextInOrder = this.cursor;
    while (this.nextInOrder < this.jobs.length && this.jobs[this.nextInOrder]!.state !== "queued") this.nextInOrder += 1;
    return this.jobs[this.nextInOrder];
  }

  private dispatch(): void {
    while (!this.broken && this.idle.length) {
      const job = this.pick();
      if (!job) return;
      const worker = this.idle.pop()!;
      job.state = "running";
      this.running.set(worker, job);
      // A worker with a read keeps the process alive: parseHome may wait on nothing else.
      worker.ref();
      worker.postMessage({ id: job.id, source: job.source, locator: job.locator });
    }
  }

  /** A job's read is made: handed to parseHome if it waits for it, else held until it takes it. */
  private made(job: Job, read: PoolRead): void {
    if (this.wanted?.job === job) {
      const { done } = this.wanted;
      this.wanted = undefined;
      job.state = "taken";
      done(read);
      return;
    }
    if (job.state === "taken") return; // dropped while it ran
    job.state = "waiting";
    job.read = read;
    job.bytes = heldBytes(read);
    this.waiting += job.bytes;
    if (this.waiting > this.peakWaiting) this.peakWaiting = this.waiting;
  }

  private finished(worker: Worker, read: PoolRead): void {
    const job = this.running.get(worker);
    this.running.delete(worker);
    this.idle.push(worker);
    worker.unref();
    if (job) this.made(job, read);
    this.dispatch();
  }

  /** A worker ended (out of memory, or crashed): its file is parseHome's to read, and another worker takes its place. */
  private gone(worker: Worker): void {
    if (!this.live.delete(worker) || this.broken) return;
    this.lost += 1;
    const at = this.idle.indexOf(worker);
    if (at !== -1) this.idle.splice(at, 1);
    const job = this.running.get(worker);
    this.running.delete(worker);
    if (job) this.made(job, { ok: false });
    if ((this.losses += 1) > LOSSES_PER_THREAD * this.threads) return this.fail();
    try {
      this.spawn();
    } catch {
      return this.fail();
    }
    this.dispatch();
  }

  /** The pool stops: no read is taken from it any more; parseHome makes each one itself. */
  private fail(): void {
    this.broken = true;
    for (const worker of this.live) void worker.terminate();
    for (const job of this.jobs) {
      job.state = "taken";
      job.read = undefined;
    }
    this.running.clear();
    this.waiting = 0;
    const wanted = this.wanted;
    this.wanted = undefined;
    wanted?.done({ ok: false });
  }
}
