// The hard job's tools: search_web, browse and read_document. Each refuses what fetch_page refuses (the SEC and its
// mirrors, SIC listings, web archives, any EDGAR host) on every request it makes and every result it returns, and none
// reaches this machine or its network: loopback, private, CGNAT and link-local addresses and single-label names are
// refused too. A tool answers with a typed result, never a throw, and every result carries `costUsd`: what the call cost,
// 0 when nothing billable happened, null when a request may have been billed at an unknown price.
import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, readFile, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIST_PRICES } from '@parcha/pi-browser';
import { pdfDocument, pdfPage } from '@parcha/pi-vision';
import { refusedHost, refusedUrl, urlPolicy } from './tools.mjs';

// The one URL policy is fetch_page's (tools.mjs); these tools use it, and its parts are exported here too.
export { blockedAddress, refusedHostOf, refusedUrl, urlPolicy } from './tools.mjs';

export const USER_AGENT = 'agentrun-learn-classify/1.0 (hard-job tools; +https://github.com/Parcha-ai/agentrun)';
export const MAX_TEXT = 8_000;
export const MAX_DOCUMENT_TEXT = 12_000;
export const MAX_LINKS = 30;
export const MAX_DOCUMENT_LINKS = 20;
export const MAX_RESULTS = 10;
export const MAX_ACTIONS = 6;
export const MAX_LOOKS = 4;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_TIMEOUT_MS = 30_000;
export const BROWSE_TIMEOUT_MS = 60_000;
const DOCUMENT_HOPS = 3;
const RENDER_DPI = 150;

/** The names a take passes in for these tools and the gateway: read by pi-browser and the gateway at each call, never
 *  written anywhere. A recording replaces each value it finds (recording.mjs). */
export const SECRET_NAMES = Object.freeze(['BROWSERBASE_API_KEY', 'BB_API_KEY', 'BROWSERBASE_PROJECT_ID', 'LEARN_CLASSIFY_GATEWAY_KEY']);

const size = (n) => (n >= 1048576 ? `${+(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const normalHost = (host) => String(host).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
const firstLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 300);

/** A host tool's cost, in the shape every result carries. */
const sumCost = (a, b) => (a === null || b === null ? null : a + b);

const SEARCH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'query', 'results', 'filtered', 'costUsd'],
  properties: {
    ok: { type: 'boolean' },
    query: { type: 'string' },
    results: {
      type: 'array', maxItems: MAX_RESULTS,
      items: {
        type: 'object', additionalProperties: false, required: ['url', 'title', 'snippet'],
        properties: { url: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' } },
      },
    },
    filtered: { type: 'integer', description: 'results dropped because their site is refused' },
    costUsd: { type: ['number', 'null'], description: 'what the search cost; null when unknown' },
    refused: { type: 'string', description: 'why the query was not sent' },
    error: { type: 'string', description: 'why ok is false when nothing was refused' },
  },
};

/** A query that names a refused site is never sent: hostname-shaped words only, so a word like a person's name is not. */
function refusedQuery(query) {
  for (const word of query.split(/\s+/)) {
    const host = word.replace(/^[a-z]+:/i, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').split('/')[0];
    if (host.includes('.') && /^[a-z0-9.-]+$/i.test(host)) {
      const why = refusedHost(host);
      if (why) return `the query names ${host}: ${why}`;
    }
  }
  return null;
}

/**
 * search_web. Live, `provider` is Browserbase's Search API (`browserbaseSearchProvider`); a test passes a fake of the same
 * shape: `{ name, secrets?: () => string[], search({ query, n }, { signal }) }` answering
 * `{ results: [{ url, title, snippet? }], costUsd: number | null }`. `secrets` names the values kept out of an error's words.
 */
export function searchWebTool({ provider, maxResults = MAX_RESULTS, allowPrivate = false }) {
  if (!provider || typeof provider.search !== 'function') throw new TypeError('searchWebTool needs a provider with search()');
  const max = Math.min(maxResults, MAX_RESULTS);
  async function run(args, { signal } = {}) {
    const query = typeof args?.query === 'string' ? args.query.trim().replace(/\s+/g, ' ') : '';
    const empty = { ok: false, query, results: [], filtered: 0, costUsd: 0 };
    if (!query) return { ...empty, error: 'the query is empty' };
    if (query.length > 200) return { ...empty, error: 'the query is over 200 characters' };
    const refused = refusedQuery(query);
    if (refused) return { ...empty, refused };
    let answer;
    try {
      answer = await provider.search({ query, n: max }, { signal });
    } catch (error) {
      const secrets = (provider.secrets?.() ?? []).filter((s) => typeof s === 'string' && s.length >= 4);
      const words = secrets.reduce((text, secret) => text.split(secret).join('[key]'), firstLine(error));
      // A request that failed may have been billed; one the provider never sent (`notSent`) cost nothing.
      return { ...empty, costUsd: error?.notSent ? 0 : null, error: `the search failed: ${words}` };
    }
    const seen = new Set();
    const results = [];
    let filtered = 0;
    for (const row of answer?.results ?? []) {
      let url;
      try {
        url = new URL(String(row?.url));
      } catch {
        continue;
      }
      url.hash = '';
      if (refusedUrl(url.href, { allowPrivate })) { filtered += 1; continue; }
      if (seen.has(url.href) || results.length >= max) continue;
      seen.add(url.href);
      results.push({ url: url.href, title: String(row?.title ?? '').slice(0, 300), snippet: String(row?.snippet ?? '').slice(0, 500) });
    }
    const costUsd = typeof answer?.costUsd === 'number' && Number.isFinite(answer.costUsd) ? answer.costUsd : null;
    return { ok: true, query, results, filtered, costUsd };
  }
  return {
    name: 'search_web',
    label: 'Search the web',
    description: `Search the web: up to ${max} results, each a URL, a title and a snippet. Use it to find a company's official site, its investor pages and its annual report. Results on SEC/EDGAR, SIC listing sites and web archives are dropped, and a query naming one of those sites is refused.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', description: 'what to search for, in words' } },
    },
    resultSchema: SEARCH_RESULT_SCHEMA,
    run,
  };
}

/** Search through pi-browser's Browserbase provider: Browserbase's Search API (at most 200 characters and 25 results; url,
 *  title, author and date, no snippet), at its list price. The provider is built at each call, so the key is read from
 *  `env` then: BROWSERBASE_API_KEY, or BB_API_KEY. */
