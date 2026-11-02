// The bound a run's end keeps beside a cost no one knows (carryBack's `atMostUsd`, run_cost_bounds): read back with the run,
// counted in stats and in analytics totals as runs of unknown cost with a bound, never added to a known sum, and absent on
// a store written before the table.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore, openStoreReader } from "../dist/index.js";
import { scratch } from "./support.mjs";

const A = { kind: "agentic", instructions: "Answer." };

async function storeWith(...agents) {
  const dir = await scratch();
  const store = openStore(dir);
  for (const id of agents) {
    store.createAgent({ name: id, id });
    await store.commitRevision(id, A, { setCurrent: true });
  }
  const run = async (agent, end) => {
    const { runId } = await store.startRun({ agent });
    if (end) store.carryBack(runId, end);
    return runId;
  };
  return { dir, store, run };
}

test("a bound is kept beside an unknown cost and read back with the run; beside a known cost it is not kept", async () => {
  const { store, run } = await storeWith("chat");
  const cut = await run("chat", { state: "completed", atMostUsd: 1.64 });
  const known = await run("chat", { state: "completed", costUsd: 0.25, atMostUsd: 9 });
  assert.deepEqual([store.readRun(cut).costUsd, store.readRun(cut).atMostUsd], [undefined, 1.64]);
  assert.deepEqual([store.readRun(known).costUsd, store.readRun(known).atMostUsd], [0.25, undefined]);
  assert.deepEqual(store.listRuns({ agent: "chat" }).map((r) => [r.id, r.atMostUsd]).sort(), [[cut, 1.64], [known, undefined]].sort());
});

test("a run opened again ends again with its latest: a known cost drops the bound, a new bound replaces it", async () => {
  const { store, run } = await storeWith("chat");
  const id = await run("chat", { state: "completed", atMostUsd: 1 });
  store.reopenRun(id);
  store.carryBack(id, { state: "completed", atMostUsd: 2 });
  assert.equal(store.readRun(id).atMostUsd, 2);
  store.reopenRun(id);
  store.carryBack(id, { state: "completed", costUsd: 0.5 });
  assert.deepEqual([store.readRun(id).costUsd, store.readRun(id).atMostUsd], [0.5, undefined]);
});

test("a bound that is not a number of at least 0 is refused, and the run stays as it was", async () => {
  const { store, run } = await storeWith("chat");
  const id = await run("chat");
  for (const atMostUsd of [-1, Number.NaN, "1"]) assert.throws(() => store.carryBack(id, { state: "completed", atMostUsd }), (e) => e instanceof AgentHomeError && e.code === "invalid");
  assert.equal(store.readRun(id).state, "running");
});

test("stats count the runs of unknown cost with a bound, and sum their bounds apart from the known sum; archived runs are left out", async () => {
  const { store, run } = await storeWith("chat", "coder");
  await run("chat", { state: "completed", costUsd: 0.25 });
  await run("chat", { state: "completed", atMostUsd: 1.5 });
  await run("coder", { state: "failed", atMostUsd: 0.5 });
  await run("coder", { state: "failed" });
  const archived = await run("coder", { state: "completed", atMostUsd: 7 });
  store.setArchived("run", archived, true);
  assert.deepEqual(store.stats().cost, { usd: 0.25, known: 1, unknown: 3, boundedUnknown: { runs: 2, atMostUsd: 2 } });
});

test("analytics totals count, under the query's agent and dates, only that agent's runs of unknown cost with a bound in range", async () => {
  const { dir, store, run } = await storeWith("chat", "coder");
  const at = {
    chatIn: await run("chat", { state: "completed", atMostUsd: 1 }),
    chatKnown: await run("chat", { state: "completed", costUsd: 0.3 }),
    chatBefore: await run("chat", { state: "completed", atMostUsd: 10 }),
    chatAfter: await run("chat", { state: "completed", atMostUsd: 100 }),
    coderIn: await run("coder", { state: "completed", atMostUsd: 1000 }),
  };
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  const when = { chatIn: "2026-10-02T09:00:00.000Z", chatKnown: "2026-10-02T10:00:00.000Z", chatBefore: "2026-09-30T09:00:00.000Z", chatAfter: "2026-10-05T09:00:00.000Z", coderIn: "2026-10-02T11:00:00.000Z" };
  for (const [key, started] of Object.entries(when)) db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(started, at[key]);
  db.close();
  const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z" };
  assert.deepEqual(store.analytics({ ...range, agent: "chat" }).totals.boundedUnknown, { runs: 1, atMostUsd: 1 }, "chat's one bounded run in range; its known run and those outside are not counted");
  assert.deepEqual(store.analytics(range).totals.boundedUnknown, { runs: 2, atMostUsd: 1001 }, "every agent's in range");
  assert.deepEqual(store.analytics({ agent: "chat" }).totals.boundedUnknown, { runs: 3, atMostUsd: 111 }, "chat's at any date");
  assert.deepEqual(store.analytics({ ...range, agent: "nobody" }).totals.boundedUnknown, { runs: 0, atMostUsd: null });
});

test("a store written before run_cost_bounds reads no bound, and its stats and analytics count none", async () => {
  const { dir, store, run } = await storeWith("chat");
  const id = await run("chat", { state: "completed", atMostUsd: 3 });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("DROP TABLE run_cost_bounds");
  db.close();
  const reader = openStoreReader(dir);
  assert.equal(reader.readRun(id).atMostUsd, undefined);
  assert.deepEqual(reader.stats().cost.boundedUnknown, { runs: 0, atMostUsd: null });
  assert.deepEqual(reader.analytics().totals.boundedUnknown, { runs: 0, atMostUsd: null });
  reader.close();
});
