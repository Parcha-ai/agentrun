// The frame recorder against a fake DevTools endpoint: what it asks the browser for, which frames become lines, and when it writes
// a gap instead. The lines are agentrun.recording/1's browser rows.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { frameRecorder, jpegSize } from "@parcha/pi-browser/recorder";
import { fakeCdp, jpeg } from "./fixtures/fake-cdp.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 4000) => { for (const end = Date.now() + ms; !check(); await sleep(10)) if (Date.now() > end) throw new Error("timed out"); };
const TOKEN = "LIVE-VIEW-TOKEN-SENTINEL-0001";

/** A provider over the fake endpoint: `attach` hands its debugger URL, with a token in it as Browserbase's carries one. */
function fakeProvider(cdp, { name = "cdp" } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls, name,
    caps: { timeoutModel: "wall-clock", maxLifetimeS: 600, survivesDisconnect: true, releaseIsAsync: false, extension: "loaded-locally" },
    async create(spec) { calls.push("create"); return { id: `sess-${(n += 1)}`, tag: spec.tag }; },
    async attach() { calls.push("attach"); return { sdkCdpUrl: `${cdp.url}?apiKey=${TOKEN}` }; },
    async release() { calls.push("release"); },
    async status() { return "running"; },
    async findByTag() { return []; },
    async liveView() { calls.push("liveView"); return { fullscreen: `https://live.example.test/view?token=${TOKEN}`, framed: null, pages: [] }; },
  };
}

async function rig(t, { pages, ...options } = {}) {
  const cdp = await fakeCdp(pages ? { pages } : {});
  t.after(() => cdp.close());
  const lines = [];
  const blobs = new Map();
  const started = Date.now();
  const frames = frameRecorder({
    sink: (line, bytes = {}) => { lines.push(line); for (const [hash, data] of Object.entries(bytes)) blobs.set(hash, data); },
    clock: () => Date.now() - started,
    gen: () => 1,
    ...options,
  });
  t.after(() => frames.close());
  const provider = fakeProvider(cdp);
  const watched = frames.watch(provider, 7);
  const spec = { tag: "ar-run-7-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1280, height: 800 }, metadata: {} };
  return { cdp, lines, blobs, frames, provider, watched, spec, started, kinds: () => lines.map((l) => l.kind) };
}

/** Creates a session and attaches to it, as the durable adapter does, and waits until the recorder is attached to a page. */
async function open(r) {
  const ref = await r.watched.create(r.spec, new AbortController().signal);
  await r.watched.attach(ref, new AbortController().signal);
  await until(() => r.cdp.screencasts().length === 1);
  return ref;
}

test("a session's frames become frame lines: the recording's shape, the JPEG as a content-addressed blob, no seq", async (t) => {
  const r = await rig(t);
  const ref = await open(r);
  const bytes = jpeg(800, 500, 300, 1);
  assert.ok(r.cdp.frame({ bytes }));
  await until(() => r.lines.length === 1);
  const [line] = r.lines;
  assert.deepEqual(Object.keys(line).sort(), ["blobs", "channel", "conv", "data", "gen", "kind", "source", "t"]);
  assert.deepEqual([line.channel, line.source, line.kind, line.conv, line.gen], ["live", "browser", "frame", 7, 1]);
  assert.deepEqual(line.data, { session: ref.id, provider: "cdp", w: 800, h: 500, mime: "image/jpeg" });
  assert.deepEqual(line.blobs, [sha(bytes)]);
  assert.ok(Number.isInteger(line.t) && line.t >= 0 && line.t < 5000);
  assert.deepEqual(r.blobs.get(sha(bytes)), new Uint8Array(bytes), "the bytes arrive beside the line, under their hash");
  assert.equal("seq" in line, false, "ordering across live lines is the writer's");
});

test("the dimensions are the JPEG's own, not the page's", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(640, 417) });
  await until(() => r.lines.length === 1);
  assert.deepEqual([r.lines[0].data.w, r.lines[0].data.h], [640, 417]);
});

test("the browser is asked for JPEG at quality 60, at most 800 px wide, and every frame is acknowledged", async (t) => {
  const r = await rig(t);
  await open(r);
  const [params] = r.cdp.screencasts();
  assert.equal(params.format, "jpeg");
  assert.equal(params.quality, 60);
  assert.ok(params.maxWidth <= 800 && params.maxWidth > 0, String(params.maxWidth));
  for (let i = 0; i < 12; i += 1) r.cdp.frame({ bytes: jpeg(800, 500, 100, i) });
  await until(() => r.cdp.acks.length === 12);
});

