// The frame recorder and the live view composed, as a host wires them: recorder.watch(liveViewProvider(provider, host)) with hold: (ref) => host.driving(ref.tag).
// A person driving through the viewer (real server, real WebSocket, input messages) yields zero stored frames and one gap; the frames come back when they stop, and a page that
// does not repaint after the person's last input is still captured once, on demand. The viewer's stream is a stub (the stream is tested against Chrome apart); the driving gate is
// core/driving.ts's own with a short quiet window, so the test does not wait out the host's default three seconds.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { frameRecorder } from "@parcha/pi-browser/recorder";
import { createLiveView, liveViewProvider } from "../dist/live-view/index.js";
import { createDrivingGates } from "../dist/core/driving.js";
import { connect } from "./fixtures/ws-client.mjs";
import { fakeCdp, jpeg } from "./fixtures/fake-cdp.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 4000) => { for (const end = Date.now() + ms; !check(); await sleep(10)) if (Date.now() > end) throw new Error("timed out"); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const QUIET_MS = 400;

/** One session recorded while a person drives it through the viewer. `withHold` wires the host's hold as a host does; `repaintAfter` says whether the page changes once the person has stopped; `shot` is what a one-off capture of the page answers. */
async function drive(t, { withHold, tag, repaintAfter = true, shot = null }) {
  const cdp = await fakeCdp();
  t.after(() => cdp.close());
  if (shot) cdp.state.screenshot = shot;
  const host = createLiveView({ hostOrigin: "https://app.example", stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }), gates: createDrivingGates({ idleMs: QUIET_MS }), viewer: { html: "<!doctype html>", js: "", css: "" } });
  t.after(() => host.close());
  const lines = [];
  const started = Date.now();
  const recorder = frameRecorder({ sink: (line) => { lines.push(line); }, clock: () => Date.now() - started, gen: () => 1, ...(withHold ? { hold: (ref) => host.driving(ref.tag) } : {}) });
  t.after(() => recorder.close());
  const provider = {
    name: "cdp", caps: {},
    async create(spec) { return { id: "sess-1", tag: spec.tag }; },
    async attach() { return { sdkCdpUrl: cdp.url }; },
    async release() {}, async status() { return "running"; }, async findByTag() { return []; },
  };
  const watched = recorder.watch(liveViewProvider(provider, host), 7);
  const ref = await watched.create({ tag }, new AbortController().signal);
  await watched.attach(ref, new AbortController().signal);
  await until(() => cdp.screencasts().length === 1);
  const frames = () => lines.filter((l) => l.kind === "frame");
  const gaps = () => lines.filter((l) => l.kind === "frame.gap");
  const shots = () => cdp.calls.filter((c) => c.method === "Page.captureScreenshot");

  // Nobody is driving: a frame is stored.
  cdp.frame({ bytes: jpeg(800, 500, 10, 1) });
  await until(() => frames().length === 1);

  // A person opens the viewer and drives: input every 100 ms while the page keeps changing.
  const view = await host.open(tag, cdp.url);
  const u = new URL(view.fullscreen);
  const token = new URLSearchParams(u.hash.slice(1)).get("t");
  u.hash = "";
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  assert.equal(c.status, 101);
  c.ws.sendJson({ type: "hello", token });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  const stored = frames().length;
  for (let i = 0; i < 12; i += 1) {
    c.ws.sendJson({ type: "mouse", action: "move", x: 10 + i, y: 20 });
    await sleep(40);
    cdp.frame({ bytes: jpeg(800, 500, 10, 100 + i) });
    await sleep(60);
  }
  assert.equal(host.driving(tag), true, "the person is the driver");
  const during = { stored, frames: frames().length, gaps: gaps().map((g) => g.data), shots: shots().length };

  // The person stops: after the quiet window the host's gate says idle. The page then repaints (the next screencast frame is stored), or it does not (one capture is taken on demand).
  await until(() => !host.driving(tag), 3000);
  if (repaintAfter) { cdp.frame({ bytes: jpeg(800, 500, 10, 200) }); await until(() => frames().length > during.frames); }
  else await until(() => frames().length > during.frames, 5000);
  await sleep(700);
  const after = { frames: frames().length, gaps: gaps().length, shots: shots().length, last: frames().at(-1) };
  c.ws.destroy();
  return { during, after };
}

test("a person driving through the live view yields zero stored frames and one host gap; frames return when the input stops", async (t) => {
  const { during, after } = await drive(t, { withHold: true, tag: "ar-run-7-1" });
  assert.equal(during.frames, during.stored, "no frame of a session a person is driving is stored");
  assert.equal(during.gaps.length, 1, "one gap for the whole span");
  assert.deepEqual([during.gaps[0].reason, during.gaps[0].detail], ["credential_on_page", "host"]);
  assert.equal(after.frames, during.stored + 1, "the next frame after the quiet window is stored");
  assert.equal(after.gaps, 1);
});

test("the control: the same session driven the same way without the host's hold stores the person's frames, so the rig sees what the hold removes", async (t) => {
  const { during } = await drive(t, { withHold: false, tag: "ar-run-7-2" });
  assert.ok(during.frames > during.stored + 3, `${during.frames - during.stored} frames stored while the person drove`);
  assert.equal(during.gaps.length, 0);
});

test("when the person stops and the page does not repaint, the replay does not end at their hold: one frame is captured on demand, the page as it is", async (t) => {
  const shot = jpeg(800, 500, 77, 9);
  const { during, after } = await drive(t, { withHold: true, tag: "ar-run-7-3", repaintAfter: false, shot });
  assert.equal(during.frames, during.stored, "nothing of the person's span is stored");
  assert.equal(during.shots, 0, "no capture is asked for while the person drives");
  assert.equal(after.frames, during.stored + 1, "one frame follows the hold");
  assert.equal(after.last.blobs[0], sha(shot), "it is the capture of the page, not a screencast frame");
  assert.equal(after.shots, 1, "one capture for the span, not one per poll");
  assert.equal(after.gaps, 1);
});
