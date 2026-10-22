// The adjudication sample and blind packets on synthetic merchants: proportional strata, salted commitments, an order
// only the salt recovers, codes alone shown, the risk judged from the site against the rubric, verdicts back to rows.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitmentOf, drawSample, learnerSide, packetOf, sectionOf, unblind } from './adjudication.mjs';
import { loadGroups } from './score-mcc.mjs';

const groups = loadGroups();
const SALT = 'x'.repeat(16) + 'synthetic-salt-0001';
const merchants = (vertical, count) => Array.from({ length: count }, (_, i) => ({ merchantId: `${vertical}-${i}`, name: `${vertical} shop ${i}`, website: `https://${vertical}${i}.example`, vertical }));
const DEV = [...merchants('nutra', 100), ...merchants('travel', 60), ...merchants('adult', 39), ...merchants('crypto', 1)];
const onSide = (side) => DEV.find((m) => learnerSide(SALT, m.merchantId) === side);
const EV = [{ url: 'https://shop.example/products', quote: 'We sell herbal supplements.' }];

test('the sample keeps each vertical\'s share of DEV, gives a one-merchant vertical its one, and rebuilds the same from the salt', () => {
  const { sample, commitments, quota } = drawSample({ dev: DEV, n: 120, salt: SALT });
  assert.equal(sample.length, 120);
  assert.deepEqual(quota, { adult: 23, crypto: 1, nutra: 60, travel: 36 });
  assert.equal(new Set(sample.map((m) => m.merchantId)).size, 120);
  assert.deepEqual(commitments, sample.map((m) => commitmentOf(SALT, m.merchantId)).sort());
  assert.ok(commitments.every((c) => /^[0-9a-f]{64}$/.test(c)));
  const ids = (s) => s.map((m) => m.merchantId).sort();
  assert.deepEqual(ids(drawSample({ dev: [...DEV].reverse(), n: 120, salt: SALT }).sample), ids(sample), 'DEV order does not move the sample');
  assert.notDeepEqual(ids(drawSample({ dev: DEV, n: 120, salt: `${SALT}-other` }).sample), ids(sample));
  const small = [...merchants('a', 10), ...merchants('b', 1), ...merchants('c', 1)];
  assert.deepEqual(drawSample({ dev: small, n: 3, salt: SALT }).quota, { a: 1, b: 1, c: 1 }, 'a vertical the shares leave empty takes one from the largest');
  const seeded = [...merchants('a', 4), ...merchants('s', 4).map((m) => ({ ...m, vertical: null, stratum: 'seed' }))];
  assert.deepEqual(drawSample({ dev: seeded, n: 4, salt: SALT }).quota, { a: 2, seed: 2 }, 'a seed merchant has no vertical and is drawn in its own stratum');
});

test('the sample refuses a short salt, a sample larger than DEV, and repeated merchant ids', () => {
  assert.throws(() => drawSample({ dev: DEV, salt: 'short' }), /salt/);
  assert.throws(() => drawSample({ dev: DEV.slice(0, 10), n: 120, salt: SALT }), /a sample of 120 from 10/);
  assert.throws(() => drawSample({ dev: [...DEV, DEV[0]], n: 120, salt: SALT }), /distinct/);
});

test('the learner is A for about half the merchants; the packet\'s first stage is the site, its second the two codes alone', () => {
  const a = DEV.filter((m) => learnerSide(SALT, m.merchantId) === 'A').length;
  assert.ok(a > 70 && a < 130, `${a} of 200 on A`);
  const merchant = { ...onSide('B'), teacher: { mcc: 5999, riskTier: null, flags: ['nutraceuticals'] } };
  const answer = { mcc: '5499', mccDescription: 'x', riskTier: 'high', riskRationale: 'learner style', evidence: EV, flags: ['nutraceuticals'], siteStatus: 'live', confidence: 0.9 };
  const p = packetOf({ merchant, answer, salt: SALT, groups });
  assert.deepEqual(p.site, { merchantId: merchant.merchantId, name: merchant.name, website: merchant.website });
  assert.deepEqual(p.codes, {
    merchantId: merchant.merchantId, same: false,
    A: { mcc: '5999', mccTitle: 'Miscellaneous and Specialty Retail Shops' },
    B: { mcc: '5499', mccTitle: 'Miscellaneous Food Stores – Convenience Stores and Specialty Markets' },
  });
  for (const leak of ['style', 'high', 'nutraceuticals', 'learner', 'teacher', 'vertical', '0.9']) assert.equal(JSON.stringify(p).includes(leak), false, leak);
});

