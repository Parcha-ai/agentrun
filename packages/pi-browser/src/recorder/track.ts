import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FrameGapData } from "./frames.js";
import { jpegSampling, jpegSize } from "./jpeg.js";

/** `frame.track`: written at export, one per session. The blobs are the WebM and its index, in that order. */
export type FrameTrackData = { session: string; fps: number; from: number; to: number };
export type FrameTrackLine = { channel: "live"; source: "browser"; kind: "frame.track"; t: number; conv: number; data: FrameTrackData; blobs: [string, string] };

/** One stretch of the track: a frame shown, or the slate (`sha256` null) while the session had no frame to show. Times are the recording's. */
export type TrackSegment = { start: number; end: number; sha256: string | null; reason?: string };
export type TrackFrame = { t: number; ms: number; sha256: string; w: number; h: number };
export type TrackGap = { from: number; to: number; reason: string; detail?: string };
export type TrackPlan = { session: string; conv: number; fps: number; from: number; to: number; width: number; height: number; segments: TrackSegment[]; frames: TrackFrame[]; gaps: TrackGap[] };

/** The index blob: where each frame and each gap is, so a viewer maps a time in the recording (`t`) to a time in the video (`t - from`). */
export type TrackIndex = { version: 1; session: string; fps: number; from: number; to: number; width: number; height: number; codec: "vp9"; frames: TrackFrame[]; gaps: TrackGap[] };

export class TrackExportError extends Error {
  readonly code: "ffmpeg_missing" | "ffmpeg_failed" | "ffmpeg_timeout" | "aborted";
  constructor(code: TrackExportError["code"], message: string) {
    super(message);
    this.name = "TrackExportError";
    this.code = code;
  }
}

type Row = { kind?: unknown; t?: unknown; conv?: unknown; data?: any; blobs?: unknown };
const even = (n: number): number => (n % 2 === 0 ? n : n + 1);

/** The timeline of one session's lines. Each frame is shown until the next one; a gap puts the slate up (from the moment it was written, except
 *  `process_killed`, which starts at the last frame the earlier process saved: nothing is known after it) until the next frame or the end.
 *  Null when the session has no frame. `skip` names frames whose picture could not be read: they show the slate and are not listed. */
export function planTrack(lines: Iterable<unknown>, options: { fps?: number; endAt?: number; skip?: ReadonlySet<string> } = {}): TrackPlan | null {
  const fps = options.fps ?? 10;
  const one = Math.max(1, Math.round(1000 / fps));
  const rows = [...lines].map((row, order) => ({ row: row as Row, order })).filter(({ row }) => (row.kind === "frame" || row.kind === "frame.gap") && typeof row.t === "number" && row.data && typeof row.data.session === "string");
  const byTime = [...rows].sort((a, b) => (a.row.t as number) - (b.row.t as number) || a.order - b.order);
  const first = byTime.find(({ row }) => row.kind === "frame");
  if (!first) return null;
  const session: string = first.row.data.session;
  const events = byTime.filter(({ row }) => row.data.session === session);
  const from = first.row.t as number;
  const segments: TrackSegment[] = [];
  const frames: TrackFrame[] = [];
  const gaps: TrackGap[] = [];
  type Open = { start: number; sha256: string | null; reason?: string };
  const state: { current: Open | null; gap: { from: number; reason: string; detail?: string } | null } = { current: null, gap: null };
  const close = (at: number): void => {
    const cur = state.current;
    if (cur && at > cur.start) segments.push({ start: cur.start, end: at, sha256: cur.sha256, ...(cur.reason ? { reason: cur.reason } : {}) });
    state.current = null;
  };
  const closeGap = (at: number): void => { if (state.gap) gaps.push({ ...state.gap, to: at }); state.gap = null; };
  let last = from;
  for (const { row } of events) {
    const t = row.t as number;
    last = Math.max(last, t);
    if (t < from) continue; // a gap written before the first frame has no place in the track
    if (row.kind === "frame") {
      const sha = (row.blobs as string[] | undefined)?.[0] ?? "";
      close(t);
      closeGap(t);
      if (options.skip?.has(sha)) {
        state.current = { start: t, sha256: null, reason: "frame_unreadable" };
        state.gap = { from: t, reason: "frame_unreadable" };
      } else {
        state.current = { start: t, sha256: sha };
        frames.push({ t, ms: t - from, sha256: sha, w: row.data.w, h: row.data.h });
      }
      continue;
    }
    const data = row.data as FrameGapData;
    const cur = state.current;
    if (!cur) continue;
    const opened = (at: number): void => { state.gap = { from: at, reason: data.reason, ...(data.detail ? { detail: data.detail } : {}) }; };
    if (cur.sha256 === null) { closeGap(t); opened(t); continue; } // the slate is already up
    const at: number = data.reason === "process_killed" ? Math.min(t, Math.max(cur.start, data.from)) : t;
    close(at);
    state.current = { start: at, sha256: null, reason: data.reason };
    opened(at);
  }
  // The track ends where the recording does; only a track that would have no length at all is given one frame's time.
  let to = Math.max(options.endAt ?? 0, last);
  if (to - from < one) to = from + one;
  close(to);
  closeGap(to);
  const width = even(frames.reduce((max, f) => Math.max(max, f.w), 2));
  const height = even(frames.reduce((max, f) => Math.max(max, f.h), 2));
  return { session, conv: first.row.conv as number, fps, from, to, width, height, segments, frames, gaps };
}

