// ARM H's pick node at $0 (research/PREREG-armH-agent-pick.md, Clarification 1): the step that picks the code, found by
// structure (the first non-decide node whose output carries the code field), runs on the root's model and thinking with
// its own tools and the run's read tools; every other node, and every node with the flag off, runs as before.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHomeFor, meteredJudge, prepareRun, runJob } from './host.mjs';
import { PRICES } from './models.mjs';
import { PICK_NODE_INSTRUCTIONS, pickNodeOf } from './pick-node.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { readJson, scriptedModel } from './scripted.mjs';
import { agentScriptMcc, CLASSIFY_MERCHANT, FIXTURES_MCC, MCC_WORKFLOW } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';

const S = { Answer: { type: 'object', properties: { mcc: { type: 'string' }, riskTier: { type: 'string' } } }, Mcc: { type: 'object', properties: { mcc: { type: 'string' }, quote: { type: 'string' } } }, Page: { type: 'object', properties: { text: { type: 'string' } } } };
const flow = (steps, schemas = S) => ({ v: 2, name: 'w', schemas, input: { schemaId: 'Page' }, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'chain', steps } });

test('the pick step is the first non-decide node whose output carries the code field: a decide that carries it is skipped, wherever it stands', () => {
  // merchant-mcc-risk b46d0494's shape: an agent picks the code, a decide assembles the answer and copies it.
  assert.equal(pickNodeOf(flow([
    { node: 'call', label: 'read-home', out: 'Page', as: 'home' },
    { node: 'agent', label: 'survey', out: 'Page', as: 'survey' },
    { node: 'agent', label: 'choose-mcc', out: 'Mcc', as: 'mcc' },
    { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' },
  ]), 'mcc'), 'choose-mcc');
  // A decide BEFORE the picking agent is skipped too; so is one nested in a route.
  assert.equal(pickNodeOf(flow([
    { node: 'route', label: 'r', branches: [{ when: {}, then: { node: 'decide', label: 'draft', out: 'Answer', as: 'answer' } }] },
    { node: 'agent', label: 'choose', out: 'Mcc', as: 'mcc' },
  ]), 'mcc'), 'choose');
  // classify-company 167836927e37's shape: an agent picks, an extract assembles; the first in order is the agent.
  const sec = { Answer: { type: 'object', properties: { sic4: { type: 'string' } } }, Sic: { type: 'object', properties: { sic4: { type: 'string' } } } };
  assert.equal(pickNodeOf(flow([{ node: 'agent', label: 'choose-sic', out: 'Sic', as: 'sic' }, { node: 'extract', label: 'assemble', out: 'Answer', as: 'answer' }], sec), 'sic4'), 'choose-sic');
  // A workflow whose output has no code field is no whole-job workflow: nothing to pick.
  assert.equal(pickNodeOf({ ...flow([{ node: 'agent', label: 'x', out: 'Mcc', as: 'x' }]), output: { schemaId: 'Page', path: 'x' } }, 'mcc'), null);
});

test('refused: a workflow that answers with the code but outputs it only from a decide, or from a node that runs no model', () => {
  assert.throws(() => pickNodeOf(flow([{ node: 'agent', label: 'read', out: 'Page', as: 'p' }, { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' }]), 'mcc'), /no node but a decide outputs it, so it has no pick step/);
  assert.throws(() => pickNodeOf(flow([{ node: 'call', label: 'lookup', via: 'tool', tool: 'mcc_codes', out: 'Mcc', as: 'mcc' }, { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' }]), 'mcc'), /pick step "lookup" is a call node, which runs no model/);
});

test('the pick node\'s one added sentence names no code, no pair and no learned text', () => {
  assert.doesNotMatch(PICK_NODE_INSTRUCTIONS, /\d/);
  assert.doesNotMatch(PICK_NODE_INSTRUCTIONS, /learned|lesson|<learned>/i);
});

// ---------------------------------------------------------------- the host: only the pick node changes

const mcc = scriptedParts({ set: SETS.mcc });
const truth = readJson(join(FIXTURES_MCC, 'answers.json'));
const lumen = mcc.companies.find((c) => c.name === 'Lumen Candle Works');
const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };
// merchant-mcc-risk with a decide after its picking extract that copies the answer through: two model nodes, one the pick.
const WITH_DECIDE = {
  ...CLASSIFY_MERCHANT,
  output: { schemaId: 'Answer', path: 'final' },
  root: { ...CLASSIFY_MERCHANT.root, steps: [...CLASSIFY_MERCHANT.root.steps, { node: 'decide', label: 'assemble', tools: [], out: 'Answer', as: 'final', instructions: 'Copy the answer.', state: { merchant: '{name}', url: '{page.url}', answer: '{answer}' } }] },
};
const sysOf = (context) => context.messages.find((m) => m.role === 'system');
const systemOf = (context) => sysOf(context)?.sections?.instructions ?? '';
const userOf = (context) => context.messages.find((m) => m.role === 'user')?.content;
const toolsOf = (r) => [...r.offered].sort();

async function served(t, pickNode) {
  const root = await mkdtemp(join(tmpdir(), 'lc-pick-node-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.mcc.input(lumen);
  const run = await prepareRun({ home, repo, host: 'test', runId: `run-pick-${pickNode ? 'on' : 'off'}`, input });
  const dispatch = { name: MCC_WORKFLOW, sha256: 'f'.repeat(64), workflow: WITH_DECIDE, input };
  const { node } = agentScriptMcc({ job: lumen, offered: [], fixtures: { truth } });
  const model = scriptedModel({ root: [{ say: 'Done.' }], node, models: twoModels });
  const measure = await runJob({ run, job: lumen, model, judge: meteredJudge(mcc.judge()), effects: [...(await mcc.toolsFor(lumen, run)), ...SETS.mcc.labelTools(mcc.data)], answer: SETS.mcc.answer(mcc.data), text: SETS.mcc.text, dispatch, ...(pickNode ? { pickNode } : {}) });
  return { measure, model };
}

test('host: with --pick-node agent the pick node alone runs on the root\'s model and thinking with its tools plus the read tools; off, every node is as before', async (t) => {
  const off = await served(t, null);
  const on = await served(t, { key: 'mcc' });
  assert.equal(off.measure.dispatch.outcome, 'complete');
  assert.equal(on.measure.dispatch.outcome, 'complete');
  assert.deepEqual(on.measure.dispatch.pickNode, ['write the answer']);
  assert.equal('pickNode' in off.measure.dispatch, false);
  // Each run's node requests in order: the pick (write the answer), then the decide (assemble).
  const firstOf = (m) => m.nodeRequests.filter((r) => r.context.messages.filter((x) => x.role === 'toolResult').length === 0);
  const [offPick, offDecide] = firstOf(off.model);
  const [onPick, onDecide] = firstOf(on.model);
  const seenOf = (m) => m.seen.filter((x) => x.who === 'node');
  // Off: every node on the host's node model and level, the host's node instructions, the node's own tools.
  assert.ok(seenOf(off.model).every((x) => x.model === 'gpt-6-luna'), JSON.stringify(seenOf(off.model)));
  assert.ok(!systemOf(offPick.context).includes(PICK_NODE_INSTRUCTIONS));
  assert.deepEqual(toolsOf(offPick), ['submit']);
  // On: the pick node on the root's model at its thinking, its tools plus fetch_page, its system the same plus one sentence.
  assert.deepEqual([seenOf(on.model)[0].model, seenOf(on.model)[0].thinking], ['claude-opus-5-5', 'high']);
  assert.deepEqual([seenOf(off.model)[0].model, seenOf(off.model)[0].thinking], ['gpt-6-luna', 'medium']);
  assert.ok(toolsOf(onPick).includes('fetch_page'), toolsOf(onPick).join(','));
  assert.deepEqual(toolsOf(onPick).filter((n) => n !== 'fetch_page' && n !== 'read_document'), toolsOf(offPick));
  assert.ok(systemOf(onPick.context).includes(PICK_NODE_INSTRUCTIONS));
  assert.equal(systemOf(onPick.context).replace(`\n\n${PICK_NODE_INSTRUCTIONS}`, ''), systemOf(offPick.context));
  const { instructions: _on, ...restOn } = sysOf(onPick.context).sections;
  const { instructions: _off, ...restOff } = sysOf(offPick.context).sections;
  assert.deepEqual(restOn, restOff, 'its task and every other section as before');
  assert.deepEqual(userOf(onPick.context), userOf(offPick.context), 'the same state: nothing is fed');
  // The decide that copies the code is byte-identical on and off: its system, its user turn and its tools.
  assert.deepEqual([sysOf(onDecide.context).content, sysOf(onDecide.context).sections], [sysOf(offDecide.context).content, sysOf(offDecide.context).sections]);
  assert.deepEqual(userOf(onDecide.context), userOf(offDecide.context));
  assert.deepEqual(toolsOf(onDecide), toolsOf(offDecide));
  assert.equal(seenOf(on.model).at(-1).model, 'gpt-6-luna');
  assert.equal(on.measure.answer.mcc, off.measure.answer.mcc);
});

test('host: a whole-job workflow with no pick step refuses the run under the flag', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lc-pick-node-refuse-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.mcc.input(lumen);
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-pick-refused', input });
  const onlyDecide = { ...CLASSIFY_MERCHANT, root: { ...CLASSIFY_MERCHANT.root, steps: CLASSIFY_MERCHANT.root.steps.map((s) => (s.node === 'extract' ? { ...s, node: 'decide' } : s)) } };
  const model = scriptedModel({ root: [{ say: 'Done.' }], models: twoModels });
  await assert.rejects(runJob({ run, job: lumen, model, judge: meteredJudge(mcc.judge()), effects: [...(await mcc.toolsFor(lumen, run)), ...SETS.mcc.labelTools(mcc.data)], answer: SETS.mcc.answer(mcc.data), text: SETS.mcc.text, dispatch: { name: MCC_WORKFLOW, sha256: 'f'.repeat(64), workflow: onlyDecide, input }, pickNode: { key: 'mcc' } }), /no node but a decide outputs it/);
});
