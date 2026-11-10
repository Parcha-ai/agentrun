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
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), runCap: { capUsd: () => undefined, modelOf: () => undefined, judged: (request) => void asked.push(request.spentUsd) } }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}; asked ${JSON.stringify(asked)}; the call ${JSON.stringify(answers)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { asked, answers, requests: await paidRequestsOf(store) };
}

/** Each paid runner.request in run-1's records (its model "paid:<name>"), every session read. */
async function paidRequestsOf(store) {
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { journalSessions } = await import("../dist/runner/sessions.js");
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    const out = [];
    for (const key of await sessions.keys()) {
      for (const record of await sessions.read(key)) if (record.kind === "runner.request" && String(record.data?.model ?? "").startsWith("paid:")) out.push(record.data);
    }
    return out;
  } finally {
    await harness.close(ctx);
  }
}

test("a paid web_search's runner.request names who charges for it (charged_by: parallel), beside its call", async (t) => {
  const { requests } = await paidRun(t, 200);
  assert.equal(requests.length, 1, `one paid request: ${JSON.stringify(requests)}`);
  assert.equal(requests[0].charged_by, "parallel", `its provider, as main's charge row names it: ${JSON.stringify(requests[0])}`);
  assert.ok(typeof requests[0].call === "string" && requests[0].call !== "", "and the call it was booked under");
});

test("a paid monid run is admitted on the run's ledger naming monid as who charges for it", async () => {
  const { mkdtempSync: scratch } = await import("node:fs");
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { monidRegistration } = await import("../dist/monid.js");
  const { bookedIn } = await import("../dist/paid-calls.js");
  const { localWorkspace } = await import("../dist/workspace/index.js");
  const { KEY } = await import("./fixtures/faux-monid.mjs");
  const env = { AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_MONID: new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname, MONID_API_KEY: KEY };
  const work = scratch(join(process.env.TMPDIR ?? tmpdir(), "agentrun-monid-charged-by-"));
  const admitted = [];
  const paid = { admit: async (request) => void admitted.push(request), settle: async () => undefined };
  const tool = monidRegistration("run", env, () => localWorkspace(work));
  try {
    await bookedIn({ call: "call-1", record: async () => {}, paid }, () => tool.execute({ provider: "faux", endpoint: "/person/enrich", input: {} }, { callId: "call-1" }, ctx));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  assert.equal(admitted.length, 1, `one paid step: ${JSON.stringify(admitted)}`);
  assert.equal(admitted[0].chargedBy, "monid", `monid charges for it, as main's charge row names it: ${JSON.stringify(admitted[0])}`);
});

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
