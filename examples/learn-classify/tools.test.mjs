// fetch_page against a local server bound to 127.0.0.1. Named hosts (www.acme.example, en.wikipedia.org) reach the same
// server through an injected fetch that keeps the host in a header, so the host rules run on real names with no network.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  ANY_HOST, blockedAddress, domainOf, fetchPageTool, MAX_BYTES, MAX_LINKS, MAX_TEXT, REFUSED_DOMAINS, refusedHost, refusedHostOf, refusedUrl, TIMEOUT_MS,
  urlPolicy, USER_AGENT,
} from './tools.mjs';

const HOME = `<!doctype html><html><head><title>Acme &amp; Sons — Valves</title>
<meta name="description" content="Acme makes industrial valves &amp; pumps.">
<style>body { color: red }</style><script>document.write('script text')</script></head>
<body><nav><a href="/menu">Menu</a></nav>
<main><h1>Valves for every plant</h1><p>We design &#38; build&nbsp;valves&#x21;</p><!-- a comment --><noscript>enable js</noscript>
<ul><li>Gate valves</li><li>Ball valves</li></ul>
<a href="/about">About</a> <a href="https://ir.acme.example/annual">Investors</a> <a href="https://evil.example/x">Elsewhere</a>
<a href="https://en.wikipedia.org/wiki/Valve">Wiki</a> <a href="mailto:a@acme.example">Mail</a> <a href="/brochure.pdf">PDF</a>
<a href="/about#team">About again</a> <a href="javascript:void(0)">JS</a> <a href="https://www.sec.gov/edgar">SEC</a></main>
<footer>© Acme</footer></body></html>`;

const WIKI = `<html><head><title>Acme - Wikipedia</title></head><body><div id="menu">Main page Contents</div>
<main id="content"><p>Acme is an American valve maker.</p><a href="/wiki/Valve">Valve</a> <a href="/wiki/Special:Search">Search</a>
<a href="/wiki/Help:Contents">Help</a> <a href="https://de.wikipedia.org/wiki/Acme">de</a> <a href="https://www.acme.example/">Official</a></main></body></html>`;

function routes(host, path, req, res, seen) {
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  if (path === '/home') return send(200, 'text/html; charset=utf-8', HOME, { 'set-cookie': 'session=1; Path=/' });
  if (path === '/headers') return send(200, 'text/plain', JSON.stringify({ ua: req.headers['user-agent'], cookie: req.headers.cookie ?? null }));
  if (path === '/wiki/Acme') return send(200, 'text/html', WIKI);
  if (path === '/plain') return send(200, 'text/plain; charset=utf-8', 'line one\n\n\n   line   two  \nline two\n');
  if (path === '/latin1') return send(200, 'text/html; charset=iso-8859-1', Buffer.from('<title>Caf\xe9</title><p>Caf\xe9 cr\xe8me</p>', 'latin1'));
  if (path === '/pdf') return send(200, 'application/pdf', '%PDF-1.4');
  if (path === '/missing') return send(404, 'text/html', '<title>Not found</title><p>No such page</p>');
  if (path === '/spa') return send(200, 'text/html', '<html><head><title>App</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>');
  if (path === '/to-home') return send(302, 'text/html', '', { location: '/home' });
  if (path === '/to-subdomain') return send(301, 'text/html', '', { location: 'https://ir.acme.example/home' });
  if (path === '/to-wiki') return send(302, 'text/html', '', { location: 'https://en.wikipedia.org/wiki/Acme' });
  if (path === '/to-other') return send(302, 'text/html', '', { location: 'https://acme-holdings.example/' });
  if (path === '/to-sec') return send(302, 'text/html', '', { location: 'https://www.sec.gov/cgi-bin/browse-edgar?company=acme' });
  if (path === '/to-twice') return send(302, 'text/html', '', { location: '/to-home' });
  if (path === '/to-nowhere') return send(302, 'text/html', '');
  if (path === '/to-archive') return send(302, 'text/html', '', { location: 'https://web.archive.org/web/2026/https://www.sec.gov/' });
  if (path === '/to-loopback') return send(302, 'text/html', '', { location: 'http://127.0.0.1:9222/json' });
  if (path === '/to-rebind') return send(302, 'text/html', '', { location: 'https://rebind.example/home' });
  if (path === '/long-text') return send(200, 'text/html', `<main>${Array.from({ length: 2000 }, (_, i) => `<p>line ${i} word word word</p>`).join('')}${Array.from({ length: 50 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')}</main>`);
  if (path === '/big') {
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = `<p>${'x'.repeat(16 * 1024 - 7)}</p>`;
    let sent = 0;
    const pump = () => {
      while (sent < 16 * MAX_BYTES) {
        sent += chunk.length;
        seen.bigSent = sent;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end('<p>TAIL-MARKER</p>');
    };
    res.on('close', () => { seen.bigClosedAt = sent; });
    return pump();
  }
  if (path === '/marker-late') return send(200, 'text/html', `<p>${'a'.repeat(2000)}</p><p>LATE-MARKER</p>`);
  if (path === '/slow') return; // never answers
  if (path === '/slow-body') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.write('<p>start');
  }
  send(404, 'text/plain', `no route for ${host}${path}`);
}

