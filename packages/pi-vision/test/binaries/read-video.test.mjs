// A video through `read` with the package's own readers and the environment's ffmpeg: a lead that takes no video is shown
// frames found by seek over the file or its window, one look's worth; a lead that takes video is given the file when it
// fits and a window cut from it when one is asked; a lead that takes no video, with eyes that take video, has the eyes
// look at the file or its window as one clip, whatever images the lead takes. Runs in the `vision-binaries` job, where a
// missing ffmpeg fails it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, VIDEO_FRAMES_PER_READ, guardResult, imageHeader, readMedia, resolveLimits } from "@parcha/pi-vision";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { fakeEyes, fixtureDir } from "@parcha/pi-vision/testing";

const have = ["ffmpeg", "ffprobe"].every((program) => spawnSync(program, ["-version"]).status === 0);
const skip = have ? false : "ffmpeg and ffprobe are not installed here";
if (!have && process.env.PI_VISION_REQUIRE_BINARIES === "1") test("ffmpeg and ffprobe are installed", () => assert.fail("this suite needs ffmpeg and ffprobe"));

const text = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const blocks = (result) => result.content.filter((b) => b.type === "image");

async function rig(limits) {
  const dir = await fixtureDir("pi-vision-read-video-");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", `${dir.path}/clip.mp4`]);
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const setup = { limits, eyes: undefined, providers: [ffmpegProvider()], sources: {}, scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, evidence: { file: async () => null } };
  const call = { conversationId: "c1", callId: "t1", model: undefined, signal: undefined };
  return { dir, read: (args) => readMedia(env, args, call, setup) };
}

test("a lead that takes no video sees frames by seek over the whole file, or over the window it asked for", { skip }, async (t) => {
  const r = await rig(DEFAULT_LIMITS);
  t.after(() => r.dir.remove());
  const whole = await r.read({ path: "clip.mp4" });
  assert.equal(blocks(whole).length, VIDEO_FRAMES_PER_READ);
  assert.ok(blocks(whole).every((b) => b.mimeType.startsWith("image/") && imageHeader(Buffer.from(b.data, "base64")).width <= 640));
  assert.match(whole.content[0].text, /^Video file clip\.mp4: \{"duration_s":12,.*\}\. Shown: 8 frames found by seek at [\d., ]+ s; read a from_s\.\.to_s window for a closer look\.$/);
  assert.deepEqual(whole.details.media.units, Array(VIDEO_FRAMES_PER_READ).fill(0), "the frames are one unit");
  whole.content.slice(1).forEach((block, i) => assert.equal(block.type, i % 2 ? "image" : "text", "each frame follows the line that names its time"));
  assert.match(whole.content[1].text, /^Frame at [\d.]+ s\.$/);
  const window = await r.read({ path: "clip.mp4", from_s: 4, to_s: 6, ask: "What changes?" });
  const times = /found by seek at ([\d., ]+) s within 4s to 6s/.exec(text(window))[1].split(", ").map(Number);
  assert.ok(times.every((s) => s >= 4 && s <= 6), times.join(", "));
  assert.deepEqual([window.details.media.fromS, window.details.media.toS], [4, 6]);
  assert.match(window.content[0].text, /Asked: What changes\?$/);
});

test("a lead that takes video gets the file when it fits and a window cut from it when one is asked", { skip }, async (t) => {
  const r = await rig(resolveLimits(undefined, { video: { native: true } }));
  t.after(() => r.dir.remove());
  const whole = await r.read({ path: "clip.mp4" });
  assert.deepEqual(blocks(whole).map((b) => b.mimeType), ["video/mp4"]);
  const window = await r.read({ path: "clip.mp4", from_s: 2, to_s: 5 });
  assert.deepEqual(blocks(window).map((b) => b.mimeType), ["video/mp4"]);
  assert.ok(Buffer.from(blocks(window)[0].data, "base64").length < Buffer.from(blocks(whole)[0].data, "base64").length, "the window is less than the file");
  assert.match(text(window), /Shown: the window [\d.]+s to [\d.]+s \(\d+ bytes\)\.$/);
  const past = await r.read({ path: "clip.mp4", from_s: 30 });
  assert.equal(past.isError, true);
  assert.match(text(past), /^Cannot read clip\.mp4: from_s \(30\) is past the end of the video \(12\.00s\)\.$/);
});

