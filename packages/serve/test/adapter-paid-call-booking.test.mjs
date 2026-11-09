// A paid tool call on the adapter loop books as main books it (paid-calls.ts paidRequest): held at its price before it is
// sent and settled at what it charged, on the run's one ledger, the runner records of its journal sessions, so the run's
// next paid request (and any later claim, which reads the same records) is asked with it. Parallel's fast search, $0.001,
// is charged on a 2xx and not on a 4xx other than a 408, as main books it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { paidRequest, parallelSearchFee } = await import("../dist/paid-calls.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A run whose one host tool makes one paid Parallel search answered `status`, then answers: the spend each of its model
 *  requests was asked with (the scripted model costs nothing, so a request after the call is asked with the call's). */
async function paidRun(t, status) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-paid-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Paid" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const answers = [];
  const search = {
    name: "search",
    replaySafe: false,
    run: async () => {
      try {
        const response = await paidRequest(parallelSearchFee(10), async () => new Response("{}", { status }));
        answers.push(response.status);
        return `searched (${response.status})`;
      } catch (error) {
        answers.push(String(error?.message ?? error));
        throw error;
      }
    },
  };
  const asked = [];
  const spec = piAdapterSpec({ script: [{ call: "search" }, { say: "done" }], tools: { search }, hooks: quiet });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), beforeRequest: (request) => void asked.push(request.spentUsd) }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}; asked ${JSON.stringify(asked)}; the call ${JSON.stringify(answers)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { asked, answers };
}

test("a paid call on the adapter loop answered 200 is charged its price on the run's one ledger: the next request is asked with $0.001", async (t) => {
  const { asked, answers } = await paidRun(t, 200);
  assert.ok(asked.length >= 2, `asked before the call and after it: ${JSON.stringify(asked)}; the call ${JSON.stringify(answers)}`);
  assert.ok(Math.abs(asked.at(-1) - 0.001) < 1e-12, `the request after the paid call is asked with its $0.001: ${JSON.stringify(asked)}; the call ${JSON.stringify(answers)}`);
});

test("a paid call answered 400 (Parallel refused it, unbilled) is settled at $0, never left at its hold: the next request is asked with $0", async (t) => {
  const { asked, answers } = await paidRun(t, 400);
  assert.deepEqual(answers, [400], "the request was sent and answered 400");
  assert.ok(asked.length >= 2 && typeof asked.at(-1) === "number" && Math.abs(asked.at(-1)) < 1e-12, `the request after it is asked with $0 (a known spend), its hold let go by its settle: ${JSON.stringify(asked)}`);
});
