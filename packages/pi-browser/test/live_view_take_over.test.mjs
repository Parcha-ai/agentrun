// Take over and hand back (LiveViewOptions.takeOver, DrivingGate.take): the person takes the run's browser through the viewer and gives it back. A take asks
// the host first (it may refuse, in its words); the hold lasts until the viewer's give, the hold's idle window with no input, or its away window with no
// viewer, and the host is told once how it ended. Only while held does the viewer's input reach the browser. A model call meanwhile waits inside the
// tool and then goes on with its old element ids dropped and plain words that the person had the browser; a driver a call took before the browser
// changed hands acts no more (the gate's epoch). Fake streams and a fake clock: no browser.
import assert from "node:assert/strict";
import test from "node:test";
import { createDrivingGates } from "../dist/core/driving.js";
import { drivingGuard, PERSON_DROVE, PERSON_HAD } from "../dist/core/driving-guard.js";
import { createLiveView } from "../dist/live-view/index.js";
import { connect } from "./fixtures/ws-client.mjs";

const VIEWER = { html: "<!doctype html>", js: "", css: "" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { for (let i = 0; i < ms / 10 && !check(); i += 1) await wait(10); return check(); };

/** A clock the test moves: `set` and `clear` as the gate's timers, `tick(ms)` fires what is due. */
function fakeClock() {
  let now = 0;
  const due = new Map();
  let next = 1;
  return {
    timers: { set: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run }); return id; }, clear: (id) => { due.delete(id); } },
    tick(ms) {
      now += ms;
      for (;;) {
        const ready = [...due].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!ready) return;
        due.delete(ready[0]);
        ready[1].run();
      }
    },
  };
}

const MIN = 60_000;

test("the gate's hold: take holds the browser for the person, moves the epoch, and refuses the model; input renews it; give, 15 minutes with no input, and 2 minutes with no viewer each end it once, saying why", () => {
  const clock = fakeClock();
  const gates = createDrivingGates({ timers: clock.timers });
  const gate = gates("ar-run-to-1-1");
  const ended = [];
  const before = gate.epoch();
  gate.setPresent(true);
  assert.equal(gate.take((why) => ended.push(why)), true);
  assert.equal(gate.held(), true);
  assert.equal(gate.state(), "person");
  assert.equal(gate.epoch(), before + 1, "a take moves the epoch");
  assert.equal(gate.model(), "person_driving", "no model call starts while held");
  assert.equal(gate.take(() => ended.push("second")), false, "a second take changes nothing");
  assert.equal(gate.input(), "driving");
  clock.tick(14 * MIN);
  assert.equal(gate.input(), "driving", "input renews the hold");
  clock.tick(14 * MIN);
  assert.equal(gate.held(), true, "28 minutes in, with input at 14: still held");
  assert.equal(gate.give(), true);
  assert.deepEqual(ended, ["given"]);
  assert.equal(gate.held(), false);
  assert.equal(gate.epoch(), before + 2, "the hold's end moves it again");
  assert.equal(gate.give(), false, "nothing to give");

  gate.take((why) => ended.push(why));
  clock.tick(15 * MIN);
  assert.deepEqual(ended, ["given", "idle"], "15 minutes with no input ends it");

  gate.take((why) => ended.push(why));
  gate.setPresent(false);
  clock.tick(MIN);
  gate.setPresent(true);
  clock.tick(5 * MIN);
  assert.equal(gate.held(), true, "a viewer back within 2 minutes keeps it");
  gate.setPresent(false);
  clock.tick(2 * MIN);
  assert.deepEqual(ended, ["given", "idle", "away"], "2 minutes with no viewer ends it");

  gate.take((why) => ended.push(why));
  gate.end();
  assert.deepEqual(ended, ["given", "idle", "away", "released"], "the session's release ends it");
});

test("a model call during the hold waits inside the tool; once handed back it goes on, its old element ids dropped, and the model is told plainly that the person had the browser", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-to-2-1";
  let forgot = 0;
  const driver = { forgetSnapshots: () => { forgot += 1; }, snapshot: async () => "[1] the page as it is now", close: async () => {} };
  const port = { session: async () => ({ tag, driver, notice: null }), relaunch: async () => ({ tag, driver }), release: async () => ({ released: true, sessionId: null }) };
  const tool = drivingGuard(async (_a, p) => { const s = await p.session(); return { content: [{ type: "text", text: JSON.stringify({ notice: s.notice, snapshot: await s.driver.snapshot() }) }] }; }, gates);
  gates(tag).take();
  let done = false;
  const running = tool({}, port, {}).then((out) => { done = true; return out; });
  await wait(100);
  assert.equal(done, false, "the call waits while the person holds the browser");
  gates(tag).give();
  const out = JSON.parse((await running).content[0].text);
  assert.equal(out.snapshot, "[1] the page as it is now");
  assert.equal(out.notice, `${PERSON_HAD} ${PERSON_DROVE}`);
  assert.equal(forgot, 1, "the old element ids were dropped before it went on");
  assert.equal(gates(tag).state(), "idle", "and the gate is free again");
});

