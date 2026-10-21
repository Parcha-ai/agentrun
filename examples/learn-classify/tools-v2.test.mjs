// The hard job's tools at $0: search_web on a fake provider, browse on pi-browser's fake provider with a scripted page,
// read_document on PDFs a local 127.0.0.1 server serves and pi-vision's scripted eyes, the eyes' route through a fake
// gateway, the three tools inside a learn-classify run (root agent, workflow call nodes, agent nodes), and, where Chrome is
// installed, browse on a real headless Chrome against the local server, refusals proved by what the server never saw.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import sharp from 'sharp';
import { FakeBackend } from '@parcha/pi-browser/testing';
import { fakeEyes, pdfBytes, pngBytes } from '@parcha/pi-vision/testing';
import {
  agentHomeFor, answerV1, groupsOf, jobInput, meteredJudge, prepareRun, runJob, sic2GroupsTool, sicCodesTool, textsRead, toolResultsOf, toolStats,
} from './host.mjs';
import { gatewayOf } from './models.mjs';
import { DEMO_SPEC, recordingSecrets, writeRecording } from './recording.mjs';
import { validateRecording } from '../../scripts/recording/validate.mjs';
import { openOut, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { SETS } from './sets.mjs';
import { FIXTURES, fixtureFetch, readJson, scriptedJev, scriptedModel } from './scripted.mjs';
import {
  blockedAddress, browserbaseSearchProvider, browserFromEnv, browseTool, fontRowsOf, gatewayEyes, guardSelfTest, hardJobTools, hostsOf, MAX_DOCUMENT_BYTES,
  MAX_LARGE_DOCUMENT_BYTES, readDocumentTool, refusedUrl, searchFromEnv, searchWebTool, SELF_TEST_URL, snapshotFetch, urlPolicy, visionFor, writeHosts,
} from './tools-v2.mjs';
import { ANY_HOST, fetchPageTool } from './tools.mjs';

const ajv = new Ajv({ strict: false, allErrors: true });
const conforms = (tool, result) => {
  const validate = ajv.compile(tool.resultSchema);
  assert.ok(validate(result), `${tool.name}: ${ajv.errorsText(validate.errors)} in ${JSON.stringify(result).slice(0, 400)}`);
  return result;
};

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-tools-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A search provider that answers from `results` (by query, or a function of it) and logs every query it was sent. */
function fakeSearchProvider({ results = {}, costUsd = 0 } = {}) {
  const queries = [];
  return {
    name: 'fake',
    queries,
    async search({ query, n }) {
      queries.push(query);
      const rows = typeof results === 'function' ? results(query) : results[query] ?? [];
      return { results: rows.slice(0, n), costUsd };
    },
  };
}

/** Every name resolves to a public address, except names under bad.example, which resolve to a CGNAT address. */
const publicLookup = async (host) => (host.endsWith('bad.example') ? [{ address: '100.64.1.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);

/** A 127.0.0.1 server for named hosts: an injected fetch keeps the host in a header, so the host rules run on real names
 *  and nothing leaves the machine. A request without the header (another process probing the port) gets a 404. */
async function localWeb(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    const host = req.headers['x-test-host'];
    if (!host) { res.writeHead(404); return res.end(); }
    seen.push(`${host}${req.url}`);
    const route = routes[`${host}${req.url}`];
    if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    route(res);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  const fetch = (href, init = {}) => {
    const url = new URL(href);
    return globalThis.fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers: { ...init.headers, 'x-test-host': url.host } });
  };
  return { fetch, seen };
}

const send = (type, body, headers = {}) => (res) => { res.writeHead(200, { 'content-type': type, ...headers }); res.end(body); };
const redirect = (location) => (res) => { res.writeHead(302, { location }); res.end(); };


test('the URL policy refuses what fetch_page refuses, and this machine and its network, on the name and on what it resolves to', async () => {
  for (const url of ['https://www.sec.gov/cgi-bin/browse-edgar', 'https://sec.gov/', 'https://edgar.example.com/x', 'https://web.archive.org/web/2020/https://apple.com',
    'https://www.siccode.com/business/apple', 'https://archive.ph/abc']) assert.match(refusedUrl(url), /refused list|EDGAR/, url);
  for (const url of ['http://127.0.0.1:8080/v1', 'http://localhost:9229/json', 'http://[::1]/', 'http://10.1.2.3/', 'http://100.64.0.10/', 'http://169.254.169.254/latest',
    'http://[::ffff:127.0.0.1]/', 'http://0x7f000001/', 'http://2130706433/', 'http://192.168.1.1/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://0.0.0.0/',
    'http://fileserver/', 'http://box.tailnet.ts.net/', 'http://printer.local/', 'http://metadata.google.internal/']) assert.ok(refusedUrl(url), url);
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'chrome://settings']) assert.match(refusedUrl(url), /only http and https/, url);
  assert.match(refusedUrl('https://user:pw@example.com/'), /credentials/);
  for (const url of ['https://www.apple.com/', 'https://investor.apple.com/sec-filings/', 'http://8.8.8.8/', 'http://[2001:4860:4860::8888]/', 'https://en.wikipedia.org/wiki/Apple_Inc.']) {
    assert.equal(refusedUrl(url), null, url);
  }
  assert.equal(blockedAddress('::ffff:7f00:1'), true);
  assert.equal(blockedAddress('64:ff9b::a00:1'), true);
  assert.equal(blockedAddress('93.184.216.34'), false);

  const policy = urlPolicy({ lookup: publicLookup });
  assert.match(await policy.check('https://intranet.bad.example/'), /resolves to 100\.64\.1\.1/);
  assert.equal(await policy.check('https://www.acme.example/'), null);
  const unresolved = urlPolicy({ lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.equal(await unresolved.check('https://nowhere.example/'), null);
  // allowPrivate (tests only) lets loopback through, never a refused site.
  const loose = urlPolicy({ allowPrivate: true });
  assert.equal(await loose.check('http://127.0.0.1:8080/'), null);
  assert.match(await loose.check('https://www.sec.gov/'), /refused list/);
});

test('search_web: refused and private results are dropped and counted, a query naming a refused site is never sent, a failure keeps the key out of its words', async () => {
  const provider = fakeSearchProvider({
    results: {
      'Acme valves official site': [
        { url: 'https://www.acme.example/', title: 'Acme', snippet: 'Valves and pumps' },
        { url: 'https://www.sec.gov/cgi-bin/browse-edgar?company=acme', title: 'EDGAR', snippet: 'SIC 3491' },
        { url: 'https://www.acme.example/#top', title: 'Acme again', snippet: '' },
        { url: 'https://web.archive.org/web/2019/https://acme.example', title: 'archive', snippet: '' },
        { url: 'http://10.0.0.7/admin', title: 'internal', snippet: '' },
        { url: 'not a url', title: 'junk', snippet: '' },
        { url: 'https://en.wikipedia.org/wiki/Acme', title: 'Acme - Wikipedia', snippet: 'x'.repeat(900) },
      ],
    },
    costUsd: 0.007,
  });
  const tool = searchWebTool({ provider });
  const found = conforms(tool, await tool.run({ query: '  Acme valves   official site ' }));
  assert.deepEqual(found.results.map((r) => r.url), ['https://www.acme.example/', 'https://en.wikipedia.org/wiki/Acme']);
  assert.equal(found.filtered, 3);
  assert.equal(found.results[1].snippet.length, 500);
  assert.equal(found.costUsd, 0.007);
  assert.deepEqual(provider.queries, ['Acme valves official site']);

  for (const query of ['site:sec.gov Acme 10-K', 'acme sic code siccode.com', 'Acme https://www.sec.gov/cgi-bin/browse-edgar']) {
    const refused = conforms(tool, await tool.run({ query }));
    assert.match(refused.refused, /refused list|EDGAR/, query);
    assert.equal(refused.costUsd, 0);
  }
  assert.equal(provider.queries.length, 1);
  // A person's name is not a host: "Edgar" alone is a word, and the query goes.
  assert.equal((await tool.run({ query: 'Edgar Thomson Steel Works owner' })).ok, true);
  assert.equal(conforms(tool, await tool.run({ query: '' })).error, 'the query is empty');

  const key = 'bb_live_sentinel_0123456789';
  const failing = searchWebTool({ provider: { name: 'x', secrets: () => [key], search: async () => { throw new Error(`401 for key ${key}`); } } });
  const failed = conforms(failing, await failing.run({ query: 'acme' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.costUsd, null);
  assert.equal(JSON.stringify(failed).includes(key), false);
  assert.match(failed.error, /\[key\]/);
});

test('Browserbase search reads its key at each call, maps its rows and its price, and costs nothing when no key is set', async () => {
  const env = {};
  const made = [];
  const provider = browserbaseSearchProvider({
    env,
    make: (options) => {
      made.push(options.env.BROWSERBASE_API_KEY);
      return { search: async ({ query, n }) => ({ results: [{ url: 'https://www.acme.example/', title: `${query} ${n}` }, { url: 'https://www.sec.gov/x', title: null }], usage: { state: 'priced', usage: { cost: { total: 0.007 } } } }) };
    },
  });
  const tool = searchWebTool({ provider });
  const missing = conforms(tool, await tool.run({ query: 'acme' }));
  assert.equal(missing.costUsd, 0);
  assert.match(missing.error, /needs BROWSERBASE_API_KEY/);
  env.BROWSERBASE_API_KEY = 'set-after-the-tool-was-made';
  const answer = conforms(tool, await tool.run({ query: 'acme' }));
  assert.deepEqual(made, ['set-after-the-tool-was-made']);
  assert.deepEqual(answer.results, [{ url: 'https://www.acme.example/', title: 'acme 10', snippet: '' }]);
  assert.equal(answer.filtered, 1);
  assert.equal(answer.costUsd, 0.007);
  assert.deepEqual(provider.secrets(), ['set-after-the-tool-was-made']);
  assert.equal(searchFromEnv({}).name, 'browserbase');
});

// browse on pi-browser's fake provider. The scripted page runs the very code browse sends (its templates) against a
// Playwright-shaped fake page; every hop and subresource asks the guard, as the real one asks for each paused request.

function scriptedBrowser({ pages, redirects = {} }) {
  const backend = new FakeBackend();
  const log = { requests: [], code: [] };
  let guard;
  const linkByText = (html, text) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi)].find((m) => m[2].includes(text))?.[1];
  return {
    backend,
    log,
    browser: async () => ({ name: 'fake', provider: backend.provider, usd: () => 0 }),
    guard: async (_target, { check, capture }) => (guard = { refused: [], status: 0, closed: false, check, capture, close() {} }),
    driver: async () => {
      let current = { url: 'about:blank', title: '', text: '', html: '' };
      const load = async (href) => {
        let at = href;
        for (let hop = 0; hop < 5; hop++) {
          const why = await guard.check(at);
          if (why) {
            guard.refused.push({ url: at, reason: why, main: true });
            current = { url: 'chrome-error://chromewebdata/', title: '', text: 'This page has been blocked by Chrome', html: '' };
            throw new Error('net::ERR_BLOCKED_BY_CLIENT');
          }
          log.requests.push(at);
          if (redirects[at]) { at = new URL(redirects[at], at).href; continue; }
          const page = pages[at];
          guard.status = page ? 200 : 404;
          // A file the guard is set to take is handed over and not shown, as the real guard does.
          if (page?.document && guard.capture) {
            guard.captured = { url: at, status: 200, contentType: page.contentType, bytes: page.document };
            throw new Error('net::ERR_ABORTED');
          }
          current = page ? { url: at, title: page.title, text: page.text, html: page.html ?? '' } : { url: at, title: 'Not found', text: '', html: '' };
          for (const sub of page?.requests ?? []) {
            const subWhy = await guard.check(sub);
            if (subWhy) guard.refused.push({ url: sub, reason: subWhy, main: false }); else log.requests.push(sub);
          }
          return;
        }
      };
      const fakePage = {
        goto: (href) => load(href),
        getByText: (text) => ({ first: () => ({ click: async () => { const href = linkByText(current.html, text); if (!href) throw new Error('locator.click: no element matched'); await load(new URL(href, current.url).href); } }) }),
        evaluate: async () => undefined,
        waitForTimeout: async () => undefined,
        waitForLoadState: async () => undefined,
      };
      const AsyncFunction = (async () => {}).constructor;
      return {
        run: async ({ code }) => { log.code.push(code); return new AsyncFunction('page', code)(fakePage); },
        page: async () => current,
        url: async () => current.url,
        snapshot: async () => '',
        screenshot: async () => ({ data: Buffer.from(pngBytes(8, 6)).toString('base64'), mimeType: 'image/png' }),
        close: async () => undefined,
      };
    },
  };
}

const ACME = {
  'https://www.acme.example/': {
    title: 'Acme  Valves',
    text: 'Acme makes valves.\n\n\n   Rendered   by script.\nRendered   by script.',
    html: '<a href="/investors">Investors</a> <a href="https://www.sec.gov/edgar">SEC filings</a> <a href="https://ir.acme.example/annual">Annual</a> <a href="https://cdn.q4.example/files/ar-2025.pdf">Annual report (PDF)</a> <a href="https://www.sec.gov/x.pdf">10-K</a> <a href="https://other.example/">Partner</a> <a href="mailto:a@acme.example">Mail</a>',
    requests: ['https://www.acme.example/app.js', 'https://www.sec.gov/pixel.gif'],
  },
  'https://www.acme.example/investors': { title: 'Investors', text: 'Segment table: Valves 70%, Pumps 30%.', html: '' },
};

const browseOf = (scripted, root, extra = {}) => browseTool({ browser: scripted.browser, driver: scripted.driver, guard: scripted.guard, root, lookup: publicLookup, ...extra });
const ledgerOps = (backend) => backend.ledger.map((row) => row.op).filter((op) => ['create', 'attach', 'release'].includes(op));

const INDEX_HTML = '<html><head><title>EDGAR Filing Documents for 0000000001-26-000001</title></head><body><div class="companyInfo">ACME CORP (Filer) CIK: 0000000001 SIC: 5961 Business Address: 1 MAIN ST SPRINGFIELD IL</div></body></html>';
const PINNED = 'https://web.archive.org/web/20260224213732id_/https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A snapshot cache dir as C1 writes it: manifest.jsonl, one line per company, and the bodies. */
async function snapshotDir(t, lines) {
  const dir = await scratch(t);
  await mkdir(join(dir, 'bodies'));
  await writeFile(join(dir, 'bodies', '1-index.html'), INDEX_HTML);
  const rows = lines ?? [{ cik: '0000000001', chosen: { form: 'index', snapshot: PINNED, body: 'bodies/1-index.html', sha256: sha256(Buffer.from(INDEX_HTML)) } }];
  await writeFile(join(dir, 'manifest.jsonl'), `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
  return dir;
}

/** A live web that answers every request with `answer(href, n)` and logs what it was asked. */
function liveWeb(answer) {
  const asked = [];
  return { asked, fetch: async (href, init) => { asked.push(href); return answer(href, asked.length, init); } };
}
const refusedConnection = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

test('the snapshot cache: a pinned SEC capture comes back as the same bytes, the same result through fetch_page, and no request goes out', async (t) => {
  const dir = await snapshotDir(t);
  const live = liveWeb(() => new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const cached = snapshotFetch({ dir, fetch: live.fetch });
  const res = await cached(PINNED, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), INDEX_HTML);
  assert.deepEqual(live.asked, []);
  // Invisible to the agent: fetch_page gives the same result from the cache as from the live archive with the same bytes.
  const page = (fetch) => fetchPageTool({ allowDomain: ANY_HOST, archivedSec: true, fetch, lookup: publicLookup });
  const fromCache = await page(cached).run({ url: PINNED });
  const fromLive = await page(live.fetch).run({ url: PINNED });
  assert.deepEqual(fromCache, fromLive);
  assert.match(fromCache.text, /SIC: 5961/);
  assert.equal(live.asked.length, 1, 'only the live tool asked the archive');
  // Another time, or no flag: a redirect to the pinned capture, as the archive resolves a time; fetch_page follows it.
  const other = await cached('https://web.archive.org/web/2026/https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm', {});
  assert.deepEqual([other.status, other.headers.get('location')], [302, 'https://web.archive.org/web/20260224213732/https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm']);
  const followed = await page(cached).run({ url: 'https://web.archive.org/web/2026/http://sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm' });
  assert.deepEqual([followed.ok, followed.url, followed.text], [true, 'https://web.archive.org/web/20260224213732/http://sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm', fromLive.text]);
  assert.equal(live.asked.length, 1);
});

test('the snapshot cache: an uncached URL goes live, an archive that turns the connection away is asked again with back-off, and a damaged body is never served', async (t) => {
  const dir = await snapshotDir(t);
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const other = 'https://web.archive.org/web/2026id_/https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000001';
  const live = liveWeb((href, n) => { if (n <= 2) throw refusedConnection(); return new Response('<p>SIC: 5961</p>', { status: 200, headers: { 'content-type': 'text/html' } }); });
  const res = await snapshotFetch({ dir, fetch: live.fetch, sleep })(other, {});
  assert.equal(res.status, 200);
  assert.deepEqual(live.asked, [other, other, other]);
  assert.deepEqual(slept, [1000, 2000]);
  // A 429 is asked again too; after the last try, what came back is returned.
  const busy = liveWeb(() => new Response('slow down', { status: 429 }));
  slept.length = 0;
  assert.equal((await snapshotFetch({ dir, fetch: busy.fetch, sleep, retries: 2 })(other, {})).status, 429);
  assert.deepEqual([busy.asked.length, slept], [3, [1000, 2000]]);
  const down = liveWeb(() => { throw refusedConnection(); });
  await assert.rejects(snapshotFetch({ dir, fetch: down.fetch, sleep, retries: 1 })(other, {}), /fetch failed/);
  assert.equal(down.asked.length, 2);
  // Anything not on the archive goes out once, as it is.
  const site = liveWeb(() => { throw refusedConnection(); });
  await assert.rejects(snapshotFetch({ dir, fetch: site.fetch, sleep })('https://www.acme.example/', {}), /fetch failed/);
  assert.equal(site.asked.length, 1);
  // A body that no longer matches its sha256 is not served: the request goes live.
  await writeFile(join(dir, 'bodies', '1-index.html'), INDEX_HTML.replace('5961', '1311'));
  const fresh = liveWeb(() => new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
  assert.equal((await snapshotFetch({ dir, fetch: fresh.fetch, sleep })(PINNED, {})).status, 200);
  assert.deepEqual(fresh.asked, [PINNED]);
  // A line without its body, or a body outside the directory, is a miss; a directory without a manifest is refused.
  const loose = await snapshotDir(t, [{ cik: '1', chosen: { snapshot: PINNED, body: '../escape.html', sha256: 'x' } }, { cik: '2', chosen: null }, 'not json']);
  const missed = liveWeb(() => new Response('', { status: 404 }));
  assert.equal((await snapshotFetch({ dir: loose, fetch: missed.fetch, sleep })(PINNED, {})).status, 404);
  assert.throws(() => snapshotFetch({ dir: join(dir, 'nowhere') }), /no manifest\.jsonl/);
});

test('with archivedSec, all three hard-job tools take the Wayback Machine\'s copy of an SEC page, and still refuse sec.gov and every other archived site', async (t) => {
  const copy = 'https://web.archive.org/web/20260911112117id_/https://www.sec.gov/Archives/edgar/data/1/0000000001-26-000001-index.htm';
  assert.equal(refusedUrl(copy, { archivedSec: true }), null);
  assert.match(refusedUrl(copy), /refused list \(archive\.org/);
  for (const url of ['https://www.sec.gov/', 'https://data.sec.gov/submissions/CIK0000000001.json', 'https://web.archive.org/web/2026/https://www.siccode.com/x',
    'https://web.archive.org/cdx/search/cdx?url=sec.gov', 'https://archive.org/details/edgar']) assert.match(refusedUrl(url, { archivedSec: true }), /refused list/, url);
  const policy = urlPolicy({ lookup: publicLookup, archivedSec: true });
  assert.deepEqual([await policy.check(copy), policy.lexical(copy)], [null, null]);

  const root = await scratch(t);
  const search = fakeSearchProvider({ results: () => [{ url: copy, title: 'Filing index', snippet: 'SIC: 5961' }, { url: 'https://www.sec.gov/x', title: 'EDGAR', snippet: '' }] });
  const scripted = scriptedBrowser({ pages: { [copy]: { title: 'Filing index', text: 'SIC: 5961', html: '<p>SIC: 5961</p>' } } });
  const web = await localWeb(t, { [`web.archive.org${new URL(copy).pathname}`]: send('text/html', '<html><p>SIC: 5961</p></html>') });
  const parts = { root, search, eyes: fakeEyes(), browser: scripted.browser, driver: scripted.driver, guard: scripted.guard, fetch: web.fetch, lookup: publicLookup };
  const [found, browse, read] = await hardJobTools({ ...parts, archivedSec: true });
  assert.deepEqual((await found.run({ query: 'acme filing index' })).results.map((r) => r.url), [copy]);
  const page = conforms(browse, await browse.run({ url: copy }));
  assert.deepEqual([page.ok, page.text], [true, 'SIC: 5961']);
  assert.match(conforms(read, await read.run({ url: copy })).text, /SIC: 5961/);
  assert.match((await browse.run({ url: 'https://www.sec.gov/' })).refused, /refused list \(sec\.gov/);
  assert.match((await read.run({ url: 'https://web.archive.org/web/2026/https://www.siccode.com/x' })).refused, /refused list \(archive\.org/);
  for (const tool of [found, browse, read]) assert.match(tool.description, /The Wayback Machine's copy of an SEC page \(https:\/\/web\.archive\.org\/web\/<time>\/<sec\.gov URL>\) is the one exception/, tool.name);
  // Off by default: the same copy is dropped from results and refused.
  const [offFound, offBrowse, offRead] = await hardJobTools(parts);
  assert.deepEqual((await offFound.run({ query: 'acme filing index' })).results, []);
  assert.match((await offBrowse.run({ url: copy })).refused, /refused list \(archive\.org/);
  assert.match((await offRead.run({ url: copy })).refused, /refused list \(archive\.org/);
  for (const tool of [offFound, offBrowse, offRead]) assert.doesNotMatch(tool.description, /Wayback/, tool.name);
});

test('browse reads the page its scripts built: tidy text, same-site links, documents on any allowed host, refused links dropped, released after', async (t) => {
  const root = await scratch(t);
  const scripted = scriptedBrowser({ pages: ACME });
  const tool = browseOf(scripted, root);
  const page = conforms(tool, await tool.run({ url: 'https://www.acme.example/' }));
  assert.equal(page.ok, true);
  assert.equal(page.status, 200);
  assert.equal(page.text, 'Acme makes valves.\nRendered by script.');
  assert.deepEqual(page.links, ['https://www.acme.example/investors', 'https://ir.acme.example/annual']);
  assert.deepEqual(page.documents, ['https://cdn.q4.example/files/ar-2025.pdf']);
  assert.deepEqual(page.blocked, ['https://www.sec.gov/pixel.gif']);
  assert.equal(scripted.log.requests.some((r) => r.includes('sec.gov')), false);
  assert.equal(page.costUsd, 0);
  assert.equal(page.browser, 'fake');
  assert.deepEqual(ledgerOps(scripted.backend), ['create', 'attach', 'release']);
  // Only browse's own templates ran in the page, the URL as a JSON literal.
  assert.ok(scripted.log.code[0].startsWith('await page.goto("https://www.acme.example/"'));
});

test('browse refuses before a browser opens, and stops a redirect or a click to a refused site at the guard', async (t) => {
  const root = await scratch(t);
  const scripted = scriptedBrowser({ pages: ACME, redirects: { 'https://www.acme.example/old': 'https://www.sec.gov/cgi-bin/browse-edgar?CIK=1' } });
  const tool = browseOf(scripted, root);
  for (const [url, why] of [['https://www.sec.gov/', /refused list/], ['file:///etc/passwd', /only http/], ['http://127.0.0.1:9229/json', /this machine/], ['https://intranet.bad.example/', /resolves to/]]) {
    const refused = conforms(tool, await tool.run({ url }));
    assert.match(refused.refused, why, url);
    assert.equal(refused.costUsd, 0);
  }
  assert.match((await tool.run({ url: 'https://www.acme.example/', actions: [{ op: 'goto', url: 'https://web.archive.org/web/2020/acme' }] })).refused, /^goto https:\/\/web\.archive\.org/);
  assert.deepEqual(ledgerOps(scripted.backend), [], 'no browser was opened for a refused URL');

  const redirected = conforms(tool, await tool.run({ url: 'https://www.acme.example/old' }));
  assert.equal(redirected.ok, false);
  assert.match(redirected.refused, /^https:\/\/www\.sec\.gov\/cgi-bin\/browse-edgar\?CIK=1: www\.sec\.gov is on the refused list/);
  assert.equal(redirected.text, '');
  const clicked = conforms(tool, await tool.run({ url: 'https://www.acme.example/', actions: [{ op: 'click', text: 'SEC filings' }] }));
  assert.match(clicked.refused, /^https:\/\/www\.sec\.gov\/edgar: /);
  assert.equal(clicked.status, 0);
  assert.equal(scripted.log.requests.some((r) => r.includes('sec.gov')), false);
  assert.deepEqual(ledgerOps(scripted.backend), ['create', 'attach', 'release', 'create', 'attach', 'release']);

  const followed = conforms(tool, await tool.run({ url: 'https://www.acme.example/', actions: [{ op: 'scroll' }, { op: 'wait', ms: 500 }, { op: 'click', text: 'Investors' }] }));
  assert.equal(followed.ok, true);
  assert.equal(followed.url, 'https://www.acme.example/investors');
  assert.equal(followed.text, 'Segment table: Valves 70%, Pumps 30%.');
  const missed = conforms(tool, await tool.run({ url: 'https://www.acme.example/', actions: [{ op: 'click', text: 'No such link' }] }));
  assert.equal(missed.ok, false);
  assert.match(missed.error, /an action failed: locator\.click: no element matched/);
  assert.match(missed.text, /Acme makes valves/);
});

test('browse refuses malformed actions before a browser opens, saves a screenshot read_document can read, and always releases', async (t) => {
  const root = await scratch(t);
  const scripted = scriptedBrowser({ pages: ACME });
  const tool = browseOf(scripted, root);
  for (const actions of [[{ op: 'type', text: 'x' }], [{ op: 'click' }], [{ op: 'wait', ms: 60_000 }], Array(7).fill({ op: 'scroll' }), 'scroll']) {
    assert.ok(conforms(tool, await tool.run({ url: 'https://www.acme.example/', actions })).error, JSON.stringify(actions));
  }
  assert.deepEqual(ledgerOps(scripted.backend), []);

  const shot = conforms(tool, await tool.run({ url: 'https://www.acme.example/', screenshot: true }));
  assert.match(shot.screenshot, /^browse\/[0-9a-f]{16}\.png$/);
  assert.ok(existsSync(join(root, shot.screenshot)));
  const eyes = fakeEyes({ answers: ['A valve catalogue page.'] });
  const reader = readDocumentTool({ root, vision: await visionFor({ root, eyes }), lookup: publicLookup });
  const looked = conforms(reader, await reader.run({ path: shot.screenshot, question: 'What does this page show?' }));
  assert.equal(looked.kind, 'image');
  assert.equal(looked.looks[0].answer, 'A valve catalogue page.');

  // A driver that dies mid-call: the result says so and the session is still released.
  const dying = scriptedBrowser({ pages: ACME });
  const broken = browseTool({ browser: dying.browser, guard: dying.guard, root, lookup: publicLookup, driver: async () => { throw new Error('attaching to the browser failed'); } });
  const failed = conforms(broken, await broken.run({ url: 'https://www.acme.example/' }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /attaching to the browser failed/);
  assert.deepEqual(ledgerOps(dying.backend), ['create', 'attach', 'release']);
});

test('the browser comes from the environment at each call: Browserbase with its key (a minute at least, at list price), else a local Chrome', async () => {
  const env = {};
  const pick = browserFromEnv({ env, profileRoot: '/nonexistent/profiles' });
  assert.equal((await pick()).name, 'chrome');
  assert.equal((await pick()).usd(30), 0);
  env.BROWSERBASE_API_KEY = 'set-later';
  const cloud = await pick();
  assert.equal(cloud.name, 'browserbase');
  assert.equal(cloud.provider.name, 'browserbase');
  assert.ok(Math.abs(cloud.usd(10) - 0.002) < 1e-12);
  assert.ok(Math.abs(cloud.usd(120) - 0.004) < 1e-12);
  await assert.rejects(browserFromEnv({ env: {} })(), /profile root under the run directory/);
});

const REPORT = pdfBytes([
  { lines: ['Acme Corporation', 'Annual Report 2025'] },
  { lines: ['Business overview', 'Acme designs and makes industrial valves and pumps.'] },
  { lines: ['Note 14: Segment information', 'Valves 1,400 (70%)', 'Pumps 600 (30%)'] },
]);

async function scanned() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1100"><rect width="850" height="1100" fill="#f6f4ee"/><text x="100" y="200" font-size="40">Segment revenue: Valves 70%</text></svg>';
  return pdfBytes([{ lines: ['Cover page'] }, { jpeg: new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer()), width: 850, height: 1100 }]);
}

test('read_document downloads a PDF within the policy and gives its text by page, the pages that hold a phrase, and a kept path', async (t) => {
  const root = await scratch(t);
  const web = await localWeb(t, {
    'ir.acme.example/ar-2025.pdf': send('application/pdf', Buffer.from(REPORT)),
    'ir.acme.example/latest.pdf': redirect('https://cdn.q4.example/ar-2025.pdf'),
    'cdn.q4.example/ar-2025.pdf': send('application/octet-stream', Buffer.from(REPORT)),
  });
  const eyes = fakeEyes();
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes }), fetch: web.fetch, lookup: publicLookup });
  const doc = conforms(tool, await tool.run({ url: 'https://ir.acme.example/ar-2025.pdf' }));
  assert.equal(doc.ok, true);
  assert.equal(doc.kind, 'pdf');
  assert.equal(doc.pageCount, 3);
  assert.deepEqual(doc.pagesShown, [1, 2, 3]);
  assert.match(doc.text, /^\[page 1\]\nAcme Corporation/);
  assert.match(doc.text, /\[page 3\]\nNote 14: Segment information/);
  assert.equal(doc.looks.length, 0);
  assert.equal(doc.costUsd, 0);
  assert.match(doc.path, /^documents\/[0-9a-f]{16}\.pdf$/);
  assert.equal(eyes.ledger.length, 0);

  const found = conforms(tool, await tool.run({ path: doc.path, find: 'segment information' }));
  assert.deepEqual(found.found, [3]);
  assert.deepEqual(found.pagesShown, [3]);
  assert.equal(web.seen.length, 1, 'a kept path is read without downloading');
  const two = conforms(tool, await tool.run({ path: doc.path, pages: [2, 9] }));
  assert.deepEqual(two.pagesShown, [2]);

  const moved = conforms(tool, await tool.run({ url: 'https://ir.acme.example/latest.pdf' }));
  assert.equal(moved.sha256, doc.sha256);
  assert.deepEqual(web.seen.slice(1), ['ir.acme.example/latest.pdf', 'cdn.q4.example/ar-2025.pdf']);
});

test('read_document looks at the pages it is told to, or at the scanned pages it shows, with the eyes; each look is priced and filed', async (t) => {
  const root = await scratch(t);
  const web = await localWeb(t, { 'ir.acme.example/ar.pdf': send('application/pdf', Buffer.from(REPORT)), 'ir.acme.example/scan.pdf': send('application/pdf', Buffer.from(await scanned())) });
  const eyes = fakeEyes({ answers: [(request) => `I see ${request.parts.find((p) => p.type === 'text')?.fragment}: Valves are the largest segment at 70%.`] });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes }), fetch: web.fetch, lookup: publicLookup });
  const looked = conforms(tool, await tool.run({ url: 'https://ir.acme.example/ar.pdf', pages: [3], question: 'Which segment is largest, and its share?' }));
  assert.deepEqual(looked.looks.map((l) => [l.page, l.fragment]), [[3, 'ar.pdf#page=3']]);
  assert.match(looked.looks[0].answer, /^I see ar\.pdf#page=3: Valves/);
  assert.ok(looked.costUsd > 0);
  assert.equal(looked.costUsd, looked.looks[0].costUsd);
  assert.equal(eyes.ledger.length, 1);
  assert.equal(eyes.ledger[0].ask, 'Which segment is largest, and its share?');
  assert.ok(eyes.ledger[0].parts.some((p) => p.type === 'image' && p.width > 1000));
  const receipt = JSON.parse(await readFile(join(root, looked.looks[0].receipt), 'utf8'));
  assert.equal(receipt.body, looked.looks[0].answer);
  assert.equal(receipt.facts.cost_usd, looked.costUsd);

  const scan = conforms(tool, await tool.run({ url: 'https://ir.acme.example/scan.pdf', question: 'What does the scanned page say?' }));
  assert.deepEqual(scan.scanPages, [2]);
  assert.deepEqual(scan.looks.map((l) => l.page), [2]);
  assert.match(scan.text, /\[page 2\]\n\(no text layer/);
  const plain = conforms(tool, await tool.run({ url: 'https://ir.acme.example/ar.pdf', question: 'Anything?' }));
  assert.deepEqual(plain.looks, [], 'a text page is not looked at unless named');
});

test('read_document refuses a refused or private URL and a redirect to one, caps the size, and reads only files this run kept', async (t) => {
  const root = await scratch(t);
  const big = Buffer.alloc(150 * 1024, 0x20);
  big.write('%PDF-1.4');
  const web = await localWeb(t, {
    'ir.acme.example/to-sec.pdf': redirect('https://www.sec.gov/Archives/edgar/data/1/ar.pdf'),
    'ir.acme.example/to-tailnet.pdf': redirect('http://100.64.0.10/x.pdf'),
    'ir.acme.example/big.pdf': send('application/pdf', big, { 'content-length': String(big.length) }),
    'ir.acme.example/streamed.pdf': (res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'transfer-encoding': 'chunked' }); res.end(big); },
    'ir.acme.example/page.html': send('text/html', '<html>not a document</html>'),
    'ir.acme.example/notes.txt': send('text/plain', 'plain words'),
  });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup, maxBytes: 100 * 1024 });
  assert.match(conforms(tool, await tool.run({ url: 'https://www.sec.gov/Archives/x.pdf' })).refused, /refused list/);
  assert.match((await tool.run({ url: 'https://ir.acme.example/to-sec.pdf' })).refused, /^redirect to https:\/\/www\.sec\.gov\/.*refused list/);
  assert.match((await tool.run({ url: 'https://ir.acme.example/to-tailnet.pdf' })).refused, /^redirect to http:\/\/100\.64\.0\.10\/x\.pdf: .*this machine or its network/);
  assert.match((await tool.run({ url: 'https://files.bad.example/x.pdf' })).refused, /resolves to 100\.64\.1\.1/);
  assert.equal(web.seen.some((s) => s.includes('sec.gov') || s.includes('100.64')), false);
  assert.equal(conforms(tool, await tool.run({ url: 'https://ir.acme.example/big.pdf' })).error, 'the file is 150 KB, over the 100 KB cap');
  assert.equal((await tool.run({ url: 'https://ir.acme.example/streamed.pdf' })).error, 'the file is over the 100 KB cap');
  // An HTML page is read as the text it shows (read_document reads filings published as pages); other text is not a document.
  const page = conforms(tool, await tool.run({ url: 'https://ir.acme.example/page.html' }));
  assert.deepEqual([page.kind, page.text], ['html', '[page 1]\nnot a document']);
  assert.equal((await tool.run({ url: 'https://ir.acme.example/notes.txt' })).error, 'not a PDF or an image');
  for (const path of ['../../etc/passwd', '/etc/passwd', 'documents/none.pdf']) assert.match((await tool.run({ path })).error, /not a file this run kept/, path);
  assert.match((await tool.run({ url: 'https://ir.acme.example/a.pdf', path: 'x' })).error, /exactly one of url and path/);
  assert.match((await tool.run({ path: 'x', pages: [0] })).error, /pages is a list/);
  assert.equal(MAX_DOCUMENT_BYTES, 20 * 1024 * 1024);
});

test('read_document\'s failed request carries its HTTP status, so a rate limit is counted from the result', async (t) => {
  const root = await scratch(t);
  const busy = (status) => (res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end('slow down'); };
  const web = await localWeb(t, { 'ir.acme.example/busy.pdf': busy(429), 'ir.acme.example/gone.pdf': busy(404) });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup });
  const limited = conforms(tool, await tool.run({ url: 'https://ir.acme.example/busy.pdf' }));
  assert.deepEqual([limited.ok, limited.error, limited.status], [false, 'HTTP 429', 429]);
  assert.equal(conforms(tool, await tool.run({ url: 'https://ir.acme.example/gone.pdf' })).status, 404);
  // A refusal sent nothing, so it has no status.
  assert.equal('status' in conforms(tool, await tool.run({ url: 'https://www.sec.gov/x.pdf' })), false);
});

test('read_document without eyes, or with eyes that fail: the text still comes back, each look says why, a failed request has no known price', async (t) => {
  const root = await scratch(t);
  const web = await localWeb(t, { 'ir.acme.example/ar.pdf': send('application/pdf', Buffer.from(REPORT)), 'ir.acme.example/logo.png': send('image/png', Buffer.from(pngBytes(40, 20))) });
  const blind = readDocumentTool({ root, vision: await visionFor({ root }), fetch: web.fetch, lookup: publicLookup });
  const none = conforms(blind, await blind.run({ url: 'https://ir.acme.example/ar.pdf', pages: [3], question: 'Largest segment?' }));
  assert.match(none.text, /Segment information/);
  assert.match(none.looks[0].miss, /^no_vision_route/);
  assert.equal(none.costUsd, 0);
  const failing = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes({ answers: [{ fail: 'upstream 500' }] }) }), fetch: web.fetch, lookup: publicLookup });
  const failed = conforms(failing, await failing.run({ url: 'https://ir.acme.example/ar.pdf', pages: [3], question: 'Largest segment?' }));
  assert.match(failed.looks[0].miss, /^look_failed/);
  assert.equal(failed.costUsd, null);
  const image = conforms(failing, await failing.run({ url: 'https://ir.acme.example/logo.png' }));
  assert.equal(image.kind, 'image');
  assert.equal(image.ok, false);
});


test('read_document asks again through the browser when a host turns a plain request away, with every hop still checked and the session priced', async (t) => {
  const root = await scratch(t);
  const web = await localWeb(t, {
    'ir.walled.example/ar.pdf': (res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>Access denied</html>'); },
    'ir.walled.example/challenge.pdf': send('text/html', '<html><script>checking your browser</script></html>'),
    'ir.walled.example/to-sec.pdf': (res) => { res.writeHead(403); res.end(); },
    'ir.open.example/ar.pdf': send('application/pdf', Buffer.from(REPORT)),
  });
  const scripted = scriptedBrowser({
    pages: {
      'https://ir.walled.example/ar.pdf': { document: Buffer.from(REPORT), contentType: 'application/pdf' },
      'https://ir.walled.example/challenge.pdf': { document: Buffer.from(REPORT), contentType: 'application/octet-stream' },
    },
    redirects: { 'https://ir.walled.example/to-sec.pdf': 'https://www.sec.gov/Archives/edgar/data/1/ar.pdf' },
  });
  const priced = async () => ({ ...(await scripted.browser()), billedSeconds: (s) => Math.max(s, 60), usd: (s) => Math.max(s, 60) * 0.12 / 3600 });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), browser: priced, driver: scripted.driver, guard: scripted.guard, fetch: web.fetch, lookup: publicLookup });

  const walled = conforms(tool, await tool.run({ url: 'https://ir.walled.example/ar.pdf', find: 'Segment' }));
  assert.equal(walled.ok, true);
  assert.equal(walled.via, 'browser');
  assert.deepEqual(walled.found, [3]);
  assert.equal(walled.browser.billedSeconds, 60);
  assert.ok(Math.abs(walled.costUsd - 0.002) < 1e-9, 'the session is in the cost');
  assert.equal(conforms(tool, await tool.run({ url: 'https://ir.walled.example/challenge.pdf' })).via, 'browser');
  const refused = conforms(tool, await tool.run({ url: 'https://ir.walled.example/to-sec.pdf' }));
  assert.match(refused.refused, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\/ar\.pdf: www\.sec\.gov is on the refused list/);
  assert.equal(scripted.log.requests.some((r) => new URL(r).hostname.endsWith('sec.gov')), false);
  const open = conforms(tool, await tool.run({ url: 'https://ir.open.example/ar.pdf' }));
  assert.equal(open.via, 'direct');
  assert.equal(open.browser, undefined);
  assert.equal(ledgerOps(scripted.backend).filter((op) => op === 'create').length, 3, 'one session per walled document, none for an open one');

  const plain = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup });
  assert.equal((await plain.run({ url: 'https://ir.walled.example/ar.pdf' })).error, 'HTTP 403');
  const nobrowser = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), browser: async () => { throw new Error('no Chrome here'); }, fetch: web.fetch, lookup: publicLookup });
  const unopened = conforms(nobrowser, await nobrowser.run({ url: 'https://ir.walled.example/ar.pdf' }));
  assert.equal(unopened.error, 'HTTP 403; through the browser: no browser: no Chrome here');
  assert.equal(unopened.via, 'direct');
});

// An HTML annual report as filed: inline XBRL, whose hidden header (the filing's tagged facts) comes before anything shown,
// then the cover, the report's text, a segment table, a hidden note and a script. Made up, like every fixture here.
const FACTS = Array.from({ length: 400 }, (_, i) => `<ix:nonNumeric name="dei:Fact${i}" contextRef="c-${i}">http://fasb.org/us-gaap/2025#Member${i}</ix:nonNumeric>`).join('\n');
const FILING = `<!DOCTYPE html><html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><head><title>Form 20-F</title><style>.cover { text-align: center }</style></head><body>
<div style="display:none"><ix:header><ix:hidden>${FACTS}</ix:hidden><ix:resources><xbrli:context id="c-1"/></ix:resources></ix:header></div>
<div class="cover"><p>FORM 20-F</p><p>Harbor Valve Holdings Ltd.</p><p>12&#160;Dock Road, Harbor City, Fujian Province, China</p><p>(Address of principal executive offices)</p></div>
<div style="color: red; display: none">a hidden note that is never shown</div><p hidden>another hidden line</p>
${'<p>Item 4. Information on the company: what the company does and where it sells.</p>\n'.repeat(160)}
<h2>Segment information</h2><table><tr><th>Segment</th><th>Share</th></tr><tr><td>Valves</td><td>70%</td></tr><tr><td>Pumps &amp; parts</td><td>30%</td></tr></table>
<script>var cover = "principal executive offices";</script>
</body></html>`;
// An Exhibit 21 published as its own .htm page: a short table, no inline XBRL.
const EXHIBIT_21 = '<html><body><p>EXHIBIT 21.1</p><p>SUBSIDIARIES OF THE REGISTRANT</p><table><tr><th>Name</th><th>Jurisdiction</th></tr><tr><td>Harbor Valve Europe GmbH</td><td>Germany</td></tr><tr><td>Harbor Valve Supply, LLC</td><td>Delaware</td></tr></table></body></html>';

test('read_document reads an HTML filing: the inline-XBRL header and hidden parts dropped, its text in pages that find and pages reach', async (t) => {
  const root = await scratch(t);
  const web = await localWeb(t, {
    'ir.harbor.example/20f-2025.htm': send('text/html; charset=utf-8', FILING),
    'ir.harbor.example/ex21.htm': send('text/html', EXHIBIT_21),
    'ir.harbor.example/empty.htm': send('text/html', '<html><head><script>checking your browser</script></head><body></body></html>'),
  });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup });
  const doc = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/20f-2025.htm' }));
  assert.equal(doc.ok, true);
  assert.equal(doc.kind, 'html');
  assert.ok(doc.pageCount > 2, `pages: ${doc.pageCount}`);
  assert.match(doc.text, /^\[page 1\]\nFORM 20-F\nHarbor Valve Holdings Ltd\.\n12 Dock Road, Harbor City, Fujian Province, China\n\(Address of principal executive offices\)/);
  for (const hidden of [/fasb\.org/, /dei:Fact/, /hidden note/, /another hidden line/, /var cover/, /text-align/]) assert.doesNotMatch(doc.text, hidden);
  assert.match(doc.path, /^documents\/[0-9a-f]{16}\.html$/);
  assert.equal(doc.costUsd, 0);

  // find and pages work as on a PDF: the cover by its words, the segment table on its page, a kept path read again.
  const cover = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/20f-2025.htm', find: 'principal executive offices' }));
  assert.deepEqual(cover.found, [1]);
  const segments = conforms(tool, await tool.run({ path: doc.path, find: 'Segment information' }));
  assert.deepEqual(segments.found, [doc.pageCount]);
  assert.match(segments.text, /Valves 70%\nPumps & parts 30%/);
  assert.deepEqual(conforms(tool, await tool.run({ path: doc.path, pages: [2] })).pagesShown, [2]);
  // A look needs a page image, which an HTML page has none of: it says so and costs nothing.
  const looked = conforms(tool, await tool.run({ path: doc.path, pages: [1], question: 'What is the address?' }));
  assert.equal(looked.looks[0].miss, 'an HTML document has no page image to look at: read its text');
  assert.equal(looked.costUsd, 0);

  // An Exhibit 21 on its own page reads as its table.
  const exhibit = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/ex21.htm' }));
  assert.equal(exhibit.kind, 'html');
  assert.match(exhibit.text, /^\[page 1\]\nEXHIBIT 21\.1\nSUBSIDIARIES OF THE REGISTRANT\nName Jurisdiction\nHarbor Valve Europe GmbH Germany\nHarbor Valve Supply, LLC Delaware$/);

  // A page that shows nothing is still not a document.
  assert.match(conforms(tool, await tool.run({ url: 'https://ir.harbor.example/empty.htm' })).error, /a page, not a file/);
});

test('read_document asks the browser first for an HTML answer, as for a bot wall, and reads the HTML it downloaded when the browser finds no file there', async (t) => {
  const root = await scratch(t);
  const web = await localWeb(t, { 'ir.harbor.example/ex21.htm': send('text/html', EXHIBIT_21) });
  const scripted = scriptedBrowser({ pages: { 'https://ir.harbor.example/ex21.htm': { title: 'Exhibit 21', text: 'EXHIBIT 21.1', html: EXHIBIT_21 } } });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), browser: scripted.browser, driver: scripted.driver, guard: scripted.guard, fetch: web.fetch, lookup: publicLookup });
  const exhibit = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/ex21.htm', find: 'Delaware' }));
  assert.equal(exhibit.ok, true);
  assert.equal(exhibit.kind, 'html');
  assert.equal(exhibit.via, 'browser');
  assert.deepEqual(exhibit.found, [1]);
  assert.deepEqual(scripted.log.requests, ['https://ir.harbor.example/ex21.htm']);
});

