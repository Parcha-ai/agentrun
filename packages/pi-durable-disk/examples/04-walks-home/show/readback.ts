// The take server's own durability check, turned into notes. With `--evidence-readback`, 03's server reads the run's work/ back from the
// disk's object store after each handover (never through the mount the pipe wrote it with) and logs `pipe.readback`; a difference logs
// `pipe.readback-mismatch`, and a read-back that cannot finish `pipe.readback-failed`. Only a read-back that equals BOTH the pipe's seal and
// what the leaving host acknowledged may back a zero-loss caption (evidence "independent-readback", see page/caption.ts). Everything else
// is shown for what it is, never as proof.
//
// The server's log also holds the run's link (and so its secret). The watcher reads it, keeps only the lines it recognises as one of the
// three events above, and never prints, stores or forwards anything else from it. A note carries counts and sizes: no digest, no path.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Note } from "./types.ts";

export type ReadbackResult =
  | { kind: "verified"; run: string; files: number; bytes: number; ms: number }
  | { kind: "unacked"; run: string; files: number; bytes: number; ms: number }
  | { kind: "differs"; run: string; match: boolean; ackedMatch: boolean | null; files: number; bytes: number; ms: number }
  | { kind: "paths"; run: string; missing: number; extra: number; differ: number; changedSinceRelease: number }
  | { kind: "failed"; run: string };

export type ReadbackNote = { kind: Note["kind"]; text: string; measured: boolean; evidence?: "independent-readback" };

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const size = (v: unknown): number | undefined => (Array.isArray(v) ? v.length : undefined);

/** One line of the server's log: the result it states, or undefined for any other line (including a line that is not JSON). */
export function parseReadbackLine(line: string): ReadbackResult | undefined {
  if (!line.includes('"pipe.readback')) return undefined;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    o = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof o.run !== "string" || o.run === "") return undefined;
  const run = o.run;
  if (o.event === "pipe.readback") {
    const files = count(o.files);
    const bytes = count(o.bytes);
    const ms = count(o.ms);
    if (files === undefined || bytes === undefined || ms === undefined) return undefined;
    // Strict booleans: a string "true" or a missing field is not a verdict.
    if (typeof o.match !== "boolean") return undefined;
    if (o.ackedMatch !== null && typeof o.ackedMatch !== "boolean") return undefined;
    if (o.match && o.ackedMatch === true) return { kind: "verified", run, files, bytes, ms };
    if (o.match && o.ackedMatch === null) return { kind: "unacked", run, files, bytes, ms };
    return { kind: "differs", run, match: o.match, ackedMatch: o.ackedMatch, files, bytes, ms };
  }
  if (o.event === "pipe.readback-mismatch") {
    const [missing, extra, differ, changedSinceRelease] = [o.missing, o.extra, o.differ, o.changedSinceRelease].map(size);
    if (missing === undefined || extra === undefined || differ === undefined || changedSinceRelease === undefined) return undefined;
    return { kind: "paths", run, missing, extra, differ, changedSinceRelease };
  }
  if (o.event === "pipe.readback-failed") return { kind: "failed", run };
  return undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** 03's server lists at most this many paths per kind in a mismatch event, so a list this long is a lower bound, not a count. */
export const PATH_LIST_CAP = 50;
const bound = (n: number) => (n >= PATH_LIST_CAP ? `at least ${n}` : String(n));
const bytesLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

