// A pool of worker threads that read a home's locators ahead of parseHome, each through a `seen` of its own
// (pool-worker.ts). parseHome still takes each read in the import's order and keeps it only when it is the read it would
// have made itself; any other it makes again, so the totals are the same whatever the pool does.
//
// A read made ahead of the import's order waits, whole, until parseHome takes it, so what the pool reads ahead is what it
// holds. The read parseHome waits for is always made next. Past it, while the reads waiting stay under the read-ahead
// (readAheadBytes()), the pool reads large files first (BIG_FILE and over, the largest first: they set the time), then
// the rest in the import's order; at the read-ahead it reads only the one parseHome waits for. A worker's heap is bounded (OLD_MB): one that
// runs out gives up its file, which parseHome reads itself, and another worker takes its place.
import { readFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Locator, SessionRead } from "./reader.js";
import { indexArrays, type RecordIndex } from "./record-index.js";

/** A read the pool made: its sessions, the records it added, those it asked for and did not hold. Not ok: make it again. */
export type PoolRead = { ok: true; sessions: SessionRead[]; mine: RecordIndex; missed: RecordIndex } | { ok: false };

/** Each worker's young generation: the default lets eight workers' garbage add up to more than the reads themselves. The
 *  workers take none of this process's flags (a caller's `--input-type=module -e` would stop them loading). */
const YOUNG_MB = 16;

/** Each worker's old generation. Unbounded, each grows to several times what it holds (eight workers: 0.5 GiB of heap
 *  for 0.12 GiB in use, on a 24 GB home). A worker past it ends; its file is read by parseHome. */
export const OLD_MB = 64;

/** The smallest old generation a worker may be given (parseHome's workerOldMb). On node 24.22.3, one pool worker started
 *  at N MB to read a synthetic home of four files (one of 1.2 MB), each N in a process of its own: at 1 and 2 MB V8 ends
 *  the whole process as the worker starts ("Fatal JavaScript out of memory: GC during deserialization"); from 3 to 6 MB
 *  no worker read a file (5 processes each, 29 at 6); at 7, 28 of 29 processes lost a worker; at 8 to 10 (29 processes
 *  each) and at 11 and 12 (5 each), every worker read every file. A worker under it can only end the process or lose
 *  every read, so it is refused. */
export const MIN_OLD_MB = 8;

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

/** One cgroup v2 level's memory: its limit, the lower of its memory.max and memory.high (Infinity: neither sets one),
 *  and its working set when it has a limit, memory.current less memory.stat's inactive_file (undefined: unreadable). */
type CgroupLevel = { limit: number; workingSet?: number };

/** A cgroup file's bytes: Infinity when it is "max", missing (the host's root cgroup has none) or not a number. */
function bytesIn(dir: string, file: string): number {
  try {
    const value = readFileSync(join(dir, file), "utf8").trim();
    return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : Infinity;
  } catch {
    return Infinity;
  }
}

/** What a cgroup holds that the kernel will not give back: memory.current, which counts page cache, less the page cache it
 *  takes back first (inactive_file). Raw memory.current swung by gigabytes a second on a machine whose cache came and
 *  went; this does not count that cache. Undefined where either file is unreadable. */
function workingSetOf(dir: string): number | undefined {
  try {
    const current = readFileSync(join(dir, "memory.current"), "utf8").trim();
    const inactive = /^inactive_file (\d+)$/m.exec(readFileSync(join(dir, "memory.stat"), "utf8"));
    if (!/^\d+$/.test(current) || !inactive) return undefined;
    return Math.max(0, Number(current) - Number(inactive[1]));
  } catch {
    return undefined;
  }
}

/** This process's cgroup v2 and every cgroup above it, the leaf first: undefined for cgroup v1 (no "0::" line), no
 *  /proc/self/cgroup (not Linux), a path outside the mount, or any error. Synchronous: read while the pool is sized, a
 *  few small files. */
