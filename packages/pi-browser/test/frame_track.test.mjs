// The export step that makes frame.track: a WebM per session from the recorded frames, with an index. The timeline is planned without ffmpeg;
// the encoding is checked with ffmpeg and ffprobe where they are installed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportFrameTracks, planTrack } from "@parcha/pi-browser/recorder";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const frame = (session, t, hash, w = 800, h = 500, conv = 3) => ({ channel: "live", source: "browser", kind: "frame", t, gen: 1, conv, data: { session, provider: "cdp", w, h, mime: "image/jpeg" }, blobs: [hash] });
const gap = (session, t, reason, from, detail, conv = 3) => ({ channel: "live", source: "browser", kind: "frame.gap", t, gen: 1, conv, data: { session, from, reason, ...(detail ? { detail } : {}) } });
const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("a track runs from the session's first frame to the end of the recording, each frame shown until the next one", () => {
  const plan = planTrack([frame("s1", 1000, "aa"), frame("s1", 1400, "bb"), frame("s1", 2600, "cc")], { fps: 10, endAt: 3000 });
  assert.deepEqual([plan.from, plan.to, plan.fps, plan.conv], [1000, 3000, 10, 3]);
  assert.deepEqual(plan.segments, [
    { start: 1000, end: 1400, sha256: "aa" },
    { start: 1400, end: 2600, sha256: "bb" },
    { start: 2600, end: 3000, sha256: "cc" },
  ]);
});

test("without an end, the last frame is shown for one frame's time, and a track of one frame has that length", () => {
  const plan = planTrack([frame("s1", 500, "aa")], { fps: 10 });
  assert.deepEqual([plan.from, plan.to], [500, 600]);
  assert.deepEqual(plan.segments, [{ start: 500, end: 600, sha256: "aa" }]);
});

test("a credential gap and a release gap show a slate from the moment they were written, until the next frame or the end; the frame before stays until then", () => {
  const plan = planTrack([frame("s1", 1000, "aa"), gap("s1", 2000, "credential_on_page", 1000, "field"), frame("s1", 3500, "bb"), gap("s1", 4200, "session_released", 3500)], { fps: 10, endAt: 5000 });
  assert.deepEqual(plan.segments, [
    { start: 1000, end: 2000, sha256: "aa" },
    { start: 2000, end: 3500, sha256: null, reason: "credential_on_page" },
    { start: 3500, end: 4200, sha256: "bb" },
    { start: 4200, end: 5000, sha256: null, reason: "session_released" },
  ]);
  assert.deepEqual(plan.gaps, [
    { from: 2000, to: 3500, reason: "credential_on_page", detail: "field" },
    { from: 4200, to: 5000, reason: "session_released" },
  ]);
});

test("a process_killed gap starts at the last frame the earlier process saved, not when the new process took the session up", () => {
  const plan = planTrack([frame("s1", 1000, "aa"), gap("s1", 6000, "process_killed", 1200), frame("s1", 6500, "bb")], { fps: 10, endAt: 7000 });
  assert.deepEqual(plan.segments, [
    { start: 1000, end: 1200, sha256: "aa" },
    { start: 1200, end: 6500, sha256: null, reason: "process_killed" },
    { start: 6500, end: 7000, sha256: "bb" },
  ]);
  assert.deepEqual(plan.gaps, [{ from: 1200, to: 6500, reason: "process_killed" }]);
});

test("a second gap while the slate is already up adds to the gap list and not to the slate", () => {
  const plan = planTrack([frame("s1", 1000, "aa"), gap("s1", 2000, "credential_on_page", 1000, "typed"), gap("s1", 2600, "session_released", 1000)], { fps: 10, endAt: 3000 });
  assert.deepEqual(plan.segments, [{ start: 1000, end: 2000, sha256: "aa" }, { start: 2000, end: 3000, sha256: null, reason: "credential_on_page" }]);
  assert.deepEqual(plan.gaps.map((g) => [g.from, g.to, g.reason]), [[2000, 2600, "credential_on_page"], [2600, 3000, "session_released"]]);
});

test("a session with no frame has no track; sessions are planned apart, and lines of other kinds are ignored", async () => {
  assert.equal(planTrack([gap("s1", 100, "session_released", 0)], { fps: 10 }), null);
  const out = await exportFrameTracks({ lines: [{ kind: "tool.call", t: 1 }, gap("s9", 10, "session_released", 0)], readBlob: () => null });
  assert.deepEqual(out, []);
});

