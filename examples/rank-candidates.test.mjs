import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from '../packages/dsl/dist/index.js';
import { rankCandidates } from './rank-candidates.mjs';
import { createScriptedJudge, fitScores, request } from './rank-candidates-fixtures.mjs';
import { main } from './run-rank-candidates.mjs';

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
  const best = candidates.map((c, index) => ({ ...c, index, score: scores[c.id] })).filter(c => c.score >= 1).sort((a, b) => b.score - a.score || a.index - b.index);
  for (const c of best.slice(0, 80)) {
    if (expected.length < 40 && (perBucket[c.bucket] ?? 0) < 8) { perBucket[c.bucket] = (perBucket[c.bucket] ?? 0) + 1; expected.push(c.id); }
  }
  assert.deepEqual(result.output.ranked.map(r => r.id), expected);
  assert.equal(result.output.ranked.length, 40);
  assert.equal(result.output.ranked.length + result.output.cut.length, 600);
  assert.equal(result.output.cut.filter(c => c.reason === 'outside the best 80').length, best.length - 80);
});

test('the fixture scores are the scores the workflow ranks by', async () => {
  const result = await runWorkflow(rankCandidates, { ...request, top: 12, perBucket: 12, minScore: 0 }, { runJudge: createScriptedJudge({ duplicates: [] }).runJudge });
  assert.deepEqual(Object.fromEntries(result.output.ranked.map(r => [r.id, r.score])), fitScores);
});

test('only candidates that were checked against each other can be chosen', async () => {
  // top 2 considers the best four. Three of them are the same talk, so one list slot stays empty
  // rather than going to p06, which was never compared with the others.
  const duplicates = [['p01', 'p03'], ['p01', 'p02'], ['p03', 'p02']];
  const result = await runWorkflow(rankCandidates, { ...request, top: 2, perBucket: 2 }, { runJudge: createScriptedJudge({ duplicates }).runJudge });
  assert.deepEqual(result.output.ranked.map(r => r.id), ['p01', 'p09']);
  assert.deepEqual(result.output.cut.filter(c => ['p03', 'p02', 'p04'].includes(c.id)), [
    { id: 'p04', reason: 'outside the best 4' }, { id: 'p03', reason: 'duplicate of p01' }, { id: 'p02', reason: 'duplicate of p01' },
  ]);
  const short = await runWorkflow(rankCandidates, { ...request, top: 2, perBucket: 1 }, { runJudge: createScriptedJudge({ duplicates }).runJudge });
  assert.deepEqual(short.output.ranked.map(r => r.id), ['p01'], 'p09 shares the full bucket; nothing unchecked fills the slot');
});

test('a bucket named like an object method is counted, and candidates that share an id stay distinct', async () => {
  const candidates = [
    { id: 'a', bucket: 'toString', title: 'First', summary: 'One.' },
    { id: 'a', bucket: 'toString', title: 'Second', summary: 'Two.' },
    { id: 'b', bucket: 'toString', title: 'Third', summary: 'Three.' },
    { id: 'c', bucket: 'constructor', title: 'Fourth', summary: 'Four.' },
  ];
  const scores = { a: 2.5, b: 2.4, c: 2.3 };
  const result = await runWorkflow(rankCandidates, { brief: request.brief, candidates, top: 3, perBucket: 2, minScore: 1 }, { runJudge: createScriptedJudge({ scores, duplicates: [] }).runJudge });
  assert.deepEqual(result.output.ranked.map(r => r.title), ['First', 'Second', 'Fourth']);
  assert.deepEqual(result.output.cut, [{ id: 'b', reason: 'bucket toString is full' }]);
});

test('the runner says what --input needs', async () => {
  await assert.rejects(main(['--live', '--input']), /--input needs the path of a JSON file/);
  await assert.rejects(main(['--input', 'request.json']), /--input requires --live/);
});