test('the classify skill\'s headquarters hint on an IQV-shaped report: the cover, in the singular, is the earliest hit, and the exhibits\' registered office never is', async (t) => {
  const skill = readFileSync(join(import.meta.dirname, 'agent-v4', 'skills', 'classify', 'SKILL.md'), 'utf8');
  const step = skill.slice(skill.indexOf('4. The headquarters'), skill.indexOf('\n5. ')).replace(/\s+/g, ' ');
  const hint = /`find: "([^"]+)"`, and take the earliest hit/.exec(step)?.[1];
  assert.ok(hint, 'the skill names words to find the headquarters by, and to take the earliest hit');
  // Made up, shaped like IQV's 10-K: the cover says "office" in the singular; a bylaws exhibit far on says "offices"; an HR
  // letter in another exhibit gives a subsidiary's registered office abroad.
  const report = pdfBytes([
    { lines: ['FORM 10-K', 'Harbor Valve Holdings Inc.', '12 Dock Road, Durham, North Carolina 27703', '(Address of principal executive office and Zip Code)'] },
    { lines: ['Item 1. Business', 'We make industrial valves and pumps.'] },
    { lines: ['Exhibit 3.2 Bylaws', 'The principal executive offices of the Corporation shall be where the Board determines.'] },
    { lines: ['Exhibit 10.31', 'Welcome to the company.', 'Registered Office: 3 Forbury Place, Reading, United Kingdom'] },
  ]);
  const root = await scratch(t);
  const web = await localWeb(t, { 'ir.harbor.example/10k.pdf': send('application/pdf', Buffer.from(report)) });
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup });
  const doc = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/10k.pdf', find: hint }));
  assert.equal(doc.found[0], 1, 'the earliest hit is the cover');
  assert.equal(doc.found.includes(4), false, 'the letter\'s registered office is no hit');
  assert.match(doc.text, /^\[page 1\]\nFORM 10-K[\s\S]*Durham, North Carolina 27703\n\(Address of principal executive office and Zip Code\)/);
});