const SLATE_COLOR = "0x1f2933";

export type TrackOptions = {
  /** The recording's lines; `frame` and `frame.gap` of every session are read, anything else is ignored. */
  lines: Iterable<unknown>;
  /** The bytes of a blob by its sha256 (the JPEG a `frame` line names); null or a throw: not there. */
  readBlob: (sha256: string) => Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;
  fps?: number;
  /** When the recording ended, in its own ms: the last frame or slate is shown until then. */
  endAt?: number;
  /** The program to start; default `ffmpeg` on the PATH. */
  ffmpeg?: string;
  /** For each session's encoding; default 120 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type Track = {
  line: FrameTrackLine;
  /** The video and the index, by sha256: the host keeps the first as `blobs/<sha256>.webm` and the second as `blobs/<sha256>.json`. */
  blobs: Record<string, Uint8Array>;
  files: { webm: string; index: string };
  index: TrackIndex;
  /** Frames the track could not use, shown as the slate: `missing` (no such blob), `hash_mismatch`, `not_a_jpeg`. */
  skipped: Array<{ sha256: string; reason: "missing" | "hash_mismatch" | "not_a_jpeg" }>;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One WebM (VP9) and one index per session that has a frame. A session's pictures are read one at a time and written straight to a private temporary
 *  directory made for the session and removed after, so memory holds one picture at a time (not every picture of the recording), and ffmpeg reads
 *  only files there: it is started with a short environment, not given a URL, and nothing it writes reaches the recording but the video. `readBlob`
 *  may be asked for the same blob again by another session. */
export async function exportFrameTracks(options: TrackOptions): Promise<Track[]> {
  const fps = options.fps ?? 10;
  const lines = [...options.lines];
  // The end of the recording is the last line of any kind, the same for every session.
  const recordingEnd = (lines as Row[]).reduce((end, row) => (typeof row?.t === "number" && row.t > end ? row.t : end), 0);
  const endAt = options.endAt ?? recordingEnd;
  const sessions = new Map<string, unknown[]>();
  for (const row of lines as Row[]) {
    const session = row?.data?.session;
    if ((row?.kind === "frame" || row?.kind === "frame.gap") && typeof session === "string") (sessions.get(session) ?? sessions.set(session, []).get(session)!).push(row);
  }
  const tracks: Track[] = [];
  for (const [, rows] of sessions) {
    throwIfAborted(options.signal);
    // One deadline for the session's whole export (every ffmpeg call of it): each call gets the time that is left.
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    const dir = await mkdtemp(path.join(os.tmpdir(), "pib-track-"));
    try {
      const names = new Map<string, Picture>();
      const skip = new Set<string>();
      const skipped: Track["skipped"] = [];
      let n = 0;
      for (const row of rows as Row[]) {
        if (row.kind !== "frame") continue;
        const hash = (row.blobs as string[] | undefined)?.[0];
        if (!hash || names.has(hash) || skip.has(hash)) continue;
        let bytes: Uint8Array | null | undefined;
        try { bytes = await options.readBlob(hash); } catch { bytes = null; }
        throwIfAborted(options.signal);
        const reason = !bytes ? "missing" : sha256(bytes) !== hash ? "hash_mismatch" : jpegSize(bytes) === null ? "not_a_jpeg" : null;
        if (reason || !bytes) { skip.add(hash); skipped.push({ sha256: hash, reason: reason ?? "missing" }); continue; }
        const file = path.join(dir, `f${n++}.jpg`);
        await writeFile(file, bytes);
        const size = jpegSize(bytes)!;
        names.set(hash, { file, w: size.w, h: size.h, sampling: jpegSampling(bytes) });
      }
      let plan: TrackPlan | null = null;
      let webm: Uint8Array | null = null;
      for (let attempt = 0; ; attempt += 1) {
        plan = planTrack(rows, { fps, endAt, skip });
        if (!plan) break;
        throwIfAborted(options.signal);
        try { webm = await encode(plan, names, dir, options, deadline); break; } catch (error) {
          // A picture whose header reads but whose data does not decode fails the whole encode: find it, show the slate for it, try once more.
          if (attempt > 0 || !(error instanceof TrackExportError) || error.code !== "ffmpeg_failed") throw error;
          const undecodable = await findUndecodable(names, dir, options, deadline);
          if (undecodable.length === 0) throw error;
          for (const hash of undecodable) { names.delete(hash); skip.add(hash); skipped.push({ sha256: hash, reason: "not_a_jpeg" }); }
        }
      }
      if (!plan || !webm) continue;
      const index: TrackIndex = { version: 1, session: plan.session, fps: plan.fps, from: plan.from, to: plan.to, width: plan.width, height: plan.height, codec: "vp9", frames: plan.frames, gaps: plan.gaps };
      const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`, "utf8");
      const files = { webm: sha256(webm), index: sha256(indexBytes) };
      tracks.push({
        line: { channel: "live", source: "browser", kind: "frame.track", t: plan.to, conv: plan.conv, data: { session: plan.session, fps: plan.fps, from: plan.from, to: plan.to }, blobs: [files.webm, files.index] },
        blobs: { [files.webm]: webm, [files.index]: indexBytes },
        files, index, skipped,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return tracks.sort((a, b) => a.line.data.from - b.line.data.from);
}

const throwIfAborted = (signal: AbortSignal | undefined): void => { if (signal?.aborted) throw new TrackExportError("aborted", "the export was aborted"); };

const quote = (file: string): string => `'${file.replaceAll("'", "'\\''")}'`;

type Picture = { file: string; w: number; h: number; sampling: string | null };
/** The layout a browser's JPEG has, and the one every picture is brought to: 4:2:0. */
const COMMON_SAMPLING = "22,11,11";

/** The pictures ffmpeg cannot decode, found one at a time (only after an encode has failed). */
async function findUndecodable(names: Map<string, Picture>, dir: string, options: TrackOptions, deadline: number): Promise<string[]> {
  const bad: string[] = [];
  for (const [hash, picture] of names) {
    throwIfAborted(options.signal);
    try { await run(options.ffmpeg ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-i", path.basename(picture.file), "-f", "null", "-"], dir, options, deadline); } catch (error) {
      if (error instanceof TrackExportError && error.code === "ffmpeg_failed") bad.push(hash); else throw error;
    }
  }
  return bad;
}

async function encode(plan: TrackPlan, names: Map<string, Picture>, dir: string, options: TrackOptions, deadline: number): Promise<Uint8Array> {
  // The slate is made at the canvas's own size, so no frame is ever scaled: a smaller frame is centred on the canvas at the size it was recorded.
  const slate = path.join(dir, "slate.jpg");
  await run(options.ffmpeg ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=${SLATE_COLOR}:s=${plan.width}x${plan.height}`, "-frames:v", "1", "slate.jpg"], dir, options, deadline);
  // ffmpeg reconfigures its filter graph when a picture's size or pixel layout differs from the one before, and the picture it was holding is lost (the
  // video then shows the next picture for its time). So every picture reaches the concat as the canvas's size and 4:2:0: one that is not is padded to
  // the canvas, at the size it was recorded and centred, and converted, first.
  const ready = new Map<string, string>();
  let fixed = 0;
  for (const [hash, picture] of names) {
    if (picture.w === plan.width && picture.h === plan.height && picture.sampling === COMMON_SAMPLING) { ready.set(hash, picture.file); continue; }
    throwIfAborted(options.signal);
    const out = `n${fixed++}.jpg`;
    await run(options.ffmpeg ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", path.basename(picture.file), "-vf", `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=${SLATE_COLOR},format=yuvj420p`, "-frames:v", "1", "-q:v", "2", out], dir, options, deadline);
    ready.set(hash, path.join(dir, out));
  }
  const list: string[] = [];
  const file = (sha: string | null): string => (sha === null ? slate : ready.get(sha)!);
  for (const segment of plan.segments) list.push(`file ${quote(file(segment.sha256))}`, `duration ${((segment.end - segment.start) / 1000).toFixed(3)}`);
  list.push(`file ${quote(file(plan.segments.at(-1)!.sha256))}`); // the concat demuxer ignores the last duration unless its file is named again
  await writeFile(path.join(dir, "list.txt"), `${list.join("\n")}\n`);
  const filter = `fps=${plan.fps},format=yuv420p`;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", filter, "-fps_mode", "cfr", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-row-mt", "1", "-deadline", "good", "-cpu-used", "5", "-an", "out.webm"];
  await run(options.ffmpeg ?? "ffmpeg", args, dir, options, deadline);
  return new Uint8Array(await readFile(path.join(dir, "out.webm")));
}

function run(program: string, args: string[], cwd: string, options: TrackOptions, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new TrackExportError("aborted", "the export was aborted"));
    const left = deadline - Date.now();
    if (left <= 0) return reject(new TrackExportError("ffmpeg_timeout", `the export did not finish within ${options.timeoutMs ?? 120_000} ms`));
    // Only a short list of names reaches the program: not the host's keys.
    const child = spawn(program, args, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: cwd }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: TrackExportError): void => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new TrackExportError("ffmpeg_timeout", `ffmpeg did not finish within ${options.timeoutMs ?? 120_000} ms of the session's export`)); }, left);
    const onAbort = (): void => { child.kill("SIGKILL"); finish(new TrackExportError("aborted", "the export was aborted")); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString("utf8"); });
    child.once("error", (error: NodeJS.ErrnoException) => finish(new TrackExportError("ffmpeg_missing", `could not start ffmpeg (${program}): ${error.code ?? error.message}`)));
    child.once("close", (code) => finish(code === 0 ? undefined : new TrackExportError("ffmpeg_failed", `ffmpeg exited with ${code}: ${stderr.trim().slice(0, 1_000)}`)));
  });
}
