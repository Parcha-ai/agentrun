// The MCC job's structural receipt: the answer's MCC quote, word for word, on an ok page of the merchant's own registrable
// domain (or the marketplace listing its website names), and that page cited for the MCC claim. Anything else is no
// receipt: an off-domain page, a paraphrase, a failed fetch, a cite on another page.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLoop, scriptedParts } from './runner.mjs';
import { fixtureWeb, scriptedModel } from './scripted.mjs';
import { FIXTURES_MCC } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';
import { ANY_HOST, fetchPageTool } from './tools.mjs';
import {
  answerToolMcc, folded, jobInputMcc, merchantPage, merchantPagesOnly, merchantScope, merchantTouchOf, mccCodesTool, mccGroupsTool, partsOfMcc, quoteOnPage, receiptOfMcc, refusingHosts,
  registrableDomain, rowOfMcc, wrongFieldsMcc,
} from './mcc.mjs';

const SITE = 'https://www.lumencandle.co.uk/';
const ABOUT = 'https://shop.lumencandle.co.uk/about';
const REVIEW = 'https://www.candle-reviews.com/lumen';
const QUOTE = 'We pour hand-made soy wax candles in small batches';
const merchant = { id: 'm-0001', name: 'Lumen Candle Co', website: SITE };
const page = (url, text, extra = {}) => ({ ok: true, url, status: 200, title: 'Lumen', text, ...extra });

/** Recording lines as recordingLines gives them: the root agent's reads and results, then its answer. */
function rootRun(reads, answer, tool = 'fetch_page') {
  const lines = [];
  reads.forEach(({ url, value }, i) => {
    lines.push({ kind: 'pi.assistant', conv: 1, data: { model: [{ content: [{ type: 'toolCall', id: `c${i}`, name: tool, arguments: { url } }] }] } });
    lines.push({ kind: 'pi.tool-result', conv: 1, data: { model: [{ toolName: tool, toolCallId: `c${i}`, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }] } });
  });
  lines.push({ kind: 'pi.assistant', conv: 1, data: { model: [{ content: [{ type: 'toolCall', id: 'ans', name: 'answer', arguments: answer }] }] } });
  return lines;
}
const answerCiting = (url, quote = QUOTE, mcc = '5999') => ({ mcc, mccDescription: 'Miscellaneous', riskTier: 'low', riskRationale: 'r', flags: [], siteStatus: 'live', confidence: 0.8, evidence: [{ claim: 'mcc', url, quote }, { claim: 'risk', url, quote }] });

test('a receipt: the quote is word for word on the merchant\'s own page, and that page is cited for the MCC', () => {
  const text = `Lumen Candle Co. ${QUOTE}, poured in Bristol.`;
  const answer = answerCiting(ABOUT);
  assert.deepEqual(receiptOfMcc(rootRun([{ url: ABOUT, value: page(ABOUT, text) }], answer), answer, merchant), { url: ABOUT, kind: 'merchant', mcc: '5999', byWorkflow: false });
});

test('no receipt: the quote is verbatim but on an off-domain page', () => {
  const answer = answerCiting(REVIEW);
  assert.equal(receiptOfMcc(rootRun([{ url: REVIEW, value: page(REVIEW, QUOTE) }], answer), answer, merchant), null);
});

test('no receipt: a paraphrase of the page, a quote with an elision, or one cut inside a word', () => {
  const lines = (answer) => rootRun([{ url: ABOUT, value: page(ABOUT, `${QUOTE}, poured in Bristol.`) }], answer);
  for (const quote of ['We make soy wax candles by hand in small batches', 'We pour hand-made ... in small batches', 'e pour hand-made soy wax candles']) {
    const answer = answerCiting(ABOUT, quote);
    assert.equal(receiptOfMcc(lines(answer), answer, merchant), null, quote);
  }
});

test('no receipt: the fetch failed, was refused, or came back 404', () => {
  for (const value of [{ ok: false, url: ABOUT, status: 0, title: '', text: QUOTE }, { ok: false, url: ABOUT, refused: 'not allowed', text: QUOTE }, page(ABOUT, QUOTE, { status: 404 })]) {
    const answer = answerCiting(ABOUT);
    assert.equal(receiptOfMcc(rootRun([{ url: ABOUT, value }], answer), answer, merchant), null, JSON.stringify(value));
  }
});