test("at most 10 frames a second, and the newest frame always lands", async (t) => {
  const r = await rig(t);
  await open(r);
  const began = Date.now();
  let last;
  for (let i = 0; i < 80; i += 1) { last = jpeg(800, 500, 50, i + 1); r.cdp.frame({ bytes: last }); await sleep(10); }
  const spent = Date.now() - began;
  await sleep(250);
  const frames = r.lines.filter((l) => l.kind === "frame");
  assert.ok(frames.length <= Math.ceil((spent / 1000) * 10) + 2, `${frames.length} frames in ${spent} ms`);
  assert.ok(frames.length >= 3, "it kept sampling");
  for (let i = 1; i < frames.length; i += 1) assert.ok(frames[i].t - frames[i - 1].t >= 85, `frames ${frames[i - 1].t} and ${frames[i].t} ms apart`);
  assert.equal(frames.at(-1).blobs[0], sha(last), "the last frame sent is the last frame kept");
});

test("releasing the session ends the capture and writes a session_released gap from the last frame", async (t) => {
  const r = await rig(t);
  const ref = await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  await r.watched.release(ref, new AbortController().signal);
  await until(() => r.lines.length === 2);
  const [frame, gap] = r.lines;
  assert.equal(gap.kind, "frame.gap");
  assert.deepEqual(gap.data, { session: ref.id, from: frame.t, reason: "session_released" });
  assert.deepEqual([gap.channel, gap.source, gap.conv, gap.gen], ["live", "browser", 7, 1]);
  assert.ok(gap.t >= frame.t);
  assert.deepEqual(r.provider.calls.filter((c) => c === "release"), ["release"], "the provider's own release still ran");
  await until(() => r.cdp.clients() === 0);
  assert.equal(r.cdp.frame(), false, "nothing is attached any more");
});

test("a session this process did not create, whose earlier frames the host knows of, starts with a process_killed gap from the last of them", async (t) => {
  const asked = [];
  const r = await rig(t, { lastFrameAt: (session) => { asked.push(session); return 21_004; } });
  const ref = { id: "sess-from-before", tag: "ar-run-7-1" };
  await r.watched.attach(ref, new AbortController().signal);
  await until(() => r.lines.length === 1);
  assert.deepEqual(asked, ["sess-from-before"]);
  const [gap] = r.lines;
  assert.deepEqual([gap.kind, gap.data], ["frame.gap", { session: "sess-from-before", from: 21_004, reason: "process_killed" }]);
  assert.equal(gap.conv, 7);
  await until(() => r.cdp.screencasts().length === 1);
  r.cdp.frame();
  await until(() => r.lines.length === 2);
  assert.equal(r.lines[1].kind, "frame", "frames follow on the same session");
});

test("a session with no earlier frames starts with no gap, and an attach the process already holds is not a second capture", async (t) => {
  const r = await rig(t, { lastFrameAt: () => null });
  const ref = { id: "sess-new-to-recording", tag: "ar-run-7-1" };
  await r.watched.attach(ref, new AbortController().signal);
  await r.watched.attach(ref, new AbortController().signal);
  await until(() => r.cdp.screencasts().length === 1);
  await sleep(100);
  assert.deepEqual(r.lines, []);
  assert.equal(r.cdp.clients(), 1, "one socket for the session");
});

test("a field holding a credential pauses the capture: a credential_on_page gap, no frame, until the next navigation", async (t) => {
  const r = await rig(t);
  const ref = await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  const before = r.lines[0];
  r.cdp.state.secret = true;
  await sleep(120);
  for (let i = 0; i < 5; i += 1) { r.cdp.frame({ bytes: jpeg(800, 500, 10, 10 + i) }); await sleep(120); }
  const gaps = r.lines.filter((l) => l.kind === "frame.gap");
  assert.equal(gaps.length, 1, "one gap line for the whole pause");
  assert.deepEqual(gaps[0].data, { session: ref.id, from: before.t, reason: "credential_on_page", detail: "field" });
  assert.equal(r.lines.filter((l) => l.kind === "frame").length, 1, "no frame is kept while it is there");
  // A subframe's navigation is not the page's, even once the field holds nothing: only the page's own navigation lifts the pause.
  r.cdp.state.secret = false;
  r.cdp.navigateSubframe("PAGE1", "https://widget.example.test/");
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 20) });
  await sleep(150);
  assert.equal(r.lines.filter((l) => l.kind === "frame").length, 1, "still paused");
  r.cdp.navigate("PAGE1", "https://example.test/next");
  await sleep(50);
  const resumed = jpeg(800, 500, 10, 30);
  r.cdp.frame({ bytes: resumed });
  await until(() => r.lines.filter((l) => l.kind === "frame").length === 2);
  assert.equal(r.lines.at(-1).blobs[0], sha(resumed));
});

