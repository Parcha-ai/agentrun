// learn-classify v4, the dollar job, at $0: the answer's shape, the scorer on its own, the agent home, then scripted passes
// end to end with fakes of lane C3's tools, scored from what each run's store says it read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { renderSkill, renderTrial, skillPath, trialPath } from '@parcha/pi-agent-learn';
import { renderCurve } from './curve.mjs';
import { HOST_WORKFLOW } from './dispatch.mjs';
import { answerV4, textsRead } from './host.mjs';
import { rerow } from './rerow.mjs';
import { rescore } from './rescore.mjs';
import { openOut, readRows, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { CITE_QUESTION_V4, countryCode, entityName, HQ_QUESTION, MAX_SUBSIDIARIES, scoreCites, scoreHq, scoreSegments, scoreSubsidiaries, scoreV4, SEGMENT_PICK } from './score-v4.mjs';
import { agentScriptV4Compose, CLASSIFY_WORKFLOW_V4, FIXTURES_V2, FIXTURES_V4, PART_CODE, PART_FIND_REPORT, readJson, scriptedModel, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-v4-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A judge that answers the scorer by case id: a segment choice by the answer segment's name (`picks[name]` is
 *  `[truth member, probability]`), the headquarters by the answer's city, a subsidiary by its name, a cite by its URL. */
function judge({ picks = {}, hq = {}, subsidiaries = {}, cites = {} } = {}) {
  const asked = [];
  const run = async ({ label, state, questions }) => {
    asked.push({ label, state, questions });
    const answers = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'choice') {
        const [member, p] = picks[state.answer.find((a) => a.id === key).name] ?? [];
        const choice = state.truth.find((t) => t.member === member)?.id ?? 'none_of_these';
        answers[key] = { type: 'choice', choice, probabilities: { [choice]: p ?? 0.9 }, confidence: p ?? 0.9 };
      } else {
        const p = label === 'score/hq' ? hq[state.answer.city] : label === 'score/subsidiary' ? subsidiaries[state.subsidiary] : cites[state.url];
        answers[key] = { type: 'noul', noul: p ?? 0.1 };
      }
    }
    return { answers, cost_usd: 0.0001 };
  };
  return { run, asked };
}

const filed = [
  { member: 'WaterSystemsMember', label: 'Water Systems', revenue: 612, share: 0.61 },
  { member: 'IndustrialFlowMember', label: 'Industrial Flow', revenue: 390, share: 0.39 },
];

// ---- the answer ----------------------------------------------------------------------------------------------------------

test('the v4 answer: the code from sic_codes, every segment or one, the headquarters, 1 to 15 subsidiaries, the report, 1 to 12 cites', () => {
  const codes = readJson(join(FIXTURES_V4, 'sic-codes.json'));
  const tool = answerV4(codes);
  const validate = new Ajv({ strict: false, allErrors: true }).compile(tool.parameters);
  const cite = { claim: 'report', url: 'https://www.harborvalve.example/annual-report-2025.pdf', locator: 'pdf p. 1', quote: 'Annual Report for fiscal year 2025.' };
  const answer = {
    sic4: '3561', segments: [{ name: 'Water Systems', share: 0.61 }, { name: 'Industrial Flow', share: 0.39 }], hq: { city: 'Pittsburgh', state: 'PA', country: 'United States' },
    subsidiaries: [{ name: 'Harbor Valve Europe GmbH', country: 'Germany' }], annualReport: { url: cite.url, fiscalYear: 2025 }, cites: [cite],
  };
  const ok = (value) => { const valid = validate(value); return valid || validate.errors.map((e) => `${e.instancePath} ${e.message}`).join('; '); };
  assert.equal(ok(answer), true);
  assert.equal(ok({ ...answer, segments: { oneSegment: true } }), true);
  assert.equal(ok({ ...answer, hq: { city: 'Toronto', country: 'Canada' } }), true, 'the state is optional');
  for (const [why, wrong] of [
    ['a code not in sic_codes', { ...answer, sic4: '9999' }],
    ['no segments', { ...answer, segments: [] }],
    ['oneSegment false', { ...answer, segments: { oneSegment: false } }],
    ['a share above 1', { ...answer, segments: [{ name: 'Water Systems', share: 61 }] }],
    ['no country', { ...answer, hq: { city: 'Pittsburgh' } }],
    ['16 subsidiaries', { ...answer, subsidiaries: Array.from({ length: MAX_SUBSIDIARIES + 1 }, (_, i) => ({ name: `Subsidiary ${i}` })) }],
    ['no subsidiaries', { ...answer, subsidiaries: [] }],
    ['a year as text', { ...answer, annualReport: { url: cite.url, fiscalYear: '2025' } }],
    ['13 cites', { ...answer, cites: Array.from({ length: 13 }, () => cite) }],
    ['a claim of another kind', { ...answer, cites: [{ ...cite, claim: 'industry' }] }],
    ['a quote over 300 characters', { ...answer, cites: [{ ...cite, quote: 'x'.repeat(301) }] }],
    ['a part left out', (({ annualReport, ...rest }) => rest)(answer)],
  ]) assert.notEqual(ok(wrong), true, why);
  assert.equal(tool.recorded(answer), '3561');
});

// ---- the scorer ----------------------------------------------------------------------------------------------------------

test('segments: a filed label or member matches without a question, F1 over both sides, share error in points', async () => {
  const j = judge();
  const exact = await scoreSegments({ answer: { segments: [{ name: 'water systems', share: 0.6 }, { name: 'Industrial Flow', share: 0.41 }] }, truth: filed, judge: j.run });
  assert.equal(exact.segmentsF1, 1);
  assert.ok(Math.abs(exact.shareErrorMean - 1.5) < 1e-9, String(exact.shareErrorMean), '1 and 2 points');
  const byMember = await scoreSegments({ answer: { segments: [{ name: 'Aftermarket Services', share: 1 }] }, truth: [{ member: 'AftermarketServicesSegmentMember', label: null, share: 1 }], judge: j.run });
  assert.deepEqual(byMember, { segmentsF1: 1, shareErrorMean: 0 });
  assert.equal(j.asked.length, 0, 'same words need no question');
  const half = await scoreSegments({ answer: { segments: [{ name: 'Water Systems', share: 0.61 }] }, truth: filed, judge: j.run });
  assert.ok(Math.abs(half.segmentsF1 - 2 / 3) < 1e-12, String(half.segmentsF1), 'precision 1, recall 1/2');
});