export function browserbaseSearchProvider({ env = process.env, make } = {}) {
  const keyOf = () => env.BROWSERBASE_API_KEY?.trim() || env.BB_API_KEY?.trim() || '';
  return {
    name: 'browserbase',
    secrets: () => [keyOf()],
    async search({ query, n }, { signal } = {}) {
      if (!keyOf()) throw Object.assign(new Error('search through Browserbase needs BROWSERBASE_API_KEY'), { notSent: true });
      const build = make ?? (await import('@parcha/pi-browser/providers/browserbase')).browserbaseProvider;
      const answer = await build({ env }).search({ query, n }, signal);
      const usage = answer.usage;
      return {
        results: (answer.results ?? []).map((r) => ({ url: r.url, title: r.title ?? '', snippet: '' })),
        costUsd: usage?.state === 'priced' ? usage.usage.cost.total : null,
      };
    },
  };
}

/** A live run's search provider: Browserbase's, the same key as the browser's (BROWSERBASE_API_KEY, read at each call).
 *  Without the key a search answers that it needs it, at no cost. */
export const searchFromEnv = (env = process.env) => browserbaseSearchProvider({ env });

const GUARDED = new Set(['page', 'iframe', 'service_worker', 'shared_worker']);
const CAPTURED = /^(application\/(pdf|octet-stream|x-pdf)|binary\/octet-stream|image\/(png|jpeg|gif|webp))\b/;
const SESSIONS = new Set([...GUARDED, 'worker']);

/**
 * A second DevTools client on the session that holds every request the browser makes until `check(url)` answers, and
 * fails it (BlockedByClient) when the answer is a refusal: navigations, redirect hops, clicked links, frames, popups and
 * subresources alike. It returns once interception is on for every open page; new targets start paused until theirs is
 * on. `refused` lists what it stopped (`main` marks a top-level document), `status` the HTTP status of the last top-level
 * document. If its socket closes or a page cannot be held, `closed` is set and the caller must not trust what the page
 * shows.
 */
export async function cdpRequestGuard(target, { check, capture }) {
  const url = target.dial?.url ?? target.sdkCdpUrl;
  const ws = new WebSocket(url, ...(target.dial?.headers ? [{ headers: target.dial.headers }] : []));
  await new Promise((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error('the request guard could not reach the browser'));
  });
  let next = 1;
  const pending = new Map();
  const pages = new Map();
  const guard = { refused: [], status: 0, closed: false, close: () => { try { ws.close(); } catch {} } };
  const setups = [];
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = next++;
    pending.set(id, { done, fail });
    try {
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (error) {
      pending.delete(id);
      fail(error);
    }
  });
  const decide = async (sessionId, p) => {
    let why;
    try {
      why = await check(p.request.url);
    } catch (error) {
      why = `the request could not be checked (${firstLine(error)})`;
    }
    if (why) {
      const main = p.resourceType === 'Document' && pages.get(sessionId) === p.frameId;
      guard.refused.push({ url: p.request.url, reason: why, main });
      return send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    }
    return send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
  };
  // With `capture`, a top-level document that answers 2xx as a PDF, an image or bytes is taken whole (at most
  // `capture.maxBytes`) into `captured`, and not shown: its request ends there.
  const take = async (sessionId, p) => {
    const header = (name) => (p.responseHeaders ?? []).find((h) => h.name.toLowerCase() === name)?.value ?? '';
    const type = header('content-type').toLowerCase();
    const ok = p.responseStatusCode >= 200 && p.responseStatusCode < 300;
    if (capture && ok && pages.get(sessionId) === p.frameId && CAPTURED.test(type)) {
      const declared = Number(header('content-length'));
      const at = { url: p.request.url, status: p.responseStatusCode, contentType: type };
      if (declared > capture.maxBytes) guard.captured = { ...at, error: `the file is ${size(declared)}, over the ${size(capture.maxBytes)} cap` };
      else {
        const body = await send('Fetch.getResponseBody', { requestId: p.requestId }, sessionId).catch(() => null);
        const bytes = body ? Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8') : null;
        guard.captured = !bytes ? { ...at, error: 'the browser did not hand over the file' }
          : bytes.length > capture.maxBytes ? { ...at, error: `the file is over the ${size(capture.maxBytes)} cap` } : { ...at, bytes };
      }
      return send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }, sessionId).catch(() => {});
    }
    return send('Fetch.continueResponse', { requestId: p.requestId }, sessionId)
      .catch(() => send('Fetch.continueRequest', { requestId: p.requestId }, sessionId)).catch(() => {});
  };
  const setup = ({ sessionId, targetInfo, waitingForDebugger }) => {
    const { type, targetId } = targetInfo;
    if (type === 'page') pages.set(sessionId, targetId);
    // Sent in order without waiting: a paused target answers renderer commands only after it resumes, and the resume
    // goes last so nothing it sends escapes before interception is on.
    const steps = [];
    // A page whose interception could not be turned on is not guarded: the guard counts as lost.
    const patterns = [{ urlPattern: '*', requestStage: 'Request' }, ...(capture && type === 'page' ? [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] : [])];
    if (GUARDED.has(type)) steps.push(send('Fetch.enable', { patterns }, sessionId).catch((error) => { if (type === 'page') guard.closed = true; throw error; }));
    if (type === 'page') steps.push(send('Network.enable', {}, sessionId));
    if (SESSIONS.has(type) || type === 'tab') steps.push(send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId));
    if (waitingForDebugger) steps.push(send('Runtime.runIfWaitingForDebugger', {}, sessionId));
    return Promise.allSettled(steps);
  };
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.fail(new Error(m.error.message)); else p?.done(m.result);
    } else if (m.method === 'Target.attachedToTarget') {
      setups.push(setup(m.params));
    } else if (m.method === 'Target.detachedFromTarget') {
      pages.delete(m.params.sessionId);
    } else if (m.method === 'Fetch.requestPaused') {
      void (m.params.responseStatusCode !== undefined || m.params.responseErrorReason ? take(m.sessionId, m.params) : decide(m.sessionId, m.params));
    } else if (m.method === 'Network.responseReceived' && m.params.type === 'Document' && pages.get(m.sessionId) === m.params.frameId) {
      guard.status = m.params.response.status;
    }
  };
  ws.onclose = () => {
    guard.closed = true;
    for (const p of pending.values()) p.fail(new Error('the request guard\'s socket closed'));
    pending.clear();
  };
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Pages open before the guard came are attached by hand when auto-attach did not reach them.
  for (const info of (await send('Target.getTargets')).targetInfos) {
    if (info.type !== 'page' || [...pages.values()].includes(info.targetId)) continue;
    const { sessionId } = await send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    if (!pages.has(sessionId)) setups.push(setup({ sessionId, targetInfo: info, waitingForDebugger: false }));
  }
  // Interception is on for every page before the first navigation is sent.
  await Promise.allSettled(setups);
  if (guard.closed) throw new Error('the request guard could not hold the browser\'s requests');
  return guard;
}

