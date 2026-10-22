// ARM F's pick gate on the MCC job (research/PREREG-armF-gated.md, "MCC"): the same gate code, its grouping the scorer's
// ISO 18245 group table (learn-mcc's, passed in as the set's data, never codes named by hand); the pick's state leaves out
// the code, its title and its MCC evidence; no MCC answer is exempt.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHomeFor, meteredJudge, prepareRun, runJob } from './host.mjs';
import { PRICES } from './models.mjs';
import { gatePick, strippedOutput } from './pick-gate.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { readJson, scriptedModel } from './scripted.mjs';
import { agentScriptMcc, answerOfMcc, CLASSIFY_MERCHANT, FIXTURES_MCC, MCC_WORKFLOW } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';
import { mccCodesTool } from './mcc.mjs';
import { groupOf, loadGroups } from '../learn-mcc/score-mcc.mjs';

const mcc = scriptedParts({ set: SETS.mcc });
const groups = SETS.mcc.pickGroups(mcc.data);
const truth = readJson(join(FIXTURES_MCC, 'answers.json'));
const lumen = mcc.companies.find((c) => c.name === 'Lumen Candle Works');
const ANSWER = answerOfMcc(truth[lumen.name], lumen.website);

test('MCC: the stripped output holds no code, no code title and no MCC evidence; the risk and its evidence stay', () => {
  const stripped = strippedOutput(ANSWER, groups);
  assert.equal('mcc' in stripped, false);
  assert.equal('mccDescription' in stripped, false);
  assert.deepEqual(stripped.evidence.map((e) => e.claim), ['risk']);
  assert.deepEqual([stripped.riskTier, stripped.siteStatus, stripped.confidence], [ANSWER.riskTier, ANSWER.siteStatus, ANSWER.confidence]);
  assert.ok(!JSON.stringify(stripped).includes(ANSWER.mcc) && !JSON.stringify(stripped).includes(ANSWER.mccDescription));
});

test('MCC: a code\'s group is the scorer\'s ISO 18245 group, from the data\'s table; its options are every code mcc_codes serves in that range', async () => {
  const table = loadGroups();
  const all = (await mccCodesTool(table).run({})).codes;
  for (const code of ['5999', '5812', '4511', '7011', '8099']) {
    const group = groups.groupOf(code);
    assert.equal(group, groupOf(code, table), code);
    const options = await groups.optionsOf(group);
    assert.deepEqual(options, all.filter((c) => groupOf(c.code, table) === group), `${code}: the range's served codes, as the tool gives them`);
    if (all.some((c) => c.code === code)) assert.ok(options.some((o) => o.code === code), `${code} is among its own options`);
  }
  assert.equal(groups.groupOf(5812), groups.groupOf('5812'), 'a numeric code reads as its four digits');
  assert.deepEqual(await groups.optionsOf('no-such-group'), []);
  assert.equal(groups.groupOf(undefined), null);
});

test('MCC: the second pick asks the MCC question over the served code\'s range, shown the stripped output; τ = 0 gates a disagreement', async () => {
  const options = await groups.optionsOf(groups.groupOf(ANSWER.mcc));
  const asked = [];
  const judgeOf = (favourite) => ({
    run: async (params) => {
      asked.push(params);
      const probabilities = Object.fromEntries(options.map((o) => [`c${o.code}`, o.code === favourite ? 0.7 : 0.3 / (options.length - 1)]));
      return { answers: { pick: { type: 'choice', choice: `c${favourite}`, probabilities } } };
    },
  });
  const kept = await gatePick({ ...groups, output: ANSWER, input: SETS.mcc.input(lumen), judge: judgeOf(ANSWER.mcc), tau: 0 });
  assert.equal(kept.gated, false);
  assert.equal(kept.record.options, options.length);
  const { questions, state } = asked[0];
  assert.match(questions.pick.instructions, /^Which of these Merchant Category Codes fits this merchant\?/);
  assert.deepEqual(Object.keys(questions.pick.criteria), options.map((o) => `c${o.code}`));
  assert.equal(questions.pick.criteria[`c${ANSWER.mcc}`], `${ANSWER.mcc} ${options.find((o) => o.code === ANSWER.mcc).name}`);
  assert.deepEqual(state.input, { name: lumen.name, website: lumen.website });
  assert.ok(!('mcc' in state.answer) && !('mccDescription' in state.answer) && !state.answer.evidence.some((e) => e.claim === 'mcc'));
  const sibling = options.find((o) => o.code !== ANSWER.mcc).code;
  const other = await gatePick({ ...groups, output: ANSWER, input: SETS.mcc.input(lumen), judge: judgeOf(sibling), tau: 0 });
  assert.deepEqual([other.gated, other.record.top], [true, sibling]);
});

