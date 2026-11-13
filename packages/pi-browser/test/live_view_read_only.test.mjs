// A read-only live view (LiveViewOptions.readOnly): the viewer watches and never drives. Its input, navigation and dialog answers are dropped on the server,
// before the browser (`held read_only`), not only hidden by the page; `ready` says so; and a watching viewer keeps no session open (it never sets
// `viewing`). And a browser with no page (a headless one that starts with none) tells the viewer there is no page yet, until one opens.
import assert from "node:assert/strict";
import test from "node:test";
import { createDrivingGates } from "../dist/core/driving.js";
import { createLiveView } from "../dist/live-view/index.js";
import { openStream } from "../dist/live-view/stream.js";
import { fakeCdp } from "./fixtures/fake-cdp.mjs";
import { connect } from "./fixtures/ws-client.mjs";

const VIEWER = { html: "<!doctype html>", js: "", css: "" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { for (let i = 0; i < ms / 10 && !check(); i += 1) await wait(10); return check(); };

async function viewer(t, tag, options) {
  const made = [];
  const factory = (_cdpUrl, handlers) => { const s = { inputs: [], handlers }; made.push(s); return { input: async (m) => { s.inputs.push(m); }, nav: async (m) => { s.inputs.push(m); }, dialog: async (m) => { s.inputs.push(m); }, close() {} }; };
  const gates = createDrivingGates();
  const host = createLiveView({ hostOrigin: "'self'", stream: factory, viewer: VIEWER, gates, ...options });
  t.after(() => host.close());
  const view = await host.open(tag, "ws://127.0.0.1:9/x");
  const u = new URL(view.fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  assert.equal(c.status, 101);
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  return { made, gates, host, ws: c.ws, first: JSON.parse((await c.ws.next()).data) };
}

test("read-only: ready says readOnly, and every input, navigation and dialog answer is held read_only on the server and never reaches the browser", async (t) => {
  const v = await viewer(t, "ar-run-ro-1-1", { readOnly: true });
  assert.deepEqual(v.first, { type: "ready", drive: "idle", readOnly: true });
  const sent = [{ type: "mouse", action: "down", x: 3, y: 4 }, { type: "text", text: "hunter2" }, { type: "key", action: "down", key: "a", code: "KeyA", text: "a" }, { type: "nav", action: "url", url: "https://example.com/" }, { type: "dialog", accept: true }];
  for (const message of sent) {
    v.ws.sendJson(message);
    assert.deepEqual(JSON.parse((await v.ws.next()).data), { type: "held", reason: "read_only" }, JSON.stringify(message));
  }
  await wait(50);
  assert.deepEqual(v.made[0].inputs, [], "nothing reached the browser");
  assert.equal(v.gates("ar-run-ro-1-1").state(), "idle", "a watching viewer never drives");
  assert.equal(v.gates("ar-run-ro-1-1").viewing(), false, "and keeps no session from its idle release");
  assert.equal(v.host.driving("ar-run-ro-1-1"), false);
});

test("read-only: a viewer that keeps sending input is closed, as any excess is", async (t) => {
  const v = await viewer(t, "ar-run-ro-2-1", { readOnly: true });
  let refused = null;
  for (let i = 0; i < 25 && !refused; i += 1) {
    v.ws.sendJson({ type: "text", text: "x" });
    const m = JSON.parse((await v.ws.next()).data);
    if (m.type === "refused") refused = m;
  }
  assert.deepEqual(refused, { type: "refused", reason: "bad_message" });
});

test("without readOnly the viewer still drives, and sets viewing: the option changes nothing else", async (t) => {
  const v = await viewer(t, "ar-run-ro-3-1", {});
  assert.deepEqual(v.first, { type: "ready", drive: "idle" });
  assert.equal(v.gates("ar-run-ro-3-1").viewing(), true);
  v.ws.sendJson({ type: "text", text: "ok" });
  assert.ok(await until(() => v.made[0].inputs.length === 1));
});

test("a stream with no page tells its viewer no_page, and a page that opens later is announced", async (t) => {
  const v = await viewer(t, "ar-run-ro-4-1", { readOnly: true });
  v.made[0].handlers.noPage();
  assert.deepEqual(JSON.parse((await v.ws.next()).data), { type: "no_page" });
  v.made[0].handlers.page({ url: "https://example.com/", title: "Example" });
  assert.deepEqual(JSON.parse((await v.ws.next()).data), { type: "page", url: "https://example.com/", title: "Example" });
});

test("the stream says there is no page when the browser has none (a headless browser that starts with none), and follows the first page that opens", async (t) => {
  const fake = await fakeCdp({ pages: [] });
  t.after(() => fake.close());
  const seen = { none: 0, pages: [] };
  const stream = openStream(fake.url, { frame: (_b, _s, ack) => ack(), page: (p) => seen.pages.push(p), noPage: () => { seen.none += 1; }, dialog: () => {}, closed: () => {} });
  t.after(() => stream.close());
  assert.ok(await until(() => seen.none === 1), "no page yet");
  fake.newPage("PAGE2", "https://example.com/");
  assert.ok(await until(() => fake.screencasts().length === 1), "the first page that opens is followed");
  assert.ok(await until(() => seen.pages.some((p) => p.url === "https://example.com/")));
  fake.destroyPage("PAGE2");
  assert.ok(await until(() => seen.none === 2), "its last page closed: no page again");
});

test("a browser that has a page never says there is none", async (t) => {
  const fake = await fakeCdp();
  t.after(() => fake.close());
  let none = 0;
  const stream = openStream(fake.url, { frame: (_b, _s, ack) => ack(), page: () => {}, noPage: () => { none += 1; }, dialog: () => {}, closed: () => {} });
  t.after(() => stream.close());
  assert.ok(await until(() => fake.screencasts().length === 1));
  await wait(400);
  assert.equal(none, 0);
});
