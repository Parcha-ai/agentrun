// A cap too small for one request is refused when the run is created, with the figures, and the agent says its floor
// before a run. A run's first request (one the cap refused at step 0 too) records its floor on its start mark, priced in
// the run's process by the cap's own path: the least (its input and least output, the figure the cap refuses it below)
// and the typical (its input and WRAP_UP_STEP0_ANSWER_TOKENS of output). The agent read serves the newest measured floor
// of its input-free part (`cap_floor`), and a create whose cap is under the least that run would need, its own input
// counted, is refused (422 below_least) with both figures. Nothing measured yet: no floor, and the create goes as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { join } from "node:path";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { piFloor } from "../dist/cap.js";
import { adapterRun } from "../dist/harness-app.js";
import { startServe } from "../dist/index.js";
import { agent, client, follow, scratch, serve, withEnv } from "./support.mjs";

/** Priced on both sides, input $10 and output $100 a million: a first request's least moves with its input. */
const FLOOR_PRICED = new URL("./fixtures/faux-floor-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const near = (a, b, within, what) => assert.ok(Math.abs(a - b) <= within, `${what}: ${a} vs ${b}`);

// Under the faux harness claude-agent and codex run one path (harness-app.ts's guard, capBefore), so codex stands for both.
for (const harness of ["pi", "codex"]) {
  test(`${harness}: a run paused at step 0 teaches the agent its floor, and a cap below the least is then refused at create with both figures`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { faux: FLOOR_PRICED, ...(harness === "pi" ? {} : { fauxHarness: FAUX_HARNESS }) });
    const id = `floor-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, harness === "pi" ? {} : { harness }))).status, 201);
    // Nothing measured yet: no floor, and a small cap is created as before (and pauses before doing anything).
    assert.equal((await api("GET", `/agents/${id}`)).body.cap_floor, undefined, "no floor before any run");
    const input = { content: "Write one.md" };
    const first = await api("POST", `/agents/${id}/runs`, { input, max_cost_usd: 0.02 });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await follow(api, first.body.run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${first.body.run_id}`)).body;
    assert.equal(pending?.kind, "budget", JSON.stringify(pending));
    // The agent's floor: measured by that refused request, its input-free part, so below what that request needed.
    const floor = (await api("GET", `/agents/${id}`)).body.cap_floor;
    assert.ok(floor, "the paused run's refused request measured the floor");
    assert.equal(typeof floor.model, "string");
    assert.ok(Number.isFinite(Date.parse(floor.measured_at)), JSON.stringify(floor));
    assert.ok(floor.least_usd > 0.1024 - 1e-6 && floor.least_usd < pending.needs_usd, JSON.stringify({ floor, pending }));
    assert.ok(floor.typical_usd > floor.least_usd, JSON.stringify(floor));
    // A second run with the same input and cap: refused at create, its least the very figure the pause needed.
    const refused = await api("POST", `/agents/${id}/runs`, { input, max_cost_usd: 0.02 });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    const { error } = refused.body;
    assert.equal(error.code, "input_invalid");
    assert.deepEqual(error.fields.map((f) => [f.field, f.reason]), [["max_cost_usd", "below_least"]], JSON.stringify(error));
    near(error.details.least_usd, pending.needs_usd, 1e-6, "the create's least is the pause's needs");
    assert.equal(error.details.least_cap_usd, Math.ceil(error.details.least_usd * 100 - 1e-9) / 100, JSON.stringify(error.details));
    assert.equal(error.details.model, floor.model);
    assert.ok(error.details.typical_usd > error.details.least_usd, JSON.stringify(error.details));
    // In words: the model, the cap asked, and both figures.
    for (const said of [floor.model, "$0.02", `$${error.details.least_cap_usd.toFixed(2)}`]) assert.ok(error.message.includes(said), `${said} in: ${error.message}`);
    // A cap between the least and the typical is created: the clamp and the wrap-up take it from there, as before.
    const between = (error.details.least_usd + error.details.typical_usd) / 2;
    const mid = await api("POST", `/agents/${id}/runs`, { input, max_cost_usd: between });
    assert.equal(mid.status, 202, JSON.stringify(mid.body));
    await follow(api, mid.body.run_id, SETTLED);
  });
}

test("pi: the create's least counts the run's own input: a longer input needs its bytes more, at the model's input price", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-input"))).status, 201);
  const first = await api("POST", "/agents/floor-input/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.02 });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  const { pending } = (await api("GET", `/runs/${first.body.run_id}`)).body;
  assert.equal(pending?.kind, "budget", JSON.stringify(pending));
  // 1,001 more plain bytes in the message (a space and 1,000 x's): $0.01001 more at $10 a million.
  const longer = await api("POST", "/agents/floor-input/runs", { input: { content: `Write one.md ${"x".repeat(1000)}` }, max_cost_usd: 0.02 });
  assert.equal(longer.status, 422, JSON.stringify(longer.body));
  near(longer.body.error.details.least_usd - pending.needs_usd, 1001 * 10 / 1e6, 2e-6, "the input's bytes at $10 a million");
});