test('the classify skill\'s cover read on three report shapes: it reads the first pages, and each shape\'s cover is among them, never a late exhibit', async (t) => {
  const skill = readFileSync(join(import.meta.dirname, 'agent-v4', 'skills', 'classify', 'SKILL.md'), 'utf8');
  const step = skill.slice(skill.indexOf('2. The annual report'), skill.indexOf('\n3. ')).replace(/\s+/g, ' ');
  const first = /Read the first pages \(`pages: (\[[\d, ]+\])`\)/.exec(step)?.[1];
  assert.ok(first, 'the skill says which first pages the cover is read from');
  const pages = JSON.parse(first);
  const cover = (office) => ({ lines: ['UNITED STATES SECURITIES AND EXCHANGE COMMISSION', 'FORM 10-K', 'For the fiscal year ended December 31, 2025', 'Harbor Valve Holdings Inc.', '12 Dock Road, Durham, North Carolina 27703', `(Address of principal executive ${office} and Zip Code)`] });
  const body = (n) => ({ lines: [`Item ${n}. Business`, 'We make industrial valves and pumps.'] });
  // Made up, each shaped like a report a pass met: IQV's cover on p. 1 in the singular and a bylaws exhibit in the plural
  // far on; ACFN's site wrapper before the cover on p. 4; RILY's site chrome before the cover on p. 5.
  const shapes = {
    iqv: { cover: 1, pdf: [cover('office'), ...[2, 3, 4, 5, 6, 7].map(body), { lines: ['Exhibit 3.2 Bylaws', 'The principal executive offices of the Corporation shall be where the Board determines.'] }] },
    acfn: { cover: 4, pdf: [{ lines: ['site.example > Stocks > Harbor Valve Holdings', 'Annual Report 2026', 'Brought to you by site.example'] }, { lines: ['Contents of this copy'] }, { lines: ['Download the full filing'] }, cover('offices'), body(1)] },
    rily: { cover: 5, pdf: [{ lines: ['Home | Markets | News | Filings'] }, { lines: ['Harbor Valve Holdings filings'] }, { lines: ['Related companies'] }, { lines: ['Sign in to follow'] }, cover('offices'), body(1)] },
  };
  const root = await scratch(t);
  const web = await localWeb(t, Object.fromEntries(Object.entries(shapes).map(([k, v]) => [`ir.harbor.example/${k}.pdf`, send('application/pdf', Buffer.from(pdfBytes(v.pdf)))])));
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup });
  for (const [k, shape] of Object.entries(shapes)) {
    const doc = conforms(tool, await tool.run({ url: `https://ir.harbor.example/${k}.pdf`, pages }));
    assert.ok(doc.pagesShown.includes(shape.cover), `${k}: the cover, p. ${shape.cover}, is among the first pages read`);
    const block = doc.text.split(/\n(?=\[page \d+\])/).find((b) => b.startsWith(`[page ${shape.cover}]`));
    assert.match(block, /FORM 10-K[\s\S]*Harbor Valve Holdings Inc\.[\s\S]*12 Dock Road, Durham/, k);
    assert.equal(doc.pagesShown.some((p) => p > 6), false, `${k}: no late page is read for the cover`);
  }
  // The plural phrase lands on IQV's bylaws exhibit, not its cover: why the cover is located by what it is.
  const byPhrase = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/iqv.pdf', find: 'principal executive offices' }));
  assert.deepEqual(byPhrase.found, [8]);
});

