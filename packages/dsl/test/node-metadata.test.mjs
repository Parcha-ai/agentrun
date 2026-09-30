// `metadata` is the host's field on every node: any JSON object, checked only for being an object,
// carried verbatim through desugaring, dry runs, runs and the author's candidate loop, included in
// the document digest, and never read. These tests pin that contract against the shared corpus.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateWorkflow, runWorkflow, dryRunWorkflow, desugarWorkflow, workflowSha256, applyHostOutputTypes, authorWorkflow,
  renderAuthorContract, renderAuthorHostAddendum, candidatePolicyErrors, WORKFLOW_NODE_KINDS, HOST_NODE_FIELDS, NODE_FIELDS,
} from "../dist/index.js";
import { loadCases } from "./lean-conformance-harness.mjs";

const MARK = (path) => ({ preset: "default", origin: path, nested: { list: [1, "two", null, { deep: true }], n: 3.5 }, empty: {} });

/** A deep copy of a workflow with `metadata` on every node, child workflows included. */
function withMetadata(workflow) {
  const visit = (node, path) => {
    if (!node || typeof node !== "object" || typeof node.node !== "string") return node;
    const out = { ...node, metadata: MARK(path) };
    if (Array.isArray(node.steps)) out.steps = node.steps.map((step, i) => visit(step, `${path}/steps/${i}`));
    if (node.node === "parallel" && Array.isArray(node.branches)) out.branches = node.branches.map((b, i) => visit(b, `${path}/branches/${i}`));
    if ((node.node === "route" || node.node === "dispatch") && node.branches) out.branches = Object.fromEntries(Object.entries(node.branches).map(([k, b]) => [k, { ...b, body: visit(b.body, `${path}/branches/${k}`) }]));
    if (node.body) out.body = visit(node.body, `${path}/body`);
    if (node.node === "workflow" && node.workflow) out.workflow = withMetadata(node.workflow);
    return out;
  };
  return { ...structuredClone(workflow), root: visit(structuredClone(workflow.root), "/root") };
}

/** Every node's kind and metadata, in document order. */
function metadataOf(workflow) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.node === "string") found.push([node.node, node.metadata]);
    for (const [key, value] of Object.entries(node)) {
      if (key === "metadata") continue;
      if (key === "workflow" && value?.root) visit(value.root);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(workflow.root);
  return found;
}

