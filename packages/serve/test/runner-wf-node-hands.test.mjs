// A workflow's model node takes read, write and edit on the runner, as main's per-run process binds them (app.ts:301-306:
// tools.ts fileTool, the run's file tools over its work folder): the claim opens the run's Workspace and the computer its
// place needs the way an agentic run's does (run-hands.ts claimRunHands, adapter-run-spec's own steps), and the node's
// file tools are the kernel's hands over them, each through the run's gate (deny in deniedText's words; ask refused in
// the model-node words, since a model node cannot wait for a person) and the run's ledger. A workflow naming none of the
// three claims no Workspace or computer; browser stays refused at the claim until the runner binds it for a node. The
// claim's Workspace and computer are let go once the claim is done.
//
// Through the real loop (startRunner over createWorkflowLoop and workflowSpecOf) on a real store, the run's Workspace its
// Mode 1 folder under the runner's data directory; the shared scripted origin calls a tool only when the request offers it.
// The switch's own wiring (resolveRunnerLoop handing the workflow spec the run's hands) through the real dispatch.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const spec = await import("../dist/runner/workflow-spec.js");
const { deniedText, modelNodeAskText } = await import("../dist/refusal-words.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const hands = await import("../dist/runner/run-hands.js").catch(() => undefined);
const { FAUX_ENV } = await import("../dist/model.js");

const FAUX_ROUTE = new URL("./fixtures/faux-route.mjs", import.meta.url).pathname;
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });

/** One model node naming `tools`, answering {answer} (the workflow's output). */
const nodeFlow = (tools) => ({
  v: 2, name: "files",
  schemas: { In: { type: "object", additionalProperties: true }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "agent", label: "files", instructions: "Keep a note, then answer.", tools, out: "Answer", as: "answer" },
});
const HANDS = ["edit", "read", "write"];
const WRITE = { call: "write", args: { path: "notes.txt", content: "forty-one" } };
const EDIT = { call: "edit", args: { path: "notes.txt", edits: [{ oldText: "forty-one", newText: "forty-two" }] } };
const READ = { call: "read", args: { path: "notes.txt" } };
const SUBMIT = { call: "submit", args: { answer: 42 } };

/** A computer claim that hands no computer (a runner place), counting each claim and each release, with what it was
 *  claimed for. */
function countingComputers() {
  const counts = { claims: [], released: 0 };
  return { counts, computerForClaim: async (launch) => { counts.claims.push(launch); return { release: async () => { counts.released += 1; } }; } };
}

/** run-1 of `workflow` (its revision with `toolSettings`), its node playing `script`, on a runner whose workflow spec gets
 *  the run's hands through claimRunHands; its row once it leaves running, the requests, the store's text, the run's
 *  folder and the computer counts. */
async function runOn(t, { workflow, toolSettings, script, toolsThrow }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-node-hands-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow, ...(toolSettings ? { toolSettings } : {}) } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  const requests = [];
  const fetch = scriptedOrigin(script, requests);
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"h"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  const computers = countingComputers();
  const handsDeps = { store, data: dir, env: {}, log: () => {}, computerForClaim: computers.computerForClaim };
  // `toolsThrow`: the hands open, then taking their tools throws in these words (a claim failing once it holds them).
  const opened = async (claim) => hands.claimRunHands(handsDeps, claim, await store.runs.launch(claim.runId), await store.runs.get(claim.runId));
  const runHands = !hands?.claimRunHands
    ? undefined
    : toolsThrow
      ? async (claim) => { const held = await opened(claim); return { ...held, tools: { ...held.tools, hostTools: () => { throw new Error(toolsThrow); } } }; }
      : opened;
  runner = startRunner({ store, createLoop: createWorkflowLoop(spec.workflowSpecOf({ store, providerOf, env: {}, ...(runHands ? { hands: runHands } : {}) })), name: "runner-a", ...TIMING });
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) {
      // The claim is done once the runner has closed (its loop's release runs after the end commit).
      await runner.close();
      runner = undefined;
      const text = ["store.sqlite", "store.sqlite-wal"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("utf8")).join("\n");
      const folder = runFolder ? runFolder(dir, "agent-1", "run-1") : undefined;
      return { row, requests, text, folder, computers: computers.counts };
    }
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const offered = (request) => (request?.tools ?? []).map((tool) => tool.name).sort();
const noteIn = (folder) => (folder && existsSync(join(folder, "notes.txt")) ? readFileSync(join(folder, "notes.txt"), "utf8") : undefined);
const needsHands = () => (hands?.claimRunHands ? undefined : assert.fail("run-hands.ts claimRunHands is not there"));