test("a track's canvas is the largest frame, in even numbers, and every frame of the plan is listed with its offset into the video", () => {
  const plan = planTrack([frame("s1", 2000, "aa", 800, 445), frame("s1", 2300, "bb", 799, 500)], { fps: 10, endAt: 2600 });
  assert.deepEqual([plan.width, plan.height], [800, 500]);
  assert.deepEqual(plan.frames, [{ t: 2000, ms: 0, sha256: "aa", w: 800, h: 445 }, { t: 2300, ms: 300, sha256: "bb", w: 799, h: 500 }]);
});

/** A real JPEG: ffmpeg draws a test pattern of the size asked. */
function realJpeg(w, h, seed) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "track-jpg-")), "f.jpg");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${(0x203040 + seed * 0x101010).toString(16)}:s=${w}x${h}`, "-frames:v", "1", out]);
  const bytes = fs.readFileSync(out);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return bytes;
}
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames,r_frame_rate:format=format_name,duration", "-of", "json", file], { encoding: "utf8" }));

test("a session's frames become a WebM of the recording's own timeline and an index that names every frame and gap", { skip: !HAVE_FFMPEG && "ffmpeg and ffprobe are not installed", timeout: 120_000 }, async (t) => {
  const small = realJpeg(640, 400, 1), big = realJpeg(800, 500, 2), third = realJpeg(800, 500, 3);
  const blobs = new Map([[sha(small), small], [sha(big), big], [sha(third), third]]);
  const lines = [frame("s1", 1000, sha(small), 640, 400), frame("s1", 2000, sha(big)), gap("s1", 3000, "credential_on_page", 2000, "field"), frame("s1", 4000, sha(third)), frame("s2", 1500, sha(big), 800, 500, 4)];
  const out = await exportFrameTracks({ lines, readBlob: (hash) => blobs.get(hash) ?? null, fps: 10, endAt: 5000 });
  assert.deepEqual(out.map((o) => o.line.data.session), ["s1", "s2"]);
  const [s1] = out;
  assert.deepEqual([s1.line.kind, s1.line.channel, s1.line.source, s1.line.conv, s1.line.t], ["frame.track", "live", "browser", 3, 5000]);
  assert.deepEqual(s1.line.data, { session: "s1", fps: 10, from: 1000, to: 5000 });
  assert.deepEqual(s1.line.blobs, [s1.files.webm, s1.files.index]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-out-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const webm = s1.blobs[s1.files.webm];
  assert.equal(sha(webm), s1.files.webm, "the blob is named by its own hash");
  fs.writeFileSync(path.join(dir, "t.webm"), webm);
  const info = probe(path.join(dir, "t.webm"));
  assert.match(info.format.format_name, /webm/);
  assert.equal(info.streams[0].codec_name, "vp9");
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [800, 500], "the canvas is the largest frame");
  assert.equal(Number(info.streams[0].nb_read_frames), 40, "four seconds at ten frames a second");
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.15, `${info.format.duration} s`);
  const index = JSON.parse(Buffer.from(s1.blobs[s1.files.index]).toString("utf8"));
  assert.equal(sha(s1.blobs[s1.files.index]), s1.files.index);
  assert.deepEqual([index.version, index.session, index.fps, index.from, index.to, index.width, index.height], [1, "s1", 10, 1000, 5000, 800, 500]);
  assert.deepEqual(index.frames.map((f) => [f.t, f.ms, f.sha256]), [[1000, 0, sha(small)], [2000, 1000, sha(big)], [4000, 3000, sha(third)]]);
  assert.deepEqual(index.gaps, [{ from: 3000, to: 4000, reason: "credential_on_page", detail: "field" }]);
  assert.equal(s1.blobs[s1.files.webm].length > 0 && Object.keys(s1.blobs).length, 2, "exactly the video and the index");
});

test("a frame whose blob is missing or is not the JPEG it names is shown as the slate and reported, not encoded", { skip: !HAVE_FFMPEG && "ffmpeg and ffprobe are not installed", timeout: 120_000 }, async () => {
  const good = realJpeg(800, 500, 1);
  const lines = [frame("s1", 1000, sha(good)), frame("s1", 2000, "0".repeat(64)), frame("s1", 3000, sha(Buffer.from("not a jpeg")))];
  const out = await exportFrameTracks({ lines, readBlob: (hash) => (hash === sha(good) ? good : hash === sha(Buffer.from("not a jpeg")) ? Buffer.from("not a jpeg") : null), fps: 10, endAt: 4000 });
  const index = JSON.parse(Buffer.from(out[0].blobs[out[0].files.index]).toString("utf8"));
  assert.deepEqual(index.frames.map((f) => f.t), [1000], "only the frame that could be read is listed");
  assert.deepEqual(out[0].skipped.map((s) => [s.sha256.slice(0, 4), s.reason]), [["0000", "missing"], [sha(Buffer.from("not a jpeg")).slice(0, 4), "not_a_jpeg"]]);
});

test("ffmpeg that cannot run is a typed failure that names it, and nothing is written", { timeout: 60_000 }, async () => {
  const lines = [frame("s1", 1000, "aa")];
  await assert.rejects(exportFrameTracks({ lines, readBlob: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), ffmpeg: "/nonexistent/ffmpeg" }), (error) => error.name === "TrackExportError" && /ffmpeg/.test(error.message));
});

/** A program that stands in for ffmpeg: it records what it was started with and writes a file for the video. */
function stubFfmpeg(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-stub-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const program = path.join(dir, "ffmpeg");
  fs.writeFileSync(program, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(program, 0o755);
  return { program, dir };
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xf4, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]); // a start-of-frame for 800 x 500: enough for jpegSize
const stubLines = () => [frame("s1", 1000, sha(JPEG)), gap("s1", 1500, "credential_on_page", 1000, "field"), frame("s1", 2000, sha(JPEG))];

test("ffmpeg gets a short environment, its arguments are fixed, it reads only the files of a private directory, and that directory is gone after", async (t) => {
  process.env.PI_TRACK_TEST_SECRET = "sentinel-secret-value";
  t.after(() => { delete process.env.PI_TRACK_TEST_SECRET; });
  const seen = path.join(os.tmpdir(), `track-seen-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(seen, { recursive: true, force: true }));
  const stub = stubFfmpeg(t, `mkdir -p ${seen}; env > ${seen}/env; printf '%s\\n' "$@" > ${seen}/argv; pwd > ${seen}/cwd; cat list.txt > ${seen}/list; printf webm > out.webm`);
  const out = await exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program, fps: 10, endAt: 3000 });
  const env = fs.readFileSync(path.join(seen, "env"), "utf8");
  assert.deepEqual(env.trim().split("\n").map((l) => l.split("=")[0]).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "PWD"].filter((k) => env.includes(`${k}=`)).sort(), "PATH, LANG, LC_ALL and HOME, nothing of the host's");
  assert.doesNotMatch(env, /sentinel-secret-value|PI_TRACK_TEST_SECRET/);
  const argv = fs.readFileSync(path.join(seen, "argv"), "utf8").trim().split("\n");
  assert.deepEqual(argv.slice(0, 11), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt"]);
  assert.equal(argv.at(-1), "out.webm");
  assert.ok(argv.includes("-fps_mode") && argv[argv.indexOf("-fps_mode") + 1] === "cfr", "a constant frame rate");
  assert.ok(argv.includes("libvpx-vp9") && !argv.some((a) => /^[a-z]+:\/\//.test(a)), "VP9, and no URL among the arguments");
  const cwd = fs.readFileSync(path.join(seen, "cwd"), "utf8").trim();
  assert.match(path.basename(cwd), /^pib-track-/);
  assert.equal(fs.existsSync(cwd), false, "the private directory is removed");
  const list = fs.readFileSync(path.join(seen, "list"), "utf8");
  assert.equal(list.split("\n").filter((l) => l.startsWith("file ")).length, 4, "frame, slate, frame, and the last file named again");
  assert.match(list, /duration 0\.500\n/, "the first frame is shown for the half second before the gap");
  assert.equal(out[0].blobs[out[0].files.webm].length, 4);
});

test("ffmpeg that exits with an error is a typed failure that carries what it said", async (t) => {
  const stub = stubFfmpeg(t, "echo 'Invalid data found when processing input' >&2; exit 1");
  await assert.rejects(exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program }), (error) => error.name === "TrackExportError" && error.code === "ffmpeg_failed" && /Invalid data found/.test(error.message));
});

