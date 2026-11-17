// `quote_missing`: a code check that the quotes an answer gives as evidence are in the pages this run fetched. A judge
// asked "are these quotes verbatim runs of the pages?" flagged 149 of 170 answers on one bench, while read against the
// fetched pages 416 of 429 quotes were there: verbatim, or equal once case, curly quotes, dashes and whitespace are
// normalised, or once both sides are read as their letters and digits alone. Code tells the 4.7% of answers carrying a
// quote no page holds from the rest; a judge could not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, validateWorkflow, predicateMatches } from '../dist/index.js';

const PAGE = 'Acme Leather — “Hand-made wallets and belts, shipped worldwide.”\n\n  Our   workshop has been in Lisbon since 1987.';
const OTHER_PAGE = 'Beta Toys sells plastic toys and board games for children of all ages.';
const check = (extra = {}) => ({ predicate: 'quote_missing', path: 'answer.evidence', field: 'quote', pages: ['page'], ...extra });
const holds = (quotes, page = PAGE, extra = {}) => predicateMatches(check(extra), { answer: { evidence: quotes.map((quote) => ({ quote, url: 'https://acme.example' })) }, page: { text: page } });

test('a quote found in the page, verbatim or after normalisation, does not hold', () => {
  assert.equal(holds(['Hand-made wallets and belts']), false, 'verbatim, inside curly quotes');
  assert.equal(holds(['our workshop has been in lisbon']), false, 'case and a run of spaces');
  assert.equal(holds(['"Hand-made wallets and belts, shipped worldwide."']), false, 'straight quotes for curly ones');
  assert.equal(holds(['Acme Leather - "Hand-made']), false, 'a hyphen for the em dash');
  assert.equal(holds(['‘Our workshop’ has been']), false, 'curly single quotes on the quote side');
});

test('a quote that differs from the page only in punctuation is found by the loose pass', () => {
  assert.equal(holds(['wallets and belts shipped worldwide']), false, 'the comma dropped');
  assert.equal(holds(['in Lisbon, since 1987!']), false, 'punctuation added');
  assert.equal(holds(['Hand made wallets']), false, 'a space for the hyphen');
});

test('a quote in no page holds; one missing quote among found ones is enough', () => {
  assert.equal(holds(['sells cheap plastic toys']), true);
  assert.equal(holds(['Hand-made wallets and belts', 'Our workshop opened in Porto']), true);
  assert.equal(holds(['Hand-made wallets and belts', 'shipped worldwide']), false);
});

test('a quote shorter than 8 characters, an empty one, an empty list and an absent answer are not checked', () => {
  assert.equal(holds(['Porto!']), false, 'six characters, missing: too short to say where it came from');
  assert.equal(holds(['  belts\n ']), false, 'short once normalised');
  assert.equal(holds(['']), false);
  assert.equal(holds([]), false);
  assert.equal(predicateMatches(check(), { page: { text: PAGE } }), false, 'no answer');
  assert.equal(predicateMatches(check(), { answer: { evidence: [{ url: 'x' }, { quote: 42 }, null] }, page: { text: PAGE } }), false, 'no string quote');
});

test('every string under each page path is page text; a quote list without a field is a list of strings', () => {
  const state = { answer: { quotes: ['wallets and belts', 'board games for children'] }, home: { result: { page: { text: PAGE } } }, found: [{ snippet: 'x' }, { content: [OTHER_PAGE] }] };
  assert.equal(predicateMatches({ predicate: 'quote_missing', path: 'answer.quotes', pages: ['home', 'found'] }, state), false);
  assert.equal(predicateMatches({ predicate: 'quote_missing', path: 'answer.quotes', pages: ['home'] }, state), true, 'the second quote is only on the other page');
  assert.equal(predicateMatches({ predicate: 'quote_missing', path: 'answer.quotes', pages: ['nowhere'] }, state), true, 'no page fetched: every quote is missing');
});

test('each page string is read alone: a quote running from the end of one into the start of the next is in no page', () => {
  const state = (quotes) => ({ answer: { quotes }, home: { text: 'Hand-made wallets and belts. Our workshop' }, about: { text: 'opened in Porto in 2004, and moved to Lisbon.' } });
  const missing = (quotes, pages = ['home', 'about']) => predicateMatches({ predicate: 'quote_missing', path: 'answer.quotes', pages }, state(quotes));
  assert.equal(missing(['Our workshop opened in Porto']), true, 'across two pages');
  assert.equal(missing(['our workshop, opened in porto']), true, 'the loose pass reads each page alone too');
  assert.equal(missing(['Hand-made wallets', 'opened in Porto in 2004']), false, 'each in one page');
  assert.equal(predicateMatches({ predicate: 'quote_missing', path: 'answer.quotes', pages: ['home'] }, { answer: { quotes: ['belts our workshop'] }, home: ['Hand-made wallets and belts', 'Our workshop'] }), true, 'two strings of one page');
});

test('not quote_missing holds when every quote is found', () => {
  assert.equal(predicateMatches({ predicate: 'not', of: check() }, { answer: { evidence: [{ quote: 'wallets and belts' }] }, page: { text: PAGE } }), true);
});