test('no receipt: the quote is on the merchant\'s page but the MCC cite names another page, or there is no MCC cite', () => {
  const reads = [{ url: ABOUT, value: page(ABOUT, QUOTE) }, { url: REVIEW, value: page(REVIEW, 'a review') }];
  const other = answerCiting(REVIEW);
  assert.equal(receiptOfMcc(rootRun(reads, other), other, merchant), null);
  const riskOnly = { ...answerCiting(ABOUT), evidence: [{ claim: 'risk', url: ABOUT, quote: QUOTE }] };
  assert.equal(receiptOfMcc(rootRun(reads, riskOnly), riskOnly, merchant), null);
});

test('no receipt: a page asked for on the merchant\'s site that redirected off it, or a quote of two words', () => {
  const redirected = page('https://www.candle-reviews.com/lumen', QUOTE);
  const answer = answerCiting(ABOUT);
  assert.equal(receiptOfMcc(rootRun([{ url: ABOUT, value: redirected }], answer), answer, merchant), null);
  const short = answerCiting(ABOUT, 'soy candles');
  assert.equal(receiptOfMcc(rootRun([{ url: ABOUT, value: page(ABOUT, 'soy candles') }], short), short, merchant), null);
});

test('a receipt by a workflow: a call node\'s read of the merchant\'s page holds the quote', () => {
  const lines = [{ kind: 'agentrun.effects', data: { key: 'e1', value: { intent: { tool: 'fetch_page' }, status: 'completed', args: { url: SITE }, result: { value: page(SITE, `Welcome. ${QUOTE}.`) } } } }];
  const answer = answerCiting(SITE);
  assert.deepEqual(receiptOfMcc(lines, answer, merchant), { url: SITE, kind: 'merchant', mcc: '5999', byWorkflow: true });
  assert.deepEqual(merchantTouchOf(lines, merchant), { touched: true, byWorkflow: true });
});

test('a marketplace listing: only pages under the listing the website names are the merchant\'s own', () => {
  const shop = { id: 'm-0002', name: 'Fern & Kiln', website: 'https://www.etsy.com/shop/FernAndKiln' };
  const listed = 'https://www.etsy.com/shop/FernAndKiln?section_id=2';
  const elsewhere = 'https://www.etsy.com/shop/SomeoneElse';
  const quote = 'Wheel-thrown stoneware mugs and planters';
  const ok = answerCiting(listed, quote, '5719');
  assert.deepEqual(receiptOfMcc(rootRun([{ url: listed, value: page(listed, quote) }], ok), ok, shop), { url: listed, kind: 'marketplace', mcc: '5719', byWorkflow: false });
  const off = answerCiting(elsewhere, quote, '5719');
  assert.equal(receiptOfMcc(rootRun([{ url: elsewhere, value: page(elsewhere, quote) }], off), off, shop), null);
  assert.equal(merchantScope('https://www.etsy.com/'), null, 'a marketplace home names no listing');
});

test('registrable domains: two-label suffixes keep three labels, a shop platform keeps the shop\'s subdomain', () => {
  assert.equal(registrableDomain('shop.lumencandle.co.uk'), 'lumencandle.co.uk');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('fern-kiln.myshopify.com'), 'fern-kiln.myshopify.com');
  assert.equal(registrableDomain('myshopify.com'), null);
  const scope = merchantScope('https://fern-kiln.myshopify.com/');
  assert.equal(merchantPage('https://fern-kiln.myshopify.com/pages/about', scope), true);
  assert.equal(merchantPage('https://other-shop.myshopify.com/', scope), false, 'another shop on the same platform is off-domain');
  assert.equal(merchantPage('https://lumencandle.co.uk.evil.com/', merchantScope(SITE)), false);
});

test('a quote is compared with URLs out and whitespace folded, nothing else: case and every word count', () => {
  assert.equal(folded('We\u2019re  OPEN\n daily https://x.y/z'), 'We\u2019re OPEN daily');
  assert.equal(quoteOnPage('\u201CWe pour hand-made soy wax candles.\u201D', '<p>We pour  hand-made\nsoy wax candles</p>'), true);
  assert.equal(quoteOnPage('we pour hand-made soy wax candles', 'We pour hand-made soy wax candles'), false, 'case is the page\'s');
  assert.equal(quoteOnPage('We pour hand-made soy wax candle', 'We pour hand-made soy wax candles'), false);
});