test('a trailing "segment" word is a format, folded on both sides like a legal form: no question for it', async () => {
  const j = judge();
  const truth = [{ member: 'Pharmaceutical', label: 'Pharmaceutical', share: 0.9 }, { member: 'Biotechnology', label: 'Biotechnology', share: 0.1 }, { member: 'WorldWrestlingEntertainmentSegment', label: null, share: 0 }];
  const result = await scoreSegments({ answer: { segments: [{ name: 'Pharmaceutical Segment', share: 0.9 }, { name: 'Biotechnology segments', share: 0.1 }, { name: 'World Wrestling Entertainment', share: 0 }] }, truth, judge: j.run });
  assert.deepEqual(result, { segmentsF1: 1, shareErrorMean: 0 });
  assert.equal(j.asked.length, 0);
});

test('segments in other words are Jev\'s: one request, a choice per open segment over the filed ones not yet taken', async () => {
  const j = judge({ picks: { 'Water': ['WaterSystemsMember', 0.9], 'Flow control': ['IndustrialFlowMember', 0.8] } });
  const result = await scoreSegments({ answer: { segments: [{ name: 'Water', share: 0.6 }, { name: 'Flow control', share: 0.3 }, { name: 'Corporate', share: 0.1 }] }, truth: filed, judge: j.run });
  assert.ok(Math.abs(result.segmentsF1 - 0.8) < 1e-12, String(result.segmentsF1), 'two of three given, two of two filed');
  assert.ok(Math.abs(result.shareErrorMean - 5) < 1e-9, String(result.shareErrorMean), '1 and 9 points');
  assert.equal(j.asked.length, 1);
  const [request] = j.asked;
  assert.equal(request.label, 'score/segments');
  assert.deepEqual(Object.keys(request.questions), ['a0', 'a1', 'a2']);
  assert.deepEqual(Object.keys(request.questions.a0.criteria), ['t0', 't1', 'none_of_these']);
  // Each question names its own answer segment: one shared question cannot tell Jev which segment it is about.
  assert.deepEqual(Object.entries(request.questions).map(([id, q]) => q.instructions), ['a0', 'a1', 'a2'].map((id) => SEGMENT_PICK.replace('{id}', id)));
  assert.match(SEGMENT_PICK, /the answer segment with id `\{id\}` in `answer`/);
  assert.match(SEGMENT_PICK, /abbreviation, initials or short form/);
  assert.deepEqual(request.state.truth, [{ id: 't0', label: 'Water Systems', member: 'WaterSystemsMember' }, { id: 't1', label: 'Industrial Flow', member: 'IndustrialFlowMember' }]);
  // A filed segment taken by name is not offered again.
  const k = judge({ picks: { 'Flows': ['IndustrialFlowMember', 0.9] } });
  await scoreSegments({ answer: { segments: [{ name: 'Water Systems', share: 0.6 }, { name: 'Flows', share: 0.4 }] }, truth: filed, judge: k.run });
  assert.deepEqual(k.asked[0].state.truth.map((t) => t.id), ['t1']);
});

test('shares are scored against the filed shares normalized to sum 1; the row carries the filed sum', async () => {
  // As filed, the shares of these five sum to 1.1718 (intersegment revenue): an answer from the segment table's own total
  // has every share right.
  const filedShares = [['Gas', 0.5522], ['EnergyTransition', 0.2096], ['WindandSolar', 0.2079], ['Hydro', 0.1514], ['EnergyMarketing', 0.0507]];
  const truth = filedShares.map(([member, share]) => ({ member, label: member, revenue: share * 1e9, share }));
  const sum = 1.1718;
  const fromTable = await scoreSegments({ answer: { segments: filedShares.map(([member, share]) => ({ name: member, share: share / sum })) }, truth, judge: judge().run });
  assert.equal(fromTable.segmentsF1, 1);
  assert.ok(fromTable.shareErrorMean < 1e-9, String(fromTable.shareErrorMean));
  const asFiled = await scoreSegments({ answer: { segments: filedShares.map(([member, share]) => ({ name: member, share })) }, truth, judge: judge().run });
  const expected = filedShares.reduce((total, [, share]) => total + Math.abs(share - share / sum) * 100, 0) / filedShares.length;
  assert.ok(Math.abs(asFiled.shareErrorMean - expected) < 1e-9, `${asFiled.shareErrorMean} vs ${expected}`);
  const company = { sic: '4911', segments: truth, hq: null, latestAnnual: null, subsidiaries: null };
  const score = await scoreV4({ answer: { sic4: '4911', segments: { oneSegment: true } }, company, read: [], codes: {}, judge: judge().run });
  assert.ok(Math.abs(score.segmentsShareSum - sum) < 1e-9, String(score.segmentsShareSum));
  assert.deepEqual(score.segmentsTruth.map((t) => t.share), filedShares.map(([, share]) => share), 'the truth in the row stays as filed');
  for (const segments of [{ oneSegment: true }, null]) assert.equal((await scoreV4({ answer: null, company: { ...company, segments }, read: [], codes: {}, judge: judge().run })).segmentsShareSum, null);
});

test('segments match one to one: two answers that pick the same filed segment, only the surer one counts', async () => {
  const j = judge({ picks: { 'Water A': ['WaterSystemsMember', 0.6], 'Water B': ['WaterSystemsMember', 0.9] } });
  // One filed segment: its share, normalized, is all of revenue.
  const result = await scoreSegments({ answer: { segments: [{ name: 'Water A', share: 0.5 }, { name: 'Water B', share: 1 }] }, truth: [filed[0]], judge: j.run });
  assert.ok(Math.abs(result.segmentsF1 - 2 / 3) < 1e-12, String(result.segmentsF1));
  assert.equal(result.shareErrorMean, 0, 'Water B, the surer, is the match');
});

