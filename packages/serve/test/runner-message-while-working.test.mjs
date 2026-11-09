// A person's message to a runner run that is still working (the server writes it as a steer row: runs-over-store.ts
// message) reaches the run, whenever it lands before the run's end, as main's does: during its turn it is placed into the
// live turn (adapter-loop.ts steer); after its turn's answer, while the run looks back in its end-of-run turn, it runs as
// a turn of its own before the run ends. Either way the model is asked again with it, the timeline shows it and its answer,
// and its row is taken, never refused by the run's end. Through the real runner, its dispatch and the pi spec.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
after(closeOpenSessions);

const RUN = "run-1";
const LOOK_BACK = "Before you go: what did you learn?";
const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** A Messages answer of `text`, the `step`th. */
const answer = (step, model, text) => sse([
  { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
  { type: "message_stop" },
]);

/** A pi run through the runner whose model answers by `answerOf(body, n)` (the nth request), and, with `looksBack`, an
 *  end-of-run turn asking LOOK_BACK; the stores and what the model was asked. */
async function runOn(t, { answerOf, looksBack = false }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-message-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer briefly." } });
  const launch = { input: { content: "First question." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, max_cost_usd: 5 };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    requests.push(body);
    return answer(requests.length - 1, body.model, await answerOf(body, requests.length));
  };
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `routecredential${"r".repeat(12)}` }, fetch, price: () => 0.01, cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1_000 };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 7), routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  // The run's end-of-run turn, as a learning run's asks one (adapter-run-spec.ts endOfRun): one turn more in its session.
  const endOfRun = async ({ ask, cut }) => {
    if (!cut) await ask(LOOK_BACK, { origin: "reflect", deadlineMs: 30_000 });
    return undefined;
  };
  const specOf = async (given, run, claim) => {
    const spec = await adapterRunSpecFromLaunch(given, run, deps, claim);
    return looksBack ? { ...spec, endOfRun } : spec;
  };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => specOf(given, run, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  return { server, requests };
}

/** The message's row once the runner has taken or settled it, or undefined at `ms`. */
const settledRow = (server, id, ms) => until(async () => (await server.commands(RUN, id - 1)).find((one) => one.id === id && one.takenAt !== null), "the message's row settles", ms).catch(() => undefined);
const ended = (server) => until(async () => {
  const now = await server.runs.get(RUN);
  return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
}, "the run's end");

/** What a run that took the message shows: taken, not refused; asked of the model; on the timeline with its answer. */
async function reached(server, requests, rowId, answered) {
  const row = (await server.commands(RUN, 0)).find((one) => one.id === rowId);
  assert.ok(row && row.takenAt !== null && row.refused === null, `the message was taken by the run, not refused or left: ${JSON.stringify(row)}`);
  assert.ok(requests.some((body) => JSON.stringify(body.messages).includes("Also this.")), `the model was asked with the message: ${requests.length} requests`);
  const said = (await runTimeline(server, RUN, context, { settled: true })).map((one) => `${one.kind}:${one.text ?? one.summary ?? ""}`).join("\n");
  assert.ok(said.includes("Also this.") && said.includes(answered), `the timeline shows the message and its answer:\n${said}`);
  assert.ok(said.indexOf("First answer.") < said.indexOf("Also this."), `after the first answer:\n${said}`);
}

test("a message sent while the run's turn is in flight reaches it: placed into the live turn, the model asked again with it before the run ends", { timeout: 120_000 }, async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { server, requests } = await runOn(t, { answerOf: async (_body, n) => (n === 1 ? (await held, "First answer.") : "Second answer.") });
  await until(() => requests.length === 1, "the turn's first model request");
  const row = await server.command(RUN, { kind: "steer", body: { text: "Also this." } });
  await settledRow(server, row.id, 15_000);
  release();
  const end = await ended(server);
  assert.equal(end.state, "ended", JSON.stringify(end));
  await reached(server, requests, row.id, "Second answer.");
});

test("a message sent after the turn's answer, while the run looks back in its end-of-run turn, runs as a turn of its own before the run ends: never refused by the end", { timeout: 120_000 }, async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { server, requests } = await runOn(t, {
    looksBack: true,
    answerOf: async (body) => {
      const asked = JSON.stringify(body.messages);
      if (asked.includes("Also this.")) return "Answer to the message.";
      if (asked.includes(LOOK_BACK)) return (await held, "A note.");
      return "First answer.";
    },
  });
  // The end-of-run turn's request is in flight: the person's message lands now.
  await until(() => requests.some((body) => JSON.stringify(body.messages).includes(LOOK_BACK)), "the end-of-run turn's model request");
  const row = await server.command(RUN, { kind: "steer", body: { text: "Also this." } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  release();
  const end = await ended(server);
  assert.equal(end.state, "ended", JSON.stringify(end));
  await reached(server, requests, row.id, "Answer to the message.");
});
