// Runs.healCost and Runs.costUnknown, on the store itself (SQLite here, Postgres under `npm run test:pg`): an ended run's
// unknown stored cost becomes the figure its booking gives in one conditional write, only from null, only at the end it
// was read at, so a stored figure is never written over and a run ended again since keeps what its end wrote. The run
// read heals through it (store-view.ts storeRunOf), and the server's start sweep reads what costUnknown lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { healedOverStore, viewOverStore } = await import("../dist/store-view.js");
const { listRuns } = await import("../dist/store-reads/runs.js");
const { stats } = await import("../dist/store-reads/stats.js");
const { agentCostOverStore } = await import("../dist/store-reads/learning.js");
const { healEndedCosts } = await import("../dist/cost-heal.js");

const ROOT = 1;
const deps = { origin: "https://run.test", serverSecrets: () => [] };

/** A native connection a launch names (native/binding.ts nativeBindingOf reads it): the run's end reads its own cost. */
const NATIVE = { runtime: "codex", project: "/fixture/project", selector: { kind: "profile", name: "review" }, machine_id: "test-machine", version: "0.167.2", model: null, fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], capabilities: { launch: true, learning: true, workflows: false, approval: "unavailable", usage: true }, connected: true };

/** Run `id` of agent-1, a CLI run whose two requests were booked at $0.01 and $0.02, ended with `costUsd` stored (null:
 *  its end could not read the booking), or left running with `ended` false. `booked` false: no request booked at all.
 *  `native`: its launch names a native connection. `stopped`: a person's stop ended its turn (state and outcome
 *  `stopped`), which reads running (store.ts stoppedByPerson). */
async function seeded(store, id, { costUsd = null, ended = true, booked = true, native = false, stopped = false } = {}) {
  if (!(await store.agents.get("agent-1"))) await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "claude-agent" } });
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "t", place: { mode: "runner" }, ...(native ? { native: NATIVE } : {}) } });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const HARNESS = await journal.mintId();
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "harness", conversation: HARNESS } } });
  for (const text of ["Hi", "Done."]) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.message", data: { role: text === "Hi" ? "person" : "model", text } } });
  for (const [turn, usd] of booked ? [[1, 0.01], [2, 0.02]] : []) {
    writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind: "runner.request", data: { turn, model: "m", heldUsd: 0.04 } } });
    writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind: "runner.turn", data: { turn, usd, bookedUsd: usd, rule: "answered" } } });
  }
  const state = stopped ? "stopped" : "ended";
  if (ended) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.end", data: { state, summary: "done", costUsd } } });
  await commitWrites(journal, writes, ctx);
  if (ended) await store.runs.update(claim, { state, outcome: stopped ? "stopped" : "completed", summary: "done", costUsd, endedAt: T0 + 10 });
}

const near = (got, want) => typeof got === "number" && Math.abs(got - want) < 1e-9;

test("healCost writes a figure only over an ended run's unknown cost, only at the end it was read at, and once", async (t) => {
  const { store } = await storeOn(t);
  await seeded(store, "run-1");
  const row = await store.runs.get("run-1");
  const at = { epoch: row.epoch, endedAt: row.endedAt };
  assert.equal(await store.runs.healCost("run-1", { ...at, endedAt: at.endedAt + 1 }, 0.03), false, "another end: nothing written");
  assert.equal(await store.runs.healCost("run-1", { ...at, epoch: at.epoch + 1 }, 0.03), false, "another epoch: nothing written");
  assert.equal((await store.runs.get("run-1")).costUsd, null);
  assert.equal(await store.runs.healCost("run-1", at, 0.03), true);
  assert.ok(near((await store.runs.get("run-1")).costUsd, 0.03));
  assert.equal(await store.runs.healCost("run-1", at, 0.5), false, "never over a stored figure");
  assert.ok(near((await store.runs.get("run-1")).costUsd, 0.03));
  await assert.rejects(store.runs.healCost("run-1", at, -1), TypeError);
});

test("healCost never writes a run still going, and costUnknown lists only ended runs whose stored cost is unknown", async (t) => {
  const { store } = await storeOn(t);
  await seeded(store, "run-a");
  await seeded(store, "run-b", { costUsd: 0.3 });
  await seeded(store, "run-c", { ended: false });
  await seeded(store, "run-d");
  const going = await store.runs.get("run-c");
  assert.equal(await store.runs.healCost("run-c", { epoch: going.epoch, endedAt: T0 + 10 }, 0.03), false, "a run still going");
  assert.deepEqual(await store.runs.costUnknown({ limit: 10 }), ["run-a", "run-d"]);
  assert.deepEqual(await store.runs.costUnknown({ limit: 1 }), ["run-a"], "a page");
  assert.deepEqual(await store.runs.costUnknown({ limit: 10, after: "run-a" }), ["run-d"], "after the page's last id");
});

