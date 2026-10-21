// The curator's judge cuts for the stream (pre-registered v0.1) and the sticky judge: a text curation held is never let in
// by a kinder answer to the same question later.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { local, openRepo } from '@parcha/pi-git-remote';
import { inboxPath, proposeFiles, renderInbox } from '@parcha/pi-agent-learn';
import { CURATE_CUTS_V01, stickyJudge, textKey } from './curate-cuts.mjs';
import { existsSync } from 'node:fs';
import { curateJob, meteredJudge } from './host.mjs';
import { runLoop, scriptedParts } from './runner.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-cuts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const RULES = '# Rules\n\nCite every claim.\n';

async function agentRepo(root) {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: root } });
  const repo = await openRepo({ dir: join(root, 'host'), remote: local(bare) });
  const { sha } = await repo.commitTo('main', { files: { 'AGENTS.md': RULES }, message: 'seed' });
  await repo.push(sha, 'main');
  return repo;
}

const lesson = (n, text) => ({ callId: `call-${n}`, type: 'lesson', text, evidence: [] });

async function propose(repo, runId, texts) {
  const candidates = texts.map((text, i) => lesson(i + 1, text));
  const files = { [inboxPath(runId)]: renderInbox(runId, candidates, { untrusted: true }) };
  const result = await proposeFiles({ repo, runId, files, candidates, secrets: [], caseValues: [] });
  assert.equal(result.status, 'proposed', JSON.stringify(result));
}

/** A judge answering each atomic question from a table keyed by the learning's text; every pairwise question is a no. */
function tableJudge(table) {
  const asked = [];
  const run = async (params) => {
    const [q] = Object.keys(params.questions);
    const text = params.state?.learning?.text;
    asked.push({ q, text });
    const noul = text !== undefined && table[text]?.[q] !== undefined ? table[text][q] : 0;
    return { answers: { [q]: { type: 'noul', noul } }, model: 'fake', usage: null, cost_usd: 0 };
  };
  return { run, asked };
}

const verdicts = (report) => {
  const out = {};
  for (const r of report.runs) for (const kind of ['accepted', 'held', 'refused']) for (const item of r[kind]) if (item.candidate !== undefined) out[`${r.run}#${item.candidate}`] = kind;
  return out;
};

test('the v0.1 cut table is the pre-registered one', () => {
  assert.deepEqual(CURATE_CUTS_V01, {
    fromContent: { yes: 0.8, no: 0.65 },
    narrowsRules: { yes: 0.6, no: 0.45 },
    general: { yes: 0.6, no: 0.4 },
  });
  assert.ok(Object.isFrozen(CURATE_CUTS_V01) && Object.values(CURATE_CUTS_V01).every(Object.isFrozen));
});

test('curateJob applies the v0.1 cuts exactly at every boundary, and the package defaults when told to', async (t) => {
  const root = await scratch(t);
  // Each text sits at one boundary of one question; the other two questions pass with room.
  const pass = { fromContent: 0.3, narrowsRules: 0.1, general: 0.9 };
  const rows = [
    ['fc at pass', { fromContent: 0.65 }, 'accepted'],
    ['fc just over pass', { fromContent: 0.66 }, 'held'],
    ['fc at refuse', { fromContent: 0.8 }, 'refused'],
    ['nr at pass', { narrowsRules: 0.45 }, 'accepted'],
    ['nr just over pass', { narrowsRules: 0.46 }, 'held'],
    ['nr at refuse', { narrowsRules: 0.6 }, 'refused'],
    ['g at pass', { general: 0.6 }, 'accepted'],
    ['g just under pass', { general: 0.59 }, 'held'],
    ['g at refuse', { general: 0.4 }, 'refused'],
  ];
  const table = Object.fromEntries(rows.map(([name, at]) => [`Lesson ${name}: read the exhibit index before the exhibits.`, { ...pass, ...at }]));
  const texts = Object.keys(table);
  const v01 = await agentRepo(join(root, 'a'));
  // One run per text: a run's candidates are judged against each other pairwise, and each row stands alone.
  for (const [i, text] of texts.entries()) await propose(v01, `run-${i + 1}`, [text]);
  const { report } = await curateJob({ repo: v01, judge: meteredJudge(tableJudge(table).run), judgeCuts: CURATE_CUTS_V01 });
  const got = verdicts(report);
  assert.deepEqual(rows.map((_, i) => got[`run-${i + 1}#1`]), rows.map(([, , want]) => want));

  // The package's own defaults on the same answers: the method lessons v0.1 admits are held or refused.
  const today = await agentRepo(join(root, 'b'));
  for (const [i, text] of texts.entries()) await propose(today, `run-${i + 1}`, [text]);
  const { report: before } = await curateJob({ repo: today, judge: meteredJudge(tableJudge(table).run) });
  assert.equal(Object.values(verdicts(before)).filter((v) => v === 'accepted').length, 0);
});