test("ffmpeg that does not finish in time is killed and reported, and the private directory is removed", async (t) => {
  const marker = path.join(os.tmpdir(), `track-hang-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const stub = stubFfmpeg(t, `pwd > ${marker}; exec sleep 30`);
  await assert.rejects(exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program, timeoutMs: 400 }), (error) => error.name === "TrackExportError" && error.code === "ffmpeg_timeout");
  assert.equal(fs.existsSync(fs.readFileSync(marker, "utf8").trim()), false);
});

test("an aborted export stops ffmpeg and says so", async (t) => {
  const stub = stubFfmpeg(t, "exec sleep 30");
  const controller = new AbortController();
  const running = exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(running, (error) => error.name === "TrackExportError" && error.code === "aborted");
});

test("lines handed over out of order are planned by their times", () => {
  const plan = planTrack([frame("s1", 2000, "bb"), gap("s1", 3000, "session_released", 2000), frame("s1", 1000, "aa")], { fps: 10, endAt: 3500 });
  assert.deepEqual(plan.segments, [{ start: 1000, end: 2000, sha256: "aa" }, { start: 2000, end: 3000, sha256: "bb" }, { start: 3000, end: 3500, sha256: null, reason: "session_released" }]);
});

test("a canvas of odd frames is rounded up to even numbers, which the encoder needs", () => {
  const plan = planTrack([frame("s1", 1000, "aa", 801, 501)], { fps: 10 });
  assert.deepEqual([plan.width, plan.height], [802, 502]);
});

test("a blob that is not the bytes its hash names is shown as the slate and reported as a mismatch, not encoded", async (t) => {
  const stub = stubFfmpeg(t, "printf webm > out.webm");
  const other = Buffer.from([...JPEG, 0x00]);
  const out = await exportFrameTracks({ lines: [frame("s1", 1000, sha(JPEG)), frame("s1", 2000, sha(other))], readBlob: (hash) => (hash === sha(other) ? JPEG : JPEG), ffmpeg: stub.program, fps: 10, endAt: 3000 });
  assert.deepEqual(out[0].skipped, [{ sha256: sha(other), reason: "hash_mismatch" }]);
  assert.deepEqual(out[0].index.frames.map((f) => f.t), [1000]);
});

test("ffmpeg that is killed on timeout is really gone: its process does not outlive the export", async (t) => {
  const pidFile = path.join(os.tmpdir(), `track-pid-${process.pid}-${Date.now()}`);
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} fs.rmSync(pidFile, { force: true }); });
  const stub = stubFfmpeg(t, `echo $$ > ${pidFile}; exec sleep 30`);
  await assert.rejects(exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program, timeoutMs: 300 }), (error) => error.code === "ffmpeg_timeout");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 40 && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })(); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the process is gone");
});

// ---- review findings ----

test("an export whose signal is already aborted never starts ffmpeg, and one aborted while a blob is being read ends aborted, ffmpeg not started", async (t) => {
  const marker = path.join(os.tmpdir(), `track-started-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const stub = stubFfmpeg(t, `: > ${marker}; printf webm > out.webm`);
  const early = new AbortController();
  early.abort();
  await assert.rejects(exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program, signal: early.signal }), (error) => error.name === "TrackExportError" && error.code === "aborted");
  assert.equal(fs.existsSync(marker), false, "ffmpeg was not started for an aborted export");
  const late = new AbortController();
  await assert.rejects(exportFrameTracks({ lines: stubLines(), readBlob: async () => { late.abort(); await new Promise((r) => setTimeout(r, 20)); return JPEG; }, ffmpeg: stub.program, signal: late.signal }), (error) => error.code === "aborted");
  assert.equal(fs.existsSync(marker), false, "ffmpeg was not started once the signal was aborted during a read");
});