test('one segment is right only against one filed segment; no filed segments is not scored', async () => {
  const one = { segments: { oneSegment: true } };
  assert.deepEqual(await scoreSegments({ answer: one, truth: [filed[0]], judge: judge().run }), { segmentsF1: 1, shareErrorMean: null });
  assert.deepEqual(await scoreSegments({ answer: one, truth: filed, judge: judge().run }), { segmentsF1: 0, shareErrorMean: null });
  assert.deepEqual(await scoreSegments({ answer: one, truth: [], judge: judge().run }), { segmentsF1: null, shareErrorMean: null });
  assert.deepEqual(await scoreSegments({ answer: one, truth: null, judge: judge().run }), { segmentsF1: null, shareErrorMean: null });
  assert.deepEqual(await scoreSegments({ answer: null, truth: filed, judge: judge().run }), { segmentsF1: 0, shareErrorMean: null });
});

test('one-segment truth (a filer that reports one segment): oneSegment or the one segment named matches, more segments match one of them', async () => {
  const truth = { oneSegment: true };
  const j = judge();
  assert.deepEqual(await scoreSegments({ answer: { segments: { oneSegment: true } }, truth, judge: j.run }), { segmentsF1: 1, shareErrorMean: null });
  assert.deepEqual(await scoreSegments({ answer: { segments: [{ name: 'Retail grocery', share: 1 }] }, truth, judge: j.run }), { segmentsF1: 1, shareErrorMean: null });
  const two = await scoreSegments({ answer: { segments: [{ name: 'Stores', share: 0.8 }, { name: 'Online', share: 0.2 }] }, truth, judge: j.run });
  assert.ok(Math.abs(two.segmentsF1 - 2 / 3) < 1e-12, String(two.segmentsF1));
  assert.deepEqual(await scoreSegments({ answer: null, truth, judge: j.run }), { segmentsF1: 0, shareErrorMean: null });
  assert.equal(j.asked.length, 0, 'no name to match: nothing is asked');
  const score = await scoreV4({ answer: { sic4: '5411', segments: { oneSegment: true } }, company: { sic: '5411', segments: truth, hq: null }, read: [], codes: {}, judge: j.run });
  assert.deepEqual([score.segmentsTruth, score.segmentsF1, score.correct, score.correctOver], [{ oneSegment: true }, 1, true, ['sic4', 'segments']]);
});

test('the headquarters: the city folded and the country as its ISO code without a question, an alias by Jev, no truth not scored', async () => {
  const j = judge({ hq: { 'New York City': 0.9 } });
  const montreal = { city: 'MONTREAL', state: 'A8', country: 'CA' };
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Montréal', state: 'Quebec', country: 'Canada' } }, truth: montreal, judge: j.run }), { hqCorrect: true });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Pittsburgh', country: 'United States of America' } }, truth: { city: 'PITTSBURGH', state: 'PA', country: 'US' }, judge: j.run }), { hqCorrect: true });
  assert.equal(j.asked.length, 0);
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'New York City', country: 'USA' } }, truth: { city: 'NEW YORK', state: 'NY', country: 'US' }, judge: j.run }), { hqCorrect: true });
  assert.deepEqual(j.asked[0].state, { answer: { city: 'New York City', state: null, country: 'USA' }, truth: { city: 'NEW YORK', state: 'NY', country: 'US' } });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'London', country: 'Canada' } }, truth: { city: 'LONDON', country: 'GB' }, judge: j.run }), { hqCorrect: false }, 'the same city in another country');
  assert.deepEqual(await scoreHq({ answer: {}, truth: montreal, judge: j.run }), { hqCorrect: false });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Montreal', country: 'Canada' } }, truth: { city: 'MONTREAL', country: null }, judge: j.run }), { hqCorrect: null });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Montreal', country: 'Canada' } }, truth: null, judge: j.run }), { hqCorrect: null });
  // As filed: a city with its province or country after a comma, or a district in brackets, is that city.
  const asked = j.asked.length;
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Toronto', country: 'Canada' } }, truth: { city: 'TORONTO, ONTARIO', state: 'A6', country: 'CA' }, judge: j.run }), { hqCorrect: true });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Haifa', country: 'Israel' } }, truth: { city: 'HAIFA, ISRAEL', state: null, country: 'IL' }, judge: j.run }), { hqCorrect: true });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Valdilana', country: 'Italy' } }, truth: { city: 'VALDILANA (BIELLA)', state: null, country: 'IT' }, judge: j.run }), { hqCorrect: true });
  assert.equal(j.asked.length, asked, 'no question for any of them');
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Luxembourg', country: 'Luxembourg' } }, truth: { city: 'GRAND DUCHY OF LUXEMBOURG', state: null, country: 'LU' }, judge: j.run }), { hqCorrect: false }, 'not the same words: Jev\'s, and this judge says no');
  assert.equal(j.asked.length, asked + 1);
  // A district or area of the filed city (Kowloon in Hong Kong) is Jev's to judge, and the question says it counts.
  const kowloon = judge({ hq: { Kowloon: 0.9 } });
  assert.deepEqual(await scoreHq({ answer: { hq: { city: 'Kowloon', state: 'Hong Kong', country: 'Hong Kong' } }, truth: { city: 'HONG KONG', state: null, country: 'HK' }, judge: kowloon.run }), { hqCorrect: true });
  assert.equal(kowloon.asked[0].questions.q.instructions, HQ_QUESTION);
  assert.match(HQ_QUESTION, /a district, area or neighbourhood within the city/);
  // The place is judged on the city and the country together: Hong Kong filed under CN is the same place as Hong Kong, HK.
  assert.match(HQ_QUESTION, /city and the country together/);
  assert.match(HQ_QUESTION, /territory/);
  assert.match(HQ_QUESTION, /merged into it or annexed by it/);
  assert.deepEqual([countryCode('U.S.A.'), countryCode('United Kingdom'), countryCode('gb'), countryCode('Atlantis')], ['US', 'GB', 'GB', 'atlantis']);
});