const KB = 1024;
async function bigReport() {
  // A page of noise makes the file larger than the in-memory cap the tests set, as a 150 MB 20-F is larger than 20 MB.
  const noise = await sharp({ create: { width: 700, height: 700, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).jpeg({ quality: 95 }).toBuffer();
  return Buffer.from(pdfBytes([{ lines: ['FORM 10-K', 'Harbor Valve Holdings Inc.'] }, { jpeg: new Uint8Array(noise), width: 700, height: 700 }, { lines: ['Note 9: Segment information', 'Valves 70%'] }]));
}

test('read_document reads a PDF over its in-memory cap up to the hard cap: streamed to a file kept outside the run\'s evidence, read by pages and find, and gone when the tool is disposed', async (t) => {
  const big = await bigReport();
  assert.ok(big.length > 100 * KB && big.length < 2048 * KB, `${big.length} bytes`);
  const root = await scratch(t);
  const largeRoot = await scratch(t);
  const web = await localWeb(t, {
    'ir.harbor.example/big.pdf': send('application/pdf', big, { 'content-length': String(big.length) }),
    'ir.harbor.example/streamed.pdf': (res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'transfer-encoding': 'chunked' }); res.end(big); },
    'ir.harbor.example/huge.pdf': send('application/pdf', Buffer.concat([big, Buffer.alloc(2048 * KB)]), { 'content-length': String(big.length + 2048 * KB) }),
  });
  const vision = await visionFor({ root, eyes: fakeEyes() });
  const tool = readDocumentTool({ root, vision, fetch: web.fetch, lookup: publicLookup, maxBytes: 100 * KB, largeRoot, largeBytes: 2048 * KB });
  const doc = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/big.pdf', find: 'Segment information' }));
  assert.equal(doc.ok, true, doc.error);
  assert.deepEqual([doc.kind, doc.bytes, doc.pageCount, doc.found], ['pdf', big.length, 3, [3]]);
  assert.match(doc.path, /^large\/[0-9a-f]{16}\.pdf$/);
  // The file is kept in the tool's own directory under largeRoot, never under the run's evidence (which a recording reads).
  const [dir] = await readdir(largeRoot);
  assert.equal(readFileSync(join(largeRoot, dir, doc.path.slice('large/'.length))).length, big.length);
  assert.equal((await readdir(root, { recursive: true })).some((f) => f.endsWith(doc.path.slice('large/'.length))), false);
  // Read again by its path without downloading, by pages.
  const seen = web.seen.length;
  assert.match(conforms(tool, await tool.run({ path: doc.path, pages: [1] })).text, /^\[page 1\]\nFORM 10-K/);
  assert.equal(web.seen.length, seen);
  // A file with no declared length is streamed the same way; one over the hard cap is refused.
  assert.equal(conforms(tool, await tool.run({ url: 'https://ir.harbor.example/streamed.pdf' })).sha256, doc.sha256);
  assert.match(conforms(tool, await tool.run({ url: 'https://ir.harbor.example/huge.pdf' })).error, /over the 2 MB cap/);
  // Disposed with its run, the kept files are gone.
  await tool.dispose();
  assert.deepEqual(await readdir(largeRoot), []);
  // Without a place for large files, the in-memory cap stands as before.
  const plain = readDocumentTool({ root, vision, fetch: web.fetch, lookup: publicLookup, maxBytes: 100 * KB });
  assert.match((await plain.run({ url: 'https://ir.harbor.example/big.pdf' })).error, /over the 100 KB cap/);
  assert.equal(MAX_LARGE_DOCUMENT_BYTES, 256 * 1024 * 1024);
});

