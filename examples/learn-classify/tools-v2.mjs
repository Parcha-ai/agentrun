// The hard job's tools: search_web, browse and read_document. Each refuses what fetch_page refuses (the SEC and its
// mirrors, SIC listings, web archives, any EDGAR host) on every request it makes and every result it returns, and none
// reaches this machine or its network: loopback, private, CGNAT and link-local addresses and single-label names are
// refused too. A tool answers with a typed result, never a throw, and every result carries `costUsd`: what the call cost,
// 0 when nothing billable happened, null when a request may have been billed at an unknown price.
import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, readFile, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIST_PRICES } from '@parcha/pi-browser';
import { pdfDocument, pdfPage } from '@parcha/pi-vision';
import { refusedHost } from './tools.mjs';

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

/** The values a take passes in for these tools and the gateway: read here at each call, never written anywhere. A
 *  recording replaces each one it finds (recording.mjs). Short values are left alone: no key is under 16 characters. */
export const SECRET_NAMES = Object.freeze(['BROWSERBASE_API_KEY', 'BB_API_KEY', 'BROWSERBASE_PROJECT_ID', 'LEARN_CLASSIFY_GATEWAY_KEY']);
export const secretValues = (env = process.env) => SECRET_NAMES.map((name) => env[name]?.trim()).filter((value) => value && value.length >= 16);

const size = (n) => (n >= 1048576 ? `${+(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const normalHost = (host) => String(host).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
const firstLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 300);

// Addresses on this machine or a network it sits on: unspecified, loopback, private, CGNAT (the tailnet), link-local,
// benchmarking, multicast and reserved. IPv6 adds unique-local, link-local, multicast, and IPv4 mapped or translated.
const V4_BLOCKED = [[0, 8], [10 << 24, 8], [100 << 24 | 64 << 16, 10], [127 << 24, 8], [169 << 24 | 254 << 16, 16], [172 << 24 | 16 << 16, 12],
  [192 << 24, 24], [192 << 24 | 168 << 16, 16], [198 << 24 | 18 << 16, 15], [224 << 24, 3]].map(([net, bits]) => [net >>> 0, bits]);
const v4Number = (address) => address.split('.').reduce((n, part) => (n * 256) + Number(part), 0);
const v4Blocked = (n) => V4_BLOCKED.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)));

function v6Words(address) {
  let text = address.split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4Number(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const part = (s) => (s ? s.split(':').map((w) => parseInt(w, 16)) : []);
  const words = tail === undefined ? part(head) : [...part(head), ...Array(8 - part(head).length - part(tail).length).fill(0), ...part(tail)];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** True for an IP literal that names this machine or a network it sits on. */
export function blockedAddress(address) {
  const host = normalHost(address);
  if (isIP(host) === 4) return v4Blocked(v4Number(host));
  if (isIP(host) !== 6) return false;
  const w = v6Words(host);
  if (!w) return true;
  if (w.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if ((w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xff00) === 0xff00) return true;
  const mapped = w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff;
  const nat64 = w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0);
  return (mapped || nat64) ? v4Blocked(((w[6] << 16) | w[7]) >>> 0) : false;
}

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'ts.net', 'lan', 'intranet'];

/** Why a host is never opened, judged on its name alone: a refused site (tools.mjs), or this machine or its network. */
export function refusedHostOf(host, { allowPrivate = false } = {}) {
  const h = normalHost(host);
  const refused = refusedHost(h);
  if (refused) return refused;
  if (allowPrivate) return null;
  if (!h || blockedAddress(h)) return `${h || 'an empty host'} is on this machine or its network`;
  if (isIP(h)) return null;
  if (!h.includes('.')) return `${h} is a single-label name, which resolves only on a local network`;
  if (LOCAL_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return `${h} is a local network name`;
  return null;
}

/** Why `raw` is never opened, judged on the URL alone, or null. */
export function refusedUrl(raw, options = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return `${JSON.stringify(String(raw).slice(0, 200))} is not a URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `only http and https URLs are opened, not ${url.protocol}`;
  if (url.username || url.password) return 'URLs with credentials are not opened';
  return refusedHostOf(url.hostname, options);
}

/** The URL check every request of a tool goes through: the name, then what the name resolves to here (once per host per
 *  policy). A name that does not resolve is left to the request to fail. */