test('subsidiaries: names match once the legal form is left out, the rest are Jev\'s; recall over at most 15 listed, no list not scored', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ name: `Harbor Unit ${i} GmbH`, jurisdiction: 'Germany' }));
  const exhibit = (list, count = list.length) => ({ exhibit: 'EX-21.1', url: 'https://www.harborvalve.example/ex21.htm', count, items: list });
  const listed = exhibit(items);
  const given = [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `Harbor Unit ${i}` })),
    { name: 'Harbor Unit 12 GmbH' }, { name: 'Harbor Unit Twelve' }, { name: 'Harbor Holdings Ltd' }, { name: 'Harbor Unit 0, Inc.' },
  ];
  const j = judge({ subsidiaries: { 'Harbor Unit Twelve': 0.9 } });
  const result = await scoreSubsidiaries({ answer: { subsidiaries: given }, truth: listed, judge: j.run });
  // 13 by name, one by Jev, one not listed, and Harbor Unit 0, Inc. is Harbor Unit 0 again (its listed one is taken, so
  // it is not asked about): 14 found of 16 given.
  assert.deepEqual(result, { subsidiariesRecall: 14 / 15, subsidiariesPrecision: 14 / 16 });
  assert.deepEqual(j.asked.map((a) => a.state.subsidiary), ['Harbor Unit Twelve', 'Harbor Holdings Ltd']);
  assert.match(j.asked[0].state.listed, /^Harbor Unit 0 GmbH; Harbor Unit 1 GmbH;/);
  const short = await scoreSubsidiaries({ answer: { subsidiaries: [{ name: 'Harbor Unit 0 GmbH' }] }, truth: exhibit(items.slice(0, 3)), judge: j.run });
  assert.deepEqual(short, { subsidiariesRecall: 1 / 3, subsidiariesPrecision: 1 });
  const counted = await scoreSubsidiaries({ answer: { subsidiaries: [{ name: 'Harbor Unit 0 GmbH' }] }, truth: exhibit(items.slice(0, 3), 4), judge: j.run });
  assert.deepEqual(counted, { subsidiariesRecall: 1 / 4, subsidiariesPrecision: 1 }, 'over the exhibit\'s count when it lists more than its items');
  assert.deepEqual(await scoreSubsidiaries({ answer: { subsidiaries: given }, truth: null, judge: j.run }), { subsidiariesRecall: null, subsidiariesPrecision: null });
  assert.deepEqual(await scoreSubsidiaries({ answer: {}, truth: listed, judge: j.run }), { subsidiariesRecall: 0, subsidiariesPrecision: null });
  assert.deepEqual(await scoreSubsidiaries({ answer: { subsidiaries: given }, truth: exhibit([], 0), judge: j.run }), { subsidiariesRecall: null, subsidiariesPrecision: null });
  assert.deepEqual([entityName('Summit Ridge Software (US) Inc.'), entityName('Cedar Lane Bank, N.A.')], ['summit ridge software us', 'cedar lane bank n a']);
  // Two listed entities whose names differ only in their legal form (one per jurisdiction) are two subsidiaries, each
  // matched once.
  const twins = exhibit([{ name: 'Vale Therapeutics Limited', jurisdiction: 'India' }, { name: 'Vale Therapeutics, Inc.', jurisdiction: 'Delaware' }, { name: 'Vale Labs B.V.' }]);
  const k = judge();
  assert.deepEqual(await scoreSubsidiaries({ answer: { subsidiaries: [{ name: 'Vale Therapeutics Limited' }, { name: 'Vale Therapeutics, Inc.' }] }, truth: twins, judge: k.run }), { subsidiariesRecall: 2 / 3, subsidiariesPrecision: 1 });
  assert.deepEqual(await scoreSubsidiaries({ answer: { subsidiaries: [{ name: 'Vale Therapeutics Ltd' }, { name: 'Vale Therapeutics Inc' }, { name: 'Vale Therapeutics' }] }, truth: twins, judge: k.run }), { subsidiariesRecall: 2 / 3, subsidiariesPrecision: 2 / 3 }, 'a third of the same name has none left');
  assert.equal(k.asked.length, 0);
});

