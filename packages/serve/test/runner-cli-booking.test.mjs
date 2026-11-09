// A CLI run's learned_workflow booking through the runner's adapter loop (the one-ledger ruling, for a CLI harness's
// learned node): a faux CLI harness calls learned_workflow, its model node runs on the session's model proxy under the
// learned_workflow side key, and the runner's booking records that request labelled learned_workflow, priced by the
// session as the harness's own. A run whose pin names no learned workflow books nothing under that label. The faux CLI
// harness is the one the harness table hands the runner (harnessOf), on a gateway on loopback; no sleeps, no port races.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { LEARNING_PIN, LEARNED_WORKFLOWS_FILE } = await import("../dist/learning.js");
const { runFolder } = await import("../dist/workspace/paths.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const HARNESS = "codex";
const fake = (name) => `not-a-secret-${name}`;

/** One model node (`extract`) workflow: learned_workflow runs it, its node a request on the session's model. */
const answerFlow = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};

/** The node's submit, when a request offers the node's submit tool and carries no tool result yet. */
const submitsAnswer = ({ body }) => {
  const offers = (body?.tools ?? []).some((tool) => tool?.name === "submit");
  const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
  return offers && !answered ? { name: "submit", input: { value: { answer: 42 } } } : undefined;
};

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A CLI run of the faux harness with `tools` and `input`, its pin naming the `answer` workflow when `learned`, through
 *  the runner's dispatch. Its session's booked requests (runner.request) and turns, and the gateway's requests. */
async function cliRun(t, { tools, instructions, learned }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-booking-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: submitsAnswer });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // The faux harness reads the turn it runs from the system prompt (the agent's instructions among it), as the harness
  // tests do: so the instruction, not the person's message, names the learned workflow to run.
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions, harness: HARNESS, tools } });
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness: HARNESS, model: { provider: "openai", modelId: "gpt-test" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  // The run's pin and its learned workflows in the run's folder, as the run's start writes them, when it has one.
  if (learned) {
    const root = runFolder(dir, "agent-1", RUN);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, LEARNING_PIN), JSON.stringify({ seed: null, section: "", workflows: ["answer"] }));
    writeFileSync(join(root, LEARNED_WORKFLOWS_FILE), JSON.stringify([{ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(answerFlow) }]));
  }
  // The faux CLI harness on a loopback gateway, handed the runner through the env's harness table (harnessOf).
  // The harness table loads a test's module only under a test runner (harness-table.ts): hand the runner the flag, so its
  // cli spec takes the faux harness this test names, never the built-in codex (which is not installed here).
  const env = { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5", AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === HARNESS ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  // The run's session records: its model requests the session booked (runner.request), the node's labelled.
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const requests = all.filter((record) => record.kind === "runner.request").map((record) => record.data);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  return { row, requests, turns };
}

test("a CLI run's learned_workflow model node books on the run's one ledger, labelled learned_workflow and priced by the session", async (t) => {
  const { row, requests, turns } = await cliRun(t, { tools: ["read", LEARNED_WORKFLOW_TOOL], instructions: "Use the learned workflow answer on What is six times seven.", learned: true });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify(row)}`);
  const node = requests.filter((request) => request.host === LEARNED_WORKFLOW_TOOL);
  assert.equal(node.length, 1, `the node's one request is the session's, labelled learned_workflow: ${JSON.stringify(requests)}`);
  assert.equal(node[0].side, true, `the node's request is a side call of the session: ${JSON.stringify(node[0])}`);
  const booked = turns.find((turn) => turn.turn === node[0].turn);
  assert.ok(booked && typeof booked.usd === "number" && booked.usd > 0, `the node's request is priced by the session, not $0: ${JSON.stringify(booked)}`);
  const own = requests.filter((request) => request.host === undefined);
  assert.ok(own.length >= 1 && !own.some((request) => request.turn === node[0].turn), `the harness's own requests carry no learned_workflow label: ${JSON.stringify(own)}`);
});

test("a CLI run whose pin names no learned workflow books nothing under the learned_workflow label", async (t) => {
  const { row, requests } = await cliRun(t, { tools: ["read"], instructions: "Hold the request that carries the note.", learned: false });
  assert.notEqual(row.state, "failed", `the run did not fail: ${JSON.stringify(row)}`);
  assert.deepEqual(requests.filter((request) => request.host === LEARNED_WORKFLOW_TOOL), [], "no learned workflow, nothing booked under its label");
});

test("a CLI turn that ends on its own error fails the run in main's words: the harness's name, then the CLI's error", async (t) => {
  // Main words a CLI turn's own error as `<harness>: <error>` (harness-app.ts), so a person reads which CLI said it.
  const said = "unexpected status 500 Internal Server Error: upstream broke";
  const { row } = await cliRun(t, { tools: ["read"], instructions: `Fail with: ${said}`, learned: false });
  assert.equal(row.state, "failed", `the run failed: ${JSON.stringify(row)}`);
  assert.equal(row.summary, `${HARNESS}: ${said}`, "the run's error names its harness first");
});