test("a navigation that leaves a credential on the page does not lift the pause", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  r.cdp.state.secret = true;
  await sleep(120);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await until(() => r.kinds().includes("frame.gap"));
  r.cdp.navigate("PAGE1", "https://example.test/two-factor");
  await sleep(50);
  for (let i = 0; i < 3; i += 1) { r.cdp.frame({ bytes: jpeg(800, 500, 10, 40 + i) }); await sleep(120); }
  assert.deepEqual(r.kinds(), ["frame", "frame.gap"]);
});

test("the host can pause a session itself (a code entered, a setup key shown), and resume it", async (t) => {
  const r = await rig(t);
  const ref = await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  r.frames.pause(ref.id);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await sleep(200);
  assert.deepEqual(r.kinds(), ["frame", "frame.gap"]);
  assert.deepEqual([r.lines[1].data.reason, r.lines[1].data.detail], ["credential_on_page", "host"]);
  r.frames.resume(ref.id);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 3) });
  await until(() => r.kinds().length === 3);
  assert.equal(r.kinds()[2], "frame");
});

test("a page that cannot be checked for a credential is not recorded", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.state.evaluateError = true;
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await sleep(250);
  assert.deepEqual(r.lines, [], "no check, no frame");
  r.cdp.state.evaluateError = false;
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await until(() => r.lines.length === 1);
});

test("the capture follows the page the agent is using: a new page, not the one it left", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ page: "PAGE1", bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  r.cdp.newPage("PAGE2", "https://example.test/popup");
  await until(() => r.cdp.screencasts().length === 1 && r.cdp.calls.filter((c) => c.method === "Page.startScreencast").length === 2);
  await sleep(150);
  r.cdp.frame({ page: "PAGE1", bytes: jpeg(800, 500, 10, 2) });
  const popup = jpeg(800, 500, 10, 3);
  r.cdp.frame({ page: "PAGE2", bytes: popup });
  await until(() => r.lines.length === 2);
  assert.equal(r.lines[1].blobs[0], sha(popup));
});

test("the recording names no live-view URL, no debugger URL and no key: the provider's live view is never asked for", async (t) => {
  const r = await rig(t);
  const ref = await open(r);
  r.cdp.frame();
  await until(() => r.lines.length === 1);
  await r.watched.release(ref, new AbortController().signal);
  await until(() => r.lines.length === 2);
  const everything = JSON.stringify(r.lines);
  for (const secret of [TOKEN, "live.example.test", String(r.cdp.port), "apiKey", "ws://"]) assert.equal(everything.includes(secret), false, secret);
  assert.equal(r.provider.calls.includes("liveView"), false);
});

test("a sink that throws or rejects never fails a browser call, and a session's conversation is read from its lease tag when none is given", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  let asked = 0;
  const convs = [];
  const frames = frameRecorder({ sink: (line) => { convs.push(line.conv); asked += 1; if (asked === 1) throw new Error("disk full"); return Promise.reject(new Error("later")); }, clock: () => 5 });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp));
  const ref = await watched.create({ tag: "ar-some-run-12-3" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  for (let i = 0; i < 3; i += 1) { cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(120); }
  await until(() => asked >= 2);
  await watched.release(ref, new AbortController().signal);
  assert.ok(convs.length >= 2 && convs.every((c) => c === 12), `conversations ${convs}`);
});

test("a session whose conversation cannot be told is not recorded: every line must carry one", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const lines = [];
  const frames = frameRecorder({ sink: (line) => { lines.push(line); }, clock: () => 0 });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp));
  const ref = await watched.create({ tag: "no-conversation-here" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await sleep(200);
  assert.equal(cdp.clients(), 0, "no socket was opened");
  assert.deepEqual(lines, []);
});

test("closing the recorder closes every capture, and frames after it are not kept", async (t) => {
  const r = await rig(t);
  await open(r);
  await r.frames.close();
  await until(() => r.cdp.clients() === 0);
  r.cdp.frame();
  await sleep(150);
  assert.deepEqual(r.lines, []);
});

test("the provider the recorder wraps is the one the host passed: everything but create, attach and release is its own", async (t) => {
  const r = await rig(t);
  assert.equal(r.watched.name, "cdp");
  assert.equal(r.watched.caps, r.provider.caps);
  assert.equal(await r.watched.status({ id: "x", tag: "y" }), "running");
  assert.deepEqual(await r.watched.findByTag("y"), []);
});

