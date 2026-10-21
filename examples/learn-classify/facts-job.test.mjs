// The facts pass's job: its rules and its answer, one frozen read per company that every SIC replay arm reads.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import { answerFacts, FACTS_RULES } from './facts-job.mjs';
import { FIXTURES_V2, FIXTURES_V4, readJson } from './scripted.mjs';

const ajv = new Ajv({ strict: false, allErrors: true });
const at = (url, locator, quote) => ({ url, locator, quote });
const REPORT = 'https://ir.acme.example/ar-2025.pdf';
const FACTS = {
  report: { form: '10-K', fiscalYear: 2025, periodEnd: '2025-12-31', ...at(REPORT, 'pdf p. 1', 'ANNUAL REPORT PURSUANT TO SECTION 13 OR 15(d) ... For the fiscal year ended December 31, 2025') },
  cover: { name: 'Acme Corporation', city: 'Springfield', state: 'Illinois', country: 'United States', ...at(REPORT, 'pdf p. 1', 'Principal executive offices: 1 Main St, Springfield, Illinois') },
  item1: { text: 'We design, manufacture and sell industrial valves and pumps to utilities and process plants.', url: REPORT, locator: 'pdf p. 4' },
  segments: { list: [{ name: 'Valves', revenue: 700, share: 0.7 }, { name: 'Pumps', revenue: 300, share: 0.3 }], total: 1000, ...at(REPORT, 'pdf p. 61', 'Valves 700 Pumps 300 Total 1,000') },
  largestLine: { name: 'Valves', revenue: 700, share: 0.7, basis: 'segment', ...at(REPORT, 'pdf p. 61', 'Valves 700') },
  revenueLines: { none: true },
};

test('the facts answer takes the six facts with their page and words, and has no place for a code', () => {
  const tool = answerFacts();
  const valid = ajv.compile(tool.parameters);
  assert.ok(valid(FACTS), ajv.errorsText(valid.errors));
  assert.deepEqual(tool.parameters.required, ['report', 'cover', 'item1', 'segments', 'largestLine', 'revenueLines']);
  assert.ok(valid({ ...FACTS, segments: { oneSegment: true, ...at(REPORT, 'pdf p. 61', 'We operate as one reportable segment.') } }));
  assert.ok(valid({ ...FACTS, revenueLines: { list: [{ name: 'Gate valves', revenue: 400, share: 0.4 }], ...at(REPORT, 'pdf p. 58', 'Gate valves 400') } }));
  for (const [what, facts] of [
    ['a code', { ...FACTS, sic4: '3491' }],
    ['a code in a fact', { ...FACTS, cover: { ...FACTS.cover, sic: '3491' } }],
    ['a quote over 300 characters', { ...FACTS, cover: { ...FACTS.cover, quote: 'x'.repeat(301) } }],
    ['an Item 1 opening over 800 characters', { ...FACTS, item1: { ...FACTS.item1, text: 'x'.repeat(801) } }],
    ['a fact with no page', { ...FACTS, largestLine: { ...FACTS.largestLine, locator: undefined } }],
    ['a basis that is neither', { ...FACTS, largestLine: { ...FACTS.largestLine, basis: 'guess' } }],
    ['more than 12 lines', { ...FACTS, revenueLines: { list: Array.from({ length: 13 }, (_, i) => ({ name: `l${i}`, revenue: 1, share: 0.01 })), ...at(REPORT, 'pdf p. 58', 'x') } }],
  ]) assert.equal(valid(JSON.parse(JSON.stringify(facts))), false, what);
  const words = JSON.stringify(tool.parameters).toLowerCase();
  for (const word of ['sic', 'naics', 'industry code', 'edgar']) assert.equal(words.includes(word), false, word);
  assert.equal(tool.recorded(FACTS), REPORT);
});

test('the facts rules name every fact and where it comes from, record no code, and name no company', () => {
  const rules = FACTS_RULES.replace(/\s+/g, ' ');
  for (const words of [/latest annual report \(a 10-K, or a 20-F or 40-F for a foreign filer\)/, /its URL, its form, the fiscal year it covers and the end of that year/,
    /the registrant's name and its principal executive offices as the cover states them/, /the opening of Item 1 Business/, /at most 800 characters, word for word/,
    /every reportable segment with its revenue and its share of total revenue, and the total; or that the company reports one segment/,
    /the largest revenue line/, /when the reportable segments are regions/, /at most 12/, /quote of at most 300 characters/,
    /Record no industry code or classification of any kind/]) assert.match(rules, words);
  const fixtures = [...readJson(join(FIXTURES_V4, 'companies-v4.json')), ...readJson(join(FIXTURES_V2, 'companies-v2.json'))];
  for (const c of fixtures) for (const word of [c.name.split(' ')[0], c.ticker]) assert.doesNotMatch(FACTS_RULES, new RegExp(`\\b${word}\\b`), word);
});
