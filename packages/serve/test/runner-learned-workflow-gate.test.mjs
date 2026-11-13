// A learned workflow on the runner is held to the run's tool permissions, as main holds it (app.ts passes toolGate.policy
// and denyFrom to learnedWorkflowTool): the run's gate checks only learned_workflow itself, so each call node's tool is
// checked by the workflow, against the same gate (adapter-run-spec.ts adapterRunGate's permissions). A call node whose
// tool the agent was granted but set to deny is refused before any node runs, in the gate's words; one set to ask is
// refused too, since a call node can't wait for an approval; and one set to deny on the server after the run was claimed
// is refused as its call node runs, the server's settings read again from the store first. On pi and on a CLI harness.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { specFor } from "./runner-spec-support.mjs";
import { linkHarnesses } from "./support.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");

const AGENT = "agent-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const STAND_IN = new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname;
/** One call node: web_fetch on the input's url, at a loopback port nothing listens on (never reached in these tests). */
const FETCH = { v: 2, name: "fetch-one", schemas: { In: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Page: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Page", path: "page" }, root: { node: "call", label: "fetch", via: "tool", tool: "web_fetch", args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 } };
const FLOWS = [{ name: "fetch-one", description: "Fetches a page", workflow: FETCH }];
const GRANTED = ["read", "web_fetch"];
const ledger = { models: async () => ({ getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}), streamSimple: () => ({}) }) };

/** The learned_workflow tool's answer to running fetch-one, from `spec`. */
async function callFetch(spec) {
  const tool = spec.session.tools.find((one) => one.name === LEARNED_WORKFLOW_TOOL);
  assert.ok(tool, `the run lists learned_workflow: ${JSON.stringify(spec.session.tools.map(({ name }) => name))}`);
  return tool.call({ name: "fetch-one", input: { url: "http://127.0.0.1:9/" } }, { callId: "c-1", signal: new AbortController().signal });
}

/** pi's spec for a run whose agent learned fetch-one, its revision's tool settings `toolSettings`, the server's `settings`. */
async function piSpec(t, { toolSettings, settings } = {}) {
  const launch = {};
  return specFor(t, {
    body: { learning: true, tools: GRANTED, ...(toolSettings ? { toolSettings } : {}) },
    ...(settings ? { settings } : {}),
    launch,
    ledger,
    before: async (_server, _key, dir) => {
      launch.learning = startAt(await landWorkflows(dir, AGENT, FLOWS));
    },
  });
}

/** codex's spec for the same run, built for its claim as the dispatch builds it (no session opened). */
async function codexSpec(t, { toolSettings }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learned-workflow-gate-"));
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
  const sha = await landWorkflows(dir, AGENT, FLOWS);
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "codex", tools: GRANTED, learning: true, toolSettings } });
  const launch = { input: { content: "Fetch it." }, title: "t", place: { mode: "runner" }, harness: "codex", model: { provider: "openai", modelId: "gpt-5" }, learning: startAt(sha) };
  await server.runs.create({ id: "run-1", agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  await linkHarnesses(dir);
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  await harnessRun.commit((tx) => tx.createRootConversation(), ctx);
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  built = await cliRunSpecFromLaunch(launch, { harness: harnessRun, registry, setModels: (given) => (models = given), ledger }, deps, claim);
  return built;
}

const DENIED = /The learned workflow fetch-one was not run: This workflow's call node calls web_fetch, which is set to deny for this agent\./;
const ASKED = /The learned workflow fetch-one was not run: This workflow's call node calls web_fetch, which is set to ask, and a workflow's call node can't wait for an approval/;

test("pi: a learned workflow whose call node's tool is set to deny for the agent is refused before any node runs, in the gate's words", async (t) => {
  const out = await callFetch((await piSpec(t, { toolSettings: { web_fetch: { permission: "deny" } } })).spec);
  assert.equal(out.isError, true, out.text);
  assert.match(out.text, DENIED);
});

test("pi: a learned workflow whose call node's tool is set to ask is refused: a call node can't wait for an approval", async (t) => {
  const out = await callFetch((await piSpec(t, { toolSettings: { web_fetch: { permission: "ask" } } })).spec);
  assert.equal(out.isError, true, out.text);
  assert.match(out.text, ASKED);
});

test("codex: a learned workflow whose call node's tool is set to deny or ask for the agent is refused, as on pi", async (t) => {
  for (const [permission, words] of [["deny", DENIED], ["ask", ASKED]]) {
    const out = await callFetch(await codexSpec(t, { toolSettings: { web_fetch: { permission } } }));
    assert.equal(out.isError, true, `${permission}: ${out.text}`);
    assert.match(out.text, words);
  }
});

test("pi: a tool the server sets to deny after the run was claimed is refused as the call node runs: the settings are read again first", async (t) => {
  const built = await piSpec(t, { settings: { web_fetch: { permission: "allow" } } });
  // Set while the run goes: no decision of the run's gate has read the store since its claim.
  await built.server.settings.put("tool-settings", { web_fetch: { permission: "deny" } });
  const out = await callFetch(built.spec);
  assert.equal(out.isError, true, out.text);
  assert.match(out.text, /The learned workflow fetch-one failed: .*web_fetch/, out.text);
  assert.match(out.text, /deny|denied/i, out.text);
});
