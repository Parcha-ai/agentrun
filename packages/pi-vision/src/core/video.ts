// Video: what the file is (duration, size, frame rate), frames found by seek, a window by stream copy when it fits and
// one re-encode when it does not, never the whole file; the inline size comes from the request budget. Without ffmpeg
// in the environment a file under the inline budget still goes to a route that takes video, and the rest is a typed
// miss. Nothing is kept: every file a call derives is read back and removed before it returns.

import type { MissCode } from "./contract.js";
import { visionContext } from "./env.js";
import { formatFragment } from "./fragments.js";
import { RESULT_BYTES_SHARE, type Limits } from "./limits.js";
import type { Part } from "./plan.js";
import type { MadeBy, Provider, ProviderCall, ProviderSource } from "./provider.js";

/** What a probe finds; null for what the file does not say. */
export type VideoFacts = {
  readonly durationS: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly bytes: number;
};

/** A provider of frames and windows that also probes. A provider signals a failure by throwing: a `VideoMiss` for a
 *  typed one, any other error for a failed operation. */
export type VideoProvider = Provider & Required<Pick<Provider, "frames" | "clip">> & {
  probe(source: ProviderSource, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly facts: VideoFacts }>;
};

/** A typed miss a provider raises, with the text the model reads. */
export class VideoMiss extends Error {
  constructor(readonly code: MissCode, message: string) {
    super(message);
    this.name = "VideoMiss";
  }
}

type Failure = { readonly ok: false; readonly code: MissCode; readonly text: string };
/** What a video operation gives: its result, or the typed miss to tell the model. */
export type VideoOutcome<T> = ({ readonly ok: true } & T) | Failure;