const object = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
/** The kinds the Lean corpus does not cover (decide, extract, sift) plus a prose artifact that desugars. */
const KITCHEN = {
  v: 2, name: "kitchen",
  schemas: {
    Input: object({ text: { type: "string" } }),
    Facts: object({ items: { type: "array", items: object({ title: { type: "string" } }) } }),
    Verdict: object({ ok: { type: "boolean" } }),
    Relevance: object({ keep: { type: "boolean", description: "Does this item bear on the text?" } }),
    Any: { type: "object" },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Any" },
  root: { node: "chain", steps: [
    { node: "extract", label: "facts", instructions: "List the items.", out: "Facts", as: "facts", tools: [] },
    { node: "decide", label: "verdict", instructions: "Judge the items.", out: "Verdict", as: "verdict", tools: [] },
    { node: "sift", label: "rank", itemsPath: "facts.items", describe: "{item.title}", out: "Relevance", as: "ranked", keep: { path: "keep" } },
    { node: "artifact", label: "brief", type: "markdown", instructions: "Write the brief.", tools: [] },
  ] },
};
const KITCHEN_CASE = {
  file: "kitchen", case: { workflow: KITCHEN, input: { text: "t" }, script: {
    gen: { "/root/steps/0": { submission: { items: [{ title: "a" }, { title: "b" }] } }, "/root/steps/1": { submission: { ok: true } }, "/root/steps/3": { markdown: "# Brief\n\nItem a bears on the text; item b does not." } },
    judge: { "/root/steps/2": { answers: { "0.keep": { type: "noul", noul: 0.9 }, "1.keep": { type: "noul", noul: 0.2 } } } },
  } },
};
const CORPUS = [...loadCases(), KITCHEN_CASE];

test("metadata is a host field every node kind admits and the author is not taught per kind", () => {
  assert.deepEqual([...HOST_NODE_FIELDS], ["metadata"]);
  for (const kind of WORKFLOW_NODE_KINDS) assert.ok(!NODE_FIELDS[kind].includes("metadata"), `${kind} lists metadata as its own field`);
  const kinds = new Set(CORPUS.flatMap(({ case: c }) => metadataOf(c.workflow).map(([kind]) => kind)));
  assert.deepEqual([...WORKFLOW_NODE_KINDS].filter((kind) => !kinds.has(kind)), [], "the corpus covers every node kind");
});

test("metadata on every node leaves every validation verdict and error unchanged, and survives desugaring verbatim", () => {
  for (const { file, case: c } of CORPUS) {
    const marked = withMetadata(c.workflow);
    assert.deepEqual(validateWorkflow(marked, { input: c.input }), validateWorkflow(c.workflow, { input: c.input }), file);
    assert.deepEqual(validateWorkflow(marked), validateWorkflow(c.workflow), `${file} without input`);
    const expected = metadataOf(marked).map(([, meta]) => meta);
    assert.ok(expected.every((meta) => meta !== undefined), file);
    assert.deepEqual(metadataOf(desugarWorkflow(marked)).map(([, meta]) => meta), expected, file);
  }
  const brief = desugarWorkflow(withMetadata(KITCHEN)).root.steps[3];
  assert.equal(brief.node, "report", "a prose artifact desugars to the report writer");
  assert.deepEqual(brief.metadata, MARK("/root/steps/3"));
});

test("a non-object metadata is refused and the error names the node", () => {
  const doc = (metadata, step = { node: "agent", label: "draft", instructions: "Do it.", out: "Any", as: "draft", tools: [] }) => ({
    v: 2, name: "m", schemas: { Any: { type: "object" } }, output: { schemaId: "Any" },
    root: { node: "chain", steps: [{ ...step, metadata }] },
  });
  for (const bad of ["preset", ["preset"], 3, true, null]) {
    const result = validateWorkflow(doc(bad));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.deepEqual(result.errors, ["workflow.root.steps[0] (draft): metadata must be a plain object of host markers"], JSON.stringify(bad));
  }
  const nested = validateWorkflow({ ...doc({}), root: { node: "chain", metadata: "x", steps: doc({}).root.steps } });
  assert.deepEqual(nested.errors, ["workflow.root (chain): metadata must be a plain object of host markers"], "a node without a label is named by its kind");
  for (const good of [{}, { preset: "default" }, { a: [1, { b: null }], "$host": "anything", "": 0 }]) assert.deepEqual(validateWorkflow(doc(good)), { ok: true }, JSON.stringify(good));
});

/** One scripted run recording everything the engine emits or asks for; functions and timings are dropped. */
async function observe(c, workflow) {
  const need = (kind, path) => {
    const entry = c.script?.[kind]?.[path];
    if (!entry) throw new Error(`no scripted ${kind} at ${path}`);
    if (entry.throw) throw new Error(entry.throw);
    return structuredClone(entry);
  };
  const log = [];
  const deps = {
    runNode: async ({ signal, review, ...request }) => { log.push(["runNode", request]); const e = need("gen", request.executionPath); return request.kind === "report" ? { report_markdown: e.markdown } : e.submission; },
    runJudge: async ({ signal, ...request }) => { log.push(["runJudge", request]); return { answers: need("judge", request.executionPath).answers }; },
    runEffect: async ({ signal, node, ...request }) => { log.push(["runEffect", request, node.label]); return need("effect", request.executionPath).result; },
    checkpoint: async (state, label, executionPath) => { log.push(["checkpoint", structuredClone(state), label, executionPath]); },
    onEvent: (event) => log.push(["event", { ...event, detail: event.detail && typeof event.detail === "object" && "duration_ms" in event.detail ? { ...event.detail, duration_ms: 0 } : event.detail }]),
  };
  const hostChannel = Object.values(c.script?.gen ?? {}).some((entry) => entry.host !== undefined);
  if (hostChannel || c.script?.after) deps.hostPolicy = {
    ...(hostChannel ? { decodeSubmission: (raw, ctx) => ({ value: raw, host: c.script.gen[ctx.executionPath]?.host }) } : {}),
    ...(c.script.after ? { afterNode: (ctx) => structuredClone(c.script.after[ctx.executionPath]) } : {}),
  };
  let result;
  try { result = await runWorkflow(workflow, structuredClone(c.input), deps); }
  catch (error) { result = { thrown: error?.name, message: String(error?.message ?? error) }; }
  return JSON.stringify({ result, log });
}

test("a run with metadata on every node produces byte-equal state, output, events, checkpoints and adapter requests", async () => {
  let ran = 0, completed = 0;
  for (const { file, case: c } of CORPUS) {
    if (!validateWorkflow(c.workflow, { input: c.input }).ok) continue;
    const plain = await observe(c, c.workflow);
    assert.equal(await observe(c, withMetadata(c.workflow)), plain, file);
    assert.ok(!plain.includes('"origin"'), file);
    ran++;
    if (JSON.parse(plain).result.status === "complete") completed++;
  }
  assert.ok(ran >= 30 && completed >= 15, `ran ${ran} cases, ${completed} complete`);
  const kitchen = JSON.parse(await observe(KITCHEN_CASE.case, withMetadata(KITCHEN)));
  assert.equal(kitchen.result.status, "complete");
  assert.deepEqual(kitchen.result.state.ranked.items, [{ title: "a" }]);
  assert.equal(kitchen.result.state.report_markdown, "# Brief\n\nItem a bears on the text; item b does not.");
});

test("a dry run is unchanged by metadata; the document digest covers it", async () => {
  for (const { file, case: c } of CORPUS) {
    const marked = withMetadata(c.workflow);
    assert.deepEqual(await dryRunWorkflow(marked, { input: c.input }), await dryRunWorkflow(c.workflow, { input: c.input }), file);
    assert.notEqual(workflowSha256(marked), workflowSha256(c.workflow), file);
    assert.equal(workflowSha256(marked), workflowSha256(withMetadata(c.workflow)), file);
  }
});

test("the author contract names metadata once; a host may name its keys; candidates keep metadata verbatim", async () => {
  const { text } = renderAuthorContract();
  assert.ok(text.includes("Every kind also accepts `metadata`, an object the host owns and the engine never reads; set only the keys the host addendum names."));
  assert.equal(text.split("`metadata`").length - 1, 1, "taught once, not per kind");
  assert.equal(renderAuthorHostAddendum({ name: "Host" }).includes("metadata"), false);
  const host = { name: "Host", metadataKeys: { preset: "the plan preset that generated the node" } };
  assert.ok(renderAuthorHostAddendum(host).includes("- A node's `metadata` may carry only these keys: `preset` (the plan preset that generated the node)."));
  assert.notEqual(renderAuthorContract({ host }).sha256, renderAuthorContract({ host: { name: "Host" } }).sha256);

  const candidate = withMetadata(KITCHEN);
  const outputHost = { name: "Host", outputTypes: { brief: { kind: "prose", description: "the brief" } } };
  assert.deepEqual(candidatePolicyErrors(candidate, {}), candidatePolicyErrors(KITCHEN, {}));
  const viewed = applyHostOutputTypes({ ...candidate, root: { ...candidate.root, steps: candidate.root.steps.map((s) => s.node === "artifact" ? { ...s, type: "brief" } : s) } }, outputHost);
  assert.deepEqual(viewed.root.steps[3].metadata, MARK("/root/steps/3"));

  const dir = await mkdtemp(join(tmpdir(), "agentrun-metadata-"));
  const authored = await authorWorkflow({ request: "Brief the text", outputDir: dir, inputKeys: ["text"], allowExecutableCandidates: true,
    runNode: async ({ review }) => { assert.deepEqual(await review(structuredClone(candidate)), { accepted: true }); return candidate; } });
  assert.deepEqual(authored.workflow, candidate);
  assert.deepEqual(metadataOf(authored.workflow), metadataOf(candidate));
});
