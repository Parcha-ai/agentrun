// The video operations against a scripted provider and an in-memory environment: what each asks of the provider, which
// limits it holds the result to, what it removes, and the typed miss for each thing that cannot be done. Real video and
// the real programs are in test/binaries/video.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { VideoMiss, describeVideo, detectOnce, probeVideo, resolveLimits, unprobedVideo, videoAsIs, videoClip, videoFrames, videoWindow } from "@parcha/pi-vision";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";

const ok = (value) => ({ ok: true, value });
const fail = (message, code = "EFAIL") => ({ ok: false, error: Object.assign(new Error(message), { code }) });
/** An environment of files in memory that records what is removed and cannot run any program. */
const memory = (files = {}) => {
  const removed = [];
  const env = {
    id: "memory", cwd: "/",
    readBinaryFile: async (path) => (path in files ? ok(files[path]) : fail(`no such file: ${path}`, "ENOENT")),
    remove: async (path) => { removed.push(path); delete files[path]; return ok(undefined); },
    createTempDir: async () => ok("/tmp/pi-vision-ffmpeg-test"),
    exec: async (command) => fail(`spawn ${command[0]} ENOENT`, "ENOENT"),
  };
  return { env, removed };
};
const source = (path = "/work/call.mp4", bytes = 1000) => ({ path, kind: "video", bytes, sha256: "ab".repeat(32) });
const call = (env, signal) => ({ env, signal, tempDir: "/work/tmp" });
const jpeg = (size) => new Uint8Array(size).fill(7);
const frame = (atS, size = 100) => ({ atS, data: jpeg(size), mimeType: "image/jpeg", width: 320, height: 180 });
const scripted = (overrides = {}) => ({
  name: "scripted", capabilities: ["frames", "clip"], kinds: ["video"], detect: async () => ({ available: true, version: "1" }),
  probe: async () => ({ madeBy: { provider: "scripted", version: "1" }, facts: { durationS: 60, width: 640, height: 360, fps: 5, bytes: 1000 } }),
  frames: async (_s, { atS }) => ({ madeBy: { provider: "scripted", version: "1" }, frames: atS.map((t) => frame(t)) }),
  clip: async (_s, { fromS, toS }) => ({ madeBy: { provider: "scripted", version: "1" }, path: "/work/tmp/clip.mp4", mimeType: "video/mp4", fromS, toS }),
  ...overrides,
});

test("the line that tells the model what a file is, and the facts of one nothing could probe", () => {
  assert.equal(describeVideo({ durationS: 1800, width: 1280, height: 720, fps: 15, bytes: 149165350 }), '{"duration_s":1800,"duration":"30:00.0","width":1280,"height":720,"fps":15,"bytes":149165350}');
  assert.equal(describeVideo(unprobedVideo(source("/a.mp4", 3885100))), '{"duration_s":null,"duration":"?","width":null,"height":null,"fps":null,"bytes":3885100}');
  assert.equal(describeVideo({ durationS: 61.456, width: 10, height: 10, fps: 29.97003, bytes: 1 }), '{"duration_s":61.46,"duration":"1:01.5","width":10,"height":10,"fps":29.97,"bytes":1}');
});

test("a window is checked against what the file says: refused in a sentence, or the window to cut", () => {
  const facts = { durationS: 1800, width: 1, height: 1, fps: 1, bytes: 1 };
  assert.deepEqual(videoWindow(facts, 60, 90), { fromS: 60, toS: 90 });
  assert.deepEqual(videoWindow(facts, 1700, 2000), { fromS: 1700, toS: 1800 }, "an end past the file is its end");
  assert.deepEqual(videoWindow(facts, 100), { fromS: 100, toS: 1800 });
  assert.deepEqual(videoWindow(facts), { fromS: 0, toS: 1800 });
  assert.deepEqual(videoWindow(facts, -5, 10), { fromS: 0, toS: 10 });
  assert.equal(videoWindow(facts, 9, 5), "to_s (5) must be greater than from_s (9)");
  assert.equal(videoWindow(facts, 9, 9), "to_s (9) must be greater than from_s (9)");
  assert.equal(videoWindow(facts, 1900, 2000), "from_s (1900) is past the end of the video (1800.00s)");
  const unknown = unprobedVideo(source());
  assert.deepEqual(videoWindow(unknown, 10, 20), { fromS: 10, toS: 20 });
  assert.match(videoWindow(unknown, 10), /does not state its length, so to_s is needed/);
});

