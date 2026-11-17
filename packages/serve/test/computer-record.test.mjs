// A run's video of its desktop's or phone's screen (serve/src/computer-record.ts startRecording): a watch of its own, each
// frame acked as it comes, at most RECORDING_LIMITS.fps frames a second piped to one ffmpeg per file, a newer frame
// replacing the one waiting (thinned within the frame rate's bound, dropped while ffmpeg is busy), never a wait. A frame of
// another format ends the file and goes on in the next; the caps, ffmpeg's own end and a screen gone each end it with a
// line on the run's timeline. Every ffmpeg here is a loopback stand-in (a node script) but the playback test's, which
// pipes real frames (the image's ffmpeg check's, docker/frame.png and frame.jpg) through the ffmpeg on this machine's
// PATH, the image's slim one included, and reads the file back with ffprobe.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { RECORDING_LIMITS, recorderMissing, startRecording } from "../dist/computer-record.js";
import { commandOnPath } from "../dist/host-command.js";

const dirs = [];
/** Every recording made here, stopped at the end whatever a test left (a live stand-in ffmpeg keeps the process up). */
const recorders = [];
after(async () => {
  await Promise.all(recorders.map((recorder) => recorder.stop("ended")));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-record-")));
  dirs.push(dir);
  return dir;
}

/** A program in ffmpeg's place: `body` run by node, its arguments in process.argv (the file's path last). */
let programs = 0;
function program(dir, body) {
  const path = join(dir, `ffmpeg-${++programs}`);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
/** Writes what it reads to the file, as ffmpeg would its video, and its arguments beside `argsAt`. */
const COPY = (argsAt) => `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(argsAt)}, JSON.stringify(process.argv.slice(2))); process.stdin.pipe(fs.createWriteStream(process.argv.at(-1)));`;
/** Never reads: the encoder that fell behind. */
const STALLED = "setInterval(() => {}, 1000);";
const CRASHES = "process.stdin.once(\"data\", () => process.exit(3));";
const DISK_FULL = "process.stdin.once(\"data\", () => { process.stderr.write(\"av_interleaved_write_frame(): No space left on device\\n\"); process.exit(1); });";

/** The computer's screen, as provider.watch gives it: each watch's handlers and signal, a frame shown to the newest one
 *  (answering how many acks it got back right away), and each watch's close. */
function screen() {
  const watches = [];
  let seq = 0;
  const watch = async (handlers, options) => {
    const one = { handlers, signal: options.signal, closed: false };
    watches.push(one);
    return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => void (one.closed = true) } };
  };
  const show = (frame) => {
    let acks = 0;
    watches.at(-1).handlers.frame({ seq: ++seq, ...frame }, () => void (acks += 1));
    return acks;
  };
  return { watch, watches, show };
}

const frame = (format, bytes, width = 1280, height = 720) => ({ format, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), width, height, frameWidth: width, frameHeight: height });

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A recording of `kind` into a fresh recordings folder, its timeline's lines and operator's lines kept. */
function recording({ ffmpeg, kind = "desktop", limits, folder } = {}) {
  const tv = screen();
  const lines = [];
  const logged = [];
  const at = folder ?? join(scratch(), "recordings");
  const recorder = startRecording({ watch: tv.watch, folder: at, tag: "c1", kind, say: (words) => void lines.push(words), ffmpeg, ...(limits ? { limits } : {}), log: (line) => void logged.push(line) });
  recorders.push(recorder);
  return { tv, lines, logged, folder: at, recorder };
}

test("the bounds: at most 10 frames a second, 1280 pixels on the long side, 500 MB or 2 h across a recording's files", () => {
  assert.equal(RECORDING_LIMITS.fps, 10);
  assert.equal(RECORDING_LIMITS.edge, 1280);
  assert.equal(RECORDING_LIMITS.maxBytes, 500 * 1024 * 1024);
  assert.equal(RECORDING_LIMITS.maxMs, 2 * 60 * 60 * 1000);
});

