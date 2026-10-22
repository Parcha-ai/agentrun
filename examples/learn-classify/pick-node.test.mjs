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
import { agentScriptV4, CLASSIFY_WORKFLOW_V4, FIXTURES_V4, readJson, scriptedModel, WORKFLOW } from './scripted.mjs';
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

// ---------------------------------------------------------------- the host (v4): only the pick node changes

const v4 = scriptedParts({ set: SETS.v4 });
const truth4 = readJson(join(FIXTURES_V4, 'answers.json'));
const harbor = v4.companies.find((c) => c.name === 'Harbor Valve Works Inc.');
const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };
const sysOf = (context) => context.messages.find((m) => m.role === 'system');
const userOf = (context) => context.messages.find((m) => m.role === 'user')?.content;
const firstTurns = (m) => m.nodeRequests.filter((r) => !r.context.messages.some((x) => x.role === 'toolResult'));
const nodeSeen = (m) => m.seen.filter((x) => x.who === 'node');

async function served4(t, pickNode, workflow = CLASSIFY_WORKFLOW_V4) {
  const root = await mkdtemp(join(tmpdir(), 'lc-pick-node-v4-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.v4.input(harbor);
  const run = await prepareRun({ home, repo, host: 'test', runId: `run-pick4-${pickNode ? 'on' : 'off'}`, input });
  const { node } = agentScriptV4({ job: harbor, offered: [], fixtures: { truth: truth4 } });
  const model = scriptedModel({ root: [{ say: 'Done.' }], node, models: twoModels });
  const measure = await runJob({ run, job: harbor, model, judge: meteredJudge(v4.judge()), effects: [...(await v4.toolsFor(harbor, run)), ...SETS.v4.labelTools(v4.data)], answer: SETS.v4.answer(v4.data), text: SETS.v4.text, dispatch: { name: WORKFLOW, sha256: 'f'.repeat(64), workflow, input }, ...(pickNode ? { pickNode } : {}) });
  return { measure, model };
}

test('host (v4): the pick node alone runs on the root\'s model and thinking, with its tools plus the read tools and one added sentence; every other node is byte-identical on and off', async (t) => {
  const pick = pickNodeOf(CLASSIFY_WORKFLOW_V4, 'sic4');
  const off = await served4(t, null);
  const on = await served4(t, { key: 'sic4' });
  assert.deepEqual([off.measure.dispatch.outcome, on.measure.dispatch.outcome], ['complete', 'complete']);
  assert.deepEqual(on.measure.dispatch.pickNode, [pick]);
  assert.equal('pickNode' in off.measure.dispatch, false);
  const offTurns = firstTurns(off.model);
  const onTurns = firstTurns(on.model);
  assert.equal(onTurns.length, offTurns.length);
  assert.ok(offTurns.length >= 2, 'the workflow has model nodes beside the pick');
  const isPick = (r) => userOf(r.context).includes(`the ${pick} record`);
  assert.equal(onTurns.filter(isPick).length, 1);
  onTurns.forEach((onTurn, i) => {
    const offTurn = offTurns[i];
    assert.equal(userOf(onTurn.context), userOf(offTurn.context), 'the same task and state: nothing is fed');
    const { instructions: onText, ...onRest } = sysOf(onTurn.context).sections;
    const { instructions: offText, ...offRest } = sysOf(offTurn.context).sections;
    assert.deepEqual(onRest, offRest);
    assert.ok(!offText.includes(PICK_NODE_INSTRUCTIONS), 'off: no node is told the sentence');
    if (isPick(onTurn)) {
      assert.equal(onText.replace(`\n\n${PICK_NODE_INSTRUCTIONS}`, ''), offText);
      assert.ok(onText.includes(PICK_NODE_INSTRUCTIONS));
      assert.ok(onTurn.offered.includes('fetch_page') && onTurn.offered.includes('read_document'), onTurn.offered.join(','));
      assert.deepEqual(onTurn.offered.filter((n) => !['fetch_page', 'read_document'].includes(n)).sort(), offTurn.offered.filter((n) => !['fetch_page', 'read_document'].includes(n)).sort());
    } else {
      assert.equal(onText, offText);
      assert.deepEqual([...onTurn.offered].sort(), [...offTurn.offered].sort());
    }
  });
  // Off, every node request on the host's node model and level; on, only the pick's request moves to the root's.
  assert.ok(nodeSeen(off.model).every((x) => x.model === 'gpt-6-luna' && x.thinking === 'medium'));
  const moved = nodeSeen(on.model).filter((x) => x.model !== 'gpt-6-luna');
  assert.ok(moved.length >= 1 && moved.every((x) => x.model === 'claude-opus-5-5' && x.thinking === 'high'), JSON.stringify(nodeSeen(on.model)));
  assert.equal(on.measure.answer.sic4, off.measure.answer.sic4);
});

test('host (v4): a whole-job workflow with no pick step refuses the run under the flag', async (t) => {
  const pick = pickNodeOf(CLASSIFY_WORKFLOW_V4, 'sic4');
  const recast = (node) => (Array.isArray(node) ? node.map(recast) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, recast(v)]).map(([k, v]) => [k, k === 'node' && node.label === pick ? 'decide' : v])) : node);
  await assert.rejects(served4(t, { key: 'sic4' }, { ...CLASSIFY_WORKFLOW_V4, root: recast(CLASSIFY_WORKFLOW_V4.root) }), /no node but a decide outputs it|run no model|runs no model/);
});