test('read_document reports a page whose fonts all lack a Unicode map like a scan: no text, in scanPages, out of find, and a question looks at it', async (t) => {
  // pdffonts, as poppler prints it for a 20-F whose text fonts are CID fonts with no ToUnicode map.
  const listing = [
    'name                                 type              encoding         emb sub uni object ID',
    '------------------------------------ ----------------- ---------------- --- --- --- ---------',
    'DNFJBK+Arial-BoldMT                  CID TrueType      Identity-H       yes yes no    3330  0',
    'DNFJAA+Calibri                       TrueType          Custom           yes yes yes   3301  0',
    'Helvetica                            Type 1            WinAnsi          no  no  no      12  0',
  ].join('\n');
  assert.deepEqual(fontRowsOf(listing).map((f) => [f.encoding, f.uni, f.decodable]), [['Identity-H', false, false], ['Custom', true, true], ['WinAnsi', false, true]]);
  const report = pdfBytes([{ lines: ['FORM 20-F', 'Harbor Valve Holdings SE'] }, { lines: ['81,7(\'67$7(6 Segment 6(&85,7,(6'] }, { lines: ['Note 9: Segment information', 'Valves 70%'] }]);
  const root = await scratch(t);
  const web = await localWeb(t, { 'ir.harbor.example/20f.pdf': send('application/pdf', Buffer.from(report)) });
  const asked = [];
  // The fonts of the whole file, and of one page; page 2 uses only a font with no Unicode map.
  const fonts = async (file, page) => { asked.push(page ?? 'all'); return page === 2 ? [fontRowsOf(listing)[0]] : page === undefined ? fontRowsOf(listing) : fontRowsOf(listing).slice(1); };
  const eyes = fakeEyes();
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes }), fetch: web.fetch, lookup: publicLookup, fonts });
  const found = conforms(tool, await tool.run({ url: 'https://ir.harbor.example/20f.pdf', find: 'Segment' }));
  assert.deepEqual(found.found, [3], 'the undecodable page is out of find');
  assert.ok(found.scanPages?.includes(2), JSON.stringify(found.scanPages));
  const looked = conforms(tool, await tool.run({ path: found.path, pages: [2], question: 'What does this page say?' }));
  assert.match(looked.text, /^\[page 2\]\n\(no text layer/);
  assert.equal(looked.looks.length, 1);
  assert.equal(eyes.ledger.length, 1, 'the question went to the eyes');
  // A file whose fonts all decode is never asked about page by page.
  const plainFonts = async (file, page) => { if (page !== undefined) throw new Error('no page check for a file whose fonts decode'); return fontRowsOf(listing).slice(1); };
  const plain = readDocumentTool({ root, vision: await visionFor({ root, eyes: fakeEyes() }), fetch: web.fetch, lookup: publicLookup, fonts: plainFonts });
  assert.deepEqual(conforms(plain, await plain.run({ url: 'https://ir.harbor.example/20f.pdf', find: 'Segment' })).found, [2, 3]);
});