test("healCost never writes a run whose stored cost carries a bound, even called directly, and costUnknown never lists it", async (t) => {
  const { store, file } = await storeOn(t);
  await seeded(store, "run-1");
  // A null cost beside a bound (cost_upper_bound 1): no end writes it (a cost written null writes the bound 0), so the
  // row is made here. The heal's own statement keeps to "no bound", whatever its caller read.
  const db = await raw(file);
  t.after(() => db.close());
  assert.equal((await db.run("UPDATE runs SET cost_upper_bound = 1 WHERE id = ?", "run-1")).changes, 1);
  const row = await store.runs.get("run-1");
  assert.equal(await store.runs.healCost("run-1", { epoch: row.epoch, endedAt: row.endedAt }, 0.03), false, "a bound: nothing written");
  assert.deepEqual(await db.get("SELECT cost_usd, cost_upper_bound FROM runs WHERE id = ?", "run-1"), { cost_usd: null, cost_upper_bound: 1 });
  assert.deepEqual(await store.runs.costUnknown({ limit: 10 }), [], "not listed for the sweep");
});

test("costUnknown leaves out the ended runs that never heal (native, no request booked, a person's stop), so the sweep reads only the healable, a page at a time", async (t) => {
  const { store } = await storeOn(t);
  const never = { "run-native": { native: true }, "run-unbooked": { booked: false }, "run-stopped": { stopped: true } };
  for (const [id, options] of Object.entries(never)) await seeded(store, id, options);
  for (const id of ["run-a", "run-m", "run-z"]) await seeded(store, id);
  // Each left out is one the rule itself never heals: its own heal writes nothing.
  for (const id of Object.keys(never)) {
    assert.equal(await healedOverStore(store, id), false, `${id} never heals`);
    assert.equal((await store.runs.get(id)).costUsd, null);
  }
  assert.deepEqual(await store.runs.costUnknown({ limit: 10 }), ["run-a", "run-m", "run-z"]);
  assert.deepEqual(await store.runs.costUnknown({ limit: 2 }), ["run-a", "run-m"], "a page");
  assert.deepEqual(await store.runs.costUnknown({ limit: 2, after: "run-m" }), ["run-z"], "after the page's last id");
  assert.deepEqual(await healEndedCosts(store, { page: 2 }), { read: 3, healed: 3, failed: 0 });
  for (const id of ["run-a", "run-m", "run-z"]) assert.ok(near((await store.runs.get(id)).costUsd, 0.03), id);
  assert.deepEqual(await healEndedCosts(store), { read: 0, healed: 0, failed: 0 }, "the never-healable are not read again");
});

test("the run read heals the store: the stored cost, the list, the stats and the learning bill read the booked total after it", async (t) => {
  const { store } = await storeOn(t);
  await seeded(store, "run-1");
  const before = await agentCostOverStore(store, "agent-1");
  assert.deepEqual([before.unknown_cost_runs, before.bill.unattributed_usd], [1, null], "unknown before the read");
  assert.ok(near((await viewOverStore(store, "run-1", deps)).cost.usd, 0.03));
  assert.ok(near((await store.runs.get("run-1")).costUsd, 0.03), "the read wrote it back");
  assert.ok(near((await listRuns(store, { agent: "agent-1" }, ctx)).find((one) => one.id === "run-1")?.costUsd, 0.03), "the list");
  assert.ok(near((await stats(store)).cost.usd, 0.03), "the stats");
  const bill = await agentCostOverStore(store, "agent-1");
  assert.ok(near(bill.runs[0]?.cost_usd, 0.03) && bill.unknown_cost_runs === 0 && bill.bill.unattributed_usd === 0, `the learning bill: ${JSON.stringify(bill.bill)}`);
  assert.deepEqual(await store.runs.costUnknown({ limit: 10 }), [], "nothing left for the sweep");
});

test("the sweep heals by the run read's rule: the unknown cost becomes its booking's figure, a stored figure stays, and a second sweep reads nothing", async (t) => {
  const { store } = await storeOn(t);
  await seeded(store, "run-1");
  await seeded(store, "run-2", { costUsd: 0.3 });
  assert.deepEqual(await healEndedCosts(store), { read: 1, healed: 1, failed: 0 });
  assert.ok(near((await store.runs.get("run-1")).costUsd, 0.03));
  assert.equal((await store.runs.get("run-2")).costUsd, 0.3);
  assert.ok(near((await viewOverStore(store, "run-1", deps)).cost.usd, 0.03), "the run read reads what the sweep wrote");
  assert.deepEqual(await healEndedCosts(store), { read: 0, healed: 0, failed: 0 });
});

test("the sweep reads a page at a time, counts a run whose read fails and goes on, and stops between runs when told", async () => {
  // A store of five unknown-cost ids whose run reads find no run, the third's read failing.
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  const pages = [];
  const over = (runs) => {
    const store = { runs, snapshot: (read) => read(store) };
    return store;
  };
  const runs = {
    costUnknown: async ({ limit, after }) => {
      pages.push([limit, after]);
      return ids.filter((id) => after === undefined || id > after).slice(0, limit);
    },
    get: async (id) => {
      if (id === "r3") throw new Error("unreadable");
      return undefined;
    },
  };
  assert.deepEqual(await healEndedCosts(over(runs), { page: 2 }), { read: 5, healed: 0, failed: 1 });
  assert.deepEqual(pages, [[2, undefined], [2, "r2"], [2, "r4"]]);
  let reads = 0;
  assert.deepEqual(await healEndedCosts(over({ ...runs, get: async () => void (reads += 1) }), { page: 2, stopped: () => reads >= 2 }), { read: 2, healed: 0, failed: 0 });
});
