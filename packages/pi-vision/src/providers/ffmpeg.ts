// Video through ffmpeg and ffprobe in the environment: the probe, frames by seek, a window by stream copy or one
// re-encode. Every program runs through the environment port and writes to a file there, which is read back and
// removed; a derived file is written under a part name and renamed, so a file under its final name is whole.
import { randomUUID } from "node:crypto";
import { visionContext, type VisionResult, type VisionEnvError } from "../core/env.js";
import { VIDEO_REENCODE_EDGE, VIDEO_REENCODE_FPS } from "../core/limits.js";
import { detectOnce, type MadeBy, type ProviderCall, type ProviderSource } from "../core/provider.js";
import { VideoMiss, type VideoFacts, type VideoProvider } from "../core/video.js";

/** How long a probe, one frame and one window may run, in seconds: the unit of an environment's `exec` timeout. */
const PROBE_TIMEOUT_S = 30;
const FRAME_TIMEOUT_S = 60;
const CLIP_TIMEOUT_S = 180;
/** A frame's JPEG quality on ffmpeg's scale (2 best, 31 worst): eight such frames at 1024 px were read as accurately as the source in measurements on synthetic video (2026-10-11). */
const FRAME_QSCALE = 4;
/** The constant rate factor of the one re-encode (x264, 1280 px, 6 fps: measured on synthetic video, 2026-10-09). */
const REENCODE_CRF = 26;
const NEEDS = "ffmpeg and ffprobe (6.1 or later)";
/** Options for every read of a source: local files only, and only the containers cameras, screen recorders and editors
 *  write, so a playlist or concat script posing as a video cannot make ffmpeg open other files or addresses. */
const INPUT_GUARD = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,asf,flv,ogg"] as const;

