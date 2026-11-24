// A run's screen recordings as the API serves them (run-recordings.ts): the run view's `recordings` (path, computer,
// seconds, bytes, finished), read from the files computer-record.ts writes beside work/; and the run files route serving
// them under recordings/, read-only, ranged, to the readers of the run's other files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { follow, runDir, serve, startRun } from "./support.mjs";

const { recordingsOf } = await import("../dist/run-recordings.js");
const { RECORDING_LIMITS, startRecording } = await import("../dist/computer-record.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { localWorkspace } = await import("../dist/workspace/index.js");
const { readRunFile } = await import("../dist/run-reads-over-store.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const u32 = (...ns) => {
  const bytes = Buffer.alloc(4 * ns.length);
  ns.forEach((n, i) => bytes.writeUInt32BE(n, 4 * i));
  return bytes;
};
const full = (version, flags) => u32(((version << 24) | flags) >>> 0);
const u64 = (n) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(n));
  return bytes;
};

/** 1970-01-01 in an MP4 header's seconds since 1904-01-01. */
const MP4_EPOCH_S = 2_082_844_800;

/** A fragmented MP4 as ffmpeg writes one (empty moov, a moof and mdat per fragment, each sample's duration in its trun, the
 *  mfra trailer at its end once finished): `fragments` is each fragment's sample durations, in units of `timescale`;
 *  `created` (ms) the start its header says, as computer-record.ts has ffmpeg write it. */