test("pi: a completed run measures the floor as a paused one does, and a cap above the least is never refused", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-done"))).status, 201);
  const first = await api("POST", "/agents/floor-done/runs", { input: { content: "Write one.md" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  const floor = (await api("GET", "/agents/floor-done")).body.cap_floor;
  assert.ok(floor && floor.least_usd > 0.1024 - 1e-6, JSON.stringify(floor));
  assert.deepEqual(floor.by_effort?.[floor.effort], { least_usd: floor.least_usd, typical_usd: floor.typical_usd }, JSON.stringify(floor));
  const above = await api("POST", "/agents/floor-done/runs", { input: { content: "Write one.md" }, max_cost_usd: 5 });
  assert.equal(above.status, 202, JSON.stringify(above.body));
});

test("pi: a floor is its revision's: a new revision has none until its own first run, which is never refused", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-rev"))).status, 201);
  const first = await api("POST", "/agents/floor-rev/runs", { input: { content: "Write one.md" } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  assert.ok((await api("GET", "/agents/floor-rev")).body.cap_floor, "the first revision's run measured it");
  // New instructions: another first request, so the old floor is not this revision's.
  const { version: _, ...definition } = (await api("GET", "/agents/floor-rev")).body.definition;
  const revised = await api("PUT", "/agents/floor-rev/definition", { definition: { ...definition, instructions: "Answer in one line." } });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal((await api("GET", "/agents/floor-rev")).body.cap_floor, undefined, "no floor on the new revision yet");
  const small = await api("POST", "/agents/floor-rev/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.02 });
  assert.equal(small.status, 202, `the new revision's first run is never refused: ${JSON.stringify(small.body)}`);
});

test("pi: the agent read while a run of the agent is live and writing its store answers 200 with the floor, its stores read only and never locked", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FLOOR_PRICED });
  assert.equal((await api("POST", "/agents", agent("floor-live"))).status, 201);
  const done = await api("POST", "/agents/floor-live/runs", { input: { content: "Write one.md" } });
  assert.equal(done.status, 202, JSON.stringify(done.body));
  await follow(api, done.body.run_id, SETTLED);
  const measured = (await api("GET", "/agents/floor-live")).body.cap_floor;
  assert.ok(measured, "the finished run measured it");
  // A run held at its answer: its store has its start mark and is written as it goes (the turn's entries, its marks).
  const gate = join(await scratch(t), "go");
  const live = await api("POST", "/agents/floor-live/runs", { input: { content: `Answer once ${gate} exists.` } });
  assert.equal(live.status, 202, JSON.stringify(live.body));
  for (const end = Date.now() + 30_000; (await api("GET", `/runs/${live.body.run_id}`)).body.status !== "working"; await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the held run never started working");
  // Read while it is live: each read answers, with a floor (the finished run's, or the live one's once its first request
  // was marked, the same revision and settings), and the live run goes on to its answer, its store not held.
  for (let i = 0; i < 5; i++) {
    const read = await api("GET", "/agents/floor-live");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.cap_floor && read.body.cap_floor.least_usd > 0, JSON.stringify(read.body.cap_floor));
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(gate, "");
  await follow(api, live.body.run_id, ["completed"]);
});

/** A ready upload of `bytes` at `path`. */
async function upload(server, path, bytes) {
  const made = await server.api("POST", "/files", { path, size_bytes: bytes.length });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await fetch(`${server.url}${made.body.upload.url}`, { method: "PUT", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" }, body: bytes });
  const ready = await sent.json();
  assert.equal(sent.status, 200, JSON.stringify(ready));
  return ready.file_id;
}

test("pi: a run whose first message carried a file list measures no input-free floor a run without files is refused by", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { faux: FLOOR_PRICED });
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("floor-files"))).status, 201);
  // A file with a long name: the first message's file list adds its line to the measured request.
  const file = await upload(server, `${"long-name-".repeat(20)}notes.txt`, Buffer.from("notes"));
  const first = await api("POST", "/agents/floor-files/runs", { input: { content: "Write one.md" }, file_ids: [file], max_cost_usd: 0.02 });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  const { pending } = (await api("GET", `/runs/${first.body.run_id}`)).body;
  assert.equal(pending?.kind, "budget", JSON.stringify(pending));
  // Without the file the same message needs less than the measured request did, by at least the list's 209 name bytes
  // ($0.00209 at $10 a million): a cap a tenth of a cent under what the file's run needed covers it, so it is never
  // refused on that run's figure.
  const without = await api("POST", "/agents/floor-files/runs", { input: { content: "Write one.md" }, max_cost_usd: Math.round((pending.needs_usd - 0.001) * 1e6) / 1e6 });
  assert.equal(without.status, 202, `the file list's bytes are not counted in a run without it: ${JSON.stringify(without.body)}`);
});