test("ffmpeg missing from the server's PATH is said in words; found on it, nothing is", () => {
  const bin = scratch();
  assert.equal(recorderMissing(""), "ffmpeg isn't installed on this server (no ffmpeg command on PATH)");
  assert.equal(recorderMissing(bin), "ffmpeg isn't installed on this server (no ffmpeg command on PATH)");
  writeFileSync(join(bin, "ffmpeg"), "#!/bin/sh\n");
  assert.equal(recorderMissing(bin), "ffmpeg isn't installed on this server (no ffmpeg command on PATH)", "a file that isn't executable is no command");
  chmodSync(join(bin, "ffmpeg"), 0o755);
  assert.equal(recorderMissing(`/nowhere:${bin}`), undefined);
});

test("each frame is acked as it comes; an encoder that falls behind costs frames (dropped, counted), never a wait", async () => {
  const dir = scratch();
  const { tv, recorder, logged } = recording({ ffmpeg: program(dir, STALLED), limits: { settleMs: 200 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  // 1 MB a frame: more than the pipe holds, so ffmpeg never takes the first one.
  const big = frame("jpeg", new Uint8Array(1 << 20));
  assert.equal(tv.show(big), 1, "acked before the show returned");
  await until(() => recorder.facts().files.length === 1, "the file's ffmpeg started");
  await sleep(100);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(tv.show(big), 1, `frame ${i + 2} acked before the show returned`);
    await sleep(5);
  }
  assert.deepEqual(recorder.facts(), { files: ["recordings/c1.mp4"], written: 0, dropped: 19, thinned: 0 }, "the first waits in the slot, each of the 19 after it replaces it");
  const started = Date.now();
  await recorder.stop("ended");
  assert.ok(Date.now() - started < 3_000, "the stop is bounded: ffmpeg that does not finish is killed");
  assert.match(logged.join("\n"), /ffmpeg did not finish recordings\/c1\.mp4 within 200 ms; it was killed/);
  assert.equal(logged.at(-1), "recorded the desktop's screen into recordings/c1.mp4: 0 frames written, 19 dropped while ffmpeg was busy, 0 thinned to 10 a second", "the counts, in the server's log");
  assert.equal(tv.watches[0].closed, true, "the watch let go");
  assert.equal(tv.watches[0].signal.aborted, true);
});

test("at most 10 frames a second reach ffmpeg: one sooner waits, a newer one replaces it (thinned); the stop writes the newest once more", async () => {
  const dir = scratch();
  const { tv, recorder, folder, lines } = recording({ ffmpeg: program(dir, COPY(join(dir, "args.json"))) });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  const started = Date.now();
  for (let i = 0; i < 40; i += 1) {
    tv.show(frame("jpeg", [i, 1, 2, 3, 4, 5, 6, 7]));
    await sleep(10);
  }
  const elapsed = Date.now() - started;
  await sleep(150);
  const facts = recorder.facts();
  assert.ok(facts.written <= Math.ceil(elapsed / 100) + 2, `${facts.written} written in ${elapsed} ms`);
  assert.ok(facts.thinned > 0, "frames within 100 ms of the last one written are thinned");
  assert.equal(facts.written + facts.dropped + facts.thinned, 40, "each frame written or replaced");
  await recorder.stop("released");
  assert.equal(statSync(join(folder, "c1.mp4")).size, (facts.written + 1) * 8, "every frame written reached the file, and the newest once more at the stop");
  assert.deepEqual(lines, ["Recording the desktop's screen into recordings/c1.mp4."], "a stop says nothing more");
  assert.equal(statSync(folder).mode & 0o777, 0o700, "the recordings folder is the server's own");
});

test("the time cap stops it, said on the timeline in words", async () => {
  const dir = scratch();
  const { tv, recorder, lines } = recording({ ffmpeg: program(dir, COPY(join(dir, "args.json"))), limits: { maxMs: 1_000, checkMs: 50 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  const end = Date.now() + 4_000;
  while (!recorder.facts().ended && Date.now() < end) {
    tv.show(frame("jpeg", [1, 2, 3]));
    await sleep(50);
  }
  assert.equal(recorder.facts().ended, "it reached its cap of 1 s");
  assert.deepEqual(lines, ["Recording the desktop's screen into recordings/c1.mp4.", "The recording of the desktop stopped: it reached its cap of 1 s. recordings/c1.mp4 keeps what was recorded until then."]);
  assert.equal(tv.watches[0].closed, true, "the watch let go");
  assert.equal(tv.show(frame("jpeg", [1])), 1, "a frame after the end is still acked");
  await recorder.stop("ended");
  assert.equal(lines.length, 2, "the stop after says nothing");
});

test("a screen unchanged until the cap still makes a video as long as the recording: the newest frame is written once more at the cap", async () => {
  const dir = scratch();
  const { tv, recorder, folder } = recording({ ffmpeg: program(dir, COPY(join(dir, "args.json"))), limits: { maxMs: 300, checkMs: 20 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("jpeg", [7, 7, 7]));
  await until(() => recorder.facts().ended, "the cap");
  await recorder.stop("ended");
  assert.equal(recorder.facts().written, 1);
  assert.deepEqual(readFileSync(join(folder, "c1.mp4")), Buffer.from([7, 7, 7, 7, 7, 7]), "the one frame, and once more at the cap");
});

test("an ffmpeg that took frames and then stopped reading never holds up the stop: the last frame's write and the file's end share one deadline", async () => {
  const dir = scratch();
  // Reads the first 4 MB, then nothing: the first frame's write completes, the stop's repeat of it never does.
  const READS_ONE = "let got = 0; process.stdin.on(\"data\", (chunk) => { got += chunk.length; if (got >= 4 * 1024 * 1024) process.stdin.pause(); }); setInterval(() => {}, 1000);";
  const { tv, recorder, logged } = recording({ ffmpeg: program(dir, READS_ONE), limits: { settleMs: 300 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("jpeg", new Uint8Array(4 * 1024 * 1024)));
  await until(() => recorder.facts().written === 1, "the first frame taken");
  const started = Date.now();
  await recorder.stop("released");
  const took = Date.now() - started;
  assert.ok(took < 1_500, `the stop took ${took} ms: one 300 ms deadline, then a kill`);
  assert.match(logged.join("\n"), /ffmpeg did not finish recordings\/c1\.mp4 within 300 ms; it was killed/);
});

test("the size cap counts the run's earlier files: a run resumed past it records nothing more, said in words", async () => {
  const dir = scratch();
  const argsAt = join(dir, "args.json");
  const folder = join(scratch(), "recordings");
  mkdirSync(folder);
  writeFileSync(join(folder, "c1.mp4"), new Uint8Array(5_000));
  const { tv, recorder, lines } = recording({ ffmpeg: program(dir, COPY(argsAt)), folder, limits: { maxBytes: 4_096 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("jpeg", [1]));
  await until(() => recorder.facts().ended, "the cap");
  assert.deepEqual(lines, ["The recording of the desktop stopped: it reached its cap of 4096 bytes."]);
  assert.equal(existsSync(argsAt), false, "no ffmpeg started");
  assert.deepEqual(readdirSync(folder), ["c1.mp4"]);
});

test("the size cap stops it, across its files, said on the timeline in words", async () => {
  const dir = scratch();
  const { tv, recorder, lines } = recording({ ffmpeg: program(dir, COPY(join(dir, "args.json"))), kind: "phone", limits: { maxBytes: 4_096, checkMs: 50 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  const end = Date.now() + 4_000;
  let format = "png";
  for (let i = 0; !recorder.facts().ended && Date.now() < end; i += 1) {
    // Half way, the phone's frames change format: the bytes of the first file count toward the cap.
    if (i === 3) format = "jpeg";
    tv.show(frame(format, new Uint8Array(1_000)));
    await sleep(120);
  }
  assert.equal(recorder.facts().ended, "it reached its cap of 4096 bytes");
  assert.equal(lines.at(-1), "The recording of the phone stopped: it reached its cap of 4096 bytes. recordings/c1.mp4, recordings/c1-2.mp4 keep what was recorded until then.");
  await recorder.stop("ended");
});

test("ffmpeg's own end (a crash, a full disk) or no ffmpeg at all ends the recording with a line, and nothing throws", async () => {
  const dir = scratch();
  for (const [body, why] of [[CRASHES, "ffmpeg stopped (exit code 3)"], [DISK_FULL, "the disk is full"]]) {
    const { tv, recorder, lines } = recording({ ffmpeg: program(dir, body), kind: "phone" });
    await until(() => tv.watches.length === 1, "the recorder's watch");
    tv.show(frame("png", [1, 2, 3]));
    await until(() => recorder.facts().ended, why);
    assert.equal(recorder.facts().ended, why);
    assert.equal(lines.at(-1), `The recording of the phone stopped: ${why}. recordings/c1.mp4 keeps what was recorded until then.`);
    assert.equal(tv.watches[0].closed, true);
    await recorder.stop("released");
  }
  const { tv, recorder, lines } = recording({ ffmpeg: join(dir, "no-such-ffmpeg") });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("jpeg", [1]));
  await until(() => recorder.facts().ended, "the missing ffmpeg");
  assert.deepEqual(lines, ["The recording of the desktop stopped: ffmpeg isn't installed on this runner (no ffmpeg command on PATH)."]);
  assert.deepEqual(recorder.facts().files, []);
  await recorder.stop("ended");
});

test("a frame of another format ends the file and goes on in the next; fitted to 1280 on the long side, no audio; a park says it pauses, and the next recording takes the next file", async () => {
  const dir = scratch();
  const argsAt = join(dir, "args.json");
  const { tv, recorder, lines, folder } = recording({ ffmpeg: program(dir, COPY(argsAt)), kind: "phone" });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("png", [1, 2], 2560, 1600));
  await until(() => existsSync(argsAt), "the first file's ffmpeg");
  const first = JSON.parse(readFileSync(argsAt, "utf8"));
  assert.deepEqual(first.slice(first.indexOf("-f"), first.indexOf("-f") + 4), ["-f", "image2pipe", "-c:v", "png"]);
  assert.match(first[first.indexOf("-vf") + 1], /^scale=1280:800:/);
  assert.ok(first.includes("-an"), "no audio");
  assert.equal(first.at(-1), join(folder, "c1.mp4"));
  await sleep(150);
  tv.show(frame("jpeg", [3, 4], 1080, 2400));
  await until(() => readFileSync(argsAt, "utf8").includes("c1-2.mp4"), "the second file's ffmpeg");
  const second = JSON.parse(readFileSync(argsAt, "utf8"));
  assert.deepEqual(second.slice(second.indexOf("-f"), second.indexOf("-f") + 4), ["-f", "image2pipe", "-c:v", "mjpeg"]);
  assert.match(second[second.indexOf("-vf") + 1], /^scale=576:1280:/);
  assert.equal(second.at(-1), join(folder, "c1-2.mp4"));
  await recorder.stop("parked");
  assert.deepEqual(lines, [
    "Recording the phone's screen into recordings/c1.mp4.",
    "The phone's frames changed from PNG to JPEG: the recording goes on in recordings/c1-2.mp4.",
    "The recording of the phone pauses while the run is parked: it goes on in a new file when the run resumes.",
  ]);
  assert.deepEqual(readFileSync(join(folder, "c1.mp4")), Buffer.from([1, 2, 1, 2]), "the first file keeps its own frames only, its newest once more at the change, so it lasts until then");
  const resumed = recording({ ffmpeg: program(dir, COPY(argsAt)), kind: "phone", folder });
  await until(() => resumed.tv.watches.length === 1, "the resumed recorder's watch");
  resumed.tv.show(frame("jpeg", [5]));
  await until(() => readFileSync(argsAt, "utf8").includes("c1-3.mp4"), "the resumed file's ffmpeg");
  assert.deepEqual(resumed.recorder.facts().files, ["recordings/c1-3.mp4"]);
  await resumed.recorder.stop("ended");
  assert.deepEqual(readdirSync(folder).sort(), ["c1-2.mp4", "c1-3.mp4", "c1.mp4"]);
});

test("a stop during a change of format returns once the file before it is finished, and opens no next file", async () => {
  const dir = scratch();
  // Takes 300 ms to finish its file once its input ends, then leaves a mark beside it.
  const SLOW_END = "const fs = require(\"node:fs\"); const out = process.argv.at(-1); process.stdin.pipe(fs.createWriteStream(out)); process.stdin.on(\"end\", () => setTimeout(() => { fs.writeFileSync(`${out}.finished`, \"\"); process.exit(0); }, 300));";
  const { tv, recorder, folder } = recording({ ffmpeg: program(dir, SLOW_END), kind: "phone" });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("png", [1]));
  await until(() => recorder.facts().written === 1, "the first frame written");
  await sleep(150);
  tv.show(frame("jpeg", [2]));
  await recorder.stop("parked");
  assert.equal(existsSync(join(folder, "c1.mp4.finished")), true, "the PNG file's ffmpeg finished before the stop returned");
  assert.deepEqual(recorder.facts().files, ["recordings/c1.mp4"], "no JPEG file opened after the stop");
  assert.deepEqual(readdirSync(folder).sort(), ["c1.mp4", "c1.mp4.finished"]);
});

test("a watch that ends is opened again; one whose computer is gone ends the recording, said in words", async () => {
  const dir = scratch();
  const { tv, recorder, lines } = recording({ ffmpeg: program(dir, COPY(join(dir, "args.json"))), limits: { rewatchMs: 10 } });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  tv.show(frame("jpeg", [1]));
  await until(() => recorder.facts().files.length === 1, "the file");
  tv.watches[0].handlers.ended({ code: "unreachable", message: "the connection dropped" });
  await until(() => tv.watches.length === 2, "the watch opened again");
  assert.equal(recorder.facts().ended, undefined);
  tv.watches[1].handlers.ended({ code: "gone", message: "no computer c1" });
  await until(() => recorder.facts().ended, "the end");
  assert.equal(lines.at(-1), "The recording of the desktop stopped: the computer is gone. recordings/c1.mp4 keeps what was recorded until then.");
  await recorder.stop("ended");
});

test("playback: real frames through this machine's ffmpeg make an H.264 file ffprobe reads, frames and a duration, one per image format", async (t) => {
  if (!commandOnPath("ffprobe", process.env.PATH) || !commandOnPath("ffmpeg", process.env.PATH)) return t.skip("ffmpeg or ffprobe isn't on this machine's PATH: the playback check is skipped");
  // A phone's frames: PNG first, then JPEG, 1920x1080 (fitted to 1280x720).
  const { tv, recorder, folder } = recording({ kind: "phone" });
  await until(() => tv.watches.length === 1, "the recorder's watch");
  for (const [format, file] of [["png", "frame.png"], ["jpeg", "frame.jpg"]]) {
    const bytes = readFileSync(new URL(`../docker/${file}`, import.meta.url));
    for (let i = 1; i <= 8; i += 1) {
      tv.show(frame(format, bytes, 1920, 1080));
      await sleep(120);
    }
  }
  await recorder.stop("ended");
  assert.equal(recorder.facts().ended, undefined, JSON.stringify(recorder.facts()));
  assert.deepEqual(recorder.facts().files, ["recordings/c1.mp4", "recordings/c1-2.mp4"]);
  for (const name of ["c1.mp4", "c1-2.mp4"]) {
    const probed = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", join(folder, name)], { encoding: "utf8" }));
    const [stream] = probed.streams;
    assert.equal(stream.codec_name, "h264", name);
    assert.deepEqual([stream.width, stream.height], [1280, 720], name);
    assert.ok(Number(stream.nb_read_frames) > 0, `${name}: ${stream.nb_read_frames} frames`);
    assert.ok(Number(probed.format.duration) > 0, `${name}: ${probed.format.duration} s`);
  }
});
