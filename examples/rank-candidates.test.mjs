import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from '../packages/dsl/dist/index.js';
import { rankCandidates } from './rank-candidates.mjs';
import { createScriptedJudge, fitScores, request } from './rank-candidates-fixtures.mjs';

test('ranks the proposals: best first, a duplicate and a full bucket cut with their reasons', async () => {
  assert.deepEqual(validateWorkflow(rankCandidates, { input: request }), { ok: true });
  const { runJudge, requests } = createScriptedJudge();
  const result = await runWorkflow(rankCandidates, request, { runJudge });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output.ranked.map(r => [r.id, r.bucket, r.score]), [
    ['p01', 'reliability', 2.92], ['p02', 'reliability', 2.71], ['p04', 'observability', 2.64], ['p06', 'cost', 2.58], ['p08', 'cost', 2.47],
  ]);
  assert.deepEqual(result.output.cut, [
    { id: 'p10', reason: 'below the minimum score' },
    { id: 'p11', reason: 'below the minimum score' },
    { id: 'p03', reason: 'duplicate of p01' },
    { id: 'p09', reason: 'bucket reliability is full' },
    { id: 'p07', reason: 'beyond the top 5' },
    { id: 'p12', reason: 'beyond the top 5' },
    { id: 'p05', reason: 'beyond the top 5' },
  ]);
  // Twelve fit questions, then the ten best paired: 10 × 9 / 2.
  assert.deepEqual(requests, [{ label: 'score-fit', questions: 12 }, { label: 'find-duplicates', questions: 45 }]);
  // Every candidate is accounted for exactly once.
  assert.deepEqual([...result.output.ranked, ...result.output.cut].map(c => c.id).sort(), request.candidates.map(c => c.id).sort());
});

test('another workflow calls it as one step', async () => {
  const parent = {
    v: 2, name: 'Plan a programme', schemas: { ...rankCandidates.schemas, Plan: { type: 'object', required: ['talks'], properties: { talks: { type: 'array', items: { type: 'string' } } } } },
    input: { schemaId: 'Request' }, output: { schemaId: 'Plan', path: 'plan' },
    root: { node: 'chain', steps: [
      { node: 'workflow', label: 'rank-proposals', workflow: rankCandidates, out: 'Ranking', as: 'ranking',
        input: { brief: '{brief}', candidates: '{candidates}', top: '{top}', perBucket: '{perBucket}', minScore: '{minScore}' } },
      { node: 'code', label: 'plan', code: 's => ({ plan: { talks: s.ranking.ranked.map(r => r.title) } })' },
    ] },
  };
  assert.deepEqual(validateWorkflow(parent, { input: request }), { ok: true });
  const result = await runWorkflow(parent, request, { runJudge: createScriptedJudge().runJudge });
  assert.equal(result.status, 'complete');
  assert.equal(result.output.talks.length, 5);
  assert.equal(result.output.talks[0], 'What we learned from 400 failed runs');
});

test('600 candidates need no batching in the workflow: the sift splits itself and the ranking is the same', async () => {
  const candidates = Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, bucket: `b${i % 7}`, title: `Candidate ${i}`, summary: `Fictional summary ${i}.` }));
  // A fixed pseudo-random score per candidate, between 0 and 3.
  const scores = Object.fromEntries(candidates.map((c, i) => [c.id, Math.round(((i * 7919) % 301)) / 100]));
  const input = { brief: request.brief, candidates, top: 40, perBucket: 8, minScore: 1 };
  const { runJudge, requests } = createScriptedJudge({ scores, duplicates: [] });
  const result = await runWorkflow(rankCandidates, input, { runJudge });
  assert.equal(result.status, 'complete');
  assert.deepEqual(requests.filter(r => r.label === 'score-fit').map(r => r.questions), [256, 256, 88]);
  // 80 considered candidates make 3,160 pairs: thirteen requests, none over the limit.
  const pairRequests = requests.filter(r => r.label === 'find-duplicates').map(r => r.questions);
  assert.equal(pairRequests.reduce((a, b) => a + b, 0), 80 * 79 / 2);
  assert.ok(pairRequests.every(n => n <= 256));
  // The same ranking computed directly from the scores.
  const expected = [];
  const perBucket = {};
  for (const c of candidates.map((c, index) => ({ ...c, index, score: scores[c.id] })).filter(c => c.score >= 1).sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (expected.length < 40 && (perBucket[c.bucket] ?? 0) < 8) { perBucket[c.bucket] = (perBucket[c.bucket] ?? 0) + 1; expected.push(c.id); }
  }
  assert.deepEqual(result.output.ranked.map(r => r.id), expected);
  assert.equal(result.output.ranked.length, 40);
  assert.equal(result.output.ranked.length + result.output.cut.length, 600);
});

test('the fixture scores are the scores the workflow ranks by', async () => {
  const result = await runWorkflow(rankCandidates, { ...request, top: 12, perBucket: 12, minScore: 0 }, { runJudge: createScriptedJudge({ duplicates: [] }).runJudge });
  assert.deepEqual(Object.fromEntries(result.output.ranked.map(r => [r.id, r.score])), fitScores);
});
