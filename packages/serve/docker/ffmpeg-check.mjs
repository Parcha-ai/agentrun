// The image's ffmpeg does what the screen recorder asks of it (src/computer-record.ts): the recorder, run on the ffmpeg on
// this machine's PATH, takes a phone's PNG frames and then its JPEG frames (frame.png and frame.jpg beside this file,
// 1920x1080) into two files, each fragmented MP4 that holds H.264 frames fitted to 1280x720. The image has no ffprobe, so
// the files are read here, box by box. The Dockerfile runs it on the final image, so a build whose ffmpeg lacks a part the
// recorder uses fails. It waits on the recorder, up to a deadline (60 s, or the ms given), and a deadline passed fails
// by name: the frame format that was never written, the files, the frames written and dropped.
//   node ffmpeg-check.mjs [deadline-ms]
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startRecording } from "../dist/computer-record.js";

const fail = (why) => {
  console.error(`ffmpeg check: ${why}`);
  process.exit(1);
};

const DEADLINE_MS = process.argv[2] === undefined ? 60_000 : Number(process.argv[2]);
if (!(DEADLINE_MS > 0)) fail(`the deadline ${process.argv[2]} is no number of ms`);

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
/** The frames written when the second file opened: the recorder says so after naming the file and before it writes
 *  the frame that opened it, so every frame written past this count is a JPEG one. */
let switchedAt;
const recorder = startRecording({
  watch: async (given) => {
    handlers = given;
    return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
  },
  folder: join(dir, "recordings"), tag: "c1", kind: "phone", log: () => {},
  say: () => {
    const now = recorder.facts();
    if (now.files.length === 2) switchedAt ??= now.written;
  },
});
while (!handlers) await sleep(10);
// Frames go in until the recorder has written what the check reads, not for a fixed time: an ffmpeg that starts slowly
// (the image built for another architecture under emulation) keeps the recorder busy, and it keeps only the newest frame
// meanwhile. PNG frames until one is written, then JPEG frames until a second file holds one written after the switch.
let seq = 0;
let deadlineHit = false;
setTimeout(() => (deadlineHit = true), DEADLINE_MS).unref();
const facts = () => recorder.facts();
const factWords = () => {
  const now = facts();
  return `files: ${now.files.join(", ") || "none"}, written ${now.written}, dropped ${now.dropped}`;
};
/** Fails with `why` (read before the stop) once the recording is stopped: its ffmpeg finished or killed, none left running. */
const stopThenFail = async (why) => {
  await recorder.stop("ended");
  fail(why);
};
// A frame counts as written once ffmpeg's input took it (the pipe's buffer), which is before ffmpeg has made its file, or
// even started: one that refuses JPEG frames can take one and then exit with no file made, and a stop that comes before
// the recorder hears of the exit reads no `ended`. So the JPEG file is done once it is on the disk too; until then the loop
// goes on, and the ffmpeg that exited fails by name (`ended`), never as a read of a file that is not there. (The PNG file
// is finished, so on the disk, once the switch to JPEG closes it.)
for (const [format, file, done] of [
  ["png", "frame.png", () => facts().written >= 1],
  ["jpeg", "frame.jpg", () => switchedAt !== undefined && facts().files.length === 2 && facts().written > switchedAt && existsSync(join(dir, facts().files[1]))],
]) {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(file, import.meta.url))));
  while (!done()) {
    if (facts().ended) await stopThenFail(`the recording ended by itself: ${facts().ended} (${factWords()})`);
    if (deadlineHit) await stopThenFail(`no ${format.toUpperCase()} frame written in ${DEADLINE_MS / 1000} s (${factWords()})`);
    handlers.frame({ seq: ++seq, format, bytes, width: 1920, height: 1080, frameWidth: 1920, frameHeight: 1080 }, () => {});
    await sleep(150);
  }
}
await recorder.stop("ended");
const stopped = facts();
if (stopped.ended) fail(`the recording ended by itself: ${stopped.ended}`);
if (stopped.files.join(" ") !== "recordings/c1.mp4 recordings/c1-2.mp4") fail(`the files are ${stopped.files.join(", ") || "none"}, not one per format`);
const read = stopped.files.map((name) => [name, video(join(dir, name))]);
for (const [name, { codec, width, height, frames }] of read) {
  if (codec !== "avc1" || width !== 1280 || height !== 720 || frames < 1) fail(`${name} holds ${frames} ${codec} frames ${width}x${height}, not H.264 at 1280x720`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`ffmpeg check: the recorder made ${read.map(([name, { frames }]) => `${name} (${frames} H.264 frames, 1280x720)`).join(" and ")} from PNG and JPEG frames`);
