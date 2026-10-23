// ARM H2's tier node at $0 (research/PREREG-MCC-H2-tier.md): the step that sets the answer's tier, found by structure (the
// first node, of any kind, whose output carries the tier field), runs on the root's model and thinking with its own tools
// and the run's read tools; every other node, the converted pick included, runs as under ARM H, and with the flag off
// nothing changes.
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
import { answerOfMcc, CLASSIFY_MERCHANT, FIXTURES_MCC, MCC_WORKFLOW } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';
import { TIER_NODE_INSTRUCTIONS, tierNodeOf } from './tier-node.mjs';

const S = { Answer: { type: 'object', properties: { mcc: { type: 'string' }, riskTier: { type: 'string' } } }, Mcc: { type: 'object', properties: { mcc: { type: 'string' } } }, Page: { type: 'object', properties: { text: { type: 'string' } } } };
const flow = (steps, schemas = S) => ({ v: 2, name: 'w', schemas, input: { schemaId: 'Page' }, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'chain', steps } });

test('on merchant-mcc-risk b46d0494 the tier step is assemble, a decide node; its pick step is still choose-mcc', () => {
  const b46 = readJson(join(FIXTURES_MCC, 'b46d0494-skeleton.json'));
  assert.deepEqual(tierNodeOf(b46, SETS.mcc.tierKey), { label: 'assemble', kind: 'decide' });
  assert.equal(pickNodeOf(b46, SETS.mcc.answerKey), 'choose-mcc');
});

test('the tier step is the first node of any kind whose output carries the tier field, nested ones included', () => {
  assert.deepEqual(tierNodeOf(flow([
    { node: 'agent', label: 'choose', out: 'Mcc', as: 'mcc' },
    { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' },
    { node: 'extract', label: 'again', out: 'Answer', as: 'again' },
  ]), 'riskTier'), { label: 'assemble', kind: 'decide' });
  assert.deepEqual(tierNodeOf(flow([
    { node: 'route', label: 'r', branches: { a: { body: { node: 'extract', label: 'draft', out: 'Answer', as: 'answer' } } } },
    { node: 'decide', label: 'assemble', out: 'Answer', as: 'answer' },
  ]), 'riskTier'), { label: 'draft', kind: 'extract' });
  // A workflow whose output has no tier field is no whole-job workflow: nothing to convert.
  assert.equal(tierNodeOf({ ...flow([{ node: 'agent', label: 'x', out: 'Mcc', as: 'x' }]), output: { schemaId: 'Mcc', path: 'x' } }, 'riskTier'), null);
});

test('refused: a workflow that answers with the tier and no node outputs it, or the node that does runs no model', () => {
  const noTierNode = { ...flow([{ node: 'agent', label: 'choose', out: 'Mcc', as: 'answer' }]) };
  assert.throws(() => tierNodeOf(noTierNode, 'riskTier'), /answers with riskTier, and no node outputs it, so it has no tier step/);
  assert.throws(() => tierNodeOf(flow([{ node: 'call', label: 'lookup', via: 'tool', tool: 'x', out: 'Answer', as: 'answer' }]), 'riskTier'), /tier step "lookup" is a call node, which runs no model/);
  assert.throws(() => tierNodeOf(flow([{ node: 'judge', label: 'rate', out: 'Answer', as: 'answer' }]), 'riskTier'), /tier step "rate" is a judge node, which runs no model/);
});

test('the tier node\'s one added sentence has no digit, no learned text, and says nothing of risk or codes', () => {
  assert.doesNotMatch(TIER_NODE_INSTRUCTIONS, /\d/);
  assert.doesNotMatch(TIER_NODE_INSTRUCTIONS, /learned|lesson|<learned>/i);
  assert.doesNotMatch(TIER_NODE_INSTRUCTIONS, /risk|tier|code|mcc|flag|rubric|categor/i);
  assert.equal(TIER_NODE_INSTRUCTIONS.split(/[.;](\s|$)/).filter((s) => s.trim()).length, 1, 'one sentence');
});

// ---------------------------------------------------------------- the host: only the tier node changes beside ARM H's pick

const mcc = scriptedParts({ set: SETS.mcc });
const truth = readJson(join(FIXTURES_MCC, 'answers.json'));
const lumen = mcc.companies.find((c) => c.name === 'Lumen Candle Works');
const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };
// merchant-mcc-risk in b46d0494's shape: an extract picks the code alone, a decide with no tools assembles the answer
// (code and tier) from the state.
const SPLIT = {
  ...CLASSIFY_MERCHANT,
  schemas: { ...CLASSIFY_MERCHANT.schemas, Code: { type: 'object', additionalProperties: false, required: ['mcc', 'mccDescription'], properties: { mcc: { type: 'string' }, mccDescription: { type: 'string' } } } },
  root: {
    ...CLASSIFY_MERCHANT.root,
    steps: [
      ...CLASSIFY_MERCHANT.root.steps.slice(0, 3),
      { node: 'extract', label: 'choose the code', tools: [], out: 'Code', as: 'code', instructions: 'The code from what the page says the merchant sells, and its title.', state: { merchant: '{name}', url: '{page.url}', text: '{page.text}' } },
      { node: 'decide', label: 'assemble', tools: [], out: 'Answer', as: 'answer', instructions: 'Assemble the answer from the state: the code as chosen, the tier by the rubric, the flags and the evidence.', state: { merchant: '{name}', url: '{page.url}', text: '{page.text}', code: '{code}' } },
    ],
  },
};
// The scripted nodes: the pick delivers the code and its title, the assemble the whole answer.
const nodeScript = (state) => {
  const full = answerOfMcc(truth[state.merchant], state.url);
  return { submit: state.code ? full : { mcc: full.mcc, mccDescription: full.mccDescription } };
};
const sysOf = (context) => context.messages.find((m) => m.role === 'system');
const systemOf = (context) => sysOf(context)?.sections?.instructions ?? '';
const userOf = (context) => context.messages.find((m) => m.role === 'user')?.content;
const toolsOf = (r) => [...r.offered].sort();

