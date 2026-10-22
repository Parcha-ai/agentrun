// Blind adjudication on synthetic merchants: candidate codes with no source in a salted order, the run's tools that keep
// stage 2 behind stage 1, verdicts back to one row per side, the commands end to end, and the rubric texts that cannot
// drift from SPEC.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedTiers, armAnswers, candidatesOf, candidateTable, sectionOf, unblind } from './adjudication.mjs';
import { adjudicatorRun } from './adjudicator-tools.mjs';
import { loadGroups } from './score-mcc.mjs';

const groups = loadGroups();
const SALT = 'x'.repeat(16) + 'synthetic-salt-0001';
const EV = [{ url: 'https://shop.example/products', quote: 'We sell herbal supplements.' }];
const merchant = (id, teacher, extra = {}) => ({ merchantId: id, name: `${id} shop`, website: `https://${id}.example`, stratum: 'nutra', teacher, ...extra });
const read = (...parts) => readFileSync(join(import.meta.dirname, ...parts), 'utf8');

test('candidates: each distinct code once, under its title, in a salted order that hides the teacher\'s place', () => {
  const c = candidatesOf({ merchantId: 'm1', codes: ['5999', 5499, '5999', null, 'MCC 5912', '5961'], salt: SALT, groups });
  assert.deepEqual(c.map((x) => x.code).sort(), ['5499', '5961', '5999']);
  assert.deepEqual(c.find((x) => x.code === '5961'), { code: '5961', title: 'not in the code table' });
  assert.equal(c.find((x) => x.code === '5499').title, 'Miscellaneous Food Stores – Convenience Stores and Specialty Markets');
  const firsts = new Set(Array.from({ length: 40 }, (_, i) => candidatesOf({ merchantId: `m${i}`, codes: ['5999', '5499'], salt: SALT, groups })[0].code));
  assert.deepEqual([...firsts].sort(), ['5499', '5999'], 'the teacher\'s code (given first) is not always shown first');
  assert.deepEqual(candidatesOf({ merchantId: 'm1', codes: ['5499', '5999'], salt: SALT, groups }), candidatesOf({ merchantId: 'm1', codes: ['5999', '5499'], salt: SALT, groups }), 'the order is the salt\'s, not the input\'s');
});

test('the candidate table covers the teacher and every arm; a merchant an arm lacks is missing for that arm', () => {
  const sample = [{ ...merchant('b', { mcc: '5999' }), order: 2 }, { ...merchant('a', { mcc: '5411' }), order: 1 }];
  const arms = [
    { name: 'hand', rows: [{ merchantId: 'a', mccAnswer: '5411', riskAnswer: 'low' }, { merchantId: 'b', mccAnswer: '5499', riskAnswer: 'medium' }] },
    { name: 'learn', rows: [{ merchantId: 'a', mccAnswer: '5422', riskAnswer: 'low' }] },
  ];
  const { candidates, missing } = candidateTable({ sample, arms, salt: SALT, groups });
  assert.deepEqual(Object.keys(candidates), ['a', 'b']);
  assert.deepEqual(candidates.a.map((c) => c.code).sort(), ['5411', '5422']);
  assert.deepEqual(candidates.b.map((c) => c.code).sort(), ['5499', '5999']);
  assert.deepEqual(missing, { hand: [], learn: ['b'] });
  assert.throws(() => armAnswers({ sample, rows: [arms[0].rows[0], arms[0].rows[0]] }), /two rows/);
});

