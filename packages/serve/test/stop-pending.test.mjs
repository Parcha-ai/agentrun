// A run whose turn a person stopped says so in its read: GET /v2/runs/{id} and its item in the run list carry `pending`
// kind stopped beside status input_required and state idle, the kind the run.needs_input webhook tells for that stop (once,
// across a restart, and never a run.ended: the stop is a wait the run stands at), so an API reader can tell a stopped run
// from one stuck. The same pair also covers a turn its harness ended on its own:
// that one reads nothing pending, and the webhook names no kind for it. A run parked on its approval reads kind approval,
// and a stopped run a message continued no longer reads stopped. pi and codex (the faux CLI harness) on the faux model;
// no socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { agent, follow, retried, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { ofType, PRIVATE_OK, receiver } from "./webhook-support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), harnessTable: fauxTable(fixture("faux-gate.mjs")), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true, ...PRIVATE_OK };
const PAGE = "http://public.example/";

/** Agent `id` on `harness` that fetches PAGE once with web_fetch (set to ask, so its run parks), and one run of it. */
async function fetching(api, id, harness) {
  const ask = `Fetch ${PAGE} once.`;
  const made = await retried(api)("POST", "/agents", agent(id, { harness, instructions: ask, tools: ["web_fetch"] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await retried(api)("POST", `/agents/${id}/runs`, { input: { content: ask } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

/** Run `runId` as GET /runs/{id} reads it and as its item in GET /runs reads it: status, state and pending, each. */
async function reads(api, runId) {
  const one = (await api("GET", `/runs/${runId}`)).body;
  const item = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  assert.ok(item, `run ${runId} is in the list`);
  return { one: [one.status, one.state, one.pending], listed: [item.status, item.state, item.pending] };
}

/** Reads run `runId` until `done` holds of its read, within `deadlineMs`. */
async function until(api, runId, done, what, deadlineMs = 30_000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const seen = await reads(api, runId);
    if (done(seen)) return seen;
    assert.ok(Date.now() < end, `run ${runId}: ${what}; it reads ${JSON.stringify(seen)}`);
    await sleep(200);
  }
}

/** The kind the newest run.needs_input for run `runId` names (null when it names none). */
const toldKind = (hook, runId) => {
  const told = ofType(hook.got, "run.needs_input").map((r) => JSON.parse(r.body).data).filter((data) => data.run_id === runId);
  return told.length ? (told.at(-1).pending?.kind ?? null) : undefined;
};

for (const harness of ["pi", "codex"]) {
  test(`${harness}: a run stopped while parked on its approval reads input_required, idle and pending kind stopped, in its read and in the list, the kind its run.needs_input tells; a message continues it, and it reads stopped no more`, { timeout: 150_000 }, async (t) => {
    withEnv(t, { FAUX_WEB_LOG: join(await scratch(t), "dialled.txt") });
    const hook = await receiver(t);
    const first = await serve(t, GATE);
    const { api } = first;
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
    const runId = await fetching(api, `stop-${harness}`, harness);
    await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });

    // Parked on its approval: kind approval, as today, and the webhook tells approval.
    const parked = await until(api, runId, ({ one }) => one[2]?.kind === "approval", "parked on its approval");
    assert.deepEqual([parked.one.slice(0, 2), parked.listed.slice(0, 2), parked.listed[2]?.kind], [["input_required", "waiting"], ["input_required", "waiting"], "approval"]);
    await hook.when(() => toldKind(hook, runId) === "approval", `${harness}: run.needs_input approval`);

    const stop = await api("POST", `/runs/${runId}/stop`, {});
    assert.deepEqual([stop.status, stop.body.stopped], [200, true], JSON.stringify(stop.body));
    const stopped = await until(api, runId, ({ one }) => one[1] === "idle", "stopped");
    assert.deepEqual(stopped, { one: ["input_required", "idle", { kind: "stopped" }], listed: ["input_required", "idle", { kind: "stopped" }] }, `${harness}: the stop reads stopped`);
    await hook.when(() => toldKind(hook, runId) === "stopped", `${harness}: run.needs_input stopped`);
    assert.equal(toldKind(hook, runId), stopped.one[2].kind, "the webhook's kind is the read's");
    // A stop is a wait the run stands at, never its end: no run.ended for it, and the next server tells it no more. One
    // message per webhook-id (a try the closing server never saw answered is tried again under the same id).
    const told = () => [...new Map(hook.got.map((r) => [r.headers["webhook-id"], JSON.parse(r.body)])).values()].filter((b) => b.data.run_id === runId).map((b) => [b.type, b.data.status, b.data.pending?.kind ?? null]);
    await first.close();
    const again = await serve(t, { ...GATE, data: first.data, openSetup: false });
    await sleep(2_000);
    assert.deepEqual(told(), [["run.needs_input", "input_required", "approval"], ["run.needs_input", "input_required", "stopped"]], `${harness}: told once each, across a restart`);
    const api2 = again.api;
    assert.deepEqual((await reads(api2, runId)).one, ["input_required", "idle", { kind: "stopped" }], "read the same after the restart");

    assert.equal((await api2("POST", `/runs/${runId}/messages`, { content: "Go on, please." })).status, 202);
    const moved = await until(api2, runId, ({ one }) => one[0] !== "input_required" || one[1] === "waiting", "continued by the message", 55_000);
    assert.notEqual(moved.one[2]?.kind, "stopped", `${harness}: continued, it no longer reads stopped`);
    assert.notEqual(moved.listed[2]?.kind, "stopped", `${harness}: nor in the list`);
  });
}

test("a run whose harness ended its turn on its own, with no stop, reads input_required and idle with nothing pending, in its read and in the list, and its run.needs_input names no kind", { timeout: 60_000 }, async (t) => {
  const hook = await receiver(t);
  const server = await serve(t, { ...PRIVATE_OK, runner: false });
  const { api, store } = server;
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await store.agents.create({ id: "alone", name: "alone" }, { id: "alone-rev", kind: "agentic", body: { instructions: "Answer." } });
  // Its turn opened and ended interrupted (a CLI turn's records), no stop asked of it; let go as parked, as a runner does.
  const ROOT = 1;
  await store.runs.create({ id: "run-alone", agentId: "alone", revisionId: "alone-rev" }, { body: { input: { message: "Help me." }, title: "Ended alone", place: { mode: "runner" } } });
  const claim = await store.claim("run-alone", "test-runner", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Help me.", timestamp: Date.now() }] };
  const start = { id: await journal.mintId(), conversationId: ROOT, kind: KINDS.turnStart, data: { at: Date.now() } };
  const end = { id: await journal.mintId(), conversationId: ROOT, kind: KINDS.turnEnd, data: { status: "interrupted" } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: user }, { type: "entry", value: start }, { type: "entry", value: end }], BACKGROUND_CONTEXT);
  await store.release(claim, { state: "parked", wakeAt: null });

  const seen = await reads(api, "run-alone");
  assert.deepEqual(seen, { one: ["input_required", "idle", null], listed: ["input_required", "idle", null] }, "nothing pending: no one stopped it");
  await hook.when(() => toldKind(hook, "run-alone") !== undefined, "run.needs_input of run-alone");
  assert.equal(toldKind(hook, "run-alone"), null, "its notice names no kind, as its read has none");
});
