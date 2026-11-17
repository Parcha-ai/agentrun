// A run's video of its desktop's, phone's or browser's screen, where the agent's setting asks for one (computer.record:
// true, computer-setting.ts). The claim (workspace/computer-for-claim.ts) starts it once the computer is attached, beside
// the live view, and stops it at the computer's release, the run's end or its park; a browser's, each session's from its
// launch to its release (tools.ts), named by the session's computer.
//
// It is a second watch of the computer's screen (the provider's watch, on a connection of its own), so it records with no
// viewer open, and neither the live viewer's frames and acks nor the agent ever wait on it: each frame is acked as it
// comes. A browser's is the run's live view's one CDP screencast of the session, shared with its viewer (browserWatch),
// whose frames come as the page changes. Frames go to one ffmpeg per recorded computer, piped in (image2pipe), each stamped as ffmpeg reads it, so the
// video's frame rate is the screen's own (a screen that does not change adds nothing). At most RECORDING_LIMITS.fps frames
// a second are written: one that comes sooner waits in a one-frame slot, and a newer one replaces it (thinned). While
// ffmpeg has not taken the frame before, a newer one replaces the one waiting too (dropped): the encoder falling behind
// costs frames, never a wait. Both are counted, in the server's log at the recording's end. The long side is
// RECORDING_LIMITS.edge pixels at most, no audio.
//
// The file is fragmented MP4 (H.264), so whatever ends the recording (a crash included) leaves a file that plays up to its
// last fragment: recordings/<computer>.mp4 in the run's recordings folder (workspace/paths.ts recordingsFolder), beside
// work/ and never in it. A frame of another image format than the file's (a phone's PNG frames, then JPEG ones) ends that
// file and goes on in the next, <computer>-2.mp4, since one ffmpeg reads one format; a resumed run's claim starts the
// next file too. A frame of another size is fitted into the file's own (scaled and padded).
//
// Its caps stop it: RECORDING_LIMITS.maxBytes across the run's files (read from the folder at each check, so a park's
// earlier files and a browser's other sessions recording at once count too, and a run past it records no more) and maxMs of one recording (from its first frame to its
// stop or its park). So do ffmpeg ending by itself (a crash, a full disk) and the screen's watch ending past
// RECORDING_LIMITS.rewatches tries: each says so on the run's timeline, in words. The run itself never fails because of
// the recorder.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Result, ScreenFrame, ScreenWatch, ScreenWatchHandlers, WatchOptions } from "@parcha/agentrun-computer";
import type { LiveViewHost } from "@parcha/pi-browser/live-view";
import { commandOnPath } from "./host-command.js";

/** The program that encodes the video. */
export const FFMPEG = "ffmpeg";

/** The recorder's bounds: frames a second at most; the long side in pixels at most; the caps, in bytes across the run's
 *  files and in ms of one recording; how often the caps are checked; how long ffmpeg is given to finish its file once its input ends;
 *  how many times in a row a watch that ended is opened again, and after how long. */
export const RECORDING_LIMITS = { fps: 10, edge: 1280, maxBytes: 500 * 1024 * 1024, maxMs: 2 * 60 * 60 * 1000, checkMs: 1_000, settleMs: 5_000, rewatches: 3, rewatchMs: 1_000 } as const;

/** Why this server cannot record a screen, in words, or undefined: ffmpeg is on `path` (the server's PATH, read now). */
export const recorderMissing = (path: string | undefined = process.env.PATH): string | undefined =>
  commandOnPath(FFMPEG, path) ? undefined : "ffmpeg isn't installed on this server (no ffmpeg command on PATH)";

/** Why a recording stops: the computer was released, the run ended, or the run parked (it goes on in a new file when the
 *  run resumes, under the claim that resumes it). */
export type RecordingStop = "released" | "ended" | "parked";

/** What a recording did: its files (recordings/<name>), the frames written, the frames replaced while ffmpeg was busy
 *  (dropped) or within the frame rate's bound (thinned), and why it ended before it was stopped, in words. */
export type RecordingFacts = { readonly files: readonly string[]; readonly written: number; readonly dropped: number; readonly thinned: number; readonly ended?: string };