test('a run disposes its tools when it ends, so a large document kept for it is gone after the run', async (t) => {
  const out = join(await scratch(t), 'out');
  let disposed = 0;
  const base = scriptedParts({ set: SETS.v2 });
  const parts = { ...base, toolsFor: async (job, run) => { const [first, ...rest] = await base.toolsFor(job, run); return [{ ...first, dispose: async () => { disposed += 1; } }, ...rest]; } };
  await runLoop({ out, parts, jobs: 2 });
  assert.equal(disposed, 2);
});

test('the eyes reach the model gateway: Google\'s model over its OpenAI-compatible chat completions at <gateway>/v1, with the gateway\'s key and thinking on', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!req.headers.authorization) { res.writeHead(404); return res.end(); }
      requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gemini-3.8-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Valves, 70%.' }, finish_reason: null }] });
      chunk({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gemini-3.8-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 6, total_tokens: 1206 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  // A take's broker variable names the OpenAI base URL; the gateway is its root either way.
  const gateway = gatewayOf({ LEARN_CLASSIFY_GATEWAY: `http://127.0.0.1:${server.address().port}/v1/`, LEARN_CLASSIFY_GATEWAY_KEY: 'gateway-placeholder' });
  assert.equal(gateway.root, `http://127.0.0.1:${server.address().port}`);
  const eyes = await gatewayEyes(gateway);
  assert.equal(eyes.model, 'google/gemini-3.8-flash');
  const root = await scratch(t);
  const tool = readDocumentTool({ root, vision: await visionFor({ root, eyes }), fetch: (await localWeb(t, { 'ir.acme.example/ar.pdf': send('application/pdf', Buffer.from(REPORT)) })).fetch, lookup: publicLookup });
  const doc = conforms(tool, await tool.run({ url: 'https://ir.acme.example/ar.pdf', pages: [3], question: 'Largest segment and its share?' }));
  assert.equal(doc.looks[0].answer, 'Valves, 70%.');
  assert.equal(doc.looks[0].model, 'google/gemini-3.8-flash');
  assert.ok(doc.costUsd > 0, 'priced from pi-ai\'s list price for the model');
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.auth, 'Bearer gateway-placeholder');
  assert.equal(request.body.model, 'gemini-3.8-flash');
  const parts = request.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.ok(parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
  assert.ok(parts.some((p) => p.type === 'text' && p.text.includes('Largest segment and its share?')));
  assert.equal(request.body.reasoning_effort, 'low');
});