test('the tools: the input is the name and website only; mcc_groups and mcc_codes; sites listing codes are refused', async () => {
  assert.deepEqual(jobInputMcc({ ...merchant, vertical: 'Home', teacher: { mcc: '5999' } }), { name: 'Lumen Candle Co', website: SITE });
  assert.deepEqual((await mccGroupsTool([{ from: '5900', to: '5999', name: 'Miscellaneous stores' }]).run()).groups, [{ code: '5900-5999', name: 'Miscellaneous stores' }]);
  const codes = mccCodesTool({ 5999: 'Miscellaneous retail', 5719: 'Miscellaneous home furnishing', 4511: 'Airlines' });
  assert.deepEqual((await codes.run({ group: '5700-5799' })).codes, [{ code: '5719', name: 'Miscellaneous home furnishing' }]);
  const [fetchPage, search] = refusingHosts([
    { name: 'fetch_page', run: async ({ url }) => ({ ok: true, url, text: 'read' }) },
    { name: 'search_web', run: async () => ({ ok: true, results: [{ url: 'https://lookup.mcc-list.example/lumen' }, { url: SITE }], filtered: 0 }) },
  ], ['mcc-list.example']);
  assert.match((await fetchPage.run({ url: 'https://www.mcc-list.example/x' })).refused, /lists merchants' codes/);
  assert.equal((await fetchPage.run({ url: SITE })).ok, true);
  assert.deepEqual(await search.run({ query: 'lumen' }), { ok: true, results: [{ url: SITE }], filtered: 1 });
});

test('a hindsight review on an MCC run opens only the merchant\'s own pages', async () => {
  const [tool] = merchantPagesOnly([{ name: 'fetch_page', run: async ({ url }) => ({ ok: true, url, text: 'read' }) }], merchant);
  assert.equal((await tool.run({ url: ABOUT })).ok, true);
  assert.match((await tool.run({ url: REVIEW })).refused, /merchant's own pages/);
});

test('the answer tool refuses what answerProblems finds; the gate parts, the teacher-labelled wrong fields and the row', () => {
  const tool = answerToolMcc({ 5999: 'Miscellaneous retail', 5719: 'Miscellaneous home furnishing' });
  assert.deepEqual(tool.parameters.properties.mcc.enum, ['5719', '5999']);
  assert.deepEqual(tool.problems({ ...answerCiting(SITE), mccDescription: 'Miscellaneous retail' }), []);
  assert.match(tool.problems(answerCiting(SITE)).join(';'), /mccDescription is not 5999's title/);
  const score = { mccAnswer: '5999', mccTeacher: '5719', mccCorrect: false, mccGroupCorrect: true, riskAnswer: 'low', riskTeacher: 'low', riskCorrect: true, riskDistance: 0, correct: false, correctOver: ['mcc', 'risk'] };
  assert.deepEqual(partsOfMcc(score), { mcc: 0, risk: 1 });
  assert.deepEqual(partsOfMcc({ ...score, riskCorrect: null }), { mcc: 0, risk: null });
  assert.deepEqual(wrongFieldsMcc(score, undefined, { codes: { 5719: 'Miscellaneous home furnishing' } }), [{ field: 'mcc', answer: '5999', truth: '5719', truthTitle: 'Miscellaneous home furnishing', label: 'teacher' }]);
  const row = rowOfMcc({ run: 3, cik: 'm-0001', sic4Answer: null, segmentsF1: null, costUsd: 0.1 }, score);
  assert.equal(row.set, 'mcc');
  assert.equal(row.label, 'teacher');
  assert.equal(row.merchantId, 'm-0001');
  assert.equal(row.correct, false);
  assert.deepEqual([row.answer, row.truth], ['5999', '5719']);
  assert.equal('sic4Answer' in row || 'segmentsF1' in row, false);
});

// ---------------------------------------------------------------- the runner's --set mcc at $0, on fixtures-mcc

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-mcc-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.merchantId, r]));