/** The scale filter that fits a frame inside `edge` px on each side without enlarging it, even sides. */
const fit = (edge: number) => `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
const sec = (s: number) => s.toFixed(3);
const unwrap = <T>(result: VisionResult<T, VisionEnvError>): T => { if (!result.ok) throw result.error; return result.value; };

/** The pixels of a JPEG, from its first start-of-frame segment. */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let at = 2; at + 9 < b.length; ) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) { at += 1; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: (b[at + 5]! << 8) | b[at + 6]!, width: (b[at + 7]! << 8) | b[at + 8]! };
    at += 2 + ((b[at + 2]! << 8) | b[at + 3]!);
  }
  return null;
}

export function ffmpegProvider(): VideoProvider {
  const ctx = (call: ProviderCall) => visionContext(call.signal);
  const at = (call: ProviderCall, name: string) => `${call.tempDir.replace(/\/+$/, "")}/${name}`;

  async function run(call: ProviderCall, argv: readonly string[], timeout: number): Promise<void> {
    const ran = unwrap(await call.env.exec(argv, { timeout }, ctx(call)));
    if (ran.exitCode !== 0) throw new Error(`${argv[0]} exited ${ran.exitCode}`);
  }

  /** The file's bytes, read back and removed. */
  async function take(call: ProviderCall, file: string): Promise<Uint8Array> {
    try { return unwrap(await call.env.readBinaryFile(file, ctx(call))); } finally { await call.env.remove(file, { force: true }, visionContext()); }
  }

  /** ffmpeg's output for this source and these parameters, written under a part name and renamed. The name carries the
   *  source's hash and the parameters, and a token of its own so concurrent calls in one directory never meet. */
  async function derive(call: ProviderCall, source: ProviderSource, params: string, ext: "jpg" | "mp4", args: readonly string[], timeout: number): Promise<string> {
    const name = at(call, `${source.sha256.slice(0, 16)}-${params}-${randomUUID().slice(0, 8)}.${ext}`);
    const part = `${name}.part`;
    try {
      await run(call, ["ffmpeg", "-nostdin", "-v", "error", "-y", ...args, "-f", ext === "mp4" ? "mp4" : "image2", part], timeout);
      unwrap(await call.env.renameFile(part, name, ctx(call)));
      return name;
    } catch (error) {
      await call.env.remove(part, { force: true }, visionContext());
      throw error;
    }
  }

  /** One frame at `t`, found by seek, as a file. */
  const grab = (call: ProviderCall, source: ProviderSource, t: number, edge: number) =>
    derive(call, source, `at${sec(t)}-${edge}`, "jpg", ["-ss", sec(t), ...INPUT_GUARD, "-i", source.path, "-frames:v", "1", "-vf", fit(edge), "-q:v", String(FRAME_QSCALE)], FRAME_TIMEOUT_S);

  const provider: VideoProvider = {
    name: "ffmpeg",
    capabilities: ["frames", "clip"],
    kinds: ["video"],

    async detect(env) {
      const context = visionContext();
      try {
        const dir = unwrap(await env.createTempDir("pi-vision-ffmpeg-", context));
        try {
          const report = `${dir}/version.json`;
          // ffprobe writes its report to a file: the environment gives back an exit code, not output.
          for (const argv of [["ffmpeg", "-version"], ["ffprobe", "-v", "error", "-show_program_version", "-of", "json", "-o", report]]) {
            const { exitCode } = unwrap(await env.exec(argv, { timeout: PROBE_TIMEOUT_S }, context));
            if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`);
          }
          const version = JSON.parse(Buffer.from(unwrap(await env.readBinaryFile(report, context))).toString("utf8")).program_version?.version;
          return typeof version === "string" ? { available: true, version } : { available: false, needs: NEEDS, reason: "ffprobe did not report its version" };
        } finally { await env.remove(dir, { recursive: true, force: true }, context); }
      } catch (error) {
        return { available: false, needs: NEEDS, reason: String((error as Error)?.message ?? error).split("\n")[0]! };
      }
    },

    async probe(source, call) {
      const madeBy = await ready(call);
      const report = at(call, `probe-${randomUUID()}.json`);
      try {
        await run(call, ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", "-o", report, ...INPUT_GUARD, "-i", source.path], PROBE_TIMEOUT_S);
        const parsed = JSON.parse(Buffer.from(unwrap(await call.env.readBinaryFile(report, ctx(call)))).toString("utf8"));
        const stream = parsed.streams?.[0];
        if (!stream) throw new VideoMiss("unreadable", "it holds no video stream");
        const [num, den] = String(stream.r_frame_rate ?? "").split("/").map(Number);
        const length = Number(parsed.format?.duration);
        const facts: VideoFacts = { durationS: Number.isFinite(length) ? length : null, width: stream.width ?? null, height: stream.height ?? null, fps: num && den ? num / den : null, bytes: source.bytes };
        return { madeBy, facts };
      } finally { await call.env.remove(report, { force: true }, visionContext()); }
    },

    async frames(source, { atS, maxEdge }, call) {
      const madeBy = await ready(call);
      const frames = [];
      for (const t of atS) {
        let file: string;
        // A time past the end gives no file, and no frame.
        try { file = await grab(call, source, t, maxEdge); } catch (error) { if (call.signal?.aborted) throw error; continue; }
        const data = await take(call, file);
        const size = jpegSize(data);
        if (size) frames.push({ ...size, data, mimeType: "image/jpeg", atS: t });
      }
      return { madeBy, frames };
    },

    async clip(source, { fromS, toS, maxBytes }, call) {
      const madeBy = await ready(call);
      const cut = (mode: "copy" | "encode") => derive(call, source, `w${sec(fromS)}-${sec(toS)}-${mode}`, "mp4", [
        "-ss", sec(fromS), ...INPUT_GUARD, "-i", source.path, "-t", sec(toS - fromS), "-an",
        ...(mode === "copy" ? ["-c", "copy"] : ["-vf", `${fit(VIDEO_REENCODE_EDGE)},fps=${VIDEO_REENCODE_FPS}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(REENCODE_CRF), "-pix_fmt", "yuv420p"]),
        // The size limit stops a window that cannot fit as soon as it passes the budget, so no window is ever encoded whole.
        "-movflags", "+faststart", "-fs", String(maxBytes + 1),
      ], CLIP_TIMEOUT_S);
      const sizeOf = async (file: string) => unwrap(await call.env.fileInfo(file, ctx(call))).size;
      const drop = (file: string) => call.env.remove(file, { force: true }, visionContext());
      // A container that refuses the copy, or a copy over the budget, goes to the one re-encode. Whatever fails after a
      // file is written removes it: the caller owns it only once this returns.
      const done = (path: string) => ({ madeBy, path, mimeType: "video/mp4", fromS, toS });
      let file: string | undefined;
      try {
        file = await cut("copy").catch((error) => { if (call.signal?.aborted) throw error; return undefined; });
        if (file && (await sizeOf(file)) <= maxBytes) return done(file);
        if (file) await drop(file);
        file = await cut("encode");
        const bytes = await sizeOf(file);
        if (bytes <= maxBytes) return done(file);
        const kept = (await provider.probe({ ...source, path: file, bytes }, call).catch(() => undefined))?.facts.durationS;
        throw new VideoMiss("over_budget", `the window ${sec(fromS)} to ${sec(toS)} s does not fit the ${maxBytes} bytes a request carries inline, even at ${VIDEO_REENCODE_EDGE} px and ${VIDEO_REENCODE_FPS} frames a second${kept ? ` (about ${Math.floor(kept)} s of it do)` : ""}; read a shorter window with from_s and to_s`);
      } catch (error) {
        if (file) await drop(file);
        throw error;
      }
    },
  };

  /** The program's version, or the typed miss that says what is missing. */
  async function ready(call: ProviderCall): Promise<MadeBy> {
    const found = await detectOnce(provider, call.env);
    if (!found.available) throw new VideoMiss("needs", `${found.needs} are not available here (${found.reason}), so frames and windows of a video cannot be taken; a video within the inline budget is still shown as it is to a route that takes video`);
    return { provider: provider.name, version: found.version };
  }
  return provider;
}
