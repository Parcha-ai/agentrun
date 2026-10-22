// ARM H's pick node on the MCC job at $0: merchant-mcc-risk's agent picking step alone runs on the root's model and thinking
// with its tools plus the read tools; the decide after it that copies the code through runs exactly as before.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHomeFor, meteredJudge, prepareRun, runJob } from './host.mjs';
import { PRICES } from './models.mjs';
import { PICK_NODE_INSTRUCTIONS } from './pick-node.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { readJson, scriptedModel } from './scripted.mjs';
import { agentScriptMcc, answerOfMcc, CLASSIFY_MERCHANT, FIXTURES_MCC, MCC_WORKFLOW } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';

// ---------------------------------------------------------------- the host: only the pick node changes

const mcc = scriptedParts({ set: SETS.mcc });
const truth = readJson(join(FIXTURES_MCC, 'answers.json'));
const lumen = mcc.companies.find((c) => c.name === 'Lumen Candle Works');
const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };
// merchant-mcc-risk with its pick an agent node (as b46d0494's choose-mcc is; an extract pick is served as written) and a
// decide after it that copies the answer through: two model nodes, one the pick.
const WITH_DECIDE = {
  ...CLASSIFY_MERCHANT,
  output: { schemaId: 'Answer', path: 'final' },
  root: { ...CLASSIFY_MERCHANT.root, steps: [...CLASSIFY_MERCHANT.root.steps.map((s) => (s.node === 'extract' ? { ...s, node: 'agent' } : s)), { node: 'decide', label: 'assemble', tools: [], out: 'Answer', as: 'final', instructions: 'Copy the answer.', state: { merchant: '{name}', url: '{page.url}', answer: '{answer}' } }] },
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

test('host, B1: a merchant-mcc-risk revision with no pick step is refused for the run, which goes by hand without throwing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lc-pick-node-refuse-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.mcc.input(lumen);
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-pick-refused', input });
  const onlyDecide = { ...CLASSIFY_MERCHANT, root: { ...CLASSIFY_MERCHANT.root, steps: CLASSIFY_MERCHANT.root.steps.map((s) => (s.node === 'extract' ? { ...s, node: 'decide' } : s)) } };
  const { node } = agentScriptMcc({ job: lumen, offered: [], fixtures: { truth } });
  const byHand = answerOfMcc(truth[lumen.name], lumen.website);
  const model = scriptedModel({ root: [{ call: 'answer', args: byHand }, { say: 'Done.' }], node, models: twoModels });
  const measure = await runJob({ run, job: lumen, model, judge: meteredJudge(mcc.judge()), effects: [...(await mcc.toolsFor(lumen, run)), ...SETS.mcc.labelTools(mcc.data)], answer: SETS.mcc.answer(mcc.data), text: SETS.mcc.text, dispatch: { name: MCC_WORKFLOW, sha256: 'f'.repeat(64), workflow: onlyDecide, input }, pickNode: { key: 'mcc' } });
  assert.deepEqual([measure.dispatch.outcome, measure.pickNode.refused.map((r) => r.revision)], ['refused', ['f'.repeat(64)]]);
  assert.equal(model.nodeRequests.length, 0, 'the refused revision never ran');
  assert.equal(measure.answer.mcc, byHand.mcc, 'the root agent answered by hand');
});
