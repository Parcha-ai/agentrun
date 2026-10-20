import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workflowSha256 } from "@parcha/agentrun-dsl";
import { workspaceFiles } from "@parcha/agentrun-dsl/recovery";
import { createWorkflowExtension, recordingLines } from "@parcha/agentrun-pi/durable";
import { local, openRepo } from "@parcha/pi-git-remote";
import { readFile } from "node:fs/promises";
import { admitRevision, hostKey, hostRunName, planServing, SERVE_LIMITS, proposeLearning, readUses, renderTrial, serve, trialPath, workflowDir } from "../dist/index.js";
import { agentRepo, commitMain, ctx, scratch } from "./support.mjs";
import { workDirWith, workflowDoc } from "./workflow-support.mjs";

const input = { sku: "A-1", amount: 10 };
/** The host's answer check: a quote with a positive price. */
const check = (output) => (typeof output?.price === "number" && output.price > 0 ? [] : ["/price must be a positive number"]);

/** A run's open Harness, on SQLite, with the DSL's workflow extension, whose one tool quotes `price` or, with `down`, fails. */
async function servingRun({ price = 21, down = false } = {}) {
  const root = await scratch();
  await mkdir(path.join(root, "cwd"));
  const store = path.join(root, "run.sqlite");
  const flow = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(path.join(root, "cwd")) }),
    run: () => ({ adapters: { runEffect: async () => { if (down) throw new Error("the registry is down"); return { price }; } } }),
  });
  const registry = createRegistry();
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(store), { registry, models: {} }, ctx);
  return { harness, flow, store, close: () => harness.close(ctx) };
}

const planOf = (workflow, extra = {}) => ({ name: workflow.name, sha256: workflowSha256(workflow), workflow, canary: false, ...extra });
const tasksIn = (store) => recordingLines(store).lines.filter((line) => line.kind === "agentrun.workflow");

test("serve runs the plan's workflow as a durable task under the host's key; a valid output is the answer", async (t) => {
  const run = await servingRun();
  t.after(run.close);
  const workflow = workflowDoc();
  const served = await serve({ harness: run.harness, workflows: run.flow, context: ctx, plan: planOf(workflow), input, tools: ["prices.quote"], check });
  assert.equal(served.outcome, "complete");
  assert.deepEqual(served.output, { price: 21 });
  assert.equal(served.key, hostKey(workflow.name, workflowSha256(workflow), input));
  assert.equal(hostRunName(served.key), workflow.name);
  assert.deepEqual([served.name, served.sha256, served.canary], [workflow.name, workflowSha256(workflow), false]);
  await run.close();
  assert.deepEqual(tasksIn(run.store).map((line) => line.data.input.key).filter((k, i, all) => all.indexOf(k) === i), [served.key]);
});

test("serve: an output the host's check refuses is an escalation with the check's problems; a gate is an escalation; a failure is failed", async (t) => {
  const cheap = await servingRun({ price: 0 });
  t.after(cheap.close);
  const refused = await serve({ harness: cheap.harness, workflows: cheap.flow, context: ctx, plan: planOf(workflowDoc()), input, tools: ["prices.quote"], check });
  assert.deepEqual([refused.outcome, refused.problems, refused.output], ["escalated", ["/price must be a positive number"], { price: 0 }]);

  const gated = await servingRun();
  t.after(gated.close);
  const big = await serve({ harness: gated.harness, workflows: gated.flow, context: ctx, plan: planOf(workflowDoc({ limit: 5 })), input, tools: ["prices.quote"], check });
  assert.equal(big.outcome, "escalated");
  assert.equal(big.escalation.summary, "needs a person");

  const down = await servingRun({ down: true });
  t.after(down.close);
  const failed = await serve({ harness: down.harness, workflows: down.flow, context: ctx, plan: planOf(workflowDoc()), input, tools: ["prices.quote"], check });
  assert.equal(failed.outcome, "failed");
  assert.match(failed.detail, /registry is down/);
});