test("without endAt a track runs to the end of the RECORDING, whatever kind of line is last, and that end is the same for every session", async (t) => {
  const stub = stubFfmpeg(t, "printf webm > out.webm");
  const lines = [frame("s1", 1000, sha(JPEG)), frame("s2", 2000, sha(JPEG), 800, 500, 4), { kind: "tool.call", t: 5000, conv: 3 }];
  const out = await exportFrameTracks({ lines, readBlob: () => JPEG, ffmpeg: stub.program, fps: 10 });
  assert.deepEqual(out.map((o) => [o.line.data.session, o.line.data.from, o.line.data.to, o.line.t]), [["s1", 1000, 5000, 5000], ["s2", 2000, 5000, 5000]]);
  assert.deepEqual(out[0].index.frames.map((f) => f.t), [1000]);
});

test("a session with hundreds of thousands of frames plans: no call passes every frame as an argument", () => {
  const lines = Array.from({ length: 250_000 }, (_, i) => frame("s1", 1000 + i * 100, "aa"));
  const plan = planTrack(lines, { fps: 10 });
  assert.equal(plan.frames.length, 250_000);
  assert.deepEqual([plan.width, plan.height], [800, 500]);
});

/** One pixel of the video's frame number `n` (counted from 0), as [r, g, b]. The crop is 2 x 2 because a 4:2:0 picture has no 1 x 1 chroma. */
const pixel = (file, n, x, y) => {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${n}),crop=2:2:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...out.subarray(0, 3)];
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 14);
/** The colour a picture shows after a JPEG round trip, read the way the tests read the video. */
const colourOf = (jpegBytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-col-"));
  fs.writeFileSync(path.join(dir, "p.jpg"), jpegBytes);
  const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, "p.jpg"), "-vf", "crop=2:2:2:2", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  fs.rmSync(dir, { recursive: true, force: true });
  return [...out.subarray(0, 3)];
};
const SLATE = [0x1f, 0x29, 0x33];