/** Where browse's browsers come from, chosen at each call: Browserbase when BROWSERBASE_API_KEY (or BB_API_KEY) is set,
 *  billed per session at its list rate with a minute's minimum; else a local headless Chrome under `profileRoot`, killed
 *  by exact pid when the call ends, at $0. */
export function browserFromEnv({ env = process.env, profileRoot, chromePath, args = [] } = {}) {
  return async () => {
    if (env.BROWSERBASE_API_KEY?.trim() || env.BB_API_KEY?.trim()) {
      const { browserbaseProvider } = await import('@parcha/pi-browser/providers/browserbase');
      const perSecond = LIST_PRICES.sessionUsdPerHour / 3600;
      const billedSeconds = (seconds) => Math.max(seconds, LIST_PRICES.sessionMinimumS);
      return { name: 'browserbase', provider: browserbaseProvider({ env }), billedSeconds, usd: (seconds) => billedSeconds(seconds) * perSecond };
    }
    if (!profileRoot) throw new Error('a local browser needs a profile root under the run directory');
    const { cdpProvider } = await import('@parcha/pi-browser/providers/cdp');
    const executablePath = chromePath ?? env.CHROME_PATH?.trim() ?? '/usr/bin/google-chrome';
    return {
      name: 'chrome',
      provider: cdpProvider({ chrome: { executablePath, profileRoot, headless: true, args } }),
      usd: () => 0,
      // The provider keeps a session's downloads directory past its release; browse downloads nothing, so an empty one goes.
      released: (ref) => rmdir(join(profileRoot, `${ref.tag}.downloads`)).catch(() => {}),
    };
  };
}

const ACTION = {
  type: 'object', additionalProperties: false, required: ['op'],
  properties: {
    op: { type: 'string', enum: ['click', 'scroll', 'wait', 'goto'] },
    text: { type: 'string', description: 'click: the visible text of the link or button' },
    ms: { type: 'integer', minimum: 100, maximum: 10_000, description: 'wait: milliseconds' },
    url: { type: 'string', description: 'goto: an http(s) URL' },
  },
};

const BROWSE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'url', 'status', 'title', 'text', 'links', 'costUsd'],
  properties: {
    ok: { type: 'boolean', description: 'true when the page loaded with readable text and every action ran' },
    url: { type: 'string', description: 'the page the text came from, after redirects and actions' },
    status: { type: 'integer', description: 'HTTP status of the page; 0 when not known' },
    title: { type: 'string' },
    text: { type: 'string', maxLength: MAX_TEXT, description: 'the page\'s visible text, after its scripts ran' },
    links: { type: 'array', maxItems: MAX_LINKS, items: { type: 'string' }, description: 'same-site page links' },
    documents: { type: 'array', maxItems: MAX_DOCUMENT_LINKS, items: { type: 'string' }, description: 'links to PDFs and images on any allowed host, for read_document' },
    screenshot: { type: 'string', description: 'a path read_document takes, when a screenshot was asked for' },
    blocked: { type: 'array', items: { type: 'string' }, description: 'requests the page made to refused sites, which were not sent' },
    browser: { type: 'string' },
    seconds: { type: 'number', description: 'how long the browser was held' },
    billedSeconds: { type: 'number', description: 'the seconds the browser provider bills for this call (its minimum included); 0 for a local browser' },
    costUsd: { type: ['number', 'null'] },
    refused: { type: 'string', description: 'why the page was not opened, or why a navigation was stopped' },
    error: { type: 'string', description: 'why ok is false when nothing was refused' },
  },
};

const settle = 'await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(1000);';
// Only these templates run in the page, with the model's values as JSON literals: no code of the model's runs there.
const STEP = {
  goto: (url) => `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" }); ${settle}`,
  click: (text) => `await page.getByText(${JSON.stringify(text)}).first().click(); ${settle}`,
  scroll: () => 'await page.evaluate(() => window.scrollTo(0, document.body ? document.body.scrollHeight : 0)); await page.waitForTimeout(1000);',
  wait: (ms) => `await page.waitForTimeout(${Number(ms)});`,
};

function actionProblem(actions) {
  if (!Array.isArray(actions)) return 'actions is a list';
  if (actions.length > MAX_ACTIONS) return `at most ${MAX_ACTIONS} actions`;
  for (const [i, a] of actions.entries()) {
    const at = `action ${i + 1}`;
    if (!a || typeof a !== 'object') return `${at} is not an object`;
    if (a.op === 'click' && (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 200)) return `${at}: click needs the visible text (1 to 200 characters)`;
    else if (a.op === 'wait' && !(Number.isInteger(a.ms) && a.ms >= 100 && a.ms <= 10_000)) return `${at}: wait needs ms from 100 to 10000`;
    else if (a.op === 'goto' && typeof a.url !== 'string') return `${at}: goto needs a url`;
    else if (!['click', 'scroll', 'wait', 'goto'].includes(a.op)) return `${at}: op is click, scroll, wait or goto`;
  }
  return null;
}

const tidyText = (s) => {
  const lines = [];
  for (const line of String(s ?? '').split('\n')) {
    const clean = line.replace(/[\s ]+/g, ' ').trim();
    if (clean && clean !== lines.at(-1)) lines.push(clean);
  }
  return lines.join('\n');
};

const DOCUMENT_LINK = /\.(pdf|png|jpe?g|gif|webp)$/i;
const registrable = (host) => normalHost(host).split('.').slice(-2).join('.');

