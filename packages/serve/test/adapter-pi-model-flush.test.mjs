// pi through the adapter loop: every paid model request leaves only after a flush, as every tool call that is not
// replay-safe does (the storeIntentFlush barrier names both). The request reaches the provider only through the session's
// model proxy, whose booking awaits the runner's request_start before it forwards one: the flush is there, on the path
// every adapter's paid requests take. The adapter loop's twin of runner-loop-model-flush, the origin a script (no
// network): a run that only answers, one whose first request the provider refuses as retryable (429, retried by pi), and
// one with a replay-safe call between its requests.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** The order of flushes and requests reaching the provider in one run of `script`; `failFirst`: the first one is
 *  answered 429 (a rate limit), which pi retries. */
async function order(t, script, { failFirst = false } = {}) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-model-flush-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flush" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const seen = [];
  const origin = scriptedOrigin(script, { push: () => seen.push("request") });
  let refused = !failFirst;
  const fetch = async (url, init) => {
    if (!refused) {
      refused = true;
      seen.push("request");
      return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "429 Too Many Requests: rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return origin(url, init);
  };
  const read = { name: "read", replaySafe: true, ask: false, run: async () => (seen.push("read"), "read") };
  const inner = createAdapterLoop(piAdapterSpec({ script, tools: { read }, hooks: quiet }, { fetch }), { restartLimit: MAX_RESTARTS });
  const createLoop = (deps) => inner({ ...deps, flush: async () => (seen.push("flush"), deps.flush()) });
  runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}: ${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return seen;
}

/** Whether every request has a flush after the one before it (or after the run's start). */
const flushedBeforeEach = (seen) => seen.every((what, index) => what !== "request" || seen.slice(seen.lastIndexOf("request", index - 1) + 1, index).includes("flush"));

test("pi through the adapter: a model request leaves only after a flush: one that only answers", async (t) => {
  const seen = await order(t, [{ say: "done" }]);
  assert.ok(seen.includes("request"), `the provider was asked: ${JSON.stringify(seen)}`);
  assert.ok(flushedBeforeEach(seen), `a flush before each request: ${JSON.stringify(seen)}`);
});

test("pi through the adapter: a retried model request leaves after a flush of its own", async (t) => {
  const seen = await order(t, [{ say: "done" }], { failFirst: true });
  assert.ok(seen.filter((what) => what === "request").length >= 2, `the request and its retry: ${JSON.stringify(seen)}`);
  assert.ok(flushedBeforeEach(seen), `a flush before the request and before its retry: ${JSON.stringify(seen)}`);
});

test("pi through the adapter: model requests each leave after a flush, with a replay-safe call between them", async (t) => {
  const seen = await order(t, [{ call: "read" }, { say: "done" }]);
  assert.equal(seen.filter((what) => what === "request").length, 2, `two requests: ${JSON.stringify(seen)}`);
  assert.ok(flushedBeforeEach(seen), `a flush before each request: ${JSON.stringify(seen)}`);
});