test("a probe gives the file's facts, or the size alone with the reason", async () => {
  const { env } = memory();
  const good = await probeVideo(scripted(), source(), call(env));
  assert.deepEqual(good.facts, { durationS: 60, width: 640, height: 360, fps: 5, bytes: 1000 });
  assert.equal(good.miss, undefined);
  const damaged = await probeVideo(scripted({ probe: async () => { throw new Error("ffprobe exited 1\nmore"); } }), source(), call(env));
  assert.deepEqual(damaged.facts, unprobedVideo(source()));
  assert.deepEqual(damaged.miss, { code: "unreadable", text: "the file could not be read as a video (ffprobe exited 1)" });
  const absent = await probeVideo(scripted({ probe: async () => { throw new VideoMiss("needs", "ffmpeg is not here"); } }), source(), call(env));
  assert.deepEqual(absent.miss, { code: "needs", text: "ffmpeg is not here" });
});

test("frames: at most the images a call may carry, never off the limits, in order, with the times that gave none", async () => {
  const { env } = memory();
  const asked = [];
  const provider = scripted({ frames: async (_s, request) => { asked.push(request); return { madeBy: { provider: "scripted", version: "1" }, frames: request.atS.filter((t) => t !== 3).map((t) => frame(t)) }; } });
  const limits = resolveLimits(undefined, { imagesPerCall: 4, image: { maxWidth: 800, maxHeight: 600 } });
  const out = await videoFrames(provider, source(), { atS: [1, -2, 2, Number.NaN, 3, 4, 5, 6], maxEdge: 1024 }, limits, call(env));
  assert.deepEqual(asked, [{ atS: [1, 2, 3, 4], maxEdge: 600 }], "negative and non-numeric times are not asked, and the count and edge are the limits'");
  assert.equal(out.ok, true);
  assert.deepEqual(out.parts.map((p) => p.fragment), ["t=1", "t=2", "t=4"]);
  assert.deepEqual(out.missing, [3]);
  assert.deepEqual(out.parts.map((p) => [p.type, p.mimeType, p.width, p.height]), Array(3).fill(["image", "image/jpeg", 320, 180]));
});

test("frames: one over the image byte limit or past a result's share of the request is left out, never sent", async () => {
  const { env } = memory();
  const sizes = { 1: 100, 2: 5000, 3: 100, 4: 100 };
  const provider = scripted({ frames: async (_s, { atS }) => ({ madeBy: { provider: "scripted", version: "1" }, frames: atS.map((t) => frame(t, sizes[t])) }) });
  const bytes = (n) => Math.ceil(n / 3) * 4;
  const limits = resolveLimits(undefined, { image: { maxBytes: bytes(1000) } });
  const over = await videoFrames(provider, source(), { atS: [1, 2, 3], maxEdge: 320 }, limits, call(env));
  assert.deepEqual([over.parts.map((p) => p.fragment), over.missing], [["t=1", "t=3"], [2]]);
  // requestBytes is the smallest known cap less 1 MiB; a result may use a quarter of it.
  const share = resolveLimits(undefined, { requestBytes: 1024 * 1024 + 4 * bytes(100) + 3 });
  assert.equal(share.requestBytes, 4 * bytes(100) + 3);
  const room = await videoFrames(provider, source(), { atS: [1, 3, 4], maxEdge: 320 }, share, call(env));
  assert.deepEqual([room.parts.map((p) => p.fragment), room.missing], [["t=1"], [3, 4]]);
});

