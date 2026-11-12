// A run's computer from the owner's side: the computer call channel (computer-channel.ts) and a held computer
// (computer-held.ts). Any running run's computer takes the owner's protocol calls, each a command row its runner answers
// behind the person's hold, its record a computer.call entry. A run started with hold: true claims its computer and waits,
// its agent not started, until its owner starts it; it keeps the computer after the agent's end until the owner releases
// it, or until no call came for the hold's minutes. The agent's own calls are kept on the tool_result row of the tool call
// that made them (computer_calls, computer-calls.ts).
//
// The run is pi through the adapter loop on a runner, its spec carrying `computer` (a client of the test's own that records
// each call) and, held, `held`. The routes are called as serve's dispatch calls them (heldRoute, with the server's store),
// and the run read's field as GET /runs/{id} adds it (heldField). The runner's hold is unit-tested on its own for its lapse
// and for a claim that lost the computer it held.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { STEADY_LEASE } from "./runner-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { heldField, heldRoute } = await import("../dist/computer-held-routes.js");
const { HOLD_MAX_MINUTES, HOLD_MINUTES, heldIn, holdIssues, holdOf } = await import("../dist/computer-held.js");
const { CALL_KIND, PROTOCOL_METHODS } = await import("../dist/computer-channel.js");
const { callRecordOf, MAX_RECORDED_CALLS, recordedClient, recordingCalls, unrecorded } = await import("../dist/computer-calls.js");
const { entriesOf } = await import("../dist/computer-commands.js");
const { journalHeld } = await import("../dist/runner/held-run.js");
const { computerHold } = await import("../dist/workspace/computer-hold.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { ApiError } = await import("../dist/errors.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 15_000;
const FAST = { pollMs: 20, takeMs: 10_000, context: ctx };
after(closeOpenSessions);

/** A computer client that answers every call with what it was asked, and records each. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "hello") return { ok: true, value: { protocol: "0.1", groups: ["screen"] } };
      if (method === "files.read") return { ok: false, error: { code: "not_found", message: `no file ${params.path}` } };
      return { ok: true, value: { method, params } };
    },
    close() {},
  };
}

/** Resolves once `check` answers truthy, polled; fails past WAIT_MS saying `what`. */
async function until(check, what) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup(t, { hold = { minutes: 1 } } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-computer-held-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const runners = [];
  const stores = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { computer: { kind: "desktop", provider: "e2b" } } });
  const body = { input: { content: "Do the task." }, title: "Do the task.", place: { mode: "runner" }, ...(hold ? { hold } : {}) };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body });
  /** A route's answer, or its refusal as { status, code, message }. */
  const route = (name, body = {}, runId = "run-1") => heldRoute(name, runId, body, server, FAST).then((answer) => ({ answer }), (error) => {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  });
  const field = () => heldField(server, "run-1", FAST);
  const state = async () => (await field())?.state;
  const row = () => server.runs.get("run-1");
  /**
   * The run on a runner. The agent calls `tool` once and says done; by default a look that counts itself. Its spec's
   * computer is a desktop on `client` (with the person's hold `personHold`, when given), held for `minutes` when the run
   * was created with a hold.
   */
  const start = async ({ client = fakeClient(), minutes = 1, personHold, tool } = {}) => {
    const looks = [];
    const used = tool ?? { name: "look", replaySafe: true, run: async () => (looks.push(Date.now()), "a grey screen") };
    const spec = piAdapterSpec({ script: [{ call: used.name }, { say: "done" }], tools: { [used.name]: used }, hooks: quiet });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const computer = { kind: "desktop", client, ...(personHold ? { hold: personHold } : {}) };
    runners.push(startRunner({ store, createLoop: createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", computer, ...(hold ? { held: { minutes } } : {}) })), name: "runner-a", ...TIMING }));
    return { client, looks };
  };
  const phases = async () => (await runTimeline(server, "run-1", ctx)).map((one) => one.summary).filter(Boolean);
  const callEntries = async () => (await entriesOf(server, "run-1", FAST)).filter((one) => one.kind === CALL_KIND).map((one) => one.data);
  return { server, route, field, state, row, start, phases, callEntries };
}

test("a held run: the owner's calls set the computer up before the start, the agent runs once started, and the run keeps the computer after its end until released", async (t) => {
  const world = await setup(t);
  assert.deepEqual(await world.field(), { state: "starting", minutes: 1 }, "no runner yet: the hold is not up");
  const early = await world.route("callRunComputer", { method: "hello" });
  assert.deepEqual([early.status, early.code], [409, "computer_not_live"], "a call before the computer is up is refused");
  assert.match(early.message, /not up now: the run is queued/);

  const run = await world.start();
  await until(async () => (await world.state()) === "waiting", "the computer is up and held");
  const waiting = await world.field();
  assert.ok(Date.parse(waiting.until) > Date.now(), `the hold lapses later: ${JSON.stringify(waiting)}`);

  // Before the start: the owner's calls reach the computer, answered verbatim, and the agent has not run.
  assert.deepEqual(await world.route("callRunComputer", { method: "hello" }), { answer: { ok: true, value: { protocol: "0.1", groups: ["screen"] } } });
  assert.deepEqual(await world.route("callRunComputer", { method: "exec.run", params: { argv: ["true"] } }), { answer: { ok: true, value: { method: "exec.run", params: { argv: ["true"] } } } });
  assert.deepEqual(await world.route("callRunComputer", { method: "files.read", params: { path: "/nope" } }), { answer: { ok: false, error: { code: "not_found", message: "no file /nope" } } }, "an error answer is the computer's, verbatim, with 200");
  assert.deepEqual(run.looks, [], "the agent waits for the start");
  assert.equal(await world.state(), "waiting");

  assert.deepEqual(await world.route("startRun"), { answer: { held: { state: "started" } } });
  const again = await world.route("startRun");
  assert.deepEqual([again.status, again.code], [409, "computer_not_live"], "a second start is refused");
  assert.match(again.message, /already started/);

  // After the agent's end the run keeps its computer: still going, and the owner's calls still reach it.
  await until(async () => (await world.state()) === "ended", "the agent is done, the computer kept");
  assert.equal(run.looks.length, 1, "the agent ran once started");
  assert.equal((await world.row()).state, "running", "the run waits for the release");
  assert.deepEqual(await world.route("callRunComputer", { method: "screen.shot", params: { format: "png" } }), { answer: { ok: true, value: { method: "screen.shot", params: { format: "png" } } } });

  assert.deepEqual(await world.route("releaseRunComputer"), { answer: { held: { state: "released" } } });
  await until(async () => (await world.row()).state === "ended", "the run ends once released");
  assert.equal((await world.row()).outcome, null, "it ends as its agent did: a plain completion");
  assert.deepEqual(run.client.calls.map((call) => call.method), ["hello", "exec.run", "files.read", "screen.shot"], "only the owner's calls went to the computer's client");

  // Each call's record is on the run's journal: its method, how it went and how long, never a param or an answer.
  const records = await world.callEntries();
  assert.deepEqual(records.map((one) => [one.method, one.ok, one.code]), [["hello", true, undefined], ["exec.run", true, undefined], ["files.read", false, "not_found"], ["screen.shot", true, undefined]]);
  for (const one of records) {
    assert.deepEqual(Object.keys(one).sort(), ["at", "by", "method", "ms", "ok", ...(one.ok ? [] : ["code"])].sort(), JSON.stringify(one));
  }

  const twice = await world.route("releaseRunComputer");
  assert.deepEqual([twice.status, twice.code], [404, "not_found"], "a second release finds nothing to let go");
  assert.doesNotMatch(twice.message, /^no route/, "and says so in words that are not a missing route");
  const late = await world.route("callRunComputer", { method: "hello" });
  assert.deepEqual([late.status, late.code], [409, "computer_not_live"], "a call after the release is refused");
  assert.equal(await world.state(), "released");

  const said = await world.phases();
  for (const words of [/^The computer is up and held/, /^The owner started the agent$/, /^The agent is done\. The run keeps its computer/, /^The owner released the computer$/]) {
    assert.ok(said.some((one) => words.test(one)), `the Timeline says ${words}: ${JSON.stringify(said)}`);
  }
});

test("a held run released before its start ends cancelled, its agent never run", async (t) => {
  const world = await setup(t);
  const run = await world.start();
  await until(async () => (await world.state()) === "waiting", "the computer is up and held");
  assert.deepEqual(await world.route("releaseRunComputer"), { answer: { held: { state: "released" } } });
  await until(async () => ["ended", "stopped", "failed"].includes((await world.row()).state), "the run ends");
  const ended = await world.row();
  assert.deepEqual([ended.state, ended.outcome], ["stopped", "cancelled"]);
  assert.deepEqual(run.looks, [], "the agent never ran");
});

test("the channel: a run that holds nothing takes the owner's calls while its agent works, and a call waits while a person holds the computer", async (t) => {
  const world = await setup(t, { hold: false });
  let letGo;
  const working = new Promise((resolve) => (letGo = resolve));
  const tool = { name: "work", replaySafe: true, run: async () => (await working, "done working") };
  const personHold = computerHold();
  const run = await world.start({ personHold, tool });
  await until(async () => (await world.row()).state === "running", "the run is claimed");

  // The runner wakes on the write, and the server on the answer (both in this process): a call costs milliseconds.
  assert.deepEqual(await world.route("callRunComputer", { method: "ping" }), { answer: { ok: true, value: { method: "ping", params: {} } } });
  const times = [];
  for (const _ of Array.from({ length: 20 })) {
    const started = performance.now();
    await world.route("callRunComputer", { method: "ping" });
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`a channel call's round trip, in process: median ${times[10].toFixed(1)} ms, slowest ${times.at(-1).toFixed(1)} ms`);
  assert.ok(times[10] < 200, `a call takes no poll interval: ${times.map((one) => one.toFixed(1)).join(", ")}`);

  // A person takes the computer: the owner's call waits for the hand-back, as the agent's would.
  assert.equal(personHold.take(), true);
  assert.equal(personHold.state(), "person");
  const asked = run.client.calls.length;
  const waited = world.route("callRunComputer", { method: "screen.shot", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(run.client.calls.length, asked, "the call has not reached the computer while the person holds it");
  assert.equal(personHold.give(), true);
  assert.deepEqual(await waited, { answer: { ok: true, value: { method: "screen.shot", params: {} } } }, "the call ran once the person gave it back");

  letGo();
  await until(async () => (await world.row()).state === "ended", "the run ends with its agent");
  const late = await world.route("callRunComputer", { method: "ping" });
  assert.deepEqual([late.status, late.code], [409, "computer_not_live"]);
  assert.match(late.message, /not up now: the run is ended/);
  assert.equal(await world.field(), undefined, "a run that holds nothing has no held field");
});

test("the agent's computer calls are kept on its tool call's result row: methods, routes and outcomes, never a typed value", async (t) => {
  const world = await setup(t, { hold: false });
  const client = fakeClient();
  const plain = client.call;
  client.call = async (method, params) => {
    if (method !== "ui.act") return plain(method, params);
    client.calls.push({ method, params });
    return { ok: true, value: { steps: [{ route: "ax", verified: true }, { error: { kind: "not_found", message: "no button" } }], expect: "unmet" } };
  };
  // The run's client as the claim wraps it (resolve-computer.ts runComputerOf).
  const recorded = recordedClient(client);
  const tool = {
    name: "drive",
    replaySafe: false,
    run: async () => {
      await recorded.call("ui.act", { steps: [{ set: { target: "password", text: "hunter2-secret" } }, { press: { target: "Sign in" } }] });
      await recorded.call("files.read", { path: "/etc/secret-path" });
      return "drove";
    },
  };
  await world.start({ client: recorded, tool });
  await until(async () => (await world.row()).state === "ended", "the run ends");
  const rows = await runTimeline(world.server, "run-1", ctx);
  const result = rows.find((row) => row.kind === "tool_result" && row.computer_calls);
  assert.ok(result, `a tool_result row carries computer_calls: ${JSON.stringify(rows.map((row) => row.kind))}`);
  assert.deepEqual(result.computer_calls.map(({ ms, ...rest }) => (assert.equal(typeof ms, "number"), rest)), [
    { method: "ui.act", ok: true, steps: [{ do: "set", route: "ax", verified: true }, { do: "press", error: "not_found" }], expect: "unmet" },
    { method: "files.read", ok: false, code: "not_found" },
  ]);
  const all = JSON.stringify(rows);
  assert.doesNotMatch(all, /hunter2-secret|secret-path|no button/, "no param's value and no answer's text is on any row");
  assert.equal(result.computer_calls_dropped, undefined);
});

test("a call's record: ui.act steps by kind, an error by its code, the most a tool call keeps, and the channel's calls on no tool call", async () => {
  assert.deepEqual(callRecordOf("ui.act", { steps: [{ type: { text: "x" } }, { key: { keys: "Enter" } }] }, { ok: true, value: { steps: [{ route: "keys", verified: false }, { route: "keys" }], expect: "met" } }, 12.6), {
    method: "ui.act", ok: true, ms: 13, steps: [{ do: "type", route: "keys", verified: false }, { do: "key", route: "keys" }], expect: "met",
  });
  assert.deepEqual(callRecordOf("exec.run", { argv: ["rm"] }, { ok: false, error: { code: "denied", message: "no" } }, 1), { method: "exec.run", ok: false, ms: 1, code: "denied" });
  assert.deepEqual(callRecordOf("screen.shot", {}, { ok: true, value: { data: "iVBOR" } }, 3), { method: "screen.shot", ok: true, ms: 3 }, "no bytes");

  const client = recordedClient(fakeClient());
  const kept = [];
  await recordingCalls(async () => {
    for (const _ of Array.from({ length: MAX_RECORDED_CALLS + 3 })) await client.call("ping", {});
    await unrecorded(() => client.call("hello", {}));
  }, async (calls, dropped) => void kept.push({ count: calls.length, dropped, methods: new Set(calls.map((one) => one.method)) }));
  assert.deepEqual(kept, [{ count: MAX_RECORDED_CALLS, dropped: 3, methods: new Set(["ping"]) }], "an unrecorded call (the channel's) is on no tool call");
  const none = [];
  await recordingCalls(async () => "no calls", async () => void none.push(1));
  assert.deepEqual(none, [], "a tool call that made no call keeps nothing");
  await client.call("ping", {});
});

test("the routes refuse in words: start and release of a run that holds no computer, a call of no run, a method the protocol lacks, a body field they keep none of", async (t) => {
  const world = await setup(t, { hold: false });
  for (const name of ["startRun", "releaseRunComputer"]) {
    const said = await world.route(name);
    assert.deepEqual([said.status, said.code], [404, "not_found"], name);
    assert.match(said.message, /holds no computer: a run started with hold: true holds one/);
  }
  const queued = await world.route("callRunComputer", { method: "hello" });
  assert.deepEqual([queued.status, queued.code], [409, "computer_not_live"]);
  const none = await world.route("callRunComputer", { method: "hello" }, "run-404");
  assert.deepEqual([none.status, none.code], [404, "not_found"]);
  const issues = (error) => [error.status, error.extra?.fields?.map((one) => [one.field, one.reason])];
  // A body's issues come before the run is read: a 422, whatever run it names.
  const wrong = await heldRoute("callRunComputer", "run-1", { method: "screen.capture" }, world.server, FAST).catch((error) => error);
  assert.deepEqual(issues(wrong), [422, [["method", "not_an_option"]]]);
  const extra = await heldRoute("startRun", "run-1", { now: true }, world.server, FAST).catch((error) => error);
  assert.deepEqual(issues(extra), [422, [["now", "not_allowed"]]]);
  const params = await heldRoute("callRunComputer", "run-1", { method: "hello", params: [] }, world.server, FAST).catch((error) => error);
  assert.deepEqual(issues(params), [422, [["params", "wrong_type"]]]);
});

test("the hold lets the computer go when no call comes for its minutes, and a new claim finds the hold it had gone with its computer", async () => {
  const written = [];
  let clock = 1_000;
  const commit = async (entries) => void written.push(...entries);
  const minutes = 0.01; // 600 ms
  const held = journalHeld({ minutes }, commit, () => clock);
  assert.equal(await held.up([], true), "held");
  assert.deepEqual(written.map((one) => [one.kind, one.data.state]), [["computer.held", "waiting"], ["agentrun.phase", undefined]]);
  assert.equal(held.refusesCall(), undefined, "a waiting hold takes calls");
  // A call starts the count again: the runner tells the hold, and the journal reads it from the call's entry.
  clock += 500;
  written.push({ kind: CALL_KIND, data: { by: 7, at: clock, method: "ping", ok: true, ms: 1 } });
  held.touched(clock);
  assert.equal(heldIn(written).until, 1_500 + minutes * 60_000, "the journal reads the lapse from the last call");
  clock += 700;
  assert.equal(await held.untilStarted(new Promise(() => {})), "moved");
  assert.deepEqual([held.state(), held.lapse()], ["released", "timeout"]);
  assert.deepEqual(heldIn(written), { state: "released", minutes, until: 2_200 + minutes * 60_000, why: "timeout" });
  assert.match(written.at(-1).data.summary, /no call came from its owner/);
  assert.match(held.decide({ id: 8, kind: "computer_start", body: {} }).refused, /let go: no call came/);
  assert.match(held.refusesCall(), /let go: no call came/, "a lapsed hold refuses calls");

  // A new claim of a run whose hold was waiting: its computer is not the one held.
  const lost = [];
  const again = journalHeld({ minutes: 1 }, async (entries) => void lost.push(...entries), () => 5_000);
  assert.equal(await again.up([{ kind: "computer.held", data: { state: "waiting", at: 1_000, minutes: 1 } }], true), "lost");
  assert.deepEqual(lost[0].data, { state: "released", at: 5_000, minutes: 1, why: "lost" });
  // A restart within the claim keeps the hold where it was.
  const kept = journalHeld({ minutes: 1 }, async () => {}, () => 5_000);
  assert.equal(await kept.up([{ kind: "computer.held", data: { state: "started", at: 1_000, minutes: 1, by: 3 } }], false), "held");
  assert.equal(kept.state(), "started");
});

test("hold and hold_minutes on a run's create: a boolean, a whole number of minutes up to the most, and only for a computer that speaks the protocol", () => {
  assert.deepEqual(holdIssues({ hold: true }), []);
  assert.deepEqual(holdIssues({ hold: true, hold_minutes: HOLD_MAX_MINUTES }), []);
  assert.deepEqual(holdIssues({ hold: "yes" }).map((one) => [one.field, one.reason]), [["hold", "wrong_type"]]);
  assert.deepEqual(holdIssues({ hold: true, hold_minutes: HOLD_MAX_MINUTES + 1 }).map((one) => [one.field, one.reason]), [["hold_minutes", "not_an_option"]]);
  assert.deepEqual(holdIssues({ hold: true, hold_minutes: 1.5 }).map((one) => [one.field, one.reason]), [["hold_minutes", "not_an_option"]]);
  assert.deepEqual(holdIssues({ hold_minutes: 5 }).map((one) => [one.field, one.reason]), [["hold_minutes", "not_an_option"]], "minutes without a hold");
  assert.deepEqual(holdOf({ hold: true }, "desktop"), { minutes: HOLD_MINUTES });
  assert.deepEqual(holdOf({ hold: true, hold_minutes: 5 }, "phone"), { minutes: 5 });
  assert.equal(holdOf({}, "desktop"), undefined);
  for (const kind of ["none", "browser"]) {
    const issue = holdOf({ hold: true }, kind);
    assert.deepEqual([issue.field, issue.reason], ["hold", "not_an_option"], kind);
  }
});

test("the protocol's methods are the spec's, and a call row names one with object params and answers no park", async () => {
  const spec = JSON.parse(readFileSync(new URL("../../../spec/computer/protocol.json", import.meta.url), "utf8"));
  assert.deepEqual([...PROTOCOL_METHODS].sort(), spec.methods.map((method) => method.name ?? method).sort());
  const sink = { command: async (runId, command) => ({ id: 1, runId, ...command }) };
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_call", body: { answers: false } }), /names its protocol method/);
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_call", body: { method: "hello" } }), /answers no park/);
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_call", body: { method: "hello", params: [], answers: false } }), /params are an object/);
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_start", body: { x: 1 } }), /carries nothing/);
  assert.equal((await sendCommand(sink, "run-1", { kind: "computer_release" })).kind, "computer_release");
});

test("served: hold on a run's create, the run read's computer.held, and the three routes, each refusing in words where the run is not up", async (t) => {
  // A Docker sandbox, on a fake `docker` first on PATH that answers the server's start-time probe: no Docker command runs.
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\nif [ \"$1\" = version ]; then echo 27.0.0-fake; fi\nexit 0\n", { mode: 0o755 });
  withEnv(t, { PATH: [bin, process.env.PATH ?? ""].join(delimiter) }, ["AGENTRUN_BOXES"]);
  const { api } = await serve(t, { runner: false });
  const desk = await api("POST", "/agents", { definition: { id: "desk", name: "desk", instructions: "Do it.", computer: { kind: "sandbox", provider: "docker" } } });
  assert.equal(desk.status, 201, JSON.stringify(desk.body));
  assert.equal((await api("POST", "/agents", { definition: { id: "plain", name: "plain", instructions: "Do it.", computer: { kind: "none" } } })).status, 201);
  const fields = (answer) => [answer.status, answer.body.error?.fields?.map((one) => [one.field, one.reason])];

  assert.deepEqual(fields(await api("POST", "/agents/plain/runs", { input: { content: "x" }, hold: true })), [422, [["hold", "not_an_option"]]], "an agent with no computer holds none");
  assert.deepEqual(fields(await api("POST", "/agents/desk/runs", { input: { content: "x" }, hold: true, hold_minutes: HOLD_MAX_MINUTES + 1 })), [422, [["hold_minutes", "not_an_option"]]]);
  assert.deepEqual(fields(await api("POST", "/agents/desk/runs", { input: { content: "x" }, hold: "yes" })), [422, [["hold", "wrong_type"]]]);
  assert.deepEqual(fields(await api("POST", "/agents/desk/runs", { input: { content: "x" }, hold_minutes: 5 })), [422, [["hold_minutes", "not_an_option"]]]);

  const held = await api("POST", "/agents/desk/runs", { input: { content: "Do the task." }, hold: true, hold_minutes: 5 });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  const id = held.body.run_id;
  assert.deepEqual((await api("GET", `/runs/${id}`)).body.computer.held, { state: "starting", minutes: 5 }, "no runner claimed it: its computer is not up");
  for (const [path, body, words] of [["start", {}, /not up yet/], ["computer/call", { method: "hello" }, /not up now/], ["computer/release", {}, /not up yet/]]) {
    const said = await api("POST", `/runs/${id}/${path}`, body);
    assert.deepEqual([said.status, said.body.error.code], [409, "computer_not_live"], path);
    assert.match(said.body.error.message, words);
    const none = await api("POST", `/runs/run-404/${path}`, body);
    assert.equal(none.status, 404, `${path} of no run`);
  }
  assert.deepEqual(fields(await api("POST", `/runs/${id}/computer/call`, { method: "screen.capture" })), [422, [["method", "not_an_option"]]]);

  const plain = await api("POST", "/agents/desk/runs", { input: { content: "Do the task." } });
  assert.equal((await api("GET", `/runs/${plain.body.run_id}`)).body.computer.held, undefined, "a run with no hold has no held field");
  const notHeld = await api("POST", `/runs/${plain.body.run_id}/start`, {});
  assert.deepEqual([notHeld.status, notHeld.body.error.code], [404, "not_found"]);
  const call = await api("POST", `/runs/${plain.body.run_id}/computer/call`, { method: "hello" });
  assert.deepEqual([call.status, call.body.error.code], [409, "computer_not_live"], "a run that holds nothing takes calls too, once it is up");
});