/** The page's anchors, resolved: same-site pages, and documents (PDFs, images) on any host the policy allows. */
function linksOf(html, pageUrl, lexical) {
  const page = new URL(pageUrl);
  const seen = new Set([page.href]);
  const links = [];
  const documents = [];
  for (const tag of String(html ?? '').match(/<a\b[^>]*>/gi) ?? []) {
    const m = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').replace(/&amp;/g, '&');
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, page);
    } catch {
      continue;
    }
    url.hash = '';
    if (seen.has(url.href) || lexical(url.href)) continue;
    seen.add(url.href);
    if (DOCUMENT_LINK.test(url.pathname)) {
      if (documents.length < MAX_DOCUMENT_LINKS) documents.push(url.href);
    } else if (registrable(url.hostname) === registrable(page.hostname) && links.length < MAX_LINKS) {
      links.push(url.href);
    }
  }
  return { links, documents };
}

/**
 * One browser session for one call, from `browser()` (`browserFromEnv`): created, put under the request guard (`capture`
 * passed on), driven by `work(page, guard, name)`, and released whatever happened. Returns `work`'s value, or `error`
 * when the session or the work failed, with the browser's name, the seconds it was held, the seconds its provider bills
 * and their price (null when a create that failed may have made a billed session).
 */
async function withBrowser({ browser, driver, openGuard = cdpRequestGuard, check, capture, signal, timeoutMs }, work) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let source;
  try {
    source = await browser();
  } catch (error) {
    return { error: `no browser: ${firstLine(error)}`, costUsd: 0, seconds: 0, billedSeconds: 0 };
  }
  const spec = {
    tag: `browse-${randomUUID().slice(0, 12)}`, maxLifetimeS: 300, idleTimeoutS: 120, proxies: false, verified: false, captcha: false,
    viewport: { width: 1280, height: 900 }, metadata: { tool: 'browse' },
  };
  let ref;
  let guard;
  let page;
  const out = { browser: source.name };
  const created = Date.now();
  try {
    ref = await source.provider.create(spec, abort);
    const target = await source.provider.attach(ref, abort);
    guard = await openGuard(target, { check, ...(capture ? { capture } : {}) });
    const makeDriver = driver ?? (await import('@parcha/pi-browser/driver/stagehand')).stagehandDriver();
    page = await makeDriver(target, abort, { batchTimeoutMs: 30_000 });
    const guarded = { run: async (input) => { if (abort.aborted) throw abort.reason; return page.run(input); }, page: () => page.page(), screenshot: (o) => page.screenshot(o) };
    out.value = await work(guarded, guard, source.name);
  } catch (error) {
    out.error = abort.aborted && !signal?.aborted ? `timed out after ${timeoutMs / 1000} s` : signal?.aborted ? 'cancelled' : firstLine(error);
  } finally {
    guard?.close();
    await page?.close().catch(() => {});
    if (ref) {
      await source.provider.release(ref).then(() => source.released?.(ref), (error) => {
        out.error = `the browser could not be released: ${firstLine(error)}`;
      });
    }
  }
  const seconds = (Date.now() - created) / 1000;
  // A create that threw may have made a session that bills; a local browser costs nothing either way.
  out.costUsd = ref ? source.usd(seconds) : source.usd(1) > 0 ? null : 0;
  out.seconds = Math.round(seconds * 10) / 10;
  out.billedSeconds = ref ? Math.round((source.billedSeconds?.(seconds) ?? 0) * 10) / 10 : 0;
  return out;
}

/**
 * browse: open one URL in a real browser, let its scripts run, optionally click, scroll, wait or go on, and read the
 * page's text, links and (asked for) a screenshot. A fresh browser per call, from `browser()` (`browserFromEnv`), released
 * when the call ends whatever happened. Every request the page makes goes through `guard` (`cdpRequestGuard`) and the URL
 * policy, so a redirect, a click or a frame to a refused site is stopped before it is sent. `root` is where screenshots are
 * written; their paths are relative to it.
 */
