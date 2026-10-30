// One host tool list, two harnesses: the same workflow on the Pi runner and on the Claude Agent adapter offers the
// model the same tool names and calls the same host tools, by the same names. The names are serve's node tools (read,
// write, edit), given as data: a node's tools come from its host's list whichever harness runs it. Both harnesses are
// scripted: Pi through a session factory that plays the model, the Claude Agent adapter on its scripted Agent SDK, whose
// model requests go through the session's real proxy. No network, no key, no CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createPiRunner } from '@parcha/agentrun-pi';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
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

async function onClaude() {
  const calls = [];
  let offered;
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  // The scripted SDK runs one scripted call per turn: one turn each.
  const sdk = fakeSdk({ remoteModel: true, mirrorLagMs: 10, script: SCRIPT.map(([name, args]) => `call ${name} ${JSON.stringify(args)}`) });
  const claude = claudeAgentAdapter({
    // The host's tools only, which is what this compares across runners; the CLI's own are on by default.
    builtins: false,
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir: join(ROOT, 'claude-sessions'),
    sdk,
    standIn: { command: process.execPath },
  });
  const watched = { ...claude, check: (spec) => claude.check(spec), open: (spec, io) => { offered = spec.tools.map((t) => t.name); return claude.open(spec, io); } };
  const runNode = createHarnessRunner(watched, { store: memorySessionStore(), tools: asSeam(hostTools(calls)) });
  try {
    const result = await runWorkflow(WORKFLOW, {}, { runNode });
    return { result, calls, offered };
  } finally {
    await provider.close();
  }
}

test("the same workflow and host tools record identical tool names on the Pi runner and the Claude Agent adapter", async () => {
  const pi = await onPi();
  const claude = await onClaude();
  assert.equal(pi.result.status, 'complete', JSON.stringify(pi.result.error ?? null));
  assert.equal(claude.result.status, 'complete', JSON.stringify(claude.result.error ?? null));
  assert.deepEqual(claude.result.output, pi.result.output);
  // Fixed by hand: the node names read and edit of the host's read, write and edit, and both runners add submit.
  assert.deepEqual([...pi.offered].sort(), ['edit', 'read', 'submit']);
  assert.deepEqual([...claude.offered].sort(), [...pi.offered].sort());
  assert.deepEqual(pi.calls, [['read', { path: 'notes.md' }], ['edit', { path: 'notes.md' }]]);
  assert.deepEqual(claude.calls, pi.calls);
});