test('a held text is still held when a later run proposes it and the judge answers kinder; without the sticky judge it walks in', async (t) => {
  const root = await scratch(t);
  const text = 'A preface may say its segment table is one segment for all purposes; answer oneSegment then.';
  const first = { [text]: { fromContent: 0.7, narrowsRules: 0.2, general: 0.7 } };
  const second = { [text]: { fromContent: 0.5, narrowsRules: 0.2, general: 0.7 } };

  for (const [name, sticky, want] of [['sticky', true, 'held'], ['plain', false, 'accepted']]) {
    const repo = await agentRepo(join(root, name));
    const file = join(root, `${name}-sticky.json`);
    await propose(repo, 'run-1', [text]);
    const one = await curateJob({ repo, judge: meteredJudge(tableJudge(first).run), judgeCuts: CURATE_CUTS_V01, ...(sticky ? { sticky: { file, cutsId: 'v0.1' } } : {}) });
    assert.equal(verdicts(one.report)['run-1#1'], 'held');
    await propose(repo, 'run-2', [text]);
    const two = await curateJob({ repo, judge: meteredJudge(tableJudge(second).run), judgeCuts: CURATE_CUTS_V01, ...(sticky ? { sticky: { file, cutsId: 'v0.1' } } : {}) });
    assert.equal(verdicts(two.report)['run-2#1'], want, name);
  }
});

test('stickyJudge keeps the worst answer per text and question: the highest fromContent and narrowsRules, the lowest general', async (t) => {
  const root = await scratch(t);
  const file = join(root, 'sticky.json');
  const answers = [0.7, 0.4, 0.75];
  let i = 0;
  const inner = async (params) => {
    const [q] = Object.keys(params.questions);
    return { answers: { [q]: { type: 'noul', noul: answers[i++ % answers.length] } }, model: 'fake', usage: null, cost_usd: 0.001 };
  };
  const ask = (judge, q, text, rules) => judge({ label: `curate/${q}`, kind: 'judge', state: { learning: { type: 'lesson', text }, ...(rules ? { rules } : {}) }, questions: { [q]: { type: 'noul', instructions: 'x' } }, decisionId: 'd' });
  const judge = stickyJudge(inner, { file, cutsId: 'v0.1' });
  const seen = [];
  for (let n = 0; n < 3; n += 1) seen.push((await ask(judge, 'fromContent', 'Read the  index FIRST.')).answers.fromContent.noul);
  assert.deepEqual(seen, [0.7, 0.7, 0.75]);
  // The same text, spaced and cased differently, is the same text.
  assert.equal(textKey('read the index first.'), textKey('Read the  index FIRST.'));
  i = 0;
  const general = [];
  for (let n = 0; n < 3; n += 1) general.push((await ask(judge, 'general', 'Another rule.')).answers.general.noul);
  assert.deepEqual(general, [0.7, 0.4, 0.4]);
  // The cost of every real call still reaches the meter.
  assert.equal((await ask(judge, 'fromContent', 'Read the index first.')).cost_usd, 0.001);
  // It survives a restart: the store is a file beside the repository.
  i = 1;
  const again = stickyJudge(inner, { file, cutsId: 'v0.1' });
  assert.equal((await ask(again, 'fromContent', 'Read the index first.')).answers.fromContent.noul, 0.75);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['version', 'cutsId', 'worst', 'prior']);
});

