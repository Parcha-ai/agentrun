// fetch_page: how a learn-classify run reads the web. Text only (no script runs, no cookies), the company's own domain and
// Wikipedia only, and never SEC/EDGAR or a site that lists SIC codes, so the label comes from what the company says it does.
// With allowDomain ANY_HOST (truth set v2, where half the companies come without a website) any public host is allowed,
// the refused list still applies, and a host that is or resolves to a private address is refused.
import { lookup as dnsLookup } from 'node:dns/promises';

export const USER_AGENT = 'agentrun-learn-classify/1.0 (fetch_page; text only; +https://github.com/Parcha-ai/agentrun)';
export const TIMEOUT_MS = 10_000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT = 8_000;
export const MAX_LINKS = 30;

// Refused before any request, whatever allowDomain says: the SEC and EDGAR mirrors, sites that publish a company's SIC
// code or the SIC/NAICS manuals, and web archives (an archived SEC page holds the answer). A host matches an entry when
// it is that domain or a subdomain of it.
export const REFUSED_DOMAINS = Object.freeze([
  'sec.gov', 'sec.report', 'secdatabase.com', 'secinfo.com', 'last10k.com', 'edgar-online.com', 'bamsec.com', 'kscope.io',
  'siccode.com', 'sic-code.com', 'siccodes.org', 'naics.com', 'naicscode.com', 'naics.codes', 'osha.gov', 'census.gov',
  'dnb.com', 'zoominfo.com', 'opencorporates.com', 'bizapedia.com', 'manta.com', 'buzzfile.com', 'corporationwiki.com',
  'fintel.io', 'stockanalysis.com', 'companiesmarketcap.com', 'macroaxis.com', 'whalewisdom.com', 'annualreports.com',
  'craft.co', 'cbinsights.com', 'owler.com', 'datanyze.com',
  'archive.org', 'archive.ph', 'archive.is', 'archive.today', 'webcache.googleusercontent.com',
]);
// Any host with a label naming EDGAR is refused too (edgar.example.com, edgar-filings.net).
const EDGAR_LABEL = /(^|[.-])edgar([.-]|$)/;
const WIKIPEDIA = 'wikipedia.org';

const TWO_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'net.au', 'co.jp', 'com.br', 'co.in', 'com.cn', 'com.hk', 'co.nz', 'co.za', 'com.mx', 'com.sg', 'co.il', 'com.tw']);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export const ANY_HOST = 'any';
// Loopback, private, link-local, carrier-grade NAT (tailnets), multicast and reserved IPv4; loopback, unique-local,
// link-local and mapped IPv6.
const PRIVATE_V4 = /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])|22[4-9]|2[3-5]\d)\./;
const PRIVATE_V6 = /^(::1?$|f[cd]|fe[89ab]|::ffff:)/;
const LOCAL_NAME = /(^|\.)(localhost|local|internal|home\.arpa)$/;

const normalHost = (host) => host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
const within = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// The domain a company's website lives on, for `allowDomain`: its host without subdomains (www.apple.com and
// investor.apple.com both give apple.com). An IP literal stays itself.
export function domainOf(website) {
  const host = normalHost(new URL(website).hostname);
  if (IPV4.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  const keep = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export function refusedHost(host) {
  const h = normalHost(host);
  if (EDGAR_LABEL.test(h)) return `${h} is EDGAR, which is never fetched`;
  const listed = REFUSED_DOMAINS.find((domain) => within(h, domain));
  return listed ? `${h} is on the refused list (${listed}: SEC filings, SIC listings or web archives)` : null;
}

export function publicAddress(address) {
  const a = normalHost(address);
  return IPV4.test(a) ? !PRIVATE_V4.test(a) : a.includes(':') ? !PRIVATE_V6.test(a) : true;
}

// A host name or address that could be public: no single-label or local names, no private address literal.
export function publicHost(host) {
  const h = normalHost(host);
  if (IPV4.test(h) || h.includes(':')) return publicAddress(h);
  return h.includes('.') && !LOCAL_NAME.test(h);
}

export function allowedHost(host, allowDomain) {
  const h = normalHost(host);
  if (refusedHost(h)) return false;
  if (allowDomain === ANY_HOST) return publicHost(h);
  return within(h, WIKIPEDIA) || (IPV4.test(allowDomain) || allowDomain.includes(':') ? h === allowDomain : within(h, allowDomain));
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'url', 'status', 'title', 'text', 'links'],
  properties: {
    ok: { type: 'boolean', description: 'true when the page answered 2xx with readable text' },
    url: { type: 'string', description: 'the URL the text came from, after the redirect if one was followed' },
    status: { type: 'integer', description: 'HTTP status; 0 when no response came back' },
    title: { type: 'string' },
    text: { type: 'string', maxLength: MAX_TEXT, description: 'readable text of the page (meta description first)' },
    links: { type: 'array', maxItems: MAX_LINKS, items: { type: 'string' }, description: 'same-site links on the page' },
    refused: { type: 'string', description: 'why the URL was not fetched (host outside the allowed set, a refused site, a second redirect)' },
    error: { type: 'string', description: 'why ok is false when nothing was refused (timeout, network error, HTTP error, not a text page, no readable text)' },
  },
};

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: { url: { type: 'string', description: 'an http(s) URL on the company\'s own domain or on wikipedia.org' } },
};