async function server(t) {
  const seen = { requests: [] };
  const open = new Set();
  const srv = createServer((req, res) => {
    const host = req.headers['x-test-host'] ?? 'direct';
    const path = new URL(req.url, 'http://x').pathname;
    seen.requests.push(`${host}${req.url}`);
    routes(host, path, req, res, seen);
  });
  srv.on('connection', (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of open) socket.destroy();
    return new Promise((resolve) => srv.close(resolve));
  });
  const { port } = srv.address();
  // Every request goes to 127.0.0.1; the host the tool asked for travels in x-test-host.
  const fetchVia = (href, init) => {
    const url = new URL(href);
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers: { ...init.headers, 'x-test-host': url.hostname } });
  };
  return { port, seen, fetchVia };
}

const acme = (s, options = {}) => fetchPageTool({ allowDomain: 'acme.example', fetch: s.fetchVia, ...options });

test('the tool has the contract shape and limits', () => {
  const tool = fetchPageTool({ allowDomain: 'acme.example' });
  assert.equal(tool.name, 'fetch_page');
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.deepEqual(tool.resultSchema.required, ['ok', 'url', 'status', 'title', 'text', 'links']);
  assert.equal(typeof tool.run, 'function');
  assert.equal(TIMEOUT_MS, 10_000);
  assert.equal(MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_TEXT, 8_000);
  assert.equal(MAX_LINKS, 30);
  assert.doesNotMatch(USER_AGENT, /@/);
});

test('a page on the real loopback server comes back as title, text and same-site links', async (t) => {
  const s = await server(t);
  const tool = fetchPageTool({ allowDomain: '127.0.0.1' });
  const page = await tool.run({ url: `http://127.0.0.1:${s.port}/home` });
  assert.equal(page.ok, true);
  assert.equal(page.status, 200);
  assert.equal(page.title, 'Acme & Sons — Valves');
  assert.equal(page.text.split('\n')[0], 'Acme makes industrial valves & pumps.');
  assert.match(page.text, /Valves for every plant\nWe design & build valves!\nGate valves\nBall valves/);
  assert.doesNotMatch(page.text, /script text|color: red|a comment|enable js|Menu|© Acme/);
  assert.deepEqual(page.links, [`http://127.0.0.1:${s.port}/menu`, `http://127.0.0.1:${s.port}/about`]);
});

test('requests carry the tool User-Agent and no cookie, even after a Set-Cookie', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  assert.equal((await tool.run({ url: 'https://www.acme.example/home' })).ok, true);
  const seen = JSON.parse((await tool.run({ url: 'https://www.acme.example/headers' })).text);
  assert.deepEqual(seen, { ua: USER_AGENT, cookie: null });
});

