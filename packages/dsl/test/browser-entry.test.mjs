// The browser entries of @parcha/agentrun-dsl (`./browser`, `./browser/worker`): bundles for the browser platform
// hold no node: import, no Buffer and no eval or new Function; the same workflows validate, inspect and dry-run to
// the same results in Node and in a worker; the worker entry runs a code node only through the host's runCode.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { dryRunWorkflow, inspectWorkflow, validateWorkflow, workflowSha256 } from "../dist/index.js";

const SUBPATHS = ["@parcha/agentrun-dsl/browser", "@parcha/agentrun-dsl/browser/worker"];
const CORPUS_DIR = fileURLToPath(new URL("../../../spec/lean/conformance/", import.meta.url));

const bundle = async (specifier, format = "esm", globalName) => {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  const result = await build({ entryPoints: [entry], bundle: true, platform: "browser", format, ...(globalName ? { globalName } : {}), write: false, logLevel: "silent", metafile: true });
  return { text: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) };
};

for (const specifier of SUBPATHS) {
  test(`${specifier} bundles for the browser platform: no node: import, no Buffer, no node built-in anywhere in the graph`, async () => {
    const { text, inputs } = await bundle(specifier);
    assert.doesNotMatch(text, /["']node:/);
    assert.doesNotMatch(text, /\bBuffer\b/);
    assert.doesNotMatch(text, /\brequire\(/);
    assert.ok(inputs.every((file) => !file.startsWith("node:")), inputs.filter((file) => file.startsWith("node:")).join(", "));
  });

  test(`${specifier} holds no eval and no new Function: code runs only if the host's runCode supplies it`, async () => {
    const { text } = await bundle(specifier);
    assert.doesNotMatch(text, /\beval\s*\(/);
    assert.doesNotMatch(text, /new\s+(?:globalThis\.|self\.|window\.)?Function\b/);
    assert.doesNotMatch(text, /(?<![\w.$])(?:globalThis\.|self\.|window\.)?Function\s*\(/);
    assert.doesNotMatch(text, /\bimport\s*\(/);
  });
}

const cases = readdirSync(CORPUS_DIR).filter((file) => file.endsWith(".json")).sort().map((file) => ({ file, ...JSON.parse(readFileSync(CORPUS_DIR + file, "utf8")) }));

// The host's executor for code nodes, the same text in Node and in the worker: it is the host's, not the bundle's.
const HOST_RUN_CODE = `async (node, state, ctx) => new Function("s", "ctx", "return (" + node.code + ")(s, ctx)")(state, ctx)`;
const hostRunCode = eval(HOST_RUN_CODE);

const workerSource = (iife) => `${iife}
const { parentPort } = require("node:worker_threads");
const scope = { postMessage: (message) => parentPort.postMessage(message), addEventListener: (type, listener) => parentPort.on("message", (data) => listener({ data })) };
AgentRunWorker.serveWorker(scope, { runCode: ${HOST_RUN_CODE} });
`;

async function startWorker() {
  const { text } = await bundle("@parcha/agentrun-dsl/browser/worker", "iife", "AgentRunWorker");
  const worker = new Worker(workerSource(text), { eval: true });
  const pending = new Map();
  let next = 1;
  worker.on("message", (message) => { pending.get(message.id)?.(message); pending.delete(message.id); });
  const ask = (op, payload) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); worker.postMessage({ id, op, ...payload }); });
  return { ask, stop: () => worker.terminate() };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("the same workflows validate, inspect, dry-run and hash to the same results in Node and in a worker", async () => {
  assert.ok(cases.length >= 40, `the conformance corpus is present (${cases.length})`);
  const { ask, stop } = await startWorker();
  try {
    for (const { file, workflow, input } of cases) {
      const viaNode = {
        validate: plain(validateWorkflow(workflow, { executeCode: false })),
        inspect: plain(inspectWorkflow(workflow)),
        dryRun: plain(await dryRunWorkflow(workflow, { runCode: hostRunCode, ...(input && typeof input === "object" ? { input } : {}) })),
        sha256: workflowSha256(workflow),
      };
      const viaWorker = {};
      for (const [op, payload] of [["validate", {}], ["inspect", {}], ["dryRun", { options: { ...(input && typeof input === "object" ? { input } : {}) } }], ["sha256", {}]]) {
        const reply = await ask(op, { workflow, ...payload });
        assert.equal(reply.ok, true, `${file} ${op}: ${JSON.stringify(reply.error)}`);
        viaWorker[op] = reply.result;
      }
      assert.deepEqual(viaWorker, viaNode, file);
    }
  } finally { await stop(); }
});

test("the worker reports an invalid workflow the way Node does, and answers a bad request with an error, never a hang", async () => {
  const { ask, stop } = await startWorker();
  try {
    const broken = { v: 2, name: "broken", schemas: {}, output: { schemaId: "Missing", path: "x" }, root: { node: "chain", steps: [] } };
    const node = plain(validateWorkflow(broken, { executeCode: false }));
    assert.equal(node.ok, false);
    assert.deepEqual((await ask("validate", { workflow: broken })).result, node);
    const unknown = await ask("explode", { workflow: broken });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error.message, /unknown op/i);
  } finally { await stop(); }
});

test("serveWorker without a runCode throws: there is no default way to run code", async () => {
  const { serveWorker } = await import("@parcha/agentrun-dsl/browser/worker");
  const scope = { postMessage() {}, addEventListener() {} };
  assert.throws(() => serveWorker(scope), /runCode/);
  assert.throws(() => serveWorker(scope, {}), /runCode/);
  assert.throws(() => serveWorker(scope, { runCode: "(s) => s" }), /runCode/);
});

test("a code node reaches only the host's runCode; with none, the browser entry's dry run reports it and evaluates nothing", async () => {
  const { dryRunWorkflow: browserDryRun } = await import("@parcha/agentrun-dsl/browser");
  const flow = { v: 2, name: "code-flow", schemas: { Out: { type: "object" } }, output: { schemaId: "Out", path: "final" },
    root: { node: "code", label: "go", code: "(s) => { globalThis.__ran = true; return { final: { ok: true } }; }" } };
  delete globalThis.__ran;
  const without = await browserDryRun(flow);
  assert.equal(without.ok, false);
  assert.match(without.problems.join(" "), /runCode/);
  assert.equal(globalThis.__ran, undefined, "the browser entry evaluated nothing");
  const seen = [];
  const withHost = await browserDryRun(flow, { runCode: async (node) => { seen.push(node.label); return { final: { ok: true } }; } });
  assert.equal(withHost.ok, true, JSON.stringify(withHost));
  assert.deepEqual(seen, ["go"]);
});