test('the run: codes refuses before stage 1; stage 1 is checked and once; the verdict covers every candidate exactly once', async () => {
  const candidates = candidatesOf({ merchantId: 'm1', codes: ['5999', '5499'], salt: SALT, groups });
  const run = adjudicatorRun({ candidates, groups });
  const [site, codes] = run.tools;
  assert.deepEqual([site.name, codes.name], ['site', 'codes']);
  assert.match((await codes.run({})).refused, /Record stage 1 with site first/);
  assert.deepEqual(run.problems({ codes: [] }), ['record stage 1 with site first']);
  assert.match((await site.run({ own: { mcc: '1234', evidence: EV }, risk: { tiers: ['low'], evidence: EV } })).refused, /from mcc_codes/);
  assert.match((await site.run({ own: { mcc: '5499', evidence: EV }, risk: { tiers: ['low', 'high'], evidence: EV } })).refused, /next to each other/);
  assert.match((await site.run({ own: { mcc: '5499', evidence: [] }, risk: { tiers: ['low'], evidence: EV } })).refused, /needs evidence/);
  assert.match((await site.run({ unjudgeable: 'parked', own: { mcc: '5499', evidence: EV } })).refused, /goes alone/);
  assert.equal((await site.run({ own: { mcc: '5499', evidence: EV }, risk: { tiers: ['medium', 'high'], evidence: EV } })).recorded, true);
  assert.match((await site.run({ own: { mcc: '5999', evidence: EV }, risk: { tiers: ['low'], evidence: EV } })).refused, /already recorded/);
  assert.deepEqual(run.problems({ codes: [] }), ['call codes first']);
  assert.deepEqual((await codes.run({})).candidates, candidates);
  assert.deepEqual(run.problems({ codes: [{ code: '5499', acceptable: true, evidence: EV }] }), ['5999 is not judged']);
  assert.deepEqual(run.problems({ codes: [{ code: '5499', acceptable: true, evidence: EV }, { code: '5499', acceptable: false, evidence: EV }, { code: '5999', acceptable: false, evidence: EV }] }), ['5499 is judged twice']);
  assert.deepEqual(run.problems({ codes: [{ code: '5812', acceptable: true, evidence: EV }, { code: '5499', acceptable: true, evidence: EV }, { code: '5999', acceptable: false, evidence: EV }] }), ['5812 is not a candidate']);
  const verdict = { codes: [{ code: '5999', acceptable: false, evidence: EV }, { code: '5499', acceptable: true, evidence: EV }] };
  assert.deepEqual(run.problems(verdict), []);
  assert.deepEqual(run.record(verdict), {
    stage1: { own: { mcc: '5499', evidence: EV }, risk: { tiers: ['medium', 'high'], evidence: EV } },
    stage2: { codes: { 5999: { acceptable: false, evidence: EV }, 5499: { acceptable: true, evidence: EV } } },
  });
  assert.equal(run.answer.parameters.properties.codes.maxItems, 2);
});

test('the run: an unjudgeable site gets no candidates and takes an empty verdict', async () => {
  const run = adjudicatorRun({ candidates: candidatesOf({ merchantId: 'm2', codes: ['5999'], salt: SALT, groups }), groups });
  const [site, codes] = run.tools;
  assert.equal((await site.run({ unjudgeable: 'the domain is parked' })).recorded, true);
  assert.deepEqual((await codes.run({})).candidates, []);
  assert.deepEqual(run.problems({ codes: [{ code: '5999', acceptable: true, evidence: EV }] }), ['the site was judged unjudgeable: give no codes']);
  assert.deepEqual(run.record({ codes: [] }), { stage1: { unjudgeable: 'the domain is parked' }, stage2: { codes: {} } });
});