test("a call stopped while it waits for the person does nothing and says so", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-to-3-1";
  let ran = 0;
  const port = { session: async () => ({ tag, driver: { close: async () => {} }, notice: null }), relaunch: async () => ({ tag }), release: async () => ({ released: true, sessionId: null }) };
  const tool = drivingGuard(async (_a, p) => { try { await p.session(); ran += 1; return { content: [{ type: "text", text: "ran" }] }; } catch (error) { return { content: [{ type: "text", text: JSON.stringify(error.failure) }], isError: true }; } }, gates);
  gates(tag).take();
  const stop = new AbortController();
  const running = tool({}, port, { signal: stop.signal });
  await wait(50);
  stop.abort();
  const out = await running;
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).code, "aborted");
  assert.equal(ran, 0);
  gates(tag).give();
});

test("an agent action from before the browser changed hands is refused: a call under way when the person takes over acts no more, refused as custody's own fence refuses (FenceRefusal)", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-to-4-1";
  const acts = [];
  const driver = { click: async (what) => { acts.push(what); return "clicked"; }, close: async () => {} };
  const port = { session: async () => ({ tag, driver, notice: null }), relaunch: async () => ({ tag, driver }), release: async () => ({ released: true, sessionId: null }) };
  const step = { go: null };
  const moved = new Promise((resolve) => { step.go = resolve; });
  const tool = drivingGuard(async (_a, p) => {
    const s = await p.session();
    await s.driver.click("first");
    await moved;
    try { await s.driver.click("second"); } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ name: error.constructor.name, ...error.failure }) }], isError: true }; }
    return { content: [{ type: "text", text: "both" }] };
  }, gates);
  const running = tool({}, port, {});
  await until(() => acts.length === 1);
  assert.equal(gates(tag).take(), true, "the person takes the browser while the call runs");
  step.go();
  const out = await running;
  assert.equal(out.isError, true);
  const failure = JSON.parse(out.content[0].text);
  assert.equal(failure.name, "FenceRefusal");
  assert.equal(failure.code, "refused");
  assert.equal(failure.effect, "possibly_effected", "its first act had reached the page");
  assert.match(failure.message, /The person took over this browser/);
  assert.deepEqual(acts, ["first"], "the act after the take never reached the page");
  gates(tag).give();
});

test("a run of several actions: once the person takes over during one, the next never reaches the page", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-to-12-1";
  const acts = [];
  let afterFirst;
  const firstDone = new Promise((resolve) => { afterFirst = resolve; });
  let taken;
  const takeHappened = new Promise((resolve) => { taken = resolve; });
  // One driver call runs every action it is given, in order, as Stagehand's batch does inside the browser.
  const driver = {
    run: async (input) => {
      for (const action of input.actions) {
        acts.push(action.id);
        if (action.id === "a1") { afterFirst(); await takeHappened; }
      }
      return { completed: input.actions.length, url: "https://example.test/" };
    },
    close: async () => {},
  };
  const port = { session: async () => ({ tag, driver, notice: null }), relaunch: async () => ({ tag, driver }), release: async () => ({ released: true, sessionId: null }) };
  const tool = drivingGuard(async (_a, p) => {
    const s = await p.session();
    try { return { content: [{ type: "text", text: JSON.stringify(await s.driver.run({ actions: [{ op: "click", id: "a1" }, { op: "click", id: "a2" }] })) }] }; }
    catch (error) { return { content: [{ type: "text", text: JSON.stringify({ name: error.constructor.name, ...error.failure }) }], isError: true }; }
  }, gates);
  const running = tool({}, port, {});
  await firstDone;
  assert.equal(gates(tag).take(), true, "the person takes over during the first action");
  taken();
  const out = await running;
  assert.equal(out.isError, true);
  const failure = JSON.parse(out.content[0].text);
  assert.deepEqual([failure.name, failure.code, failure.effect], ["FenceRefusal", "refused", "possibly_effected"]);
  assert.deepEqual(acts, ["a1"], "the second action never reached the page");
  gates(tag).give();
});

