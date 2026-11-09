// The run-side viewer of a desktop's or a phone's screen (computer-live.ts openComputerView), on the store's fake, a fake
// watch and a fake computer-hold: the endpoint is handed over under the run's claim (fenced: refused), speaks pi-browser's
// live-view protocol (hello, ready, frames acked one at a time, take and give, hold and status, held, refused, ended), lets
// input through toAction to the watch only while the person holds the computer, says a refusal in words, and ends with
// close (the row dropped). The token is in no row in plaintext, no log and no error. No clock: each wait is on a message.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect as tcp } from "node:net";
import { test } from "node:test";
import { computerViewerAssets } from "../dist/computer-viewer.js";
import { NOT_TAKEN, openComputerView, parseViewerMessage, viewerHoldOf } from "../dist/computer-live.js";
import { readLiveViewers } from "../dist/browser-live.js";
import { fakeHold, fakeWatch } from "./computer-live-support.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { fakeLiveViewersStore } from "./live-viewers-support.mjs";

const RUN = "run-1";
/** A test seal key, no real one. */
const KEY = randomBytes(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A desktop's view opened on the fake store, and its row as the server reads it. */
async function opened(t, { kind = "desktop", input = "desktop", tag = "cmp-desktop-1", hold = fakeHold(), watch = fakeWatch(), store = fakeLiveViewersStore(), claim } = {}) {
  const held = claim ?? store.claim(RUN);
  const result = await openComputerView({ store, sealKey: KEY, claim: held, kind, input, tag, watch: watch.watch, hold: hold.hold });
  assert.equal(result.ok, true, JSON.stringify(result));
  t.after(() => result.view.close("ended"));
  const [row] = await readLiveViewers(store, KEY, RUN);
  return { view: result.view, row, store, hold, watch, claim: held };
}
/** A viewer on the endpoint, from its own origin (as the server's proxy sends it), past its hello. */
async function viewerOf(row, { hello = true } = {}) {
  const c = await connect(`ws://127.0.0.1:${row.port}/v/${row.id}/ws`, { origin: `http://127.0.0.1:${row.port}` });
  assert.equal(c.status, 101);
  if (!hello) return c.ws;
  c.ws.sendJson({ type: "hello", token: row.token });
  const ready = JSON.parse((await c.ws.next(5_000)).data);
  return Object.assign(c.ws, { ready });
}
/** The next text message of `type`. */
const next = async (ws, type) => JSON.parse((await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, 5_000)).item?.data ?? "null");