test('unblind: a side is right on the code when its code was judged acceptable, on the tier when its tier is allowed', () => {
  const items = [
    { merchant: merchant('a', { mcc: '5999', riskTier: null }), answer: { mcc: '5499', riskTier: 'high' } },
    { merchant: merchant('b', { mcc: '3504', riskTier: 'low' }), answer: { mcc: '7011', riskTier: 'medium' } },
    { merchant: merchant('c', { mcc: '5999' }), answer: { mcc: null, riskTier: null } },
  ];
  const stage1 = {
    a: { own: { mcc: '5499', evidence: EV }, risk: { tiers: ['medium', 'high'], evidence: EV } },
    b: { own: { mcc: '3504', evidence: EV }, risk: { tiers: ['low'], evidence: EV } },
    c: { unjudgeable: 'parked' },
  };
  const stage2 = {
    a: { codes: { 5999: { acceptable: false, evidence: EV }, 5499: { acceptable: true, evidence: EV } } },
    b: { codes: { 3504: { acceptable: true, evidence: EV }, 7011: { acceptable: true, evidence: EV } } },
  };
  const { learner, teacher, unjudgeable } = unblind({ items, stage1, stage2 });
  assert.deepEqual(learner[0], { merchantId: 'a', vertical: 'nutra', side: 'learner', mccAdjRight: true, mccOwnExact: true, riskAdjRight: true, riskAdjDistance: 0, adjRight: true });
  assert.deepEqual(teacher[0], { merchantId: 'a', vertical: 'nutra', side: 'teacher', mccAdjRight: false, mccOwnExact: false, riskAdjRight: null, riskAdjDistance: null, adjRight: null });
  assert.deepEqual([learner[1].mccAdjRight, learner[1].mccOwnExact, learner[1].riskAdjRight, learner[1].riskAdjDistance], [true, true, false, 1], 'the general 7011 matches the adjudicator\'s own brand code 3504');
  assert.deepEqual([teacher[1].mccAdjRight, teacher[1].riskAdjRight, teacher[1].adjRight], [true, true, true]);
  assert.deepEqual(unjudgeable, [{ merchantId: 'c', reason: 'parked' }]);
  const noCode = unblind({ items: [{ merchant: merchant('d', { mcc: '5999' }), answer: { mcc: null } }], stage1: { d: stage1.a }, stage2: { d: { codes: { 5999: { acceptable: true, evidence: EV } } } } });
  assert.deepEqual([noCode.learner[0].mccAdjRight, noCode.learner[0].mccOwnExact], [false, false], 'no code is wrong');
  assert.throws(() => unblind({ items: items.slice(0, 1), stage1: {}, stage2 }), /no stage 1/);
  assert.throws(() => unblind({ items: items.slice(0, 1), stage1, stage2: { a: { codes: { 5999: stage2.a.codes[5999] } } } }), /5499 was not judged/);
  assert.throws(() => allowedTiers({ tiers: ['low', 'low'], evidence: EV }), /next to each other/);
});

