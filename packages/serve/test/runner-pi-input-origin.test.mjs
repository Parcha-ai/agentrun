// A pi run a trigger started, through the runner's adapter loop on pi's spec (adapter-run-spec.ts adapterRunSpecFromLaunch):
// its launch names the trigger and the first input's origin (run-launch.ts, as the server writes it at the firing), a
// schedule's with owner true (its owner wrote the words) and a webhook's with owner false. pi's first input is the host's
// input entry with that origin, the launch's own owner flag kept, as a trigger's steer is, never the person's: its
// Timeline shows a trigger row and no "You" row, so a webhook's payload never reads as the owner's words. pi's model goes
// through the session proxy to a loopback gateway; no sleeps, no port races.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const TRIGGER = { id: "trg_0123456789abcdef01234567", firing_key: `fir_${"a".repeat(32)}` };
const LABEL = { schedule: "Schedule", webhook: "Webhook" };

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A pi run stored with its launch (`launch`: more of its body, as the server writes it), run to its end by a runner whose
 *  dispatch builds pi's spec from the stored launch. Its messages as the journal reader reads them, and its Timeline. */
async function piRun(t, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-pi-input-origin-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: () => undefined });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Clock" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [] } });
  const body = { input: { content: "Say the time." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, ...launch };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: "claude-sonnet-4-5", provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_harness, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }) });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return { row, messages: messagesOf(entries), rows: await runTimeline(server, RUN, ctx, { settled: true }) };
}

for (const [source, owner] of [["schedule", true], ["webhook", false]]) {
  test(`a pi run a ${source} trigger started journals its first input as the trigger's (owner ${owner}), never the person's: its Timeline shows the trigger's row, never "You"`, async (t) => {
    const origin = { kind: "trigger", trigger_id: TRIGGER.id, source, owner };
    const { row, messages, rows } = await piRun(t, { trigger: TRIGGER, input_origin: origin });
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
    const said = messages.filter((message) => message.role !== "model");
    assert.deepEqual(said.map((message) => [message.text, message.origin ?? null]), [["Say the time.", origin]], "the first input is the trigger's, with the launch's owner flag");
    assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), [], "no row reads as the person's");
    assert.deepEqual(rows.filter((r) => r.origin === "trigger").map((r) => [r.summary, r.trigger]), [[`${LABEL[source]} ${TRIGGER.id}: Say the time.`, { id: TRIGGER.id, source, owner }]]);
  });
}

test("a pi run a person started keeps its first input the person's: a \"You\" row, no trigger row", async (t) => {
  const { row, messages, rows } = await piRun(t, {});
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  assert.deepEqual(messages.filter((message) => message.role !== "model").map((message) => [message.text, message.origin ?? null]), [["Say the time.", null]]);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: Say the time."]);
  assert.equal(rows.filter((r) => r.origin === "trigger").length, 0);
});