test("a connection the network cut is taken up again, and frames follow", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  r.cdp.cut();
  await until(() => r.cdp.clients() === 0);
  await until(() => r.cdp.clients() === 1 && r.cdp.screencasts().length === 1, 6000);
  const again = jpeg(800, 500, 10, 2);
  r.cdp.frame({ bytes: again });
  await until(() => r.lines.length === 2);
  assert.equal(r.lines[1].blobs[0], sha(again));
});

test("several sessions at once are captured apart: each line names its own session and conversation, and the rate is each session's own", async (t) => {
  const endpoints = await Promise.all([1, 2, 3].map(() => fakeCdp()));
  t.after(() => Promise.all(endpoints.map((e) => e.close())));
  const lines = [];
  const frames = frameRecorder({ sink: (line) => { lines.push(line); }, clock: () => Date.now() % 1_000_000 });
  t.after(() => frames.close());
  const byId = new Map();
  const provider = {
    name: "browserbase", caps: {},
    async create(spec) { const ref = { id: `bb_${spec.tag}`, tag: spec.tag }; byId.set(ref.id, endpoints[byId.size]); return ref; },
    async attach(ref) { return { sdkCdpUrl: byId.get(ref.id).url }; },
    async release() {},
  };
  const watched = frames.watch(provider);
  const refs = [];
  for (const [i, cid] of [11, 12, 13].entries()) { const ref = await watched.create({ tag: `ar-run-${cid}-1` }, new AbortController().signal); await watched.attach(ref, new AbortController().signal); refs.push(ref); await until(() => endpoints[i].screencasts().length === 1); }
  for (let round = 0; round < 3; round += 1) { for (const e of endpoints) e.frame({ bytes: jpeg(800, 500, 20, round) }); await sleep(120); }
  await until(() => lines.length >= 9);
  for (const [i, cid] of [11, 12, 13].entries()) {
    const mine = lines.filter((l) => l.data.session === refs[i].id);
    assert.ok(mine.length >= 3, `session ${i}: ${mine.length} lines`);
    assert.ok(mine.every((l) => l.conv === cid && l.data.provider === "browserbase"));
  }
  assert.equal(frames.stats().sessions, 3);
});

test("it never asks for more than 800 px or more than 10 frames a second, whatever the host passes", async (t) => {
  const r = await rig(t, { maxWidth: 1600, maxFps: 60 });
  await open(r);
  assert.ok(r.cdp.screencasts()[0].maxWidth <= 800);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  for (let i = 0; i < 20; i += 1) { r.cdp.frame({ bytes: jpeg(800, 500, 10, 2 + i) }); await sleep(10); }
  await sleep(300);
  const frames = r.lines.filter((l) => l.kind === "frame");
  for (let i = 1; i < frames.length; i += 1) assert.ok(frames[i].t - frames[i - 1].t >= 85, `${frames[i].t - frames[i - 1].t} ms apart`);
});

test("a sink that never answers costs frames, not the capture: each line waits its turn for sinkTimeoutMs, then counts as dropped", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const frames = frameRecorder({ sink: () => new Promise(() => {}), clock: () => 0, sinkTimeoutMs: 150 });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 3);
  const ref = await watched.create({ tag: "ar-run-3-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  for (let i = 0; i < 12; i += 1) { cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(120); }
  await until(() => frames.stats().dropped >= 2, 6000);
  assert.equal(frames.stats().frames, 0, "no frame was saved");
});

test("when frames of one spacing arrive together, the newest is the one kept", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  const newest = jpeg(800, 500, 10, 3);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await sleep(5);
  r.cdp.frame({ bytes: newest });
  await sleep(300);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[1].blobs[0], sha(newest));
});

test("a page that takes longer to check than the spacing still gives at most 10 frames a second", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.state.evaluateDelayMs = 150;
  for (let i = 0; i < 40; i += 1) { r.cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(20); }
  await sleep(400);
  const frames = r.lines.filter((l) => l.kind === "frame");
  assert.ok(frames.length >= 2);
  for (let i = 1; i < frames.length; i += 1) assert.ok(frames[i].t - frames[i - 1].t >= 85, `${frames[i].t - frames[i - 1].t} ms apart`);
});

test("a session created by this process is not a resumed one, whatever the host knows of earlier frames", async (t) => {
  const r = await rig(t, { lastFrameAt: () => 9_000 });
  await open(r);
  await sleep(100);
  assert.deepEqual(r.lines, []);
});

