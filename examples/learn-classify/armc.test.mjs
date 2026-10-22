// ARM C's carriers for a discovered lookup, at $0: the tools' refusal of SEC and web-archive hosts states the archived
// carve-out (what is allowed, never what a page holds); a lesson that contradicts an active fact is refused, with the
// sticky worst answer; and facts are kept past the index cap up to a floor.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { local, openRepo } from '@parcha/pi-git-remote';
import { inboxPath, learningId, learningPath, proposeFiles, renderInbox, renderLearning } from '@parcha/pi-agent-learn';
import { stickyJudge } from './curate-cuts.mjs';
import { curateJob, meteredJudge } from './host.mjs';
import { ARCHIVED_SEC_NOTE, fetchPageTool, refusedUrl } from './tools.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-armc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- the refusal states the carve-out

const noNetwork = async () => { throw new Error('no request is made for a refused URL'); };

test('with the archived carve-out on, refusing sec.gov, a mirror or another archive copy says what is allowed instead', async () => {
  const tool = fetchPageTool({ allowDomain: 'any', archivedSec: true, fetch: noNetwork, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  for (const url of ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1', 'https://sec.report/CIK/1', 'https://web.archive.org/web/2026/https://example.com/']) {
    const result = await tool.run({ url });
    assert.ok(result.refused?.endsWith(ARCHIVED_SEC_NOTE), `${url}: ${result.refused}`);
  }
  assert.ok(refusedUrl('https://www.sec.gov/x', { archivedSec: true }).endsWith(ARCHIVED_SEC_NOTE));
  assert.equal(refusedUrl('https://web.archive.org/web/2026/https://www.sec.gov/x', { archivedSec: true }), null, 'the carve-out itself is open');
});

test('without the carve-out the refusal is as before, and a local address never gets the note', async () => {
  const tool = fetchPageTool({ allowDomain: 'any', fetch: noNetwork, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const refused = (await tool.run({ url: 'https://www.sec.gov/x' })).refused;
  assert.equal(refused, 'www.sec.gov is on the refused list (sec.gov: SEC filings, SIC listings or web archives)');
  assert.equal(refusedUrl('https://www.sec.gov/x'), refused);
  assert.ok(!refusedUrl('http://127.0.0.1/x', { archivedSec: true }).includes(ARCHIVED_SEC_NOTE));
});

// ---------------------------------------------------------------- facts over lessons, and the fact floor

const RULES = '# Rules\n\nCite every claim.\n';
const FACT = { id: 'L-f00000000001', type: 'fact', scope: 'all', status: 'active', provenance: { runs: ['run-000'], sha: '0'.repeat(40), untrusted: true }, uses: 0, supersedes: [], text: 'The archived EDGAR company page shows the SEC\'s assigned SIC code.' };
const COUNTER = 'Wayback copies of EDGAR company pages were unreachable; do not count on them to confirm an SEC-assigned SIC code.';

async function agentRepo(root) {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: root } });
  const repo = await openRepo({ dir: join(root, 'host'), remote: local(bare) });
  const { sha } = await repo.commitTo('main', { files: { 'AGENTS.md': RULES, [learningPath(FACT.id)]: renderLearning(FACT) }, message: 'seed' });
  await repo.push(sha, 'main');
  return repo;
}
async function proposeLesson(repo, runId, text) {
  const candidates = [{ callId: 'call-1', type: 'lesson', text, evidence: [] }];
  const result = await proposeFiles({ repo, runId, files: { [inboxPath(runId)]: renderInbox(runId, candidates, { untrusted: true }) }, candidates, secrets: [], caseValues: [] });
  assert.equal(result.status, 'proposed', JSON.stringify(result));
}
/** Every atomic question passes; contradicts answers from `contradicts`, a number or a list taken in turn. */
function judgeWith(contradicts) {
  const seen = [];
  let i = 0;
  const run = async (params) => {
    const [q] = Object.keys(params.questions);
    const p = q === 'contradicts' ? (Array.isArray(contradicts) ? contradicts[Math.min(i++, contradicts.length - 1)] : contradicts) : { general: 0.95, narrowsRules: 0.02, fromContent: 0.02, duplicate: 0.02, supersedes: 0.02 }[q] ?? 0.02;
    seen.push(q);
    return { answers: { [q]: { type: 'noul', noul: p } }, cost_usd: 0 };
  };
  return { run, seen };
}
const verdict = (curated, runId) => {
  const r = curated.report.runs.find((x) => x.run === runId);
  return ['accepted', 'held', 'refused'].find((kind) => r[kind].some((item) => item.candidate === 1));
};

test('curateJob: with factsOverLessons the counter-lesson to an active fact is refused; without it, it is accepted as in B', async (t) => {
  const plain = await agentRepo(await scratch(t));
  await proposeLesson(plain, 'run-015', COUNTER);
  assert.equal(verdict(await curateJob({ repo: plain, judge: meteredJudge(judgeWith(0.9).run) }), 'run-015'), 'accepted');
  const repo = await agentRepo(await scratch(t));
  await proposeLesson(repo, 'run-015', COUNTER);
  const curated = await curateJob({ repo, judge: meteredJudge(judgeWith(0.9).run), factsOverLessons: true });
  assert.equal(verdict(curated, 'run-015'), 'refused');
  assert.match(curated.report.runs[0].refused[0].reason, /^contradicts the active fact L-f00000000001 \(0\.90\)$/);
});

test('the sticky judge keeps the worst contradicts answer per lesson and fact: a kinder answer later does not let the counter-lesson in', async (t) => {
  const root = await scratch(t);
  const file = join(root, 'sticky.json');
  const first = await agentRepo(join(root, 'a'));
  await proposeLesson(first, 'run-015', COUNTER);
  const firstJudge = judgeWith(0.9);
  const sticky = { file, cutsId: 'v0.1', contradicts: true };
  assert.equal(verdict(await curateJob({ repo: first, judge: meteredJudge(firstJudge.run), sticky, factsOverLessons: true }), 'run-015'), 'refused');
  // The same text from a later run, judged kindly now: the store answers with the worst it saw.
  const later = await agentRepo(join(root, 'b'));
  await proposeLesson(later, 'run-030', COUNTER);
  assert.equal(verdict(await curateJob({ repo: later, judge: meteredJudge(judgeWith(0.05).run), sticky, factsOverLessons: true }), 'run-030'), 'refused');
  // Without the contradicts option the store passes pairwise questions through, as before.
  const passing = stickyJudge(judgeWith(0.05).run, { file: join(root, 'plain.json'), cutsId: 'v0.1' });
  const answer = await passing({ questions: { contradicts: { type: 'noul' } }, state: { candidate: { type: 'lesson', text: COUNTER }, existing: { id: FACT.id, type: 'fact', text: FACT.text } } });
  assert.equal(answer.answers.contradicts.noul, 0.05);
});

test('curateJob passes factFloor to curate; the runner takes --fact-floor as a whole number and --facts-over-lessons', async (t) => {
  const runner = join(import.meta.dirname, 'runner.mjs');
  const out = join(await scratch(t), 'out');
  const cli = (...args) => spawnSync(process.execPath, [runner, '--scripted', '--set', 'v4', '--out', out, '--jobs', '0', ...args], { encoding: 'utf8' });
  const bad = cli('--fact-floor', '1.5');
  assert.deepEqual([bad.status, bad.stderr.split('\n')[0]], [2, '--fact-floor is a whole number from 0']);
  const ok = cli('--fact-floor', '12', '--facts-over-lessons');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /facts are kept past the index cap while 12 or fewer are active/);
  assert.match(ok.stdout, /a lesson that contradicts an active fact is refused/);
  const repo = await agentRepo(await scratch(t));
  await proposeLesson(repo, 'run-001', 'A general lesson about reading the segment note.');
  const curated = await curateJob({ repo, judge: meteredJudge(judgeWith(0.02).run), factFloor: 12 });
  assert.equal(verdict(curated, 'run-001'), 'accepted');
  assert.equal(learningId('run-001', 'A general lesson about reading the segment note.'), curated.report.runs[0].accepted[0].id);
});