export interface Recording {
  /** Ends the recording: the newest frame written once more (so the video lasts until now), ffmpeg's input closed and its
   *  file finished, the watch let go. Idempotent; never throws. */
  stop(why: RecordingStop): Promise<void>;
  facts(): RecordingFacts;
}

/** The computer's watch, bound to its ref (provider.watch): the recorder gives the handlers and the signal. */
export type RecordWatch = (handlers: ScreenWatchHandlers, options: WatchOptions) => Promise<Result<Pick<ScreenWatch, "close">>>;

/** Browser session `tag`'s screen as the recorder watches it: the run's live view's screencast of it (pi-browser's
 *  LiveViewHost.watch), which the live view acks; JPEG frames of the page's size. */
export const browserWatch = (view: Pick<LiveViewHost, "watch">, tag: string): RecordWatch => async (handlers) => {
  let seq = 0;
  const unwatch = view.watch(tag, {
    frame: (bytes, { w, h }) => handlers.frame({ seq: ++seq, format: "jpeg", bytes, width: w, height: h, frameWidth: w, frameHeight: h }, () => undefined),
    ended: () => handlers.ended({ code: "unreachable", message: "the browser's DevTools socket closed" }),
  });
  return unwatch ? { ok: true, value: { close: async () => unwatch() } } : { ok: false, error: { code: "unreachable", message: "the browser session has no live view" } };
};

/** A run's browser sessions' recordings, each by its tag, where its claim records (ClaimBrowser.record): the answer is
 *  told session `id` under `tag` at its launch or its reopening, which starts its own (named by its computer, `id`) and
 *  ends the one before it under that tag, and null at its release, which ends it. With no `record`, nothing. */
export function sessionRecordings(view: Pick<LiveViewHost, "watch">, record: ((id: string, watch: RecordWatch) => Recording) | undefined): (tag: string, id: string | null) => Promise<void> {
  const held = new Map<string, { id: string; recording: Recording }>();
  return async (tag, id) => {
    const before = held.get(tag);
    if (before?.id === id) return;
    if (record && id !== null) held.set(tag, { id, recording: record(id, browserWatch(view, tag)) });
    else held.delete(tag);
    await before?.recording.stop("released");
  };
}

export type RecordInput = {
  readonly watch: RecordWatch;
  /** The run's recordings folder on this machine (recordingsFolder): made when the first frame comes. */
  readonly folder: string;
  /** The computer's ref id: its file's name. */
  readonly tag: string;
  readonly kind: "desktop" | "phone" | "browser";
  /** A line on the run's timeline. */
  readonly say: (words: string) => void;
  /** For tests: the program run in ffmpeg's place, the bounds, and where a line for the operator goes (default stderr). */
  readonly ffmpeg?: string;
  readonly limits?: Partial<typeof RECORDING_LIMITS>;
  readonly log?: (line: string) => void;
};

/** A file's name: the computer's ref id in the characters a file name takes, and the file's number after the first. */
const fileName = (tag: string, n: number): string => `${tag.replace(/[^A-Za-z0-9._-]/g, "_")}${n === 1 ? "" : `-${n}`}.mp4`;

/** A frame's size fitted to `edge` on its long side, each side even (H.264's 4:2:0 needs it). */
const fitted = (width: number, height: number, edge: number): [number, number] => {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  const even = (side: number) => Math.max(2, 2 * Math.round((side * scale) / 2));
  return [even(width), even(height)];
};

/** ffmpeg's arguments for one file: `format` frames piped in, each stamped as it is read (in ms), fitted into
 *  width x height, H.264 at the frames' own times, a key frame every 2 s at most apart, fragmented MP4. The file is on disk
 *  as it goes, a fragment at each key frame (run-recordings.ts reads it mid-run): the input is not probed (a quiet screen's
 *  few frames would never fill ffmpeg's 5 MB probe), it is decoded on one thread (the PNG decoder's frame threads hold one
 *  frame per core back), and each fragment is flushed as it is written. */