// ---------------------------------------------------------------- the host: the MCC workflow's code gated or kept

const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };
const said = (context) => { const user = context.messages.find((m) => m.role === 'user'); return typeof user.content === 'string' ? user.content : user.content.map((c) => c.text ?? '').join(''); };

async function served(t, tau) {
  const root = await mkdtemp(join(tmpdir(), 'lc-mcc-gate-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.mcc.input(lumen);
  const run = await prepareRun({ home, repo, host: 'test', runId: `run-mcc-gate-${String(tau).replace('.', '')}`, input });
  const dispatch = { name: MCC_WORKFLOW, sha256: 'f'.repeat(64), workflow: CLASSIFY_MERCHANT, input };
  const { node } = agentScriptMcc({ job: lumen, offered: [], fixtures: { truth } });
  const model = scriptedModel({ root: [{ call: 'answer', args: ANSWER }, { say: 'Done.' }], node, models: twoModels });
  const pickGate = { ...groups, tau, receiptOf: () => false };
  // The scripted Jev, but the gate's pick, which puts 0.8 on the served code.
  const base = mcc.judge();
  const judge = async (params) => {
    if (params.label !== 'gate/pick') return base(params);
    const options = Object.keys(params.questions.pick.criteria);
    const probabilities = Object.fromEntries(options.map((o) => [o, o === `c${ANSWER.mcc}` ? 0.8 : 0.2 / (options.length - 1)]));
    return { answers: { pick: { type: 'choice', choice: `c${ANSWER.mcc}`, probabilities } } };
  };
  const measure = await runJob({ run, job: lumen, model, judge: meteredJudge(judge), effects: [...(await mcc.toolsFor(lumen, run)), ...SETS.mcc.labelTools(mcc.data)], answer: SETS.mcc.answer(mcc.data), text: SETS.mcc.text, dispatch, pickGate });
  return { measure, model };
}

test('host, MCC: τ above the pick\'s margin hands the code to the root agent, shown no code; τ = 0 keeps the agreed pick', async (t) => {
  const gated = await served(t, 0.95);
  assert.deepEqual([gated.measure.dispatch.outcome, gated.measure.dispatch.gated.gated, gated.measure.dispatch.gated.group], ['escalated', true, groupOf(ANSWER.mcc, mcc.data.table)]);
  const prompt = said(gated.model.requests[0]);
  assert.ok(prompt.includes('its mcc pick was not sure enough to stand alone'), prompt);
  assert.ok(!prompt.includes(`"mcc":`) && !prompt.includes(ANSWER.mccDescription), 'the agent is shown no code and no code title');
  assert.equal(gated.measure.answer.mcc, ANSWER.mcc, 'the agent answered');

  const kept = await served(t, 0);
  assert.deepEqual(kept.model.requests, [], 'the root agent is never asked');
  assert.deepEqual([kept.measure.dispatch.outcome, kept.measure.dispatch.gated.gated], ['complete', false]);
  assert.ok(kept.measure.dispatch.gated.m > 0, JSON.stringify(kept.measure.dispatch.gated));
  assert.equal(kept.measure.answer.mcc, ANSWER.mcc);
});