/** The typed miss for an error a provider or the environment raised; a call that was cancelled is cancelled, not a miss. */
const failure = (call: ProviderCall, error: unknown, code: MissCode, what: string): Failure => {
  if (call.signal?.aborted) throw error;
  return error instanceof VideoMiss ? { ok: false, code: error.code, text: error.message } : { ok: false, code, text: `${what} (${String((error as Error)?.message ?? error).split("\n")[0]})` };
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const fmtS = (s: number | null) => (s === null ? "?" : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`);

/** The facts of a file nothing could probe: only its size. */
export const unprobedVideo = (source: ProviderSource): VideoFacts => ({ durationS: null, width: null, height: null, fps: null, bytes: source.bytes });

/** The line that tells the model what the file is. */
export const describeVideo = (facts: VideoFacts): string => JSON.stringify({
  duration_s: facts.durationS === null ? null : Number(facts.durationS.toFixed(2)), duration: fmtS(facts.durationS),
  width: facts.width, height: facts.height, fps: facts.fps === null ? null : Number(facts.fps.toFixed(2)), bytes: facts.bytes,
});

/** The facts of a video, always usable: what the probe could not say is null, and `miss` says why. */
export async function probeVideo(provider: VideoProvider, source: ProviderSource, call: ProviderCall): Promise<{ facts: VideoFacts; madeBy?: MadeBy; miss?: { code: MissCode; text: string } }> {
  try {
    const { madeBy, facts } = await provider.probe(source, call);
    return { facts, madeBy };
  } catch (error) {
    const { code, text } = failure(call, error, "unreadable", "the file could not be read as a video");
    return { facts: unprobedVideo(source), miss: { code, text } };
  }
}

/** The window `from_s` to `to_s` against what the file says: the window to cut, or the sentence that refuses the
 *  arguments. An end the file does not state must be given. */
export function videoWindow(facts: VideoFacts, fromS?: number, toS?: number): { fromS: number; toS: number } | string {
  const from = Math.max(0, fromS ?? 0);
  if (toS !== undefined && toS <= from) return `to_s (${toS}) must be greater than from_s (${from})`;
  if (facts.durationS !== null && from >= facts.durationS) return `from_s (${from}) is past the end of the video (${facts.durationS.toFixed(2)}s)`;
  const end = toS === undefined ? facts.durationS : Math.min(toS, facts.durationS ?? toS);
  return end === null ? `the video does not state its length, so to_s is needed with from_s (${from})` : { fromS: from, toS: end };
}

/** The raw bytes a video part may carry: the inline allowance, and never more than base64 (4/3 larger) leaves of the request. */
const inlineBudget = (limits: Limits) => Math.min(limits.video.inlineBytes, Math.floor((limits.requestBytes * 3) / 4));

const VIDEO_MIME: Readonly<Record<string, string>> = Object.freeze({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska" });

/** The file itself as one part, for a route that takes video and a file within the inline budget. No program runs. */
export async function videoAsIs(source: ProviderSource, facts: VideoFacts, limits: Limits, call: ProviderCall): Promise<VideoOutcome<{ part: Part; bytes: number }>> {
  const mimeType = VIDEO_MIME[source.path.slice(source.path.lastIndexOf(".")).toLowerCase()];
  if (!mimeType) return { ok: false, code: "unsupported", text: "its container is not one a route takes as it is; a window of it is cut into mp4 when ffmpeg is installed" };
  const budget = inlineBudget(limits);
  const over = (bytes: number): Failure => ({ ok: false, code: "over_budget", text: `it is ${bytes} bytes, over the ${budget} a request carries inline; read a window of it with from_s and to_s` });
  if (source.bytes > budget) return over(source.bytes);
  const read = await call.env.readBinaryFile(source.path, visionContext(call.signal));
  if (!read.ok) return failure(call, read.error, "unreadable", "the file could not be read");
  if (read.value.length > budget) return over(read.value.length);
  const fragment = formatFragment({ t: facts.durationS ? { from: 0, to: facts.durationS } : { from: 0 } });
  return { ok: true, part: { type: "video", data: base64(read.value), mimeType, fragment }, bytes: read.value.length };
}

/** One frame at each time asked, found by seek: at most `imagesPerCall`, each within the image limits and together
 *  within a result's share of the request. `missing` lists the times that gave no frame. */
export async function videoFrames(provider: VideoProvider, source: ProviderSource, request: { readonly atS: readonly number[]; readonly maxEdge: number }, limits: Limits, call: ProviderCall): Promise<VideoOutcome<{ parts: Part[]; madeBy: MadeBy; missing: number[] }>> {
  const atS = request.atS.filter((t) => Number.isFinite(t) && t >= 0).slice(0, limits.imagesPerCall);
  const maxEdge = Math.min(request.maxEdge, limits.image.maxWidth, limits.image.maxHeight);
  let out;
  try { out = await provider.frames(source, { atS, maxEdge }, call); } catch (error) { return failure(call, error, "video_unseeable", "no frame could be taken"); }
  let room = Math.floor(limits.requestBytes * RESULT_BYTES_SHARE);
  const parts: Part[] = [];
  const shown = new Set<number>();
  for (const frame of out.frames) {
    const data = base64(frame.data);
    if (data.length > limits.image.maxBytes || data.length > room) continue;
    room -= data.length;
    shown.add(frame.atS);
    parts.push({ type: "image", data, mimeType: frame.mimeType, width: frame.width, height: frame.height, fragment: formatFragment({ t: { from: frame.atS } }) });
  }
  if (!parts.length) return { ok: false, code: "video_unseeable", text: "no frame could be taken at the times asked: they may be past the end of the video, or its frames do not fit the image limits" };
  return { ok: true, parts, madeBy: out.madeBy, missing: atS.filter((t) => !shown.has(t)) };
}

/** The window as one video part within the inline budget: stream copy when it fits, else one re-encode, never the whole
 *  file. The file the provider wrote is read back and removed. */
export async function videoClip(provider: VideoProvider, source: ProviderSource, window: { readonly fromS: number; readonly toS: number }, limits: Limits, call: ProviderCall): Promise<VideoOutcome<{ part: Part; madeBy: MadeBy; fromS: number; toS: number; bytes: number }>> {
  const budget = inlineBudget(limits);
  let made;
  try { made = await provider.clip(source, { ...window, maxBytes: budget }, call); } catch (error) { return failure(call, error, "video_unseeable", "the window could not be cut"); }
  try {
    const read = await call.env.readBinaryFile(made.path, visionContext(call.signal));
    if (!read.ok) return failure(call, read.error, "video_unseeable", "the window could not be read back");
    if (read.value.length > budget) return { ok: false, code: "over_budget", text: `the window is ${read.value.length} bytes, over the ${budget} a request carries inline; read a shorter window` };
    const { fromS, toS, madeBy, mimeType } = made;
    return { ok: true, part: { type: "video", data: base64(read.value), mimeType, fragment: formatFragment({ t: { from: fromS, to: toS } }) }, madeBy, fromS, toS, bytes: read.value.length };
  } finally { await call.env.remove(made.path, { force: true }, visionContext()); }
}
