// With no `gates` option the live view uses the package's shared per-session registry (core/driving.ts), the one the toolset's model calls use, so a host
// passes nothing and person and model still never interleave. The default is never a no-op.
import assert from "node:assert/strict";
import test from "node:test";
import { createLiveView, drivingGates } from "../dist/live-view/index.js";
import { connect } from "./fixtures/ws-client.mjs";

const VIEWER = { html: "<!doctype html>", js: "", css: "" };
const stream = () => { const made = []; return { made, factory: (cdpUrl, handlers) => { const s = { inputs: [], closed: false, handlers }; made.push(s); return { input: async (m) => { s.inputs.push(m); }, nav: async () => {}, dialog: async () => {}, close() { s.closed = true; } }; } }; };
const open = async (t, tag) => {
  const st = stream();
  const host = createLiveView({ hostOrigin: null, stream: st.factory, viewer: VIEWER });
  t.after(async () => { await host.close(); });
  const view = await host.open(tag, "ws://127.0.0.1:9/x");
  const u = new URL(view.fullscreen);
  const token = new URLSearchParams(u.hash.slice(1)).get("t");
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  assert.equal(c.status, 101);
  c.ws.sendJson({ type: "hello", token });
  return { st, host, ws: c.ws, first: JSON.parse((await c.ws.next()).data) };
};