export function urlPolicy({ allowPrivate = false, lookup = dnsLookup } = {}) {
  const resolved = new Map();
  const resolvesBlocked = (host) => {
    if (!resolved.has(host)) {
      resolved.set(host, lookup(host, { all: true, verbatim: true })
        .then((answers) => answers.find((a) => blockedAddress(a.address)) ?? null, () => null)
        .then((hit) => (hit ? `${host} resolves to ${hit.address}, on this machine or its network` : null)));
    }
    return resolved.get(host);
  };
  return {
    allowPrivate,
    lexical: (raw) => refusedUrl(raw, { allowPrivate }),
    async check(raw) {
      const why = refusedUrl(raw, { allowPrivate });
      if (why || allowPrivate) return why;
      const host = normalHost(new URL(raw).hostname);
      return isIP(host) ? null : resolvesBlocked(host);
    },
  };
}

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
 * search_web over a provider: `{ name, secrets?: () => string[], search({ query, n }, { signal }) }` answering
 * `{ results: [{ url, title, snippet? }], costUsd: number | null }`. The provider holds its key and reads it at each call;
 * `secrets` names the values to keep out of an error's words.
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

/** A $0 search provider for tests and scripted runs: answers from `results` (by query, or a function of it). */
export function fakeSearchProvider({ results = {}, costUsd = 0, fail } = {}) {
  const queries = [];
  return {
    name: 'fake',
    queries,
    async search({ query, n }) {
      queries.push(query);
      if (fail) throw new Error(fail);
      const rows = typeof results === 'function' ? results(query) : results[query] ?? [];
      return { results: rows.slice(0, n), costUsd };
    },
  };
}

/** Search through pi-browser's Browserbase provider (its Search API, at its list price), built at each call so the key is
 *  read from `env` then: BROWSERBASE_API_KEY, or BB_API_KEY. */
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
const SESSIONS = new Set([...GUARDED, 'worker']);

/**
 * A second DevTools client on the session that holds every request the browser makes until `check(url)` answers, and
 * fails it (BlockedByClient) when the answer is a refusal: navigations, redirect hops, clicked links, frames, popups and
 * subresources alike. It returns once interception is on for every open page; new targets start paused until theirs is
 * on. `refused` lists what it stopped (`main` marks a top-level document), `status` the HTTP status of the last top-level
 * document. If its socket closes or a page cannot be held, `closed` is set and the caller must not trust what the page
 * shows.
 */