test("frames: none made is video_unseeable; a typed miss keeps its code and text; a cancelled call throws", async () => {
  const { env } = memory();
  const limits = resolveLimits(undefined);
  const none = await videoFrames(scripted({ frames: async () => ({ madeBy: { provider: "s", version: "1" }, frames: [] }) }), source(), { atS: [500], maxEdge: 320 }, limits, call(env));
  assert.deepEqual([none.ok, none.code], [false, "video_unseeable"]);
  const nothing = await videoFrames(scripted(), source(), { atS: [-1, Number.NaN], maxEdge: 320 }, limits, call(env));
  assert.equal(nothing.code, "video_unseeable");
  const needs = await videoFrames(scripted({ frames: async () => { throw new VideoMiss("needs", "ffmpeg is not here"); } }), source(), { atS: [1], maxEdge: 320 }, limits, call(env));
  assert.deepEqual([needs.code, needs.text], ["needs", "ffmpeg is not here"]);
  const crashed = await videoFrames(scripted({ frames: async () => { throw new Error("ffmpeg exited 1\nlog"); } }), source(), { atS: [1], maxEdge: 320 }, limits, call(env));
  assert.deepEqual([crashed.code, crashed.text], ["video_unseeable", "no frame could be taken (ffmpeg exited 1)"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(videoFrames(scripted({ frames: async () => { throw new Error("aborted"); } }), source(), { atS: [1], maxEdge: 320 }, limits, call(env, controller.signal)), /aborted/);
});

test("a window is read back as one part and its file is removed, whether it fits or not", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const { env, removed } = memory({ "/work/tmp/clip.mp4": bytes });
  const asked = [];
  const provider = scripted({ clip: async (_s, request) => { asked.push(request); return { madeBy: { provider: "scripted", version: "1" }, path: "/work/tmp/clip.mp4", mimeType: "video/mp4", fromS: 10, toS: 25 }; } });
  const limits = resolveLimits(undefined, { video: { inlineBytes: 5 } });
  const out = await videoClip(provider, source(), { fromS: 10, toS: 20 }, limits, call(env));
  assert.deepEqual(asked, [{ fromS: 10, toS: 20, maxBytes: 5 }], "the provider is held to the inline budget");
  assert.deepEqual(out.part, { type: "video", data: Buffer.from(bytes).toString("base64"), mimeType: "video/mp4", fragment: "t=10,25" });
  assert.deepEqual([out.fromS, out.toS, out.bytes], [10, 25, 5], "the window is what the provider says it cut");
  assert.deepEqual(removed, ["/work/tmp/clip.mp4"]);
  const { env: other, removed: removedToo } = memory({ "/work/tmp/clip.mp4": bytes });
  const tight = await videoClip(provider, source(), { fromS: 10, toS: 20 }, resolveLimits(undefined, { video: { inlineBytes: 4 } }), call(other));
  assert.deepEqual([tight.ok, tight.code], [false, "over_budget"]);
  assert.match(tight.text, /5 bytes, over the 4/);
  assert.deepEqual(removedToo, ["/work/tmp/clip.mp4"]);
  const { env: gone, removed: removedNone } = memory();
  assert.equal((await videoClip(provider, source(), { fromS: 10, toS: 20 }, limits, call(gone))).code, "video_unseeable");
  assert.deepEqual(removedNone, ["/work/tmp/clip.mp4"]);
});

test("a window the provider cannot cut is the provider's typed miss, else video_unseeable", async () => {
  const { env, removed } = memory();
  const limits = resolveLimits(undefined);
  const big = await videoClip(scripted({ clip: async () => { throw new VideoMiss("over_budget", "about 40 s of it do"); } }), source(), { fromS: 0, toS: 99 }, limits, call(env));
  assert.deepEqual([big.code, big.text], ["over_budget", "about 40 s of it do"]);
  const broken = await videoClip(scripted({ clip: async () => { throw new Error("ffmpeg exited 234"); } }), source(), { fromS: 0, toS: 9 }, limits, call(env));
  assert.deepEqual([broken.code, broken.text], ["video_unseeable", "the window could not be cut (ffmpeg exited 234)"]);
  assert.deepEqual(removed, [], "nothing was written, so nothing is removed");
});

test("a file within the inline budget goes as it is, with no provider; over it, or in an unknown container, it is a miss", async () => {
  const files = { "/work/call.mp4": new Uint8Array(900), "/work/call.avi": new Uint8Array(10) };
  const { env } = memory(files);
  const limits = resolveLimits(undefined, { video: { inlineBytes: 1000 } });
  const whole = await videoAsIs(source("/work/call.mp4", 900), { durationS: 20, width: 1, height: 1, fps: 1, bytes: 900 }, limits, call(env));
  assert.deepEqual([whole.part.mimeType, whole.part.fragment, whole.bytes, whole.part.data.length], ["video/mp4", "t=0,20", 900, 1200]);
  const unknownLength = await videoAsIs(source("/work/call.mp4", 900), unprobedVideo(source("/work/call.mp4", 900)), limits, call(env));
  assert.equal(unknownLength.part.fragment, "t=0");
  const big = await videoAsIs(source("/work/call.mp4", 1001), unprobedVideo(source()), limits, call(env));
  assert.deepEqual([big.ok, big.code], [false, "over_budget"]);
  assert.match(big.text, /it is 1001 bytes, over the 1000 a request carries inline; read a window of it with from_s and to_s/);
  const grew = await videoAsIs(source("/work/call.mp4", 10), unprobedVideo(source()), resolveLimits(undefined, { video: { inlineBytes: 100 } }), call(env));
  assert.equal(grew.code, "over_budget", "the bytes read count, not only the size the caller stated");
  const avi = await videoAsIs(source("/work/call.avi", 10), unprobedVideo(source()), limits, call(env));
  assert.deepEqual([avi.ok, avi.code], [false, "unsupported"]);
  const missing = await videoAsIs(source("/work/none.mp4", 10), unprobedVideo(source()), limits, call(env));
  assert.equal(missing.code, "unreadable");
});

test("with no ffmpeg in the environment every operation is a needs miss that names it, and a small file still goes as it is", async () => {
  const { env } = memory({ "/work/call.mp4": new Uint8Array(500) });
  const provider = ffmpegProvider();
  const found = await detectOnce(provider, env);
  assert.deepEqual([found.available, found.needs], [false, "ffmpeg and ffprobe (6.1 or later)"]);
  assert.match(found.reason, /spawn ffmpeg ENOENT/);
  const limits = resolveLimits(undefined);
  const probed = await probeVideo(provider, source("/work/call.mp4", 500), call(env));
  assert.deepEqual(probed.facts, unprobedVideo(source("/work/call.mp4", 500)));
  assert.equal(probed.miss.code, "needs");
  assert.match(probed.miss.text, /ffmpeg and ffprobe \(6\.1 or later\) are not available here .*still shown as it is to a route that takes video/);
  for (const out of [
    await videoFrames(provider, source("/work/call.mp4", 500), { atS: [1], maxEdge: 320 }, limits, call(env)),
    await videoClip(provider, source("/work/call.mp4", 500), { fromS: 0, toS: 5 }, limits, call(env)),
  ]) assert.deepEqual([out.ok, out.code], [false, "needs"]);
  const whole = await videoAsIs(source("/work/call.mp4", 500), probed.facts, limits, call(env));
  assert.equal(whole.ok, true);
});

test("the video code runs programs only through the environment and never resolves mediabunny itself", async () => {
  for (const file of ["../dist/providers/ffmpeg.js", "../dist/core/video.js"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /child_process|execFile|spawn\(|from "mediabunny"|import\("mediabunny"\)/, file);
  }
});