function cgroupLevels(root: string, self: string): CgroupLevel[] | undefined {
  try {
    const line = readFileSync(self, "utf8").split("\n").find((l) => l.startsWith("0::"));
    if (line === undefined) return undefined;
    const parts = line.slice(3).split("/").filter((p) => p !== "" && p !== ".");
    if (parts.includes("..")) return undefined;
    const levels: CgroupLevel[] = [];
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const dir = join(root, ...parts.slice(0, depth));
      const limit = Math.min(bytesIn(dir, "memory.max"), bytesIn(dir, "memory.high"));
      levels.push(limit < Infinity ? { limit, workingSet: workingSetOf(dir) } : { limit });
    }
    return levels;
  } catch {
    return undefined;
  }
}

/** The container's memory limit: process.constrainedMemory(), or the lowest memory.max or memory.high of this process's
 *  cgroup v2 and every cgroup above it when that is lower. Node reads only the process's own cgroup (the lower of its
 *  memory.max and memory.high, libuv 1.52); this takes the same rule up the tree. A container whose process sits in
 *  /init.scope (memory.max "max") under a namespace root of 4 GiB had no limit by Node, and the pool was sized for the
 *  host's 810 GB. Where no cgroup v2 level can be read, `constrained` as it is. */
export function constrainedMemory(root = "/sys/fs/cgroup", self = "/proc/self/cgroup", constrained = process.constrainedMemory()): number {
  const levels = cgroupLevels(root, self);
  if (!levels) return constrained;
  const lowest = Math.min(constrained > 0 ? constrained : Infinity, ...levels.map((level) => level.limit));
  return lowest === Infinity ? constrained : lowest;
}

/** The memory this process's cgroups still have room for: at each level with a limit (constrainedMemory's), the limit
 *  less its working set (workingSetOf), the least of them, never under 0. Infinity where no level has both a limit and a
 *  readable working set. A 2 GiB container already holding 1 GiB has 1 GiB of room, though the machine has hundreds free. */
export function cgroupRoom(root = "/sys/fs/cgroup", self = "/proc/self/cgroup"): number {
  let room = Infinity;
  for (const { limit, workingSet } of cgroupLevels(root, self) ?? []) if (workingSet !== undefined) room = Math.min(room, Math.max(0, limit - workingSet));
  return room;
}

/** The memory this process may use: its container's limit (constrainedMemory) when one is set below the machine's, else
 *  the machine's. A 2 GiB container on a 512 GiB host has 2 GiB. */
export const memoryLimit = (total = totalmem(), constrained = constrainedMemory()): number => (constrained > 0 && constrained < total ? constrained : total);

/** The default read-ahead: READ_AHEAD_BYTES, or a sixteenth of the memory this process may use when that is less (512 MiB
 *  at 8 GiB, 128 MiB in a 2 GiB container). */
export const readAheadBytes = (memory = memoryLimit()): number => Math.min(READ_AHEAD_BYTES, Math.floor(memory / 16));

/** The default threads' ceiling. On a 48-core machine, a 23 GB home (pooled, median of 2) took 27.5 s at 8 threads
 *  (peak 1.13 GiB), 20.3 s at 16 (1.77 GiB), 17.2 s at 24 (2.39 GiB) and 23.3 s at 32 (2.87 GiB): 16 takes most of 24's
 *  gain for three quarters of its memory, and past 24 the threads slow each other down. */
export const DEFAULT_THREADS_CEILING = 16;

/** The most a worker's heap holds: its young generation (YOUNG_MB) and its old one (`oldMb`), both capped at its start.
 *  The pool's peak grew by about this, 80 MiB a worker at the default, from 8 threads to 24 (the runs DEFAULT_THREADS_CEILING cites). */
export const workerBytes = (oldMb = OLD_MB): number => (YOUNG_MB + oldMb) * 2 ** 20;

/** The memory still free to this process: the machine's (os.freemem, MemAvailable on Linux: page cache it may reclaim
 *  counts as free), at most its container's limit (memoryLimit) and the room its cgroups have left (cgroupRoom: each
 *  limit less what is in use, page cache the kernel takes back first not counted). Not process.availableMemory: under a
 *  cgroup it takes the limit less memory.current, which counts all the page cache as used. On a 503 GiB machine with
 *  345 GiB free, in a cgroup of 350 GiB whose 346 GiB in use were 250 GiB of page cache, it read 130 MiB to 3.6 GiB from
 *  one second to the next. */
