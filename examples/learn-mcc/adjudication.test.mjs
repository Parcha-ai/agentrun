// The adjudication sample and blind packets on synthetic merchants: proportional strata, salted commitments, an order
// only the salt recovers, nothing stylistic shown, and verdicts back to one row per side.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitmentOf, drawSample, learnerSide, packetOf, unblind } from './adjudication.mjs';
import { loadGroups } from './score-mcc.mjs';

const table = loadGroups();
const SALT = 'x'.repeat(16) + 'synthetic-salt-0001';
const merchants = (vertical, count) => Array.from({ length: count }, (_, i) => ({ merchantId: `${vertical}-${i}`, name: `${vertical} shop ${i}`, website: `https://${vertical}${i}.example`, vertical }));
const DEV = [...merchants('nutra', 100), ...merchants('travel', 60), ...merchants('adult', 39), ...merchants('crypto', 1)];

test('the sample keeps each vertical\'s share of DEV, gives a one-merchant vertical its one, and rebuilds the same from the salt', () => {
  const { sample, commitments, quota } = drawSample({ dev: DEV, n: 120, salt: SALT });
  assert.equal(sample.length, 120);
  assert.deepEqual(quota, { adult: 23, crypto: 1, nutra: 60, travel: 36 });
  assert.equal(new Set(sample.map((m) => m.merchantId)).size, 120);
  assert.deepEqual(commitments, sample.map((m) => commitmentOf(SALT, m.merchantId)).sort());
  assert.ok(commitments.every((c) => /^[0-9a-f]{64}$/.test(c)));
  assert.deepEqual(drawSample({ dev: [...DEV].reverse(), n: 120, salt: SALT }).sample.map((m) => m.merchantId).sort(), sample.map((m) => m.merchantId).sort(), 'DEV order does not move the sample');
  assert.notDeepEqual(drawSample({ dev: DEV, n: 120, salt: `${SALT}-other` }).sample.map((m) => m.merchantId).sort(), sample.map((m) => m.merchantId).sort());
  const small = [...merchants('a', 10), ...merchants('b', 1), ...merchants('c', 1)];
  assert.deepEqual(drawSample({ dev: small, n: 3, salt: SALT }).quota, { a: 1, b: 1, c: 1 }, 'a vertical the shares leave empty takes one from the largest');
});

test('the sample refuses a short salt, a sample larger than DEV, and repeated merchant ids', () => {
  assert.throws(() => drawSample({ dev: DEV, salt: 'short' }), /salt/);
  assert.throws(() => drawSample({ dev: DEV.slice(0, 10), n: 120, salt: SALT }), /a sample of 120 from 10/);
  assert.throws(() => drawSample({ dev: [...DEV, DEV[0]], n: 120, salt: SALT }), /distinct/);
});

test('the learner is A for about half the merchants, and the packet shows code, title and tier only', () => {
  const sides = DEV.map((m) => learnerSide(SALT, m.merchantId));
  const a = sides.filter((s) => s === 'A').length;
  assert.ok(a > 70 && a < 130, `${a} of 200 on A`);
  const merchant = DEV.find((m) => learnerSide(SALT, m.merchantId) === 'B');
  const learner = { mcc: '5499', risk: 'High', rationale: 'learner style', evidence: [{ url: 'u', quote: 'q' }], flags: ['nutraceuticals'], confidence: 0.9 };
  const teacher = { mcc: 5999, risk: 'high', rationale: 'swarm style' };
  const p = packetOf({ merchant, learner, teacher, salt: SALT, table });
  assert.deepEqual(p.A, { mcc: '5999', mccTitle: 'Miscellaneous and Specialty Retail Shops', risk: 'high' });
  assert.deepEqual(p.B, { mcc: '5499', mccTitle: 'Miscellaneous Food Stores – Convenience Stores and Specialty Markets', risk: 'high' });
  assert.deepEqual(p.same, { mcc: false, risk: true });
  assert.equal(JSON.stringify(p).includes('style'), false);
  assert.equal(JSON.stringify(p).includes('learner'), false);
});

test('verdicts unblind to one row per side; the same value takes only both or neither; every verdict carries evidence', () => {
  const [onA, onB] = [DEV.find((m) => learnerSide(SALT, m.merchantId) === 'A'), DEV.find((m) => learnerSide(SALT, m.merchantId) === 'B')];
  const packets = [
    packetOf({ merchant: onA, learner: { mcc: '5499', risk: 'high' }, teacher: { mcc: '5999', risk: 'medium' }, salt: SALT, table }),
    packetOf({ merchant: onB, learner: { mcc: '5967', risk: 'high' }, teacher: { mcc: '5967', risk: 'high' }, salt: SALT, table }),
  ];
  const ev = [{ url: 'https://shop.example/products', quote: 'We sell herbal supplements.' }];
  const verdicts = {
    [onA.merchantId]: { mcc: { verdict: 'A', evidence: ev }, risk: { verdict: 'neither', evidence: ev } },
    [onB.merchantId]: { mcc: { verdict: 'both', evidence: ev }, risk: { verdict: 'both', evidence: ev } },
  };
  const { learner, teacher } = unblind({ packets, verdicts, salt: SALT, verticals: { [onA.merchantId]: 'nutra', [onB.merchantId]: 'adult' } });
  assert.deepEqual(learner[0], { merchantId: onA.merchantId, vertical: 'nutra', side: 'learner', mccAdjRight: true, riskAdjRight: false, adjRight: false });
  assert.deepEqual(teacher[0], { merchantId: onA.merchantId, vertical: 'nutra', side: 'teacher', mccAdjRight: false, riskAdjRight: false, adjRight: false });
  assert.equal(learner[1].adjRight, true);
  assert.equal(teacher[1].adjRight, true);
  assert.throws(() => unblind({ packets, verdicts: { ...verdicts, [onB.merchantId]: { mcc: { verdict: 'A', evidence: ev }, risk: { verdict: 'both', evidence: ev } } }, salt: SALT }), /only both or neither/);
  assert.throws(() => unblind({ packets, verdicts: { ...verdicts, [onA.merchantId]: { mcc: { verdict: 'A', evidence: [] }, risk: { verdict: 'A', evidence: ev } } }, salt: SALT }), /needs evidence/);
  assert.throws(() => unblind({ packets, verdicts: { ...verdicts, [onA.merchantId]: { mcc: { verdict: 'learner', evidence: ev }, risk: { verdict: 'A', evidence: ev } } }, salt: SALT }), /must be one of/);
  assert.throws(() => unblind({ packets, verdicts: { [onA.merchantId]: verdicts[onA.merchantId] }, salt: SALT }), /no verdict/);
  const gone = unblind({ packets, verdicts: { ...verdicts, [onB.merchantId]: { unjudgeable: 'the site no longer loads' } }, salt: SALT });
  assert.deepEqual([gone.learner.length, gone.teacher.length], [1, 1]);
  assert.deepEqual(gone.unjudgeable, [{ merchantId: onB.merchantId, reason: 'the site no longer loads' }]);
});
