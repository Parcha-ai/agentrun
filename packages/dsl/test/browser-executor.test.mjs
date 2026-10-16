// `@parcha/agentrun-dsl/browser/executor`: the DSL's own code-node executor (compileTransform, deniedGlobalReferences,
// DENIED_GLOBALS) for a Web Worker the host has locked down. It is the very module Node runs (code-exec.ts), a denylist
// plus new Function and NOT a sandbox; neither ./browser nor ./browser/worker reaches it; and in a worker it answers what
// Node answers over the code nodes of the conformance corpus and a set of refusals.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { compileTransform, deniedGlobalReferences } from '../dist/code-exec.js';

const bundle = async (specifier, format = 'esm', globalName) => {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format, ...(globalName ? { globalName } : {}), write: false, logLevel: 'silent', metafile: true });
  return { text: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) };
};

test('the executor bundles for the browser platform with no node: import and no Buffer, and it is the code that compiles with new Function', async () => {
  const { text } = await bundle('@parcha/agentrun-dsl/browser/executor');
  assert.doesNotMatch(text, /["']node:/);
  assert.doesNotMatch(text, /\bBuffer\b/);
  assert.match(text, /new Function\(/, 'the executor is a new Function: it says so');
  const module = await import('@parcha/agentrun-dsl/browser/executor');
  assert.deepEqual(Object.keys(module).sort(), ['DENIED_GLOBALS', 'compileTransform', 'deniedGlobalReferences']);
});

test('./browser and ./browser/worker never reach the executor, its module, or the code that compiles: it is reachable by its own subpath only', async () => {
  for (const specifier of ['@parcha/agentrun-dsl/browser', '@parcha/agentrun-dsl/browser/worker']) {
    const { inputs, text } = await bundle(specifier);
    const reached = inputs.filter((file) => /(?:^|\/)(?:code-exec|denied-globals)\.[jt]s$|browser\/executor\.[jt]s$/.test(file));
    assert.deepEqual(reached, [], `${specifier} reaches ${reached.join(', ')}`);
    assert.doesNotMatch(text, /new\s+(?:globalThis\.)?Function\b/);
  }
  const sources = new URL('../src/', import.meta.url);
  const importers = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
    else if (entry.name.endsWith('.ts') && /from\s+["'][^"']*(?:browser\/executor|\.\/executor)(?:\.js)?["']/.test(readFileSync(new URL(entry.name, dir), 'utf8'))) importers.push(fileURLToPath(new URL(entry.name, dir)));
  } };
  walk(sources);
  assert.deepEqual(importers, [], 'no module imports the executor; a host does, by its subpath');
});

// ---- Node against the executor, in a worker, over one corpus --------------------------------------------------------

const corpus = readdirSync(fileURLToPath(new URL('../../../spec/lean/conformance/', import.meta.url))).filter((file) => file.endsWith('.json')).sort()
  .map((file) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/lean/conformance/${file}`, import.meta.url)), 'utf8')).workflow);
const codeOf = (node, found = []) => {
  if (node && typeof node === 'object') {
    if (node.node === 'code' && typeof node.code === 'string') found.push(node.code);
    for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach((item) => codeOf(item, found)); else codeOf(value, found); }
  }
  return found;
};
const REFUSALS = [
  '(s) => ({ pid: process.pid })', '(s) => fetch("http://x.invalid")', '(s) => new Function("return 1")()', '(s) => globalThis.x', '(s) => Buffer.from("a")',
  '(s) => setTimeout(() => 1, 0)', '(s) => Date.now()', '(s) => Promise.resolve(1)', '(s) => require("fs")', '(s) => module.exports', '(s) => typeof XMLHttpRequest',
  'async (s) => ({ a: 1 })', '(s) => (async () => ({}))()', '(s) => ({ then(resolve) { resolve(1); } })', '(s) => { throw new Error("boom"); }', '(s) => s.missing.deep',
  '(s) => ({ a: 1', 'not a function', '42', '', '   ', '(s, ctx) => ({ label: ctx && ctx.label, n: s.v })', '(s) => s', '(s) => [1, 2, 3].map((n) => n * s.v)',
  '(s) => { const re = /process|fetch/; return { ok: re.test("process") }; }', '(s) => "global process fetch in a string"', '(s) => `${s.v} Function Buffer`',
];
const STATE = { question: ' wiki ', v: 2, items: [1, 2], nested: { a: [1, { b: 2 }] } };
const CTX = { sop: '', label: 'probe', executionPath: '/root' };

const attempt = (compile, source) => {
  let fn;
  try { fn = compile(source); } catch (error) { return { compile: String(error?.message ?? error) }; }
  try { return { value: JSON.parse(JSON.stringify(fn(structuredClone(STATE), { ...CTX }) ?? null)) }; } catch (error) { return { run: String(error?.message ?? error) }; }
};

async function inWorker(sources) {
  const { text } = await bundle('@parcha/agentrun-dsl/browser/executor', 'iife', 'Executor');
  const script = `${text}
const { parentPort, workerData } = require("node:worker_threads");
const STATE = ${JSON.stringify(STATE)}, CTX = ${JSON.stringify(CTX)};
const attempt = ${attempt.toString()};
parentPort.postMessage({
  attempts: workerData.sources.map((source) => attempt(Executor.compileTransform, source)),
  denied: workerData.sources.map((source) => Executor.deniedGlobalReferences(source)),
  list: Executor.DENIED_GLOBALS,
});`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: true, workerData: { sources } });
    worker.once('message', (message) => { resolve(message); void worker.terminate(); });
    worker.once('error', reject);
  });
}

test('in a worker the executor answers what Node answers: the same outputs, the same refusals, the same denied-global errors, over the corpus\'s code nodes and the refusals', async () => {
  const sources = [...new Set([...corpus.flatMap((workflow) => codeOf(workflow)), ...REFUSALS])];
  assert.ok(sources.length >= 60, `${sources.length} code sources`);
  const viaWorker = await inWorker(sources);
  const viaNode = sources.map((source) => attempt(compileTransform, source));
  for (const [index, source] of sources.entries()) {
    assert.deepEqual(viaWorker.attempts[index], viaNode[index], source);
    assert.deepEqual(viaWorker.denied[index], deniedGlobalReferences(source), source);
  }
  // Both sides refuse and accept, so the comparison is not two silences.
  assert.ok(viaNode.some((row) => 'value' in row), 'some code runs');
  assert.ok(viaNode.some((row) => 'compile' in row), 'some code is refused at compile');
  assert.ok(viaNode.some((row) => 'run' in row && /undefined|reading|not a function|boom/.test(row.run)), 'some code fails when it runs, a denied global among it');
  assert.ok(viaNode.some((row) => /synchronous/.test(row.compile ?? row.run ?? '')), 'the sync-only refusals are among them');
  const { DENIED_GLOBALS } = await import('../dist/denied-globals.js');
  assert.deepEqual(viaWorker.list, DENIED_GLOBALS);
});