test("a release by a process that never captured the session ends the tile where an earlier process's frames stopped", async (t) => {
  const r = await rig(t, { lastFrameAt: (session) => (session === "sess-earlier" ? 33_000 : null) });
  await r.watched.release({ id: "sess-earlier", tag: "ar-run-7-1" }, new AbortController().signal);
  await until(() => r.lines.length === 1);
  assert.deepEqual(r.lines.map((l) => [l.kind, l.conv, l.data]), [["frame.gap", 7, { session: "sess-earlier", from: 33_000, reason: "session_released" }]]);
  await r.watched.release({ id: "sess-never-framed", tag: "ar-run-7-2" }, new AbortController().signal);
  assert.equal(r.lines.length, 1, "a session with no earlier frames has no tile to end");
});

test("a page whose title changes is not the page the agent moved to", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.navigate("PAGE1", "https://example.test/one");
  await sleep(100);
  r.cdp.newPage("PAGE2", "https://example.test/popup");
  await until(() => r.cdp.calls.filter((c) => c.method === "Page.startScreencast").length === 2);
  await sleep(100);
  r.cdp.infoChanged("PAGE1");
  await sleep(150);
  assert.equal(r.cdp.calls.filter((c) => c.method === "Page.startScreencast").length, 2, "the capture stayed on the popup");
  const popup = jpeg(800, 500, 10, 5);
  r.cdp.frame({ page: "PAGE2", bytes: popup });
  await until(() => r.lines.length === 1);
  assert.equal(r.lines[0].blobs[0], sha(popup));
});

test("jpegSize reads the size a JPEG states: baseline or progressive, after tables; a non-JPEG states none", async () => {
  const sof = (marker, w, h) => Buffer.from([0xff, marker, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03]);
  const soi = Buffer.from([0xff, 0xd8]);
  assert.deepEqual(jpegSize(Buffer.concat([soi, sof(0xc0, 640, 480)])), { w: 640, h: 480 });
  assert.deepEqual(jpegSize(Buffer.concat([soi, sof(0xc2, 800, 417)])), { w: 800, h: 417 }, "progressive");
  assert.deepEqual(jpegSize(Buffer.concat([soi, dht, sof(0xc1, 320, 200)])), { w: 320, h: 200 }, "after a table segment");
  assert.equal(jpegSize(Buffer.concat([soi, dht])), null);
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});


for (const [what, pages] of [
  ["listed first", [{ id: "REAL", url: "https://example.test/moving" }, { id: "BLANK", url: "about:blank" }]],
  ["listed last", [{ id: "BLANK", url: "about:blank" }, { id: "REAL", url: "https://example.test/moving" }]],
]) {
  test(`a browser whose real page is ${what} among its pages is recorded on the real page, not the blank one`, async (t) => {
    const r = await rig(t, { pages });
    const ref = await r.watched.create(r.spec, new AbortController().signal);
    await r.watched.attach(ref, new AbortController().signal);
    await until(() => r.cdp.screencasts().length === 1);
    const real = jpeg(800, 500, 10, 7);
    assert.equal(r.cdp.frame({ page: "BLANK", bytes: jpeg(800, 500, 10, 6) }), false, "the blank page is not captured");
    assert.ok(r.cdp.frame({ page: "REAL", bytes: real }));
    await until(() => r.lines.length === 1);
    assert.equal(r.lines[0].blobs[0], sha(real));
  });
}

test("a blank page becomes the one in use when it is moved to an address, and the one a popup opened is not left for the blank one", async (t) => {
  const r = await rig(t, { pages: [{ id: "BLANK", url: "about:blank" }] });
  const ref = await r.watched.create(r.spec, new AbortController().signal);
  await r.watched.attach(ref, new AbortController().signal);
  await until(() => r.cdp.screencasts().length === 1);
  r.cdp.newPage("POPUP", "https://example.test/popup");
  await until(() => r.cdp.calls.filter((c) => c.method === "Page.startScreencast").length === 2);
  r.cdp.newPage("EMPTY", "about:blank");
  await sleep(150);
  assert.equal(r.cdp.calls.filter((c) => c.method === "Page.startScreencast").length, 2, "a new blank page does not take the capture from a page at an address");
  r.cdp.destroyPage("POPUP");
  await until(() => r.cdp.calls.filter((c) => c.method === "Page.startScreencast").length === 3);
});

test("a frame whose page moved on before it was kept is not kept: it belongs to the page it showed", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  r.cdp.navigate("PAGE1", "https://example.test/next");
  await sleep(300);
  assert.equal(r.lines.length, 1, "the held frame was of the page before the navigation");
  const after = jpeg(800, 500, 10, 3);
  r.cdp.frame({ bytes: after });
  await until(() => r.lines.length === 2);
  assert.equal(r.lines[1].blobs[0], sha(after));
});

