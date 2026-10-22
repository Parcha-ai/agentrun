// ARM H's pick node at $0 (research/PREREG-armH-agent-pick.md, Clarification 1; PREREG-H-stream.md B1-B3): the step that
// picks the code, found by structure (the first non-decide node whose output carries the code field), runs on the root's
// model and thinking with its own tools and the run's read tools when it is an agent; an extract or call that produces the
// code is served as written; a revision with no pick step is refused for the run, which goes on without it. Every other
// node, and every node with the flag off, runs as before.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHomeFor, meteredJudge, prepareRun, runJob } from './host.mjs';
import { PRICES } from './models.mjs';
import { PICK_NODE_INSTRUCTIONS, pickStepOf } from './pick-node.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { agentScriptV4, answerOfV4, CLASSIFY_WORKFLOW_V4, FIXTURES_V4, readJson, scriptedModel, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

const S = { Answer: { type: 'object', properties: { mcc: { type: 'string' }, riskTier: { type: 'string' } } }, Mcc: { type: 'object', properties: { mcc: { type: 'string' }, quote: { type: 'string' } } }, Page: { type: 'object', properties: { text: { type: 'string' } } } };
const flow = (steps, schemas = S) => ({ v: 2, name: 'w', schemas, input: { schemaId: 'Page' }, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'chain', steps } });

const label = (w, key) => pickStepOf(w, key)?.label;