test('the two commands end to end: the candidates file names no source and no tier; unblind writes rows and counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adjudication-'));
  try {
    const sample = [{ ...merchant('a', { mcc: '5999', riskTier: null }), order: 1 }, { ...merchant('b', { mcc: '5967', riskTier: null }), order: 2 }];
    const hand = [{ merchantId: 'a', mccAnswer: '5499', riskAnswer: 'medium' }, { merchantId: 'b', mccAnswer: '5967', riskAnswer: 'high' }];
    writeFileSync(join(dir, 'sample.json'), JSON.stringify(sample));
    writeFileSync(join(dir, 'hand.jsonl'), hand.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'salt'), `${SALT}\n`);
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, 'adjudication.mjs'), ...args], { encoding: 'utf8' }));
    assert.deepEqual(cli('candidates', join(dir, 'sample.json'), join(dir, 'salt'), join(dir, 'candidates.json'), `hand=${join(dir, 'hand.jsonl')}`), { merchants: 2, missing: { hand: 0 } });
    const text = readFileSync(join(dir, 'candidates.json'), 'utf8');
    for (const leak of ['medium', 'high', 'hand', 'teacher', 'learner', SALT]) assert.equal(text.includes(leak), false, leak);
    assert.deepEqual(JSON.parse(text).b.map((c) => c.code), ['5967'], 'a code two sides share appears once');
    const stage1 = { a: { own: { mcc: '5499', evidence: EV }, risk: { tiers: ['medium'], evidence: EV } }, b: { own: { mcc: '5967', evidence: EV }, risk: { tiers: ['high'], evidence: EV } } };
    const stage2 = { a: { codes: { 5999: { acceptable: false, evidence: EV }, 5499: { acceptable: true, evidence: EV } } }, b: { codes: { 5967: { acceptable: true, evidence: EV } } } };
    writeFileSync(join(dir, 'stage1.json'), JSON.stringify(stage1));
    writeFileSync(join(dir, 'stage2.json'), JSON.stringify(stage2));
    const summary = cli('unblind', join(dir, 'sample.json'), join(dir, 'hand.jsonl'), join(dir, 'stage1.json'), join(dir, 'stage2.json'), join(dir, 'out'));
    assert.deepEqual(summary.learner, { mccAdjRight: { k: 2, n: 2 }, mccOwnExact: { k: 2, n: 2 }, riskAdjRight: { k: 2, n: 2 }, adjRight: { k: 2, n: 2 } });
    assert.deepEqual(summary.teacher, { mccAdjRight: { k: 1, n: 2 }, mccOwnExact: { k: 1, n: 2 }, riskAdjRight: { k: 0, n: 0 }, adjRight: { k: 0, n: 0 } });
    assert.equal(readFileSync(join(dir, 'out', 'teacher.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the rubric section is cut at the next heading of its level and hashed, so it can be pinned', () => {
  const spec = '# Task\n\n## The risk rubric\n\nThe tier is the highest one any row reaches:\n- high, when ...\n### a sub-heading stays\n\n## The flags\n\n- adult\n';
  const { text, sha256 } = sectionOf(spec, '## The risk rubric');
  assert.equal(text, '## The risk rubric\n\nThe tier is the highest one any row reaches:\n- high, when ...\n### a sub-heading stays');
  assert.match(sha256, /^[0-9a-f]{64}$/);
  assert.equal(sectionOf(`${spec}\n`, '## The risk rubric').sha256, sha256);
  assert.throws(() => sectionOf(spec, '## Missing'), /no section/);
});

const body = (section) => section.text.split('\n').slice(1).join('\n').trim();
const marked = (text, start, end) => text.slice(text.indexOf(start) + start.length, text.indexOf(end)).trim();

test('the risk rubric is SPEC.md\'s word for word, in ADJUDICATION.md and in the adjudicator\'s skill', () => {
  const rubric = body(sectionOf(read('SPEC.md'), '## The risk rubric'));
  for (const tier of ['- high, when', '- medium, when no high row holds', '- low, when no other row holds']) assert.ok(rubric.includes(tier), tier);
  const protocol = read('ADJUDICATION.md');
  const open = protocol.indexOf('```text\n', protocol.indexOf('<!-- risk rubric: SPEC.md, word for word -->')) + '```text\n'.length;
  assert.equal(protocol.slice(open, protocol.indexOf('\n```', open)), rubric);
  assert.equal(body(sectionOf(read('adjudicator', 'skills', 'adjudicate-merchant', 'SKILL.md'), '# The risk rubric')), rubric);
});

test('the MCC rules are the same in ADJUDICATION.md and in the adjudicator\'s skill', () => {
  const rules = marked(read('ADJUDICATION.md'), '<!-- mcc rules: the adjudicate-merchant skill, word for word -->', '<!-- mcc rules: end -->');
  assert.ok(rules.includes('(e) An airline, car rental or lodging merchant'));
  assert.equal(body(sectionOf(read('adjudicator', 'skills', 'adjudicate-merchant', 'SKILL.md'), '# The MCC rules')), rules);
});

test('the adjudicator\'s home: the web tools, the code tables, site, codes and answer; no learning; a run cap', () => {
  const agent = JSON.parse(read('adjudicator', 'agent.json'));
  assert.deepEqual(agent.skills, ['adjudicate-merchant']);
  assert.deepEqual(agent.tools, ['search_web', 'browse', 'fetch_page', 'read_document', 'mcc_groups', 'mcc_codes', 'site', 'codes', 'answer']);
  assert.ok(agent.max_cost_usd <= 3);
  const rules = read('adjudicator', 'AGENTS.md');
  for (const words of [/record both with `site`/, /Then call `codes`/, /calling `answer` once/, /Do not guess it and do not look for it/]) assert.match(rules, words);
  assert.equal(/learn,|agentrun|workflow tool/.test(agent.tools.join(',')), false);
});