async function served(t, flags, workflow = SPLIT) {
  const root = await mkdtemp(join(tmpdir(), 'lc-tier-node-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.mcc.input(lumen);
  const run = await prepareRun({ home, repo, host: 'test', runId: `run-tier-${Object.keys(flags).join('-') || 'off'}`, input });
  const dispatch = { name: MCC_WORKFLOW, sha256: 'f'.repeat(64), workflow, input };
  const model = scriptedModel({ root: [{ say: 'Done.' }], node: nodeScript, models: twoModels });
  const measure = await runJob({ run, job: lumen, model, judge: meteredJudge(mcc.judge()), effects: [...(await mcc.toolsFor(lumen, run)), ...SETS.mcc.labelTools(mcc.data)], answer: SETS.mcc.answer(mcc.data), text: SETS.mcc.text, dispatch, ...flags });
  // Each node's first request, in workflow order (the pick, then the assemble), and the model and level each went out on.
  const first = model.nodeRequests.filter((r) => r.context.messages.filter((x) => x.role === 'toolResult').length === 0);
  return { measure, model, first, seen: model.seen.filter((x) => x.who === 'node') };
}

test('host: with --tier-node agent the tier node alone runs on the root\'s model and thinking with its tools plus the read tools and one sentence; the pick runs as under ARM H', async (t) => {
  const h = await served(t, { pickNode: { key: 'mcc' } });
  const h2 = await served(t, { pickNode: { key: 'mcc' }, tierNode: { key: 'riskTier' } });
  assert.equal(h.measure.dispatch.outcome, 'complete');
  assert.equal(h2.measure.dispatch.outcome, 'complete');
  assert.deepEqual([h2.measure.dispatch.pickNode, h2.measure.dispatch.tierNode], [['choose the code'], ['assemble']]);
  assert.equal('tierNode' in h.measure.dispatch, false);
  const [hPick, hAssemble] = h.first;
  const [h2Pick, h2Assemble] = h2.first;
  // The pick: byte-identical to ARM H's (its model and level, its system, its user turn, its tools).
  assert.deepEqual([h2.seen[0].model, h2.seen[0].thinking], [h.seen[0].model, h.seen[0].thinking]);
  assert.deepEqual([h2.seen[0].model, h2.seen[0].thinking], ['claude-opus-5-5', 'high']);
  assert.ok(systemOf(h2Pick.context).includes(PICK_NODE_INSTRUCTIONS));
  assert.deepEqual([sysOf(h2Pick.context).content, sysOf(h2Pick.context).sections], [sysOf(hPick.context).content, sysOf(hPick.context).sections]);
  assert.deepEqual(userOf(h2Pick.context), userOf(hPick.context));
  assert.deepEqual(toolsOf(h2Pick), toolsOf(hPick));
  // The assemble: under ARM H on the node model, its own tools only; under H2 on the root's model and level, the read tools
  // added, its system the same plus one sentence, its task, state and every other section unchanged.
  assert.deepEqual([h.seen.at(-1).model, h.seen.at(-1).thinking], ['gpt-6-luna', 'medium']);
  assert.deepEqual([h2.seen.at(-1).model, h2.seen.at(-1).thinking], ['claude-opus-5-5', 'high']);
  assert.deepEqual(toolsOf(hAssemble), ['submit']);
  assert.deepEqual(toolsOf(h2Assemble), ['fetch_page', 'read_document', 'submit'], 'the run\'s read tools beside its own (none)');
  assert.ok(!systemOf(hAssemble.context).includes(TIER_NODE_INSTRUCTIONS));
  assert.equal(systemOf(h2Assemble.context).replace(`\n\n${TIER_NODE_INSTRUCTIONS}`, ''), systemOf(hAssemble.context));
  const { instructions: _on, ...restOn } = sysOf(h2Assemble.context).sections;
  const { instructions: _off, ...restOff } = sysOf(hAssemble.context).sections;
  assert.deepEqual(restOn, restOff, 'its task and every other section as before');
  assert.deepEqual(userOf(h2Assemble.context), userOf(hAssemble.context), 'the same state: nothing is fed');
  assert.deepEqual(h2.measure.answer, h.measure.answer);
});

test('host: with both flags off every node runs as it did before either flag existed', async (t) => {
  const off = await served(t, {});
  const tierOff = await served(t, { tierNode: null, pickNode: null });
  assert.ok(off.seen.every((x) => x.model === 'gpt-6-luna' && x.thinking === 'medium'));
  assert.equal('tierNode' in off.measure.dispatch || 'pickNode' in off.measure.dispatch, false);
  for (const [a, b] of off.first.map((r, i) => [r, tierOff.first[i]])) {
    assert.deepEqual([sysOf(a.context).content, sysOf(a.context).sections, userOf(a.context), toolsOf(a)], [sysOf(b.context).content, sysOf(b.context).sections, userOf(b.context), toolsOf(b)]);
    assert.ok(!systemOf(a.context).includes(TIER_NODE_INSTRUCTIONS) && !systemOf(a.context).includes(PICK_NODE_INSTRUCTIONS));
  }
});

test('host: refused under the flag, a workflow whose tier comes from no node, and one whose tier step is also its pick', async (t) => {
  const noTier = { ...SPLIT, root: { ...SPLIT.root, steps: [...SPLIT.root.steps.slice(0, 4), { node: 'call', label: 'assemble', via: 'tool', tool: 'mcc_codes', args: {}, out: 'Answer', as: 'answer' }] } };
  await assert.rejects(served(t, { tierNode: { key: 'riskTier' } }, noTier), /tier step "assemble" is a call node, which runs no model/);
  // CLASSIFY_MERCHANT's one extract outputs the code and the tier: the pick and the tier step are one node.
  await assert.rejects(served(t, { pickNode: { key: 'mcc' }, tierNode: { key: 'riskTier' } }, CLASSIFY_MERCHANT), /the pick step and the tier step are one node \("write the answer"\)/);
});