test("a frame held while the capture moved to another page is not kept", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ page: "PAGE1", bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  r.cdp.frame({ page: "PAGE1", bytes: jpeg(800, 500, 10, 2) });
  r.cdp.newPage("PAGE2", "https://example.test/popup");
  await sleep(300);
  assert.equal(r.lines.length, 1);
});

test("a page whose content cannot be checked (nested past what the probe reads) is not recorded and does not pause", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.state.unchecked = true;
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await sleep(250);
  assert.deepEqual(r.lines, [], "no check, no frame, no gap");
  r.cdp.state.unchecked = false;
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await until(() => r.lines.length === 1);
});

test("a release the provider refuses ends nothing: the capture goes on and no gap is written; the release that succeeds ends it", async (t) => {
  const r = await rig(t);
  const ref = await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  let refuse = true;
  const real = r.provider.release;
  r.provider.release = async (...args) => { if (refuse) throw new Error("Browserbase refused the release"); return real.apply(r.provider, args); };
  await assert.rejects(r.watched.release(ref, new AbortController().signal), /refused/);
  assert.deepEqual(r.kinds(), ["frame"], "no session_released gap");
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await until(() => r.lines.length === 2);
  assert.equal(r.lines[1].kind, "frame", "frames still come");
  refuse = false;
  await r.watched.release(ref, new AbortController().signal);
  await until(() => r.lines.length === 3);
  assert.deepEqual([r.lines[2].kind, r.lines[2].data.reason], ["frame.gap", "session_released"]);
});

test("a write that fails is not a frame saved: it is counted as dropped, and the next gap starts at the last frame that was saved", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const saved = [];
  let n = 0;
  const frames = frameRecorder({
    sink: (line) => { n += 1; if (line.kind === "frame" && n === 2) throw new Error("disk full"); if (line.kind === "frame" && n === 3) return Promise.reject(new Error("later")); saved.push(line); },
    clock: () => Date.now() % 1_000_000,
  });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 4);
  const ref = await watched.create({ tag: "ar-run-4-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  for (let i = 0; i < 3; i += 1) { cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(130); }
  await until(() => frames.stats().dropped === 2);
  assert.equal(saved.length, 1);
  assert.equal(frames.stats().dropped, 2);
  assert.equal(frames.stats().frames, saved.length);
  const lastSaved = saved.filter((l) => l.kind === "frame").at(-1);
  frames.pause(ref.id);
  await until(() => saved.some((l) => l.kind === "frame.gap"));
  assert.equal(saved.find((l) => l.kind === "frame.gap").data.from, lastSaved.t);
});

test("lines reach the sink one at a time and in order, a gap after the frame it follows even when it is made while that frame is being written", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const order = [];
  let inFlight = 0;
  let most = 0;
  const frames = frameRecorder({ sink: async (line) => { inFlight += 1; most = Math.max(most, inFlight); await sleep(250); order.push(line.kind); inFlight -= 1; }, clock: () => 0 });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 4);
  const ref = await watched.create({ tag: "ar-run-4-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => cdp.calls.filter((c) => c.method === "Runtime.evaluate").length === 2);
  await sleep(50); // the frame is being written now
  frames.pause(ref.id);
  await until(() => order.length === 2, 4000);
  assert.deepEqual(order, ["frame", "frame.gap"]);
  assert.equal(most, 1, "never two writes at once");
});

const evaluated = (r) => r.cdp.calls.filter((c) => c.method === "Runtime.evaluate").length;

test("a frame is judged twice: when it arrives, against the page it was captured from, and again when its turn to be kept comes", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  assert.equal(evaluated(r), 2, "one check at capture, one at delivery");
  // A second frame arrives inside the spacing: it is judged at once, and kept later.
  const before = evaluated(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await sleep(70);
  assert.equal(evaluated(r), before + 1, "judged on arrival");
  assert.equal(r.lines.length, 1, "and not kept yet");
  await until(() => r.lines.length === 2);
  assert.equal(evaluated(r), before + 2);
});

