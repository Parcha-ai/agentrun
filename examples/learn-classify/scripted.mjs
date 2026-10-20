// The $0 doubles for the learn-classify loop: a scripted model (pi-ai's faux provider), a scripted Jev and a fetch_page
// stub over fixture pages. Every answer is fixed per case id (the company's name, as the host gave it), never read out of
// prose. The scripted agent does the first job by hand and saves a workflow; once a run is offered that workflow it loads
// and runs it instead.
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const FIXTURES_V2 = join(import.meta.dirname, 'fixtures-v2');
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
export function scriptedModel({ root, node = (state) => ({ submit: extractAnswer(state) }), models: chosen }) {
  const requests = [];
  const nodeRequests = [];
  // `models` names the root's and the nodes' models ({ root: { id, thinking, cost? }, node: { id, thinking, cost? } }), as
  // a live pass's two are; `seen` says which model and thinking level each request was sent with.
  const ids = chosen ? [...new Set([chosen.root.id, chosen.node.id])] : ['scripted'];
  const costOf = (id) => [chosen?.root, chosen?.node].find((m) => m?.id === id)?.cost;
  const seen = [];
  const faux = fauxProvider({ models: ids.map((id) => ({ id, reasoning: true, ...(costOf(id) ? { cost: costOf(id) } : {}) })) });
  let step = 0;
  let id = 0;
  const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${++id}` })], { stopReason: 'toolUse' });
  const respond = (context, options, _state, requestModel) => {
    const offered = offeredTools(context);
    seen.push({ who: offered.includes('submit') ? 'node' : 'root', model: requestModel?.id, thinking: options?.reasoning ?? null });
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
  if (!chosen) return { models, agent: { model: { provider: 'faux', modelId: 'scripted' }, thinkingLevel: 'low' }, requests, nodeRequests, seen };
  const ref = (pick) => ({ model: { provider: 'faux', modelId: pick.id }, thinkingLevel: pick.thinking });
  return { models: pricedModels(models), agent: ref(chosen.root), node: ref(chosen.node), requests, nodeRequests, seen };
}

/** `models` with each answer priced by its own model's catalog entry, as a live provider prices it (the faux provider
 *  prices nothing): what the guard, the rows and the executions read. */
export function pricedModels(models) {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property !== 'streamSimple') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (model, context, options) => {
        const inner = target.streamSimple(model, context, options);
        return {
          [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
          result: async () => {
            const message = await inner.result();
            const per = model.cost ?? {};
            const u = message.usage;
            const part = (tokens, price) => ((tokens ?? 0) * (price ?? 0)) / 1e6;
            const cost = { input: part(u.input, per.input), output: part(u.output, per.output), cacheRead: part(u.cacheRead, per.cacheRead), cacheWrite: part(u.cacheWrite, per.cacheWrite) };
            return { ...message, usage: { ...u, cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite } } };
          },
        };
      };
    },
  });
}

/** The last agentrun run's outcome in a request, from the tool's own JSON answer. */
export function lastRunOutcome(context) {
  const runIds = new Set(context.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall' && c.name === 'agentrun' && c.arguments?.action === 'run').map((c) => c.id)));
  const result = context.messages.findLast((m) => m.role === 'toolResult' && runIds.has(m.toolCallId));
  return json(textOf(result?.content))?.outcome;
}

/** The scripted agent's steps for one job: by hand, then `workflow` saved, when no workflow is offered; else the offered
 *  workflow, loaded and run, and the answer it returned. `truth` is the fixture's answer for this case. */
export function agentScript({ job, offered, truth, page, workflow = CLASSIFY_WORKFLOW }) {
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
    { call: 'agentrun', args: { action: 'inspect', workflow, input } },
    { call: 'agentrun', args: { action: 'dry-run' } },
    { call: 'agentrun', args: { action: 'save', name: WORKFLOW } },
    { call: 'learn', args: { type: 'workflow', id: WORKFLOW, text: WORKFLOW_WHEN } },
    { say: 'Answered by hand, and saved classify-company for the next run.' },
  ];
}

const CURATE = { general: 0.94, narrowsRules: 0.03, fromContent: 0.03, duplicate: 0.04, supersedes: 0.04, contradicts: 0.03, namesCase: 0.03, workflowCase: 0.03 };

/**
 * A scripted Jev. Curate's and the leak gate's yes-or-no questions get the fixed answers above (or `overrides`); a pick
 * chooses the fixture's group for the company in its state (`truthByName`), or none for a company it has none for. The
 * scorers' questions take `segments` (a fixture's judge.json): v2's segment and cite answers, and v4's segment matches,
 * headquarters aliases and subsidiaries, each keyed by the exact value asked about; a v4 question it has no key for is no.
 */
export function scriptedJev({ truthByName = {}, groups = [], overrides = {}, segments = {}, asked = [] } = {}) {
  return async ({ kind, label, state, questions }) => {
    const answers = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'noul' && label === 'score/segment') {
        answers[key] = { type: 'noul', noul: segments.segments?.[state.truth?.member] ?? 0.9 };
      } else if (question.type === 'noul' && label === 'score/cite') {
        answers[key] = { type: 'noul', noul: segments.cites?.[state.url] ?? 0.9 };
      } else if (question.type === 'noul' && label === 'score/hq') {
        answers[key] = { type: 'noul', noul: segments.hq?.[state.answer?.city] ?? 0.1 };
      } else if (question.type === 'noul' && label === 'score/subsidiary') {
        answers[key] = { type: 'noul', noul: segments.subsidiaries?.[state.subsidiary] ?? 0.1 };
      } else if (question.type === 'choice' && label === 'score/segments') {
        // v4's segment match: the filed segment `segments.segmentMatch` names (by member) for this answer segment, else none.
        const name = state.answer?.find((a) => a.id === key)?.name;
        const member = segments.segmentMatch?.[name];
        const choice = state.truth?.find((t) => member !== undefined && t.member === member)?.id ?? 'none_of_these';
        const options = Object.keys(question.criteria);
        answers[key] = { type: 'choice', choice, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)])), confidence: 0.9 };
      } else if (question.type === 'noul') {
        answers[key] = { type: 'noul', noul: overrides[key] ?? CURATE[key] ?? 0.5 };
      } else if (question.type === 'choice') {
        // The option for the company's code, or for its 2-digit group: each option is described "<code> <name>".
        const options = Object.keys(question.criteria);
        const truth = String(truthByName[state?.company] ?? '');
        const startsWith = (code) => code && options.find((o) => String(question.criteria[o] ?? '').startsWith(`${code} `));
        const byIndex = groups.findIndex((g) => g.code === truth);
        const choice = startsWith(truth) ?? startsWith(truth.slice(0, 2)) ?? (byIndex >= 0 && options.includes(`item_${byIndex}`) ? `item_${byIndex}` : undefined)
          ?? (options.includes('none_of_these') ? 'none_of_these' : options[0]);
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

// ---- v2: the hard job --------------------------------------------------------------------------------------------------

const V2_PAGE = FETCH_RESULT_SCHEMA;
const SEARCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'query', 'results', 'filtered', 'costUsd'],
  properties: {
    ok: { type: 'boolean' }, query: { type: 'string' }, filtered: { type: 'integer' }, costUsd: { type: ['number', 'null'] },
    results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['url', 'title', 'snippet'], properties: { url: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' } } } },
  },
};
const BROWSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'url', 'status', 'title', 'text', 'links', 'costUsd'],
  properties: { ...FETCH_RESULT_SCHEMA.properties, costUsd: { type: ['number', 'null'] }, seconds: { type: 'number' }, browser: { type: 'string' }, documents: { type: 'array', items: { type: 'string' } } },
};
const DOCUMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'source', 'kind', 'text', 'looks', 'costUsd'],
  properties: {
    ok: { type: 'boolean' }, source: { type: 'string' }, kind: { type: 'string', enum: ['pdf', 'image', 'unknown'] }, text: { type: 'string' }, pageCount: { type: 'integer' },
    looks: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, answer: { type: 'string' } } } }, costUsd: { type: ['number', 'null'] },
  },
};

/** Fakes of lane C3's search_web, browse and read_document over fixtures, with their names and result shapes: search
 *  answers a query naming a fixture company with its results, browse a fixture page (30 billed seconds), read_document a
 *  fixture document (and one look when a question is asked). Every fake's call is collected in `calls`. */
export function fakeHardTools({ pages = {}, documents = {}, search = {}, calls = [] } = {}) {
  const page = (url) => pages[url] ?? pages[new URL(url).href] ?? Object.entries(pages).find(([u]) => new URL(u).href === new URL(url).href)?.[1];
  return {
    calls,
    tools: () => [
      {
        name: 'search_web', description: 'Search the web.', resultSchema: SEARCH_SCHEMA,
        parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
        run: async ({ query }) => {
          calls.push({ tool: 'search_web', query });
          const hit = Object.entries(search).find(([name]) => query.toLowerCase().includes(name.toLowerCase()));
          return { ok: true, query, results: hit ? hit[1] : [], filtered: 0, costUsd: 0.001 };
        },
      },
      {
        name: 'browse', description: 'Open a page in a browser and read it after its scripts ran.', resultSchema: BROWSE_SCHEMA,
        parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' } } },
        run: async ({ url }) => {
          calls.push({ tool: 'browse', url });
          const found = page(url);
          return found ? { ok: true, url, status: 200, title: found.title, text: found.text, links: found.links ?? [], costUsd: 0.002, seconds: 30, browser: 'fake' }
            : { ok: false, url, status: 404, title: '', text: '', links: [], costUsd: 0.002, seconds: 30, browser: 'fake' };
        },
      },
      {
        name: 'read_document', description: 'Read a PDF or image: its text, and what a vision model sees on the pages a question needs.', resultSchema: DOCUMENT_SCHEMA,
        parameters: {
          type: 'object', additionalProperties: false, required: ['url'],
          properties: { url: { type: 'string' }, question: { type: 'string' }, pages: { type: 'array', items: { type: 'integer', minimum: 1 } }, find: { type: 'string' } },
        },
        // A look (vision) only when a question is asked, at the first page named, else at the document's own page.
        run: async ({ url, question, pages, find }) => {
          calls.push({ tool: 'read_document', url, question, pages, find });
          const doc = documents[url];
          return doc ? { ok: true, source: url, kind: 'pdf', text: doc.text, pageCount: doc.pages ?? 1, looks: question ? [{ page: pages?.[0] ?? doc.page ?? 1, answer: doc.look ?? '' }] : [], costUsd: 0.001 }
            : { ok: false, source: url, kind: 'unknown', text: '', looks: [], costUsd: 0 };
        },
      },
    ],
  };
}

/** The whole-job v2 workflow the scripted agent writes: read the given site, pick the group, then the code within it, and
 *  write the answer from the page. */
export const CLASSIFY_WORKFLOW_V2 = Object.freeze({
  v: 2, name: WORKFLOW,
  schemas: {
    Company: { type: 'object', additionalProperties: false, required: ['name', 'website'], properties: { name: { type: 'string' }, ticker: { type: 'string' }, website: { type: 'string' } } },
    Page: V2_PAGE,
    Groups: CLASSIFY_WORKFLOW.schemas.Groups,
    Codes: { type: 'object', additionalProperties: false, required: ['codes'], properties: { codes: CLASSIFY_WORKFLOW.schemas.Groups.properties.groups } },
    Answer: {
      type: 'object', additionalProperties: false, required: ['sic4', 'primarySegment', 'evidence'],
      properties: {
        sic4: { type: 'string' },
        primarySegment: { type: 'object', additionalProperties: false, required: ['name', 'share'], properties: { name: { type: 'string' }, share: { type: ['number', 'null'] } } },
        evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'url', 'locator', 'quote'], properties: { claim: { type: 'string' }, url: { type: 'string' }, locator: { type: 'string' }, quote: { type: 'string' } } } },
      },
    },
  },
  input: { schemaId: 'Company' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: {
    node: 'chain',
    steps: [
      { node: 'call', label: 'read the site', via: 'tool', tool: 'fetch_page', args: { url: '{website}' }, out: 'Page', as: 'page', deadline_s: 30 },
      { node: 'escalate', label: 'no page', when: { predicate: 'empty', path: 'page.text' }, kind: 'review', stage: 'research', summary: 'the site has no text to read' },
      { node: 'call', label: 'the groups', via: 'tool', tool: 'sic2_groups', args: {}, out: 'Groups', as: 'groups', deadline_s: 10 },
      { node: 'pick', label: 'the group', itemsPath: 'groups.groups', describe: '{item.code} {item.name}', allowNone: true, as: 'group', instructions: 'Which group holds the company\'s main business, as its own site describes it?', state: { company: '{name}', text: '{page.text}' } },
      { node: 'escalate', label: 'no group', when: { predicate: 'field_equals', path: 'group.none', value: true }, kind: 'review', stage: 'classify', summary: 'no group fits' },
      { node: 'call', label: 'the codes', via: 'tool', tool: 'sic_codes', args: { group: '{group.item.code}' }, out: 'Codes', as: 'codes', deadline_s: 10 },
      { node: 'pick', label: 'the code', itemsPath: 'codes.codes', describe: '{item.code} {item.name}', allowNone: true, as: 'code', instructions: 'Which 4-digit code fits the company\'s main business?', state: { company: '{name}', text: '{page.text}' } },
      { node: 'escalate', label: 'no code', when: { predicate: 'field_equals', path: 'code.none', value: true }, kind: 'review', stage: 'classify', summary: 'no code fits' },
      { node: 'extract', label: 'write the answer', tools: [], out: 'Answer', as: 'answer', instructions: 'sic4 is the picked code. primarySegment is the largest segment the page states, with its share of revenue. evidence cites the page for both.', state: { company: '{name}', code: '{code.item}', text: '{page.text}', url: '{page.url}' } },
    ],
  },
});

/**
 * The scripted v2 agent for one job: by hand (search for the site when none is given, read it, read the annual report,
 * the group, the code, the answer with cites), then CLASSIFY_WORKFLOW_V2 saved; or, offered it, load, run and answer
 * from it. `fixtures.truth[name]` is the case's answer (code, segment and the quotes the cites use).
 */
export function agentScriptV2({ job, offered, fixtures }) {
  const truth = fixtures.truth[job.name];
  const input = { name: job.name, ...(job.ticker ? { ticker: job.ticker } : {}), ...(job.website ? { website: job.website } : {}) };
  const node = (state) => {
    const t = fixtures.truth[state.company];
    return { submit: { sic4: state.code?.code ?? '', primarySegment: t.segment, evidence: [{ claim: 'sic', url: state.url, locator: 'home page', quote: t.siteQuote }, { claim: 'segment', url: state.url, locator: 'home page', quote: t.siteSegmentQuote ?? t.siteQuote }] } };
  };
  const answer = (sic4, segment) => ({
    sic4, primarySegment: segment,
    evidence: [{ claim: 'sic', url: truth.site, locator: 'home page', quote: truth.siteQuote }, { claim: 'segment', url: truth.document, locator: `pdf p. ${truth.page ?? 1}`, quote: truth.segmentQuote }],
  });
  if (offered.includes(WORKFLOW) && job.website) {
    return {
      node,
      root: [
        { call: 'agentrun', args: { action: 'load', name: WORKFLOW, input } },
        { call: 'agentrun', args: { action: 'run' } },
        { call: 'answer', args: (context) => { const outcome = lastRunOutcome(context); return outcome?.status === 'complete' ? outcome.output : answer(truth.sic4, truth.segment); } },
        { say: 'Answered with the workflow\'s result.' },
      ],
    };
  }
  const site = job.website ?? truth.site;
  return {
    node,
    root: [
      ...(job.website ? [] : [{ call: 'search_web', args: { query: `${job.name} ${job.ticker ?? ''} investor relations`.trim() } }]),
      { call: job.website ? 'fetch_page' : 'browse', args: { url: site } },
      { call: 'read_document', args: { url: truth.document, question: 'revenue by reportable segment' } },
      { call: 'sic2_groups', args: {} },
      { call: 'sic_codes', args: { group: truth.sic4.slice(0, 2) } },
      { call: 'answer', args: answer(truth.sic4, truth.segment) },
      ...(offered.includes(WORKFLOW) ? [] : [
        { call: 'agentrun', args: { action: 'describe' } },
        { call: 'agentrun', args: { action: 'inspect', workflow: CLASSIFY_WORKFLOW_V2, input: { name: job.name, website: site } } },
        { call: 'agentrun', args: { action: 'dry-run' } },
        { call: 'agentrun', args: { action: 'save', name: WORKFLOW } },
        { call: 'learn', args: { type: 'workflow', id: WORKFLOW, text: 'Use it for any company whose website is given.' } },
      ]),
      { say: 'Answered by hand.' },
    ],
  };
}

// ---- v4: the dollar job ------------------------------------------------------------------------------------------------

export const FIXTURES_V4 = join(import.meta.dirname, 'fixtures-v4');

const CITE_V4 = {
  type: 'object', additionalProperties: false, required: ['claim', 'url', 'locator', 'quote'],
  properties: { claim: { type: 'string', enum: ['sic', 'segment', 'hq', 'subsidiary', 'report'] }, url: { type: 'string' }, locator: { type: 'string' }, quote: { type: 'string' } },
};

/** The whole-job v4 workflow the scripted agent writes: read the given site, pick the group and the code, take the annual
 *  report's link from the site, read the report, and write the answer from the site and the report. */
export const CLASSIFY_WORKFLOW_V4 = Object.freeze({
  v: 2, name: WORKFLOW,
  schemas: {
    Company: CLASSIFY_WORKFLOW_V2.schemas.Company,
    Page: V2_PAGE,
    Groups: CLASSIFY_WORKFLOW_V2.schemas.Groups,
    Codes: CLASSIFY_WORKFLOW_V2.schemas.Codes,
    Report: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' } } },
    Document: DOCUMENT_SCHEMA,
    Answer: {
      type: 'object', additionalProperties: false, required: ['sic4', 'segments', 'hq', 'subsidiaries', 'annualReport', 'cites'],
      properties: {
        sic4: { type: 'string' },
        segments: {
          anyOf: [
            { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'share'], properties: { name: { type: 'string' }, share: { type: 'number' } } } },
            { type: 'object', additionalProperties: false, required: ['oneSegment'], properties: { oneSegment: { type: 'boolean' } } },
          ],
        },
        hq: { type: 'object', additionalProperties: false, required: ['city', 'country'], properties: { city: { type: 'string' }, state: { type: 'string' }, country: { type: 'string' } } },
        subsidiaries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, country: { type: 'string' } } } },
        annualReport: { type: 'object', additionalProperties: false, required: ['url', 'fiscalYear'], properties: { url: { type: 'string' }, fiscalYear: { type: 'integer' } } },
        cites: { type: 'array', items: CITE_V4 },
      },
    },
  },
  input: { schemaId: 'Company' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: {
    node: 'chain',
    steps: [
      ...CLASSIFY_WORKFLOW_V2.root.steps.slice(0, -1),
      { node: 'extract', label: 'the annual report', tools: [], out: 'Report', as: 'report', instructions: 'url is the link to the company\'s latest annual report among the site\'s links.', state: { company: '{name}', links: '{page.links}' } },
      { node: 'call', label: 'read the report', via: 'tool', tool: 'read_document', args: { url: '{report.url}', question: 'revenue by reportable segment, the headquarters, and the list of subsidiaries' }, out: 'Document', as: 'document', deadline_s: 120 },
      { node: 'escalate', label: 'no report', when: { predicate: 'empty', path: 'document.text' }, kind: 'review', stage: 'research', summary: 'the annual report has no text to read' },
      {
        node: 'extract', label: 'write the answer', tools: [], out: 'Answer', as: 'answer',
        instructions: 'sic4 is the picked code. segments, hq and subsidiaries are as the report states them; annualReport is the report read, with its fiscal year. cites quote the site and the report pages for each part.',
        state: { company: '{name}', code: '{code.item}', url: '{page.url}', report: '{report.url}', text: '{page.text}', document: '{document.text}' },
      },
    ],
  },
});

/** The v4 answer for a fixture case, its cites on the site and the report as read in the run. */
export function answerOfV4(t, { sic4 = t.sic4, site = t.site, report = t.document } = {}) {
  return {
    sic4, segments: t.segments, hq: t.hq, subsidiaries: t.subsidiaries, annualReport: { ...t.annualReport, url: report },
    cites: [
      { claim: 'sic', url: site, locator: 'home page', quote: t.siteQuote },
      { claim: 'segment', url: report, locator: 'pdf p. 4', quote: t.segmentQuote },
      { claim: 'hq', url: report, locator: 'pdf p. 1', quote: t.hqQuote },
      { claim: 'subsidiary', url: report, locator: 'pdf p. 9', quote: t.subsidiaryQuote },
      { claim: 'report', url: report, locator: 'pdf p. 1', quote: t.reportQuote },
    ],
  };
}

/**
 * The scripted v4 agent for one job: by hand (search for the site when none is given, read it, read the annual report,
 * the group, the code, the six-part answer), then CLASSIFY_WORKFLOW_V4 saved; or, offered it, load, run and answer from
 * it. `fixtures.truth[name]` is the case's answer and the quotes its cites use.
 */
export function agentScriptV4({ job, offered, fixtures }) {
  const truth = fixtures.truth[job.name];
  const input = { name: job.name, ...(job.ticker ? { ticker: job.ticker } : {}), ...(job.website ? { website: job.website } : {}) };
  // The workflow's two extracts, told apart by their state: the report's link from the site's links, then the answer.
  const node = (state) => {
    const t = fixtures.truth[state.company];
    if ('links' in state) return { submit: { url: t.document } };
    return { submit: answerOfV4(t, { sic4: state.code?.code ?? '', site: state.url, report: state.report }) };
  };
  if (offered.includes(WORKFLOW) && job.website) {
    return {
      node,
      root: [
        { call: 'agentrun', args: { action: 'load', name: WORKFLOW, input } },
        { call: 'agentrun', args: { action: 'run' } },
        { call: 'answer', args: (context) => { const outcome = lastRunOutcome(context); return outcome?.status === 'complete' ? outcome.output : answerOfV4(truth); } },
        { say: 'Answered with the workflow\'s result.' },
      ],
    };
  }
  const site = job.website ?? truth.site;
  return {
    node,
    root: [
      ...(job.website ? [] : [{ call: 'search_web', args: { query: `${job.name} ${job.ticker ?? ''} investor relations`.trim() } }]),
      { call: job.website ? 'fetch_page' : 'browse', args: { url: site } },
      // Find the segment note, then look at its page (vision) for the table as laid out.
      { call: 'read_document', args: { url: truth.document, find: 'segment information' } },
      { call: 'read_document', args: { url: truth.document, pages: [4], question: 'the segment revenue table as laid out' } },
      { call: 'sic2_groups', args: {} },
      { call: 'sic_codes', args: { group: truth.sic4.slice(0, 2) } },
      { call: 'answer', args: answerOfV4(truth) },
      ...(offered.includes(WORKFLOW) ? [] : [
        { call: 'agentrun', args: { action: 'describe' } },
        { call: 'agentrun', args: { action: 'inspect', workflow: CLASSIFY_WORKFLOW_V4, input: { name: job.name, website: site } } },
        { call: 'agentrun', args: { action: 'dry-run' } },
        { call: 'agentrun', args: { action: 'save', name: WORKFLOW } },
        { call: 'learn', args: { type: 'workflow', id: WORKFLOW, text: 'Use it for any company whose website is given.' } },
      ]),
      { say: 'Answered by hand.' },
    ],
  };
}