test('verdicts unblind to one row per side: the code by A/B, the tier against the allowed tiers, a teacher with no tier null', () => {
  const [onA, onB] = [onSide('A'), onSide('B')];
  const items = [
    { merchant: { ...onA, teacher: { mcc: '5999', riskTier: null } }, answer: { mcc: '5499', riskTier: 'high' } },
    { merchant: { ...onB, teacher: { mcc: '5967', riskTier: 'high' } }, answer: { mcc: '5967', riskTier: 'low' } },
  ];
  const verdicts = {
    [onA.merchantId]: { own: { mcc: '5499', evidence: EV }, risk: { tiers: ['medium', 'high'], evidence: EV }, mcc: { verdict: 'A', evidence: EV } },
    [onB.merchantId]: { own: { mcc: '5967', evidence: EV }, risk: { tiers: ['high'], evidence: EV }, mcc: { verdict: 'both', evidence: EV } },
  };
  const { learner, teacher, unjudgeable } = unblind({ items, verdicts, salt: SALT });
  assert.deepEqual(learner[0], { merchantId: onA.merchantId, vertical: onA.vertical, side: 'learner', mccAdjRight: true, mccOwnExact: true, riskAdjRight: true, riskAdjDistance: 0, adjRight: true });
  assert.deepEqual(teacher[0], { merchantId: onA.merchantId, vertical: onA.vertical, side: 'teacher', mccAdjRight: false, mccOwnExact: false, riskAdjRight: null, riskAdjDistance: null, adjRight: null });
  assert.deepEqual([learner[1].mccAdjRight, learner[1].riskAdjRight, learner[1].riskAdjDistance, learner[1].adjRight], [true, false, 2, false]);
  assert.deepEqual([teacher[1].mccAdjRight, teacher[1].riskAdjRight, teacher[1].adjRight], [true, true, true]);
  const hotel = { merchant: { ...onA, teacher: { mcc: '3504' } }, answer: { mcc: '7011', riskTier: 'low' } };
  const brand = unblind({ items: [hotel], verdicts: { [onA.merchantId]: { own: { mcc: '3504', evidence: EV }, risk: { tiers: ['low'], evidence: EV }, mcc: { verdict: 'both', evidence: EV } } }, salt: SALT });
  assert.deepEqual([brand.learner[0].mccOwnExact, brand.teacher[0].mccOwnExact], [true, true], 'the generic 7011 matches the adjudicator\'s own brand code 3504');
  assert.deepEqual(unjudgeable, []);
});

test('a verdict needs the own code, allowed tiers next to each other, A/B/both/neither, and evidence for each; same codes take only both or neither', () => {
  const merchant = { ...onSide('A'), teacher: { mcc: '5999' } };
  const items = [{ merchant, answer: { mcc: '5999', riskTier: 'low' } }];
  const good = { own: { mcc: '5999', evidence: EV }, risk: { tiers: ['low'], evidence: EV }, mcc: { verdict: 'both', evidence: EV } };
  const run = (v) => unblind({ items, verdicts: { [merchant.merchantId]: v }, salt: SALT });
  assert.equal(run(good).learner[0].adjRight, true);
  assert.throws(() => run({ ...good, mcc: { verdict: 'A', evidence: EV } }), /only both or neither/);
  assert.throws(() => run({ ...good, own: { evidence: EV } }), /own code/);
  assert.throws(() => run({ ...good, risk: { tiers: ['low', 'high'], evidence: EV } }), /next to each other/);
  assert.throws(() => run({ ...good, risk: { tiers: [], evidence: EV } }), /one tier/);
  assert.throws(() => run({ ...good, risk: { tiers: ['low'], evidence: [] } }), /risk verdict needs evidence/);
  assert.throws(() => run({ ...good, mcc: { verdict: 'learner', evidence: EV } }), /must be one of/);
  assert.throws(() => run({ ...good, mcc: { verdict: 'both', evidence: [{ url: 'u' }] } }), /mcc verdict needs evidence/);
  assert.throws(() => unblind({ items, verdicts: {}, salt: SALT }), /no verdict/);
  const gone = run({ unjudgeable: 'the site no longer loads' });
  assert.deepEqual([gone.learner, gone.teacher, gone.unjudgeable], [[], [], [{ merchantId: merchant.merchantId, reason: 'the site no longer loads' }]]);
});

test('the rubric section is cut at the next heading of its level and hashed, so it can be pinned', () => {
  const spec = '# Task\n\n## The risk rubric\n\nThe tier is the highest one any row reaches:\n- high, when ...\n### a sub-heading stays\n\n## The flags\n\n- adult\n';
  const { text, sha256 } = sectionOf(spec, '## The risk rubric');
  assert.equal(text, '## The risk rubric\n\nThe tier is the highest one any row reaches:\n- high, when ...\n### a sub-heading stays');
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(sectionOf(`${spec}\n`, '## The risk rubric').sha256, sha256);
  assert.throws(() => sectionOf(spec, '## Missing'), /no section/);
});

test('ADJUDICATION.md quotes SPEC.md\'s risk rubric word for word, so the two cannot drift', () => {
  const read = (file) => readFileSync(join(import.meta.dirname, file), 'utf8');
  const { text } = sectionOf(read('SPEC.md'), '## The risk rubric');
  const body = text.split('\n').slice(1).join('\n').trim();
  const protocol = read('ADJUDICATION.md');
  const marker = protocol.indexOf('<!-- risk rubric: SPEC.md, word for word -->');
  assert.ok(marker >= 0, 'the quote is marked');
  const open = protocol.indexOf('```text\n', marker) + '```text\n'.length;
  assert.equal(protocol.slice(open, protocol.indexOf('\n```', open)), body);
  for (const tier of ['- high, when', '- medium, when no high row holds', '- low, when no other row holds']) assert.ok(body.includes(tier), tier);
});
