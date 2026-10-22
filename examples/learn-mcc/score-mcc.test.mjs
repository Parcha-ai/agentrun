// The MCC scorer on synthetic rows: exact code, ISO 18245 group with Visa's T&E folds, risk tier and its ordinal
// distance, per-field nulls where the teacher has no value, and the per-vertical summary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupOf, loadGroups, mccOf, riskOf, sameGroup, scoreMcc, summarizeMcc } from './score-mcc.mjs';

const table = loadGroups();

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

test('the table holds the 13 ISO 18245 ranges end to end, its source cited, and the sample codes in their groups', () => {
  assert.equal(table.groups.length, 13);
  assert.equal(table.groups[0].from, '0001');
  assert.equal(table.groups.at(-1).to, '9999');
  for (const [i, g] of table.groups.entries()) if (i) assert.equal(Number(g.from), Number(table.groups[i - 1].to) + 1, `${g.id} starts where the last range ends`);
  assert.match(table.source.ranges.url, /^https:\/\//);
  assert.match(table.source.codes.url, /^https:\/\//);
  assert.match(table.source.ranges.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(table.checks.listedOutsideTheirRange, [], 'every code the range reference lists sits inside its own table\'s range');
  for (const s of table.checks.sample) {
    assert.ok(s.visa, `${s.code} is in Visa's listing`);
    if (s.citiTable) assert.equal(groupOf(s.code, table), table.groups.find((g) => g.name === s.citiTable).id, `${s.code} is in the group Citi lists it under`);
  }
  const expected = { '0742': 'agricultural-services', '1520': 'contracted-services', '3000': 'airlines', '3351': 'car-rental', '3501': 'lodging', '4111': 'transportation-services', '4900': 'utility-services', '5411': 'retail-outlet-services', '5651': 'clothing-stores', '5812': 'miscellaneous-stores', '7311': 'business-services', '8011': 'professional-services-and-membership-organizations', '9311': 'government-services' };
  for (const [code, group] of Object.entries(expected)) assert.equal(groupOf(code, table), group, code);
});

test('a code Visa lists as an airline above 3299 is an airline, not car rental, and a generic T&E code matches its block', () => {
  assert.equal(groupOf('3301', table), 'airlines');
  assert.equal(groupOf('3351', table), 'car-rental');
  assert.ok(sameGroup('3000', '4511', table), 'United\'s own code and the generic airline code are both an airline');
  assert.ok(sameGroup('7011', '3501', table));
  assert.ok(sameGroup('3357', '7512', table));
  assert.ok(sameGroup('4511', '4111', table), 'the generic airline code keeps its own range too');
  assert.equal(sameGroup('3000', '4111', table), false, 'a merchant-specific airline code is not commuter transport');
  assert.equal(sameGroup('3000', '7011', table), false);
  assert.equal(sameGroup(null, '5999', table), false);
});

test('one answer: exact code, group, risk tier and distance, each right or wrong, and correct over the scored fields', () => {
  const right = scoreMcc({ answer: { mcc: '5999', risk: 'medium' }, teacher: { mcc: '5999', risk: 'Medium' }, table });
  assert.deepEqual(right, {
    against: 'teacher', mccAnswer: '5999', mccTeacher: '5999', mccCorrect: true, mccKnown: true,
    mccGroupAnswer: 'miscellaneous-stores', mccGroupTeacher: 'miscellaneous-stores', mccGroupCorrect: true,
    riskAnswer: 'medium', riskTeacher: 'medium', riskCorrect: true, riskDistance: 0, correct: true, correctOver: ['mcc', 'risk'],
  });
  const groupOnly = scoreMcc({ answer: { mcc: '5969', risk: 'low' }, teacher: { mcc: '5999', risk: 'high' }, table });
  assert.equal(groupOnly.mccCorrect, false);
  assert.equal(groupOnly.mccGroupCorrect, true);
  assert.equal(groupOnly.riskCorrect, false);
  assert.equal(groupOnly.riskDistance, 2);
  assert.equal(groupOnly.correct, false);
  const offGroup = scoreMcc({ answer: { mcc: 5411, risk: 'high' }, teacher: { mcc: '5812', risk: 'medium' }, table });
  assert.equal(offGroup.mccAnswer, '5411');
  assert.equal(offGroup.mccGroupCorrect, false);
  assert.equal(offGroup.riskDistance, 1);
});

test('no answer is wrong on every field the teacher has; a field the teacher lacks is not scored', () => {
  const none = scoreMcc({ answer: null, teacher: { mcc: '5999', risk: 'low' }, table });
  assert.equal(none.mccCorrect, false);
  assert.equal(none.mccGroupCorrect, false);
  assert.equal(none.riskCorrect, false);
  assert.equal(none.riskDistance, null);
  assert.equal(none.mccKnown, false);
  assert.equal(none.correct, false);
  const noRisk = scoreMcc({ answer: { mcc: '5999', risk: 'high' }, teacher: { mcc: '5999' }, table });
  assert.equal(noRisk.riskCorrect, null);
  assert.equal(noRisk.riskDistance, null);
  assert.deepEqual(noRisk.correctOver, ['mcc']);
  assert.equal(noRisk.correct, true);
  const nothing = scoreMcc({ answer: { mcc: '5999', risk: 'low' }, teacher: {}, table });
  assert.deepEqual(nothing.correctOver, []);
  assert.equal(nothing.correct, false, 'nothing scored is not correct');
});

test('an unlisted code can still agree with the teacher exactly; mccKnown only reports it', () => {
  const r = scoreMcc({ answer: { mcc: '5961', risk: 'low' }, teacher: { mcc: '5961', risk: 'low' }, table });
  assert.equal(r.mccCorrect, true);
  assert.equal(r.mccKnown, false, 'Visa no longer lists 5961 and Citi gives it to TSYS alone');
  assert.equal(scoreMcc({ answer: { mcc: '6538' }, teacher: { mcc: '6538' }, table }).mccKnown, true, 'a Mastercard-only code is known');
});

test('the summary counts each field over the rows that score it, per vertical, with the teacher group share and cost per job', () => {
  const row = (vertical, answer, teacher, costUsd) => ({ ...scoreMcc({ answer, teacher, table }), vertical, ...(costUsd === undefined ? {} : { costUsd }) });
  const rows = [
    row('nutra', { mcc: '5499', risk: 'high' }, { mcc: '5499', risk: 'high' }, 0.4),
    row('nutra', { mcc: '5912', risk: 'medium' }, { mcc: '5499', risk: 'high' }, 0.6),
    row('travel', { mcc: '4511', risk: 'medium' }, { mcc: '3000', risk: 'medium' }),
    row('travel', { mcc: '4722', risk: 'low' }, { mcc: '4722' }, 0.2),
  ];
  const s = summarizeMcc(rows);
  assert.equal(s.against, 'teacher');
  assert.deepEqual(s.overall.mccCorrect, { k: 2, n: 4, rate: 0.5 });
  assert.deepEqual(s.overall.mccGroupCorrect, { k: 3, n: 4, rate: 0.75 }, '5912 vs 5499 is another group; 4511 vs 3000 is an airline either way');
  assert.deepEqual(s.overall.riskCorrect, { k: 2, n: 3, rate: 2 / 3 });
  assert.deepEqual(s.byVertical.nutra.correct, { k: 1, n: 2, rate: 0.5 });
  assert.equal(s.byVertical.travel.riskCorrect.n, 1);
  assert.equal(s.overall.riskDistanceMean, 1 / 3);
  assert.equal(s.overall.riskOffByTwo, 0);
  assert.ok(Math.abs(s.overall.costPerJobUsd - 0.4) < 1e-12);
  assert.equal(s.overall.costUnknown, 1);
  assert.deepEqual(s.teacherGroupShare, { 'retail-outlet-services': 0.5, airlines: 0.25, 'transportation-services': 0.25 });
});