function fmp4(fragments, { timescale = 1000, finished = true, created } = {}) {
  const mvhd = created === undefined ? [] : [box("mvhd", full(0, 0), u32(MP4_EPOCH_S + Math.floor(created / 1000), MP4_EPOCH_S + Math.floor(created / 1000), 1000, 0), Buffer.alloc(80))];
  const moov = box("moov", ...mvhd, box("trak", box("mdia", box("mdhd", full(0, 0), u32(0, 0, timescale, 0, 0)))), box("mvex", box("trex", full(0, 0), u32(1, 1, 0, 0, 0))));
  const parts = [box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")), moov];
  let at = 0;
  for (const samples of fragments) {
    const trun = box("trun", full(0, 0x301), u32(samples.length, 0), u32(...samples.flatMap((d) => [d, 4])));
    parts.push(box("moof", box("traf", box("tfhd", full(0, 0x20000), u32(1)), box("tfdt", full(1, 0), u64(at)), trun)), box("mdat", Buffer.alloc(4 * samples.length, 7)));
    at += samples.reduce((a, b) => a + b, 0);
  }
  if (finished) parts.push(box("mfra", u32(16), box("mfro", full(0, 0), u32(16))));
  return Buffer.concat(parts);
}

const TAG = "0327421a8b52a0f5badfd67a085ff054c7c3753b978d019a525a8413898f114c";

test("recordingsOf lists each file: its computer, its seconds from its fragments, its bytes, and whether it is finished", async () => {
  const data = tempDir("agentrun-rec-");
  const folder = join(data, "rec");
  mkdirSync(folder);
  const first = fmp4([[500, 500, 1000], [2000]]);
  writeFileSync(join(folder, `${TAG}.mp4`), first);
  // The run's resume went on in -2, still being written: its trailer not there, its last box cut short.
  const going = fmp4([[1500]], { finished: false });
  writeFileSync(join(folder, `${TAG}-2.mp4`), Buffer.concat([going, box("moof", Buffer.alloc(40)).subarray(0, 20)]));
  // A computer whose own tag ends in -3, with no file of that name without it.
  writeFileSync(join(folder, "phone-3.mp4"), fmp4([[100]], { timescale: 100 }));
  writeFileSync(join(folder, "notes.txt"), "not a recording");
  const listed = await recordingsOf(folder, null);
  // A computer's files in the order it recorded them.
  assert.deepEqual(listed, [
    { path: `recordings/${TAG}.mp4`, computer: TAG, seconds: 4, bytes: first.length, finished: true },
    { path: `recordings/${TAG}-2.mp4`, computer: TAG, seconds: 1.5, bytes: going.length + 20, finished: false },
    { path: "recordings/phone-3.mp4", computer: "phone-3", seconds: 1, bytes: fmp4([[100]], { timescale: 100 }).length, finished: true },
  ]);
  // Right after the run's end its encoder still has the recorder's settle time to write the rest and its trailer.
  const long = 2 * RECORDING_LIMITS.settleMs + 1_000;
  assert.equal((await recordingsOf(folder, Date.now()))[1].finished, false);
  // A quiet screen's file, unchanged long before the end: the recorder stops at the computer's release, after the end is
  // saved, and its last frame and trailer come then. So the settle time counts from the end too.
  const quiet = (Date.now() - 10 * long) / 1000;
  utimesSync(join(folder, `${TAG}-2.mp4`), quiet, quiet);
  assert.equal((await recordingsOf(folder, Date.now()))[1].finished, false, "unchanged a long while, but the run just ended");
  // Past both, a file with no trailer is one whose encoder was cut: it plays to its last fragment, and is done.
  assert.equal((await recordingsOf(folder, Date.now() - long))[1].finished, true);
  assert.equal((await recordingsOf(folder, null))[1].finished, false, "the run going on: its encoder may only be quiet");
  // It grows: read on from where the last read stopped.
  writeFileSync(join(folder, `${TAG}-2.mp4`), fmp4([[1500], [500, 500]]));
  assert.deepEqual((await recordingsOf(folder, null))[1], { path: `recordings/${TAG}-2.mp4`, computer: TAG, seconds: 2.5, bytes: fmp4([[1500], [500, 500]]).length, finished: true });
  assert.deepEqual(await recordingsOf(join(data, "none"), null), [], "no folder: nothing recorded");
});

test("recordingsOf lists a run's computers in the order they recorded, not by name", async () => {
  const folder = tempDir("agentrun-rec-order-");
  // A run's desktop released at its question and a new one taken at its answer: the second's id sorts first by name.
  writeFileSync(join(folder, "faux-desktop-7.mp4"), fmp4([[1000]]));
  await sleep(20);
  writeFileSync(join(folder, "faux-desktop-17.mp4"), fmp4([[1000]]));
  assert.deepEqual((await recordingsOf(folder, null)).map((one) => one.computer), ["faux-desktop-7", "faux-desktop-17"]);
});

test("recordingsOf keeps a run's computers in the order they started while the first records on", async () => {
  const folder = tempDir("agentrun-rec-steady-");
  const first = join(folder, "browser-b.mp4");
  const second = join(folder, "browser-a.mp4");
  const order = async () => (await recordingsOf(folder, null)).map((one) => one.computer);
  // Two sessions recording at once: their headers say when each started, and the first's file changes after the second's.
  // The second's file is made first here, so its making (birth time) says the opposite of the headers.
  const start = Date.parse("2026-11-24T12:00:00Z");
  writeFileSync(second, fmp4([[1000]], { created: start + 5_000, finished: false }));
  await sleep(20);
  writeFileSync(first, fmp4([[1000]], { created: start, finished: false }));
  utimesSync(first, new Date(start + 60_000), new Date(start + 60_000));
  utimesSync(second, new Date(start + 6_000), new Date(start + 6_000));
  assert.deepEqual(await order(), ["browser-b", "browser-a"], "by the starts the headers say, not by name, making or last change");
  // With no start in their headers, the first read's making stands while a file grows.
  const plain = tempDir("agentrun-rec-plain-");
  writeFileSync(join(plain, "faux-desktop-7.mp4"), fmp4([[1000]], { finished: false }));
  await sleep(20);
  writeFileSync(join(plain, "faux-desktop-17.mp4"), fmp4([[1000]], { finished: false }));
  const plainOrder = async () => (await recordingsOf(plain, null)).map((one) => one.computer);
  assert.deepEqual(await plainOrder(), ["faux-desktop-7", "faux-desktop-17"]);
  await sleep(20);
  writeFileSync(join(plain, "faux-desktop-7.mp4"), fmp4([[1000], [1000]], { finished: false }));
  assert.deepEqual(await plainOrder(), ["faux-desktop-7", "faux-desktop-17"], "the first records on: it stays first");
});

test("recordingsOf reads ffmpeg's own fragmented MP4 the length ffprobe says", async (t) => {
  if (spawnSync("ffprobe", ["-version"]).status !== 0 || spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg and ffprobe aren't on this machine's PATH, so ffmpeg's own file isn't read here");
  const folder = tempDir("agentrun-rec-ffmpeg-");
  const file = join(folder, "desk.mp4");
  const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5", "-t", "5", "-an", "-c:v", "libx264", "-preset", "veryfast", "-fps_mode", "vfr", "-force_key_frames", "expr:gte(t,n_forced*2)", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", file]);
  assert.equal(made.status, 0, String(made.stderr));
  const probed = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).stdout.toString().trim());
  const [listed] = await recordingsOf(folder, null);
  assert.equal(listed.finished, true);
  assert.ok(Math.abs(listed.seconds - probed) <= 0.25, `${listed.seconds} s read, ${probed} s probed`);
  // An unchanged file (its size and change time as read) is not opened again: the same bytes of noise read as it did.
  const { mtime } = statSync(file);
  writeFileSync(file, Buffer.alloc(listed.bytes, 0x5a));
  utimesSync(file, mtime, mtime);
  assert.deepEqual(await recordingsOf(folder, null), [listed]);
});