test("a read of a video window that misses is filed with the video, its kind, its hash and the window asked", { skip }, async (t) => {
  const dir = await fixtureDir("pi-vision-read-video-miss-");
  t.after(() => dir.remove());
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", `${dir.path}/clip.mp4`]);
  const filed = [];
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const setup = { limits: resolveLimits(undefined, { video: { native: true, inlineBytes: 2000 } }), eyes: undefined, providers: [ffmpegProvider()], sources: {}, scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/1-look.md` }; } } };
  const out = await readMedia(env, { path: "clip.mp4", from_s: 2, to_s: 5 }, { conversationId: "c1", callId: "t1", model: undefined, signal: undefined }, setup);
  assert.equal(out.details.miss.code, "over_budget");
  const [record] = filed;
  const sha256 = createHash("sha256").update(readFileSync(`${dir.path}/clip.mp4`)).digest("hex");
  assert.deepEqual([record.args.path, record.args.from_s, record.args.to_s, record.facts.kind, record.facts.sha256, record.facts.fragment], ["clip.mp4", 2, 5, "video", sha256, "t=2,5"]);
});

/** A read and its guard on one call, as the durable extension composes them: a lead of `input` and these eyes. Looks
 *  are filed in `filed` and the call keeps its memos in `memos`, as a host's evidence and pi-durable's memos do. */
const tinyBudget = () => resolveLimits(undefined, { video: { native: true, inlineBytes: 2000 } });
async function rigWithEyes({ input, eyes, leadVideo = false }) {
  const dir = await fixtureDir("pi-vision-read-video-eyes-");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", `${dir.path}/clip.mp4`]);
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const model = { id: "lead-model", input };
  const limits = resolveLimits(model, { video: { native: leadVideo } });
  const filed = [];
  const memos = new Map();
  const evidence = { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}-look.md` }; } };
  const setup = { limits, eyes, providers: [ffmpegProvider()], sources: {}, scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, evidence };
  const memo = async (key, compute) => { if (!memos.has(key)) memos.set(key, await compute()); return memos.get(key); };
  const call = { conversationId: "c1", callId: "t1", model, signal: undefined, memo };
  return { dir, filed, memos, read: async (args) => guardResult(await readMedia(env, args, call, setup), call, setup, imageHeader) };
}
const seenParts = (request) => request.parts.filter((p) => p.type !== "text").map((p) => p.mimeType);

test("a lead that takes no images, with eyes that take video: the eyes get the file, or the window asked, as one clip and never frames", { skip }, async (t) => {
  const eyes = fakeEyes({ accepts: { video: true }, answers: ["A test card with a moving bar."] });
  const r = await rigWithEyes({ input: ["text"], eyes });
  t.after(() => r.dir.remove());
  const whole = await r.read({ path: "clip.mp4", ask: "What moves?" });
  assert.deepEqual(eyes.ledger.map(seenParts), [["video/mp4"]], "one look at the clip itself");
  assert.equal(eyes.ledger[0].ask, "What moves?");
  assert.equal(blocks(whole).length, 0, "only the eyes' words reach the lead");
  assert.match(text(whole), /video seen for you by fake-eyes/);
  await r.read({ path: "clip.mp4", from_s: 2, to_s: 5, ask: "What moves?" });
  assert.deepEqual(eyes.ledger.map(seenParts), [["video/mp4"], ["video/mp4"]], "a window is one clip too");
});

test("eyes that take no video still look at frames for a lead that takes no images", { skip }, async (t) => {
  const eyes = fakeEyes({ answers: ["A test card."] });
  const r = await rigWithEyes({ input: ["text"], eyes });
  t.after(() => r.dir.remove());
  await r.read({ path: "clip.mp4", ask: "What moves?" });
  assert.deepEqual(eyes.ledger.map(seenParts), [Array(VIDEO_FRAMES_PER_READ).fill("image/jpeg")]);
});

test("a lead that takes images but not video, with eyes that take video: the eyes get the file, or the window asked, as one clip, and the lead their words", { skip }, async (t) => {
  const eyes = fakeEyes({ accepts: { video: true }, answers: ["A test card with a moving bar."] });
  const r = await rigWithEyes({ input: ["text", "image"], eyes });
  t.after(() => r.dir.remove());
  const whole = await r.read({ path: "clip.mp4", ask: "What moves?" });
  assert.deepEqual(eyes.ledger.map(seenParts), [["video/mp4"]], "one look at the clip itself, never frames");
  assert.equal(eyes.ledger[0].ask, "What moves?");
  assert.equal(blocks(whole).length, 0, "no frame reaches the lead");
  assert.match(text(whole), /video seen for you by fake-eyes/);
  await r.read({ path: "clip.mp4", from_s: 2, to_s: 5, ask: "What moves?" });
  assert.deepEqual(eyes.ledger.map(seenParts), [["video/mp4"], ["video/mp4"]], "a window is one clip too");
});