/** What the stage says about a result. Only `verified` is evidence that nothing was lost. */
export function readbackNote(r: ReadbackResult): ReadbackNote {
  switch (r.kind) {
    case "verified":
      return {
        kind: "story",
        text: `Read back from the disk's object store after the handover: ${plural(r.files, "file")}, ${bytesLabel(r.bytes)}, identical to what the tab had acknowledged and to what the pipe sealed (read in ${r.ms} ms). Nothing was lost.`,
        measured: true,
        evidence: "independent-readback",
      };
    case "unacked":
      return {
        kind: "story",
        text: `Read back from the disk's object store after the handover: ${plural(r.files, "file")}, ${bytesLabel(r.bytes)}, identical to what the pipe sealed. The leaving host sent no acknowledged workspace, so this does not show what the tab had acknowledged.`,
        measured: false,
      };
    case "differs": {
      const what = !r.match && r.ackedMatch === false ? "what the pipe sealed and from what the tab had acknowledged" : !r.match ? "what the pipe sealed" : "what the tab had acknowledged";
      return { kind: "story", text: `Read back from the disk's object store after the handover, ${plural(r.files, "file")}, DIFFERS from ${what}.`, measured: true };
    }
    case "paths":
      return {
        kind: "story",
        text: `The read-back found ${bound(r.missing)} missing, ${bound(r.differ)} changed and ${bound(r.extra)} extra paths; ${bound(r.changedSinceRelease)} of them were written in the second before the release or later, which the next host may have written.`,
        measured: true,
      };
    case "failed":
      return { kind: "story", text: "The read-back after the handover could not finish, so nothing is shown about what survived it.", measured: false };
  }
}

export type WatcherOptions = {
  /** The server's log file now (it moves with a retake), or undefined while there is none. */
  file: () => string | undefined;
  /** The run the stage is showing: lines about any other run are ignored. */
  run: () => string | undefined;
  /** Counts each time the stage's feed adopts a link (a first connection, a retake). A new server's results wait for it to advance. */
  epoch: () => number;
  onNote: (note: ReadbackNote) => void;
  intervalMs?: number;
  now?: () => number;
  /** How long a new server's results wait for the feed to follow its link before the run's name alone decides. Default 30 s. */
  holdMs?: number;
};

/**
 * Tails the take server's log for the three read-back events. It starts at the end of the file it first sees (what happened before the
 * stage was watching is not replayed with a new timestamp), reads a file that replaced it from its start (a restarted server), and
 * keeps nothing but the lines it recognises.
 */
export class ReadbackWatcher {
  private opts: WatcherOptions;
  private path: string | undefined;
  private ino = -1;
  private offset = 0;
  private partial = "";
  private seen = false;
  /** A log that replaced the one before it is a new server's: its results wait until the feed has followed the new link. */
  private hold: { epoch: number; since: number } | undefined;
  private held: ReadbackResult[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WatcherOptions) {
    this.opts = options;
  }

  start(): void {
    if (this.timer) return;
    this.poll(); // where the tail begins: lines written from now on are read, even before the first tick
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The hold ends when the feed has followed the new link, or after `holdMs`; what waited is shown if it is about the run on the stage. */
  private release(): void {
    if (!this.hold) return;
    if (this.opts.epoch() < this.hold.epoch && this.now() - this.hold.since < (this.opts.holdMs ?? 30_000)) return;
    const held = this.held;
    this.held = [];
    this.hold = undefined;
    for (const result of held) this.deliver(result);
  }

  poll(): void {
    this.release();
    const path = this.opts.file();
    if (path === undefined) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    try {
      const st = fstatSync(fd);
      const replaced = this.path !== path || this.ino !== st.ino || st.size < this.offset;
      if (replaced) {
        // The first file ever seen is tailed from its end; one that replaced it is a new server's, read from its start.
        this.offset = this.seen ? 0 : st.size;
        if (this.seen && !this.hold) this.hold = { epoch: this.opts.epoch() + 1, since: this.now() };
        this.partial = "";
        this.path = path;
        this.ino = st.ino;
      }
      this.seen = true;
      const chunk = Buffer.alloc(64 * 1024);
      while (this.offset < st.size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.partial += chunk.toString("utf8", 0, n);
        const lines = this.partial.split("\n");
        this.partial = lines.pop() ?? "";
        // A line that is not a read-back event is dropped here, unread by anything else: the log holds the run's secret.
        for (const line of lines) this.take(line);
        if (this.partial.length > 1024 * 1024) this.partial = "";
      }
    } finally {
      closeSync(fd);
    }
  }

  private take(line: string): void {
    const result = parseReadbackLine(line);
    if (!result) return;
    if (this.hold) {
      if (this.held.length < 50) this.held.push(result);
      return;
    }
    this.deliver(result);
  }

  private deliver(result: ReadbackResult): void {
    if (result.run !== this.opts.run()) return;
    this.opts.onNote(readbackNote(result));
  }
}