test("a model node's write, edit and read, allowed: offered once each, run on the run's Workspace, its file changed and read back", async (t) => {
  needsHands();
  const { row, requests, text, folder, computers } = await runOn(t, { workflow: nodeFlow(HANDS), script: [WRITE, EDIT, READ, SUBMIT] });
  assert.deepEqual(offered(requests[0]), ["edit", "read", "submit", "write"], "the node's request offers its three tools and submit");
  for (const [index, request] of requests.entries()) {
    for (const name of HANDS) assert.equal(offered(request).filter((each) => each === name).length, 1, `request ${index} offers ${name} once: ${JSON.stringify(offered(request))}`);
  }
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(noteIn(folder), "forty-two", "written, then edited, in the run's own folder");
  assert.ok(text.includes("forty-two"), "the read's answer, the edited file, is in the run's record");
  assert.equal(computers.claims.length, 1, "the claim asked for the computer its place needs, once");
  assert.equal(computers.released, 1, "and let it go once the claim was done");
});

test("a model node's write set to deny: refused in deniedText's words, nothing written", async (t) => {
  needsHands();
  const { row, text, folder } = await runOn(t, { workflow: nodeFlow(["write"]), toolSettings: { write: { permission: "deny" } }, script: [WRITE, SUBMIT] });
  assert.equal(row.state, "ended", `the node reads the refusal and submits: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.ok(text.includes(deniedText("write", undefined, "agent")), "the call's answer is the gate's deny, in main's words");
  assert.equal(noteIn(folder), undefined, "never written");
});

test("a model node's edit set to ask: refused in the model-node words (it cannot wait for a person), the file unchanged", async (t) => {
  needsHands();
  const { row, text, folder } = await runOn(t, { workflow: nodeFlow(["write", "edit"]), toolSettings: { edit: { permission: "ask" } }, script: [WRITE, EDIT, SUBMIT] });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.ok(text.includes(modelNodeAskText("edit")), "the call's answer is main's model-node ask refusal");
  assert.equal(noteIn(folder), "forty-one", "written, never edited");
});

test("a workflow whose nodes name no file tool claims no Workspace and no computer", async (t) => {
  needsHands();
  const { row, computers } = await runOn(t, { workflow: nodeFlow([]), script: [SUBMIT] });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(computers.claims.length, 0, "no computer claimed");
});

test("a claim that fails once it holds the run's hands lets them go: the run fails in the failure's words, its computer released once", async (t) => {
  needsHands();
  const words = "the run's file tools could not be taken here";
  const { row, requests, computers } = await runOn(t, { workflow: nodeFlow(["read"]), script: [SUBMIT], toolsThrow: words });
  assert.equal(row.state, "failed", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.ok(`${row.summary ?? ""}`.includes(words), `failed in the failure's words: ${row.summary}`);
  assert.equal(requests.length, 0, "no model request sent");
  assert.equal(computers.claims.length, 1, "the computer was claimed");
  assert.equal(computers.released, 1, "and let go, though the claim failed");
});

test("a model node naming browser is still refused at the claim, in words naming it, nothing claimed", async (t) => {
  const words = spec.nodeToolUnboundText("browser");
  const { row, requests, computers } = await runOn(t, { workflow: nodeFlow(["browser"]), script: [SUBMIT] });
  assert.equal(row.state, "failed", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.ok(`${row.summary ?? ""}`.includes(words), `refused in words naming browser: ${row.summary}`);
  assert.equal(requests.length, 0, "no model request sent");
  assert.equal(computers.claims.length, 0, "no computer claimed");
});

test("through the runner's real dispatch, a node naming read claims the run's computer for its place and lets it go", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-node-hands-dispatch-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: nodeFlow(["read"]) } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" } } });
  const computers = countingComputers();
  const deps = {
    env: { [FAUX_ENV]: FAUX_ROUTE }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3),
    routeOf: async () => assert.fail("a workflow resolves no pi route"),
    computerForClaim: computers.computerForClaim,
  };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: resolveRunnerLoop(deps) }) });
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 45_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The claim is done once the runner has closed (its loop's release runs after the end commit).
  await runner.close();
  runner = undefined;
  // The faux route never submits, so the node may fail; what matters is the claim: never refused for read, and the hands
  // claimed for the run's place and let go.
  const { counts } = computers;
  assert.ok(!`${row.summary ?? ""}`.includes(spec.nodeToolUnboundText("read")), `not refused at the claim: ${row.summary}`);
  assert.equal(counts.claims.length, 1, `the computer claimed once: ${JSON.stringify(counts.claims)}`);
  assert.deepEqual(counts.claims[0]?.place, { mode: "runner" }, "for the run's own place");
  assert.equal(counts.claims[0]?.runId, "run-1");
  assert.equal(counts.released, 1, "let go once the claim was done");
});