test('the report: the fiscal year against the latest annual filing, read when a cite names a PDF page of its URL; correct is every part with truth', async () => {
  const report = 'https://www.harborvalve.example/annual-report-2025.pdf';
  const company = { sic: '3561', segments: filed, hq: { city: 'PITTSBURGH', state: 'PA', country: 'US' }, latestAnnual: { form: '10-K', fy: 2025, period: '20251231', adsh: 'x' }, subsidiaries: null };
  const answer = {
    sic4: '3561', segments: [{ name: 'Water Systems', share: 0.61 }, { name: 'Industrial Flow', share: 0.39 }], hq: { city: 'Pittsburgh', country: 'US' },
    subsidiaries: [{ name: 'Harbor Valve Europe GmbH' }], annualReport: { url: report, fiscalYear: 2025 },
    cites: [
      { claim: 'hq', url: 'https://harborvalve.example/annual-report-2025.pdf#page=1', locator: 'pdf p. 1', quote: 'Headquarters: Pittsburgh.' },
      { claim: 'sic', url: 'https://elsewhere.example/', locator: 'home page', quote: 'pumps' },
    ],
  };
  const read = [{ tool: 'read_document', url: report, text: '[page 1] Headquarters: Pittsburgh, United States.' }];
  const j = judge({ cites: { 'https://harborvalve.example/annual-report-2025.pdf#page=1': 0.9 } });
  const score = await scoreV4({ answer, company, read, codes: {}, judge: j.run });
  assert.deepEqual([score.reportYearCorrect, score.reportRead, score.evidenceSupported, score.correct, score.correctOver], [true, true, 0.5, true, ['sic4', 'segments', 'hq']]);
  assert.match(j.asked.find((a) => a.label === 'score/cite').state.claim, /headquarters are in Pittsburgh, US/);
  assert.deepEqual([score.subsidiariesRecall, score.subsidiariesTruthCount], [null, null]);
  assert.deepEqual(score.segmentsTruth, [{ label: 'Water Systems', member: 'WaterSystemsMember', share: 0.61 }, { label: 'Industrial Flow', member: 'IndustrialFlowMember', share: 0.39 }]);

  const again = (patch, truth = company) => scoreV4({ answer: { ...answer, ...patch }, company: truth, read, codes: {}, judge: judge().run });
  const withExhibit = await again({}, { ...company, subsidiaries: { exhibit: 'EX-21.1', url: 'https://x.example/ex21.htm', count: 2, items: [{ name: 'Harbor Valve Europe GmbH', jurisdiction: 'Germany' }, { name: 'Harbor Flow LLC' }] } });
  assert.deepEqual([withExhibit.subsidiariesTruthCount, withExhibit.subsidiariesRecall, withExhibit.subsidiariesPrecision], [2, 0.5, 1]);
  assert.equal((await again({ annualReport: { url: report, fiscalYear: 2024 } })).reportYearCorrect, false);
  assert.equal((await again({}, { ...company, latestAnnual: null })).reportYearCorrect, null);
  assert.equal((await again({ annualReport: { url: report, fiscalYear: 2026 } })).reportYearCorrect, false, 'a year past the latest filed');
  const newer = { ...company, latestAnnual: { ...company.latestAnnual, newerPossible: true } };
  assert.deepEqual(await Promise.all([2024, 2025, 2026, 2027].map(async (fiscalYear) => (await again({ annualReport: { url: report, fiscalYear } }, newer)).reportYearCorrect)), [false, true, true, false], 'newerPossible: the next year too');
  assert.equal((await again({ cites: [{ ...answer.cites[0], locator: 'page 1' }] })).reportRead, false, 'a page of the PDF, as "pdf p. N"');
  assert.equal((await again({ cites: [{ ...answer.cites[0], url: 'https://www.harborvalve.example/investors' }] })).reportRead, false, 'on the report itself');
  assert.equal((await again({ sic4: '3562' })).correct, false);
  assert.equal((await again({ segments: [{ name: 'Water Systems', share: 1 }] })).correct, false, 'F1 2/3');
  assert.equal((await again({ hq: { city: 'Boston', country: 'US' } })).correct, false);
  // A part with no truth is left out of correct, never failed: correctOver names the parts that counted.
  const noSegments = await again({ segments: { oneSegment: true } }, { ...company, segments: [] });
  assert.deepEqual([noSegments.segmentsF1, noSegments.correct, noSegments.correctOver], [null, true, ['sic4', 'hq']]);
  const noHq = await again({ hq: { city: 'Boston', country: 'US' } }, { ...company, hq: { city: 'PITTSBURGH', state: 'PA', country: null } });
  assert.deepEqual([noHq.hqCorrect, noHq.correct, noHq.correctOver], [null, true, ['sic4', 'segments']]);
  const codeOnly = await again({ sic4: '3562' }, { ...company, segments: null, hq: null });
  assert.deepEqual([codeOnly.correct, codeOnly.correctOver], [false, ['sic4']], 'the code always counts');
  assert.deepEqual((await again({ hq: { city: 'Boston', country: 'US' } })).correctOver, ['sic4', 'segments', 'hq'], 'a wrong part with truth counts');
  const none = await scoreV4({ answer: null, company, read, codes: {}, judge: judge().run });
  assert.deepEqual([none.sic4Answer, none.sicCorrect4, none.segmentsF1, none.hqCorrect, none.reportYearCorrect, none.reportRead, none.evidenceSupported, none.correct, none.correctOver], [null, false, 0, false, false, false, null, false, ['sic4', 'segments', 'hq']]);
});

// A report as read_document returns it: "[page N]" blocks.
const pages = (from, to, text = (n) => `Filler text of page ${n}. `.repeat(40)) => Array.from({ length: to - from + 1 }, (_, i) => `[page ${from + i}]\n${text(from + i)}`).join('\n');

test('a document read again by its local copy is the document it was first read from: its pages count at its URL', () => {
  const url = 'https://cdn.example/files/annual-report-2025.pdf';
  const path = 'documents/ef03c7b59fd15bd6.pdf';
  const read = textsRead([
    { tool: 'read_document', args: { url, find: 'Segment Disclosures' }, value: { ok: true, source: url, url, path, sha256: 'ef03', kind: 'pdf', text: '[page 181]\nNote 37 Segment Disclosures', looks: [] } },
    { tool: 'read_document', args: { path, pages: [194] }, value: { ok: true, source: path, path, sha256: 'ef03', kind: 'pdf', text: '[page 194]\nTransAlta is headquartered in Calgary, Alberta.', looks: [] } },
    { tool: 'read_document', args: { path: 'documents/other.pdf', pages: [1] }, value: { ok: true, source: 'documents/other.pdf', path: 'documents/other.pdf', sha256: 'aa11', kind: 'pdf', text: '[page 1]\nAnother document.', looks: [] } },
  ]);
  assert.deepEqual(read.filter((r) => r.url === url).map((r) => r.text), ['[page 181]\nNote 37 Segment Disclosures', '[page 194]\nTransAlta is headquartered in Calgary, Alberta.']);
  assert.deepEqual(read.filter((r) => r.url === 'documents/other.pdf').length, 1);
  assert.ok(!read.some((r) => r.url === url && /Another document/.test(r.text)), 'another sha256 is another document');
});

test('a cite on "pdf p. N" is judged on that page and its neighbours as read, however far into the report it is', async () => {
  const url = 'https://www.harborvalve.example/annual-report-2025.pdf';
  const quote = 'Harbor Valve Works is headquartered in Pittsburgh, Pennsylvania.';
  // 60 pages of about a thousand characters each, then the cited page: far past what one request holds.
  const read = [{ tool: 'read_document', url, text: pages(1, 60) }, { tool: 'read_document', url, text: `[page 61]\n${quote}\n[page 62]\nThe next page.` }];
  const answer = { sic4: '3561', hq: { city: 'Pittsburgh', country: 'US' }, cites: [{ claim: 'hq', url, locator: 'pdf p. 61 (cover page)', quote }, { claim: 'report', url, locator: 'cover page', quote: 'Annual report' }] };
  const j = judge({ cites: { [url]: 0.9 } });
  await scoreCites({ answer, read, judge: j.run });
  const [onPage, unpaged] = j.asked.map((a) => a.state.text);
  // Each cite is asked whether its quote is on that page and supports at least part of the claim of its kind.
  assert.ok(j.asked.every((a) => a.questions.q.instructions === CITE_QUESTION_V4));
  assert.match(CITE_QUESTION_V4, /on that page/);
  assert.match(CITE_QUESTION_V4, /at least part of `claim`/);
  assert.match(onPage, /headquartered in Pittsburgh/);
  assert.match(onPage, /^\[page 60\]/, 'the page before it too');
  assert.match(onPage, /\[page 62\]\nThe next page\./);
  assert.doesNotMatch(onPage, /\[page 59\]/);
  assert.ok(unpaged.length <= 24_000 && /^\[page 1\]/.test(unpaged), 'no page named: what was read, from the start, cut at the request\'s size');
});