test("the view is handed over under the claim: one row of its kind and tag, its token sealed, its endpoint on loopback; the viewer's hello gets ready with takeOver, and the watch starts", async (t) => {
  const { row, store, watch } = await opened(t);
  assert.deepEqual([row.kind, row.tag], ["desktop", "cmp-desktop-1"]);
  assert.match(row.id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(row.token, /^[A-Za-z0-9_-]{43}$/);
  for (const { v } of store.received) {
    assert.deepEqual(Object.keys(v).sort(), ["id", "kind", "port", "sealed", "tag"]);
    assert.ok(!Buffer.from(v.sealed).includes(row.token) && !JSON.stringify(v).includes(row.token), "the token is in no column in plaintext");
  }
  const ws = await viewerOf(row);
  assert.deepEqual(ws.ready, { type: "ready", drive: "agent", takeOver: true, held: false, kind: "desktop", input: "desktop" });
  await watch.opened();
  ws.destroy();
});

test("frames go one at a time: each [w][h][image] with the screen's real pixels, and the watch is acked only once the viewer acks", async (t) => {
  const { row, watch } = await opened(t);
  const ws = await viewerOf(row);
  await watch.opened();
  const acked = watch.push({ bytes: JPEG, width: 1920, height: 1080, frameWidth: 1280, frameHeight: 720 });
  const { item } = await ws.until((m) => m.type === "binary", 5_000);
  assert.deepEqual([item.data.readUInt16BE(0), item.data.readUInt16BE(2)], [1920, 1080], "the input space, not the image's");
  assert.deepEqual(item.data.subarray(4), JPEG);
  assert.equal(watch.state.acks, 0, "not acked before the viewer drew it");
  ws.sendJson({ type: "ack" });
  await acked;
  assert.equal(watch.state.acks, 1);
  // A PNG frame (a phone's) goes the same way, its bytes as they are.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const second = watch.push({ seq: 2, format: "png", bytes: png });
  assert.deepEqual((await ws.until((m) => m.type === "binary", 5_000)).item.data.subarray(4), png);
  ws.sendJson({ type: "ack" });
  await second;
  ws.destroy();
});

test("input outside the person's hold is answered held (Take over to drive.) and never sent; take reaches the hold, pending holds it too, and once the person holds it toAction's actions reach the watch; a refusal comes back in words", async (t) => {
  const { row, watch, hold } = await opened(t);
  const ws = await viewerOf(row);
  await watch.opened();
  const click = { type: "mouse", action: "down", x: 10, y: 20, button: 0, buttons: 1, clickCount: 1, modifiers: 0 };
  ws.sendJson(click);
  assert.deepEqual(await next(ws, "held"), { type: "held", reason: "not_taken", message: NOT_TAKEN });
  ws.sendJson({ type: "take" });
  assert.equal(await hold.nextCall(), "take");
  assert.deepEqual(await next(ws, "status"), { type: "status", drive: "pending" });
  ws.sendJson(click);
  assert.equal((await next(ws, "held")).reason, "taking", "pending: the agent's step is still ending");
  assert.deepEqual(watch.state.inputs, [], "nothing reached the computer");
  hold.grant();
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  const sent = watch.nextInput();
  ws.sendJson(click);
  assert.deepEqual(await sent, [{ type: "move", at: [10, 20] }, { type: "down", button: "left" }]);
  assert.ok(hold.calls.includes("touched"), "the hold heard the person's input");
  // A desktop takes no tap: refused in toAction's words, nothing sent.
  ws.sendJson({ type: "tap", x: 1, y: 2 });
  assert.deepEqual(await next(ws, "held"), { type: "held", reason: "refused", message: "a desktop takes the mouse, the wheel and keys, not a tap" });
  // The computer refusing the input says so, its words without a URL.
  watch.state.refuse = "the screen is locked at https://vendor.example/x?token=abc";
  ws.sendJson({ type: "key", action: "char", key: "a", code: "KeyA", text: "a", modifiers: 0 });
  const failed = await next(ws, "held");
  assert.equal(failed.reason, "failed");
  assert.ok(!failed.message.includes("https://") && !failed.message.includes("abc"), failed.message);
  assert.equal(watch.state.inputs.length, 2);
  ws.destroy();
});

test("give and the hold's own ends reach the viewer in the hold's words; the viewer gone mid-take is the hold's away", async (t) => {
  const { row, watch, hold } = await opened(t, { hold: fakeHold({ grant: true }) });
  const ws = await viewerOf(row);
  await watch.opened();
  ws.sendJson({ type: "take" });
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  const giving = hold.nextCall();
  ws.sendJson({ type: "give" });
  assert.equal(await giving, "give");
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: false, reason: "given" });
  // Taken again, then the hold ends on its own (idle), in its words.
  ws.sendJson({ type: "take" });
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  hold.emit({ state: "agent", ended: "idle", message: "no input came from you for 15 minutes" });
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: false, reason: "idle", message: "no input came from you for 15 minutes" });
  // Taken once more, and the viewer's socket goes: the hold's away.
  ws.sendJson({ type: "take" });
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  const away = hold.nextCall();
  ws.destroy();
  assert.equal(await away, "away");
  assert.ok(watch.state.closed >= 1, "the watch ends with the viewer");
});