test("a take while the agent's call runs goes live once that call returns: until then the person's input is held, and no other call starts", async () => {
  const gates = createDrivingGates();
  const tag = "ar-run-to-13-1";
  const gate = gates(tag);
  const call = gate.model();
  let started = 0;
  assert.equal(gate.take(undefined, () => { started += 1; }), true);
  assert.equal(gate.held(), true, "held: no other model call starts");
  assert.equal(gate.model(), "person_driving");
  assert.equal(gate.input(), "agent_acting", "the person's input waits for the agent's call to return");
  assert.equal(started, 0);
  call.release();
  assert.equal(started, 1, "the hold goes live as the call returns");
  assert.equal(gate.input(), "driving");
  assert.equal(gate.state(), "person");
  gate.give();
});

/** A take-over viewer on a fake stream, and what the host was asked. */
async function viewer(t, tag, { refuse, gates = createDrivingGates() } = {}) {
  const made = [];
  const asked = [];
  const ends = [];
  const factory = (_cdpUrl, handlers) => { const s = { inputs: [], handlers }; made.push(s); return { input: async (m) => { s.inputs.push(m); }, nav: async (m) => { s.inputs.push(m); }, dialog: async (m) => { s.inputs.push(m); }, close() {} }; };
  const takeOver = { take: async (at) => { asked.push(at); return refuse ? { refused: refuse } : { end: (why) => ends.push(why) }; } };
  const host = createLiveView({ hostOrigin: "'self'", stream: factory, viewer: VIEWER, gates, takeOver });
  t.after(() => host.close());
  const view = await host.open(tag, "ws://127.0.0.1:9/x");
  const u = new URL(view.fullscreen);
  const open = async () => {
    const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
    assert.equal(c.status, 101);
    c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
    return { ws: c.ws, first: JSON.parse((await c.ws.next()).data) };
  };
  const { ws, first } = await open();
  const nextOf = async (ws_, type) => JSON.parse((await ws_.until((m) => m.type === "text" && JSON.parse(m.data).type === type)).item?.data ?? "null");
  return { made, asked, ends, gates, host, ws, first, open, nextOf };
}

test("take-over viewer: ready says so; input outside a hold is held not_taken and never reaches the browser; take holds it, the person's input reaches the browser, and give hands it back", async (t) => {
  const tag = "ar-run-to-5-1";
  const v = await viewer(t, tag);
  assert.deepEqual(v.first, { type: "ready", drive: "idle", takeOver: true, held: false });
  for (const message of [{ type: "text", text: "hunter2" }, { type: "mouse", action: "down", x: 3, y: 4 }, { type: "nav", action: "url", url: "https://example.com/" }, { type: "dialog", accept: true }]) {
    v.ws.sendJson(message);
    assert.deepEqual(JSON.parse((await v.ws.next()).data), { type: "held", reason: "not_taken" }, JSON.stringify(message));
  }
  assert.deepEqual(v.made[0].inputs, [], "nothing reached the browser outside a hold");
  assert.equal(v.gates(tag).viewing(), false, "a watching viewer keeps no session from its idle release");
  v.ws.sendJson({ type: "take" });
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: true });
  assert.deepEqual(v.asked, [tag], "the host was asked first");
  assert.equal(v.gates(tag).held(), true);
  assert.equal(v.host.driving(tag), true, "the recorder holds its capture while held");
  v.ws.sendJson({ type: "text", text: "tomsmith" });
  assert.ok(await until(() => v.made[0].inputs.length === 1));
  assert.deepEqual(v.made[0].inputs, [{ type: "text", text: "tomsmith" }]);
  v.ws.sendJson({ type: "give" });
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: false, reason: "given" });
  assert.deepEqual(v.ends, ["given"], "the host is told once how it ended");
  v.ws.sendJson({ type: "text", text: "after" });
  assert.deepEqual(await v.nextOf(v.ws, "held"), { type: "held", reason: "not_taken" });
  assert.equal(v.made[0].inputs.length, 1);
});

test("take-over viewer: a take the host refuses is shown in its words and holds nothing", async (t) => {
  const tag = "ar-run-to-6-1";
  const words = "spend_cap_reached: Not sent: the run has spent $0.99 of its $1.00 cap.";
  const v = await viewer(t, tag, { refuse: words });
  v.ws.sendJson({ type: "take" });
  assert.deepEqual(await v.nextOf(v.ws, "take_refused"), { type: "take_refused", message: words });
  assert.equal(v.gates(tag).held(), false);
  v.ws.sendJson({ type: "text", text: "x" });
  assert.deepEqual(await v.nextOf(v.ws, "held"), { type: "held", reason: "not_taken" });
  assert.deepEqual(v.made[0].inputs, []);
});