test("every picture of a track shows in the video as recorded, the first one too: a smaller frame keeps its size and is centred, the slate fills the canvas", { skip: !HAVE_FFMPEG && "ffmpeg and ffprobe are not installed", timeout: 120_000 }, async (t) => {
  const small = realJpeg(640, 400, 5), big = realJpeg(800, 500, 9);
  const lines = [frame("s1", 1000, sha(small), 640, 400), frame("s1", 2000, sha(big)), gap("s1", 3000, "session_released", 2000)];
  const [track] = await exportFrameTracks({ lines, readBlob: (hash) => (hash === sha(small) ? small : big), fps: 10, endAt: 4000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-px-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "t.webm");
  fs.writeFileSync(file, track.blobs[track.files.webm]);
  assert.ok(near(pixel(file, 3, 400, 250), colourOf(small)), `frame 3 shows the first, smaller picture: ${pixel(file, 3, 400, 250)} vs ${colourOf(small)}`);
  assert.ok(near(pixel(file, 3, 5, 5), SLATE), "the margin around a smaller frame is the slate colour: it is not enlarged");
  assert.ok(near(pixel(file, 3, 790, 490), SLATE) && near(pixel(file, 3, 20, 250), SLATE), "left of the 640-wide picture (20, 250) is margin too");
  assert.ok(near(pixel(file, 15, 5, 5), colourOf(big)) && near(pixel(file, 15, 400, 250), colourOf(big)), "the full-size frame fills the canvas");
  assert.ok(near(pixel(file, 25, 5, 5), SLATE) && near(pixel(file, 25, 790, 490), SLATE), "the slate fills the canvas");
});

test("pictures of another pixel layout (4:4:4, grayscale) are shown too: none is dropped when the layout changes", { skip: !HAVE_FFMPEG && "ffmpeg and ffprobe are not installed", timeout: 120_000 }, async (t) => {
  const make = (pixFmt, colour) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-fmt-"));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=800x500`, "-frames:v", "1", "-pix_fmt", pixFmt, path.join(dir, "p.jpg")]);
    const bytes = fs.readFileSync(path.join(dir, "p.jpg"));
    fs.rmSync(dir, { recursive: true, force: true });
    return bytes;
  };
  const a = make("yuvj444p", "0x305070"), b = make("yuvj420p", "0x703050"), c = make("gray", "0x808080");
  const lines = [frame("s1", 1000, sha(a)), frame("s1", 2000, sha(b)), frame("s1", 3000, sha(c))];
  const [track] = await exportFrameTracks({ lines, readBlob: (hash) => ({ [sha(a)]: a, [sha(b)]: b, [sha(c)]: c })[hash], fps: 10, endAt: 4000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-px-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "t.webm");
  fs.writeFileSync(file, track.blobs[track.files.webm]);
  for (const [n, jpeg] of [[3, a], [15, b], [25, c]]) assert.ok(near(pixel(file, n, 400, 250), colourOf(jpeg)), `frame ${n}: ${pixel(file, n, 400, 250)} vs ${colourOf(jpeg)}`);
});

test("two sessions that name the same missing blob each report it, once", async (t) => {
  const stub = stubFfmpeg(t, "printf webm > out.webm");
  const lines = [frame("s1", 1000, sha(JPEG)), frame("s1", 2000, "0".repeat(64)), frame("s1", 2500, "0".repeat(64)), frame("s2", 1000, sha(JPEG), 800, 500, 4), frame("s2", 2000, "0".repeat(64), 800, 500, 4)];
  const out = await exportFrameTracks({ lines, readBlob: (hash) => (hash === sha(JPEG) ? JPEG : null), ffmpeg: stub.program, fps: 10, endAt: 3000 });
  assert.deepEqual(out.map((o) => o.skipped), [[{ sha256: "0".repeat(64), reason: "missing" }], [{ sha256: "0".repeat(64), reason: "missing" }]]);
  assert.deepEqual(out.map((o) => o.index.frames.map((f) => f.t)), [[1000], [1000]]);
});

test("the pictures of a session are not held in memory while ffmpeg runs: they are on disk, and read one at a time", { timeout: 60_000 }, async (t) => {
  const v8 = await import("node:v8");
  const vm = await import("node:vm");
  v8.setFlagsFromString("--expose-gc");
  const collect = vm.runInNewContext("gc");
  const marker = path.join(os.tmpdir(), `track-mem-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const stub = stubFfmpeg(t, `: > ${marker}; sleep 1; printf webm > out.webm`);
  const refs = [];
  let inFlight = 0, peak = 0;
  const pictures = Array.from({ length: 30 }, (_, i) => Buffer.concat([JPEG, Buffer.from(`pic-${i}`)])); // the bytes after the JPEG's end marker make each picture's hash its own
  const byHash = new Map(pictures.map((bytes) => [sha(bytes), bytes]));
  /** A fresh buffer per read, tracked weakly: the test itself holds none of them. */
  const readBlob = async (hash) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    const copy = Buffer.from(byHash.get(hash));
    refs.push(new WeakRef(copy));
    inFlight -= 1;
    return copy;
  };
  const lines = pictures.map((bytes, i) => frame("s1", 1000 + i * 100, sha(bytes)));
  const running = exportFrameTracks({ lines, readBlob, ffmpeg: stub.program, fps: 10 });
  for (const end = Date.now() + 20_000; !fs.existsSync(marker) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(marker), "ffmpeg started");
  await new Promise((r) => setTimeout(r, 100));
  collect();
  const alive = refs.filter((ref) => ref.deref() !== undefined).length;
  assert.ok(alive <= 2, `${alive} of ${refs.length} pictures are still in memory while ffmpeg runs`);
  assert.equal(peak, 1, "one read at a time");
  await running;
});

test("an aborted export reads no more blobs: none for a signal aborted before it starts, none after the read that was under way", async (t) => {
  const stub = stubFfmpeg(t, "printf webm > out.webm");
  const a = Buffer.from([...JPEG, 1]), b = Buffer.from([...JPEG, 2]), c = Buffer.from([...JPEG, 3]);
  const blobs = new Map([[sha(a), a], [sha(b), b], [sha(c), c]]);
  const lines = [frame("s1", 1000, sha(a)), frame("s1", 2000, sha(b)), frame("s1", 3000, sha(c))];
  const early = new AbortController();
  early.abort();
  let reads = 0;
  await assert.rejects(exportFrameTracks({ lines, readBlob: (hash) => { reads += 1; return blobs.get(hash); }, ffmpeg: stub.program, signal: early.signal }), (error) => error.code === "aborted");
  assert.equal(reads, 0, "nothing is read for a signal aborted before the export starts");
  const during = new AbortController();
  reads = 0;
  await assert.rejects(exportFrameTracks({ lines, readBlob: (hash) => { reads += 1; during.abort(); return blobs.get(hash); }, ffmpeg: stub.program, signal: during.signal }), (error) => error.code === "aborted");
  assert.equal(reads, 1, "the read under way finished and no other was started");
});

// ---- review second round ----

test("timeoutMs is one deadline for a session's whole export: every ffmpeg call gets only the time that is left", async (t) => {
  // Three pictures that each need a padding call, the slate and the encode: five calls of about 0.4 s against a limit of 1.2 s.
  const stub = stubFfmpeg(t, "sleep 0.4; printf webm > out.webm");
  const pics = [1, 2, 3].map((n) => Buffer.from([...JPEG, n]));
  const lines = pics.map((bytes, i) => frame("s1", 1000 + i * 100, sha(bytes)));
  const blobs = new Map(pics.map((bytes) => [sha(bytes), bytes]));
  const began = Date.now();
  await assert.rejects(exportFrameTracks({ lines, readBlob: (hash) => blobs.get(hash), ffmpeg: stub.program, timeoutMs: 1200 }), (error) => error.name === "TrackExportError" && error.code === "ffmpeg_timeout");
  assert.ok(Date.now() - began < 2_400, `the export ended after ${Date.now() - began} ms, not after every call had its own 1.2 s`);
});

test("a picture whose header reads but that cannot be decoded is shown as the slate and reported as not_a_jpeg, and the other pictures still export", { skip: !HAVE_FFMPEG && "ffmpeg and ffprobe are not installed", timeout: 120_000 }, async (t) => {
  const good = realJpeg(800, 500, 4), other = realJpeg(800, 500, 8);
  const headerOnly = Buffer.from([...JPEG, 9]); // a start-of-frame that states 800 x 500 and no image data
  const lines = [frame("s1", 1000, sha(good)), frame("s1", 2000, sha(headerOnly)), frame("s1", 3000, sha(other))];
  const blobs = new Map([[sha(good), good], [sha(headerOnly), headerOnly], [sha(other), other]]);
  const [track] = await exportFrameTracks({ lines, readBlob: (hash) => blobs.get(hash), fps: 10, endAt: 4000 });
  assert.deepEqual(track.skipped, [{ sha256: sha(headerOnly), reason: "not_a_jpeg" }]);
  assert.deepEqual(track.index.frames.map((f) => f.t), [1000, 3000]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-bad-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "t.webm");
  fs.writeFileSync(file, track.blobs[track.files.webm]);
  assert.ok(near(pixel(file, 3, 400, 250), colourOf(good)), "the first picture shows");
  assert.ok(near(pixel(file, 15, 400, 250), SLATE), "the undecodable picture's time shows the slate");
  assert.ok(near(pixel(file, 25, 400, 250), colourOf(other)), "the last picture shows");
});

test("a track ends where the caller says the recording ended: a minimum length applies only to a track that would have none", () => {
  const plan = planTrack([frame("s1", 1000, "aa"), gap("s1", 4200, "session_released", 1000)], { fps: 10, endAt: 4250 });
  assert.equal(plan.to, 4250, "not extended by a frame's time");
  assert.deepEqual(plan.segments.at(-1), { start: 4200, end: 4250, sha256: null, reason: "session_released" });
  const sameEnd = planTrack([frame("s2", 2000, "bb"), gap("s2", 4200, "session_released", 2000)], { fps: 10, endAt: 4250 });
  assert.equal(sameEnd.to, plan.to, "every session ends where the recording does");
  const none = planTrack([frame("s3", 5000, "cc")], { fps: 10, endAt: 5000 });
  assert.deepEqual([none.from, none.to], [5000, 5100], "a track of no length is one frame long");
});

test("an encode that fails with every picture decoding is not tried a second time: the failure is reported as it was", async (t) => {
  const count = path.join(os.tmpdir(), `track-encodes-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(count, { force: true }));
  // The decode checks (-xerror) and the padding and slate calls succeed; the encode (it reads the concat list) fails.
  const stub = stubFfmpeg(t, `case "$*" in *concat*) echo x >> ${count}; echo 'Error while encoding' >&2; exit 1;; esac; printf x > out.webm; printf x > slate.jpg`);
  await assert.rejects(exportFrameTracks({ lines: stubLines(), readBlob: () => JPEG, ffmpeg: stub.program, fps: 10, endAt: 3000 }), (error) => error.code === "ffmpeg_failed" && /Error while encoding/.test(error.message));
  assert.equal(fs.readFileSync(count, "utf8").trim().split("\n").length, 1, "one encode attempt");
});