const argsOf = (format: ScreenFrame["format"], width: number, height: number, path: string): string[] => [
  "-hide_banner", "-loglevel", "error", "-nostats",
  "-probesize", "32", "-analyzeduration", "0", "-fpsprobesize", "0", "-threads", "1", "-use_wallclock_as_timestamps", "1", "-framerate", "1000", "-f", "image2pipe", "-c:v", format === "png" ? "png" : "mjpeg", "-i", "pipe:0",
  "-an", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
  "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "28",
  "-force_key_frames", "expr:gte(t,n_forced*2)", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-flush_packets", "1", "-f", "mp4", "-n", path,
];

/** A length in words: "2 h", "90 min", "45 s". */
const lengthWords = (ms: number): string => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);
/** A size in words: "500 MB". */
const sizeWords = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} bytes`);

/** One file being written: its ffmpeg, the image format it reads, its name in the run's folder and its path. `dead`: its
 *  ffmpeg ended; `ending`: this recorder ended its input. */
type Part = {
  readonly child: ChildProcessByStdio<Writable, null, Readable>;
  readonly format: ScreenFrame["format"];
  readonly name: string;
  readonly path: string;
  readonly exited: Promise<void>;
  dead: boolean;
  ending: boolean;
  stderr: string;
};

/** Starts recording the computer's screen (see the top of this file). It never throws: whatever goes wrong ends the
 *  recording with a line on the timeline. */
export function startRecording(input: RecordInput): Recording {
  const limits = { ...RECORDING_LIMITS, ...input.limits };
  const log = input.log ?? ((line: string) => void process.stderr.write(`agentrun-serve: ${line}\n`));
  const what = `the ${input.kind}`;
  const say = (words: string): void => {
    try {
      input.say(words);
    } catch {
      // The timeline's own failure is not the recording's.
    }
  };
  const gap = 1000 / limits.fps;
  const abort = new AbortController();
  const files: string[] = [];
  let watch: Pick<ScreenWatch, "close"> | undefined;
  let part: Part | undefined;
  /** The newest switch of files (switchPart): bounded, and awaited by the recording's end. */
  let switching: Promise<void> | undefined;
  /** The newest frame not written yet, and the newest written. */
  let slot: ScreenFrame | undefined;
  let last: ScreenFrame | undefined;
  /** A frame is being written, or a file opened. */
  let busy = false;
  let wroteAt = Number.NEGATIVE_INFINITY;
  let firstAt: number | undefined;
  let pacer: NodeJS.Timeout | undefined;
  let written = 0;
  let dropped = 0;
  let thinned = 0;
  /** Watches ended in a row with no frame between. */
  let misses = 0;
  /** Set once the recording ends: why, in words, or "" when it was stopped. */
  let over: string | undefined;
  let finished: Promise<void> | undefined;

  /** Whether ffmpeg took the bytes. */
  const write = (into: Part, bytes: Uint8Array): Promise<boolean> => new Promise((resolve) => {
    if (into.dead || into.ending || !into.child.stdin.writable) return resolve(false);
    // The callback comes once ffmpeg's pipe took the bytes, or with the pipe's error: a busy ffmpeg holds it back.
    into.child.stdin.write(bytes, (error) => resolve(!error));
  });

  /** Ends a file: `tail` (the newest frame once more) written, ffmpeg's input closed and its file finished, all within
   *  one settleMs deadline, past which ffmpeg is killed: an ffmpeg that stopped reading never holds up the release. */
  const endPart = async (ended: Part, tail?: Uint8Array): Promise<void> => {
    const deadline = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), limits.settleMs).unref());
    if (tail) await Promise.race([write(ended, tail), deadline]);
    ended.ending = true;
    ended.child.stdin.end();
    const late = await Promise.race([ended.exited.then(() => false), deadline]);
    if (late) {
      log(`ffmpeg did not finish ${ended.name} within ${limits.settleMs} ms; it was killed`);
      ended.child.kill("SIGKILL");
      await ended.exited;
    }
  };

  /** The bytes of every video in the run's folder: the byte cap is the run's, so it counts a park's earlier files and the
   *  files of the run's other recordings (a browser's sessions, each its own, can record at once). */
  const runBytes = async (listed?: readonly string[]): Promise<number> => {
    let total = 0;
    for (const one of (listed ?? (await readdir(input.folder).catch(() => []))).filter((name) => name.endsWith(".mp4"))) total += await stat(join(input.folder, one)).then((file) => file.size, () => 0);
    return total;
  };

  /** A file for `frame`'s format: its folder made, its name the first of the series not taken, its ffmpeg started. */
  const openPart = async (frame: ScreenFrame, before: Part | undefined): Promise<Part | undefined> => {
    let path: string;
    let name: string;
    let bytes: number;
    try {
      await mkdir(input.folder, { recursive: true, mode: 0o700 });
      const listed = await readdir(input.folder);
      const taken = new Set(listed);
      bytes = await runBytes(listed);
      let n = 1;
      while (taken.has(fileName(input.tag, n))) n += 1;
      name = `recordings/${fileName(input.tag, n)}`;
      path = join(input.folder, fileName(input.tag, n));
    } catch (error) {
      void finish(`its folder could not be made (${(error as NodeJS.ErrnoException).code ?? "an error"})`);
      return undefined;
    }
    if (bytes >= limits.maxBytes) {
      void finish(`it reached its cap of ${sizeWords(limits.maxBytes)}`);
      return undefined;
    }
    const [width, height] = fitted(frame.frameWidth, frame.frameHeight, limits.edge);
    const child = spawn(input.ffmpeg ?? FFMPEG, argsOf(frame.format, width, height, path), { stdio: ["pipe", "ignore", "pipe"] });
    let exited!: () => void;
    const opened: Part = { child, format: frame.format, name, path, exited: new Promise((resolve) => (exited = resolve)), dead: false, ending: false, stderr: "" };
    /** Set when ffmpeg did not start (its 'error' comes before any 'close'). */
    let unstarted: NodeJS.ErrnoException | undefined;
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => void (opened.stderr = (opened.stderr + chunk.toString("utf8")).slice(-2048)));
    child.once("close", (code, signal) => {
      opened.dead = true;
      exited();
      if (opened.ending || unstarted) return;
      const why = /no space left on device/i.test(opened.stderr) ? "the disk is full" : `ffmpeg stopped (${signal ? `signal ${signal}` : `exit code ${code}`})`;
      log(`ffmpeg stopped recording ${opened.name}: ${opened.stderr.trim().split("\n").at(-1) ?? ""}`);
      void finish(why);
    });
    unstarted = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      child.once("spawn", () => resolve(undefined));
      child.once("error", (error) => resolve(error));
    });
    if (unstarted) {
      opened.dead = true;
      exited();
      void finish(unstarted.code === "ENOENT" ? "ffmpeg isn't installed on this runner (no ffmpeg command on PATH)" : `ffmpeg could not start (${unstarted.code ?? unstarted.message})`);
      return undefined;
    }
    files.push(name);
    say(before ? `The ${input.kind}'s frames changed from ${before.format.toUpperCase()} to ${frame.format.toUpperCase()}: the recording goes on in ${name}.` : `Recording ${what}'s screen into ${name}.`);
    return opened;
  };

  /** The file for `frame`'s format, made `part`: the one before ended (its newest frame once more, so it lasts until
   *  the change), the next opened. The end of the recording waits on it. */
  const switchPart = async (frame: ScreenFrame): Promise<void> => {
    const before = part;
    part = undefined;
    if (before) await endPart(before, last && last.format === before.format ? last.bytes : undefined);
    if (over !== undefined) return;
    const opened = await openPart(frame, before);
    if (!opened) return;
    // Stopped while it opened: its file ends at once.
    if (over !== undefined) return void (await endPart(opened));
    part = opened;
  };

  const put = async (frame: ScreenFrame): Promise<void> => {
    if (!part || part.format !== frame.format) {
      switching = switchPart(frame);
      await switching;
      if (!part) return;
    }
    wroteAt = Date.now();
    firstAt ??= wroteAt;
    if (!(await write(part, frame.bytes))) return;
    written += 1;
    last = frame;
  };

  /** The frame waiting goes to ffmpeg, when ffmpeg is free and the frame rate's bound allows. */
  const pump = (): void => {
    if (over !== undefined || busy || !slot) return;
    const wait = wroteAt + gap - Date.now();
    if (wait > 0) {
      pacer ??= setTimeout(() => {
        pacer = undefined;
        pump();
      }, wait).unref();
      return;
    }
    const frame = slot;
    slot = undefined;
    busy = true;
    void put(frame).finally(() => {
      busy = false;
      pump();
    });
  };

  const onFrame = (next: ScreenFrame, ack: () => void): void => {
    // Acked at once: the watch never waits on the encoder.
    ack();
    if (over !== undefined) return;
    misses = 0;
    if (slot) {
      if (busy) dropped += 1;
      else thinned += 1;
    }
    slot = next;
    pump();
  };

  const lost = (error: { readonly code: string; readonly message: string }): void => {
    watch = undefined;
    if (over !== undefined) return;
    log(`the ${input.kind}'s screen watch for its recording ended: ${error.code}: ${error.message}`);
    if (error.code !== "gone" && misses < limits.rewatches) {
      misses += 1;
      setTimeout(() => void open(), limits.rewatchMs).unref();
      return;
    }
    void finish(error.code === "gone" ? "the computer is gone" : "its screen stopped answering");
  };

  const open = async (): Promise<void> => {
    if (over !== undefined) return;
    const started = await input.watch({ frame: onFrame, ended: lost }, { signal: abort.signal }).catch((error: unknown) => ({ ok: false as const, error: { code: "unreachable", message: (error as Error)?.message ?? String(error) } }));
    if (!started.ok) return lost(started.error);
    if (over !== undefined) return void (await started.value.close().catch(() => undefined));
    watch = started.value;
  };

  const checker = setInterval(() => {
    if (over !== undefined || firstAt === undefined) return;
    if (Date.now() - firstAt >= limits.maxMs) return void finish(`it reached its cap of ${lengthWords(limits.maxMs)}`);
    if (part) void runBytes().then((bytes) => (bytes >= limits.maxBytes && over === undefined ? finish(`it reached its cap of ${sizeWords(limits.maxBytes)}`) : undefined));
  }, limits.checkMs);
  checker.unref();

  /** The end of the recording, once: `why` in words when it ended by itself (said on the timeline), else stopped. */
  const finish = (why?: string): Promise<void> => (finished ??= (async () => {
    over = why ?? "";
    clearInterval(checker);
    if (pacer) clearTimeout(pacer);
    abort.abort();
    const watched = watch;
    watch = undefined;
    const closing = watched?.close().catch(() => undefined);
    if (why) say(`The recording of ${what} stopped: ${why}.${files.length ? ` ${files.join(", ")} ${files.length === 1 ? "keeps" : "keep"} what was recorded until then.` : ""}`);
    // A switch of files under way finishes first (the file before it ended, the next one not opened or ended at once),
    // so the stop returns with every ffmpeg done.
    await switching;
    const ending = part;
    part = undefined;
    if (ending) {
      // The newest frame once more, so the video lasts until now (a screen that did not change since has no frame of its
      // own): at a stop and at a cap alike; an ffmpeg that ended takes nothing.
      const newest = slot ?? last;
      await endPart(ending, !busy && newest && newest.format === ending.format ? newest.bytes : undefined);
    }
    // An ended recording keeps no picture: the claim holds each of its run's recordings until its own end.
    slot = undefined;
    last = undefined;
    await closing;
    if (files.length) log(`recorded ${what}'s screen into ${files.join(", ")}: ${written} frames written, ${dropped} dropped while ffmpeg was busy, ${thinned} thinned to ${limits.fps} a second`);
  })());

  void open();
  return {
    async stop(why) {
      if (over === undefined && why === "parked" && files.length > 0) say(`The recording of ${what} pauses while the run is parked: it goes on in a new file when the run resumes.`);
      await finish().catch(() => undefined);
    },
    facts: () => ({ files: [...files], written, dropped, thinned, ...(over ? { ended: over } : {}) }),
  };
}
