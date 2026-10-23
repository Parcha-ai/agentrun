// The MCC scorer on synthetic rows: exact code, ISO 18245 group with Visa's T&E folds, risk tier and its ordinal
// distance, a field the teacher lacks left out of the n, the reported-only fields, and the per-vertical summary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { genericOf, groupOf, labelsOf, loadGroups, loadStage1Labels, mccOf, riskOf, sameGroup, scoreMcc, summarizeMcc } from './score-mcc.mjs';

const groups = loadGroups();
const merchant = (teacher, vertical = 'nutra') => ({ merchantId: 'm1', name: 'A Shop', website: 'https://shop.example', vertical, teacher });

test('an MCC is four digits: a short code or a whole number is zero-padded, anything else is no code', () => {
  assert.equal(mccOf('5999'), '5999');
  assert.equal(mccOf(742), '0742');
  assert.equal(mccOf(' 742 '), '0742');
  for (const bad of ['MCC 5999', '59999', '59.9', '', null, undefined, 5999.5, -1, 10_000, ['5999']]) assert.equal(mccOf(bad), null, String(bad));
});

test('a risk tier is low, medium or high in any case; anything else is none', () => {
  assert.equal(riskOf(' High '), 'high');
  for (const bad of ['very high', 'elevated', '', null, 2]) assert.equal(riskOf(bad), null, String(bad));
});

