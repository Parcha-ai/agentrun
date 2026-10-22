// The MCC scorer on synthetic rows: exact code, ISO 18245 group with Visa's T&E folds, risk tier and its ordinal
// distance, a field the teacher lacks left out of the n, the reported-only fields, and the per-vertical summary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupOf, loadGroups, mccOf, riskOf, sameGroup, scoreMcc, summarizeMcc } from './score-mcc.mjs';

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
    against: 'teacher', mccAnswer: '5999', mccTeacher: '5999', mccCorrect: true, mccKnown: true,
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
  assert.deepEqual(s.overall.mccCorrect, { k: 2, n: 4, rate: 0.5 });
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
});