test('a run offers the three tools to the root agent, to a workflow\'s call nodes and to its agent nodes, and its store holds every call\'s cost', async (t) => {
  const out = join(await scratch(t), 'out');
  const { repo } = await openOut(out, { mode: 'scripted' });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const labels = readJson(join(FIXTURES, 'sic2.json'));
  const job = { cik: '0000000001', name: 'Acme Corporation', website: 'https://www.acme.example/', sic2: '34', split: 'run', order: 1 };
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-tools', input: jobInput(job) });
  const root = join(run.dir, 'tool-files');
  const web = await localWeb(t, { 'ir.acme.example/ar.pdf': send('application/pdf', Buffer.from(REPORT)) });
  const scripted = scriptedBrowser({ pages: ACME });
  // Fake values in the names a take passes in, echoed by a tool result with a path under the run's directory.
  const key = 'bb_live_SENTINEL_0123456789abcdef';
  const project = '00000000-sentinel-project-0000000000';
  const search = fakeSearchProvider({ results: () => [{ url: 'https://www.acme.example/', title: 'Acme', snippet: `valves ${key} ${project} at ${run.dir}/evidence/note.txt` }] });
  const more = await hardJobTools({
    root, search, eyes: fakeEyes({ answers: ['Valves, 70%.'] }),
    browser: scripted.browser, driver: scripted.driver, guard: scripted.guard, fetch: web.fetch, lookup: publicLookup,
  });
  const [searchTool, browse, read] = more;
  const input = { ...jobInput(job), report: 'https://ir.acme.example/ar.pdf' };
  const workflow = {
    v: 2, name: 'read-segments',
    schemas: {
      Company: { type: 'object', additionalProperties: false, required: ['name', 'website', 'report'], properties: { name: { type: 'string' }, website: { type: 'string' }, report: { type: 'string' } } },
      Found: searchTool.resultSchema, Page: browse.resultSchema, Doc: read.resultSchema,
      Summary: { type: 'object', additionalProperties: false, required: ['business', 'url'], properties: { business: { type: 'string' }, url: { type: 'string' } } },
      Check: { type: 'object', additionalProperties: false, required: ['tools'], properties: { tools: { type: 'string' } } },
    },
    input: { schemaId: 'Company' },
    output: { schemaId: 'Summary', path: 'summary' },
    root: {
      node: 'chain',
      steps: [
        { node: 'call', label: 'find the site', via: 'tool', tool: 'search_web', args: { query: '{name}' }, out: 'Found', as: 'found', deadline_s: 30 },
        { node: 'call', label: 'open the site', via: 'tool', tool: 'browse', args: { url: '{website}' }, out: 'Page', as: 'page', deadline_s: 90 },
        { node: 'call', label: 'read the report', via: 'tool', tool: 'read_document', args: { url: '{report}', find: 'Segment', pages: [3], question: 'Largest segment?' }, out: 'Doc', as: 'doc', deadline_s: 60 },
        { node: 'agent', label: 'say what it does', tools: ['browse', 'read_document'], instructions: 'Open the site with browse and say what the company makes.', state: { website: '{website}' }, out: 'Summary', as: 'summary' },
        { node: 'agent', label: 'list the tools', instructions: 'Name the tools you were given.', state: { check: 'tools' }, out: 'Check', as: 'check' },
      ],
    },
  };
  const model = scriptedModel({
    root: [
      { call: 'search_web', args: { query: 'Acme Corporation official site' } },
      { call: 'browse', args: { url: 'https://www.acme.example/', actions: [{ op: 'click', text: 'Investors' }] } },
      { call: 'read_document', args: { url: 'https://ir.acme.example/ar.pdf', find: 'segment' } },
      { call: 'sic_codes', args: { group: '34' } },
      { call: 'agentrun', args: { action: 'inspect', workflow, input } },
      { call: 'agentrun', args: { action: 'run' } },
      { say: 'Done.' },
    ],
    node: (state, { offered, results }) => {
      if (state.check) return { submit: { tools: [...offered].sort().join(',') } };
      const page = results.find((r) => r.name === 'browse')?.value;
      return page ? { submit: { business: page.text.split('\n')[0], url: page.url } } : { call: 'browse', args: { url: state.website } };
    },
  });
  const codes = readJson(join(import.meta.dirname, 'data', 'sic-codes.json'));
  const effects = [fixtureFetch({}), ...more, sic2GroupsTool(labels), sicCodesTool(codes)];
  const measure = await runJob({ run, job, model, judge: meteredJudge(scriptedJev({ groups: groupsOf(labels) })), effects, answer: answerV1(labels) });
  assert.deepEqual(measure.reports, []);
  for (const name of ['search_web', 'browse', 'read_document', 'sic_codes']) assert.equal(measure.toolCalls[name], 1, name);
  const rootResults = model.requests.at(-1).messages.filter((m) => m.role === 'toolResult' && ['search_web', 'browse', 'read_document'].includes(m.toolName));
  for (const result of rootResults) assert.equal(JSON.parse(result.content.map((c) => c.text).join('')).ok, true, result.toolName);

  assert.equal(measure.workflowRuns.length, 1);
  assert.equal(measure.workflowRuns[0].outcome, 'complete');
  assert.deepEqual(measure.workflowRuns[0].output, { business: 'Acme makes valves.', url: 'https://www.acme.example/' });
  const offered = model.nodeRequests.map((r) => [...r.offered].sort().join(','));
  assert.ok(offered.includes('browse,read_document,submit'), offered.join(' | '));
  assert.ok(offered.includes('browse,fetch_page,read_document,search_web,sic2_groups,sic_codes,submit'), offered.join(' | '));
  for (const names of offered) for (const name of ['answer', 'learn', 'agentrun']) assert.equal(names.split(',').includes(name), false);

  // Root: one call each. Workflow: one call node each, and the agent node's browse. The host reads them all back from
  // the run's store, with what each cost.
  const results = toolResultsOf(run.storePath);
  const stats = toolStats(results);
  assert.deepEqual(stats.toolCalls, { search: 2, browse: 3, fetch: 0, read_document: 2 });
  assert.equal(stats.browserCostUsd, 0);
  assert.equal(stats.searchCostUsd, 0);
  assert.equal(stats.visionPages, 1);
  assert.ok(stats.documentCostUsd > 0, 'the look is priced');
  assert.ok(textsRead(results).some((r) => r.tool === 'read_document' && r.text.includes('Valves, 70%.')));
  assert.equal(ledgerOps(scripted.backend).filter((op) => op === 'release').length, 3);

  // The hosts it touched, for growing the refused list.
  const hosts = hostsOf(results);
  assert.deepEqual(hosts.visited, { 'ir.acme.example': 2, 'www.acme.example': 3 });
  assert.deepEqual(hosts.searched, { 'www.acme.example': 2 });
  assert.deepEqual(hosts.refused, { 'www.sec.gov': 3 });
  await writeHosts({ dir: join(out, 'hosts'), runId: run.runId, results });
  assert.deepEqual(JSON.parse(await readFile(join(out, 'hosts', `${run.runId}.json`), 'utf8')), { run: run.runId, ...hosts });

  // The recording holds neither value nor the run's path, and passes the gallery's validation and the record-time scan.
  // The two Browserbase values are registered through the demo spec (demo.json), as the reference recorder registers a
  // demo's keys; BB_API_KEY, which the spec does not declare, through the tools' own list.
  const other = 'bb_other_SENTINEL_9876543210';
  const env = { AGENTRUN_HOME: join(out, 'no-sign-in'), BROWSERBASE_API_KEY: key, BROWSERBASE_PROJECT_ID: project, BB_API_KEY: other, LEARN_CLASSIFY_GATEWAY_KEY: 'placeholder' };
  assert.deepEqual(DEMO_SPEC.keys[0].oneOf[0].map((k) => k.env), ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID']);
  assert.deepEqual(recordingSecrets(env).filter((s) => !s.key.startsWith('this machine')), [{ key: 'BROWSERBASE_API_KEY', value: key }, { key: 'BROWSERBASE_PROJECT_ID', value: project }, { key: 'BB_API_KEY', value: other }]);
  const into = join(out, 'recordings');
  await writeRecording({ into, run: { ...run, runId: run.runId }, job, model: 'faux/scripted', providers: 'scripted', started: 0, ended: 1, spend: { costUsd: null, judgeCostUsd: 0 }, modelUsd: null, env });
  const events = await readFile(join(into, run.runId, 'events.jsonl'), 'utf8');
  assert.equal(events.includes(key) || events.includes(project) || events.includes(run.dir), false);
  assert.ok(events.includes('valves [redacted] [redacted] at <run>/evidence/note.txt'), 'redacted and scrubbed in place');
  assert.deepEqual(validateRecording(join(into, run.runId)), []);
  assert.ok(existsSync(join(into, run.runId, 'manifest.json')));
});

test('the guard self-test passes when a redirect to sec.gov comes back refused and blocked, and throws when it comes back open', async (t) => {
  const root = await scratch(t);
  const held = scriptedBrowser({ pages: {}, redirects: { [SELF_TEST_URL]: 'https://www.sec.gov/' } });
  const passed = await guardSelfTest({ root, browser: held.browser, driver: held.driver, guard: held.guard, lookup: publicLookup });
  assert.match(passed.refused, /www\.sec\.gov is on the refused list/);
  assert.deepEqual(passed.blocked, ['https://www.sec.gov/']);
  assert.deepEqual(held.log.requests.map((r) => new URL(r).hostname), ['httpbin.org']);
  // Under a pass's archivedSec policy, the redirect to sec.gov itself is refused all the same.
  const archived = scriptedBrowser({ pages: {}, redirects: { [SELF_TEST_URL]: 'https://www.sec.gov/' } });
  const passedArchived = await guardSelfTest({ root, browser: archived.browser, driver: archived.driver, guard: archived.guard, lookup: publicLookup, archivedSec: true });
  assert.deepEqual(passedArchived.blocked, ['https://www.sec.gov/']);

  // A guard that lets the redirect through: the self-test throws, naming what came back.
  const open = scriptedBrowser({ pages: { 'https://www.sec.gov/': { title: 'SEC', text: 'EDGAR full-text search' } }, redirects: { [SELF_TEST_URL]: 'https://www.sec.gov/' } });
  const leaky = async (target, options) => Object.assign(await open.guard(target, { check: async () => null }), { check: async () => null });
  await assert.rejects(guardSelfTest({ root, browser: open.browser, driver: open.driver, guard: leaky, lookup: publicLookup }), /failed its self-test on fake: .*must come back refused/);
});

/** A live pass's parts at $0: the scripted v2 pass's tools and model, marked live, with a browser check on the scripted
 *  browser (one whose guard holds, or one that lets the redirect through). */
function liveScripted({ leaky = false, browserCheck = true, extra = [] } = {}) {
  const base = scriptedParts({ set: SETS.v2 });
  const held = scriptedBrowser({ pages: leaky ? { 'https://www.sec.gov/': { title: 'SEC', text: 'EDGAR' } } : {}, redirects: { [SELF_TEST_URL]: 'https://www.sec.gov/' } });
  const guard = leaky ? async (target) => Object.assign(await held.guard(target, { check: async () => null }), { check: async () => null }) : held.guard;
  return {
    ...base,
    mode: 'live',
    // A live pass names its node model; here the scripted one, at a level of its own.
    modelFor: (job, run) => ({ ...base.modelFor(job, run), node: { model: { provider: 'faux', modelId: 'scripted' }, thinkingLevel: 'medium' } }),
    toolsFor: async (job, run) => [...(await base.toolsFor(job, run)), ...extra],
    ...(browserCheck ? { browserCheck: (dir) => guardSelfTest({ root: dir, browser: held.browser, driver: held.driver, guard, lookup: publicLookup }) } : {}),
  };
}

test('every live pass checks itself before job 1: the tools offered, a refused code node and the browser guard, recorded in selftest.json', async (t) => {
  const out = join(await scratch(t), 'out');
  const { rows } = await runLoop({ out, parts: liveScripted(), jobs: 1 });
  assert.equal(rows.length, 1, 'the pass went on to its job');
  const report = JSON.parse(await readFile(join(out, 'selftest.json'), 'utf8'));
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.tools.root, ['agentrun', 'answer', 'browse', 'fetch_page', 'learn', 'read_document', 'search_web', 'sic2_groups', 'sic_codes']);
  assert.deepEqual(report.tools.callNode, ['browse', 'fetch_page', 'read_document', 'search_web', 'sic2_groups', 'sic_codes']);
  assert.deepEqual(report.tools.agentNode, ['browse', 'fetch_page', 'read_document', 'search_web', 'sic2_groups', 'sic_codes', 'submit']);
  assert.equal(report.codeNode.outcome, 'refused');
  assert.deepEqual(report.browser.blocked, ['https://www.sec.gov/']);
  // The self-test's own run lives in a home of its own: the pass's home holds only the pass's run.
  assert.deepEqual(await readdir(join(out, 'home', 'runs')), ['run-001']);
});