// ---- the agent home ------------------------------------------------------------------------------------------------------

test('the v4 home: the workflows skill and the learning rules as v2 has them, the job text and classify skill for six parts, no company named', () => {
  const v2 = join(import.meta.dirname, 'agent-v2');
  const v4 = join(import.meta.dirname, 'agent-v4');
  const text = (dir, ...file) => readFileSync(join(dir, ...file), 'utf8');
  assert.equal(text(v4, 'skills', 'workflows', 'SKILL.md'), text(v2, 'skills', 'workflows', 'SKILL.md'));
  const definition = JSON.parse(text(v4, 'agent.json'));
  assert.deepEqual(definition.skills, ['classify', 'workflows']);
  assert.deepEqual(definition.tools, JSON.parse(text(v2, 'agent.json')).tools);
  const after = (body, heading) => body.slice(body.indexOf(heading));
  const shape = /`\{ "sic4", .*\}`/;
  // v2's learning rules hold in v4 line for line (the answer's shape aside); v4 adds how classify-company is composed.
  const v4Rules = after(text(v4, 'AGENTS.md'), '## Every run').replace(shape, '');
  for (const line of after(text(v2, 'AGENTS.md'), '## Every run').replace(shape, '').split('\n')) assert.ok(v4Rules.includes(line), line);
  for (const words of [/embed it as a `workflow` step, a complete inline child/, /cover the parts no workflow covers/, /a revised part does not\s+reach `classify-company` until then/]) assert.match(v4Rules, words);
  // classify-company takes the job's input as given, a website or none.
  for (const words of [/takes the job's input as given and must work when the website is absent/, /requires only `name`/, /a route by its `valuePath`/]) assert.match(v4Rules, words);
  assert.match(text(v4, 'AGENTS.md'), /`\{ "sic4", "segments", "hq", "subsidiaries", "annualReport", "cites" \}`, the answer's own shape/);
  const parameters = Object.keys(answerV4({}).parameters.properties);
  assert.deepEqual(parameters, ['sic4', 'segments', 'hq', 'subsidiaries', 'annualReport', 'cites']);
  const job = `${text(v4, 'AGENTS.md')}\n${text(v4, 'skills', 'classify', 'SKILL.md')}`;
  for (const words of [/Exhibit 21/, /Exhibit 8/, /read_document/, /pdf p\. N/, /principal executive offices/, /every reportable (operating )?segment/i]) assert.match(job, words);
  // The segment table is looked at (vision) on its page, and a page with no text is looked at, not skipped.
  for (const words of [/`pages: \[N\]`/, /`question: "the segment\s+revenue table as laid out"`/, /no text \(a scan or a chart\) is not skipped/]) assert.match(job, words);
  const fixtures = [...readJson(join(FIXTURES_V4, 'companies-v4.json')), ...readJson(join(FIXTURES_V2, 'companies-v2.json'))];
  for (const c of fixtures) for (const word of [c.name.split(' ')[0], c.ticker]) assert.doesNotMatch(job, new RegExp(`\\b${word}\\b`), word);
});

// ---- scripted passes -----------------------------------------------------------------------------------------------------

const V4_FIELDS = ['dispatched', 'correctOver', 'segmentsAnswer', 'segmentsTruth', 'segmentsShareSum', 'segmentsF1', 'shareErrorMean', 'hqAnswer', 'hqTruth', 'hqCorrect', 'subsidiariesAnswer', 'subsidiariesTruthCount',
  'subsidiariesRecall', 'subsidiariesPrecision', 'reportAnswer', 'reportTruth', 'reportYearCorrect', 'reportRead'];
const V3_FIELDS = ['company', 'ticker', 'born', 'rewritten', 'executions', 'workflowShare', 'agentFallback', 'scoreCostUsd'];
const V2_TOOL_FIELDS = ['set', 'categories', 'websiteGiven', 'sic4Answer', 'sic4Truth', 'sicCorrect4', 'sicCorrect2', 'evidenceSupported', 'toolCalls', 'browserMinutes', 'visionPages', 'browserCostUsd'];

test('a scripted v4 pass: by hand, then the whole-job workflow on site and report, every v4 field beside v3\'s', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.v4 });
  const asked = [];
  const judgeOf = parts.judge;
  parts.judge = () => { const j = judgeOf(); return async (params) => { if (params.label?.startsWith('score/')) asked.push(params.label); return j(params); }; };
  const { rows } = await runLoop({ out, parts, jobs: 4, record: false });
  assert.equal(rows.length, 4);
  for (const row of rows) for (const field of [...V2_TOOL_FIELDS, ...V3_FIELDS, ...V4_FIELDS]) assert.ok(field in row, `${field} in run ${row.run}`);
  for (const row of rows) for (const field of ['segmentAnswer', 'segmentTruth', 'segmentCorrect', 'shareError']) assert.ok(!(field in row), `v2's ${field} is not a v4 field`);
  assert.deepEqual(rows.map((r) => r.set), ['v4', 'v4', 'v4', 'v4']);
  assert.deepEqual(rows.map((r) => [r.sic4Answer, r.sicCorrect4]), [['3561', true], ['5411', true], ['7372', true], ['5812', true]]);
  // Bluefin reports one segment and answered so; Summit's "Cloud Software" is the filed "Cloud" by Jev; Lantern Hall has no segment truth.
  assert.deepEqual(rows.map((r) => r.segmentsF1), [1, 1, 1, null]);
  assert.deepEqual(rows.map((r) => r.hqCorrect), [true, true, true, true]);
  assert.deepEqual(rows.map((r) => [r.subsidiariesTruthCount, r.subsidiariesRecall, r.subsidiariesPrecision]), [[3, 1, 1], [null, null, null], [2, 1, 1], [1, 1, 1]]);
  assert.deepEqual(rows.map((r) => [r.reportYearCorrect, r.reportRead]), [[true, true], [true, true], [true, true], [true, true]]);
  assert.ok(rows.every((r) => r.evidenceSupported === 1), JSON.stringify(rows.map((r) => r.evidenceSupported)));
  assert.deepEqual(rows.map((r) => r.correct), [true, true, true, true]);
  assert.deepEqual(rows.map((r) => r.correctOver), [['sic4', 'segments', 'hq'], ['sic4', 'segments', 'hq'], ['sic4', 'segments', 'hq'], ['sic4', 'hq']], 'run 4: no segment truth, left out');
  assert.equal(asked.filter((l) => l === 'score/segments').length, 1, 'only Summit\'s segment needed Jev');
  assert.equal(asked.filter((l) => l === 'score/hq' || l === 'score/subsidiary').length, 0);

  assert.deepEqual(rows.map((r) => r.byWorkflow), [false, false, true, true]);
  assert.deepEqual(rows.map((r) => r.dispatched), [false, false, false, false], 'a workflow on trial runs through the agent');
  assert.deepEqual(rows[0].workflowsSaved, [WORKFLOW]);
  assert.deepEqual(rows[0].born.map((b) => b.name), [WORKFLOW]);
  // By hand the report is read twice: find the segment note, then a look at its page with a question (vision).
  assert.deepEqual(rows[1].toolCalls, { search: 1, browse: 1, fetch: 0, read_document: 2 });
  assert.deepEqual(rows.map((r) => r.visionPages), [1, 1, 1, 1]);
  const reads = parts.fakeCalls.filter((c) => c.tool === 'read_document');
  assert.deepEqual(reads.slice(0, 2).map((c) => [Boolean(c.find), c.pages ?? null, Boolean(c.question)]), [[true, null, false], [false, [4], true]], 'find, then look at the page it found');
  assert.deepEqual(rows[2].toolCalls, { search: 0, browse: 0, fetch: 1, read_document: 1 }, 'the workflow read the site and the report through its call nodes');
  for (const r of rows.slice(2)) {
    assert.deepEqual(r.executions.map((e) => [e.name, e.outcome, e.toolCalls]), [[WORKFLOW, 'complete', 4]], 'fetch_page, sic2_groups, sic_codes, read_document');
    assert.deepEqual([r.workflowShare, r.agentFallback], [1, false]);
  }
  assert.deepEqual(readRows(join(out, 'runs.jsonl')), rows);

  const html = renderCurve({ rows });
  assert.match(html, /headline: code, segments and HQ/);
  assert.match(html, /<div class="k">headquarters<\/div><div class="v">4 of 4/);
  assert.match(html, /<div class="k">segments, F1 0\.8\+<\/div><div class="v">3 of 3/);
}, { timeout: 180_000 });