const ANY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: { url: { type: 'string', description: 'an http(s) URL on any public site except SEC/EDGAR, SIC listing sites and web archives' } },
};

const emptyPage = (url, status = 0) => ({ ok: false, url, status, title: '', text: '', links: [] });

// `lookup` resolves a host name to its addresses, only in ANY_HOST mode; tests pass their own.
export function fetchPageTool({ allowDomain, fetch: fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, lookup = dnsLookup }) {
  const any = allowDomain === ANY_HOST;
  const domain = any ? ANY_HOST : normalHost(String(allowDomain ?? ''));
  if (!any && (!domain || (!domain.includes('.') && !domain.includes(':')))) throw new TypeError(`allowDomain must be a domain such as example.com, not ${JSON.stringify(allowDomain)}`);
  if (!any && refusedHost(domain)) throw new TypeError(`allowDomain ${domain} is a refused site`);

  const check = (raw, base) => {
    let url;
    try {
      url = new URL(raw, base);
    } catch {
      return { refused: `${JSON.stringify(raw)} is not a URL` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { url, refused: `only http and https URLs are fetched, not ${url.protocol}` };
    if (url.username || url.password) return { url, refused: 'URLs with credentials are not fetched' };
    const host = normalHost(url.hostname);
    const refused = refusedHost(host);
    if (refused) return { url, refused };
    if (!allowedHost(host, domain)) return { url, refused: any ? `${host} is not a public host` : `${host} is outside the allowed hosts (${domain} and its subdomains, *.wikipedia.org)` };
    url.hash = '';
    return { url };
  };

  // In ANY_HOST mode a name must not resolve to a private address. The check runs before each request; a name whose
  // answer changes between this lookup and the connection is not caught.
  const resolvesPublic = async (url) => {
    if (!any) return null;
    const host = normalHost(url.hostname);
    if (IPV4.test(host) || host.includes(':')) return null;
    const addresses = await lookup(host, { all: true });
    const inside = addresses.find((a) => !publicAddress(a.address));
    return inside ? `${host} resolves to a private address (${inside.address})` : null;
  };

  async function run(args, { signal } = {}) {
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    const first = check(raw);
    if (first.refused) return { ...emptyPage(first.url?.href ?? raw), refused: first.refused };
    const deadline = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const get = (url) => fetchImpl(url.href, {
      redirect: 'manual',
      signal: abort,
      credentials: 'omit',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'accept-language': 'en-US,en;q=0.8' },
    });
    let url = first.url;
    try {
      const firstPrivate = await resolvesPublic(url);
      if (firstPrivate) return { ...emptyPage(url.href), refused: firstPrivate };
      let res = await get(url);
      if (isRedirect(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) return { ...emptyPage(url.href, res.status), error: 'a redirect without a Location header' };
        const next = check(location, url);
        if (next.refused) return { ...emptyPage(url.href, res.status), refused: `redirect to ${next.url?.href ?? location}: ${next.refused}` };
        const nextPrivate = await resolvesPublic(next.url);
        if (nextPrivate) return { ...emptyPage(url.href, res.status), refused: `redirect to ${next.url.href}: ${nextPrivate}` };
        url = next.url;
        res = await get(url);
        if (isRedirect(res.status)) {
          const again = res.headers.get('location');
          await res.body?.cancel();
          return { ...emptyPage(url.href, res.status), refused: `a second redirect${again ? ` (to ${new URL(again, url).href})` : ''}; one hop is followed, so fetch that URL directly if it is allowed` };
        }
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      const kind = /html|xml/.test(type) ? 'html' : type.startsWith('text/') || !type ? 'text' : null;
      if (!kind) {
        await res.body?.cancel();
        return { ...emptyPage(url.href, res.status), error: `not a text page (${type.split(';')[0]})` };
      }
      const bytes = await readCapped(res, maxBytes);
      const body = decode(bytes, type);
      const page = kind === 'html' ? readHtml(body, url, any ? domainOf(url.href) : domain) : { title: '', text: tidy(body), links: [] };
      const text = page.text.slice(0, MAX_TEXT);
      const result = { ok: res.ok && text.length > 0, url: url.href, status: res.status, title: page.title, text, links: page.links };
      if (!res.ok) result.error = `HTTP ${res.status}`;
      else if (!text) result.error = 'the page has no readable text (it may need JavaScript)';
      return result;
    } catch (error) {
      const why = deadline.aborted ? `timed out after ${timeoutMs / 1000} s` : signal?.aborted ? 'cancelled' : `fetch failed: ${error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error}`;
      return { ...emptyPage(url.href), error: why };
    }
  }

  return {
    name: 'fetch_page',
    label: 'Fetch page',
    description: any
      ? `Fetch one web page as text: its title, readable text (at most ${MAX_TEXT} characters) and up to ${MAX_LINKS} same-site links. Any public http(s) site is allowed except SEC/EDGAR, SIC listing sites and web archives, which are always refused. No JavaScript runs, so a page that builds itself in the browser may come back empty.`
      : `Fetch one web page as text: its title, readable text (at most ${MAX_TEXT} characters) and up to ${MAX_LINKS} same-site links. Only ${domain} (and its subdomains) and *.wikipedia.org are allowed; SEC/EDGAR and SIC listing sites are always refused. No JavaScript runs, so a page that builds itself in the browser may come back empty.`,
    parameters: any ? ANY_PARAMETERS : PARAMETERS,
    resultSchema: RESULT_SCHEMA,
    run,
  };
}

const isRedirect = (status) => status >= 300 && status < 400 && status !== 304;

// Reads at most `max` bytes and stops there: a longer page is cut, not refused.
async function readCapped(res, max) {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, max - size);
    chunks.push(take);
    size += take.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function decode(bytes, type) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const label = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', laquo: '«', raquo: '»', deg: '°', eacute: 'é', egrave: 'è',
  aacute: 'á', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', times: '×', shy: '',
};
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  }
  return ENTITIES[name.toLowerCase()] ?? whole;
});

