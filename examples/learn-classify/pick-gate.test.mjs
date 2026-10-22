// ARM F's gate at $0 (research/PREREG-armF-gated.md): one Jev pick over the served code's group, independent of the
// workflow's code step; under τ the field goes back to the agent through the host's escalation hand-off, with no code shown.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOST_WORKFLOW, handoffText, hostRecord } from './dispatch.mjs';
import { agentHomeFor, meteredJudge, prepareRun, runJob } from './host.mjs';
import { PRICES } from './models.mjs';
import { gatePick, marginOf, strippedOutput } from './pick-gate.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { agentScriptV4, answerOfV4, CLASSIFY_WORKFLOW_V4, FIXTURES_V4, readJson, scriptedModel, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

const OUTPUT = {
  sic4: '2836',
  segments: [{ name: 'Biologics', share: 1 }],
  hq: { city: 'Basel', country: 'Switzerland' },
  cites: [
    { claim: 'sic', url: 'https://example.com/10-k', locator: 'p. 3', quote: 'SIC 2836 biological products' },
    { claim: 'hq', url: 'https://example.com/10-k', locator: 'cover', quote: 'Basel, Switzerland' },
  ],
};
const CODES = [{ code: '2833', name: 'MEDICINAL CHEMICALS' }, { code: '2834', name: 'PHARMACEUTICAL PREPARATIONS' }, { code: '2836', name: 'BIOLOGICAL PRODUCTS' }];
const SIC = { key: 'sic4', claim: 'sic', groupOf: (code) => code.slice(0, 2), optionsOf: async (group) => CODES.filter((c) => c.code.startsWith(group)) };

/** A judge that answers the gate's pick with `probabilities` (by code) and records what it was asked. */
function pickJudge(probabilities) {
  const asked = [];
  const run = async (params) => {
    asked.push(params);
    const p = Object.fromEntries(Object.entries(probabilities).map(([code, v]) => [`c${code}`, v]));
    const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
    return { answers: { pick: { type: 'choice', choice, probabilities: p, confidence: p[choice] } } };
  };
  return { run, asked };
}

test('the stripped output holds no code field and no cite of the code\'s claim; the rest is as the workflow gave it', () => {
  const stripped = strippedOutput(OUTPUT, SIC);
  assert.equal('sic4' in stripped, false);
  assert.deepEqual(stripped.cites.map((c) => c.claim), ['hq']);
  assert.deepEqual([stripped.segments, stripped.hq], [OUTPUT.segments, OUTPUT.hq]);
  assert.ok(!JSON.stringify(stripped).includes('2836'));
  assert.equal(marginOf({ c1: 0.6, c2: 0.3, c3: 0.1 }, 'c2'), -0.3);
  assert.equal(marginOf({ c1: 0.6, c2: 0.3 }, 'c1'), 0.3);
  assert.equal(marginOf(undefined, 'c1'), null);
});

test('the second pick sees only the served code\'s group and the stripped output; τ = 0 gates exactly a disagreement', async () => {
  const sure = pickJudge({ 2833: 0.05, 2834: 0.15, 2836: 0.8 });
  const kept = await gatePick({ ...SIC, output: OUTPUT, input: { name: 'Acme Bio AG' }, judge: sure, tau: 0 });
  assert.deepEqual([kept.gated, kept.record.m, kept.record.top, kept.record.options], [false, 0.65, '2836', 3]);
  const asked = sure.asked[0];
  assert.deepEqual(Object.keys(asked.questions.pick.criteria), ['c2833', 'c2834', 'c2836']);
  assert.equal(asked.questions.pick.criteria.c2836, '2836 BIOLOGICAL PRODUCTS');
  assert.equal(asked.state.company, 'Acme Bio AG');
  assert.equal('sic4' in asked.state.answer, false);
  assert.ok(!asked.state.answer.cites.some((c) => c.claim === 'sic'));

  const other = await gatePick({ ...SIC, output: OUTPUT, input: { name: 'Acme Bio AG' }, judge: pickJudge({ 2833: 0.05, 2834: 0.6, 2836: 0.35 }), tau: 0 });
  assert.deepEqual([other.gated, other.record.m, other.record.top], [true, -0.25, '2834'], 'τ = 0: the second pick prefers a sibling');
  const close = pickJudge({ 2833: 0, 2834: 0.45, 2836: 0.55 });
  assert.equal((await gatePick({ ...SIC, output: OUTPUT, input: {}, judge: close, tau: 0 })).gated, false, 'agreement passes τ = 0');
  assert.equal((await gatePick({ ...SIC, output: OUTPUT, input: {}, judge: close, tau: 0.2 })).gated, true, 'a margin of 0.1 is under τ = 0.2');
});