test('stickyJudge asks narrowsRules afresh for new rules, passes every other question through, and asks for a margin when the cuts change', async (t) => {
  const root = await scratch(t);
  const file = join(root, 'sticky.json');
  let next = 0.9;
  const inner = async (params) => {
    const [q] = Object.keys(params.questions);
    return { answers: { [q]: { type: 'noul', noul: next } }, model: 'fake', usage: null, cost_usd: 0 };
  };
  const ask = (judge, q, state) => judge({ label: `curate/${q}`, kind: 'judge', state, questions: { [q]: { type: 'noul', instructions: 'x' } }, decisionId: 'd' });
  const learning = { type: 'lesson', text: 'A rule.' };
  const judge = stickyJudge(inner, { file, cutsId: 'v0.1' });
  assert.equal((await ask(judge, 'narrowsRules', { learning, rules: 'old rules' })).answers.narrowsRules.noul, 0.9);
  next = 0.2;
  assert.equal((await ask(judge, 'narrowsRules', { learning, rules: 'old rules' })).answers.narrowsRules.noul, 0.9);
  assert.equal((await ask(judge, 'narrowsRules', { learning, rules: 'new rules' })).answers.narrowsRules.noul, 0.2);
  // Pairwise questions and the workflow question are not about one learning's text: untouched.
  next = 0.1;
  assert.equal((await ask(judge, 'duplicate', { candidate: learning, existing: { id: 'L-000000000000', type: 'lesson', text: 'B.' } })).answers.duplicate.noul, 0.1);
  assert.equal((await ask(judge, 'workflowCase', { workflow: {} })).answers.workflowCase.noul, 0.1);
  // New cuts: the old worst is dropped, and a text seen before must clear by 0.05 (bad questions up, general down).
  next = 0.5;
  const recut = stickyJudge(inner, { file, cutsId: 'v1' });
  assert.equal((await ask(recut, 'narrowsRules', { learning, rules: 'old rules' })).answers.narrowsRules.noul, 0.55);
  assert.equal((await ask(recut, 'general', { learning })).answers.general.noul, 0.5);
  next = 0.6;
  assert.equal((await ask(recut, 'general', { learning: { type: 'lesson', text: 'Never seen.' } })).answers.general.noul, 0.6);
});

test('with nothing asked for, curateJob curates as the package does: its own cuts, the judge unwrapped', async (t) => {
  const root = await scratch(t);
  const text = 'Read the exhibit index before the exhibits.';
  // Held by the package's own fromContent cut (0.1 < 0.3 < 0.5), then a kinder 0.05: an unwrapped judge lets it in.
  const first = { [text]: { fromContent: 0.3, narrowsRules: 0.05, general: 0.9 } };
  const second = { [text]: { fromContent: 0.05, narrowsRules: 0.05, general: 0.9 } };
  const repo = await agentRepo(root);
  await propose(repo, 'run-1', [text]);
  assert.equal(verdicts((await curateJob({ repo, judge: meteredJudge(tableJudge(first).run) })).report)['run-1#1'], 'held');
  await propose(repo, 'run-2', [text]);
  assert.equal(verdicts((await curateJob({ repo, judge: meteredJudge(tableJudge(second).run) })).report)['run-2#1'], 'accepted');
});

test('the runner keeps no sticky store unless asked: --curate-sticky writes it beside the repository', async (t) => {
  const root = await scratch(t);
  for (const [name, sticky] of [['plain', false], ['sticky', true]]) {
    const out = join(root, name);
    const parts = scriptedParts();
    if (sticky) Object.assign(parts, { sticky: true, judgeCuts: CURATE_CUTS_V01, cutsId: 'v0.1' });
    await runLoop({ out, parts, jobs: 1, record: false });
    assert.equal(existsSync(join(out, 'curate-sticky.json')), sticky, name);
  }
});