test("a lead that takes images, with eyes that take no video, sees the frames itself; a lead that takes video, the file; the eyes are not asked", { skip }, async (t) => {
  const still = fakeEyes();
  const watching = fakeEyes({ accepts: { video: true } });
  const images = await rigWithEyes({ input: ["text", "image"], eyes: still });
  const video = await rigWithEyes({ input: ["text", "image"], eyes: watching, leadVideo: true });
  t.after(() => Promise.all([images.dir.remove(), video.dir.remove()]));
  const frames = await images.read({ path: "clip.mp4", ask: "What moves?" });
  assert.equal(blocks(frames).length, VIDEO_FRAMES_PER_READ);
  assert.ok(blocks(frames).every((b) => b.mimeType.startsWith("image/")));
  const clip = await video.read({ path: "clip.mp4" });
  assert.deepEqual(blocks(clip).map((b) => b.mimeType), ["video/mp4"]);
  assert.deepEqual([still.ledger.length, watching.ledger.length], [0, 0], "the eyes are not asked when the lead sees the media itself");
});

test("an image-taking lead's clip look is filed and kept in the same shape as a text-only lead's, and its answer is kept for the call", { skip }, async (t) => {
  const shapeOf = (r) => {
    const [record] = r.filed;
    return { args: Object.keys(record.args).sort(), facts: Object.keys(record.facts).sort(), kind: record.facts.kind, native: record.args.native, model: record.args.model,
      memos: [...r.memos.keys()].map((key) => key.split(":").slice(0, 2).join(":")).sort(), kept: Object.keys([...r.memos].find(([key]) => key.startsWith("vision:look:"))[1]).sort() };
  };
  const blindEyes = fakeEyes({ accepts: { video: true }, answers: ["A moving bar."] });
  const imageEyes = fakeEyes({ accepts: { video: true }, answers: ["A moving bar."] });
  const blind = await rigWithEyes({ input: ["text"], eyes: blindEyes });
  const images = await rigWithEyes({ input: ["text", "image"], eyes: imageEyes });
  t.after(() => Promise.all([blind.dir.remove(), images.dir.remove()]));
  const args = { path: "clip.mp4", from_s: 2, to_s: 5, ask: "What moves?" };
  await blind.read(args);
  await images.read(args);
  assert.equal(images.filed.length, 1, "the look is filed once");
  assert.deepEqual(shapeOf(images), shapeOf(blind));
  assert.deepEqual([images.filed[0].facts.kind, images.filed[0].args.native, images.filed[0].args.model], ["video", false, "fake-eyes"]);
  const again = await images.read(args);
  assert.equal(imageEyes.ledger.length, 1, "the same call reads the same window again from its kept answer, unpaid");
  assert.match(text(again), /A moving bar\./);
});

test("over the eyes' inline budget, a lead that takes images sees its own 8 frames, as with eyes that take no video; a lead that takes no images gets the miss", { skip }, async (t) => {
  const tight = fakeEyes({ accepts: { video: true }, limits: tinyBudget() });
  const blindEyes = fakeEyes({ accepts: { video: true }, limits: tinyBudget() });
  const images = await rigWithEyes({ input: ["text", "image"], eyes: tight });
  const blind = await rigWithEyes({ input: ["text"], eyes: blindEyes });
  t.after(() => Promise.all([images.dir.remove(), blind.dir.remove()]));
  const whole = await images.read({ path: "clip.mp4", ask: "What moves?" });
  assert.equal(blocks(whole).length, VIDEO_FRAMES_PER_READ, "the whole file: the lead's frames");
  assert.ok(blocks(whole).every((b) => b.mimeType.startsWith("image/")));
  assert.match(whole.content[0].text, /Shown: 8 frames found by seek at [\d., ]+ s; read a from_s\.\.to_s window for a closer look\. Asked: What moves\?$/);
  const window = await images.read({ path: "clip.mp4", from_s: 2, to_s: 5, ask: "What moves?" });
  assert.equal(blocks(window).length, VIDEO_FRAMES_PER_READ, "a window: the lead's frames of it");
  assert.match(text(window), /found by seek at [\d., ]+ s within 2s to 5s/);
  assert.equal(tight.ledger.length, 0, "the eyes are not asked; the lead sees the frames itself");
  const missed = await blind.read({ path: "clip.mp4", from_s: 2, to_s: 5, ask: "What moves?" });
  assert.equal(missed.details.miss.code, "over_budget");
  assert.equal(blindEyes.ledger.length, 0);
});
