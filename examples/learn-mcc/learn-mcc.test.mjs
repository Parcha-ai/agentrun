// learn-mcc at $0: the answer's shape and the checks across its fields, then the learner's home: AGENTS.md states only
// what the answer is, the classify-merchant skill holds the methods and the one risk rubric SPEC.md states, and the
// learning rules and the workflows skill are learn-classify v4's (the SEC home's) for a merchant.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import { answerMcc, answerProblems, CLAIMS, FLAGS, JOB_INPUT, MAX_EVIDENCE, RISK_TIERS, SITE_STATUSES } from './answer.mjs';

const HOME = join(import.meta.dirname, 'agent-mcc');
const SEC_HOME = join(import.meta.dirname, '..', 'learn-classify', 'agent-v4-edgar');
const read = (...path) => readFileSync(join(...path), 'utf8');
const flat = (body) => body.replace(/\s+/g, ' ').trim();
const between = (body, from, to) => body.slice(body.indexOf(from), to === undefined ? undefined : body.indexOf(to, body.indexOf(from) + from.length));

// A few codes in the table's shape (code to title), for the schema alone.
const CODES = { 5411: 'Grocery Stores, Supermarkets', 5499: 'Miscellaneous Food Stores', 5968: 'Direct Marketing - Continuity/Subscription Merchant', 7997: 'Clubs - Country Clubs, Membership' };

const ANSWER = {
  mcc: '5499', mccDescription: CODES[5499], riskTier: 'medium',
  riskRationale: 'It sells boxed snacks on a monthly plan, disclosed at checkout, with no trial that turns into billing.',
  flags: ['subscription'], siteStatus: 'live', confidence: 0.82,
  evidence: [
    { claim: 'mcc', url: 'https://www.snackbox.example/shop', quote: 'Curated snack boxes, shipped every month.' },
    { claim: 'risk', url: 'https://www.snackbox.example/terms', quote: 'Your plan renews monthly until you cancel.' },
    { claim: 'subscription', url: 'https://www.snackbox.example/terms', quote: 'Your plan renews monthly until you cancel.' },
  ],
};

test('the answer: a code from mcc_codes and its title, a tier, flags from the list, the site, 1 to 10 verbatim items, a confidence', () => {
  const tool = answerMcc(CODES);
  const validate = new Ajv({ strict: false, allErrors: true }).compile(tool.parameters);
  const ok = (value) => { const valid = validate(value); return valid || validate.errors.map((e) => `${e.instancePath} ${e.message}`).join('; '); };
  assert.deepEqual(Object.keys(tool.parameters.properties), ['mcc', 'mccDescription', 'riskTier', 'riskRationale', 'flags', 'siteStatus', 'evidence', 'confidence']);
  assert.equal(ok(ANSWER), true);
  assert.equal(ok({ ...ANSWER, flags: [] }), true, 'no flag is an answer');
  assert.equal(ok({ ...ANSWER, siteStatus: 'parked', confidence: 0 }), true);
  for (const [why, wrong] of [
    ['a code not in mcc_codes', { ...ANSWER, mcc: '9999' }],
    ['a code as a number', { ...ANSWER, mcc: 5499 }],
    ['a tier of another name', { ...ANSWER, riskTier: 'elevated' }],
    ['a flag not on the list', { ...ANSWER, flags: ['dropshipping'] }],
    ['a site status of another name', { ...ANSWER, siteStatus: 'down' }],
    ['no evidence', { ...ANSWER, evidence: [] }],
    ['11 evidence items', { ...ANSWER, evidence: Array.from({ length: MAX_EVIDENCE + 1 }, () => ANSWER.evidence[0]) }],
    ['a quote over 300 characters', { ...ANSWER, evidence: [{ ...ANSWER.evidence[0], quote: 'x'.repeat(301) }] }],
    ['a claim of another kind', { ...ANSWER, evidence: [{ ...ANSWER.evidence[0], claim: 'vertical' }] }],
    ['an item with a locator it does not take', { ...ANSWER, evidence: [{ ...ANSWER.evidence[0], locator: 'footer' }] }],
    ['a confidence above 1', { ...ANSWER, confidence: 82 }],
    ['a rationale over 600 characters', { ...ANSWER, riskRationale: 'x'.repeat(601) }],
    ['a part left out', (({ siteStatus, ...rest }) => rest)(ANSWER)],
    ['a part it does not take', { ...ANSWER, vertical: 'food' }],
  ]) assert.notEqual(ok(wrong), true, why);
  assert.equal(tool.recorded(ANSWER), '5499');
  // Keywords some model routes refuse on the wire are not in the schema: answerProblems holds what they would.
  assert.doesNotMatch(JSON.stringify(tool.parameters), /"(contains|uniqueItems|allOf|oneOf|if|then|patternProperties)"/);
  assert.deepEqual(CLAIMS, ['mcc', 'risk', ...FLAGS]);
  assert.deepEqual([RISK_TIERS, SITE_STATUSES], [['low', 'medium', 'high'], ['live', 'unreachable', 'parked', 'other_business']]);
  assert.deepEqual([JOB_INPUT.required, Object.keys(JOB_INPUT.properties)], [['name', 'website'], ['name', 'website']], 'the input is the name and the website, nothing else');
});