test('a live pass whose agent could run a command, or whose browser lets a sec.gov redirect through, stops before job 1', async (t) => {
  const root = await scratch(t);
  const shell = { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } }, resultSchema: { type: 'object' }, run: async () => ({}) };
  for (const [name, parts, why] of [
    ['bash', liveScripted({ extra: [shell] }), /root offers bash, not known to run neither a command nor code/],
    ['leaky', liveScripted({ leaky: true }), /failed its self-test on fake/],
    ['unchecked', liveScripted({ browserCheck: false }), /the pass has a browser and no browser check/],
  ]) {
    const out = join(root, name);
    await assert.rejects(runLoop({ out, parts, jobs: 1 }), why, name);
    assert.equal(existsSync(join(out, 'runs.jsonl')), false, name);
    assert.deepEqual(await readdir(join(out, 'home', 'runs')).catch(() => []), [], name);
    const report = JSON.parse(await readFile(join(out, 'selftest.json'), 'utf8'));
    assert.equal(report.ok, false, name);
  }
  // A sealed pass checks itself the same way.
  const sealedOut = join(root, 'bash');
  await assert.rejects(runSealed({ out: sealedOut, parts: liveScripted({ extra: [shell] }), at: 'seed' }), /root offers bash/);
});

// A real headless Chrome (its own profile under the test's directory, killed by exact pid), against a 127.0.0.1 server
// that answers every name (Chrome's host-resolver rule maps them all to it). Skips where no Chrome is installed.

const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome'].find((path) => existsSync(path));

test('browse and read_document on a real Chrome: scripts run, a walled PDF comes from the browser, and a redirect, a click and an image to a refused site never reach it', { skip: CHROME ? false : 'no Chrome on this machine', timeout: 240_000 }, async (t) => {
  const seen = [];
  let port;
  const server = createServer((req, res) => {
    const host = (req.headers['x-test-host'] ?? req.headers.host ?? '').split(':')[0];
    seen.push(`${host}${req.url}`);
    const html = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
    if (host === 'www.acme.test' && req.url === '/') {
      return html(`<html><head><title>Acme</title></head><body><div id="r"></div><script>document.getElementById('r').textContent = 'Rendered by script: Acme makes valves.';</script>
        <a href="/investors">Investors</a> <a href="http://www.sec.gov:${port}/cgi-bin/browse-edgar">SEC filings</a> <a href="http://cdn.q4.test:${port}/ar.pdf">Annual report</a>
        <img src="http://www.sec.gov:${port}/pixel.png"><iframe src="http://web.archive.org:${port}/web/2020/acme"></iframe></body></html>`);
    }
    if (host === 'www.acme.test' && req.url === '/investors') return html('<title>Investors</title><p>Segment table: Valves 70%, Pumps 30%.</p>');
    if (host === 'www.acme.test' && req.url === '/to-sec') { res.writeHead(302, { location: `http://www.sec.gov:${port}/cgi-bin/browse-edgar?CIK=1` }); return res.end(); }
    if (host === 'www.acme.test' && req.url === '/script-nav') return html(`<title>Moving</title><p>Moving on</p><script>setTimeout(() => { location.href = 'http://siccode.com:${port}/apple'; }, 50);</script>`);
    if (host === 'www.acme.test' && req.url === '/walled.pdf') {
      if (!/Chrome/.test(req.headers['user-agent'] ?? '')) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<p>Access denied</p>'); }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(Buffer.from(REPORT));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  port = server.address().port;
  const dir = await scratch(t);
  const profileRoot = join(dir, 'browser');
  const browser = browserFromEnv({ env: {}, profileRoot, chromePath: CHROME, args: ['--host-resolver-rules=MAP * 127.0.0.1'] });
  // Loopback is allowed here only because the test server is on it; the refused list holds as always.
  const tool = browseTool({ browser, root: join(dir, 'files'), allowPrivate: true });
  const at = (path) => `http://www.acme.test:${port}${path}`;

  const page = conforms(tool, await tool.run({ url: at('/'), screenshot: true }));
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(page.browser, 'chrome');
  assert.equal(page.status, 200);
  assert.match(page.text, /Rendered by script: Acme makes valves\./);
  assert.deepEqual(page.links, [at('/investors')]);
  assert.deepEqual(page.documents, [`http://cdn.q4.test:${port}/ar.pdf`]);
  assert.ok(page.blocked.includes(`http://www.sec.gov:${port}/pixel.png`), JSON.stringify(page.blocked));
  assert.ok(page.blocked.some((url) => url.startsWith(`http://web.archive.org:${port}/`)), JSON.stringify(page.blocked));
  assert.ok(existsSync(join(dir, 'files', page.screenshot)));

  const redirected = conforms(tool, await tool.run({ url: at('/to-sec') }));
  assert.match(redirected.refused, /www\.sec\.gov is on the refused list/);
  const tested = await guardSelfTest({ root: join(dir, 'files'), browser, url: at('/to-sec'), allowPrivate: true });
  assert.deepEqual(tested.blocked, [`http://www.sec.gov:${port}/cgi-bin/browse-edgar?CIK=1`]);
  const clicked = conforms(tool, await tool.run({ url: at('/'), actions: [{ op: 'click', text: 'SEC filings' }] }));
  assert.match(clicked.refused, /www\.sec\.gov is on the refused list/);
  const scripted = conforms(tool, await tool.run({ url: at('/script-nav'), actions: [{ op: 'wait', ms: 1500 }] }));
  assert.match(scripted.refused ?? '', /siccode\.com is on the refused list/, JSON.stringify(scripted));
  const followed = conforms(tool, await tool.run({ url: at('/'), actions: [{ op: 'click', text: 'Investors' }] }));
  assert.equal(followed.url, at('/investors'));
  assert.match(followed.text, /Valves 70%/);

  // Another process on the machine may probe a new loopback port by its address; no refused host ever arrives.
  // A host that turns away a plain request: read_document takes the file from the browser's own response.
  const direct = (href, init = {}) => { const u = new URL(href); return globalThis.fetch(`http://127.0.0.1:${port}${u.pathname}`, { ...init, headers: { ...init.headers, 'x-test-host': u.host } }); };
  const reader = readDocumentTool({ root: join(dir, 'files'), vision: await visionFor({ root: join(dir, 'files'), eyes: fakeEyes() }), browser, fetch: direct, allowPrivate: true });
  const walled = conforms(reader, await reader.run({ url: at('/walled.pdf'), find: 'Segment' }));
  assert.equal(walled.via, 'browser', JSON.stringify(walled));
  assert.deepEqual(walled.found, [3]);
  const blocked = conforms(reader, await reader.run({ url: at('/to-sec') }));
  assert.match(blocked.refused ?? '', /www\.sec\.gov is on the refused list/, JSON.stringify(blocked));

  const reached = new Set(seen.map((s) => s.split('/')[0]));
  assert.ok(reached.has('www.acme.test'));
  for (const host of reached) assert.equal(refusedUrl(`http://${host}/`, { allowPrivate: true }), null, `the server saw ${host}`);
  // Each call's Chrome is gone and its profile removed.
  assert.deepEqual(await readdir(profileRoot).catch(() => []), []);
});
