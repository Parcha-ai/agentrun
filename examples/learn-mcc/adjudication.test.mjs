// Blind adjudication on synthetic merchants: an order only the salt recovers, codes alone shown, the risk judged from the
// site against the rubric, verdicts back to rows, an arm's rows joined to the sample, and the two commands end to end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { armAnswers, learnerSide, packetOf, sectionOf, unblind, verdictsOf } from './adjudication.mjs';
import { loadGroups } from './score-mcc.mjs';

const groups = loadGroups();
const SALT = 'x'.repeat(16) + 'synthetic-salt-0001';
const merchants = (vertical, count) => Array.from({ length: count }, (_, i) => ({ merchantId: `${vertical}-${i}`, name: `${vertical} shop ${i}`, website: `https://${vertical}${i}.example`, vertical }));
const DEV = [...merchants('nutra', 100), ...merchants('travel', 60), ...merchants('adult', 39), ...merchants('crypto', 1)];
const onSide = (side) => DEV.find((m) => learnerSide(SALT, m.merchantId) === side);
const EV = [{ url: 'https://shop.example/products', quote: 'We sell herbal supplements.' }];

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

test('an arm\'s rows join the sample in its own order; a merchant the arm lacks is missing; two rows for one are refused', () => {
  const sample = [{ ...DEV[1], order: 2, teacher: { mcc: '5999' } }, { ...DEV[0], order: 1, teacher: { mcc: '5411' } }, { ...DEV[2], order: 3, teacher: { mcc: '5812' } }];
  const rows = [{ merchantId: DEV[0].merchantId, mccAnswer: '5411', riskAnswer: 'low', mccTeacher: 'not read' }, { merchantId: DEV[1].merchantId, mccAnswer: null, riskAnswer: null }];
  const { items, missing } = armAnswers({ sample, rows });
  assert.deepEqual(items.map((i) => [i.merchant.merchantId, i.answer]), [[DEV[0].merchantId, { mcc: '5411', riskTier: 'low' }], [DEV[1].merchantId, { mcc: null, riskTier: null }]]);
  assert.deepEqual(missing, [DEV[2].merchantId]);
  assert.throws(() => armAnswers({ sample, rows: [...rows, rows[0]] }), /two rows/);
});

test('stage 1 is shared by every arm and stage 2 is the arm\'s; an unjudgeable site needs no stage 2', () => {
  const stage1 = { a: { own: { mcc: '5999', evidence: EV }, risk: { tiers: ['low'], evidence: EV } }, b: { unjudgeable: 'parked' } };
  assert.deepEqual(verdictsOf(stage1, { a: { mcc: { verdict: 'both', evidence: EV } } }), { a: { ...stage1.a, mcc: { verdict: 'both', evidence: EV } }, b: { unjudgeable: 'parked' } });
  assert.equal(verdictsOf(stage1, {}).a.mcc, undefined, 'a missing stage 2 reaches unblind, which refuses it');
});

test('the two commands end to end: packets hold no key and no tier; unblind writes one row per side and the counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adjudication-'));
  try {
    const [onA, onB] = [onSide('A'), onSide('B')];
    const sample = [{ ...onA, order: 1, teacher: { mcc: '5999', riskTier: null } }, { ...onB, order: 2, teacher: { mcc: '5967', riskTier: null } }];
    writeFileSync(join(dir, 'sample.json'), JSON.stringify(sample));
    writeFileSync(join(dir, 'rows.jsonl'), [{ merchantId: onA.merchantId, mccAnswer: '5499', riskAnswer: 'medium' }, { merchantId: onB.merchantId, mccAnswer: '5967', riskAnswer: 'high' }].map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'salt'), `${SALT}\n`);
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, 'adjudication.mjs'), ...args], { encoding: 'utf8' }));
    assert.deepEqual(cli('packets', join(dir, 'sample.json'), join(dir, 'rows.jsonl'), join(dir, 'salt'), join(dir, 'packets')), { packets: 2, missing: [] });
    const codes = readFileSync(join(dir, 'packets', 'codes.jsonl'), 'utf8');
    assert.deepEqual(JSON.parse(codes.split('\n')[0]).A.mcc, '5499', 'the learner is A for this merchant');
    for (const leak of ['medium', 'high', 'learner', 'teacher', SALT]) assert.equal(codes.includes(leak), false, leak);
    assert.deepEqual(readFileSync(join(dir, 'packets', 'site.jsonl'), 'utf8').trim().split('\n').map((l) => Object.keys(JSON.parse(l))), [['merchantId', 'name', 'website'], ['merchantId', 'name', 'website']]);
    const stage1 = { [onA.merchantId]: { own: { mcc: '5499', evidence: EV }, risk: { tiers: ['medium'], evidence: EV } }, [onB.merchantId]: { own: { mcc: '5967', evidence: EV }, risk: { tiers: ['high'], evidence: EV } } };
    const stage2 = { [onA.merchantId]: { mcc: { verdict: 'A', evidence: EV } }, [onB.merchantId]: { mcc: { verdict: 'both', evidence: EV } } };
    writeFileSync(join(dir, 'stage1.json'), JSON.stringify(stage1));
    writeFileSync(join(dir, 'stage2.json'), JSON.stringify(stage2));
    const summary = cli('unblind', join(dir, 'sample.json'), join(dir, 'rows.jsonl'), join(dir, 'salt'), join(dir, 'stage1.json'), join(dir, 'stage2.json'), join(dir, 'out'));
    assert.deepEqual(summary.learner, { mccAdjRight: { k: 2, n: 2 }, mccOwnExact: { k: 2, n: 2 }, riskAdjRight: { k: 2, n: 2 }, adjRight: { k: 2, n: 2 } });
    assert.deepEqual(summary.teacher, { mccAdjRight: { k: 1, n: 2 }, mccOwnExact: { k: 1, n: 2 }, riskAdjRight: { k: 0, n: 0 }, adjRight: { k: 0, n: 0 } });
    assert.equal(readFileSync(join(dir, 'out', 'learner.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