test('a scripted MCC pass: rows labelled the teacher\'s; a receipt only for the quote on the merchant\'s own page; the grown revision promoted by receipt and gated on the bank', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.mcc });
  Object.assign(parts, { receiptAdmission: true, receiptHoldsTrial: true, receiptPromotion: true, promoteNoFloor: true, thresholds: { promoteAfter: 2 }, bank: ['m-011', 'm-012', 'm-013', 'm-014'].map((id) => ({ id })) });
  const list = ['m-001', 'm-007', 'm-008', 'm-009', 'm-010', 'm-002', 'm-004'].map((id) => ({ id }));
  const { rows } = await runLoop({ out, parts, split: 'train', list, record: false, gateWaitAtEnd: true });
  assert.ok(rows.every((r) => r.set === 'mcc' && r.label === 'teacher'));
  const r = byId(rows);
  assert.deepEqual(r['m-001'].receipt, { url: 'https://lumencandle.example/', kind: 'merchant', mcc: '5999', byWorkflow: false });
  for (const id of ['m-007', 'm-008', 'm-009']) assert.equal(r[id].receipt, null, `${id}: a paraphrase, an off-domain cite, a site that did not load`);
  assert.deepEqual(r['m-010'].receipt, { url: 'https://fernandkiln.myshopify.com/', kind: 'merchant', mcc: '5719', byWorkflow: true });
  // m-002 saves classify-merchant grown by a browser read; m-004's site reads only in a browser, so the grown trial
  // answers it, with a workflow receipt, and is promoted at once over the serving revision; the bank gate then compares
  // the two on two parts (code and tier) of four bank merchants.
  assert.equal(r['m-004'].receipt.byWorkflow, true);
  assert.deepEqual(r['m-004'].curate.promoted, ['classify-merchant']);
  const [verdict] = readFileSync(join(out, 'gate', 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([verdict.name, verdict.cells, verdict.companies, verdict.first], ['classify-merchant', 8, 4, false]);
  // The teacher disagrees with no answer here, so every scored row agrees on the code.
  assert.ok(rows.every((row) => row.mccCorrect === true));
});

test('hindsight on an MCC run: a teacher disagreement gets one reflection, shown as the teacher\'s label; it reads only the merchant\'s pages, so its lessons are its own work, and one naming the teacher\'s code is refused', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.mcc });
  const pages = JSON.parse(readFileSync(join(FIXTURES_MCC, 'pages.json'), 'utf8'));
  const SITE_005 = 'https://paperlanterngifts.example/';
  const hypotheses = [
    { lesson: 'A shop whose own pages sell cards and wrapping as well as gifts takes the code for the larger line by what it says it sells most.', why: 'the run picked the gift code', whereReadable: 'the shop\'s own home page', scope: 'card and gift shops', mechanism: 'lesson', test: 'replay card shops' },
    { lesson: 'Card and gift shops are 5999.', why: 'the teacher said so', whereReadable: 'the home page', scope: 'card shops', mechanism: 'lesson', test: 'replay' },
  ];
  const prompts = [];
  parts.hindsight = {
    fields: ['mcc', 'risk'],
    model: () => {
      const model = scriptedModel({ root: [{ call: 'fetch_page', args: { url: SITE_005 } }, { call: 'fetch_page', args: { url: 'https://furniture-reviews.example/oakline' } }, { call: 'answer', args: { hypotheses } }] });
      prompts.push(model.requests);
      return model;
    },
    tools: async (job) => merchantPagesOnly([fetchPageTool({ allowDomain: ANY_HOST, fetch: fixtureWeb(pages), lookup: async () => [{ address: '93.184.216.34', family: 4 }] })], job),
  };
  const { rows } = await runLoop({ out, parts, split: 'train', list: [{ id: 'm-005' }], record: false });
  const [row] = rows;
  assert.deepEqual([row.mccAnswer, row.mccTeacher, row.mccCorrect, row.riskCorrect], ['5947', '5999', false, true]);
  const [reflection] = row.hindsight.reflections;
  assert.deepEqual([reflection.field, reflection.label, reflection.hypotheses], ['mcc', 'teacher', 2]);
  const prompt = JSON.stringify(prompts[0][0].messages);
  assert.match(prompt, /The teacher's value \(another agent's label, not ground truth\): 5999/);
  assert.match(prompt, /classify the merchant Paper Lantern Gifts/);
  assert.deepEqual(row.hindsight.proposals.map((p) => [p.status, p.untrusted, p.reasons]), [['proposed', false, undefined], ['refused', false, ['case_data']]]);
});