for (const [what, answers, detail] of [
  ["a credential on the page when the frame arrived, gone by the time it would be kept", [{ hold: true, why: "field" }, { hold: false, why: null }], "field"],
  ["a credential typed and cleared between the frame's capture and its being kept", [{ hold: false, why: null }, { hold: true, why: "typed" }], "typed"],
]) {
  test(`${what}: the frame is dropped and the capture paused`, async (t) => {
    const r = await rig(t);
    const ref = await open(r);
    r.cdp.state.answers.push(...answers);
    r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
    await until(() => r.kinds().includes("frame.gap"), 3000);
    await sleep(250);
    assert.deepEqual(r.kinds(), ["frame.gap"], "no frame");
    assert.deepEqual(r.lines[0].data, { session: ref.id, from: r.lines[0].t, reason: "credential_on_page", detail });
  });
}

for (const why of ["too_deep", "unreadable_frame"]) {
  test(`a page the check cannot read (${why}) counts as a credential being present: no frame, a credential_on_page gap that says why`, async (t) => {
    const r = await rig(t);
    const ref = await open(r);
    r.cdp.state.secret = true;
    r.cdp.state.why = why;
    r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
    await until(() => r.lines.length === 1);
    await sleep(250);
    assert.deepEqual(r.lines.map((l) => [l.kind, l.data.reason, l.data.detail]), [["frame.gap", "credential_on_page", why]]);
    assert.equal(r.lines[0].data.session, ref.id);
  });
}

test("a check that answers with something that is not a verdict is not a clean page", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.state.answers.push("yes", 3, null, {});
  for (let i = 0; i < 4; i += 1) { r.cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(130); }
  assert.deepEqual(r.lines, []);
});

test("a verdict that is not one, when the frame's turn comes, is not a clean page", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.state.answers.push({ hold: false, why: null }, "garbage");
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await sleep(350);
  assert.deepEqual(r.lines, [], "judged clean at capture, unreadable at delivery: not kept");
});

test("a frame judged clean when it arrived is not kept once the page has navigated before its turn", async (t) => {
  const r = await rig(t);
  await open(r);
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => r.lines.length === 1);
  const before = r.cdp.calls.filter((c) => c.method === "Runtime.evaluate").length;
  r.cdp.frame({ bytes: jpeg(800, 500, 10, 2) });
  await until(() => r.cdp.calls.filter((c) => c.method === "Runtime.evaluate").length === before + 1);
  r.cdp.navigate("PAGE1", "https://example.test/moved-on");
  await sleep(350);
  assert.equal(r.lines.length, 1, "it was judged on arrival, and the page moved before its turn");
});

