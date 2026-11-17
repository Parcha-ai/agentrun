// A host's watch of a session's frames (LiveViewHost.watch, which serve's run video records) over a fake DevTools endpoint:
// it takes the frames with no viewer open, and each one is acked so the browser sends the next; a viewer and the watch
// share the session's one screencast, never a second one, and a viewer that joins it is sent the page and the newest frame;
// the stream ends once neither has it. A release ends the watch with no call; a browser socket cut under it calls `ended`.
import assert from "node:assert/strict";
import test from "node:test";
import { createDrivingGates } from "../dist/core/driving.js";
import { createLiveView } from "../dist/live-view/index.js";
import { decodeFrame } from "../dist/live-view/protocol.js";
import { fakeCdp, jpeg } from "./fixtures/fake-cdp.mjs";
import { connect } from "./fixtures/ws-client.mjs";

const VIEWER = { html: "<!doctype html>", js: "", css: "" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { for (let i = 0; i < ms / 10 && !check(); i += 1) await wait(10); return check(); };
const screencastsStarted = (fake) => fake.calls.filter((c) => c.method === "Page.startScreencast").length;

async function rig(t) {
  const fake = await fakeCdp({ pages: [{ id: "PAGE1", url: "https://one.example.test/" }] });
  t.after(() => fake.close());
  const host = createLiveView({ hostOrigin: "'self'", viewer: VIEWER, gates: createDrivingGates() });
  t.after(() => host.close());
  const view = await host.open("ar-run-w-1", fake.url);
  const seen = { frames: [], ended: 0 };
  const watcher = { frame: (bytes, page) => seen.frames.push({ tag: bytes[21], page }), ended: () => { seen.ended += 1; } };
  return { fake, host, view, seen, watcher };
}

async function viewerOf(view) {
  const u = new URL(view.fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  assert.equal(c.status, 101);
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  return c.ws;
}

test("a watch takes the session's frames with no viewer, each acked; a viewer that joins shares the one screencast and is sent the page and the newest frame; the stream ends once neither has it", async (t) => {
  const { fake, host, view, seen, watcher } = await rig(t);
  assert.equal(host.watch("ar-run-unknown", watcher), null, "no view, no watch");
  const unwatch = host.watch("ar-run-w-1", watcher);
  assert.ok(await until(() => fake.screencasts().length === 1), "the watch alone starts the screencast");
  assert.ok(fake.frame({ bytes: jpeg(800, 500, 0, 1) }));
  assert.ok(await until(() => seen.frames.length === 1 && fake.acks.length === 1), "the frame reached the watch and was acked with no viewer");
  assert.deepEqual(seen.frames[0], { tag: 1, page: { w: 1280, h: 800 } });

  const ws = await viewerOf(view);
  const { item: frame, seen: before } = await ws.until((m) => m.type === "binary");
  assert.ok(frame, "the joining viewer is sent the newest frame");
  assert.equal(decodeFrame(frame.data).jpeg[21], 1);
  const said = before.filter((m) => m.type === "text").map((m) => JSON.parse(m.data).type);
  assert.deepEqual(said, ["ready", "page"], "and the page shown, after its ready");
  assert.equal(fake.clients(), 1, "one DevTools socket for the watch and the viewer");
  assert.equal(screencastsStarted(fake), 1, "one screencast, never a second");

  assert.ok(fake.frame({ bytes: jpeg(800, 500, 0, 2) }));
  const { item: next } = await ws.until((m) => m.type === "binary");
  assert.equal(decodeFrame(next.data).jpeg[21], 2, "the viewer has the next frame");
  assert.ok(await until(() => seen.frames.length === 2 && fake.acks.length === 2), "so has the watch, and it was acked");

  unwatch();
  assert.ok(fake.frame({ bytes: jpeg(800, 500, 0, 3) }));
  const { item: third } = await ws.until((m) => m.type === "binary");
  assert.equal(decodeFrame(third.data).jpeg[21], 3, "the viewer goes on alone");
  assert.equal(seen.frames.length, 2, "the watch has stopped");
  assert.equal(fake.screencasts().length, 1);

  ws.destroy();
  assert.ok(await until(() => fake.clients() === 0), "with neither, the stream ends");
  assert.equal(seen.ended, 0);
});

test("a release ends a watch with no call; a DevTools socket cut under a watch calls ended once", async (t) => {
  const { fake, host, seen, watcher } = await rig(t);
  host.watch("ar-run-w-1", watcher);
  assert.ok(await until(() => fake.screencasts().length === 1));
  fake.cut();
  assert.ok(await until(() => seen.ended === 1), "the socket's end is told");
  await wait(50);
  assert.equal(seen.ended, 1, "once");

  const again = await rig(t);
  again.host.watch("ar-run-w-1", again.watcher);
  assert.ok(await until(() => again.fake.screencasts().length === 1));
  await again.host.release("ar-run-w-1");
  assert.ok(await until(() => again.fake.clients() === 0), "the release ends the stream");
  await wait(50);
  assert.equal(again.seen.ended, 0, "a release is the host's own: no call");
  assert.equal(again.host.watch("ar-run-w-1", again.watcher), null, "a released session takes no watch");
});