test("serve refuses before any task what the agentrun tool would refuse: a code node, a tool the host does not register, an input the workflow does not take", async (t) => {
  const run = await servingRun();
  t.after(run.close);
  const at = (plan, overrides = {}) => serve({ harness: run.harness, workflows: run.flow, context: ctx, plan, input, tools: ["prices.quote"], check, ...overrides });
  const code = await at(planOf(workflowDoc({ code: true })));
  assert.deepEqual([code.outcome, code.key], ["refused", null]);
  assert.match(code.detail, /code nodes \(double\)/);
  const tools = await at(planOf(workflowDoc()), { tools: [] });
  assert.match(tools.detail, /tools this host does not register: prices\.quote/);
  const country = await at(planOf(workflowDoc({ country: true })));
  assert.equal(country.outcome, "refused");
  assert.match(country.detail, /does not take this input/);
  // Its schema takes an input without the sku, and a node reads it: the DSL's check with this input refuses it.
  const optional = workflowDoc({ name: "optional-sku" });
  optional.schemas.In.required = ["amount"];
  const lacking = await at(planOf(optional), { input: { amount: 10 } });
  assert.equal(lacking.outcome, "refused");
  assert.match(lacking.detail, /interpolates \{sku\} but no upstream node produces "sku"/);
  // Past the tool's own workload limits: a map that would quote 100 skus at once.
  const wide = {
    v: 2, name: "wide-map",
    schemas: {
      In: { type: "object", additionalProperties: false, required: ["skus"], properties: { skus: { type: "array", items: { type: "string" } } } },
      Quote: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
      Quotes: { type: "array", items: { type: "object" } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Quotes", path: "quotes" },
    root: { node: "map", label: "each sku", itemsPath: "skus", maxConcurrency: 100, as: "quotes", body: { node: "call", label: "quote", via: "tool", tool: "prices.quote", args: { sku: "{item}" }, out: "Quote", as: "quote", deadline_s: 20 } },
  };
  const many = await at(planOf(wide), { input: { skus: ["A-1", "A-2"] } });
  assert.equal(many.outcome, "refused");
  assert.match(many.detail, /Map concurrency must not exceed 8/);
  // The tool's candidate policy: an agent node with the legacy budget field, which the DSL accepts and never reads.
  const legacy = workflowDoc({ name: "legacy-budget" });
  legacy.root.steps.push({ node: "agent", label: "check the quote", instructions: "Check the quote in the JSON input.", state: { quote: "{quote}" }, out: "Quote", as: "checked", budget: 5 });
  const budget = await at(planOf(legacy));
  assert.equal(budget.outcome, "refused");
  assert.match(budget.detail, /budget is not read; declare budget_usd/);
  await run.close();
  assert.deepEqual(tasksIn(run.store), [], "no task was written");
});

test("a served run is a use of its own digest under its name, with the host's verdict, though the run's store does not hold that revision", async (t) => {
  const workflow = workflowDoc({ name: "registry-lookup" });
  const proven = workflowDoc({ name: "registry-lookup", limit: 500 });
  // The run's store holds the trial it was seeded with; the host served the proven revision, a canary, from the repository.
  const { dir } = await workDirWith({ "registry-lookup": workflow });
  const cheap = await servingRun({ price: 0 });
  t.after(cheap.close);
  const served = await serve({ harness: cheap.harness, workflows: cheap.flow, context: ctx, plan: planOf(proven, { canary: true, trial: workflowSha256(workflow) }), input, tools: ["prices.quote"], check });
  assert.equal(served.canary, true);
  await cheap.close();
  const plain = await readUses({ store: cheap.store, workDir: dir, run: "run-7" });
  assert.equal(plain.doc, undefined, "the store's reader alone never sees it: the revision is not in the run's store");
  const read = await readUses({ store: cheap.store, workDir: dir, run: "run-7", served: [served] });
  const task = tasksIn(cheap.store).at(-1).data;
  assert.deepEqual(read.doc, { version: 1, run: "run-7", uses: [{ name: "registry-lookup", sha256: workflowSha256(proven), outcome: "escalated", at: new Date(task.endedAt).toISOString() }] }, "completed in the store, refused by the host's check: escalated");
});

test("the host's verdict stands for the reader's on a served revision the run's store holds, and a served run that never started is no use", async (t) => {
  const workflow = workflowDoc();
  const { dir } = await workDirWith({ "registry-lookup": workflow });
  const cheap = await servingRun({ price: 0 });
  t.after(cheap.close);
  const served = await serve({ harness: cheap.harness, workflows: cheap.flow, context: ctx, plan: planOf(workflow), input, tools: ["prices.quote"], check });
  const refused = await serve({ harness: cheap.harness, workflows: cheap.flow, context: ctx, plan: planOf(workflowDoc({ code: true })), input, tools: ["prices.quote"], check });
  await cheap.close();
  assert.deepEqual((await readUses({ store: cheap.store, workDir: dir, run: "run-8" })).doc.uses.map((u) => u.outcome), ["frozen"], "the store says it completed");
  const read = await readUses({ store: cheap.store, workDir: dir, run: "run-8", served: [served, refused] });
  assert.deepEqual(read.doc.uses.map((u) => [u.sha256, u.outcome]), [[workflowSha256(workflow), "escalated"]]);
});

test("proposeLearning carries what the host served into the run's uses file", async (t) => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const trial = workflowDoc();
  const proven = workflowDoc({ limit: 500 });
  const { dir } = await workDirWith({ "registry-lookup": trial });
  const run = await servingRun();
  t.after(run.close);
  const served = await serve({ harness: run.harness, workflows: run.flow, context: ctx, plan: planOf(proven, { canary: true, trial: workflowSha256(trial) }), input, tools: ["prices.quote"], check });
  const result = await proposeLearning({ repo, runId: "run-3", target: run.harness, workDir: dir, served: [served] });
  assert.equal(result.status, "proposed");
  const inspector = await openRepo({ dir: path.join(root, "inspector"), remote: local(bare) });
  await inspector.fetch();
  const uses = JSON.parse(await inspector.read("uses/run-3.json", await inspector.resolve("runs/run-3")));
  assert.deepEqual(uses.uses.map((u) => [u.name, u.sha256, u.outcome]), [["registry-lookup", workflowSha256(proven), "frozen"]]);
});

// ---- planServing: what the host serves for a run ------------------------------------------------------------------------

const NAME = "registry-lookup";

/**
 * The agent repository's main holding `entries` (each `{ doc, active? }`, in order) as revisions of NAME: their records and
 * the trial file admitRevision makes of them, the last one live; `active` promotes a revision as curate would. `tamper`
 * changes that entry's record after it was hashed. Returns the repository, main and each digest.
 */
async function revisions(entries, { tamper = -1 } = {}) {
  const { repo } = await agentRepo(await scratch());
  const { dir, store } = await workDirWith({});
  const files = {};
  const digests = [];
  let trial;
  for (const [i, { doc, active }] of entries.entries()) {
    const { digest } = await store.save(NAME, doc);
    digests.push(digest);
    const record = await readFile(path.join(dir, workflowDir(NAME), `${digest}.json`), "utf8");
    files[`${workflowDir(NAME)}/${digest}.json`] = i === tamper ? record.replace('"needs a person"', '"needs someone"') : record;
    const at = `2026-10-20T0${i}:00:00.000Z`;
    trial = trial === undefined
      ? { name: NAME, status: "trial", when: [], revisions: [{ sha256: digest, status: "trial", since: at, run: `run-a${i}`, after: 0 }], uses: [] }
      : admitRevision(trial, { name: NAME, sha256: digest, run: `run-a${i}`, at, when: [] }).trial;
    if (active) trial = { ...trial, status: "active", revisions: trial.revisions.map((r) => (r.sha256 === digest ? { ...r, status: "active" } : r)) };
  }
  files[trialPath(NAME)] = renderTrial(trial);
  return { repo, sha: await commitMain(repo, files), digests };
}

/** The run's working directory as seedWorkflows leaves it: the live revision in the run's own store. */
const seededWith = async (doc) => (await workDirWith({ [NAME]: doc })).dir;
const plan = (repo, sha, workDir, sha256, takes = () => true) => planServing({ repo, sha, workDir, workflows: [{ name: NAME, sha256 }], takes });

test("planServing serves the live revision when it is active, from the run's own store", async () => {
  const a = workflowDoc();
  const { repo, sha, digests: [da] } = await revisions([{ doc: a, active: true }]);
  const picked = await plan(repo, sha, await seededWith(a), da);
  assert.deepEqual([picked.name, picked.sha256, picked.canary, picked.trial], [NAME, da, false, undefined]);
  assert.deepEqual(picked.workflow, a);
});

test("planServing: while a revision is on trial, it serves the one it superseded, read from the repository, a canary", async () => {
  const a = workflowDoc();
  const b = workflowDoc({ limit: 500 });
  const { repo, sha, digests: [da, db] } = await revisions([{ doc: a, active: true }, { doc: b }]);
  const picked = await plan(repo, sha, await seededWith(b), db);
  assert.deepEqual([picked.sha256, picked.canary, picked.trial], [da, true, db]);
  assert.deepEqual(picked.workflow, a);
});

test("planServing serves nothing for a first revision on trial, for a workflow the job's check does not take, for a record that does not hash, or for a seed that is not the live revision", async () => {
  const a = workflowDoc();
  const b = workflowDoc({ limit: 500 });
  const first = await revisions([{ doc: a }]);
  assert.equal(await plan(first.repo, first.sha, await seededWith(a), first.digests[0]), null, "nothing was proven before it: the agent runs it");
  const pair = await revisions([{ doc: a, active: true }, { doc: b }]);
  assert.equal(await plan(pair.repo, pair.sha, await seededWith(b), pair.digests[1], () => false), null, "the host's takes says no");
  const tampered = await revisions([{ doc: a, active: true }, { doc: b }], { tamper: 0 });
  assert.equal(await plan(tampered.repo, tampered.sha, await seededWith(b), tampered.digests[1]), null, "the canary's record does not hash to its digest");
  assert.equal(await plan(pair.repo, pair.sha, await seededWith(a), pair.digests[0]), null, "the run was seeded with a revision that is not the live one");
});

test("planServing passes over a superseded revision whose record does not read, for the one before it", async () => {
  const a = workflowDoc();
  const b = workflowDoc({ limit: 500 });
  const c = workflowDoc({ limit: 700 });
  const { repo, sha, digests: [da, db, dc] } = await revisions([{ doc: a, active: true }, { doc: b, active: true }, { doc: c }], { tamper: 1 });
  const picked = await plan(repo, sha, await seededWith(c), dc);
  assert.deepEqual([picked.sha256, picked.canary, picked.trial], [da, true, dc], `${db.slice(0, 8)}'s record does not hash, so the one before it is served`);
});

test("the package loads on a durable host with none of pi's coding agent, agent core or TUI installed", () => {
  // A resolve hook that refuses those packages, as if they were not installed, then the package's entry point.
  const hooks = `export async function resolve(specifier, context, next) { if (/^@earendil-works\\/pi-(coding-agent|agent-core|tui)(\\/|$)/.test(specifier)) throw new Error("not installed: " + specifier); return next(specifier, context); }`;
  const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", `await import(${JSON.stringify(entry)}); console.log("loaded");`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "loaded");
});

test("serve's workload limits are the agentrun tool's own: at each limit the tool and serve agree, one past it both refuse", async (t) => {
  const { WorkflowExtensionService } = await import("@parcha/agentrun-pi");
  const toolTakes = (doc, input) => { try { new WorkflowExtensionService({ allowedTools: ["prices.quote"] }).preflight(doc, input); return true; } catch { return false; } };
  const quote = (label) => ({ node: "call", label, via: "tool", tool: "prices.quote", args: { sku: "{sku}" }, out: "Quote", as: label.replace(/\W/g, "_"), deadline_s: 20 });
  const schemas = {
    In: { type: "object", additionalProperties: false, required: ["sku", "skus"], properties: { sku: { type: "string" }, skus: { type: "array", items: { type: "string" } } } },
    Quote: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    Any: { type: "object" },
  };
  const doc = (name, root) => ({ v: 2, name, schemas, input: { schemaId: "In" }, output: { schemaId: "Any", path: "out" }, root });
  const map = (n) => doc(`map-${n}`, { node: "map", label: "each", itemsPath: "skus", maxConcurrency: n, as: "out", body: { ...quote("q"), args: { sku: "{item}" } } });
  const parallel = (n) => doc(`parallel-${n}`, { node: "parallel", label: "all", branches: Array.from({ length: n }, (_, i) => quote(`q${i}`)) });
  const chain = (n) => doc(`chain-${n}`, { node: "chain", steps: Array.from({ length: n - 1 }, (_, i) => (i === n - 2 ? { ...quote(`q${i}`), as: "out" } : quote(`q${i}`))) });
  const input = { sku: "A-1", skus: ["A-1"] };
  const run = await servingRun();
  t.after(run.close);
  const serveRefuses = async (d) => (await serve({ harness: run.harness, workflows: run.flow, context: ctx, plan: planOf(d), input, tools: ["prices.quote"], check: () => [] })).outcome === "refused";
  for (const [what, make, limit] of [["map concurrency", map, SERVE_LIMITS.maxMapConcurrency], ["parallel branches", parallel, SERVE_LIMITS.maxParallelBranches], ["nodes", chain, SERVE_LIMITS.maxNodes]]) {
    assert.equal(toolTakes(make(limit), input), true, `the tool takes ${what} at ${limit}`);
    assert.equal(toolTakes(make(limit + 1), input), false, `the tool refuses ${what} at ${limit + 1}`);
    assert.equal(await serveRefuses(make(limit + 1)), true, `serve refuses ${what} at ${limit + 1}`);
  }
});
