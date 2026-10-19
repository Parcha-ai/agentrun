// The $0 doubles for the learn-classify loop: a scripted model (pi-ai's faux provider), a scripted Jev and a fetch_page
// stub over fixture pages. Every answer is fixed per case id (the company's name, as the host gave it), never read out of
// prose. The scripted agent does the first job by hand and saves a workflow; once a run is offered that workflow it loads
// and runs it instead.
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** fetch_page's result, per the C1/C2 contract. */
export const FETCH_RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['ok', 'url', 'status', 'title', 'text', 'links'],
  properties: {
    ok: { type: 'boolean' }, url: { type: 'string' }, status: { type: 'integer' }, title: { type: 'string' }, text: { type: 'string' },
    links: { type: 'array', items: { type: 'string' } }, refused: { type: 'string' },
  },
});

/** fetch_page over fixture pages: a page the fixtures hold, else a 404. `seen` collects every URL asked for. */
export function fixtureFetch(pages, seen = []) {
  return {
    name: 'fetch_page',
    description: 'Read one web page as text: the company\'s own site or Wikipedia, nothing else.',
    parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', description: 'An http or https URL.' } } },
    resultSchema: FETCH_RESULT_SCHEMA,
    run: async ({ url }) => {
      seen.push(url);
      const page = pages[url];
      return page ? { ok: true, url, status: 200, title: page.title, text: page.text, links: page.links ?? [] } : { ok: false, url, status: 404, title: '', text: '', links: [] };
    },
  };
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A `fetch` over the fixture pages, as HTML, for lane C1's fetch_page: the scripted pass runs the real tool on them. */
export function fixtureWeb(pages, seen = []) {
  const byHref = new Map(Object.entries(pages).map(([url, page]) => [new URL(url).href, page]));
  return async (href) => {
    seen.push(href);
    const page = byHref.get(new URL(href).href);
    if (!page) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const links = (page.links ?? []).map((link) => `<a href="${escapeHtml(link)}">more</a>`).join(' ');
    const html = `<!doctype html><html><head><title>${escapeHtml(page.title)}</title></head><body><main><p>${escapeHtml(page.text)}</p>${links}</main></body></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
}

export const WORKFLOW = 'classify-company';
export const WORKFLOW_WHEN = 'Use it for any company with a website: it reads the home page, picks the industry group with Jev and writes the answer; when the page does not load or no group fits it escalates, and you classify by hand.';

/** The whole-job workflow the scripted agent writes in its first run. */
export const CLASSIFY_WORKFLOW = Object.freeze({
  v: 2, name: WORKFLOW,
  schemas: {
    Company: { type: 'object', additionalProperties: false, required: ['name', 'website'], properties: { name: { type: 'string' }, website: { type: 'string' } } },
    Page: FETCH_RESULT_SCHEMA,
    Groups: {
      type: 'object', additionalProperties: false, required: ['groups'],
      properties: { groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code: { type: 'string' }, name: { type: 'string' } } } } },
    },
    Answer: { type: 'object', additionalProperties: false, required: ['sic2', 'evidence', 'url'], properties: { sic2: { type: 'string' }, evidence: { type: 'string' }, url: { type: 'string' } } },
  },
  input: { schemaId: 'Company' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: {
    node: 'chain',
    steps: [
      { node: 'call', label: 'read the home page', via: 'tool', tool: 'fetch_page', args: { url: '{website}' }, out: 'Page', as: 'page', deadline_s: 30 },
      { node: 'escalate', label: 'no page', when: { predicate: 'empty', path: 'page.text' }, kind: 'review', stage: 'research', summary: 'the home page did not load or has no text' },
      { node: 'call', label: 'the groups', via: 'tool', tool: 'sic2_groups', args: {}, out: 'Groups', as: 'groups', deadline_s: 10 },
      {
        node: 'pick', label: 'industry group', itemsPath: 'groups.groups', describe: '{item.code} {item.name}', allowNone: true, as: 'picked',
        instructions: 'Which industry group is this company\'s main business, by what its own home page says it sells or makes?',
        state: { company: '{name}', title: '{page.title}', text: '{page.text}' },
      },
      { node: 'escalate', label: 'no group fits', when: { predicate: 'field_equals', path: 'picked.none', value: true }, kind: 'review', stage: 'classify', summary: 'no group fits what the home page says' },
      {
        node: 'extract', label: 'write the answer', tools: [], out: 'Answer', as: 'answer',
        instructions: 'sic2 is the picked group\'s code. evidence is one sentence from the page text that shows the company\'s business. url is the page\'s url.',
        state: { group: '{picked.item}', text: '{page.text}', url: '{page.url}' },
      },
    ],
  },
});

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(''));
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

/** The tools a request offers, by name, as its system messages add and remove them. */
export function offeredTools(context) {
  const names = new Set();
  for (const message of context.messages) {
    if (message.role !== 'system') continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === 'string' ? tool : tool.name);
  }
  return [...names];
}

const firstSentence = (text) => `${String(text ?? '').split('. ')[0].trim().replace(/\.$/, '')}.`;

/** A node's default delivery for the extract node above: the picked group's code, the page's first sentence, its URL. */
export const extractAnswer = (state) => ({ sic2: state.group?.code ?? '', evidence: firstSentence(state.text), url: state.url ?? '' });

/**
 * A scripted model for one run. `root` is the root agent's responses in order (each `{ call, args }` or `{ say }`, `args`
 * may be a function of the request); a request whose tools include `submit` is a workflow node's, answered by `node`.
 */
export function scriptedModel({ root, node = (state) => ({ submit: extractAnswer(state) }) }) {
  const requests = [];
  const nodeRequests = [];
  const faux = fauxProvider({ models: [{ id: 'scripted', reasoning: true }] });
  let step = 0;
  let id = 0;
  const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${++id}` })], { stopReason: 'toolUse' });
  const respond = (context) => {
    const offered = offeredTools(context);
    if (offered.includes('submit')) {
      nodeRequests.push({ context, offered });
      const last = context.messages.at(-1);
      if (last?.role === 'toolResult' && last.toolName === 'submit' && !last.isError) return fauxAssistantMessage([fauxText('Delivered.')], { stopReason: 'stop' });
      const user = context.messages.find((m) => m.role === 'user');
      // The node's input state is the user turn's first line, as JSON; the runner's delivery contract follows it.
      const state = json(textOf(user?.content).split('\n')[0]) ?? {};
      const results = context.messages.filter((m) => m.role === 'toolResult').map((m) => ({ name: m.toolName, value: json(textOf(m.content)) }));
      const next = node(state, { offered, results });
      return next.call ? call(next.call, next.args) : call('submit', next.submit);
    }
    requests.push(context);
    const next = root[step++];
    if (!next) return fauxAssistantMessage([fauxText('Done.')], { stopReason: 'stop' });
    if (next.call) return call(next.call, typeof next.args === 'function' ? next.args(context) : next.args);
    return fauxAssistantMessage([fauxText(next.say)], { stopReason: 'stop' });
  };
  faux.setResponses(Array.from({ length: 400 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, agent: { model: { provider: 'faux', modelId: 'scripted' }, thinkingLevel: 'low' }, requests, nodeRequests };
}

/** The last agentrun run's outcome in a request, from the tool's own JSON answer. */
export function lastRunOutcome(context) {
  const runIds = new Set(context.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall' && c.name === 'agentrun' && c.arguments?.action === 'run').map((c) => c.id)));
  const result = context.messages.findLast((m) => m.role === 'toolResult' && runIds.has(m.toolCallId));
  return json(textOf(result?.content))?.outcome;
}

/** The scripted agent's steps for one job: by hand, then a workflow saved, when no workflow is offered; else the offered
 *  workflow, loaded and run, and the answer it returned. `truth` is the fixture's answer for this case. */
export function agentScript({ job, offered, truth, page }) {
  const input = { name: job.name, website: job.website };
  if (offered.includes(WORKFLOW)) {
    return [
      { call: 'agentrun', args: { action: 'load', name: WORKFLOW, input } },
      { call: 'agentrun', args: { action: 'run' } },
      {
        call: 'answer',
        args: (context) => {
          const outcome = lastRunOutcome(context);
          return outcome?.status === 'complete' ? outcome.output : { sic2: truth, evidence: firstSentence(page?.text), url: job.website };
        },
      },
      { say: 'Answered with the workflow\'s result.' },
    ];
  }
  return [
    { call: 'sic2_groups', args: {} },
    { call: 'fetch_page', args: { url: job.website } },
    { call: 'answer', args: { sic2: truth, evidence: firstSentence(page?.text), url: job.website } },
    { call: 'agentrun', args: { action: 'describe' } },
    { call: 'agentrun', args: { action: 'inspect', workflow: CLASSIFY_WORKFLOW, input } },
    { call: 'agentrun', args: { action: 'dry-run' } },
    { call: 'agentrun', args: { action: 'save', name: WORKFLOW } },
    { call: 'learn', args: { type: 'workflow', id: WORKFLOW, text: WORKFLOW_WHEN } },
    { say: 'Answered by hand, and saved classify-company for the next run.' },
  ];
}

const CURATE = { general: 0.94, narrowsRules: 0.03, fromContent: 0.03, duplicate: 0.04, supersedes: 0.04, contradicts: 0.03, namesCase: 0.03 };

/**
 * A scripted Jev. Curate's and the leak gate's yes-or-no questions get the fixed answers above (or `overrides`); a pick
 * chooses the fixture's group for the company in its state (`truthByName`), or none for a company it has none for.
 */
export function scriptedJev({ truthByName = {}, groups = [], overrides = {}, asked = [] } = {}) {
  return async ({ kind, label, state, questions }) => {
    const answers = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'noul') {
        answers[key] = { type: 'noul', noul: overrides[key] ?? CURATE[key] ?? 0.5 };
      } else if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const index = groups.findIndex((g) => g.code === truthByName[state?.company]);
        const choice = index >= 0 && options.includes(`item_${index}`) ? `item_${index}` : options.includes('none_of_these') ? 'none_of_these' : options[0];
        const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)]));
        answers[key] = { type: 'choice', choice, probabilities, confidence: 0.9 };
      } else {
        throw new Error(`the scripted Jev has no answer for a ${question.type} question`);
      }
      asked.push({ kind, label, question: key, answer: answers[key] });
    }
    return { answers, model: 'scripted', usage: null, cost_usd: 0 };
  };
}
