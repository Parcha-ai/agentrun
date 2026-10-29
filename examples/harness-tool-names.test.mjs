// One host tool list, two harnesses: the same workflow on the Pi runner and on the Codex adapter offers the model the
// same tool names and calls the same host tools, by the same names. The names are serve's node tools (read, write,
// edit), given as data: a node's tools come from its host's list whichever harness runs it. Both harnesses are scripted:
// Pi through a session factory that plays the model, Codex on its stand-in app-server. No network, no key.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createPiRunner } from '@parcha/agentrun-pi';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { codexAdapter } from '@parcha/agentrun-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const STAND_IN = fileURLToPath(new URL('../packages/run-adapters-codex/test/fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'harness-names-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** The host's tools, once: serve's node tool names, each recording its calls. */
function hostTools(calls) {
  const tool = (name) => ({ name, description: `The host's ${name}.`, inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, run: async (args) => { calls.push([name, args]); return `${name} ok`; } });
  return ['read', 'write', 'edit'].map(tool);
}
const asPi = (tools) => tools.map((t) => ({ name: t.name, label: t.name, description: t.description, parameters: t.inputSchema, execute: async (_id, params) => ({ content: [{ type: 'text', text: await t.run(params) }], details: {} }) }));
const asSeam = (tools) => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, replay: 'safe', call: async (args) => ({ text: await t.run(args) }) }));

const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const WORKFLOW = { v: 2, name: 'names', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'agent', label: 'edit', instructions: 'Read the notes, then edit them.', tools: ['read', 'edit'], out: 'Out', as: 'final' } };
/** What the model does: read, edit, then deliver. */
const SCRIPT = [['read', { path: 'notes.md' }], ['edit', { path: 'notes.md' }], ['submit', { value: { answer: 'edited' } }]];

async function onPi() {
  const calls = [];
  let offered;
  const runNode = createPiRunner({
    model: {}, modelRuntime: {}, tools: asPi(hostTools(calls)), cwd: ROOT,
    sessionFactory: async (config) => {
      offered = [...config.tools];
      const byName = new Map(config.customTools.map((t) => [t.name, t]));
      return { session: {
        subscribe: () => () => {}, async abort() {}, dispose() {},
        async prompt() { for (const [name, args] of SCRIPT) await byName.get(name).execute(`call_${name}`, args, undefined, undefined, {}); },
      } };
    },
  });
  const result = await runWorkflow(WORKFLOW, {}, { runNode });
  return { result, calls, offered };
}

async function onCodex() {
  const calls = [];
  let offered;
  const script = join(mkdtempSync(join(ROOT, 'codex-')), 'script.json');
  // The stand-in runs one scripted call per turn: one turn each.
  writeFileSync(script, JSON.stringify(SCRIPT.map(([name, args]) => `call ${name} ${JSON.stringify(args)}`)));
  const codex = codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    sessionsDir: join(ROOT, 'codex-sessions'),
    standIn: { command: process.execPath, args: [STAND_IN], env: { FAKE_CODEX_MODEL: 'remote', FAKE_CODEX_SCRIPT: script } },
    // What the stand-in says goes through the session's proxy as a model request, so the runner's turn cap holds.
    fetch: async () => new Response(`data: ${JSON.stringify({ delta: 'ok' })}\n\ndata: ${JSON.stringify({ delta: '', response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\ndata: [DONE]\n\n`, { status: 200 }),
  });
  const watched = { ...codex, open: (spec, io) => { offered = spec.tools.map((t) => t.name); return codex.open(spec, io); } };
  const runNode = createHarnessRunner(watched, { store: memorySessionStore(), tools: asSeam(hostTools(calls)) });
  const result = await runWorkflow(WORKFLOW, {}, { runNode });
  return { result, calls, offered };
}

test("the same workflow and host tools record identical tool names on the Pi runner and the Codex adapter", async () => {
  const pi = await onPi();
  const codex = await onCodex();
  assert.equal(pi.result.status, 'complete', JSON.stringify(pi.result.error ?? null));
  assert.equal(codex.result.status, 'complete', JSON.stringify(codex.result.error ?? null));
  assert.deepEqual(codex.result.output, pi.result.output);
  // Fixed by hand: the node names read and edit of the host's read, write and edit, and both runners add submit.
  assert.deepEqual([...pi.offered].sort(), ['edit', 'read', 'submit']);
  assert.deepEqual([...codex.offered].sort(), [...pi.offered].sort());
  assert.deepEqual(pi.calls, [['read', { path: 'notes.md' }], ['edit', { path: 'notes.md' }]]);
  assert.deepEqual(codex.calls, pi.calls);
});
