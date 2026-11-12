// A held computer (computer-held.ts): a run started with hold: true claims its computer and waits, its agent not started,
// until its owner starts it; the owner's protocol calls reach the computer before the start and after the agent's end;
// the run keeps the computer after the end until the owner releases it, or until no call came for the hold's minutes.
//
// The run is pi through the adapter loop on a runner, its spec carrying `held` (a computer client of the test's own that
// records each call). The routes are called as serve's dispatch calls them (heldRoute, with the server's store), and the
// run read's field as GET /runs/{id} adds it (heldField). The runner's hold is unit-tested on its own for its lapse and for
// a claim that lost the computer it held.
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
const { HOLD_MAX_MINUTES, HOLD_MINUTES, heldIn, holdIssues, holdOf, PROTOCOL_METHODS } = await import("../dist/computer-held.js");
const { journalHeld } = await import("../dist/runner/held-run.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { ApiError } = await import("../dist/errors.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 15_000;
const FAST = { pollMs: 20, waitMs: 10_000, context: ctx };
after(closeOpenSessions);

/** A computer client that answers every call with what it was asked, and records each. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "hello") return { ok: true, value: { protocol: "0.2", groups: ["screen", "ui"] } };
      if (method === "files.read") return { ok: false, error: { code: "not_found", message: `no file ${params.path}` } };
      return { ok: true, value: { method, params } };
    },
    close() {},
  };
}

async function setup(t, { hold = { minutes: 1 }, launch = true } = {}) {
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
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, launch ? { body } : undefined);
  const until = async (check, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = await check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** A route's answer, or its refusal as { status, code, message }. */
  const route = (name, body = {}) => heldRoute(name, "run-1", body, server, FAST).then((answer) => ({ answer }), (error) => {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  });
  const field = () => heldField(server, "run-1", FAST);
  const state = async () => (await field())?.state;
  const row = () => server.runs.get("run-1");
  /** The run on a runner: the agent looks once (its look counted) and answers. Its spec holds the computer `client`. */
  const start = async (client = fakeClient(), minutes = 1) => {
    const looks = [];
    const look = { name: "look", replaySafe: true, run: async () => (looks.push(Date.now()), "a grey screen") };
    const spec = piAdapterSpec({ script: [{ call: "look" }, { say: "done" }], tools: { look }, hooks: quiet });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    runners.push(startRunner({ store, createLoop: createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), agentId: "agent-1", held: { client, minutes } })), name: "runner-a", ...TIMING }));
    return { client, looks };
  };
  const phases = async () => (await runTimeline(server, "run-1", ctx)).map((one) => one.summary).filter(Boolean);
  return { server, route, field, state, row, start, until, phases };
}

test("a held run: the owner's calls set the computer up before the start, the agent runs once started, and the run keeps the computer after its end until released", async (t) => {
  const world = await setup(t);
  assert.deepEqual(await world.field(), { state: "starting", minutes: 1 }, "no runner yet: the hold is not up");
  const early = await world.route("callRunComputer", { method: "hello" });
  assert.deepEqual([early.status, early.code], [409, "computer_not_live"], "a call before the computer is up is refused");

  const run = await world.start();
  await world.until(async () => (await world.state()) === "waiting", "the computer is up and held");
  const waiting = await world.field();
  assert.ok(Date.parse(waiting.until) > Date.now(), `the hold lapses later: ${JSON.stringify(waiting)}`);

  // Before the start: the owner's calls reach the computer, answered verbatim, and the agent has not run.
  assert.deepEqual(await world.route("callRunComputer", { method: "hello" }), { answer: { ok: true, value: { protocol: "0.2", groups: ["screen", "ui"] } } });
  assert.deepEqual(await world.route("callRunComputer", { method: "exec.run", params: { argv: ["true"] } }), { answer: { ok: true, value: { method: "exec.run", params: { argv: ["true"] } } } });
  assert.deepEqual(await world.route("callRunComputer", { method: "files.read", params: { path: "/nope" } }), { answer: { ok: false, error: { code: "not_found", message: "no file /nope" } } }, "an error answer is the computer's, verbatim, with 200");
  assert.deepEqual(run.looks, [], "the agent waits for the start");
  assert.equal(await world.state(), "waiting");

  assert.deepEqual(await world.route("startRun"), { answer: { held: { state: "started" } } });
  const again = await world.route("startRun");
  assert.deepEqual([again.status, again.code], [409, "computer_not_live"], "a second start is refused");
  assert.match(again.message, /already started/);

  // After the agent's end the run keeps its computer: still going, and the owner's calls still reach it.
  await world.until(async () => (await world.state()) === "ended", "the agent is done, the computer kept");
  assert.equal(run.looks.length, 1, "the agent ran once started");
  assert.equal((await world.row()).state, "running", "the run waits for the release");
  assert.deepEqual(await world.route("callRunComputer", { method: "ui.observe", params: { app: "x" } }), { answer: { ok: true, value: { method: "ui.observe", params: { app: "x" } } } });

  assert.deepEqual(await world.route("releaseRunComputer"), { answer: { held: { state: "released" } } });
  await world.until(async () => (await world.row()).state === "ended", "the run ends once released");
  assert.equal((await world.row()).outcome, null, "it ends as its agent did: a plain completion");
  assert.deepEqual(run.client.calls.map((call) => call.method), ["hello", "exec.run", "files.read", "ui.observe"], "only the owner's calls went to the held computer's client");

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
  await world.until(async () => (await world.state()) === "waiting", "the computer is up and held");
  assert.deepEqual(await world.route("releaseRunComputer"), { answer: { held: { state: "released" } } });
  await world.until(async () => ["ended", "stopped", "failed"].includes((await world.row()).state), "the run ends");
  const ended = await world.row();
  assert.deepEqual([ended.state, ended.outcome], ["stopped", "cancelled"]);
  assert.deepEqual(run.looks, [], "the agent never ran");
});