test("pi: a floor measured under other host settings (here the host's thinking level) never refuses a run under the current ones", { timeout: 120_000 }, async (t) => {
  // Measured on a server whose host thinking level is high.
  withEnv(t, { AGENT_THINKING: "high" });
  const data = join(await scratch(t), "agents");
  let server = await startServe({ data, port: 0, faux: FLOOR_PRICED, drainTimeout: "5s" });
  t.after(() => server?.close());
  let api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", agent("floor-host"))).status, 201);
  const first = await api("POST", "/agents/floor-host/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.02 });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, SETTLED);
  assert.equal((await api("GET", "/agents/floor-host")).body.cap_floor?.effort, "high", "measured at the host's level");
  await server.close();
  // The host's thinking level is now low: a run of the same revision with no effort of its own runs at low.
  process.env.AGENT_THINKING = "low";
  server = await startServe({ data, port: 0, faux: FLOOR_PRICED, drainTimeout: "5s" });
  api = client(server.baseUrl, server.token);
  const small = await api("POST", "/agents/floor-host/runs", { input: { content: "Write one.md" }, max_cost_usd: 0.02 });
  assert.equal(small.status, 202, `measured at high, the low run is not refused on it: ${JSON.stringify(small.body)}`);
});

test("pi: only a fresh conversation's first request has a floor: a request after an answer (a follow-up in a later process) has none", async () => {
  const floorOf = await piFloor({ effort: "medium" });
  const model = { id: "floor-1", name: "floor-1", api: "openai-responses", provider: "p", maxTokens: 64_000, contextWindow: 400_000, cost: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 } };
  const user = { role: "user", content: "Write one.md", timestamp: 1 };
  assert.ok(floorOf(model, { systemPrompt: "Answer.", messages: [user] }, {}), "the first request of a fresh conversation");
  const answered = { role: "assistant", content: [{ type: "text", text: "Done." }], api: model.api, provider: "p", model: model.id, stopReason: "stop", timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  assert.equal(floorOf(model, { systemPrompt: "Answer.", messages: [user, answered, { ...user, timestamp: 3 }] }, {}), undefined, "a request after an answer");
});

test("another harness: a session opened again (not new) records no floor on its first request; a new one does", async () => {
  const mark = { model: "m", inputTokens: 1, leastUsd: 1, typicalUsd: 1, inputUsdPerToken: 0 };
  const floorsAt = async (state) => {
    const adapter = {
      id: "floored", version: "0", capabilities: () => ({ fork: false }), check: () => [],
      async open(_spec, io) {
        let ended = Promise.resolve({ status: "completed" });
        return {
          state,
          async send() {
            const ticket = await io.models.beforeRequest({ model: "m", inputTokensMax: 1 });
            await io.models.afterRequest({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0 }, ticket ?? undefined);
            ended = Promise.resolve({ status: "completed" });
          },
          async recover() {},
          async settleOpenTurn() {},
          turnEnd: () => ended,
          async interrupt() {},
          async close() {},
        };
      },
    };
    const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
    const app = adapterRun(async () => adapter, "floored", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx, undefined, [], undefined, undefined, () => false, undefined, undefined, undefined, undefined, [], () => mark);
    app.door.attach(() => {});
    await app.onOpen({ harness, env: async () => ({ confinePrefix: () => ["/usr/bin/setpriv", "--no-new-privs", "--"] }) });
    const door = { run: { harness }, signal: new AbortController().signal, emit: () => {}, adopt: () => {} };
    assert.deepEqual(await app.door.submit({ requestId: "m1", content: "Answer.", whenBusy: "followUp" }, door), { accepted: true });
    const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
    for (const end = Date.now() + 10_000; ; await new Promise((resolve) => setTimeout(resolve, 10))) {
      const { items } = await root.entries({ order: "ascending" }, 500, undefined, ctx);
      const starts = items.filter((entry) => entry.kind === REQUEST_STARTED);
      if (starts.length) return starts.filter((entry) => entry.data?.floor !== undefined).length;
      assert.ok(Date.now() < end, "no request was marked");
    }
  };
  assert.equal(await floorsAt("new"), 1, "a new session's first request");
  assert.equal(await floorsAt("idle"), 0, "a session opened again");
});