test('a receipted code is never gated and costs no pick; no signal (an error, no probabilities) is gated; a group of one is not', async () => {
  const judge = pickJudge({ 2834: 1, 2836: 0 });
  const exempt = await gatePick({ ...SIC, output: OUTPUT, input: {}, judge, tau: 0.5, receipt: async () => true });
  assert.deepEqual([exempt.gated, exempt.record.exempt, judge.asked.length], [false, 'receipt', 0]);
  const failing = { run: async () => { throw new Error('the broker is down'); } };
  const lost = await gatePick({ ...SIC, output: OUTPUT, input: {}, judge: failing, tau: 0 });
  assert.deepEqual([lost.gated, lost.record.m], [true, null]);
  const bare = { run: async () => ({ answers: { pick: { type: 'choice', choice: 'c2836' } } }) };
  assert.equal((await gatePick({ ...SIC, output: OUTPUT, input: {}, judge: bare, tau: 0 })).gated, true);
  const alone = await gatePick({ ...SIC, optionsOf: async () => [CODES[2]], output: OUTPUT, input: {}, judge, tau: 0.5 });
  assert.deepEqual([alone.gated, alone.record.m], [false, 1]);
});

test('the hand-off of a gated run shows its output without the code and asks the agent for the code', () => {
  const stripped = strippedOutput(OUTPUT, SIC);
  const text = handoffText({ name: WORKFLOW, revision: 'a'.repeat(64), outcome: 'escalated', output: stripped, gated: { key: 'sic4', group: '28', tau: 0.3, gated: true, m: -0.25, top: '2834' } });
  assert.ok(text.includes('its sic4 pick was not sure enough to stand alone'), text);
  assert.ok(text.includes(JSON.stringify(stripped)));
  assert.ok(!text.includes('2836') && !text.includes('2834'), 'the hand-off names no code');
  assert.ok(text.endsWith('Start from that: choose its sic4 yourself, check the rest as you need, and give the answer.'));
  assert.equal(handoffText({ name: WORKFLOW, revision: 'a'.repeat(64), outcome: 'escalated', detail: { summary: 'x' } }).endsWith('Start from that: do the rest of the job and give the answer.'), true, 'an ungated escalation is as before');
});

// ---------------------------------------------------------------- the host: m < τ hands off, τ = 0 keeps an agreed pick

const v4 = scriptedParts({ set: SETS.v4 });
const answer4 = SETS.v4.answer(v4.data);
const truth4 = readJson(join(FIXTURES_V4, 'answers.json'));
const harbor = v4.companies.find((c) => c.name === 'Harbor Valve Works Inc.');
const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };
const said = (context) => { const user = context.messages.find((m) => m.role === 'user'); return typeof user.content === 'string' ? user.content : user.content.map((c) => c.text ?? '').join(''); };

async function served(t, tau) {
  const root = await mkdtemp(join(tmpdir(), 'lc-pick-gate-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const input = SETS.v4.input(harbor);
  const run = await prepareRun({ home, repo, host: 'test', runId: `run-gate-${String(tau).replace('.', '')}`, input });
  const dispatch = { name: WORKFLOW, sha256: 'f'.repeat(64), workflow: CLASSIFY_WORKFLOW_V4, input };
  const { node } = agentScriptV4({ job: harbor, offered: [], fixtures: { truth: truth4 } });
  const model = scriptedModel({ root: [{ call: 'answer', args: answerOfV4(truth4[harbor.name]) }, { say: 'Done.' }], node, models: twoModels });
  const pickGate = { ...SETS.v4.pickGroups(v4.data), tau, receiptOf: () => false };
  const measure = await runJob({ run, job: harbor, model, judge: meteredJudge(v4.judge()), effects: [...(await v4.toolsFor(harbor, run)), ...SETS.v4.labelTools(v4.data)], answer: answer4, text: SETS.v4.text, dispatch, pickGate });
  return { measure, model };
}

test('host: τ above the pick\'s margin sends the code back to the root agent, shown no code; τ = 0 keeps the agreed pick', async (t) => {
  const gated = await served(t, 0.95);
  assert.deepEqual([gated.measure.dispatch.outcome, gated.measure.dispatch.gated.gated, gated.measure.dispatch.gated.m, gated.measure.dispatch.gated.group], ['escalated', true, 0.8, '35']);
  const prompt = said(gated.model.requests[0]);
  assert.ok(prompt.includes('its sic4 pick was not sure enough to stand alone'), prompt);
  assert.ok(!prompt.includes('"sic4"') && !prompt.includes(truth4[harbor.name].sic4), 'the agent is shown no code');
  assert.equal(gated.measure.answer.sic4, truth4[harbor.name].sic4, 'the agent answered');
  assert.deepEqual(gated.measure.workflowRuns.filter((r) => r.classifiedBy === HOST_WORKFLOW).map((r) => r.outcome), ['escalated'], 'the host\'s run is not the answer: it counts as escalated, as an invalid output does');
  assert.equal(hostRecord({ executions: [{ key: gated.measure.dispatch.key, outcome: 'complete' }] }, gated.measure.dispatch).executions[0].outcome, 'escalated');

  const kept = await served(t, 0);
  assert.deepEqual(kept.model.requests, [], 'the root agent is never asked');
  assert.deepEqual([kept.measure.dispatch.outcome, kept.measure.dispatch.gated.gated, kept.measure.dispatch.gated.m], ['complete', false, 0.8]);
  assert.equal(kept.measure.answer.sic4, truth4[harbor.name].sic4);
  assert.deepEqual(kept.measure.workflowRuns.filter((r) => r.classifiedBy === HOST_WORKFLOW).map((r) => r.outcome), ['complete']);
  assert.equal(hostRecord({ executions: [{ key: kept.measure.dispatch.key, outcome: 'complete' }] }, kept.measure.dispatch).executions[0].outcome, 'complete');
});
