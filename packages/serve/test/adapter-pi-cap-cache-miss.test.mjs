// pi through the adapter under a cap: no request can book the run past it. Each request is held at its worst case, its
// whole input bound uncached, so:
//   - a cache miss (request 1 finds none of the cache request 0 wrote, all of its input billed as a cache write) is booked
//     at no more than its hold, and the run's spend, as its records read again say, stays within the cap;
//   - a request that leaves and is cut with no usage (its runner lost while it is out) is booked cut at its hold, which
//     fit what was left, and the run's records count no more than the cap.
// Held as if request 0's cache were still warm, request 1 would be admitted on that guess with its output clamped to what
// is left, and either would pass the cap by what the cache was guessed to save.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { cap, capRun, quiet, SONNET, sleep, specCap, STEADY } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
after(closeOpenSessions);

const CAP = 0.05;
/** Sonnet's list price as the provider bills it, in this test only: input, cache writes, cache reads and output. */
const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.cacheWrite ?? 0) * 3.75 + (usage.cacheRead ?? 0) * 0.3 + (usage.output ?? 0) * 15) / 1e6;

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** One Anthropic answer of `step` (0 calls the read tool, any later answers) billed at `usage`. */
function answer(body, step, usage) {
  const start = { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens } } };
  const block = step === 0
    ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_0", name: "read", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }]
    : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }];
  return sse([start, ...block, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: step === 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }, { type: "message_stop" }]);
}
/** The provider: request 0 writes its whole prompt to the cache (a warm cache for the next request) and answers with 10
 *  tokens; request 1 is `later(body, bytes)`: a miss billed all of its input as a cache write and its whole output limit,
 *  or a hold that never answers. */
function origin(sent, later) {
  return async (_url, init = {}) => {
    const text = String(init.body ?? "{}");
    const body = JSON.parse(text);
    sent.push(body);
    const bytes = Buffer.byteLength(text, "utf8");
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    if (step === 0) return answer(body, 0, { input_tokens: 3, cache_creation_input_tokens: bytes - 3, cache_read_input_tokens: 0, output_tokens: 10 });
    return later(body, bytes, step);
  };
}
const miss = (body, bytes, step) => answer(body, step, { input_tokens: 0, cache_creation_input_tokens: bytes, cache_read_input_tokens: 0, output_tokens: body.max_tokens ?? 10 });

const read = { name: "read", replaySafe: true, ask: false, run: async () => "read" };
const specOf = (fetch) => (_claim, run) => ({
  adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch, price }),
  session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools({ read }), context: "fresh" },
  input: "Follow the script.",
  hooks: quiet,
  gate: () => "allow",
});

/** The run's spend as its records count it, every session summed (what a reopened run reads), and the root session's
 *  requests: each one's hold and the figure it counts at. */
async function recordsOf(store) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    let spent = 0;
    let root;
    for (const key of await sessions.keys()) {
      const records = await sessions.read(key);
      const read = sessionSpendOf(records);
      spent += read.spentUsd;
      if (key === "root") root = { read, records };
    }
    return { spent, requests: root.read.figures.map(({ turn, usd }) => ({ turn, usd, heldUsd: root.read.held.get(turn) })), records: root.records };
  } finally {
    await harness.close(ctx);
  }
}

/** No request counts past its hold, and the run's records count no more than the cap. */
function withinCap({ spent, requests }, at) {
  for (const one of requests) assert.ok(one.usd === null || one.usd <= one.heldUsd + 1e-12, `${at}: turn ${one.turn} counts $${one.usd}, past its hold $${one.heldUsd}`);
  assert.ok(spent <= CAP + 1e-12, `${at}: the run's records count $${spent} on a $${CAP} cap`);
}

test("a cache miss on a request after one that wrote the cache is booked at no more than its hold, and the run's records count no more than the cap", async (t) => {
  const { row, asked, store } = await capRun(t, { specOf: (sent) => specOf(origin(sent, miss)), cap: specCap(CAP), runCap: { capUsd: () => CAP, modelOf: () => SONNET } });
  const admitted = asked.filter((a) => a.answer && a.answer.refuse === undefined);
  assert.ok(admitted.length >= 1, `the first request is admitted: ${JSON.stringify(asked.map((a) => a.answer))}`);
  const read = await recordsOf(store);
  t.diagnostic(`${row.state}: spent $${read.spent}; ${JSON.stringify(read.requests)}`);
  withinCap(read, "the miss");
  // Request 1 went (the miss), or was refused before it left for want of room for its worst case: never sent past the cap.
  assert.ok(row.state === "ended" || row.state === "parked", JSON.stringify(row));
});

test("a request cut with no usage (its runner lost while it is out) is booked cut at its hold, and the run's records count no more than the cap", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-cap-cut-"));
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [await openSqliteStore({ dataDir: dir, role: "runner", now }), await openSqliteStore({ dataDir: dir, role: "runner", now })];
  const runners = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  t.after(async () => {
    release();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Cut" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  let out = () => {};
  const isOut = new Promise((resolve) => (out = resolve));
  let first = true;
  // Request 1 is held at the provider the first time (its runner is lost meanwhile); any later request is answered.
  const later = async (body, bytes, step) => {
    if (!first) return miss(body, bytes, step);
    first = false;
    out();
    await held;
    throw new Error("the provider's connection went with its runner");
  };
  const sent = [];
  const parkRule = { capUsd: CAP, park: (refusal) => cap.parkOf(refusal, CAP), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const loop = createAdapterLoop(async (claim, run) => ({ ...specOf(origin(sent, later))(claim, run), cap: parkRule, runCap: { capUsd: () => CAP, modelOf: () => SONNET } }), { restartLimit: MAX_RESTARTS });
  runners.push(startRunner({ store: stores[0], createLoop: loop, name: "runner-a", ...STEADY }));
  await isOut;
  // Lost while request 1 is out: killed, its claim run out on the stores' clock; the next runner books it cut.
  runners[0].kill();
  clock.skewMs += STEADY.leaseMs * 2;
  runners.push(startRunner({ store: stores[1], createLoop: loop, name: "runner-b", ...STEADY }));
  for (const from = Date.now(); (await server.runs.get("run-1")).runner !== "runner-b"; await sleep(20)) {
    if (Date.now() - from > 20_000) throw new Error("the second runner did not take the run within 20 s");
  }
  release();
  let row;
  for (const from = Date.now(); ; await sleep(20)) {
    row = await server.runs.get("run-1");
    if (row.state !== "running" && row.state !== "queued" && row.runner === null) break;
    if (row.state === "parked" && row.claimedUntil < now()) break;
    if (Date.now() - from > 30_000) throw new Error(`the run did not settle: ${JSON.stringify(row)}`);
  }
  const read = await recordsOf(stores[1]);
  t.diagnostic(`${row.state}: spent $${read.spent}; ${JSON.stringify(read.requests)}`);
  assert.equal(read.records.filter((r) => r.kind === "runner.turn" && r.data.cut === true).length, 1, `request 1 booked cut: ${JSON.stringify(read.records.map((r) => [r.kind, r.data]))}`);
  withinCap(read, "the cut");
});