export function browseTool({ browser, root, driver, guard: openGuard = cdpRequestGuard, allowPrivate = false, lookup = dnsLookup, timeoutMs = BROWSE_TIMEOUT_MS }) {
  if (typeof browser !== 'function') throw new TypeError('browseTool needs browser: () => { name, provider, usd }');
  if (!root) throw new TypeError('browseTool needs root, where screenshots are written');
  const policy = urlPolicy({ allowPrivate, lookup });
  const empty = (url, extra = {}) => ({ ok: false, url, status: 0, title: '', text: '', links: [], costUsd: 0, ...extra });

  async function run(args, { signal } = {}) {
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    const actions = args?.actions ?? [];
    const problem = actionProblem(actions);
    if (problem) return empty(raw, { error: problem });
    for (const target of [raw, ...actions.filter((a) => a.op === 'goto').map((a) => a.url)]) {
      const why = await policy.check(target);
      if (why) return empty(raw, { refused: target === raw ? why : `goto ${target}: ${why}` });
    }
    const session = await withBrowser({ browser, driver, openGuard, check: policy.check, signal, timeoutMs }, async (page, guard, name) => {
      let failure = null;
      const step = async (code) => {
        try {
          await page.run({ code });
        } catch (error) {
          failure = error;
        }
      };
      await step(STEP.goto(raw));
      for (const action of actions) {
        if (failure) break;
        await step(action.op === 'click' ? STEP.click(action.text.trim()) : action.op === 'wait' ? STEP.wait(action.ms) : action.op === 'goto' ? STEP.goto(action.url) : STEP.scroll());
      }
      if (guard.closed) throw new Error('the request guard lost the browser, so the page cannot be trusted');
      const now = await page.page();
      const stopped = guard.refused.findLast((r) => r.main);
      const blocked = [...new Set(guard.refused.map((r) => r.url))].slice(0, 10);
      const base = { browser: name, ...(blocked.length ? { blocked } : {}) };
      if (String(now.url).startsWith('chrome-error:') || (stopped && failure)) {
        return empty(stopped?.url ?? raw, { ...base, ...(stopped ? { refused: `${stopped.url}: ${stopped.reason}` } : { error: `the page did not load${failure ? ` (${firstLine(failure)})` : ''}` }) });
      }
      if (policy.lexical(now.url)) return empty(now.url, { ...base, refused: `${now.url}: ${policy.lexical(now.url)}` });
      const text = tidyText(now.text).slice(0, MAX_TEXT);
      const { links, documents } = linksOf(now.html, now.url, policy.lexical);
      const result = { ok: !failure && text.length > 0, url: now.url, status: guard.status ?? 0, title: String(now.title ?? '').slice(0, 300), text, links, ...(documents.length ? { documents } : {}), ...base };
      if (failure) result.error = `an action failed: ${firstLine(failure)}`;
      else if (!text) result.error = 'the page has no visible text';
      if (args?.screenshot) {
        const shot = await page.screenshot({ type: 'png' });
        const bytes = Buffer.from(shot.data, 'base64');
        const file = `browse/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`;
        await mkdir(join(root, 'browse'), { recursive: true });
        await writeFile(join(root, file), bytes);
        result.screenshot = file;
      }
      return result;
    });
    const { value, error, ...spent } = session;
    return { ...(value ?? empty(raw, { ...(spent.browser ? { browser: spent.browser } : {}) })), ...(error ? { ok: false, error } : {}), costUsd: spent.costUsd, seconds: spent.seconds, billedSeconds: spent.billedSeconds };
  }

  return {
    name: 'browse',
    label: 'Browse',
    description: `Open a web page in a real browser, run its scripts, and read its visible text (at most ${MAX_TEXT} characters), up to ${MAX_LINKS} same-site links and links to PDFs and images. Use it for sites that need JavaScript or that fetch_page cannot read. actions, in order after the page loads: click (by visible text), scroll, wait (ms) or goto (url). screenshot: true saves a picture of the page that read_document can look at. SEC/EDGAR, SIC listing sites and web archives are refused on every navigation, redirect and click.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: {
        url: { type: 'string', description: 'an http(s) URL' },
        actions: { type: 'array', maxItems: MAX_ACTIONS, items: ACTION },
        screenshot: { type: 'boolean' },
      },
    },
    resultSchema: BROWSE_RESULT_SCHEMA,
    run,
  };
}

const LOOK = {
  type: 'object', additionalProperties: false, required: ['fragment', 'answer', 'costUsd'],
  properties: {
    page: { type: 'integer' }, fragment: { type: 'string' }, answer: { type: 'string' }, model: { type: 'string' },
    costUsd: { type: ['number', 'null'] }, receipt: { type: 'string' }, miss: { type: 'string', description: 'why this look could not be made' },
  },
};

const DOCUMENT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'source', 'kind', 'text', 'looks', 'costUsd'],
  properties: {
    ok: { type: 'boolean' },
    source: { type: 'string', description: 'the url or path asked for' },
    url: { type: 'string', description: 'the URL the document came from, after redirects, when it was downloaded' },
    via: { type: 'string', enum: ['direct', 'browser'], description: 'how it was downloaded: a plain request, or a browser session when the host turned the plain one away' },
    browser: {
      type: 'object', additionalProperties: false, required: ['browser', 'seconds', 'billedSeconds', 'costUsd'],
      properties: { browser: { type: 'string' }, seconds: { type: 'number' }, billedSeconds: { type: 'number' }, costUsd: { type: ['number', 'null'] } },
      description: 'the browser session the download took, when it took one; its cost is in costUsd',
    },
    path: { type: 'string', description: 'where the document is kept: pass it as path to read it again without downloading' },
    kind: { type: 'string', enum: ['pdf', 'image', 'unknown'] },
    sha256: { type: 'string' },
    bytes: { type: 'integer' },
    pageCount: { type: 'integer' },
    scanPages: { type: 'array', items: { type: 'integer' }, description: 'pages with no text layer: only a look reads them' },
    pagesShown: { type: 'array', items: { type: 'integer' }, description: 'the pages whose text is in text' },
    found: { type: 'array', items: { type: 'integer' }, description: 'pages whose text holds `find`' },
    text: { type: 'string', maxLength: MAX_DOCUMENT_TEXT, description: 'the text layer, each page headed [page N]' },
    looks: { type: 'array', items: LOOK, description: 'what the vision model answered to the question, per page looked at' },
    costUsd: { type: ['number', 'null'] },
    refused: { type: 'string' },
    error: { type: 'string' },
  },
};

const PNG = [0x89, 0x50, 0x4e, 0x47];
const WALL_STATUS = new Set([401, 403, 406, 429, 503]);
function kindOf(bytes) {
  const b = bytes;
  if (b.length >= 5 && Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-') return { kind: 'pdf', mimeType: 'application/pdf', ext: 'pdf' };
  if (PNG.every((x, i) => b[i] === x)) return { kind: 'image', mimeType: 'image/png', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mimeType: 'image/jpeg', ext: 'jpg' };
  if (Buffer.from(b.subarray(0, 4)).toString('latin1') === 'GIF8') return { kind: 'image', mimeType: 'image/gif', ext: 'gif' };
  if (Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return { kind: 'image', mimeType: 'image/webp', ext: 'webp' };
  return null;
}

/** A download within the policy: every hop checked before it is sent, at most DOCUMENT_HOPS redirects, `maxBytes` refused
 *  (a cut PDF is unreadable), no cookies or credentials. */
async function download(url, { policy, fetchImpl, maxBytes, timeoutMs, signal }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let at = url;
  try {
    for (let hop = 0; ; hop++) {
      const why = await policy.check(at);
      if (why) return { refused: hop ? `redirect to ${at}: ${why}` : why };
      const res = await fetchImpl(at, {
        redirect: 'manual', signal: abort, credentials: 'omit',
        headers: { 'user-agent': USER_AGENT, accept: 'application/pdf,image/*;q=0.9,*/*;q=0.1' },
      });
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) return { error: 'a redirect without a Location header' };
        if (hop >= DOCUMENT_HOPS) return { error: `more than ${DOCUMENT_HOPS} redirects` };
        at = new URL(location, at).href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { error: `HTTP ${res.status}`, status: res.status, url: at };
      }
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) {
        await res.body?.cancel();
        return { error: `the file is ${size(declared)}, over the ${size(maxBytes)} cap` };
      }
      const chunks = [];
      let got = 0;
      for await (const chunk of res.body ?? []) {
        got += chunk.length;
        if (got > maxBytes) return { error: `the file is over the ${size(maxBytes)} cap` };
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), url: at, type: res.headers.get('content-type') ?? '' };
    }
  } catch (error) {
    return { error: deadline.aborted ? `timed out after ${timeoutMs / 1000} s` : signal?.aborted ? 'cancelled' : `the download failed: ${firstLine(error)}` };
  }
}

/** A path under `root`, or null when it leads out of it. */
async function within(root, path) {
  if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) return null;
  const base = await realpath(root).catch(() => resolve(root));
  const target = await realpath(resolve(base, path)).catch(() => null);
  if (!target) return null;
  const rel = relative(base, target);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..') ? target : null;
}

const pagesProblem = (pages) => (pages === undefined ? null
  : !Array.isArray(pages) || !pages.length || pages.length > 10 || !pages.every((p) => Number.isInteger(p) && p >= 1) ? 'pages is a list of 1 to 10 page numbers' : null);

/**
 * read_document: a PDF or an image, from a URL (downloaded within the URL policy, at most 20 MB) or a path under `root`
 * (one this tool or browse kept). A host that turns a plain request away is asked again through `browser` (the same
 * sessions as browse, under the same guard). A PDF comes back as its text layer, page by page; with `find`, the pages that hold
 * those words; with `pages`, those pages' text. With `question`, the vision model looks at `pages` (or, without them, the
 * scanned pages shown) and answers about each: up to MAX_LOOKS looks a call. An image is looked at whole.
 *
 * The looks go through pi-vision's `vision.see` on `vision` (createVisionExtension) with `eyes` (`gatewayEyes`, through
 * the model gateway, or scripted ones), and each is filed as a receipt under `root`/evidence.
 */
export function readDocumentTool({ root, vision, browser, driver, guard: openGuard = cdpRequestGuard, allowPrivate = false, lookup = dnsLookup, fetch: fetchImpl = globalThis.fetch, maxBytes = MAX_DOCUMENT_BYTES, timeoutMs = DOCUMENT_TIMEOUT_MS }) {
  if (!root) throw new TypeError('readDocumentTool needs root, where documents are kept');
  if (!vision?.see) throw new TypeError('readDocumentTool needs vision: createVisionExtension(...) from @parcha/pi-vision/durable');
  const policy = urlPolicy({ allowPrivate, lookup });
  let calls = 0;

  async function looks(items, question, signal) {
    const done = [];
    let costUsd = 0;
    const call = { conversationId: 'learn-classify', callId: `read_document-${++calls}`, tool: 'read_document', model: undefined, signal };
    const see = vision.see(undefined, call);
    for (const item of items) {
      try {
        const answer = await see.execute({ ask: question, images: [{ type: 'image', data: item.data, mimeType: item.mimeType }], fragments: [item.fragment] }, { signal });
        costUsd = sumCost(costUsd, answer.costUsd);
        done.push({ ...(item.page ? { page: item.page } : {}), fragment: item.fragment, answer: answer.text, model: answer.model, costUsd: answer.costUsd, ...(answer.receipts[0] ? { receipt: answer.receipts[0] } : {}) });
      } catch (error) {
        if (signal?.aborted) throw error;
        // A look that failed after its request may have been billed; one refused before it (a typed miss) cost nothing.
        const unknown = error?.code === 'look_failed';
        costUsd = unknown ? null : costUsd;
        done.push({ ...(item.page ? { page: item.page } : {}), fragment: item.fragment, answer: '', costUsd: unknown ? null : 0, miss: firstLine(error) });
      }
    }
    return { looks: done, costUsd };
  }

  // The browser-backed download: the document opened in a browser session under the guard, every hop checked, and its
  // bytes taken from the browser's own response (`capture`). For a host that refuses a plain request.
  async function throughBrowser(target, signal) {
    const session = await withBrowser({ browser, driver, openGuard, check: policy.check, capture: { maxBytes }, signal, timeoutMs: BROWSE_TIMEOUT_MS }, async (page, guard) => {
      try {
        await page.run({ code: STEP.goto(target) });
      } catch {}
      const stopped = guard.refused.findLast((r) => r.main);
      if (stopped) return { refused: `${stopped.url}: ${stopped.reason}` };
      if (guard.closed) throw new Error('the request guard lost the browser, so the file cannot be trusted');
      const got = guard.captured;
      if (!got) return { error: 'the browser was given no PDF or image at that address' };
      return got.error ? { error: got.error } : { bytes: got.bytes, url: got.url };
    });
    const { value, error, ...spent } = session;
    return { ...(value ?? {}), ...(error ? { error: `through the browser: ${error}` } : {}), spent };
  }

  async function run(args, { signal } = {}) {
    const used = {};
    const result = await read(args, signal, used);
    if (!used.browser) return typeof args?.url === 'string' && args.url.trim() ? { ...result, via: 'direct' } : result;
    return { ...result, via: 'browser', browser: used.browser, costUsd: sumCost(result.costUsd, used.browser.costUsd) };
  }

  async function read(args, signal, used) {
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    const given = typeof args?.path === 'string' ? args.path.trim() : '';
    const question = typeof args?.question === 'string' ? args.question.trim() : '';
    const find = typeof args?.find === 'string' ? args.find.trim() : '';
    const source = url || given;
    const empty = (extra) => ({ ok: false, source, kind: 'unknown', text: '', looks: [], costUsd: 0, ...extra });
    if (!!url === !!given) return empty({ error: 'give exactly one of url and path' });
    const problem = pagesProblem(args?.pages) ?? (question.length > 500 ? 'the question is over 500 characters' : null) ?? (find.length > 100 ? 'find is over 100 characters' : null);
    if (problem) return empty({ error: problem });

    let bytes;
    let kept;
    let from;
    if (url) {
      let got = await download(url, { policy, fetchImpl, maxBytes, timeoutMs, signal });
      // A host that turns away a plain request (a bot wall: 401, 403, 406, 429, 503, or a page where a file was asked
      // for) is asked again through the browser, when there is one.
      const walled = WALL_STATUS.has(got.status) || (got.bytes && !kindOf(got.bytes) && /html/.test(got.type));
      if (walled && browser) {
        const viaBrowser = await throughBrowser(url, signal);
        if (viaBrowser.spent.browser) used.browser = viaBrowser.spent;
        if (viaBrowser.refused || viaBrowser.error) return empty(viaBrowser.refused ? { refused: viaBrowser.refused } : { error: `${got.error ?? 'a page, not a file'}; ${viaBrowser.error}` });
        got = viaBrowser;
      }
      if (got.refused || got.error) return empty(got.refused ? { refused: got.refused } : { error: got.error });
      bytes = got.bytes;
      from = got.url;
    } else {
      const at = await within(root, given);
      if (!at) return empty({ error: `${given} is not a file this run kept (a path from read_document or browse)` });
      const info = await stat(at);
      if (!info.isFile()) return empty({ error: `${given} is not a file` });
      if (info.size > maxBytes) return empty({ error: `the file is over the ${size(maxBytes)} cap` });
      bytes = await readFile(at);
      kept = at;
    }
    const kind = kindOf(bytes);
    if (!kind) return empty({ error: 'not a PDF or an image' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!kept) {
      kept = join(root, 'documents', `${sha256.slice(0, 16)}.${kind.ext}`);
      await mkdir(dirname(kept), { recursive: true });
      await writeFile(kept, bytes);
    }
    const path = relative(root, kept).split(sep).join('/');
    const name = url ? new URL(url).pathname.split('/').pop() || path : path;
    const base = { ok: true, source, ...(from ? { url: from } : {}), path, kind: kind.kind, sha256, bytes: bytes.length };

    if (kind.kind === 'image') {
      const ask = question || 'Write out all the text this image shows, tables row by row, then say in one sentence what the image is.';
      const seen = await looks([{ fragment: name, data: bytes.toString('base64'), mimeType: kind.mimeType }], ask, signal);
      return { ...base, text: '', ...seen, ok: seen.looks.some((l) => l.answer) };
    }

    const { nodeVisionEnv } = await import('@parcha/pi-vision/node');
    const { packageProviders } = await import('@parcha/pi-vision/durable');
    const ctx = { env: nodeVisionEnv({ cwd: root }), providers: packageProviders(), deriveDir: join(root, 'documents', 'derived'), signal };
    const pdf = { path: kept, kind: 'pdf', bytes: bytes.length, sha256 };
    const read = await pdfDocument(pdf, ctx);
    if (!read.ok) return { ...base, ok: false, text: '', looks: [], costUsd: 0, error: `${read.miss.code}: ${read.miss.detail}` };
    const texts = read.value.pages;
    const pageCount = texts.length;
    const scanPages = texts.flatMap((t, i) => (t.trim() ? [] : [i + 1]));
    const wanted = (args?.pages ?? []).filter((p) => p <= pageCount);
    const needle = find.toLowerCase();
    const found = needle ? texts.flatMap((t, i) => (t.toLowerCase().includes(needle) ? [i + 1] : [])) : undefined;
    const order = wanted.length ? wanted : Array.from({ length: pageCount }, (_, i) => i + 1).slice(found?.length ? found[0] - 1 : 0);
    let text = '';
    const pagesShown = [];
    for (const p of order) {
      const block = `[page ${p}]\n${texts[p - 1].trim() || '(no text layer: ask a question with pages to look at it)'}\n\n`;
      if (text && text.length + block.length > MAX_DOCUMENT_TEXT) break;
      text += block;
      pagesShown.push(p);
    }
    text = text.trim().slice(0, MAX_DOCUMENT_TEXT);
    let seen = { looks: [], costUsd: 0 };
    if (question) {
      const toLook = (wanted.length ? wanted : pagesShown.filter((p) => scanPages.includes(p))).slice(0, MAX_LOOKS);
      const items = [];
      for (const p of toLook) {
        const made = await pdfPage(pdf, ctx, { page: p, dpi: RENDER_DPI });
        items.push(made.ok
          ? { page: p, fragment: `${name}#page=${p}`, data: Buffer.from(made.value.image.data).toString('base64'), mimeType: made.value.image.mimeType }
          : { page: p, fragment: `${name}#page=${p}`, miss: `${made.miss.code}: ${made.miss.detail}` });
      }
      const renderable = items.filter((i) => !i.miss);
      seen = await looks(renderable, question, signal);
      for (const i of items.filter((i) => i.miss)) seen.looks.push({ page: i.page, fragment: i.fragment, answer: '', costUsd: 0, miss: i.miss });
      seen.looks.sort((a, b) => a.page - b.page);
    }
    return { ...base, pageCount, ...(scanPages.length ? { scanPages: scanPages.slice(0, 200) } : {}), pagesShown, ...(found ? { found: found.slice(0, 200) } : {}), text, ...seen };
  }

  return {
    name: 'read_document',
    label: 'Read document',
    description: `Read a PDF or an image (an annual report, an investor presentation, a screenshot from browse), from a url (at most ${size(maxBytes)}) or a path this run kept. A PDF comes back as its text, page by page (at most ${MAX_DOCUMENT_TEXT} characters a call): find names words to look for (the pages that hold them are listed and the text starts there), pages picks the pages to read. question has a vision model look at the pages you name (a segment table, a chart, a scan) and answer about each, at most ${MAX_LOOKS} pages a call; an image is always looked at. Each look costs money: name the pages first with find. SEC/EDGAR, SIC listing sites and web archives are refused.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'an http(s) URL of a PDF or an image' },
        path: { type: 'string', description: 'a path read_document or browse returned' },
        question: { type: 'string', description: 'what to find out by looking at the pages' },
        pages: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'integer', minimum: 1 }, description: 'the pages to read, and to look at when question is given' },
        find: { type: 'string', description: 'words to find in the text: the pages that hold them come back in found' },
      },
    },
    resultSchema: DOCUMENT_RESULT_SCHEMA,
    run,
  };
}

/** A receipt sink for pi-vision: each look as JSON under `root`/evidence/looks, named by its memo key. */
export function evidenceSink(root) {
  return {
    async file(_label, record) {
      const name = `evidence/looks/${record.facts.key.slice(0, 16)}.json`;
      await mkdir(join(root, 'evidence', 'looks'), { recursive: true });
      await writeFile(join(root, name), `${JSON.stringify(record, null, 2)}\n`);
      return { path: name };
    },
  };
}

/** pi-vision's handle for read_document: no tool of its own is installed, only `vision.see` is used, with `eyes`. */
export async function visionFor({ root, eyes }) {
  const { createVisionExtension } = await import('@parcha/pi-vision/durable');
  return createVisionExtension({
    eyes,
    evidence: evidenceSink(root),
    scope: () => ({ label: 'read_document', deriveDir: join(root, 'documents', 'derived') }),
    install: { read: 'off', guard: false },
  });
}

/**
 * The vision model, through the model gateway the run's models use (models.mjs: LEARN_CLASSIFY_GATEWAY, its key in
 * LEARN_CLASSIFY_GATEWAY_KEY): pi-ai's catalog entry for `model` (gemini-3.8-flash by default), served over the
 * gateway's OpenAI-compatible chat completions at `<gateway>/v1`, which is how the gateway serves Google's models.
 * Thinking stays on (pi-vision asks for `low` at least).
 */
export async function gatewayEyes(gateway, { model = 'gemini-3.8-flash', thinking = 'low' } = {}) {
  const [{ openAICompletionsApi }, { createModels, createProvider }, { googleProvider }, { modelsEyes }] = await Promise.all([
    import('@earendil-works/pi-ai/api/openai-completions.lazy'), import('@earendil-works/pi-ai/models'),
    import('@earendil-works/pi-ai/providers/google'), import('@parcha/pi-vision/durable'),
  ]);
  const entry = googleProvider().getModels().find((m) => m.id === model);
  if (!entry) throw new Error(`pi-ai has no Google model ${model}`);
  const baseUrl = `${gateway.root}/v1`;
  const models = createModels();
  models.setProvider(createProvider({
    id: 'google', name: 'Google through the gateway', baseUrl,
    auth: { apiKey: { name: 'LEARN_CLASSIFY_GATEWAY_KEY', resolve: async () => ({ auth: { apiKey: gateway.key }, source: 'LEARN_CLASSIFY_GATEWAY_KEY' }) } },
    models: [{ ...entry, api: 'openai-completions', provider: 'google', baseUrl }],
    api: openAICompletionsApi(),
  }));
  const eyes = modelsEyes(models, { provider: 'google', modelId: model }, { thinking });
  if (!eyes) throw new Error(`${model} takes no images`);
  return eyes;
}

/**
 * The three tools for one run, each reading the environment when it is called: search_web on Browserbase's Search API,
 * browse on a Browserbase session (a local Chrome under `profileRoot` without the key), and read_document with `eyes`
 * (`gatewayEyes`, or scripted ones). `root` is where the run's documents and screenshots go. `search`, `browser`,
 * `driver`, `guard`, `lookup` and `fetch` replace the live parts in tests.
 */
export async function hardJobTools({ root, profileRoot, search, eyes, env = process.env, browser, driver, guard, lookup, fetch, allowPrivate } = {}) {
  await mkdir(root, { recursive: true });
  const shared = { ...(allowPrivate ? { allowPrivate } : {}), ...(lookup ? { lookup } : {}) };
  const tools = [searchWebTool({ provider: search ?? browserbaseSearchProvider({ env }), ...(allowPrivate ? { allowPrivate } : {}) })];
  tools.push(browseTool({ browser: browser ?? browserFromEnv({ env, profileRoot }), root, ...(driver ? { driver } : {}), ...(guard ? { guard } : {}), ...shared }));
  tools.push(readDocumentTool({ root, vision: await visionFor({ root, eyes }), browser: browser ?? browserFromEnv({ env, profileRoot }), ...(driver ? { driver } : {}), ...(guard ? { guard } : {}), ...(fetch ? { fetch } : {}), ...shared }));
  return tools;
}

/** The hosts a run's tools touched, so the refused list can grow: `visited` (pages and documents that answered),
 *  `searched` (hosts search results named) and `refused` (what a tool refused; nothing was sent), each host with its
 *  count. `results` are the run's tool results as host.mjs's `toolResultsOf` reads them from its store. */
export function hostsOf(results) {
  const tally = { visited: {}, searched: {}, refused: {} };
  const add = (bucket, url) => {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    tally[bucket][host] = (tally[bucket][host] ?? 0) + 1;
  };
  for (const { tool, args, value } of results) {
    if (!value) continue;
    if (tool === 'search_web') for (const row of value.results ?? []) add('searched', row.url);
    if (tool === 'fetch_page' || tool === 'browse' || tool === 'read_document') {
      const url = tool === 'read_document' ? value.url ?? (args?.url || undefined) : value.url;
      if (value.refused) add('refused', url ?? args?.url);
      else if (url && (value.ok || value.status > 0)) add('visited', url);
    }
    if (tool === 'browse') for (const url of value.blocked ?? []) add('refused', url);
  }
  const sorted = (bucket) => Object.fromEntries(Object.entries(bucket).sort(([a], [b]) => a.localeCompare(b)));
  return { visited: sorted(tally.visited), searched: sorted(tally.searched), refused: sorted(tally.refused) };
}

/** Writes `<dir>/<run id>.json`: the run's hosts (`hostsOf`). */
export async function writeHosts({ dir, runId, results }) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${runId}.json`), `${JSON.stringify({ run: runId, ...hostsOf(results) }, null, 2)}\n`);
}

