// A pi run cancelled while its model's answer streams: the request the cancel cut is booked at no known cost (the provider
// may bill what it streamed), so the run's cost is unknown, never the $0 its cut answer carries. Through the real loop:
// startRunner over createDispatchLoop and the pi spec (adapterRunSpecFromLaunch), on a real store; the provider is a
// scripted origin that starts an answer and holds it open until the request is aborted. No socket leaves this machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { viewOverStore } = await import("../dist/store-view.js");
after(closeOpenSessions);

const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const KEY = `not-a-secret-${"c"}`;

/** An origin that starts the answer (its usage's input, a first text delta) and holds it open until the request is aborted:
 *  `streaming` resolves once the answer has started. */
function holdingOrigin() {
  let started = () => {};
  const streaming = new Promise((resolve) => (started = resolve));
  const fetch = async (url, init = {}) => {
    // Straight to Anthropic the proxy first asks for the request's token count (count_tokens): that is answered whole, and
    // only the messages request streams and is held open.
    if (String(url).endsWith("/count_tokens")) return Response.json({ input_tokens: 100 });
    const body = JSON.parse(String(init.body ?? "{}"));
    const encoder = new TextEncoder();
    const event = (data) => encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    // The answer's start goes out when the session's proxy first reads the body, and the cancel waits until it has: a
    // cancel before the proxy read anything would be a request with nothing streamed (never answered), a different case.
    let pulls = 0;
    const stream = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(init.signal.reason ?? new Error("aborted")), { once: true });
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(event({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 2_000, output_tokens: 1 } } }));
          controller.enqueue(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          controller.enqueue(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working on it, " } }));
          return undefined;
        }
        // The proxy came back for more: it has read the answer's start. Then the answer holds until the request is aborted.
        started();
        return new Promise(() => {});
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, streaming };
}

test("a pi run cancelled while its answer streams reads its cost unknown, never $0: the cut request is booked at no known cost", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-pi-cancel-cost-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer at length." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Write a long answer." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } } });
  const origin = holdingOrigin();
  const route = {
    model: "claude-sonnet-4-5", provider: { api: "anthropic-messages", origin: "https://api.anthropic.com", credential: () => KEY },
    fetch: origin.fetch,
    price: (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6,
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 64_000,
  };
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 5), routeOf: async () => route,
    computerForClaim: async () => ({ release: async () => {} }),
  };
  runner = startRunner({
    store, name: "runner-a", ...TIMING,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }),
  });
  await origin.streaming;
  await sendCommand(server, "run-1", { kind: "cancel", body: {} });
  let row;
  for (const from = Date.now(); ; await new Promise((resolve) => setTimeout(resolve, 25))) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  }
  assert.equal(row.state, "stopped", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(row.costUsd, null, `the run's stored cost is unknown, never $0: ${row.costUsd}`);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.equal(view?.cost?.usd, null, `its view's cost is unknown too: ${JSON.stringify(view?.cost)}`);
});