export async function cdpRequestGuard(target, { check }) {
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
  const setup = ({ sessionId, targetInfo, waitingForDebugger }) => {
    const { type, targetId } = targetInfo;
    if (type === 'page') pages.set(sessionId, targetId);
    // Sent in order without waiting: a paused target answers renderer commands only after it resumes, and the resume
    // goes last so nothing it sends escapes before interception is on.
    const steps = [];
    // A page whose interception could not be turned on is not guarded: the guard counts as lost.
    if (GUARDED.has(type)) steps.push(send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId).catch((error) => { if (type === 'page') guard.closed = true; throw error; }));
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
      void decide(m.sessionId, m.params);
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
 *  priced at its list rate (a minute's minimum); else a local headless Chrome under `profileRoot`, killed by exact pid
 *  when the call ends, at $0. */
export function browserFromEnv({ env = process.env, profileRoot, chromePath, args = [] } = {}) {
  return async () => {
    if (env.BROWSERBASE_API_KEY?.trim() || env.BB_API_KEY?.trim()) {
      const { browserbaseProvider } = await import('@parcha/pi-browser/providers/browserbase');
      const perSecond = LIST_PRICES.sessionUsdPerHour / 3600;
      return { name: 'browserbase', provider: browserbaseProvider({ env }), usd: (seconds) => Math.max(seconds, LIST_PRICES.sessionMinimumS) * perSecond };
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
    const deadline = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let source;
    try {
      source = await browser();
    } catch (error) {
      return empty(raw, { error: `no browser: ${firstLine(error)}` });
    }
    const spec = {
      tag: `browse-${randomUUID().slice(0, 12)}`, maxLifetimeS: 300, idleTimeoutS: 120, proxies: false, verified: false, captcha: false,
      viewport: { width: 1280, height: 900 }, metadata: { tool: 'browse' },
    };
    let ref;
    let guard;
    let page;
    let result;
    let created = null;
    try {
      created = Date.now();
      ref = await source.provider.create(spec, abort);
      const target = await source.provider.attach(ref, abort);
      guard = await openGuard(target, { check: policy.check });
      const makeDriver = driver ?? (await import('@parcha/pi-browser/driver/stagehand')).stagehandDriver();
      page = await makeDriver(target, abort, { batchTimeoutMs: 30_000 });
      let failure = null;
      const step = async (code) => {
        if (abort.aborted) throw abort.reason;
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
      const base = { browser: source.name, ...(blocked.length ? { blocked } : {}) };
      if (String(now.url).startsWith('chrome-error:') || (stopped && failure)) {
        result = empty(stopped?.url ?? raw, { ...base, ...(stopped ? { refused: `${stopped.url}: ${stopped.reason}` } : { error: `the page did not load${failure ? ` (${firstLine(failure)})` : ''}` }) });
      } else if (policy.lexical(now.url)) {
        result = empty(now.url, { ...base, refused: `${now.url}: ${policy.lexical(now.url)}` });
      } else {
        const text = tidyText(now.text).slice(0, MAX_TEXT);
        const { links, documents } = linksOf(now.html, now.url, policy.lexical);
        result = { ok: !failure && text.length > 0, url: now.url, status: guard.status ?? 0, title: String(now.title ?? '').slice(0, 300), text, links, ...(documents.length ? { documents } : {}), ...base };
        if (failure) result.error = `an action failed: ${firstLine(failure)}`;
        else if (!text) result.error = 'the page has no visible text';
        if (args?.screenshot) {
          const shot = await page.screenshot({ type: 'png' });
          const bytes = Buffer.from(shot.data, 'base64');
          const name = `browse/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`;
          await mkdir(join(root, 'browse'), { recursive: true });
          await writeFile(join(root, name), bytes);
          result.screenshot = name;
        }
      }
    } catch (error) {
      result = empty(raw, { browser: source.name, error: abort.aborted && !signal?.aborted ? `timed out after ${timeoutMs / 1000} s` : signal?.aborted ? 'cancelled' : firstLine(error) });
    } finally {
      guard?.close();
      await page?.close().catch(() => {});
      if (ref) {
        await source.provider.release(ref).then(() => source.released?.(ref), (error) => {
          result = { ...result, ok: false, error: `the browser could not be released: ${firstLine(error)}` };
        });
      }
    }
    // A create that threw may have made a session that bills; one never asked for cost nothing.
    const seconds = created ? (Date.now() - created) / 1000 : 0;
    result.costUsd = ref ? source.usd(seconds) : created && source.usd(1) > 0 ? null : 0;
    result.seconds = Math.round(seconds * 10) / 10;
    return result;
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
        return { error: `HTTP ${res.status}` };
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
 * (one this tool or browse kept). A PDF comes back as its text layer, page by page; with `find`, the pages that hold
 * those words; with `pages`, those pages' text. With `question`, the vision model looks at `pages` (or, without them, the
 * scanned pages shown) and answers about each: up to MAX_LOOKS looks a call. An image is looked at whole.
 *
 * The looks go through pi-vision's `vision.see` on `vision` (createVisionExtension) with `eyes` (`gatewayEyes`, through
 * the model gateway, or scripted ones), and each is filed as a receipt under `root`/evidence.
 */
export function readDocumentTool({ root, vision, allowPrivate = false, lookup = dnsLookup, fetch: fetchImpl = globalThis.fetch, maxBytes = MAX_DOCUMENT_BYTES, timeoutMs = DOCUMENT_TIMEOUT_MS }) {
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

  async function run(args, { signal } = {}) {
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
    if (url) {
      const got = await download(url, { policy, fetchImpl, maxBytes, timeoutMs, signal });
      if (got.refused || got.error) return empty(got.refused ? { refused: got.refused } : { error: got.error });
      bytes = got.bytes;
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
    const base = { ok: true, source, path, kind: kind.kind, sha256, bytes: bytes.length };

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
 * The three tools for one run, from the environment at the time of the call: `search` (a provider for search_web; none
 * leaves search_web out), the browser (`browserFromEnv`: Browserbase with its key, else a local Chrome under
 * `profileRoot`), and the eyes (`gatewayEyes`, or scripted ones). `root` is where the run's documents and screenshots go.
 */
export async function hardJobTools({ root, profileRoot, search, eyes, env = process.env, browser, driver, guard, lookup, fetch, allowPrivate } = {}) {
  await mkdir(root, { recursive: true });
  const shared = { ...(allowPrivate ? { allowPrivate } : {}), ...(lookup ? { lookup } : {}) };
  const tools = [];
  if (search) tools.push(searchWebTool({ provider: search, ...(allowPrivate ? { allowPrivate } : {}) }));
  tools.push(browseTool({ browser: browser ?? browserFromEnv({ env, profileRoot }), root, ...(driver ? { driver } : {}), ...(guard ? { guard } : {}), ...shared }));
  tools.push(readDocumentTool({ root, vision: await visionFor({ root, eyes }), ...(fetch ? { fetch } : {}), ...shared }));
  return tools;
}