test('the pick step is the first non-decide node whose output carries the code field: a decide that carries it is skipped, wherever it stands', () => {
  // merchant-mcc-risk b46d0494's shape: an agent picks the code, a decide assembles the answer and copies it.
  assert.deepEqual(pickStepOf(flow([
    { node: 'call', label: 'read-home', out: 'Page', as: 'home' },
    { node: 'agent', label: 'survey', out: 'Page', as: 'survey' },
    { node: 'agent', label: 'choose-mcc', out: 'Mcc', as: 'mcc' },
    { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' },
  ]), 'mcc'), { label: 'choose-mcc', kind: 'agent', convert: true });
  // A decide BEFORE the picking agent is skipped too; so is one nested in a route.
  assert.equal(label(flow([
    { node: 'route', label: 'r', branches: [{ when: {}, then: { node: 'decide', label: 'draft', out: 'Answer', as: 'answer' } }] },
    { node: 'agent', label: 'choose', out: 'Mcc', as: 'mcc' },
  ]), 'mcc'), 'choose');
  // A workflow whose output has no code field is no whole-job workflow: nothing to pick.
  assert.equal(pickStepOf({ ...flow([{ node: 'agent', label: 'x', out: 'Mcc', as: 'x' }]), output: { schemaId: 'Page', path: 'x' } }, 'mcc'), null);
});

test('B2: only an agent pick step is converted; a call or an extract that produces the code (a record copied) is served as written', () => {
  const sec = { Answer: { type: 'object', properties: { sic4: { type: 'string' } } }, Record: { type: 'object', properties: { sic4: { type: 'string' }, title: { type: 'string' } } } };
  // A discovered lookup: a call reads the SEC record, an extract copies its SIC field into the answer.
  assert.deepEqual(pickStepOf(flow([{ node: 'call', label: 'read the record', via: 'tool', tool: 'fetch_page', out: 'Record', as: 'record' }, { node: 'extract', label: 'copy the code', out: 'Answer', as: 'answer' }], sec), 'sic4'), { label: 'read the record', kind: 'call', convert: false });
  assert.deepEqual(pickStepOf(flow([{ node: 'extract', label: 'copy the code', out: 'Answer', as: 'answer' }], sec), 'sic4'), { label: 'copy the code', kind: 'extract', convert: false });
});

// The two served revisions H@cp200 and H-MCC ran, by structure (their node kinds, labels and output schemas' code fields).
const C_167836927e37 = { v: 2, name: 'classify-company', output: { schemaId: 'Answer', path: 'answer' },
  schemas: { Company: { type: 'object', properties: { name: {} } }, Report: { type: 'object', properties: { url: {} } }, Segs: { type: 'object', properties: { segments: {}, largestLine: {} } }, Sic: { type: 'object', properties: { sic4: {}, quote: {} } }, Answer: { type: 'object', properties: { sic4: {}, segments: {}, hq: {} } } },
  root: { node: 'chain', steps: [{ node: 'call', label: 'find-report', out: 'Report', as: 'report' }, { node: 'agent', label: 'segments', out: 'Segs', as: 'segs' }, { node: 'agent', label: 'choose-sic', tools: ['sic2_groups', 'sic_codes'], out: 'Sic', as: 'sic' }, { node: 'extract', label: 'assemble', out: 'Answer', as: 'answer' }] } };
const B46D0494 = { v: 2, name: 'merchant-mcc-risk', output: { schemaId: 'Answer', path: 'answer' },
  schemas: { Page: { type: 'object', properties: { text: {} } }, Mcc: { type: 'object', properties: { mainLine: {}, mcc: {}, mccDescription: {} } }, Answer: { type: 'object', properties: { mcc: {}, riskTier: {} } } },
  root: { node: 'chain', steps: [{ node: 'call', label: 'read-home', out: 'Page', as: 'home' }, { node: 'agent', label: 'survey-site', out: 'Page', as: 'survey' }, { node: 'agent', label: 'choose-mcc', tools: ['mcc_groups', 'mcc_codes'], out: 'Mcc', as: 'mcc' }, { node: 'judge', label: 'rubric', as: 'rubric' }, { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' }] } };

test('B3: C\'s classify-company 167836927e37 and merchant-mcc-risk b46d0494 still convert their agent pick, so H@cp200 and H-MCC are unchanged', () => {
  assert.deepEqual(pickStepOf(C_167836927e37, 'sic4'), { label: 'choose-sic', kind: 'agent', convert: true });
  assert.deepEqual(pickStepOf(B46D0494, 'mcc'), { label: 'choose-mcc', kind: 'agent', convert: true });
});

test('B1: a workflow that answers with the code but outputs it only from a decide has no pick step, and is refused, not thrown', () => {
  const step = pickStepOf(flow([{ node: 'agent', label: 'read', out: 'Page', as: 'p' }, { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' }]), 'mcc');
  assert.match(step.refused, /no node but a decide outputs it, so it has no pick step/);
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

/** CLASSIFY_WORKFLOW_V4 with its pick step (an extract) made an agent node, as a learned workflow's pick usually is. */
const PICK4 = pickStepOf(CLASSIFY_WORKFLOW_V4, 'sic4').label;
const recastPick = (to) => (node) => (Array.isArray(node) ? node.map(recastPick(to)) : node && typeof node === 'object'
  ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === 'node' && node.label === PICK4 ? to : recastPick(to)(v)])) : node);
const AGENT_PICK_V4 = { ...CLASSIFY_WORKFLOW_V4, root: recastPick('agent')(CLASSIFY_WORKFLOW_V4.root) };

async function served4(t, pickNode, workflow = AGENT_PICK_V4, { root: rootScript = [{ say: 'Done.' }], home: given } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lc-pick-node-v4-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const home = given ?? await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.v4.input(harbor);
  const run = await prepareRun({ home, repo, host: 'test', runId: `run-pick4-${pickNode ? 'on' : 'off'}-${Math.random().toString(36).slice(2, 8)}`, input });
  const { node } = agentScriptV4({ job: harbor, offered: [], fixtures: { truth: truth4 } });
  const model = scriptedModel({ root: rootScript, node, models: twoModels });
  const measure = await runJob({ run, job: harbor, model, judge: meteredJudge(v4.judge()), effects: [...(await v4.toolsFor(harbor, run)), ...SETS.v4.labelTools(v4.data)], answer: SETS.v4.answer(v4.data), text: SETS.v4.text, dispatch: { name: WORKFLOW, sha256: 'f'.repeat(64), workflow, input }, ...(pickNode ? { pickNode } : {}) });
  return { measure, model };
}

test('host (v4): an agent pick node alone runs on the root\'s model and thinking, with its tools plus the read tools and one added sentence; every other node is byte-identical on and off', async (t) => {
  const pick = PICK4;
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
      assert.ok(onTurn.offered.includes('fetch_page') && onTurn.offered.includes('read_document'), onTurn.offered.join(','));
      assert.deepEqual(onTurn.offered.filter((n) => !['fetch_page', 'read_document'].includes(n)).sort(), offTurn.offered.filter((n) => !['fetch_page', 'read_document'].includes(n)).sort());
    } else {
      assert.equal(onText, offText);
      assert.deepEqual([...onTurn.offered].sort(), [...offTurn.offered].sort());
    }
  });
  assert.ok(nodeSeen(off.model).every((x) => x.model === 'gpt-6-luna' && x.thinking === 'medium'));
  const moved = nodeSeen(on.model).filter((x) => x.model !== 'gpt-6-luna');
  assert.ok(moved.length >= 1 && moved.every((x) => x.model === 'claude-opus-5-5' && x.thinking === 'high'), JSON.stringify(nodeSeen(on.model)));
  assert.equal(on.measure.answer.sic4, off.measure.answer.sic4);
});

test('host (v4), B2: an extract pick step (a copy) is served as written: on and off, every node request is byte-identical and on the node model', async (t) => {
  const off = await served4(t, null, CLASSIFY_WORKFLOW_V4);
  const on = await served4(t, { key: 'sic4' }, CLASSIFY_WORKFLOW_V4);
  assert.deepEqual([off.measure.dispatch.outcome, on.measure.dispatch.outcome], ['complete', 'complete']);
  assert.equal('pickNode' in on.measure.dispatch, false, 'no node converted');
  assert.deepEqual(on.measure.pickNode, { asWritten: [{ name: WORKFLOW, revision: 'f'.repeat(64), label: PICK4, kind: 'extract' }] });
  const offTurns = firstTurns(off.model);
  const onTurns = firstTurns(on.model);
  assert.deepEqual(onTurns.map((r) => [userOf(r.context), sysOf(r.context).sections, [...r.offered].sort()]), offTurns.map((r) => [userOf(r.context), sysOf(r.context).sections, [...r.offered].sort()]));
  assert.ok(nodeSeen(on.model).every((x) => x.model === 'gpt-6-luna' && x.thinking === 'medium'));
});

test('host (v4), B1: a revision with no pick step is refused for its run, which goes by hand without throwing; a later run dispatches another revision', async (t) => {
  const onlyDecide = { ...CLASSIFY_WORKFLOW_V4, root: recastPick('decide')(CLASSIFY_WORKFLOW_V4.root) };
  const byHand = [{ call: 'answer', args: answerOfV4(truth4[harbor.name]) }, { say: 'Done.' }];
  const first = await served4(t, { key: 'sic4' }, onlyDecide, { root: byHand });
  assert.equal(first.measure.dispatch.outcome, 'refused');
  assert.match(first.measure.dispatch.detail, /no pick step/);
  assert.deepEqual(first.measure.pickNode.refused.map((r) => [r.name, r.revision]), [[WORKFLOW, 'f'.repeat(64)]]);
  assert.equal(first.model.nodeRequests.length, 0, 'the refused revision never ran');
  assert.ok(first.model.requests.length >= 1, 'the root agent did the job');
  assert.equal(first.measure.answer.sic4, truth4[harbor.name].sic4);
  const later = await served4(t, { key: 'sic4' }, AGENT_PICK_V4);
  assert.equal(later.measure.dispatch.outcome, 'complete');
  assert.deepEqual(later.measure.dispatch.pickNode, [PICK4]);
});
