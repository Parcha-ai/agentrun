// The image's ffmpeg does what the screen recorder asks of it (src/computer-record.ts): the recorder, run on the ffmpeg on
// this machine's PATH, takes a phone's PNG frames and then its JPEG frames (frame.png and frame.jpg beside this file,
// 1920x1080) into two files, each fragmented MP4 that holds H.264 frames fitted to 1280x720. The image has no ffprobe, so
// the files are read here, box by box. The Dockerfile runs it on the final image, so a build whose ffmpeg lacks a part the
// recorder uses fails.
//   node ffmpeg-check.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startRecording } from "../dist/computer-record.js";

const fail = (why) => {
  console.error(`ffmpeg check: ${why}`);
  process.exit(1);
};

/** The boxes of an MP4 between `from` and `to`: each one's type and its payload's start and end. */
function boxes(bytes, from, to) {
  const found = [];
  for (let at = from; at + 8 <= to; ) {
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > to) fail(`a box at byte ${at} says ${size} bytes`);
    found.push({ type: bytes.toString("latin1", at + 4, at + 8), start: at + 8, end: at + size });
    at += size;
  }
  return found;
}

/** A file's video: its sample entry's codec and size (moov's stsd), and the frames its fragments hold (each trun's count). */
function video(path) {
  const bytes = readFileSync(path);
  const top = boxes(bytes, 0, bytes.length);
  const inside = (box, types) => types.reduce((at, type) => at && boxes(bytes, at.start, at.end).find((child) => child.type === type), box);
  const stsd = inside(top.find((box) => box.type === "moov"), ["trak", "mdia", "minf", "stbl", "stsd"]);
  if (top[0]?.type !== "ftyp" || !stsd) fail(`${path} is no MP4 with a video track`);
  // stsd: version and flags, an entry count, then the entries; an avc1 entry's width and height are 24 bytes into it.
  const [entry] = boxes(bytes, stsd.start + 8, stsd.end);
  const frames = top.filter((box) => box.type === "moof").reduce((sum, moof) => {
    const trun = inside(moof, ["traf", "trun"]);
    return sum + (trun ? bytes.readUInt32BE(trun.start + 4) : 0);
  }, 0);
  return { codec: entry.type, width: bytes.readUInt16BE(entry.start + 24), height: bytes.readUInt16BE(entry.start + 26), frames };
}

const dir = mkdtempSync(join(tmpdir(), "agentrun-ffmpeg-check-"));
let handlers;
const recorder = startRecording({
  watch: async (given) => {
    handlers = given;
    return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
  },
  folder: join(dir, "recordings"), tag: "c1", kind: "phone", say: () => {}, log: () => {},
});
while (!handlers) await sleep(10);
let seq = 0;
for (const [format, file] of [["png", "frame.png"], ["jpeg", "frame.jpg"]]) {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(file, import.meta.url))));
  for (let i = 0; i < 4; i += 1) {
    handlers.frame({ seq: ++seq, format, bytes, width: 1920, height: 1080, frameWidth: 1920, frameHeight: 1080 }, () => {});
    await sleep(150);
  }
}
await recorder.stop("ended");
const facts = recorder.facts();
if (facts.ended) fail(`the recording ended by itself: ${facts.ended}`);
if (facts.files.join(" ") !== "recordings/c1.mp4 recordings/c1-2.mp4") fail(`the files are ${facts.files.join(", ") || "none"}, not one per format`);
const read = facts.files.map((name) => [name, video(join(dir, name))]);
for (const [name, { codec, width, height, frames }] of read) {
  if (codec !== "avc1" || width !== 1280 || height !== 720 || frames < 1) fail(`${name} holds ${frames} ${codec} frames ${width}x${height}, not H.264 at 1280x720`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`ffmpeg check: the recorder made ${read.map(([name, { frames }]) => `${name} (${frames} H.264 frames, 1280x720)`).join(" and ")} from PNG and JPEG frames`);