test("one viewer per computer: a second is refused viewer_in_use; a wrong token is refused unauthorized; a foreign Origin or another path is never upgraded", async (t) => {
  const { row } = await opened(t);
  const first = await viewerOf(row);
  const second = await viewerOf(row, { hello: false });
  second.sendJson({ type: "hello", token: row.token });
  assert.deepEqual(await next(second, "refused"), { type: "refused", reason: "viewer_in_use" });
  const wrong = await viewerOf(row, { hello: false });
  wrong.sendJson({ type: "hello", token: "A".repeat(43) });
  assert.deepEqual(await next(wrong, "refused"), { type: "refused", reason: "unauthorized" });
  assert.equal((await connect(`ws://127.0.0.1:${row.port}/v/${row.id}/ws`, { origin: "http://evil.example" })).status, 403);
  assert.equal((await connect(`ws://127.0.0.1:${row.port}/v/${row.id}/ws`)).status, 403, "no Origin");
  assert.equal((await connect(`ws://127.0.0.1:${row.port}/v/AAAAAAAAAAAAAAAAAAAAAA/ws`, { origin: `http://127.0.0.1:${row.port}` })).status, 404);
  first.destroy();
});

test("close ends the viewer and drops the row; a computer that goes ends the viewer with why; a relaunch of the same tag ends the old viewer and replaces the row", async (t) => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  const a = await opened(t, { store, claim });
  const ws = await viewerOf(a.row);
  await a.watch.opened();
  // The computer went: the viewer is told, in words, and the page says "This computer has ended".
  a.watch.end("gone", "the computer is gone");
  assert.deepEqual(await next(ws, "ended"), { type: "ended", reason: "gone", message: "the computer is gone" });
  assert.match(computerViewerAssets.js, /gone: "This computer has ended\."/);
  // A relaunch: the same tag again replaces the row; a viewer of the old one is ended.
  const again = await viewerOf(a.row);
  const b = await opened(t, { store, claim });
  assert.equal((await next(again, "ended")).reason, "ended");
  assert.notEqual(b.row.id, a.row.id);
  assert.deepEqual((await readLiveViewers(store, KEY, RUN)).map((v) => v.id), [b.row.id], "one row, the new one's");
  // close: the viewer is told, the row goes, the endpoint stops.
  const last = await viewerOf(b.row);
  await b.view.close("released");
  assert.deepEqual(await next(last, "ended"), { type: "ended", reason: "released", message: "This computer was released." });
  assert.deepEqual(await readLiveViewers(store, KEY, RUN), [], "the row is dropped");
  await assert.rejects(new Promise((resolve, reject) => tcp(b.row.port, "127.0.0.1").once("connect", resolve).once("error", reject)), "nothing listens after close");
});

test("a stale claim is refused fenced: nothing handed over and nothing left listening; a bad tag and a kind that does not fit its input are refused before anything starts", async () => {
  const store = fakeLiveViewersStore();
  const stale = store.claim(RUN);
  store.claim(RUN);
  const result = await openComputerView({ store, sealKey: KEY, claim: stale, kind: "desktop", input: "desktop", tag: "cmp-1", watch: fakeWatch().watch, hold: fakeHold().hold });
  assert.equal(result.ok, false);
  assert.equal(result.refused, "fenced");
  assert.deepEqual(await readLiveViewers(store, KEY, RUN), []);
  const port = store.received[0].v.port;
  await assert.rejects(new Promise((resolve, reject) => tcp(port, "127.0.0.1").once("connect", resolve).once("error", reject)), "the endpoint closed");
  const claim = store.claim(RUN);
  assert.equal((await openComputerView({ store, sealKey: KEY, claim, kind: "desktop", input: "desktop", tag: "no spaces", watch: fakeWatch().watch, hold: fakeHold().hold })).refused, "bad_tag");
  assert.equal((await openComputerView({ store, sealKey: KEY, claim, kind: "phone", input: "desktop", tag: "cmp-1", watch: fakeWatch().watch, hold: fakeHold().hold })).refused, "kind");
  assert.equal((await openComputerView({ store, sealKey: KEY, claim, kind: "browser", input: "desktop", tag: "cmp-1", watch: fakeWatch().watch, hold: fakeHold().hold })).refused, "kind");
});