// The answer is the run's input; the page is what this run's call node fetched (runEffect).
const flow = () => ({
  v: 2, name: 'cite', schemas: {
    In: { type: 'object', required: ['url', 'answer'], properties: { url: { type: 'string' }, answer: { type: 'object' } } },
    Page: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    Any: { type: 'object' },
  },
  input: { schemaId: 'In' }, output: { schemaId: 'Any', path: 'answer' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'fetch', via: 'tool', tool: 'web.browse', args: { url: '{url}' }, out: 'Page', as: 'page', deadline_s: 10 },
    { node: 'escalate', label: 'quotes', when: check(), kind: 'quote_missing', stage: 'answer', summary: 'a quote is in no page this run fetched' },
  ] },
});
const answerOf = (...quotes) => ({ mcc: '5948', evidence: quotes.map((quote) => ({ quote, url: 'https://acme.example' })) });
const run = (answer, page, deps = {}) => {
  const events = [];
  return runWorkflow(flow(), { url: 'https://acme.example', answer }, { runEffect: async () => ({ text: page }), onEvent: (event) => events.push(event), ...deps }).then((result) => ({ result, events, evaluated: events.find((event) => event.type === 'escalate.evaluated') }));
};

test('a missing quote escalates the run; its event says how many quotes were checked and missed, never their text', async () => {
  const { result, evaluated } = await run(answerOf('Hand-made wallets and belts', 'Our workshop opened in Porto', 'ok'), PAGE);
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.kind, 'quote_missing');
  assert.equal(evaluated.detail.fired, true);
  assert.equal(evaluated.detail.quotes_checked, 2, 'the short quote is not checked');
  assert.equal(evaluated.detail.quotes_missed, 1);
  const said = JSON.stringify(evaluated);
  for (const text of ['wallets', 'Porto', 'Lisbon', 'Acme']) assert.equal(said.includes(text), false, `the event carries no quote or page text (${text})`);
  const clean = await run(answerOf('Hand-made wallets and belts', 'in Lisbon since 1987'), PAGE);
  assert.equal(clean.result.status, 'complete');
  assert.deepEqual([clean.evaluated.detail.fired, clean.evaluated.detail.quotes_checked, clean.evaluated.detail.quotes_missed], [false, 2, 0]);
});

test('a quote from a page another run fetched is a miss: only this run\'s state is read', async () => {
  const quote = 'board games for children of all ages';
  assert.equal((await run(answerOf(quote), OTHER_PAGE)).result.status, 'complete', 'the run that fetched it');
  assert.equal((await run(answerOf(quote), PAGE)).result.status, 'escalated', 'a run that fetched another page');
});

const errorsOf = (when) => {
  const doc = flow();
  doc.root.steps[1].when = when;
  const checked = validateWorkflow(doc, { input: { url: 'u', answer: {} } });
  return checked.ok ? [] : checked.errors;
};

test('validation: a path, a non-empty pages list of paths this run produces, and no page path inside the quotes', () => {
  assert.deepEqual(errorsOf(check()), []);
  assert.deepEqual(errorsOf({ predicate: 'not', of: check() }), [], 'a mechanical predicate: not takes it');
  assert.match(errorsOf(check({ path: '' })).join('\n'), /quote_missing needs a path/);
  assert.match(errorsOf(check({ pages: [] })).join('\n'), /quote_missing needs pages/);
  assert.match(errorsOf(check({ pages: ['page', ''] })).join('\n'), /quote_missing needs pages/);
  assert.match(errorsOf(check({ field: '' })).join('\n'), /quote_missing\.field/);
  assert.match(errorsOf(check({ pages: ['answer'] })).join('\n'), /reads its quotes as a page/);
  assert.match(errorsOf(check({ pages: ['answer.evidence.0'] })).join('\n'), /reads its quotes as a page/);
  assert.match(errorsOf(check({ pages: ['fetched'] })).join('\n'), /reads "fetched" but no input key or earlier node produces "fetched"/);
});

test('a poll waiting on not quote_missing reads its pages from the declared result: one outside it is refused, as its path is', () => {
  const pollOn = (pages) => {
    const doc = flow();
    doc.schemas.Draft = { type: 'object', properties: { quotes: { type: 'array', items: { type: 'string' } }, text: { type: 'string' } } };
    doc.root.steps = [{ node: 'call', label: 'draft', via: 'tool', tool: 'drafts.get', args: { url: '{url}' }, out: 'Draft', as: 'draft', deadline_s: 5, poll: { until: { predicate: 'not', of: { predicate: 'quote_missing', path: 'quotes', pages } }, interval_s: 1, deadline_s: 5 } }];
    doc.output.path = 'draft';
    const checked = validateWorkflow(doc, { input: { url: 'u', answer: {} } });
    return checked.ok ? [] : checked.errors;
  };
  assert.deepEqual(pollOn(['text']), []);
  assert.match(pollOn(['text', 'body']).join('\n'), /poll\.until pages "body" is not in the declared result shape \(quotes, text\); every quote would miss and the poll could never settle/);
});