test('a v4 sealed pass scores the sealed companies at a commit, and rerow backfills a v4 pass from companies-v4.json', async (t) => {
  const out = join(await scratch(t), 'out');
  const { rows } = await runLoop({ out, parts: scriptedParts({ set: SETS.v4 }), jobs: 2 });
  const sealed = await runSealed({ out, parts: scriptedParts({ set: SETS.v4 }), at: 'seed' });
  const companies = readJson(join(FIXTURES_V4, 'companies-v4.json')).filter((c) => c.split === 'sealed');
  assert.deepEqual(sealed.rows.map((r) => [r.set, r.split, r.phase, r.company, r.correct]), companies.map((c) => ['v4', 'sealed', 'before', c.name, true]));
  assert.deepEqual([sealed.rows[0].segmentsTruth, sealed.rows[0].segmentsF1], [{ oneSegment: true }, 1], 'a one-segment filer, its one segment named');
  assert.ok(sealed.rows.every((r) => V4_FIELDS.every((f) => f in r)));
  assert.equal(sealed.rows[1].subsidiariesRecall, null, 'a 40-F filer with no exhibit list');
  await assert.rejects(runLoop({ out, parts: scriptedParts({ set: SETS.v2 }), jobs: 1 }), /holds a v4 pass; a v2 pass needs its own --out/);

  const written = await rerow({ out, data: FIXTURES_V4 });
  assert.equal(written.runs, 2);
  const v3 = readRows(join(out, 'runs.v3.jsonl'));
  assert.deepEqual(v3.map((r) => [r.company, r.ticker, r.born, r.executions, r.workflowShare, r.agentFallback]), rows.map((r) => [r.company, r.ticker, r.born, r.executions, r.workflowShare, r.agentFallback]));
}, { timeout: 240_000 });

test('the host dispatches a promoted v4 workflow: its output passes the v4 answer and is the run\'s; a company without a website goes to the agent', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  // CLASSIFY_WORKFLOW_V4 on main, promoted: its live revision active.
  const store = join(root, 'store');
  await mkdir(store, { recursive: true });
  const saved = await new WorkflowStore(store).save(WORKFLOW, CLASSIFY_WORKFLOW_V4);
  const trial = { name: WORKFLOW, status: 'active', when: [], revisions: [{ sha256: saved.digest, status: 'active', since: '2026-10-20T00:00:00.000Z', run: 'run-000', after: 0 }], uses: [] };
  const commit = await repo.commitTo('main', {
    files: {
      [`.pi/agentrun/workflows/${WORKFLOW}/${saved.digest}.json`]: await readFile(join(store, '.pi/agentrun/workflows', WORKFLOW, `${saved.digest}.json`), 'utf8'),
      [`.pi/agentrun/workflows/${WORKFLOW}/latest`]: `${saved.digest}\n`,
      [skillPath(WORKFLOW)]: renderSkill(WORKFLOW, 'Use it for any company whose website is given.'),
      [trialPath(WORKFLOW)]: renderTrial(trial),
    },
    message: 'test: classify-company promoted',
  });
  await repo.push(commit.sha, 'main');

  const { rows } = await runLoop({ out, parts: scriptedParts({ set: SETS.v4 }), jobs: 2, record: false });
  assert.deepEqual(rows.map((r) => r.dispatched), [true, false]);
  // Harbor Valve: the host's run answered, with no root-agent call and no tool call of the agent's own.
  assert.deepEqual([rows[0].byWorkflow, rows[0].correct, rows[0].correctOver], [true, true, ['sic4', 'segments', 'hq']]);
  assert.deepEqual(rows[0].workflowsUsed.map((u) => [u.name, u.outcome, u.classifiedBy ?? null]), [[WORKFLOW, 'complete', HOST_WORKFLOW]]);
  assert.deepEqual([rows[0].reportRead, rows[0].evidenceSupported, rows[0].subsidiariesRecall], [true, 1, 1]);
  assert.deepEqual(rows[0].toolCalls, { search: 0, browse: 0, fetch: 1, read_document: 1 }, 'the workflow\'s call nodes');
  assert.deepEqual([rows[0].workflowShare, rows[0].agentFallback], [1, null]);
  // Bluefin has no website: the workflow's input schema refuses its input, so the host does not run it, and the agent does
  // the job by hand.
  assert.deepEqual([rows[1].byWorkflow, rows[1].correct], [false, true]);
  assert.deepEqual(rows[1].toolCalls, { search: 1, browse: 1, fetch: 0, read_document: 2 });
  // No dispatch and no use: nothing in the row or the uses file counts against the promoted workflow.
  assert.deepEqual(['dispatch' in rows[1], rows[1].workflowsUsed], [false, []]);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'progress', 'run-002.json'), 'utf8')).finished.uses, []);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'progress', 'run-001.json'), 'utf8')).finished.uses.map((u) => [u.name, u.outcome]), [[WORKFLOW, 'frozen']]);
}, { timeout: 180_000 });

