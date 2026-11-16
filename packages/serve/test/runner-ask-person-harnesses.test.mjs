// ask_person on every harness: the same run on pi, claude-agent, codex and opencode. The model asks the person a question; the run
// parks on it (input_required, the question pending, the row saying "Waiting for your reply", its claim released); the
// person's answer resumes it as its next user turn and the run ends, the question asked once. A stop while it waits ends
// it stopped. pi runs ask_person as its own tool (its control.terminate ends the turn); the CLI harnesses get the
// same tool as a host tool (cli-run-spec.ts), and the loop cuts the CLI's turn at its next request after the question
// (adapter-loop.ts TurnCut), so the run's record, state and answer are pi's. pi through the runner's pi spec on the faux
// gateway; each CLI through the runner's CLI spec (cliRunSpecFromLaunch) on the faux harness on its wire
// (fixtures/faux-harness.mjs "Ask the person: ..."), a real store and the runner's dispatch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { hostToolsOf } from "./host-tools-of.mjs";
import { queue, release, stores } from "./runner-support.mjs";
import * as claude from "./conformance-claude-agent.mjs";
import * as codex from "./conformance-codex.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { blockersOf } = await import("../dist/runnable.js");
const { askPerson } = await import("../dist/tools.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

after(claude.closeOpenSessions);
after(codex.closeOpenSessions);
const QUIET = { beforeIntent: async () => {}, beforeResult: async () => {} };

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const QUESTION = "Which region should I pick?";
const ANSWER = "us-west-2";
const WAITING = "Waiting for your reply";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const VIEW_DEPS = { origin: "https://run.test", serverSecrets: () => [] };
const fake = (name) => `not-a-secret-${name}`;

/** Each harness: its launch's model, and for a CLI its gateway environment (the faux harness's session proxy). */
const HARNESSES = {
  pi: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } },
  "claude-agent": { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, env: (url) => ({ ANTHROPIC_API_KEY: fake("anthropic"), ANTHROPIC_BASE_URL: url }) },
  codex: { model: { provider: "openai", modelId: "gpt-6.1-sol" }, env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL: "gpt-6.1-sol", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }) },
  opencode: { model: { provider: "openai", modelId: "gpt-6.1-sol" }, env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL: "gpt-6.1-sol", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }) },
};

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** pi's model on the faux gateway: on a request offering ask_person with no tool result yet, it asks; after, it answers. */
const driveAsk = ({ body }) => {
  const toolNames = (body?.tools ?? []).map((tool) => tool?.name);
  const hasResult = (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
  if (toolNames.includes("ask_person") && !hasResult) return { name: "ask_person", input: { question: QUESTION } };
  return undefined;
};

/** A run on `harness` granted ask_person, through the runner; settled once it rests (parked, ended, failed, stopped) with
 *  no runner holding it. The runner stays up so the test may answer it. */
async function askRun(t, harness) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-ask-person-harnesses-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: driveAsk, text: "done" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const { model, env } = HARNESSES[harness];
  // The faux harness reads its script from the system prompt; pi's model from the gateway.
  const instructions = `Ask the person: ${QUESTION}`;
  await server.agents.create({ id: "agent-1", name: "Asks" }, { id: "rev-1", kind: "agentic", body: { instructions, tools: ["ask_person"], ...(harness === "pi" ? {} : { harness }) } });
  const launch = { input: { content: "Pick a region." }, title: "t", place: { mode: "runner" }, model, ...(harness === "pi" ? {} : { harness }) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  if (harness === "pi") {
    const price = (_model, usage) => ((usage.input ?? 0) * 2 + (usage.output ?? 0) * 10) / 1e6;
    const route = { model: model.modelId, provider: { api: "anthropic-messages", origin: gw.url, credential: () => fake("pi") }, cost: { input: 2, output: 10 }, outputCeiling: 8_192, price };
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
    runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  } else {
    // The harness table loads a test's module only under a test runner (harness-table.ts): the flag is handed the runner.
    const runEnv = { ...env(gw.url), AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
    const deps = { env: runEnv, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
    runner = startRunner({
      store, name: "runner-a", ...TIMING,
      createLoop: createDispatchLoop({
        launchOf: (runId) => store.runs.launch(runId),
        resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
      }),
    });
  }
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["parked", "ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, `the ${harness} run's park or end`);
  return { row, server };
}

const rowsOf = async (server) => runTimeline(server, RUN, ctx);
const asks = (rows) => rows.filter((row) => row.kind === "tool_use" && row.tool_name === "ask_person");
const shown = (rows) => JSON.stringify(rows.map((row) => [row.kind, row.tool_name ?? null, row.summary ?? null]));

for (const harness of Object.keys(HARNESSES)) {
  test(`${harness}: a run that calls ask_person parks on its question, input_required with the question pending, its claim released`, { timeout: 60_000 }, async (t) => {
    const { row, server } = await askRun(t, harness);
    const rows = await rowsOf(server);
    assert.deepEqual([row.state, row.summary], ["parked", WAITING], `parked on the question, the row saying so: ${JSON.stringify({ state: row.state, summary: row.summary })} ${shown(rows)}`);
    assert.equal(row.runner, null, "the claim is released");
    const view = await viewOverStore(server, RUN, VIEW_DEPS);
    assert.equal(view.status, "input_required", `the view reads input_required: ${JSON.stringify(view.status)}`);
    assert.equal(view.state, "waiting", JSON.stringify(view.state));
    assert.deepEqual([view.pending?.kind, view.pending?.question], ["question", QUESTION], `the model's question is pending: ${JSON.stringify(view.pending)}`);
    const [use] = asks(rows);
    assert.equal(asks(rows).length, 1, `one ask_person call: ${shown(rows)}`);
    const result = rows.find((one) => one.kind === "tool_result" && one.tool_use_id === use.tool_use_id);
    assert.equal(result?.tool_status, "success", `its result: ${JSON.stringify(result)}`);
    assert.match(String(result.tool_result_preview ?? ""), /^Asked the person: Which region should I pick\?/, "the answer pi's tool gives");
    // The turn ended on the question: nothing the model said after it is on the record, as on pi.
    const after = rows.slice(rows.indexOf(result) + 1).filter((one) => ["text_block", "final_answer"].includes(one.kind));
    assert.deepEqual(after, [], `nothing said after the question: ${shown(rows)}`);
  });

  test(`${harness}: the person's answer resumes the parked run as its next turn, the waiting summary goes with it, and nothing is re-asked`, { timeout: 60_000 }, async (t) => {
    const { row, server } = await askRun(t, harness);
    assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
    await sendCommand(server, RUN, { kind: "steer", body: { text: ANSWER } });
    const ended = await until(async () => {
      const now = await server.runs.get(RUN);
      return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the answer resumes and ends the run");
    assert.deepEqual([ended.state, ended.summary], ["ended", null], `the answer ran the run to its end: ${JSON.stringify({ state: ended.state, summary: ended.summary })}`);
    const rows = await rowsOf(server);
    assert.equal(asks(rows).length, 1, `ask_person asked once: ${shown(rows)}`);
    const result = rows.findIndex((one) => one.kind === "tool_result" && one.tool_name === "ask_person");
    const answered = rows.findIndex((one) => one.kind === "user_message" && String(one.text ?? one.summary ?? "").includes(ANSWER));
    assert.ok(answered > result && result >= 0, `the person's answer is the user turn after the question: ${shown(rows)}`);
    assert.ok(rows.slice(answered + 1).some((one) => one.kind === "final_answer"), `the model answered the person's turn: ${shown(rows)}`);
    const view = await viewOverStore(server, RUN, VIEW_DEPS);
    assert.notEqual(view.status, "input_required", `nothing pending once answered: ${JSON.stringify(view.status)}`);
  });

  test(`${harness}: a stop while the run waits on its question ends it stopped`, { timeout: 60_000 }, async (t) => {
    const { row, server } = await askRun(t, harness);
    assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
    await sendCommand(server, RUN, { kind: "stop", body: {} });
    const stopped = await until(async () => {
      const now = await server.runs.get(RUN);
      return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the stop ends the waiting run");
    assert.equal(stopped.state, "stopped", JSON.stringify({ state: stopped.state, summary: stopped.summary }));
  });

  test(`${harness}: a run that names ask_person is runnable, never refused as pi's`, async () => {
    const blockers = await blockersOf({}, { kind: "agentic", instructions: "Ask the person.", tools: ["ask_person"], harness, model: HARNESSES[harness].model.modelId });
    assert.equal(blockers.find((blocker) => blocker.tool === "ask_person"), undefined, JSON.stringify(blockers));
  });
}

// The same question through each CLI's own adapter, on its package's stand-in: Claude Code's (its fake Agent SDK, which
// makes no model request: it says its reply after the call and ends its turn by itself, so the words after the question
// are what the loop keeps off the record) and Codex's (its stand-in app-server, each step a model request through the
// session's proxy: the request after the question is the one the loop cuts the turn at, then stops and settles the turn
// through the adapter's own interrupt and settleOpenTurn). ask_person is the session's host tool, as cli-run-spec binds it.
const ADAPTERS = {
  "claude-agent": (script) => claude.claudeAgentSpec({ script, tools: {}, hooks: QUIET }),
  codex: (script) => codex.codexSpec({ script, tools: {}, hooks: QUIET }),
};

for (const [harness, specFor] of Object.entries(ADAPTERS)) {
  test(`${harness}'s adapter: the run parks on its question with nothing said after it, and the person's answer is its next turn`, { timeout: 60_000 }, async (t) => {
    const opened = await stores({ runners: 1 });
    await queue(opened.server, RUN);
    const spec = specFor([{ call: "ask_person", args: { question: QUESTION } }, { sayLastSteer: true }]);
    const withAsk = async (claim, run) => {
      const given = await spec(claim, run);
      return { ...given, session: { ...given.session, tools: hostToolsOf({}, ["ask_person"], ctx, new Map(), [askPerson]) } };
    };
    const runner = startRunner({ store: opened.runners[0], name: "runner-a", ...TIMING, createLoop: createAdapterLoop(withAsk, { restartLimit: MAX_RESTARTS }) });
    t.after(async () => {
      await runner.close();
      await release(opened);
    });
    const server = opened.server;
    const settled = (states) => until(async () => {
      const now = await server.runs.get(RUN);
      return states.includes(now.state) && now.runner === null && now;
    }, `the run at one of ${states}`);
    const parked = await settled(["parked", "ended", "failed", "stopped"]);
    let rows = await rowsOf(server);
    assert.deepEqual([parked.state, parked.summary], ["parked", WAITING], `parked on its question: ${JSON.stringify({ state: parked.state, summary: parked.summary })} ${shown(rows)}`);
    const result = rows.findIndex((one) => one.kind === "tool_result" && one.tool_name === "ask_person");
    assert.ok(result >= 0 && rows[result].tool_status === "success", shown(rows));
    assert.deepEqual(rows.slice(result + 1).filter((one) => ["text_block", "final_answer"].includes(one.kind)), [], `nothing said after the question: ${shown(rows)}`);
    const view = await viewOverStore(server, RUN, VIEW_DEPS);
    assert.deepEqual([view.status, view.pending?.question], ["input_required", QUESTION], JSON.stringify(view.pending));
    await sendCommand(server, RUN, { kind: "steer", body: { text: ANSWER } });
    const ended = await settled(["ended", "failed", "stopped"]);
    rows = await rowsOf(server);
    assert.deepEqual([ended.state, ended.summary], ["ended", null], `the answer ran the run to its end: ${JSON.stringify({ state: ended.state, summary: ended.summary })} ${shown(rows)}`);
    assert.equal(asks(rows).length, 1, `asked once: ${shown(rows)}`);
    const answered = rows.findIndex((one) => one.kind === "user_message" && String(one.text ?? one.summary ?? "").includes(ANSWER));
    assert.ok(answered > result, `the answer is the user turn after the question: ${shown(rows)}`);
    assert.ok(rows.slice(answered + 1).some((one) => one.kind === "final_answer" && String(one.text ?? one.summary ?? "").includes(ANSWER)), `the model's next turn read the answer: ${shown(rows)}`);
  });
}
