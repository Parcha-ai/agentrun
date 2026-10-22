// The $0 doubles for the MCC job: a scripted agent over fixture merchants (fixtures-mcc/), whose answers are fixed per
// merchant name and never read out of prose. It does a merchant by hand (the site, the ranges, the codes, the answer) and
// saves merchant-mcc-risk, a whole-job workflow that reads the site and writes the answer from it; once a run is offered
// that workflow it loads and runs it, and goes by hand when it does not complete.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FETCH_RESULT_SCHEMA, lastRunOutcome } from './scripted.mjs';

export const FIXTURES_MCC = join(import.meta.dirname, 'fixtures-mcc');
export const MCC_WORKFLOW = 'merchant-mcc-risk';
export const MCC_WORKFLOW_WHEN = 'Use it for any merchant with a website: it reads the site and writes the answer from what the site says it sells; when the site has no text it escalates, and you classify by hand.';
export const MCC_LESSON = 'Quote, word for word, the sentence on the merchant\'s own site that says what it sells, and cite that page for the code.';

const EVIDENCE = {
  type: 'object', additionalProperties: false, required: ['claim', 'url', 'quote'],
  properties: { claim: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string' } },
};

/** The whole-job MCC workflow the scripted agent writes: read the given site, escalate when it has no text, and write the
 *  answer from the page. */
export const CLASSIFY_MERCHANT = Object.freeze({
  v: 2, name: MCC_WORKFLOW,
  schemas: {
    Merchant: { type: 'object', additionalProperties: false, required: ['name', 'website'], properties: { name: { type: 'string' }, website: { type: 'string' } } },
    Page: FETCH_RESULT_SCHEMA,
    Answer: {
      type: 'object', additionalProperties: false, required: ['mcc', 'mccDescription', 'riskTier', 'riskRationale', 'flags', 'siteStatus', 'evidence', 'confidence'],
      properties: {
        mcc: { type: 'string' }, mccDescription: { type: 'string' }, riskTier: { type: 'string' }, riskRationale: { type: 'string' },
        flags: { type: 'array', items: { type: 'string' } }, siteStatus: { type: 'string' }, evidence: { type: 'array', items: EVIDENCE }, confidence: { type: 'number' },
      },
    },
  },
  input: { schemaId: 'Merchant' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: {
    node: 'chain',
    steps: [
      { node: 'call', label: 'read the site', via: 'tool', tool: 'fetch_page', args: { url: '{website}' }, out: 'Page', as: 'page', deadline_s: 30 },
      { node: 'escalate', label: 'site not read', when: { predicate: 'gte', path: 'page.status', n: 400 }, kind: 'review', stage: 'research', summary: 'the site answered with an error' },
      { node: 'escalate', label: 'no page', when: { predicate: 'empty', path: 'page.text' }, kind: 'review', stage: 'research', summary: 'the site has no text to read' },
      {
        node: 'extract', label: 'write the answer', tools: [], out: 'Answer', as: 'answer',
        instructions: 'The code from what the page says the merchant sells, its title, the tier by the rubric, the flags the page shows, and evidence quoted word for word from the page.',
        state: { merchant: '{name}', url: '{page.url}', text: '{page.text}' },
      },
    ],
  },
});

/** merchant-mcc-risk grown after a site it could not read: the site is also opened in a browser, and the answer is written
 *  from what the browser read. A second revision of the same name, so a pass that runs it promotes a replacement and the
 *  promotion gate compares the two. */
export const CLASSIFY_MERCHANT_BROWSE = Object.freeze({
  ...CLASSIFY_MERCHANT,
  schemas: {
    ...CLASSIFY_MERCHANT.schemas,
    Browsed: {
      type: 'object', additionalProperties: false, required: ['ok', 'url', 'status', 'title', 'text', 'links'],
      properties: {
        ...FETCH_RESULT_SCHEMA.properties, costUsd: { type: ['number', 'null'] }, seconds: { type: 'number' }, browser: { type: 'string' },
        documents: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  root: {
    node: 'chain',
    steps: [
      ...CLASSIFY_MERCHANT.root.steps.slice(0, 2),
      { node: 'call', label: 'open the site in a browser', via: 'tool', tool: 'browse', args: { url: '{website}' }, out: 'Browsed', as: 'browsed', deadline_s: 60 },
      { node: 'escalate', label: 'no page in the browser', when: { predicate: 'empty', path: 'browsed.text' }, kind: 'review', stage: 'research', summary: 'the site has no text to read, even in a browser' },
      { ...CLASSIFY_MERCHANT.root.steps[3], state: { merchant: '{name}', url: '{page.url}', text: '{browsed.text}' } },
    ],
  },
});

/** merchant-mcc-risk as a churn rehearsal's run saves it: its pick step an agent node, and a step that never fires (its
 *  value a hash of the merchant's id, never a case value), so each run's revision has its own digest. */
export function savedEveryRun(job) {
  const picked = agentPick(CLASSIFY_MERCHANT);
  return {
    ...picked,
    root: {
      ...picked.root,
      steps: [
        { node: 'escalate', label: 'never', when: { predicate: 'in', path: 'name', values: [`never-${createHash('sha256').update(String(job.cik)).digest('hex').slice(0, 12)}`] }, kind: 'review', stage: 'research', summary: 'never fires' },
        ...picked.root.steps,
      ],
    },
  };
}

/** A workflow with its answer-writing extract made an agent node, as a learned workflow's pick step usually is. */
const agentPick = (workflow) => ({ ...workflow, root: { ...workflow.root, steps: workflow.root.steps.map((step) => (step.node === 'extract' ? { ...step, node: 'agent' } : step)) } });

/** The MCC answer for a fixture merchant, its evidence on `url` (the page read) unless the fixture names another page. */
export function answerOfMcc(t, url) {
  const at = (u) => u ?? url;
  return {
    mcc: t.mcc, mccDescription: t.title, riskTier: t.riskTier, riskRationale: t.riskRationale, flags: t.flags ?? [], siteStatus: t.siteStatus ?? 'live',
    evidence: [
      { claim: 'mcc', url: at(t.mccUrl), quote: t.quote },
      { claim: 'risk', url: at(t.riskUrl), quote: t.riskQuote ?? t.quote },
      ...(t.flags ?? []).map((flag) => ({ claim: flag, url: at(t.riskUrl), quote: t.flagQuotes?.[flag] ?? t.riskQuote ?? t.quote })),
    ],
    confidence: t.confidence ?? 0.8,
  };
}

/** The MCC job by hand, up to the answer: the site (or the page the fixture names), the ranges, the range's codes. */
function byHandMcc(job, t) {
  return [
    { call: 'fetch_page', args: { url: job.website } },
    ...(t.extraPages ?? (t.extraPage ? [t.extraPage] : [])).map((url) => ({ call: 'fetch_page', args: { url } })),
    { call: 'mcc_groups', args: {} },
    { call: 'mcc_codes', args: { group: t.group } },
  ];
}

/**
 * The scripted MCC agent for one merchant: by hand, then CLASSIFY_MERCHANT saved (and the grounding lesson noted); or,
 * offered merchant-mcc-risk, load, run and answer from it, by hand when it does not complete. `fixtures.truth[name]` is
 * the merchant's scripted answer and the quotes its evidence uses.
 */
export function agentScriptMcc({ job, offered, fixtures }) {
  const t = fixtures.truth[job.name];
  const input = { name: job.name, website: job.website };
  const node = (state) => ({ submit: answerOfMcc(fixtures.truth[state.merchant], state.url) });
  if (offered.includes(MCC_WORKFLOW)) {
    // Run it on the input as given; when it does not complete, the job by hand. On a site that reads only in a browser
    // (the fixture's `browserOnly`), a run it did not complete grows it by a browser read: the grown revision is saved,
    // loaded and run on this merchant, and the answer is its output.
    const notComplete = (context) => lastRunOutcome(context)?.status !== 'complete';
    const fromRun = (context) => { const outcome = lastRunOutcome(context); return outcome?.status === 'complete' ? outcome.output : answerOfMcc(t, job.website); };
    return {
      node,
      root: [
        { call: 'agentrun', args: { action: 'load', name: MCC_WORKFLOW, input } },
        { call: 'agentrun', args: { action: 'run' } },
        ...byHandMcc(job, t).map((step) => ({ ...step, when: notComplete })),
        // A fixture merchant with `saveEvery` (a churn rehearsal): after the run completes, a new revision of the workflow is
        // saved, loaded and run on this merchant too (its pick an agent node, a no-op step making its digest this run's own),
        // and the answer is that run's output; so every such run both uses the live revision and saves a new one.
        ...(t.saveEvery ? [
          { call: 'agentrun', args: { action: 'inspect', workflow: savedEveryRun(job), input } },
          { call: 'agentrun', args: { action: 'dry-run' } },
          { call: 'agentrun', args: { action: 'save', name: MCC_WORKFLOW } },
          { call: 'agentrun', args: { action: 'load', name: MCC_WORKFLOW, input } },
          { call: 'agentrun', args: { action: 'run' } },
        ].map((step) => ({ ...step, when: (context) => !notComplete(context) })) : []),
        ...(t.browserOnly ? [
          { call: 'agentrun', args: { action: 'inspect', workflow: t.saveEvery ? agentPick(CLASSIFY_MERCHANT_BROWSE) : CLASSIFY_MERCHANT_BROWSE, input } },
          { call: 'agentrun', args: { action: 'dry-run' } },
          { call: 'agentrun', args: { action: 'save', name: MCC_WORKFLOW } },
          { call: 'agentrun', args: { action: 'load', name: MCC_WORKFLOW, input } },
          { call: 'agentrun', args: { action: 'run' } },
          { call: 'learn', args: { type: 'workflow', id: MCC_WORKFLOW, text: 'Use it for any merchant with a website: it reads the site, also in a browser, and writes the answer from it; it escalates when neither has text.' } },
        ].map((step) => ({ ...step, when: notComplete })) : []),
        { call: 'answer', args: fromRun },
        { say: 'Answered.' },
      ],
    };
  }
  return {
    node,
    root: [
      ...byHandMcc(job, t),
      { call: 'answer', args: answerOfMcc(t, job.website) },
      { call: 'learn', args: { type: 'lesson', text: MCC_LESSON } },
      { call: 'agentrun', args: { action: 'describe' } },
      { call: 'agentrun', args: { action: 'inspect', workflow: t.saveEvery ? savedEveryRun(job) : CLASSIFY_MERCHANT, input } },
      { call: 'agentrun', args: { action: 'dry-run' } },
      { call: 'agentrun', args: { action: 'save', name: MCC_WORKFLOW } },
      { call: 'learn', args: { type: 'workflow', id: MCC_WORKFLOW, text: MCC_WORKFLOW_WHEN } },
      { say: 'Answered by hand, and saved merchant-mcc-risk for the next run.' },
    ],
  };
}