test('composition: the parts are admitted, then classify-company embedding them, promoted after three clean uses, then the host runs it, with a website given or not', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.v4 });
  const truth = readJson(join(FIXTURES_V4, 'answers.json'));
  // The six companies with a website, then one without (Bluefin), after classify-company is promoted.
  parts.companies = [...parts.companies.filter((c) => c.website), { ...parts.companies.find((c) => c.split === 'run' && !c.website), order: 99 }];
  parts.modelFor = (job, run) => scriptedModel(agentScriptV4Compose({ job, offered: run.workflows.loaded.map((w) => w.name), fixtures: { truth } }));
  const { rows } = await runLoop({ out, parts, jobs: 7, record: false });
  const names = [PART_CODE.name, PART_FIND_REPORT.name];
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.correct), JSON.stringify(rows.map((r) => [r.company, r.correctOver])));
  // Run 1 by hand saves the two parts; run 2, offered both, composes classify-company from them.
  assert.deepEqual([...rows[0].curate.admitted].sort(), names);
  assert.deepEqual(rows[1].workflowsOffered.slice().sort(), names);
  assert.deepEqual(rows[1].curate.admitted, [WORKFLOW]);
  // Runs 3 to 5 run it on trial through the agent; the third clean use promotes it; run 6 the host runs it, no agent.
  // Run 7 has no website: the host runs it all the same, and it finds the site first.
  assert.deepEqual(rows.map((r) => [r.byWorkflow, r.dispatched]), [[false, false], [false, false], [true, false], [true, false], [true, false], [true, true], [true, true]]);
  assert.deepEqual(rows.map((r) => r.curate.promoted), [[], [], [], [], [WORKFLOW], [], []]);
  for (const r of rows.slice(5)) assert.deepEqual(r.workflowsUsed.map((u) => [u.name, u.outcome, u.classifiedBy ?? null]), [[WORKFLOW, 'complete', HOST_WORKFLOW]]);
  assert.equal(rows[6].websiteGiven, false);
  // As saved, classify-company embeds both parts whole, as workflow steps.
  const revision = rows[1].born.find((b) => b.name === WORKFLOW).revision;
  const record = JSON.parse(execFileSync('git', ['--git-dir', join(out, 'agent.git'), 'show', `main:.pi/agentrun/workflows/${WORKFLOW}/${revision}.json`], { encoding: 'utf8' }));
  const document = record.workflow ?? record;
  const children = document.root.steps.filter((step) => step.node === 'workflow');
  assert.deepEqual(children.map((c) => c.workflow.name), names);
  assert.deepEqual(children.map((c) => c.workflow), [PART_CODE, PART_FIND_REPORT].map((w) => JSON.parse(JSON.stringify(w))));
  // It takes the job's input as given: only the name is required.
  assert.deepEqual(document.schemas[document.input.schemaId].required, ['name']);
  // The host's runs: the site (read once to start, once in each part), the groups, the codes, the report; without a
  // website, a search for the site first.
  assert.deepEqual(rows.slice(5).map((r) => r.executions.map((e) => [e.name, e.outcome, e.toolCalls])), [[[WORKFLOW, 'complete', 6]], [[WORKFLOW, 'complete', 7]]]);
  assert.deepEqual(rows.slice(5).map((r) => r.toolCalls), [{ search: 0, browse: 0, fetch: 3, read_document: 1 }, { search: 1, browse: 0, fetch: 3, read_document: 1 }]);
}, { timeout: 300_000 });

test('rescore scores a finished v4 pass again from its own files against a truth set, beside runs.jsonl, never over it', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const parts = scriptedParts({ set: SETS.v4 });
  const { rows } = await runLoop({ out, parts, jobs: 2, record: false });
  const runs = readFileSync(join(out, 'runs.jsonl'));
  // The truth moves on: Harbor Valve's headquarters, as its latest cover gives them, are now Boston.
  const data = join(root, 'data');
  await cp(FIXTURES_V4, data, { recursive: true });
  const companies = readJson(join(data, 'companies-v4.json'));
  companies[0].hq = { city: 'BOSTON', state: 'MA', country: 'US' };
  await writeFile(join(data, 'companies-v4.json'), JSON.stringify(companies));
  const { before, after } = await rescore({ out, data, judge: parts.judge() });
  assert.deepEqual(readFileSync(join(out, 'runs.jsonl')), runs, 'runs.jsonl is never rewritten');
  assert.deepEqual(before, rows);
  assert.deepEqual(readRows(join(out, 'runs.rescored.jsonl')), after);
  assert.deepEqual(after.map((r) => [r.hqTruth.city, r.hqCorrect, r.correct]), [['BOSTON', false, false], ['SEATTLE', true, true]]);
  // Every other field as it was, the score aside.
  const { hqTruth, hqCorrect, correct, scoreCostUsd, ...rest } = after[1];
  const { hqTruth: h, hqCorrect: c, correct: k, scoreCostUsd: s, ...was } = rows[1];
  assert.deepEqual(rest, was);
}, { timeout: 180_000 });