test("no gates option: a viewer connects (ready, not closed 1011) and its input is the shared registry's person", async (t) => {
  const r = await open(t, "ar-run-drv-1-1");
  assert.deepEqual(r.first, { type: "ready", drive: "idle" });
  r.ws.sendJson({ type: "mouse", action: "down", x: 3, y: 4 });
  for (let i = 0; i < 100 && r.st.made[0].inputs.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(r.st.made[0].inputs.length, 1);
  assert.equal(drivingGates("ar-run-drv-1-1").state(), "person", "the registry the toolset's model calls consult");
  assert.equal(r.host.driving("ar-run-drv-1-1"), true);
  assert.equal(drivingGates("ar-run-drv-1-1").model(), "person_driving", "a model call while a person drives is refused");
  await r.host.release("ar-run-drv-1-1");
  assert.equal(drivingGates("ar-run-drv-1-1").state(), "idle", "release ended the gate");
});

test("no gates option: while a model call is in flight the viewer's input is held agent_acting and never reaches the browser; the person drives again once it returns", async (t) => {
  const r = await open(t, "ar-run-drv-2-1");
  const call = drivingGates("ar-run-drv-2-1").model();
  assert.notEqual(call, "person_driving");
  assert.deepEqual(JSON.parse((await r.ws.next()).data), { type: "status", drive: "agent" });
  r.ws.sendJson({ type: "text", text: "hunter2" });
  assert.deepEqual(JSON.parse((await r.ws.next()).data), { type: "held", reason: "agent_acting" });
  assert.equal(r.st.made[0].inputs.length, 0);
  call.release();
  assert.deepEqual(JSON.parse((await r.ws.next()).data), { type: "status", drive: "idle" });
  r.ws.sendJson({ type: "text", text: "tomsmith" });
  for (let i = 0; i < 100 && r.st.made[0].inputs.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(r.st.made[0].inputs, [{ type: "text", text: "tomsmith" }]);
});

const { drivingGuard } = await import("../dist/core/driving-guard.js");
const { createDrivingGates } = await import("../dist/core/driving.js");
const port = (tag, relaunchTag = "ar-run-drv-9-2") => ({ session: async () => ({ tag }), relaunch: async () => ({ tag: relaunchTag }), release: async () => ({ released: true, sessionId: null }), marker: "kept" });
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };

test("drivingGuard: the gate is the model's from the tool's first session() until it returns, even when it throws; the tool sees the rest of its port as it was", async () => {
  const gates = createDrivingGates();
  const hold = gate();
  const states = [];
  const guarded = drivingGuard(async (_args, p) => { assert.equal(p.marker, "kept"); await p.session(); states.push(gates("ar-run-drv-9-1").state()); await hold.promise; return { content: [{ type: "text", text: "ok" }] }; }, gates);
  const running = guarded({}, port("ar-run-drv-9-1"), {});
  await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(states, ["agent"]);
  assert.equal(gates("ar-run-drv-9-1").input(), "agent_acting", "a viewer's input is held while the call runs");
  hold.open();
  assert.equal((await running).content[0].text, "ok");
  assert.equal(gates("ar-run-drv-9-1").state(), "idle", "released on return");
  const thrower = drivingGuard(async (_a, p) => { await p.session(); throw new Error("the tool failed"); }, gates);
  await assert.rejects(() => thrower({}, port("ar-run-drv-9-1"), {}), /the tool failed/);
  assert.equal(gates("ar-run-drv-9-1").state(), "idle", "released on a throw");
});

test("drivingGuard: while a person drives the tool does nothing, and the refusal is typed and retryable; a relaunch moves the call to the new session's gate", async () => {
  const gates = createDrivingGates();
  let ran = 0;
  const tool = async (_a, p) => { await p.session(); ran += 1; return { content: [{ type: "text", text: "ran" }] }; };
  gates("ar-run-drv-9-1").input();
  const refused = drivingGuard(async (a, p, c) => { try { return await tool(a, p, c); } catch (error) { return { content: [{ type: "text", text: JSON.stringify(error.failure) }], isError: true }; } }, gates);
  const out = await refused({}, port("ar-run-drv-9-1"), {});
  const failure = JSON.parse(out.content[0].text);
  assert.deepEqual([ran, failure.code, failure.retryable, failure.effect, failure.message.startsWith("person_driving: ")], [0, "refused", true, "none", true]);
  assert.equal(gates("ar-run-drv-9-1").state(), "person", "a refused call leaves the person driving");
  const relaunching = drivingGuard(async (_a, p) => { await p.relaunch({}); assert.equal(gates("ar-run-drv-9-2").state(), "agent"); assert.equal(gates("ar-run-drv-9-1").state(), "person", "the old session's person is not the call's concern"); return { content: [{ type: "text", text: "ok" }] }; }, gates);
  await relaunching({}, port("ar-run-drv-9-1"), {});
  assert.equal(gates("ar-run-drv-9-2").state(), "idle");
});

test("drivingGuard: a class-based port keeps its own state: a method the guard does not override runs on the real port, not on a copy", async () => {
  class Port { live = "attached"; async session() { return { tag: "ar-run-drv-8-1" }; } async relaunch() { return { tag: "ar-run-drv-8-2" }; } async release() { this.live = null; return { released: true, sessionId: "s" }; } async current() { return this.live ? "ar-run-drv-8-1" : null; } }
  const p = new Port();
  const guarded = drivingGuard(async (_a, port) => { await port.release(); return { content: [{ type: "text", text: "done" }] }; }, createDrivingGates(), { early: true });
  await guarded({}, p, {});
  assert.equal(p.live, null, "the release wrote its state on the real port");
  assert.equal(await p.current(), null);
});

test("DrivingGate.viewing(): false until an authenticated viewer is connected, true while it is, false when it leaves, is refused, or the session is released", async (t) => {
  const tag = "ar-run-drv-7-1";
  assert.equal(drivingGates(tag).viewing(), false, "no viewer, no view");
  const r = await open(t, tag);
  assert.deepEqual(r.first, { type: "ready", drive: "idle" });
  assert.equal(drivingGates(tag).viewing(), true, "set on hello");
  assert.equal(drivingGates(tag).state(), "idle", "viewing is not driving: a person idle with the viewer open is still viewing");

  // A second viewer with the right token is refused and changes nothing; a stranger that never says hello is not a viewer.
  const u = new URL((await r.host.open(tag, "ws://127.0.0.1:9/x")).fullscreen);
  const token = new URLSearchParams(u.hash.slice(1)).get("t");
  const second = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  second.ws.sendJson({ type: "hello", token });
  assert.deepEqual(JSON.parse((await second.ws.next()).data), { type: "refused", reason: "viewer_in_use" });
  assert.equal(drivingGates(tag).viewing(), true, "the refused second viewer did not clear it");

  r.ws.destroy();
  for (let i = 0; i < 100 && drivingGates(tag).viewing(); i += 1) await new Promise((x) => setTimeout(x, 10));
  assert.equal(drivingGates(tag).viewing(), false, "cleared when the viewer leaves");

  const stranger = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  assert.equal(stranger.status, 101);
  assert.equal(drivingGates(tag).viewing(), false, "a connection with no hello is not a viewer");
  stranger.ws.destroy();

  const wrong = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  wrong.ws.sendJson({ type: "hello", token: "x".repeat(43) });
  assert.deepEqual(JSON.parse((await wrong.ws.next()).data), { type: "refused", reason: "unauthorized" });
  assert.equal(drivingGates(tag).viewing(), false, "a hello with the wrong token does not make a viewer");

  const again = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  again.ws.sendJson({ type: "hello", token });
  assert.equal(JSON.parse((await again.ws.next()).data).type, "ready");
  assert.equal(drivingGates(tag).viewing(), true, "a viewer that comes back is viewing again");
  await r.host.release(tag);
  assert.equal(drivingGates(tag).viewing(), false, "cleared at release");
});

test("DrivingGate.viewing(): a custom registry's gate is told too, and a gate's end() clears it", async () => {
  const gates = createDrivingGates();
  const gate = gates("ar-run-drv-7-2");
  assert.equal(gate.viewing(), false);
  gate.setViewing(true);
  assert.equal(gate.viewing(), true);
  assert.equal(gates("ar-run-drv-7-2").viewing(), true, "the same gate per tag");
  gate.setViewing(false);
  assert.equal(gate.viewing(), false);
  gate.setViewing(true);
  gate.end();
  assert.equal(gate.viewing(), false, "end() clears the flag on the gate that was ended, not only on the next one made for the tag");
  assert.equal(gates("ar-run-drv-7-2").viewing(), false, "and the tag's next gate starts without a viewer");
});

test("a person's command in flight keeps the person driving until it ends, even past the idle window", async (t) => {
  const gates = createDrivingGates({ idleMs: 1_500 });
  const tag = "ar-run-drv-6-1";
  const hold = gate();
  const st = { inputs: [], navs: [] };
  const host = createLiveView({ hostOrigin: null, gates, viewer: VIEWER, stream: () => ({ input: async (m) => { st.inputs.push(m); }, nav: async (m) => { st.navs.push(m); await hold.promise; }, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open(tag, "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  c.ws.sendJson({ type: "nav", action: "url", url: "https://example.com/slow" });
  for (let i = 0; i < 100 && st.navs.length < 1; i += 1) await new Promise((x) => setTimeout(x, 10));
  await new Promise((x) => setTimeout(x, 2_600));
  assert.equal(gates(tag).model(), "person_driving", "the person's navigation is still running, so the model does not take the browser");
  hold.open();
  await new Promise((x) => setTimeout(x, 100));
  c.ws.destroy();
});

test("input queued behind a slow command is checked against the gate again when it is delivered, not only when it arrived", async (t) => {
  const hold = gate();
  const seenInput = [];
  let calls = 0;
  // The gate says 'driving' when each message arrives and when the navigation is delivered, and 'agent_acting' by the time the queued text would be.
  const fake = { state: () => "idle", input: () => (calls += 1) <= 3 ? "driving" : "agent_acting", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} };
  const host = createLiveView({ hostOrigin: null, gates: () => fake, viewer: VIEWER, stream: () => ({ input: async (m) => { seenInput.push(m); }, nav: async () => { await hold.promise; }, dialog: async () => {}, close() {} }) });
  t.after(() => host.close());
  const u = new URL((await host.open("ar-run-drv-6-2", "ws://127.0.0.1:9/x")).fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  assert.equal(JSON.parse((await c.ws.next()).data).type, "ready");
  c.ws.sendJson({ type: "nav", action: "url", url: "https://example.com/slow" });
  c.ws.sendJson({ type: "text", text: "queued behind the navigation" });
  await new Promise((x) => setTimeout(x, 300));
  hold.open();
  const { item } = await c.ws.until((m) => m.type === "text" && JSON.parse(m.data).type === "held", 3_000);
  assert.deepEqual(JSON.parse(item.data), { type: "held", reason: "agent_acting" });
  assert.deepEqual(seenInput, [], "the queued text did not reach the browser");
  c.ws.destroy();
});

test("open() that finishes after close() or release() gives no viewer: the server it started is stopped and the open is refused", async (t) => {
  const http = await import("node:http");
  const servers = [];
  const original = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) { servers.push(this); return original.apply(this, args); };
  t.after(() => { http.Server.prototype.listen = original; });
  const host = createLiveView({ hostOrigin: null, gates: () => ({ state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} }), viewer: VIEWER, stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }) });
  const opening = host.open("ar-run-drv-5-1", "ws://127.0.0.1:9/x");
  const closing = host.close();
  await assert.rejects(opening, /closed|released/);
  await closing;
  assert.equal(host.known("ar-run-drv-5-1"), null, "no viewer URL survives shutdown");
  assert.deepEqual(servers.map((s) => s.listening), servers.map(() => false), "the listener the open started is stopped");

  const host2 = createLiveView({ hostOrigin: null, gates: () => ({ state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} }), viewer: VIEWER, stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }) });
  t.after(() => host2.close());
  const racing = host2.open("ar-run-drv-5-2", "ws://127.0.0.1:9/x");
  await host2.release("ar-run-drv-5-2");
  await assert.rejects(racing, /closed|released/);
  assert.equal(host2.known("ar-run-drv-5-2"), null, "a release that overtook the open is not undone by it");
});