/** A public page that redirects to sec.gov: the guard must stop the second hop. */
export const SELF_TEST_URL = 'https://httpbin.org/redirect-to?url=https%3A%2F%2Fwww.sec.gov%2F';

/**
 * The browser's guard, checked once before a live pass starts: browse `url` (a redirect to sec.gov) on the browser the
 * pass will use and require that it comes back refused, with the refused request listed in `blocked`. Throws otherwise,
 * so the pass stops before its first job. Returns browse's result (its costUsd is the test's).
 */
export async function guardSelfTest({ root, profileRoot, env = process.env, url = SELF_TEST_URL, browser, driver, guard, lookup, allowPrivate }) {
  const tool = browseTool({ browser: browser ?? browserFromEnv({ env, profileRoot }), root, ...(driver ? { driver } : {}), ...(guard ? { guard } : {}), ...(lookup ? { lookup } : {}), ...(allowPrivate ? { allowPrivate } : {}) });
  const result = await tool.run({ url });
  const stopped = (result.blocked ?? []).some((blocked) => refusedHost(new URL(blocked).hostname));
  if (!result.refused || !stopped || result.text) {
    const seen = JSON.stringify({ ok: result.ok, url: result.url, refused: result.refused ?? null, error: result.error ?? null, blocked: result.blocked ?? [] });
    throw new Error(`the browser's request guard failed its self-test on ${result.browser ?? 'the browser'}: ${url} must come back refused with its refused request blocked; it came back ${seen}`);
  }
  return result;
}
