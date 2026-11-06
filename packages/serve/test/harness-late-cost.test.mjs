// A harness request written before its cost came in (BOOKED unpriced), its process gone before that cost did: the next
// open books it (bookCut) and writes its late entry (harness-app.ts priceLate, REQUEST_COST_LATE at usd null) before that
// process sends any new request, so its bound leaves the served in-flight figure; a run no process holds serves none.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_COST_LATE, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { RequestBounds } from "../dist/bounds.js";
import { agent, follow, letGo, runDir, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SONNET_PRICED = new URL("./fixtures/faux-sonnet-priced.mjs", import.meta.url).pathname;

test("a request booked before its cost, its process gone: the next open writes its late entry (usd null) before any new request, and the bounds read it out of flight", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: SONNET_PRICED });
  const never = join(await scratch(t), "never");
  assert.equal((await api("POST", "/agents", agent("late", { harness: "claude-agent", instructions: `Grow, then answer with its cost booked when ${never} exists.` }))).status, 201);
  const run = (await api("POST", "/agents/late/runs", { input: { content: "go" }, max_cost_usd: 5 })).body;
  await follow(api, run.run_id, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
  await letGo(data, run.run_id);
  const read = () => {
    const db = new DatabaseSync(join(runDir(data, run.run_id), "store", "run.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT id, record FROM entries ORDER BY rowid").all().map((row) => ({ ...JSON.parse(String(row.record)), id: Number(row.id) })); } finally { db.close(); }
  };
  const before = read();
  const booked = before.find((e) => e.kind === "adapter.request" && e.data?.request === 2);
  assert.equal(booked?.data?.unpriced, true, `request 2 was written before its cost: ${JSON.stringify(booked)}`);
  assert.ok(!before.some((e) => e.kind === REQUEST_COST_LATE && e.data?.request === 2), "its cost never came in that process");
  // A follow-up opens the run's next process: it books the request its predecessor left, then sends its own.
  await (await import("node:fs/promises")).writeFile(`${never}.next`, "");
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Go on." })).status < 300, true);
  await follow(api, run.run_id, ["completed", "failed", "input_required"], { deadlineMs: 90_000, after: 1 });
  await letGo(data, run.run_id);
  const after = read();
  const late = after.findIndex((e) => e.kind === REQUEST_COST_LATE && e.data?.request === 2);
  const nextStart = after.findIndex((e, i) => i > after.indexOf(after.find((x) => x.kind === "adapter.request" && x.data?.request === 2)) && e.kind === REQUEST_STARTED && e.data?.request === 3);
  assert.ok(late >= 0, `the next open wrote its late entry: ${JSON.stringify(after.map((e) => [e.kind, e.data?.request, e.data?.usd]))}`);
  assert.equal(after[late].data.usd, null, "at an unknown cost");
  assert.ok(nextStart > late, `before the next process's first request: late ${late}, next start ${nextStart}`);
  const startOf2 = after.find((e) => e.kind === REQUEST_STARTED && e.data?.request === 2);
  assert.ok(startOf2?.data?.boundUsd > 0, `request 2 carried a bound: ${JSON.stringify(startOf2?.data)}`);
  const upTo = after.slice(0, late + 1);
  const live = new RequestBounds();
  for (const entry of upTo) live.note([entry], 5);
  const whole = new RequestBounds();
  whole.note(upTo, 5);
  for (const [how, bounds] of [["live", live], ["whole", whole]]) assert.equal(bounds.inFlight(), 0, `${how}: out of flight once its late entry is in`);
  const view = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(view.cost.overshoot_bound_usd, 0);
});

test("a late entry at an unknown cost takes the request out of flight, its bound among the ended ones, live and whole", () => {
  let id = 0;
  const KEY = "run:r1";
  const entries = [
    { id: ++id, kind: "agentrun.tool_cost", data: { call: "c", usd: 0.9 } },
    { id: ++id, kind: REQUEST_STARTED, data: { key: KEY, request: 1, boundUsd: 0.2 } },
    { id: ++id, kind: "pi.assistant", model: [{ role: "assistant", api: "agentrun-adapter", stopReason: "stop", usage: {} }] },
    { id: ++id, kind: "adapter.request", data: { key: KEY, request: 1, unpriced: true } },
    { id: ++id, kind: REQUEST_COST_LATE, data: { key: KEY, request: 1, usd: null } },
  ];
  const live = new RequestBounds();
  for (const entry of entries) live.note([entry], 0.5);
  const whole = new RequestBounds();
  whole.note(entries, 0.5);
  for (const [how, bounds] of [["live", live], ["whole", whole]]) {
    assert.equal(bounds.inFlight(), 0, how);
    assert.ok(Math.abs(bounds.ended() - 0.2) < 1e-12, `${how}: its bound ended: ${bounds.ended()}`);
  }
});