const tidy = (s) => {
  const lines = [];
  for (const line of s.split('\n')) {
    const clean = line.replace(/[\s ]+/g, ' ').trim();
    if (clean && clean !== lines.at(-1)) lines.push(clean);
  }
  return lines.join('\n');
};

const DROP = /<(script|style|noscript|template|svg|iframe|object|canvas|head|title)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|nav|main|aside|dd|dt|dl|blockquote|pre|form|figure|figcaption|hr|option)\b[^>]*>/gi;
const SKIP_LINK = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|mp4|mp3|mov|xlsx?|docx?|pptx?|css|js|json|xml)$/i;

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function readHtml(html, url, domain) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  const title = tidy(decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? '')).replace(/\n/g, ' ');
  let description = '';
  for (const tag of source.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    if (name === 'description' || name === 'og:description') {
      description = tidy(attr(tag, 'content') ?? '').replace(/\n/g, ' ');
      if (description) break;
    }
  }
  const stripped = source.replace(DROP, ' ');
  // The page's own content when it marks it: Wikipedia and most sites wrap it in <main>, leaving menus outside.
  const region = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(stripped)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(stripped)?.[1] ?? stripped;
  const body = tidy(decodeEntities(region.replace(BLOCK, '\n').replace(/<[^>]*>/g, ' ')));
  const text = description && !body.startsWith(description) ? `${description}\n\n${body}` : body;
  return { title, text, links: sameSiteLinks(stripped, url, domain) };
}

// Same site: on a Wikipedia page, articles on that same wiki; anywhere else, pages of the company's domain.
function sameSiteLinks(html, page, domain) {
  const host = normalHost(page.hostname);
  const onWiki = within(host, WIKIPEDIA);
  const seen = new Set([page.href]);
  const links = [];
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    if (links.length >= MAX_LINKS) break;
    const href = attr(tag, 'href');
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, page);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const h = normalHost(url.hostname);
    const same = onWiki ? h === host && /^\/wiki\/[^:]+$/.test(url.pathname) : !within(h, WIKIPEDIA) && allowedHost(h, domain);
    if (!same || SKIP_LINK.test(url.pathname) || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push(url.href);
  }
  return links;
}