test('the group table holds the 13 ISO 18245 ranges end to end, its sources cited, and the sample codes in their groups', () => {
  assert.equal(groups.groups.length, 13);
  assert.equal(groups.groups[0].code, '0001-1499');
  assert.equal(groups.groups.at(-1).to, '9999');
  for (const [i, g] of groups.groups.entries()) {
    assert.equal(g.code, `${g.from}-${g.to}`);
    if (i) assert.equal(Number(g.from), Number(groups.groups[i - 1].to) + 1, `${g.id} starts where the last range ends`);
  }
  for (const doc of [groups.source.ranges, groups.source.codes]) {
    assert.match(doc.url, /^https:\/\//);
    assert.match(doc.sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(groups.checks.listedOutsideTheirRange, [], 'every code the range reference lists sits inside its own table\'s range');
  for (const s of groups.checks.sample) {
    assert.equal(groups.codes[s.code], s.visa, `${s.code} is in the code table under Visa's title`);
    if (s.citiTable) assert.equal(groupOf(s.code, groups), groups.groups.find((g) => g.name === s.citiTable).id, `${s.code} is in the group Citi lists it under`);
  }
  const expected = { '0742': 'agricultural-services', '1520': 'contracted-services', '3000': 'airlines', '3351': 'car-rental', '3501': 'lodging', '4111': 'transportation-services', '4900': 'utility-services', '5411': 'retail-outlet-services', '5651': 'clothing-stores', '5812': 'miscellaneous-stores', '7311': 'business-services', '8011': 'professional-services-and-membership-organizations', '9311': 'government-services' };
  for (const [code, group] of Object.entries(expected)) assert.equal(groupOf(code, groups), group, code);
});

test('the code table: four-digit keys in code order, every code in some group, the Mastercard-only codes included', () => {
  const codes = Object.keys(groups.codes);
  assert.ok(codes.length > 900);
  assert.ok(codes.every((c) => /^\d{4}$/.test(c) && typeof groups.codes[c] === 'string' && groups.codes[c].length));
  assert.ok(codes.every((c) => groupOf(c, groups) !== null));
  for (const c of groups.mastercardOnly) assert.ok(groups.codes[c], c);
  assert.equal(groups.codes['5921'], 'Package Stores – Beer, Wine, and Liquor', 'the code Visa printed under 5912 a second time');
});

test('a code Visa lists as an airline above 3299 is an airline, not car rental, and a generic T&E code matches its block', () => {
  assert.equal(groupOf('3301', groups), 'airlines');
  assert.equal(groupOf('3351', groups), 'car-rental');
  assert.ok(sameGroup('3000', '4511', groups), 'United\'s own code and the generic airline code are both an airline');
  assert.ok(sameGroup('7011', '3501', groups));
  assert.ok(sameGroup('3357', '7512', groups));
  assert.ok(sameGroup('4511', '4111', groups), 'the generic airline code keeps its own range too');
  assert.equal(sameGroup('3000', '4111', groups), false, 'a merchant-specific airline code is not commuter transport');
  assert.equal(sameGroup('3000', '7011', groups), false);
  assert.equal(sameGroup(null, '5999', groups), false);
});

test('one answer: exact code, group, tier and distance, each right or wrong; correct is the exact code', () => {
  const answer = { mcc: '5999', mccDescription: 'Miscellaneous and Specialty Retail Shops', riskTier: 'medium', flags: ['subscription', 'nutraceuticals'], siteStatus: 'live', confidence: 0.7 };
  const right = scoreMcc({ answer, merchant: merchant({ mcc: '5999', riskTier: 'Medium', flags: ['nutraceuticals'] }), groups });
  assert.deepEqual(right, {
    against: 'teacher', mccAnswer: '5999', mccTeacher: '5999', mccCorrect: true, brandMapped: false, mccKnown: true,
    mccGroupAnswer: 'miscellaneous-stores', mccGroupTeacher: 'miscellaneous-stores', mccGroupCorrect: true,
    riskAnswer: 'medium', riskTeacher: 'medium', riskCorrect: true, riskDistance: 0,
    flagsAnswer: ['nutraceuticals', 'subscription'], flagsTeacher: ['nutraceuticals'], flagsJaccard: 0.5,
    siteStatus: 'live', confidence: 0.7, correct: true,
  });
  const groupOnly = scoreMcc({ answer: { mcc: '5969', riskTier: 'low' }, merchant: merchant({ mcc: '5999', riskTier: 'high' }), groups });
  assert.deepEqual([groupOnly.mccCorrect, groupOnly.mccGroupCorrect, groupOnly.riskCorrect, groupOnly.riskDistance, groupOnly.correct], [false, true, false, 2, false]);
  const offGroup = scoreMcc({ answer: { mcc: '5411', riskTier: 'high' }, merchant: merchant({ mcc: 5812, riskTier: 'medium' }), groups });
  assert.deepEqual([offGroup.mccTeacher, offGroup.mccGroupCorrect, offGroup.riskDistance], ['5812', false, 1]);
  assert.equal(scoreMcc({ answer: { mcc: '5999' }, merchant: merchant({ mcc: '5999' }) }).mccCorrect, true, 'the shipped table when none is passed');
});

test('a T&E brand code counts as its block\'s generic code in the exact match, on both sides, and the row says so', () => {
  assert.deepEqual(['3502', '3543', '3504', '3066', '3722', '3301', '3357', '4511', '7011', '5812'].map((c) => genericOf(c, groups)), ['7011', '7011', '7011', '4511', '7011', '4511', '7512', '4511', '7011', '5812']);
  const exact = (answer, teacher) => scoreMcc({ answer: { mcc: answer }, merchant: merchant({ mcc: teacher }), groups });
  assert.deepEqual([exact('7011', '3504').mccCorrect, exact('7011', '3504').brandMapped], [true, true], 'the run is offered 7011, never Hilton\'s 3504');
  assert.deepEqual([exact('4511', '3066').mccCorrect, exact('7512', '3357').mccCorrect, exact('3502', '3722').mccCorrect], [true, true, true]);
  assert.deepEqual([exact('5812', '3502').mccCorrect, exact('5812', '3502').brandMapped], [false, true]);
  assert.deepEqual([exact('4511', '4111').mccCorrect, exact('4511', '4111').brandMapped], [false, false], 'a generic code is not a brand code');
  assert.deepEqual([exact('5999', '5999').brandMapped, exact(null, '3504').brandMapped], [false, true]);
});

test('a teacher with no risk (the swarm\'s risk stage not run) scores the code only: risk is null, never wrong, out of the n', () => {
  const r = scoreMcc({ answer: { mcc: '5999', riskTier: 'high' }, merchant: merchant({ mcc: '5999', riskTier: null }), groups });
  assert.deepEqual([r.riskCorrect, r.riskDistance, r.riskAnswer, r.correct], [null, null, 'high', true]);
  const s = summarizeMcc([r, scoreMcc({ answer: { mcc: '5411', riskTier: 'low' }, merchant: merchant({ mcc: '5999' }), groups })]);
  assert.deepEqual(s.overall.riskCorrect, { k: 0, n: 0, rate: null });
  assert.deepEqual(s.overall.mccCorrect, { k: 1, n: 2, rate: 0.5 });
});

test('no answer is wrong on every field the teacher has; no teacher block scores nothing', () => {
  const none = scoreMcc({ answer: null, merchant: merchant({ mcc: '5999', riskTier: 'low' }), groups });
  assert.deepEqual([none.mccCorrect, none.mccGroupCorrect, none.riskCorrect, none.riskDistance, none.mccKnown, none.correct], [false, false, false, null, false, false]);
  assert.throws(() => scoreMcc({ answer: { mcc: '5999', risk: 'low' }, teacher: { mcc: '5999' }, table: groups }), /takes \{ answer, merchant, groups \}/, 'the first call shape fails loudly');
  const unlabelled = scoreMcc({ answer: { mcc: '5999', riskTier: 'low' }, merchant: { merchantId: 'm2' }, groups });
  assert.deepEqual([unlabelled.mccCorrect, unlabelled.mccGroupCorrect, unlabelled.riskCorrect, unlabelled.correct], [null, null, null, null]);
});

test('an unlisted code can still agree with the teacher exactly; mccKnown only reports it', () => {
  const r = scoreMcc({ answer: { mcc: '5961' }, merchant: merchant({ mcc: '5961' }), groups });
  assert.equal(r.mccCorrect, true);
  assert.equal(r.mccKnown, false, 'Visa no longer lists 5961 and Citi gives it to TSYS alone');
  assert.equal(scoreMcc({ answer: { mcc: '6538' }, merchant: merchant({ mcc: '6538' }), groups }).mccKnown, true, 'a Mastercard-only code is known');
});

test('the summary counts each field over the rows that score it, per vertical, with the teacher group share, Brier and cost', () => {
  const row = (vertical, answer, teacher, costUsd) => ({ ...scoreMcc({ answer, merchant: merchant(teacher, vertical), groups }), vertical, ...(costUsd === undefined ? {} : { costUsd }) });
  const rows = [
    row('nutra', { mcc: '5499', riskTier: 'high', confidence: 0.9 }, { mcc: '5499', riskTier: 'high' }, 0.4),
    row('nutra', { mcc: '5912', riskTier: 'medium', confidence: 0.5 }, { mcc: '5499', riskTier: 'high' }, 0.6),
    row('travel', { mcc: '4511', riskTier: 'medium' }, { mcc: '3000', riskTier: 'medium' }),
    row('travel', { mcc: '4722', riskTier: 'low' }, { mcc: '4722' }, 0.2),
  ];
  const s = summarizeMcc(rows);
  assert.equal(s.against, 'teacher');
  assert.deepEqual(s.overall.mccCorrect, { k: 3, n: 4, rate: 0.75 }, '4511 against United\'s 3000 is exact once the brand code is mapped');
  assert.equal(s.overall.brandMapped, 1);
  assert.equal(s.byVertical.travel.brandMapped, 1);
  assert.deepEqual(s.overall.mccGroupCorrect, { k: 3, n: 4, rate: 0.75 }, '5912 vs 5499 is another group; 4511 vs 3000 is an airline either way');
  assert.deepEqual(s.overall.riskCorrect, { k: 2, n: 3, rate: 2 / 3 });
  assert.deepEqual(s.byVertical.nutra.mccCorrect, { k: 1, n: 2, rate: 0.5 });
  assert.equal(s.byVertical.travel.riskCorrect.n, 1);
  assert.equal(s.overall.riskDistanceMean, 1 / 3);
  assert.equal(s.overall.riskOffByTwo, 0);
  assert.ok(Math.abs(s.overall.brierVsTeacher - (0.01 + 0.25) / 2) < 1e-12);
  assert.ok(Math.abs(s.overall.costPerJobUsd - 0.4) < 1e-12);
  assert.equal(s.overall.costUnknown, 1);
  assert.deepEqual(s.teacherGroupShare, { 'retail-outlet-services': 0.5, airlines: 0.25, 'transportation-services': 0.25 });
  const seed = { ...scoreMcc({ answer: { mcc: '5999' }, merchant: merchant({ mcc: '5999', riskTier: null, flags: null }, null), groups }), vertical: null, stratum: 'seed' };
  assert.deepEqual(Object.keys(summarizeMcc([seed]).byVertical), ['seed'], 'a seed merchant is counted under its stratum, not as unknown');
  assert.equal(seed.flagsJaccard, null, 'the swarm gives its flags as prose, so there is no list to compare');
});

// Proposal C: the stage-1 teacher. The truth per merchant is the adjudicator's stage-1 MCC and its allowed tiers; a
// merchant with no label falls back to the swarm teacher on the code alone.
const judged = (merchant, mcc, allowedTiers) => ({ merchant, mcc, allowedTiers, unjudgeable: false, reason: null });
const LABEL_LINES = [
  judged('m1', '5712', ['low']),
  judged('m2', '5499', ['medium', 'high']),
  judged('m3', '3504', ['medium']),
  { merchant: 'm4', mcc: null, allowedTiers: null, unjudgeable: true, reason: 'the site is behind a bot wall' },
];
const labels = labelsOf(LABEL_LINES);
const row = (merchantId, teacher) => ({ merchantId, name: `${merchantId} shop`, website: `https://${merchantId}.example`, stratum: 'nutra', teacher });

test('stage-1 labels: the code and the allowed tiers per merchant, an unjudgeable one kept as such, a bad line refused', () => {
  assert.deepEqual(labels, { m1: { mcc: '5712', allowedTiers: ['low'] }, m2: { mcc: '5499', allowedTiers: ['medium', 'high'] }, m3: { mcc: '3504', allowedTiers: ['medium'] }, m4: { unjudgeable: 'the site is behind a bot wall' } });
  assert.throws(() => labelsOf([LABEL_LINES[0], LABEL_LINES[0]]), /m1 is labelled twice/);
  assert.throws(() => labelsOf([judged('x', '12', ['low'])]), /x: the label's code/);
  assert.throws(() => labelsOf([judged('x', 5999, ['low'])]), /x: the label's code/, 'the pinned file writes the code as a string');
  assert.throws(() => labelsOf([judged('x', '5999', ['low', 'high'])]), /x: the label's tiers/);
  assert.throws(() => labelsOf([judged('x', '5999', [])]), /x: the label's tiers/);
  assert.throws(() => labelsOf([{ ...judged('x', '5999', ['low']), unjudgeable: 'no' }]), /x: unjudgeable must be true or false/);
  assert.throws(() => labelsOf([{ merchantId: 'x', mcc: '5999', allowedTiers: ['low'], unjudgeable: false }]), /needs its merchant/);
  assert.deepEqual(labelsOf([judged('y', '5499', ['high', 'medium'])]), { y: { mcc: '5499', allowedTiers: ['medium', 'high'] } }, 'tiers in rubric order');
});

test('C: a right code with an allowed tier is right; a right code with a disallowed tier is WRONG', () => {
  const right = scoreMcc({ answer: { mcc: '5712', riskTier: 'low' }, merchant: row('m1', { mcc: '5719' }), groups, labels });
  assert.deepEqual([right.against, right.mccTeacher, right.mccCorrect, right.riskTeacher, right.riskCorrect, right.riskDistance, right.correct], ['stage1', '5712', true, ['low'], true, 0, true]);
  const wrongTier = scoreMcc({ answer: { mcc: '5712', riskTier: 'high' }, merchant: row('m1', { mcc: '5712' }), groups, labels });
  assert.deepEqual([wrongTier.mccCorrect, wrongTier.riskCorrect, wrongTier.riskDistance, wrongTier.correct], [true, false, 2, false]);
  const either = scoreMcc({ answer: { mcc: '5499', riskTier: 'high' }, merchant: row('m2', { mcc: '5499' }), groups, labels });
  assert.deepEqual([either.riskCorrect, either.correct], [true, true], 'either allowed tier is right');
  const below = scoreMcc({ answer: { mcc: '5499', riskTier: 'low' }, merchant: row('m2', { mcc: '5499' }), groups, labels });
  assert.deepEqual([below.riskCorrect, below.riskDistance, below.correct], [false, 1, false], 'the distance is to the nearest allowed tier');
  const wrongCode = scoreMcc({ answer: { mcc: '5719', riskTier: 'low' }, merchant: row('m1', { mcc: '5719' }), groups, labels });
  assert.deepEqual([wrongCode.mccCorrect, wrongCode.riskCorrect, wrongCode.correct, wrongCode.mccSwarm, wrongCode.mccSwarmCorrect], [false, true, false, '5719', true], 'the swarm\'s code is reported beside and decides nothing');
});

test('C: the T&E brand rule holds against the stage-1 code; no answer is wrong on both parts', () => {
  const brand = scoreMcc({ answer: { mcc: '7011', riskTier: 'medium' }, merchant: row('m3', { mcc: '7011' }), groups, labels });
  assert.deepEqual([brand.mccCorrect, brand.brandMapped, brand.correct], [true, true, true]);
  const none = scoreMcc({ answer: null, merchant: row('m1', { mcc: '5712' }), groups, labels });
  assert.deepEqual([none.mccAnswer, none.mccCorrect, none.riskCorrect, none.riskDistance, none.correct], [null, false, false, null, false]);
});

test('C: an unjudgeable or unlabelled merchant falls back to the swarm teacher on the code alone, and is flagged', () => {
  const unjudgeable = scoreMcc({ answer: { mcc: '5999', riskTier: 'low' }, merchant: row('m4', { mcc: '5999', riskTier: null }), groups, labels });
  assert.deepEqual([unjudgeable.against, unjudgeable.labelFallback, unjudgeable.mccTeacher, unjudgeable.mccCorrect, unjudgeable.riskCorrect, unjudgeable.correct], ['teacher', 'unjudgeable', '5999', true, null, true]);
  const unlabelled = scoreMcc({ answer: { mcc: '5411', riskTier: 'low' }, merchant: row('m9', { mcc: '5999' }), groups, labels });
  assert.deepEqual([unlabelled.against, unlabelled.labelFallback, unlabelled.mccCorrect, unlabelled.riskCorrect, unlabelled.correct], ['teacher', 'unlabelled', false, null, false]);
  assert.equal(scoreMcc({ answer: { mcc: '5712', riskTier: 'low' }, merchant: row('m1', { mcc: '5712' }), groups, labels }).labelFallback, null);
});

test('C: the label is found by the truth row\'s merchantId, or by the runner job\'s id or cik', () => {
  const job = (key) => ({ ...key, name: 'm1 shop', website: 'https://m1.example', teacher: { mcc: '5712' } });
  for (const key of [{ merchantId: 'm1' }, { id: 'm1', cik: 'm1' }, { cik: 'm1' }]) {
    const r = scoreMcc({ answer: { mcc: '5712', riskTier: 'low' }, merchant: job(key), groups, labels });
    assert.deepEqual([r.against, r.correct], ['stage1', true], JSON.stringify(key));
  }
});

test('with no labels every score is what it was: no new field, the same values', () => {
  const inputs = [
    [{ mcc: '5999', riskTier: 'medium', flags: ['subscription'], siteStatus: 'live', confidence: 0.7 }, { mcc: '5999', riskTier: 'Medium', flags: ['subscription'] }],
    [{ mcc: '7011', riskTier: 'low' }, { mcc: '3504', riskTier: null, flags: null }],
    [null, { mcc: '5999' }],
  ];
  for (const [answer, teacher] of inputs) {
    const off = scoreMcc({ answer, merchant: merchant(teacher), groups });
    assert.deepEqual(Object.keys(off), ['against', 'mccAnswer', 'mccTeacher', 'mccCorrect', 'brandMapped', 'mccKnown', 'mccGroupAnswer', 'mccGroupTeacher', 'mccGroupCorrect', 'riskAnswer', 'riskTeacher', 'riskCorrect', 'riskDistance', 'flagsAnswer', 'flagsTeacher', 'flagsJaccard', 'siteStatus', 'confidence', 'correct']);
    assert.equal(JSON.stringify(scoreMcc({ answer, merchant: merchant(teacher), groups, labels: undefined })), JSON.stringify(off));
    assert.equal(off.against, 'teacher');
  }
});

test('C: the summary adds both-fields right over the labelled rows and the fallback count; without labels it adds nothing', () => {
  const scored = [
    scoreMcc({ answer: { mcc: '5712', riskTier: 'low' }, merchant: row('m1', { mcc: '5712' }), groups, labels }),
    scoreMcc({ answer: { mcc: '5712', riskTier: 'high' }, merchant: row('m1', { mcc: '5712' }), groups, labels }),
    scoreMcc({ answer: { mcc: '5999', riskTier: 'low' }, merchant: row('m4', { mcc: '5999' }), groups, labels }),
  ].map((r) => ({ ...r, stratum: 'nutra' }));
  const s = summarizeMcc(scored);
  assert.deepEqual(s.overall.bothCorrect, { k: 1, n: 2, rate: 0.5 });
  assert.equal(s.overall.labelFallback, 1);
  assert.deepEqual(s.overall.riskCorrect, { k: 1, n: 2, rate: 0.5 });
  const off = summarizeMcc([scoreMcc({ answer: { mcc: '5999' }, merchant: merchant({ mcc: '5999' }), groups })]);
  assert.equal('bothCorrect' in off.overall, false);
  assert.equal('labelFallback' in off.overall, false);
});

test('C: the labelling pass\'s own output loads and scores: a labelled merchant on both fields, an unjudgeable one on the code', () => {
  // The pass's rehearsal file as it wrote it, its merchants renamed: the repository names no campaign merchant.
  const rehearsal = loadStage1Labels(join(import.meta.dirname, 'fixtures', 'labels-stage1-rehearsal.jsonl'), groups);
  assert.deepEqual(rehearsal, {
    'grocer-one.example': { mcc: '5661', allowedTiers: ['low', 'medium'] },
    'bakery-two.example': { mcc: '5462', allowedTiers: ['low'] },
    'furniture-three.example': { unjudgeable: 'the site does not load' },
  });
  const job = (id, teacher) => ({ id, cik: id, name: id, website: `https://${id}`, teacher });
  const score = (id, answer, teacher) => scoreMcc({ answer, merchant: job(id, teacher), groups, labels: rehearsal });
  assert.deepEqual(['low', 'medium'].map((t) => score('bakery-two.example', { mcc: '5462', riskTier: t }, { mcc: '5812' }).correct), [true, false]);
  assert.equal(score('grocer-one.example', { mcc: '5661', riskTier: 'medium' }, { mcc: '5411' }).correct, true, 'either of two adjacent tiers');
  const fallback = score('furniture-three.example', { mcc: '5712', riskTier: 'high' }, { mcc: '5712' });
  assert.deepEqual([fallback.against, fallback.labelFallback, fallback.mccCorrect, fallback.riskCorrect, fallback.correct], ['teacher', 'unjudgeable', true, null, true]);
});
