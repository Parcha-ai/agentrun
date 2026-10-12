// A video through `read` with the package's own readers and the environment's ffmpeg: a lead that takes no video is shown
// frames found by seek over the file or its window, one look's worth; a lead that takes video is given the file when it
// fits and a window cut from it when one is asked. Runs in the `vision-binaries` job, where a missing ffmpeg fails it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, VIDEO_FRAMES_PER_READ, imageHeader, readMedia, resolveLimits } from "@parcha/pi-vision";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { fixtureDir } from "@parcha/pi-vision/testing";

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