test("the routes refuse in words: a run that holds no computer, a method the protocol lacks, a body field they keep none of", async (t) => {
  const world = await setup(t, { hold: false });
  for (const name of ["startRun", "callRunComputer", "releaseRunComputer"]) {
    const said = await world.route(name, name === "callRunComputer" ? { method: "hello" } : {});
    assert.deepEqual([said.status, said.code], [404, "not_found"], name);
    assert.match(said.message, /holds no computer: a run started with hold: true holds one/);
  }
  const issues = (error) => [error.status, error.extra?.fields?.map((one) => [one.field, one.reason])];
  // A body's issues come before the hold is read: a 422, whatever run it names.
  const wrong = await heldRoute("callRunComputer", "run-1", { method: "screen.capture" }, world.server, FAST).catch((error) => error);
  assert.deepEqual(issues(wrong), [422, [["method", "not_an_option"]]]);
  const extra = await heldRoute("startRun", "run-1", { now: true }, world.server, FAST).catch((error) => error);
  assert.deepEqual(issues(extra), [422, [["now", "not_allowed"]]]);
  const params = await heldRoute("callRunComputer", "run-1", { method: "hello", params: [] }, world.server, FAST).catch((error) => error);
  assert.deepEqual(issues(params), [422, [["params", "wrong_type"]]]);
  assert.equal(await world.field(), undefined, "the run read has no held field for a run that holds none");
});

test("the hold lets the computer go when no call comes for its minutes, and a new claim finds the hold it had gone with its computer", async () => {
  const written = [];
  let clock = 1_000;
  const commit = async (entries) => void written.push(...entries);
  const minutes = 0.01; // 600 ms
  const held = journalHeld({ client: fakeClient(), minutes }, commit, () => clock);
  assert.equal(await held.up([], true), "held");
  assert.deepEqual(written.map((one) => [one.kind, one.data.state]), [["computer.held", "waiting"], ["agentrun.phase", undefined]]);
  // A call starts the count again.
  clock += 500;
  const decided = await held.decide({ id: 7, kind: "computer_call", body: { method: "ping", params: {} } });
  await decided.write();
  assert.equal(heldIn(written).until, 1_500 + minutes * 60_000, "the journal reads the lapse from the last call");
  clock += 700;
  assert.equal(await held.untilStarted(new Promise(() => {})), "moved");
  assert.deepEqual([held.state(), held.lapse()], ["released", "timeout"]);
  assert.deepEqual(heldIn(written), { state: "released", minutes, until: 2_200 + minutes * 60_000, why: "timeout" });
  assert.match(written.at(-1).data.summary, /no call came from its owner/);
  const refused = await held.decide({ id: 8, kind: "computer_start", body: {} });
  assert.match(refused.refused, /let go: no call came/);

  // A new claim of a run whose hold was waiting: its computer is not the one held.
  const lost = [];
  const again = journalHeld({ client: fakeClient(), minutes: 1 }, async (entries) => void lost.push(...entries), () => 5_000);
  assert.equal(await again.up([{ kind: "computer.held", data: { state: "waiting", at: 1_000, minutes: 1 } }], true), "lost");
  assert.deepEqual(lost[0].data, { state: "released", at: 5_000, minutes: 1, why: "lost" });
  // A restart within the claim keeps the hold where it was.
  const kept = journalHeld({ client: fakeClient(), minutes: 1 }, async () => {}, () => 5_000);
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

test("the protocol's methods are the spec's, and a call row names one with object params", async () => {
  const spec = JSON.parse(readFileSync(new URL("../../../spec/computer/protocol.json", import.meta.url), "utf8"));
  assert.deepEqual([...PROTOCOL_METHODS].sort(), spec.methods.map((method) => method.name ?? method).sort());
  const sink = { command: async (runId, command) => ({ id: 1, runId, ...command }) };
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_call", body: {} }), /names its protocol method/);
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_call", body: { method: "hello", params: [] } }), /params are an object/);
  await assert.rejects(sendCommand(sink, "run-1", { kind: "computer_start", body: { x: 1 } }), /carries nothing/);
  assert.equal((await sendCommand(sink, "run-1", { kind: "computer_release" })).kind, "computer_release");
});

test("served: hold on a run's create, the run read's computer.held, and the three routes, each refusing in words where the hold is not", async (t) => {
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
  for (const [path, body] of [["start", {}], ["computer/call", { method: "hello" }], ["computer/release", {}]]) {
    const said = await api("POST", `/runs/${id}/${path}`, body);
    assert.deepEqual([said.status, said.body.error.code], [409, "computer_not_live"], path);
    assert.match(said.body.error.message, /not up yet/);
    const none = await api("POST", `/runs/run-404/${path}`, body);
    assert.equal(none.status, 404, `${path} of no run`);
  }
  assert.deepEqual(fields(await api("POST", `/runs/${id}/computer/call`, { method: "screen.capture" })), [422, [["method", "not_an_option"]]]);

  const plain = await api("POST", "/agents/desk/runs", { input: { content: "Do the task." } });
  assert.equal((await api("GET", `/runs/${plain.body.run_id}`)).body.computer.held, undefined, "a run with no hold has no held field");
  const notHeld = await api("POST", `/runs/${plain.body.run_id}/start`, {});
  assert.deepEqual([notHeld.status, notHeld.body.error.code], [404, "not_found"]);
});
