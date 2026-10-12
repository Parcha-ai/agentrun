// The ffmpeg provider and the video operations on real video, built here with ffmpeg's own test sources. Frames are
// found by seek and checked against a ramp whose brightness is its time; windows are cut by stream copy or one re-encode
// and never kept; a 30 minute file reads in seconds and leaves nothing behind. These suites run in the `vision-binaries`
// job, where a missing ffmpeg fails them, and skip elsewhere with their reason.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { describeVideo, detectOnce, probeVideo, resolveLimits, videoAsIs, videoClip, videoFrames, videoWindow } from "@parcha/pi-vision";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { fixtureDir, imageSize, registerProviderConformance } from "@parcha/pi-vision/testing";
import { measured, nodeEnv } from "./video-env.mjs";

const have = ["ffmpeg", "ffprobe"].every((program) => spawnSync(program, ["-version"]).status === 0);
const skip = have ? false : "ffmpeg and ffprobe are not installed here";
if (!have && process.env.PI_VISION_REQUIRE_BINARIES === "1") test("ffmpeg and ffprobe are installed", () => assert.fail("this suite needs ffmpeg and ffprobe"));

const dir = have ? await fixtureDir("pi-vision-video-") : null;
after(() => dir?.remove());

const ffmpeg = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
let references = 0;
/** A JPEG of the first frame `file` shows, made the same way whatever the file is, so brightness compares across them. */
const jpegOf = (file, ...filter) => {
  const out = join(dir.path, `reference-${references++}.jpg`);
  ffmpeg("-i", file, ...filter, "-frames:v", "1", "-q:v", "4", "-f", "image2", out);
  return out;
};
/** The brightness of a frame: what a pixel of a ramp frame says about its time. */
const brightness = (file) => execFileSync("ffmpeg", ["-v", "error", "-i", file.endsWith(".jpg") ? file : jpegOf(file), "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])[0];
/** The brightness of frame number `n` of the ramp, from a sequential decode: no seek is involved. */
const rampAt = (n) => brightness(jpegOf(files.ramp.path, "-vf", `select=eq(n\\,${n})`));
const probeJson = (file, entries) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", file], { encoding: "utf8" }));
const x264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

const files = {};
if (have) {
  const at = (name) => join(dir.path, name);
  // A 20 s ramp at 5 frames a second whose brightness grows with time, a keyframe every 5 s.
  ffmpeg("-f", "lavfi", "-i", "nullsrc=size=320x240:rate=5,geq=lum='16+10.95*T':cb=128:cr=128", "-t", "20", ...x264, "-g", "25", at("ramp.mp4"));
  // 30 minutes of test pattern at a small bitrate: the size of a long screen recording.
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=5", "-t", "1800", ...x264, "-preset", "ultrafast", "-b:v", "80k", "-maxrate", "80k", "-bufsize", "160k", "-g", "50", at("long.mp4"));
  // 12 s of 1080p at 12 Mbit/s: a stream copy of it is far over a few megabytes, its re-encode is not.
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25", "-t", "12", ...x264, "-preset", "ultrafast", "-b:v", "12M", at("heavy.mp4"));
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:a", "aac", "-f", "mp4", at("audio-only.mp4"));
  await writeFile(at("text.mp4"), "this is not a video\n");
  // A concat script posing as a video, naming a real one beside it: ffmpeg opens it as a script when nothing stops it.
  await writeFile(at("script.mp4"), "ffconcat version 1.0\nfile ramp.mp4\n");
  const ramp = await readFile(at("ramp.mp4"));
  await writeFile(at("truncated.mp4"), ramp.subarray(0, Math.floor(ramp.length * 0.6)));
  for (const name of ["ramp", "long", "heavy", "audio-only", "text", "script", "truncated"]) {
    const bytes = await readFile(at(`${name}.mp4`));
    files[name] = { path: at(`${name}.mp4`), kind: "video", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}

const provider = ffmpegProvider();
const limits = resolveLimits(undefined);
/** A call with a temp directory of its own, and what each program left in it. */
const session = async (overrides = {}) => {
  const tempDir = join(dir.path, `call-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tempDir);
  const watched = measured(nodeEnv(), tempDir);
  return { call: { env: watched.env, signal: undefined, tempDir, ...overrides }, tempDir, watched, left: () => readdir(tempDir) };
};
/** Brightness levels: a frame of the ramp is about 3 levels from the next. */
const tolerance = 6;

registerProviderConformance({
  provider,
  env: () => nodeEnv(),
  fixtures: have ? [{ name: "ramp.mp4", source: files.ramp, expect: { frames: { atS: [1, 9.6, 17.4], maxEdge: 160, width: 160, height: 120 }, clip: { fromS: 2, toS: 8, maxBytes: 5_000_000 } } }] : [],
});

test("detection names the version of the programs it found", { skip }, async () => {
  const found = await detectOnce(provider, nodeEnv("detect"));
  assert.equal(found.available, true);
  assert.match(found.version, /^\d/);
});

test("a probe tells what the file is, in the line the model reads", { skip }, async () => {
  const { call, left } = await session();
  const probed = await probeVideo(provider, files.ramp, call);
  assert.equal(probed.miss, undefined);
  assert.deepEqual(probed.facts, { durationS: 20, width: 320, height: 240, fps: 5, bytes: files.ramp.bytes });
  assert.equal(describeVideo(probed.facts), `{"duration_s":20,"duration":"0:20.0","width":320,"height":240,"fps":5,"bytes":${files.ramp.bytes}}`);
  assert.deepEqual(await left(), []);
});

test("frames are found by seek: each shows the moment asked, at the size asked", { skip }, async () => {
  const { call, left } = await session();
  const times = [4, 7.2, 12.4, 16.8, 19.8];
  const out = await videoFrames(provider, files.ramp, { atS: times, maxEdge: 160 }, limits, call);
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.parts.length, times.length);
  for (const [i, part] of out.parts.entries()) {
    assert.equal(part.type, "image");
    assert.equal(part.mimeType, "image/jpeg");
    const jpeg = Buffer.from(part.data, "base64");
    assert.deepEqual(imageSize(jpeg), { mimeType: "image/jpeg", width: 160, height: 120 });
    assert.deepEqual([part.width, part.height], [160, 120]);
    assert.equal(part.fragment, `t=${times[i]}`);
    const file = join(dir.path, `frame-${i}.jpg`);
    await writeFile(file, jpeg);
    // The ramp's brightness is 12.75 a second by construction: the pixel says which moment was found.
    const shown = brightness(file);
    assert.ok(Math.abs(shown - 12.75 * times[i]) <= tolerance, `the frame at ${times[i]} s shows brightness ${shown}, the ramp has ${12.75 * times[i]} there`);
    assert.ok(Math.abs(shown - 12.75 * (times[i] + (times[i] < 8 ? 5 : -5))) > 20, "and not what the ramp shows 5 s away");
  }
  assert.deepEqual(await left(), [], "no file is kept");
});

test("a frame is never larger than the source: the edge is a ceiling", { skip }, async () => {
  const { call } = await session();
  const out = await videoFrames(provider, files.ramp, { atS: [3], maxEdge: 4000 }, limits, call);
  assert.deepEqual([out.parts[0].width, out.parts[0].height], [320, 240]);
});

test("times past the end give no frame, and the ones inside are still shown", { skip }, async () => {
  const { call, left } = await session();
  const mixed = await videoFrames(provider, files.ramp, { atS: [4, 25, 60], maxEdge: 160 }, limits, call);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.parts.length, 1);
  assert.deepEqual(mixed.missing, [25, 60]);
  const none = await videoFrames(provider, files.ramp, { atS: [25, 60], maxEdge: 160 }, limits, call);
  assert.deepEqual([none.ok, none.code], [false, "video_unseeable"]);
  assert.deepEqual(await left(), []);
});

test("a window by stream copy starts where it was asked, though its keyframe is earlier", { skip }, async () => {
  const { call, left } = await session();
  const out = await videoClip(provider, files.ramp, { fromS: 7.2, toS: 12.4 }, limits, call);
  assert.equal(out.ok, true);
  assert.deepEqual([out.part.type, out.part.mimeType, out.part.fragment, out.fromS, out.toS], ["video", "video/mp4", "t=7.2,12.4", 7.2, 12.4]);
  const file = join(dir.path, "window.mp4");
  await writeFile(file, Buffer.from(out.part.data, "base64"));
  assert.equal(out.bytes, Buffer.from(out.part.data, "base64").length);
  const length = Number(probeJson(file, "format=duration").format.duration);
  assert.ok(length >= 5.2 && length <= 7, `the clip is ${length} s for a window of 5.2 s`);
  const first = rampAt(Math.round(7.2 * 5));
  assert.ok(Math.abs(brightness(file) - first) <= tolerance, `the clip's first frame shows ${brightness(file)}, the ramp has ${first} at 7.2 s (its keyframe, at 5 s, has ${rampAt(25)})`);
  assert.deepEqual(await left(), [], "the clip is read back and removed");
});

test("a window too large to copy is re-encoded once at 1280 px and 6 frames a second", { skip }, async () => {
  const { call, left } = await session();
  const budget = resolveLimits(undefined, { video: { inlineBytes: 4_000_000 } });
  const copy = join(dir.path, "heavy-copy.mp4");
  ffmpeg("-i", files.heavy.path, "-an", "-c", "copy", copy);
  const copyBytes = (await stat(copy)).size;
  assert.ok(copyBytes > 4_000_000, `the stream copy of the window is ${copyBytes} bytes, over the budget`);
  const out = await videoClip(provider, files.heavy, { fromS: 0, toS: 12 }, budget, call);
  assert.equal(out.ok, true, out.text);
  assert.ok(out.bytes <= 4_000_000);
  const file = join(dir.path, "encoded.mp4");
  await writeFile(file, Buffer.from(out.part.data, "base64"));
  const stream = probeJson(file, "stream=width,height,r_frame_rate,codec_name").streams[0];
  assert.deepEqual([stream.width, stream.height, stream.r_frame_rate, stream.codec_name], [1280, 720, "6/1", "h264"]);
  assert.deepEqual(await left(), []);
});

test("a window that cannot fit even re-encoded is an over_budget miss that says how much does, and stops encoding at the budget", { skip }, async () => {
  const { call, left, watched } = await session();
  const tiny = resolveLimits(undefined, { video: { inlineBytes: 40_000 } });
  const out = await videoClip(provider, files.heavy, { fromS: 0, toS: 12 }, tiny, call);
  assert.deepEqual([out.ok, out.code], [false, "over_budget"]);
  assert.match(out.text, /40000 bytes/);
  assert.match(out.text, /about \d+ s of it do/);
  assert.ok(watched.derivedBytes() < 1_000_000, `derived ${watched.derivedBytes()} bytes for a 40,000 byte budget`);
  assert.deepEqual(await left(), []);
});

test("a window is never the whole file: the 30 minute file cut at 60 to 90 s stays within the budget", { skip }, async () => {
  const { call, left, watched } = await session();
  const started = performance.now();
  const out = await videoClip(provider, files.long, { fromS: 60, toS: 90 }, limits, call);
  const elapsed = performance.now() - started;
  assert.equal(out.ok, true, out.text);
  assert.ok(out.bytes < 2_000_000, `${out.bytes} bytes for 30 s`);
  assert.ok(elapsed < 5000, `${elapsed} ms`);
  assert.ok(watched.derivedBytes() < 10_000_000);
  assert.deepEqual(await left(), []);
});

test("a 30 minute video reads in under 5 s and under 10 MB derived: facts and 8 frames by seek, nothing kept", { skip }, async () => {
  const { call, left, watched } = await session();
  const started = performance.now();
  const probed = await probeVideo(provider, files.long, call);
  assert.equal(probed.facts.durationS, 1800);
  const times = Array.from({ length: 8 }, (_, i) => (i + 0.5) * (probed.facts.durationS / 8));
  const frames = await videoFrames(provider, files.long, { atS: times, maxEdge: 1024 }, limits, call);
  const elapsed = performance.now() - started;
  assert.equal(frames.ok, true);
  assert.equal(frames.parts.length, 8);
  assert.deepEqual(frames.missing, []);
  assert.ok(elapsed < 5000, `${elapsed} ms for the facts and 8 frames of a 30 minute file`);
  assert.ok(watched.derivedBytes() < 10_000_000, `${watched.derivedBytes()} bytes derived`);
  assert.deepEqual(await left(), [], "nothing is kept");
  console.log(`# 30 minute file: facts and 8 frames in ${Math.round(elapsed)} ms, ${watched.derivedBytes()} bytes derived`);
});

test("a window that holds the asked second is a cheap way to look: the 30 minute file's window reads in under a second of work", { skip }, async () => {
  const { call, watched } = await session();
  const started = performance.now();
  const probed = await probeVideo(provider, files.long, call);
  const window = videoWindow(probed.facts, 900, 930);
  assert.deepEqual(window, { fromS: 900, toS: 930 });
  const out = await videoClip(provider, files.long, window, limits, call);
  const elapsed = performance.now() - started;
  assert.equal(out.ok, true);
  assert.ok(elapsed < 5000, `${elapsed} ms`);
  console.log(`# 30 minute file: facts and a 30 s window in ${Math.round(elapsed)} ms, ${watched.derivedBytes()} bytes derived`);
});

test("a file under the inline budget goes as it is, with no program run", { skip }, async () => {
  const { call, watched } = await session();
  const out = await videoAsIs(files.ramp, { durationS: 20, width: 320, height: 240, fps: 5, bytes: files.ramp.bytes }, limits, call);
  assert.equal(out.ok, true);
  assert.deepEqual([out.part.mimeType, out.part.fragment], ["video/mp4", "t=0,20"]);
  assert.equal(Buffer.from(out.part.data, "base64").equals(await readFile(files.ramp.path)), true);
  assert.equal(watched.derivedBytes(), 0);
});

test("a file that is not a video, one with only sound, and a cut-off one are typed misses or what remains", { skip }, async () => {
  const { call, left } = await session();
  const text = await probeVideo(provider, files.text, call);
  assert.deepEqual([text.miss.code, text.facts.durationS, text.facts.bytes], ["unreadable", null, files.text.bytes]);
  const sound = await probeVideo(provider, files["audio-only"], call);
  assert.deepEqual([sound.miss.code, sound.miss.text], ["unreadable", "it holds no video stream"]);
  assert.equal((await videoFrames(provider, files.text, { atS: [1], maxEdge: 160 }, limits, call)).code, "video_unseeable");
  assert.equal((await videoClip(provider, files.text, { fromS: 0, toS: 2 }, limits, call)).code, "video_unseeable");
  const cut = await videoFrames(provider, files.truncated, { atS: [1, 18], maxEdge: 160 }, limits, call);
  assert.equal(cut.ok, true);
  assert.deepEqual([cut.parts.length, cut.missing], [1, [18]]);
  assert.deepEqual(await left(), []);
});

test("a concat script posing as a video is not opened, though it names a real file", { skip }, async () => {
  const { call, left } = await session();
  const opened = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", files.script.path], { encoding: "utf8" });
  assert.equal(opened.trim(), "concat", "ffprobe on its own opens it as a script that names another file");
  const probed = await probeVideo(provider, files.script, call);
  assert.deepEqual([probed.miss.code, probed.facts.durationS], ["unreadable", null]);
  assert.equal((await videoFrames(provider, files.script, { atS: [1], maxEdge: 160 }, limits, call)).code, "video_unseeable");
  assert.equal((await videoClip(provider, files.script, { fromS: 0, toS: 2 }, limits, call)).code, "video_unseeable");
  assert.deepEqual(await left(), []);
});

test("a window whose size cannot be read is removed, not left in the caller's directory", { skip }, async () => {
  const { tempDir, left } = await session();
  const env = { ...nodeEnv(), fileInfo: async () => ({ ok: false, error: Object.assign(new Error("stat failed"), { code: "EIO" }) }) };
  await assert.rejects(provider.clip(files.ramp, { fromS: 2, toS: 8, maxBytes: 5_000_000 }, { env, signal: undefined, tempDir }), /stat failed/);
  assert.deepEqual(await left(), []);
});

test("every program is given its timeout in seconds, the unit an environment's exec takes", { skip }, async () => {
  const seen = [];
  const base = nodeEnv("seconds");
  const env = { ...base, exec: (command, options, context) => { seen.push(options?.timeout); return base.exec(command, options, context); } };
  const { tempDir } = await session();
  const call = { env, signal: undefined, tempDir };
  await probeVideo(provider, files.ramp, call);
  await videoFrames(provider, files.ramp, { atS: [3], maxEdge: 160 }, limits, call);
  await videoClip(provider, files.ramp, { fromS: 2, toS: 8 }, limits, call);
  assert.ok(seen.length >= 5, "detection, the probe, a frame and a window each ran a program");
  assert.ok(seen.every((timeout) => Number.isFinite(timeout) && timeout > 0 && timeout <= 3600), `timeouts ${JSON.stringify(seen)} are an hour at most, not milliseconds`);
});

test("a call that is cancelled throws, and is not a miss", { skip }, async () => {
  const controller = new AbortController();
  controller.abort();
  const { call, left } = await session({ signal: controller.signal });
  await assert.rejects(videoFrames(provider, files.ramp, { atS: [1, 2], maxEdge: 160 }, limits, call));
  await assert.rejects(videoClip(provider, files.ramp, { fromS: 1, toS: 3 }, limits, call));
  assert.deepEqual(await left(), []);
});