test("a recording being written is on disk as it goes: a quiet screen's few frames reach the file in fragments, PNG and JPEG alike", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg isn't on this machine's PATH, so the recorder's own file isn't made here");
  const scratch = tempDir("agentrun-rec-live-");
  for (const [format, ext] of [["png", "png"], ["jpeg", "jpg"]]) {
    const images = [0, 1].map((i) => {
      const image = join(scratch, `f${i}.${ext}`);
      const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=1:duration=${i + 1}`, "-update", "1", "-y", image]);
      assert.equal(made.status, 0, String(made.stderr));
      return readFileSync(image);
    });
    let handlers;
    const watch = async (given) => {
      handlers = given;
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
    };
    const folder = join(scratch, `rec-${format}`);
    const recorder = startRecording({ watch, folder, tag: "c1", kind: "desktop", say: () => {}, log: () => {} });
    // Four frames a second, as a screen that changes now and then sends them: far fewer than ffmpeg's input probe or its
    // decoder's threads would hold back before writing anything.
    let listed;
    try {
      for (let i = 0; i < 40 && !(listed?.seconds > 0); i++) {
        await sleep(250);
        handlers?.frame({ seq: i + 1, format, bytes: new Uint8Array(images[i % 2]), width: 1280, height: 720, frameWidth: 1280, frameHeight: 720 }, () => {});
        [listed] = await recordingsOf(folder, null);
      }
      assert.ok(listed?.seconds > 0 && listed.bytes > 0, `${format}: the file read mid-recording: ${JSON.stringify(listed)}`);
      assert.equal(listed.finished, false, `${format}: still being written`);
    } finally {
      await recorder.stop("ended");
    }
    [listed] = await recordingsOf(folder, null);
    assert.equal(listed.finished, true, `${format}: ffmpeg wrote its trailer at the stop`);
    // Its header says when it started (mvhd's creation time), which orders a run's computers.
    const bytes = readFileSync(join(folder, "c1.mp4"));
    const mvhd = bytes.indexOf("mvhd", 0, "latin1");
    const started = (bytes.readUInt32BE(mvhd + 8) - MP4_EPOCH_S) * 1000;
    assert.ok(mvhd > 0 && Math.abs(Date.now() - started) < 5 * 60_000, `${format}: the header's start ${new Date(started).toISOString()}`);
  }
});

test("readRunFile refuses a withheld run's recording (403) before its recordings are opened", async () => {
  const store = await openSqliteStore({ file: join(tempDir("agentrun-rec-store-"), "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer.", tools: [] } });
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const folder = tempDir("agentrun-rec-withheld-");
  writeFileSync(join(folder, "desk.mp4"), fmp4([[1000]]));
  let opened = false;
  const deps = { env: {}, runWorkspace: async () => null, recordings: async () => { opened = true; return localWorkspace(folder); }, runFacts: async () => undefined, withheld: async () => true, context: BACKGROUND_CONTEXT };
  await assert.rejects(() => readRunFile(store, "run-1", "recordings/desk.mp4", {}, {}, new URL("http://x/"), deps), (e) => e.code === "forbidden");
  assert.equal(opened, false);
});

test("the run view lists a run's recordings, the files route serves one ranged and read-only, to the run's readers alone", async (t) => {
  const { api, data, baseUrl, token } = await serve(t);
  const { run_id } = await startRun(api, "plain", "Hello.");
  await follow(api, run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${run_id}`)).body.recordings, [], "an agent that doesn't record lists none");
  const bytes = fmp4([[1000, 1000], [1000]]);
  await mkdir(join(runDir(data, run_id), "recordings"));
  await writeFile(join(runDir(data, run_id), "recordings", `${TAG}.mp4`), bytes);
  // The agent's own folder of that name, in work/: the path is the run's recordings, so it is neither listed nor served.
  await mkdir(join(runDir(data, run_id), "work", "recordings"));
  await writeFile(join(runDir(data, run_id), "work", "recordings", "mine.txt"), "the agent's");
  const view = await api("GET", `/runs/${run_id}`);
  assert.deepEqual(view.body.recordings, [{ path: `recordings/${TAG}.mp4`, computer: TAG, seconds: 3, bytes: bytes.length, finished: true }]);
  const listed = (await api("GET", `/runs/${run_id}/files`)).body.files.map((f) => f.path);
  assert.ok(!listed.some((path) => path.startsWith("recordings")), JSON.stringify(listed));
  // A list reads no recording: the field is the run read's alone.
  const [inList] = (await api("GET", "/runs")).body.runs;
  assert.equal(inList.run_id, run_id);
  assert.equal("recordings" in inList, false, "a run in a list carries no recordings");

  const at = `${baseUrl}/runs/${run_id}/files/recordings/${TAG}.mp4`;
  const auth = { authorization: `Bearer ${token}` };
  const whole = await fetch(at, { headers: auth });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-disposition"), null, "inline, so a <video> plays it");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  const part = await fetch(at, { headers: { ...auth, range: "bytes=8-23" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 8-23/${bytes.length}`);
  assert.equal(part.headers.get("content-length"), "16");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(8, 24));
  const tail = await fetch(at, { headers: { ...auth, range: "bytes=-10" } });
  assert.deepEqual([tail.status, tail.headers.get("content-range")], [206, `bytes ${bytes.length - 10}-${bytes.length - 1}/${bytes.length}`]);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(-10));
  const past = await fetch(at, { headers: { ...auth, range: `bytes=${bytes.length}-` } });
  assert.deepEqual([past.status, past.headers.get("content-range"), (await past.json()).error.code], [416, `bytes */${bytes.length}`, "range_not_satisfiable"]);
  const download = await fetch(`${at}?download=1`, { headers: auth });
  assert.equal(download.headers.get("content-disposition"), `attachment; filename="${TAG}.mp4"`);
  await download.arrayBuffer();

  // Read-only: no write, no delete; the file is as it was.
  for (const method of ["PUT", "DELETE"]) {
    const refused = await fetch(at, { method, headers: auth, ...(method === "PUT" ? { body: "x" } : {}) });
    assert.equal(refused.status, 405, `${method}: ${refused.status}`);
    await refused.arrayBuffer();
  }
  assert.deepEqual(Buffer.from(await (await fetch(at, { headers: auth })).arrayBuffer()), bytes);
  // Another host-owned path is still 403, in words; the agent's own recordings/ file is not there; no reader, no file.
  const dotted = await fetch(`${baseUrl}/runs/${run_id}/files/.agents/x.md`, { headers: auth });
  assert.deepEqual([dotted.status, (await dotted.json()).error.code], [403, "system_file_forbidden"]);
  const mine = await fetch(`${baseUrl}/runs/${run_id}/files/recordings/mine.txt`, { headers: auth });
  assert.deepEqual([mine.status, (await mine.json()).error.code], [404, "not_found"]);
  const stranger = await fetch(at);
  assert.equal(stranger.status, 401);
  await stranger.arrayBuffer();
});