test('the company domain, its subdomains and Wikipedia are allowed; links stay on the site', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  const home = await tool.run({ url: 'https://www.acme.example/home' });
  assert.equal(home.ok, true);
  assert.deepEqual(home.links, ['https://www.acme.example/menu', 'https://www.acme.example/about', 'https://ir.acme.example/annual']);
  assert.equal((await tool.run({ url: 'https://acme.example/home' })).ok, true);
  assert.equal((await tool.run({ url: 'https://ir.acme.example/home' })).ok, true);
  const wiki = await tool.run({ url: 'https://en.wikipedia.org/wiki/Acme' });
  assert.equal(wiki.ok, true);
  assert.equal(wiki.text, 'Acme is an American valve maker.\nValve Search\nHelp de Official');
  assert.deepEqual(wiki.links, ['https://en.wikipedia.org/wiki/Valve']);
  assert.deepEqual(s.seen.requests, ['www.acme.example/home', 'acme.example/home', 'ir.acme.example/home', 'en.wikipedia.org/wiki/Acme']);
});

test('other hosts, SEC, EDGAR and SIC listing sites are refused before any request, never thrown', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  const refused = async (url, pattern) => {
    const page = await tool.run({ url });
    assert.equal(page.ok, false, url);
    assert.equal(page.status, 0, url);
    assert.match(page.refused, pattern, url);
    assert.deepEqual([page.title, page.text, page.links], ['', '', []]);
  };
  await refused('https://evil.example/', /outside the allowed hosts/);
  await refused('https://acme.example.evil.example/', /outside the allowed hosts/);
  await refused('https://notacme.example/', /outside the allowed hosts/);
  await refused('https://www.sec.gov/cgi-bin/browse-edgar?company=acme', /refused list \(sec\.gov/);
  await refused('https://efts.sec.gov/LATEST/search-index?q=acme', /refused list \(sec\.gov/);
  await refused('https://edgar.acme.example/filings', /EDGAR/);
  await refused('https://www.siccode.com/business/acme', /refused list \(siccode\.com/);
  await refused('https://www.naics.com/company/acme', /refused list \(naics\.com/);
  await refused('https://www.osha.gov/data/sic-manual', /refused list \(osha\.gov/);
  await refused('https://web.archive.org/web/2026id_/https://data.sec.gov/submissions/CIK0000320193.json', /refused list \(archive\.org/);
  await refused('https://archive.org/details/edgar', /refused list \(archive\.org/);
  await refused('https://archive.ph/acme.example', /refused list \(archive\.ph/);
  await refused('ftp://www.acme.example/', /only http and https/);
  await refused('javascript:alert(1)', /only http and https/);
  await refused('https://user:pw@www.acme.example/', /credentials/);
  await refused('/home', /not a URL/);
  await refused('', /not a URL/);
  assert.equal((await tool.run({})).refused, '"" is not a URL');
  assert.equal((await tool.run({ url: 42 })).refused, '"" is not a URL');
  assert.deepEqual(s.seen.requests, []);
});

test('the refused list wins over allowDomain, which must name a real domain', () => {
  assert.throws(() => fetchPageTool({ allowDomain: 'sec.gov' }), /refused site/);
  assert.throws(() => fetchPageTool({ allowDomain: 'www.siccode.com' }), /refused site/);
  assert.throws(() => fetchPageTool({ allowDomain: 'archive.org' }), /refused site/);
  assert.throws(() => fetchPageTool({ allowDomain: 'com' }), /allowDomain must be a domain/);
  assert.throws(() => fetchPageTool({}), /allowDomain must be a domain/);
  for (const domain of REFUSED_DOMAINS) assert.ok(refusedHost(`www.${domain}`), domain);
  assert.equal(refusedHost('www.acme.example'), null);
  assert.equal(refusedHost('fedgarage.example'), null);
});

test('one redirect hop is followed inside the allowed hosts and nowhere else', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  const local = await tool.run({ url: 'https://www.acme.example/to-home' });
  assert.equal(local.ok, true);
  assert.equal(local.url, 'https://www.acme.example/home');
  assert.equal((await tool.run({ url: 'https://www.acme.example/to-subdomain' })).url, 'https://ir.acme.example/home');
  assert.equal((await tool.run({ url: 'https://www.acme.example/to-wiki' })).title, 'Acme - Wikipedia');

  const other = await tool.run({ url: 'https://www.acme.example/to-other' });
  assert.equal(other.ok, false);
  assert.equal(other.status, 302);
  assert.match(other.refused, /^redirect to https:\/\/acme-holdings\.example\/: acme-holdings\.example is outside the allowed hosts/);
  const sec = await tool.run({ url: 'https://www.acme.example/to-sec' });
  assert.match(sec.refused, /^redirect to https:\/\/www\.sec\.gov\/.*refused list/);
  const twice = await tool.run({ url: 'https://www.acme.example/to-twice' });
  assert.equal(twice.ok, false);
  assert.match(twice.refused, /a second redirect \(to https:\/\/www\.acme\.example\/home\)/);
  assert.equal((await tool.run({ url: 'https://www.acme.example/to-nowhere' })).error, 'a redirect without a Location header');
  assert.deepEqual(s.seen.requests, [
    'www.acme.example/to-home', 'www.acme.example/home', 'www.acme.example/to-subdomain', 'ir.acme.example/home', 'www.acme.example/to-wiki',
    'en.wikipedia.org/wiki/Acme', 'www.acme.example/to-other', 'www.acme.example/to-sec', 'www.acme.example/to-twice', 'www.acme.example/to-home',
    'www.acme.example/to-nowhere',
  ]);
});

test('text is capped at 8,000 characters and links at 30', async (t) => {
  const s = await server(t);
  const page = await acme(s).run({ url: 'https://www.acme.example/long-text' });
  assert.equal(page.ok, true);
  assert.equal(page.text.length, MAX_TEXT);
  assert.equal(page.links.length, MAX_LINKS);
  assert.equal(page.links[0], 'https://www.acme.example/p0');
});

test('a body past the byte cap is cut there and the connection dropped', async (t) => {
  const s = await server(t);
  const small = await acme(s, { maxBytes: 1000 }).run({ url: 'https://www.acme.example/marker-late' });
  assert.equal(small.ok, true);
  assert.doesNotMatch(small.text, /LATE-MARKER/);
  assert.equal(small.text, 'a'.repeat(1000 - '<p>'.length));

  const big = await acme(s).run({ url: 'https://www.acme.example/big' });
  assert.equal(big.ok, true);
  assert.doesNotMatch(big.text, /TAIL-MARKER/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(s.seen.bigClosedAt < 16 * MAX_BYTES, `the server sent ${s.seen.bigSent} bytes before the client hung up`);
});

test('a page that does not answer in time ends with a timeout, headers or body', async (t) => {
  const s = await server(t);
  const tool = acme(s, { timeoutMs: 300 });
  for (const path of ['/slow', '/slow-body']) {
    const started = Date.now();
    const page = await tool.run({ url: `https://www.acme.example${path}` });
    assert.equal(page.ok, false);
    assert.equal(page.error, 'timed out after 0.3 s');
    assert.ok(Date.now() - started < 2000);
  }
});

test('the caller can cancel', async (t) => {
  const s = await server(t);
  const page = await acme(s).run({ url: 'https://www.acme.example/slow' }, { signal: AbortSignal.timeout(100) });
  assert.equal(page.error, 'cancelled');
});

test('non-text pages, HTTP errors and script-only pages are not ok, with the reason', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  const pdf = await tool.run({ url: 'https://www.acme.example/pdf' });
  assert.deepEqual({ ok: pdf.ok, status: pdf.status, error: pdf.error, text: pdf.text }, { ok: false, status: 200, error: 'not a text page (application/pdf)', text: '' });
  const missing = await tool.run({ url: 'https://www.acme.example/missing' });
  assert.deepEqual({ ok: missing.ok, status: missing.status, error: missing.error, title: missing.title }, { ok: false, status: 404, error: 'HTTP 404', title: 'Not found' });
  const spa = await tool.run({ url: 'https://www.acme.example/spa' });
  assert.equal(spa.ok, false);
  assert.match(spa.error, /no readable text/);
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const down = await fetchPageTool({ allowDomain: '127.0.0.1' }).run({ url: `http://127.0.0.1:${port}/` });
  assert.equal(down.ok, false);
  assert.match(down.error, /^fetch failed: ECONNREFUSED/);
});

test('plain text is tidied and declared charsets are decoded', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  assert.equal((await tool.run({ url: 'https://www.acme.example/plain' })).text, 'line one\nline two');
  const latin = await tool.run({ url: 'https://www.acme.example/latin1' });
  assert.equal(latin.title, 'Café');
  assert.equal(latin.text, 'Café crème');
});

test('domainOf names the domain a company website lives on', () => {
  assert.equal(domainOf('https://www.apple.com/'), 'apple.com');
  assert.equal(domainOf('https://investor.apple.com/home'), 'apple.com');
  assert.equal(domainOf('https://www.acme.co.uk/'), 'acme.co.uk');
  assert.equal(domainOf('http://127.0.0.1:8080/'), '127.0.0.1');
});

// ANY_HOST mode: names resolve through a fake lookup, so a "public" name needs no network and a rebinding name is testable.
const fakeLookup = (asked) => async (host) => {
  asked.push(host);
  if (host === 'rebind.example') return [{ address: '127.0.0.1', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
};
const anyTool = (s, asked) => fetchPageTool({ allowDomain: ANY_HOST, fetch: s.fetchVia, lookup: fakeLookup(asked) });

test('ANY_HOST allows an arbitrary public host and keeps its links on that site', async (t) => {
  const s = await server(t);
  const asked = [];
  const tool = anyTool(s, asked);
  const page = await tool.run({ url: 'https://www.random-company.example/home' });
  assert.equal(page.ok, true);
  assert.equal(page.title, 'Acme & Sons — Valves');
  assert.deepEqual(page.links, ['https://www.random-company.example/menu', 'https://www.random-company.example/about']);
  assert.equal((await tool.run({ url: 'https://en.wikipedia.org/wiki/Acme' })).ok, true);
  assert.deepEqual(asked, ['www.random-company.example', 'en.wikipedia.org']);
  assert.match(tool.description, /Any public http\(s\) site is allowed except SEC\/EDGAR, SIC listing sites and web archives/);
  assert.notDeepEqual(tool.parameters, fetchPageTool({ allowDomain: 'acme.example' }).parameters);
});

test('ANY_HOST still refuses SEC, SIC sites, archives, EDGAR, bad schemes, credentials and private hosts, with no request', async (t) => {
  const s = await server(t);
  const asked = [];
  const tool = anyTool(s, asked);
  const refused = async (url, pattern) => {
    const page = await tool.run({ url });
    assert.equal(page.ok, false, url);
    assert.equal(page.status, 0, url);
    assert.match(page.refused, pattern, url);
  };
  await refused('https://www.sec.gov/cgi-bin/browse-edgar?company=acme', /refused list \(sec\.gov/);
  await refused('https://data.sec.gov/submissions/CIK0000320193.json', /refused list \(sec\.gov/);
  await refused('https://www.siccode.com/business/acme', /refused list \(siccode\.com/);
  await refused('https://web.archive.org/web/2026/https://www.sec.gov/', /refused list \(archive\.org/);
  await refused('https://edgar.random-company.example/', /EDGAR/);
  await refused('ftp://www.random-company.example/', /only http and https/);
  await refused('https://user:pw@www.random-company.example/', /credentials/);
  for (const url of ['http://127.0.0.1:9222/json', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/latest', 'http://198.18.0.1/', 'http://192.0.0.8/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[64:ff9b::a00:1]/']) {
    await refused(url, /is on this machine or its network/);
  }
  for (const url of ['http://localhost/', 'http://intranet/']) await refused(url, /single-label name/);
  for (const url of ['http://printer.local/', 'http://box.tailnet.ts.net/', 'http://metadata.google.internal/', 'http://nas.lan/']) await refused(url, /local network name/);
  assert.deepEqual(s.seen.requests, []);
  assert.deepEqual(asked, []);
});

test('ANY_HOST refuses a name that resolves to a private address, before any request', async (t) => {
  const s = await server(t);
  const asked = [];
  const page = await anyTool(s, asked).run({ url: 'https://rebind.example/home' });
  assert.equal(page.ok, false);
  assert.equal(page.refused, 'rebind.example resolves to 127.0.0.1, on this machine or its network');
  assert.deepEqual(asked, ['rebind.example']);
  assert.deepEqual(s.seen.requests, []);
});

test('ANY_HOST applies the same rules to the redirect hop', async (t) => {
  const s = await server(t);
  const asked = [];
  const tool = anyTool(s, asked);
  const other = await tool.run({ url: 'https://www.random-company.example/to-other' });
  assert.equal(other.url, 'https://acme-holdings.example/');
  assert.equal(other.refused, undefined);
  assert.match((await tool.run({ url: 'https://www.random-company.example/to-sec' })).refused, /^redirect to https:\/\/www\.sec\.gov\/.*refused list/);
  assert.match((await tool.run({ url: 'https://www.random-company.example/to-archive' })).refused, /^redirect to https:\/\/web\.archive\.org\/.*refused list \(archive\.org/);
  assert.match((await tool.run({ url: 'https://www.random-company.example/to-loopback' })).refused, /^redirect to http:\/\/127\.0\.0\.1:9222\/json: 127\.0\.0\.1 is on this machine or its network/);
  assert.match((await tool.run({ url: 'https://www.random-company.example/to-rebind' })).refused, /^redirect to https:\/\/rebind\.example\/home: rebind\.example resolves to 127\.0\.0\.1/);
  assert.deepEqual(s.seen.requests, [
    'www.random-company.example/to-other', 'acme-holdings.example/', 'www.random-company.example/to-sec', 'www.random-company.example/to-archive',
    'www.random-company.example/to-loopback', 'www.random-company.example/to-rebind',
  ]);
});

test('the domain-limited tool is unchanged by ANY_HOST', async (t) => {
  const s = await server(t);
  const tool = acme(s);
  assert.match((await tool.run({ url: 'https://www.random-company.example/home' })).refused, /outside the allowed hosts \(acme\.example and its subdomains/);
  assert.deepEqual(s.seen.requests, []);
});

test('one address policy: blockedAddress parses v4 and v6, including the ranges a prefix match misses', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '192.0.0.8', '198.18.0.1', '198.19.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b::192.168.0.1', '[::1]',
  ];
  const open = ['8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1', '192.0.2.1', '198.20.0.1', '2001:4860:4860::8888', '::ffff:93.184.216.34', '64:ff9b::5db8:d822'];
  for (const address of blocked) assert.equal(blockedAddress(address), true, address);
  for (const address of open) assert.equal(blockedAddress(address), false, address);
  assert.equal(blockedAddress('www.example.com'), false);
});

test('refusedHostOf and refusedUrl judge names and URLs; allowPrivate lifts only the local rules', () => {
  assert.equal(refusedHostOf('www.example.com'), null);
  assert.match(refusedHostOf('www.sec.gov'), /refused list/);
  assert.match(refusedHostOf('box.tailnet.ts.net'), /local network name/);
  assert.match(refusedHostOf('fileserver'), /single-label name/);
  assert.equal(refusedHostOf('127.0.0.1', { allowPrivate: true }), null);
  assert.match(refusedHostOf('www.sec.gov', { allowPrivate: true }), /refused list/);
  assert.match(refusedUrl('file:///etc/passwd'), /only http and https/);
  assert.match(refusedUrl('https://user:pw@example.com/'), /credentials/);
  assert.match(refusedUrl('not a url'), /is not a URL/);
  assert.equal(refusedUrl('https://www.example.com/about'), null);
});

test('urlPolicy resolves each name once and refuses a name that lands on this network', async () => {
  const asked = [];
  const policy = urlPolicy({ lookup: fakeLookup(asked) });
  assert.equal(await policy.check('https://www.example.com/'), null);
  assert.equal(await policy.check('https://www.example.com/other'), null);
  assert.equal(await policy.check('https://rebind.example/'), 'rebind.example resolves to 127.0.0.1, on this machine or its network');
  assert.equal(await policy.check('http://93.184.216.34/'), null);
  assert.deepEqual(asked, ['www.example.com', 'rebind.example']);
  const unresolved = urlPolicy({ lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.equal(await unresolved.check('https://nowhere.example/'), null);
});