test("take-over viewer: the hold outlives a reconnect, and ends 2 minutes after its viewer is gone; the host is told, and a viewer that comes back is told it no longer holds", async (t) => {
  const tag = "ar-run-to-7-1";
  const clock = fakeClock();
  const v = await viewer(t, tag, { gates: createDrivingGates({ timers: clock.timers }) });
  v.ws.sendJson({ type: "take" });
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: true });
  v.ws.destroy();
  assert.ok(await until(() => v.host.tracked().sessions === 1 && v.gates(tag).held()), "still held");
  await wait(100);
  clock.tick(MIN);
  const back = await v.open();
  assert.deepEqual(back.first, { type: "ready", drive: "person", takeOver: true, held: true }, "a viewer back within 2 minutes still holds it");
  back.ws.destroy();
  await wait(100);
  clock.tick(2 * MIN);
  assert.equal(v.gates(tag).held(), false);
  assert.deepEqual(v.ends, ["away"]);
  const later = await v.open();
  assert.equal(later.first.held, false);
});

test("take-over viewer: the host gives the browser back at the run's cap: the viewer is told why, in the cap's words, and the host's end hears cap", async (t) => {
  const tag = "ar-run-to-10-1";
  const v = await viewer(t, tag);
  v.ws.sendJson({ type: "take" });
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: true });
  const words = "spend_cap_reached: Not sent: the run has spent $0.04 of its $0.05 cap.";
  assert.equal(v.gates(tag).give("cap", words), true);
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: false, reason: "cap", message: words });
  assert.deepEqual(v.ends, ["cap"]);
});

test("take-over viewer: a take sent while one is being asked of the host is answered held taking, and the host is asked once", async (t) => {
  const tag = "ar-run-to-11-1";
  let answer;
  const asked = [];
  const host = createLiveView({ hostOrigin: "'self'", stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }), viewer: VIEWER, gates: createDrivingGates(), takeOver: { take: (at) => { asked.push(at); return new Promise((resolve) => { answer = resolve; }); } } });
  t.after(() => host.close());
  const view = await host.open(tag, "ws://127.0.0.1:9/x");
  const u = new URL(view.fullscreen);
  const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
  c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
  await c.ws.next();
  c.ws.sendJson({ type: "take" });
  await until(() => asked.length === 1);
  c.ws.sendJson({ type: "take" });
  assert.deepEqual(JSON.parse((await c.ws.next()).data), { type: "held", reason: "taking" });
  answer({ end() {} });
  assert.deepEqual(JSON.parse((await c.ws.until((m) => m.type === "text" && JSON.parse(m.data).type === "hold")).item.data), { type: "hold", held: true });
  assert.deepEqual(asked, [tag], "asked once");
});

test("take-over viewer: a take while the agent acts is told it holds the browser only once the agent's call returns; input meanwhile is held agent_acting", async (t) => {
  const tag = "ar-run-to-14-1";
  const v = await viewer(t, tag);
  const call = v.gates(tag).model();
  v.ws.sendJson({ type: "take" });
  await until(() => v.asked.length === 1);
  await wait(50);
  v.ws.sendJson({ type: "text", text: "too soon" });
  assert.deepEqual(await v.nextOf(v.ws, "held"), { type: "held", reason: "agent_acting" });
  assert.deepEqual(v.made[0].inputs, []);
  call.release();
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: true });
  v.ws.sendJson({ type: "text", text: "now" });
  assert.ok(await until(() => v.made[0].inputs.length === 1));
});

test("take-over viewer: the session's release ends a hold, and the host is told", async (t) => {
  const tag = "ar-run-to-8-1";
  const v = await viewer(t, tag);
  v.ws.sendJson({ type: "take" });
  assert.deepEqual(await v.nextOf(v.ws, "hold"), { type: "hold", held: true });
  await v.host.release(tag);
  assert.deepEqual(v.ends, ["released"]);
});

test("take and give are refused as unknown by a viewer that is not a take-over one, and a read-only one drops them as any input", async (t) => {
  for (const [options, reason] of [[{}, "bad_message"], [{ readOnly: true, takeOver: { take: async () => ({ end() {} }) } }, "read_only"]]) {
    const gates = createDrivingGates();
    const host = createLiveView({ hostOrigin: "'self'", stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }), viewer: VIEWER, gates, ...options });
    t.after(() => host.close());
    const view = await host.open(`ar-run-to-9-${reason}`, "ws://127.0.0.1:9/x");
    const u = new URL(view.fullscreen);
    const c = await connect(`ws://${u.host}${u.pathname}/ws`, { origin: u.origin });
    c.ws.sendJson({ type: "hello", token: new URLSearchParams(u.hash.slice(1)).get("t") });
    await c.ws.next();
    c.ws.sendJson({ type: "take" });
    assert.deepEqual(JSON.parse((await c.ws.next()).data), { type: "held", reason });
    assert.equal(gates(`ar-run-to-9-${reason}`).held(), false);
  }
});
