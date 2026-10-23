// The run's browser frames, for the replay player on its page. pi-browser's frame recorder hands this store each
// agentrun.recording/1 `frame` and `frame.gap` line with its JPEG, and the store keeps them in `<run>/frames/`:
// `frames.jsonl`, one line each with its `seq`, and `blobs/<sha256>.jpg`. The directory is owner-only (0700, its files
// 0600), since after a sign-in the frames show the person's own pages. It is beside the run, outside `work/`, so no tool
// of the agent's reaches it, and nothing that packs, exports or replays a run reads it.
//
// While the person drives the browser the store is held: from `hold()` (request_sign_in calls it before its result
// exists) until `lift()` (the agent's next tool call), it refuses every frame, and it writes one `frame.gap`
// (`credential_on_page`, detail `host`) where the frames stopped. A refused frame is one the recorder counts as dropped,
// so it never becomes the place a later gap starts from. The recorder's own credential check runs as well. Each line
// the store keeps, and only those, is handed to `kept` once it is on disk (the run's recording, when it has one).
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLine, FrameSink } from "@parcha/pi-browser/recorder";

export const FRAMES_DIR = "frames";
export const FRAMES_FILE = "frames.jsonl";

export type FrameStore = {
  /** The recorder's sink. */
  sink: FrameSink;
  /** From now on every frame is dropped; the first hold writes the gap. */
  hold(): void;
  lift(): void;
  readonly held: boolean;
  /** Every line handed over so far is on disk. */
  flush(): Promise<void>;
};

/** The frames of the run in `runDir`; `clock` is the `t` of the gap a hold writes (ms since the recording started). */
export function frameStore(runDir: string, clock: () => number, kept?: FrameSink): FrameStore {
  const dir = join(runDir, FRAMES_DIR);
  const blobs = join(dir, "blobs");
  const file = join(dir, FRAMES_FILE);
  let held = false;
  let seq: number | null = null;
  /** Where the frames stand: the session and conversation of the newest frame kept, and its `t`. */
  let last: { session: string; conv: number; t: number } | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function open(): Promise<number> {
    if (seq !== null) return seq;
    await mkdir(blobs, { recursive: true, mode: 0o700 });
    for (const path of [dir, blobs]) await chmod(path, 0o700);
    const known = await readFile(file, "utf8").catch(() => "");
    if (known) await chmod(file, 0o600);
    return (seq = known.split("\n").filter(Boolean).length);
  }

  async function write(line: FrameLine, bytes?: Record<string, Uint8Array>): Promise<void> {
    const n = await open();
    for (const [sha, blob] of Object.entries(bytes ?? {})) {
      if (!/^[0-9a-f]{64}$/.test(sha) || createHash("sha256").update(blob).digest("hex") !== sha) continue;
      await writeFile(join(blobs, `${sha}.jpg`), blob, { mode: 0o600, flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    seq = n + 1;
    await appendFile(file, `${JSON.stringify({ ...line, seq: seq })}\n`, { mode: 0o600 });
    try { await kept?.(line, bytes); } catch { /* a recording never loses the run its frames */ }
  }

  /** In the order lines were handed over; a line that cannot be written is lost, never retried out of order. */
  const enqueue = (line: FrameLine, bytes?: Record<string, Uint8Array>) => {
    const done = queue.then(() => write(line, bytes));
    queue = done.catch(() => undefined);
    return done;
  };

  return {
    sink(line, bytes) {
      if (line.kind === "frame") {
        if (held) return Promise.reject(new Error("not kept: the person is driving the browser"));
        last = { session: line.data.session, conv: line.conv, t: line.t };
      }
      return enqueue(line, bytes);
    },
    hold() {
      if (held) return;
      held = true;
      if (last) void enqueue({ channel: "live", source: "browser", kind: "frame.gap", t: clock(), conv: last.conv, data: { session: last.session, from: last.t, reason: "credential_on_page", detail: "host" } }).catch(() => undefined);
    },
    lift() {
      held = false;
    },
    get held() {
      return held;
    },
    flush: () => queue,
  };
}
