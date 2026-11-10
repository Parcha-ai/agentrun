// A run on the runner lists its agent's learned workflows: the claim reads them from the agent's learning folder at the
// commit the run's learning start pinned (runner/learning-seed.ts, the one read the seed lay makes), never from a pin in
// the run's directory, which no runner writes. On both spec builders: pi's (adapterRunSpecFromLaunch) and the CLI
// harnesses' (cliRunSpecFromLaunch: claude-agent, codex). The learned_workflow tool names each ACTIVE learned workflow,
// as main's start chose them (learning.ts chooseWorkflows): never one pending its owner's OK, never a retired one, never
// one holding a key saved on the server (left out, in one line of the run's log). A run with no learning start lists none.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { specFor } from "./runner-spec-support.mjs";
import { answerFlow, linkHarnesses } from "./support.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");

const AGENT = "agent-1";
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const STAND_IN = new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname;
/** A key saved on the server, plainly a test value, never a real one. */
const SAVED = { name: "SOME_SERVICE_KEY", value: "saved-value-for-the-cut-0002" };
const GRANTED = ["read", LEARNED_WORKFLOW_TOOL];
/** One active workflow the run gets, and three it never does: pending its owner's OK, retired, holding a saved key. */
const FLOWS = [
  { name: "answer", description: "Answers a question as a number", workflow: answerFlow() },
  { name: "later", description: "Waits for its owner", workflow: answerFlow(), status: "pending" },
  { name: "old-flow", description: "Was retired by a person", workflow: answerFlow(), status: "retired" },
  { name: "leaky", description: `Calls the service with ${SAVED.value}`, workflow: answerFlow() },
];
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));

/** The run's one ledger as the adapter loop hands it (run.ledger): the learned_workflow tool's model nodes take the
 *  session's proxied models from it. Building the spec asks it nothing else; no model is called. */
const ledger = { models: async () => ({ getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}), streamSimple: () => ({}) }) };

/** The learned_workflow tool of a built spec, or undefined. */
const learnedOf = (spec) => spec.session.tools.find((tool) => tool.name === LEARNED_WORKFLOW_TOOL);

/** Asserts `spec` lists learned_workflow naming `answer` alone of FLOWS, in its description and its name's enum. */
function listsAnswerOnly(spec) {
  const tool = learnedOf(spec);
  assert.ok(tool, `the run lists learned_workflow: ${JSON.stringify(spec.session.tools.map(({ name }) => name))}`);
  assert.match(tool.description, /- answer: Answers a question as a number/, tool.description);
  for (const name of ["later", "old-flow", "leaky"]) assert.equal(tool.description.includes(name), false, `${name} is not the run's: ${tool.description}`);
  assert.equal(tool.description.includes(SAVED.value), false, "no saved key in the tool's description");
  assert.deepEqual(tool.inputSchema?.properties?.name?.enum, ["answer"], "the tool runs answer alone");
}

/** pi's spec for a learning run whose seed holds FLOWS (`seed`: "landed", or "none": no learning start). */
async function piSpec(t, { seed = "landed" } = {}) {
  const launch = {};
  return specFor(t, {
    body: { learning: true, tools: GRANTED },
    keys: { [SAVED.name]: SAVED.value },
    launch,
    ledger,
    before: async (_server, _key, dir) => {
      if (seed === "landed") launch.learning = startAt(await landWorkflows(dir, AGENT, FLOWS));
    },
  });
}

/** A CLI harness's spec for a learning run whose seed holds FLOWS, built for its claim as the dispatch builds it (no
 *  session opened), as runner-learning-seed-lay's cliSpec builds it. `log`: the spec's log lines. */
async function cliSpec(t, harness, { seed = "landed" } = {}) {
  const dir = scratch("runner-learned-workflows-seed-");
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let built;
  let harnessRun;
  t.after(async () => {
    await built?.release?.().catch(() => {});
    await harnessRun?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const sha = seed === "landed" ? await landWorkflows(dir, AGENT, FLOWS) : undefined;
  const model = harness === "claude-agent" ? { provider: "anthropic", modelId: "claude-haiku-4-5" } : { provider: "openai", modelId: "gpt-5" };
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness, tools: GRANTED, learning: true } });
  const launch = { input: { content: "Run what you learned." }, title: "t", place: { mode: "runner" }, harness, model, ...(sha !== undefined ? { learning: startAt(sha) } : {}) };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await putSealedKey(server, SEAL_KEY, SAVED.name, SAVED.value);
  await server.flush?.();
  await linkHarnesses(dir);
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const log = [];
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const deps = {
    env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("no pi route"), log: (line) => log.push(line),
    computerForClaim: async () => ({ release: async () => {} }),
  };
  built = await cliRunSpecFromLaunch(launch, { harness: harnessRun, registry, setModels: (given) => (models = given), ledger }, deps, claim);
  return { spec: built, log };
}

test("pi: a run on the runner lists its agent's active learned workflow, never a pending, retired or secret-holding one", async (t) => {
  const { spec } = await piSpec(t);
  listsAnswerOnly(spec);
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run on the runner lists its agent's active learned workflow, never a pending, retired or secret-holding one; the one left out is said in one line`, async (t) => {
    const { spec, log } = await cliSpec(t, harness);
    listsAnswerOnly(spec);
    const said = log.filter((line) => /learned workflow/.test(line));
    assert.equal(said.length, 1, JSON.stringify(log));
    assert.match(said[0], /leaky/);
    assert.equal(said[0].includes(SAVED.value), false);
  });
}

test("a run with no learning start lists no learned workflow, on pi and on a CLI harness", async (t) => {
  assert.equal(learnedOf((await piSpec(t, { seed: "none" })).spec), undefined);
  assert.equal(learnedOf((await cliSpec(t, "codex", { seed: "none" })).spec), undefined);
});