test("a phone takes taps, swipes, its buttons and keys while held; the token is in no log and no message the viewer or the store got", async (t) => {
  const writes = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (writes.push(String(chunk)), out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (writes.push(String(chunk)), err(chunk, ...rest));
  t.after(() => ((process.stdout.write = out), (process.stderr.write = err)));
  const { row, watch, store } = await opened(t, { kind: "phone", input: "android", tag: "cmp-phone-1", hold: fakeHold({ grant: true }) });
  const ws = await viewerOf(row);
  assert.equal(ws.ready.kind, "phone");
  await watch.opened();
  ws.sendJson({ type: "take" });
  await next(ws, "hold");
  const said = [];
  for (const [event, actions] of [
    [{ type: "tap", x: 5, y: 6 }, [{ type: "tap", at: [5, 6] }]],
    [{ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 400, ms: 250 }, [{ type: "swipe", path: [[1, 2], [3, 400]], ms: 250 }]],
    [{ type: "button", name: "recents" }, [{ type: "button", name: "app_switch" }]],
  ]) {
    const sent = watch.nextInput();
    ws.sendJson(event);
    assert.deepEqual(await sent, actions);
  }
  ws.sendJson({ type: "mouse", action: "down", x: 1, y: 1, button: 0, buttons: 1, clickCount: 1, modifiers: 0 });
  const refused = await next(ws, "held");
  said.push(JSON.stringify(refused));
  assert.equal(refused.message, "a phone takes taps, swipes, its buttons and keys, not the mouse");
  ws.sendJson({ type: "nonsense" });
  said.push(JSON.stringify(await next(ws, "held")));
  ws.destroy();
  for (const text of [...writes, ...said, JSON.stringify(store.received.map(({ v }) => ({ ...v, sealed: Buffer.from(v.sealed).toString("latin1") })))]) assert.ok(!text.includes(row.token), "no token");
});

test("the viewer's messages are checked field by field; viewerHoldOf drives tl-places' functions: take, give answering done, away with no outcome, the state and its changes", async () => {
  assert.equal(parseViewerMessage('{"type":"hello","token":"x","extra":1}'), null);
  assert.equal(parseViewerMessage('{"type":"mouse","action":"down","x":1e9,"y":0}'), null);
  assert.equal(parseViewerMessage('{"type":"button","name":"power"}'), null);
  assert.deepEqual(parseViewerMessage('{"type":"wheel","x":1,"y":2,"dx":0,"dy":120}'), { type: "wheel", x: 1, y: 2, dx: 0, dy: 120 });
  const asked = [];
  const listeners = [];
  const places = {
    computerHoldOf: (store, runId) => (asked.push(["state", store, runId]), "agent"),
    takeOverComputer: async (store, runId) => (asked.push(["take", store, runId]), { hold: "pending" }),
    handBackComputer: async (store, runId, options) => (asked.push(["handBack", store, runId, options]), { hold: "agent" }),
    onComputerHold: (runId, listener) => (listeners.push([runId, listener]), () => asked.push(["unsubscribed", runId])),
  };
  const hold = viewerHoldOf(places, "the-store", RUN);
  assert.equal(await hold.state(), "agent");
  assert.deepEqual(await hold.take(), { hold: "pending" });
  await hold.give();
  await hold.away();
  const off = hold.on(() => {});
  off();
  assert.deepEqual(asked, [["state", "the-store", RUN], ["take", "the-store", RUN], ["handBack", "the-store", RUN, { outcome: "done" }], ["handBack", "the-store", RUN, {}], ["unsubscribed", RUN]]);
  assert.equal(listeners[0][0], RUN);
});