export const freeMemory = (free = freemem(), limit = memoryLimit(), room = cgroupRoom()): number => Math.min(free, limit, room);

/** parseHome's default threads: the fewest of
 *  - the cores this process may run on, one left for the thread that takes the reads and totals them (two cores keep
 *    two threads: one worker would read no faster than the calling thread alone);
 *  - DEFAULT_THREADS_CEILING;
 *  - the workers whose heaps (workerBytes) fit in the memory still free (freeMemory) once the read-ahead (`aheadBytes`)
 *    is set aside, since the reads waiting are held on the calling thread;
 *  and at least 1 (every file read on the calling thread). A caller's `threads` is taken as given, up to MOST_THREADS. */
export const defaultThreads = (cores = availableParallelism(), available = freeMemory(), aheadBytes = readAheadBytes(), oldMb = OLD_MB): number => {
  const byCores = cores <= 2 ? cores : cores - 1;
  const byMemory = Math.floor(Math.max(0, available - aheadBytes) / workerBytes(oldMb));
  return Math.max(1, Math.min(byCores, DEFAULT_THREADS_CEILING, byMemory));
};

/** Workers lost (out of memory, or ended) past this many times the threads: the pool stops, and parseHome reads the rest. */
const LOSSES_PER_THREAD = 2;

/** A session's objects beyond its typed arrays and its strings, as the budget counts them. */
const SESSION_BYTES = 1024;

/** A string past U+00FF: V8 holds it at two bytes a UTF-16 code unit, any other at one. */
const WIDE = /[^\u0000-\u00ff]/;

/** A read's strings as V8 holds them (a session's first prompt and title can run to megabytes), wherever they are in its
 *  objects and arrays (a session's turns, a read's requests and paths): each object once, on a stack of its own, so no
 *  depth runs the call stack out and a cycle ends. A typed array holds none: heldBytes counts its bytes apart. */
export function stringBytes(read: object): number {
  let bytes = 0;
  const visited = new Set<object>();
  const stack: unknown[] = [read];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") bytes += (WIDE.test(value) ? 2 : 1) * value.length;
    else if (typeof value === "object" && value !== null && !ArrayBuffer.isView(value) && !visited.has(value)) {
      visited.add(value);
      for (const inner of Array.isArray(value) ? value : Object.values(value)) stack.push(inner);
    }
  }
  return bytes;
}

type Job = { id: number; source: string; locator: Locator; size: number; state: "queued" | "running" | "waiting" | "taken"; read?: PoolRead; bytes: number };

const indexBytes = (index: RecordIndex): number => indexArrays(index).reduce((sum, a) => sum + a.byteLength, 0);

/** What a read holds while it waits: its indexes' and counts' arrays, and its sessions with their strings. */
function heldBytes(read: PoolRead): number {
  if (!read.ok) return 0;
  let bytes = indexBytes(read.mine) + indexBytes(read.missed);
  for (const sessionRead of read.sessions) {
    const { counts } = sessionRead;
    bytes += SESSION_BYTES + stringBytes(sessionRead) + (counts ? counts.model.byteLength + counts.values.byteLength + counts.has.byteLength : 0);
  }
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
  /** The most bytes of reads waiting at once, read by the lane's measuring script alone. The read-ahead is checked before
   *  a read is sent, so the reads in flight then (at most `threads`) may land past it. */
  peakWaiting = 0;

  constructor(private readonly threads: number, private readonly aheadBytes = readAheadBytes(), private readonly oldMb = OLD_MB) {
    // A worker that cannot start (no file descriptors, no memory) stops the pool: parseHome reads every file itself.
    try {
      for (let i = 0; i < threads; i += 1) this.spawn();
    } catch {
      this.fail();
    }
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