test("a gate nothing holds is not kept: it goes when its last call, its person window (once the model has been told a person drove), its viewer and its listeners are gone; a gate in use stays the same object", async () => {
  const gates = createDrivingGates({ idleMs: 50 });
  const tag = "ar-run-drv-4-1";
  const g = gates(tag);
  const call = g.model();
  assert.equal(gates(tag), g, "held by a running call");
  call.release();
  assert.notEqual(gates(tag), g, "after its last call, nothing holds it");
  const v = gates(tag);
  v.setViewing(true);
  assert.equal(gates(tag), v, "held by a viewer");
  v.model().release();
  assert.equal(gates(tag), v, "a call that ends does not drop a gate a viewer still holds");
  v.setViewing(false);
  assert.notEqual(gates(tag), v, "a viewer that left holds nothing");
  const l = gates(tag);
  const off = l.onChange(() => {});
  assert.equal(gates(tag), l, "held by a listener");
  l.model().release();
  assert.equal(gates(tag), l, "a call that ends does not drop a gate a listener still holds");
  off();
  assert.notEqual(gates(tag), l);
  const p = gates(tag);
  p.input();
  assert.equal(gates(tag), p, "held by a person who has just driven");
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(gates(tag), p, "kept past the person's window until the model's next call has been told a person drove");
  const told = p.model();
  assert.equal(told.drove, true);
  p.told();
  told.release();
  assert.notEqual(gates(tag), p, "and released once that call has ended");
  const e = gates(tag);
  e.input();
  e.end();
  assert.notEqual(gates(tag), e, "a session's release (end) drops it whether or not the model was told");
});