test("closing the recorder waits for the line the sink is writing", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const written = [];
  let started = false;
  const frames = frameRecorder({ sink: async (line) => { started = true; await sleep(300); written.push(line.kind); }, clock: () => 0 });
  const watched = frames.watch(fakeProvider(cdp), 4);
  const ref = await watched.create({ tag: "ar-run-4-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => started);
  await frames.close();
  assert.deepEqual(written, ["frame"]);
});

/** A clock that only moves when a wait is asked of it, and a wait that ends late, on time, or early in turn (a loaded box's timers): what a check of the page is paced by in these tests. */
function jitteryClock({ late = 30, early = 10 } = {}) {
  let now = 0, n = 0;
  return { now: () => now, sleep: async (ms) => { n += 1; now += n % 3 === 1 ? ms + late : n % 3 === 2 ? ms : Math.max(0, ms - early); } };
}
/** No more than `n` of these (a sorted list of times in ms) in any half-open window of one second. */
const atMostPerSecond = (times, n = 20) => { for (let i = 0; i + n < times.length; i += 1) assert.ok(times[i + n] - times[i] >= 1000, `${n + 1} probes within ${(times[i + n] - times[i]).toFixed(1)} ms: ${times.slice(i, i + n + 1).map((x) => x.toFixed(0)).join(" ")}`); };

for (const [what, secret] of [["frames that are kept", false], ["frames of a page with a credential on it", true]]) {
  test(`a flood of frames, ${what}, with waits that end late, on time and early: no 1 s window holds more than 20 checks of the page, arrival and delivery together (a virtual clock, so the load of the box cannot move it)`, async (t) => {
    const probes = [];
    const r = await rig(t, { probeClock: jitteryClock(), onProbe: (at) => probes.push(at) });
    await open(r);
    r.cdp.state.secret = secret;
    const began = Date.now();
    while (Date.now() - began < 2500) { r.cdp.frame({ bytes: jpeg(800, 500, 10, 1) }); await sleep(3); }
    await sleep(300);
    assert.ok(probes.length >= 40, `${probes.length} checks`);
    for (let i = 1; i < probes.length; i += 1) assert.ok(probes[i] - probes[i - 1] >= 50, `two checks ${(probes[i] - probes[i - 1]).toFixed(1)} ms apart`);
    atMostPerSecond(probes);
    if (!secret) assert.ok(r.lines.filter((l) => l.kind === "frame").length >= 3, "the budget does not starve the capture");
  });
}

test("a write that outlasts sinkTimeoutMs is dropped and counted, but no other write starts until it ends: lines reach storage in order, one at a time", async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const events = [];
  let active = 0, maxActive = 0, n = 0;
  const frames = frameRecorder({
    clock: () => 0, sinkTimeoutMs: 150,
    sink: async (line) => {
      const id = (n += 1);
      active += 1; maxActive = Math.max(maxActive, active);
      events.push(`start ${id} ${line.kind}`);
      await sleep(id === 1 ? 500 : 5); // the first write is slow, far past the timeout
      events.push(`end ${id}`);
      active -= 1;
    },
  });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 3);
  const ref = await watched.create({ tag: "ar-run-3-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  for (let i = 0; i < 8; i += 1) { cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(110); }
  await sleep(700);
  assert.equal(maxActive, 1, "never two writes at once");
  assert.equal(events[0], "start 1 frame");
  assert.equal(events[1], "end 1", "nothing starts before the slow write has ended");
  assert.ok(frames.stats().dropped >= 1, "the slow write was counted as dropped");
});

test("a sink that never answers leaves one unfinished write, not one per line", { timeout: 30_000 }, async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  let started = 0;
  const frames = frameRecorder({ clock: () => 0, sinkTimeoutMs: 100, sink: () => { started += 1; return new Promise(() => {}); } });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 3);
  const ref = await watched.create({ tag: "ar-run-3-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  for (let i = 0; i < 12; i += 1) { cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(120); }
  await until(() => frames.stats().dropped >= 3, 6000);
  assert.equal(started, 1, "the write that never ends is the only one started");
});

test("releasing a session does not wait for storage: the provider's release returns while the sink is still silent, and close() waits a bounded time", { timeout: 30_000 }, async (t) => {
  const r = await rig(t, { sink: () => new Promise(() => {}), sinkTimeoutMs: 600, lastFrameAt: () => 9_000 });
  const ref = await r.watched.create(r.spec, new AbortController().signal);
  await r.watched.attach(ref, new AbortController().signal);
  await until(() => r.cdp.screencasts().length === 1);
  const began = Date.now();
  await r.watched.release(ref, new AbortController().signal);
  assert.ok(Date.now() - began < 300, `release took ${Date.now() - began} ms`);
  // a release made by a process that never captured the session is no different
  const other = Date.now();
  await r.watched.release({ id: "sess-earlier", tag: "ar-run-7-1" }, new AbortController().signal);
  assert.ok(Date.now() - other < 300, "the later-process release does not wait either");
  const closing = Date.now();
  await r.frames.close();
  assert.ok(Date.now() - closing < 3000, `close took ${Date.now() - closing} ms against a sink that never answers`);
});

test("a line whose turn comes after its timeout is not written: the sink gets the lines that are still wanted, not the backlog", { timeout: 30_000 }, async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let started = 0, opened = false, startedAfterOpen = 0;
  const frames = frameRecorder({ clock: () => 0, sinkTimeoutMs: 150, sink: async () => { started += 1; if (opened) startedAfterOpen += 1; if (started === 1) await gate; } });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 3);
  const ref = await watched.create({ tag: "ar-run-3-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  // The first write is stuck while frames keep coming; every line made behind it is older than the timeout by the time the write ends, except the last one or two.
  for (let i = 0; i < 14; i += 1) { cdp.frame({ bytes: jpeg(800, 500, 10, i) }); await sleep(100); }
  assert.ok(frames.stats().dropped >= 4, `${frames.stats().dropped} dropped while the write was stuck`);
  opened = true;
  open();
  await sleep(400);
  assert.ok(startedAfterOpen <= 2, `${startedAfterOpen} writes started after the stuck one ended: the backlog was written`);
});

test("lines made while a write is stuck wait in a bounded queue: past 32 they are dropped at once, not held until their timeouts", { timeout: 30_000 }, async (t) => {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  const frames = frameRecorder({ clock: () => 0, sinkTimeoutMs: 3_000, sink: () => new Promise(() => {}) });
  t.after(() => frames.close());
  const watched = frames.watch(fakeProvider(cdp), 3);
  const ref = await watched.create({ tag: "ar-run-3-1" }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  for (let i = 0; i < 40; i += 1) { frames.resume(ref.id); frames.pause(ref.id); } // each pause writes one gap line
  assert.ok(frames.stats().dropped >= 8, `${frames.stats().dropped} dropped at once`);
});