test('answerProblems: the title is its code\'s, the code and the tier have evidence, each flag has evidence and evidence names only given flags', () => {
  assert.deepEqual(answerProblems(ANSWER, CODES), []);
  const cases = [
    [{ ...ANSWER, mccDescription: 'Snack boxes' }, /mccDescription is not 5499's title/],
    [{ ...ANSWER, evidence: ANSWER.evidence.filter((e) => e.claim !== 'mcc') }, /no evidence item supports mcc/],
    [{ ...ANSWER, evidence: ANSWER.evidence.filter((e) => e.claim !== 'risk') }, /no evidence item supports risk/],
    [{ ...ANSWER, flags: ['subscription', 'nutraceuticals'] }, /no evidence item supports the flag nutraceuticals/],
    [{ ...ANSWER, flags: [] }, /evidence supports subscription, which is not among the flags/],
    [{ ...ANSWER, flags: ['subscription', 'subscription'] }, /a flag is given more than once/],
  ];
  for (const [answer, problem] of cases) assert.match(answerProblems(answer, CODES).join('; '), problem);
});

test('the home: AGENTS.md and the classify-merchant and workflows skills; the workflows skill is the SEC home\'s, word for word', () => {
  const files = execFileSync('find', ['.', '-type', 'f'], { cwd: HOME, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['./AGENTS.md', './agent.json', './skills/classify-merchant/SKILL.md', './skills/workflows/SKILL.md']);
  const definition = JSON.parse(read(HOME, 'agent.json'));
  assert.deepEqual(definition.skills, ['classify-merchant', 'workflows']);
  assert.deepEqual(definition.tools, ['search_web', 'browse', 'fetch_page', 'read_document', 'mcc_groups', 'mcc_codes', 'answer', 'learn', 'agentrun']);
  assert.equal(read(HOME, 'skills', 'workflows', 'SKILL.md'), read(SEC_HOME, 'skills', 'workflows', 'SKILL.md'));
  assert.match(read(HOME, 'skills', 'classify-merchant', 'SKILL.md'), /^---\nname: classify-merchant\ndescription: .+\n---\n/);
});

test('AGENTS.md states only what the answer is: every field, the evidence rule and the skill to read, and no method', () => {
  const rules = read(HOME, 'AGENTS.md');
  const job = flat(between(rules, '## The job', '## Every run'));
  for (const words of [/its MCC, the 4-digit ISO 18245 merchant category code a card network would assign it from what it sells, a code in mcc_codes, with that code's title;/,
    /its risk tier, low, medium or high, the tier the risk rubric gives it, with the rubric's reasons in at most 600 characters;/, /the flags its own pages show/,
    /live, unreachable, parked, or another business/, /from 0 to 1, that the MCC is the one a card network would assign/, /Finish by calling answer once, with 1 to 10 evidence items\./,
    /verbatim, at most 300 characters/, /a page of the merchant's own site, or a marketplace listing that names it as the seller, that says what it sells/,
    /How to do the job by hand, and the risk rubric, are the classify-merchant skill\./]) assert.match(job, words);
  // No method: no tool to read with, no way to choose, no page to look for, nothing about memory or refusals.
  assert.doesNotMatch(job, /mcc_groups|search_web|fetch_page|browse|read_document|footer|home page|terms|refund|remember|refused|recurring|high, when/);
  // The answer's shape as the whole-job workflow returns it is the answer tool's.
  const shape = rules.match(/`\{ "mcc", [^`]*\}`/s)[0].replace(/\s+/g, ' ');
  assert.equal(shape, `\`{ ${Object.keys(answerMcc(CODES).parameters.properties).map((k) => `"${k}"`).join(', ')} }\``);
});

test('the learning rules are the SEC home\'s for a merchant: each bullet as it is there, but for the job\'s own names', () => {
  // The SEC home's rules, with its words for its own job swapped for this one's; the bullets about a website that may be
  // absent are the SEC job's alone (a merchant's website is always given), and the tools-above line names the job's tools.
  const swap = (body) => body.replaceAll('classify-company', 'merchant-mcc-risk').replaceAll('company', 'merchant')
    .replace('finding the official site, reading the segment table, following a holding merchant to its operating business, sending a site that needs JavaScript to the browser',
      'reading the merchant\'s site, finding its policy pages, choosing the code from what it sells, tiering the risk by the rubric, sending a site that needs JavaScript to the browser')
    .replace('(a document\'s URL)', '(a policy page\'s URL)').replace('the tools above', 'the job\'s tools')
    .replace('(what a merchant does, for its 4-digit SIC code)', '(what a merchant\'s business is, for its MCC)').replace('stays a Jev pick,', 'stays a Jev pick, judge or route,')
    .replace('A filing convention you met (where the SEC files a kind of merchant)', 'A coding convention you met (how card networks code a kind of business)');
  const bullets = (body, words = (text) => text) => words(flat(between(body, '## Every run'))).split(/ (?=- )/).map((b) => b.trim());
  const ours = bullets(read(HOME, 'AGENTS.md'));
  const theirs = bullets(read(SEC_HOME, 'AGENTS.md'), swap).filter((b) => !/takes `\{ "name", "ticker"\?|must work when the website is absent/.test(b));
  for (const bullet of theirs) assert.ok(ours.includes(bullet), bullet);
  assert.equal(ours.length, theirs.length + 1, 'and one bullet of its own: the whole job\'s input and shape');
});

test('one risk rubric: SPEC.md states the skill\'s rubric and flags word for word, and the flags are the answer\'s', () => {
  const skill = read(HOME, 'skills', 'classify-merchant', 'SKILL.md');
  const spec = read(import.meta.dirname, 'SPEC.md');
  const rubric = between(skill, 'The risk rubric. The tier', '\nThe flags:\n').trim();
  const flags = between(skill, '\nThe flags:\n', '# Parts that make workflows').replace('\nThe flags:\n', '').trim();
  assert.ok(spec.includes(rubric), 'the rubric');
  assert.ok(spec.includes(flags), 'the flags');
  assert.deepEqual([...flags.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]), [...FLAGS]);
  for (const tier of ['- high, when', '- medium, when no high row holds', '- low, when no other row holds']) assert.ok(rubric.includes(tier), tier);
});

test('the home names no merchant and no vertical: no site, no domain, its examples invented', () => {
  const body = ['AGENTS.md', 'agent.json', 'skills/classify-merchant/SKILL.md'].map((file) => read(HOME, file)).join('\n');
  assert.doesNotMatch(body, /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|shop|store|us|uk)\b/i);
  // The vertical is the teacher's discovery category and goes with the label: the learner never hears of it.
  assert.doesNotMatch(body, /vertical/i);
});
