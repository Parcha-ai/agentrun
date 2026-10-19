#!/usr/bin/env node
// Rebuilds data/companies.json, data/sic2.json and data/build-report.json from public data, with no credentials and no
// model calls:
//   - SIC codes: the SEC's Financial Statement Data Set (sub.txt holds each filer's SIC as of the filing), company names
//     and tickers from the SEC's company_tickers.json, descriptions from the SEC's SIC code list;
//   - websites: Wikidata's official website (P856) for the item carrying the CIK (P5531), with an English Wikipedia article;
//   - every chosen website is fetched once with fetch_page under the same rules a run has.
// --via=wayback reads the same SEC files from pinned Internet Archive copies (for networks sec.gov refuses).
//
//   node examples/learn-classify/build-truth.mjs [--via=sec|wayback] [--cache=DIR] [--recheck]
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { domainOf, fetchPageTool, refusedHost } from './tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = join(HERE, 'data');
const SEC_UA = 'agentrun learn-classify demo (claudio-michel[bot]@users.noreply.github.com)';
export const OPEN_UA = 'agentrun learn-classify demo (+https://github.com/Parcha-ai/agentrun)';

const TOTAL = 130;
const RUN = 100;
const SEALED = TOTAL - RUN;
export const GROUP_CAP = 10;
export const MIN_RUN_GROUPS = 25;
const GROUP_WEIGHT = 0.75;
export const MIN_TEXT = 400;
const CHECK_CONCURRENCY = 8;

const SEC_FILES = {
  tickers: { url: 'https://www.sec.gov/files/company_tickers.json', wayback: '20261018055724' },
  fsds: { url: 'https://www.sec.gov/files/dera/data/financial-statement-data-sets/2026q1.zip', wayback: '20261005001837' },
  sicList: { url: 'https://www.sec.gov/search-filings/standard-industrial-classification-sic-code-list', wayback: '20261001145830' },
};
const WIKIDATA = 'https://query.wikidata.org/sparql';
const SPARQL = `SELECT ?item ?cik ?website ?article WHERE {
  ?item wdt:P5531 ?cik ; wdt:P856 ?website .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
}`;

// Not operating businesses a website could describe: blank checks, asset-backed and commodity trusts, unit investment
// trusts, royalty traders, ADRs, foreign governments, non-operating establishments.
export const EXCLUDED_SIC = new Set(['6189', '6221', '6726', '6770', '6792', '6795', '8880', '8888', '9995', '9999']);
const US = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const PERIODIC = new Set(['10-K', '10-K/A', '10-KT', '10-Q', '10-Q/A']);

// SEC filing conventions a reader of the website would not guess, reviewed by hand on the built set. The report keeps them
// so a later check can ask whether the learned notes picked them up.
const CONVENTIONS = [
  { ciks: ['0000106535', '0000752642', '0000906345', '0000910612', '0001040971'], convention: 'A REIT files under 6798, group 67 (Holding And Other Investment Offices), not 65 (Real Estate), whatever it owns: timberland, homes, apartments, malls, offices.' },
  { ciks: ['0001405495'], convention: 'A company that earns from licensing its patents files under 6794 (Patent Owners & Lessors), group 67.' },
  { ciks: ['0001839341'], convention: 'Core Scientific, a data-center and bitcoin-mining company, files under 6199 (Finance Services), group 61.' },
  { ciks: ['0001327567'], convention: 'Palo Alto Networks, a security-software company by its site, files under 3577 (Computer Peripheral Equipment), group 35.' },
  { ciks: ['0001836833'], convention: 'Planet Labs, satellite imagery and data by its site, files under 3663 (Communications Equipment), group 36.' },
  { ciks: ['0000773840'], convention: 'Honeywell, a diversified industrial by its site, files under 3724 (Aircraft Engines & Engine Parts), group 37.' },
  { ciks: ['0001018724', '0001616707', '0001576942'], convention: 'An online retailer files under 5961 (Retail-Catalog & Mail-Order Houses), group 59, not under the goods it sells.' },
  { ciks: ['0001029199'], convention: 'Euronet, payments processing, files under 6099 (Functions Related To Depository Banking), group 60.' },
  { ciks: ['0001326801'], convention: 'Meta files under 7370 (Computer Programming, Data Processing), group 73, though meta.com sells glasses and headsets.' },
];

// Major group names of the 1987 SIC Manual (the SEC's code list names only some of its groups). sic2.json is all of them,
// so the label set does not reveal which groups the companies fall in.
export const MAJOR_GROUPS = {
  '01': 'Agricultural Production Crops', '02': 'Agriculture Production Livestock And Animal Specialties', '07': 'Agricultural Services',
  '08': 'Forestry', '09': 'Fishing, Hunting, And Trapping', '10': 'Metal Mining', '12': 'Coal Mining', '13': 'Oil And Gas Extraction',
  '14': 'Mining And Quarrying Of Nonmetallic Minerals, Except Fuels', '15': 'Building Construction General Contractors And Operative Builders',
  '16': 'Heavy Construction Other Than Building Construction Contractors', '17': 'Construction Special Trade Contractors',
  '20': 'Food And Kindred Products', '21': 'Tobacco Products', '22': 'Textile Mill Products',
  '23': 'Apparel And Other Finished Products Made From Fabrics And Similar Materials', '24': 'Lumber And Wood Products, Except Furniture',
  '25': 'Furniture And Fixtures', '26': 'Paper And Allied Products', '27': 'Printing, Publishing, And Allied Industries',
  '28': 'Chemicals And Allied Products', '29': 'Petroleum Refining And Related Industries', '30': 'Rubber And Miscellaneous Plastics Products',
  '31': 'Leather And Leather Products', '32': 'Stone, Clay, Glass, And Concrete Products', '33': 'Primary Metal Industries',
  '34': 'Fabricated Metal Products, Except Machinery And Transportation Equipment', '35': 'Industrial And Commercial Machinery And Computer Equipment',
  '36': 'Electronic And Other Electrical Equipment And Components, Except Computer Equipment', '37': 'Transportation Equipment',
  '38': 'Measuring, Analyzing, And Controlling Instruments; Photographic, Medical And Optical Goods; Watches And Clocks',
  '39': 'Miscellaneous Manufacturing Industries', '40': 'Railroad Transportation',
  '41': 'Local And Suburban Transit And Interurban Highway Passenger Transportation', '42': 'Motor Freight Transportation And Warehousing',
  '43': 'United States Postal Service', '44': 'Water Transportation', '45': 'Transportation By Air', '46': 'Pipelines, Except Natural Gas',
  '47': 'Transportation Services', '48': 'Communications', '49': 'Electric, Gas, And Sanitary Services', '50': 'Wholesale Trade-durable Goods',
  '51': 'Wholesale Trade-non-durable Goods', '52': 'Building Materials, Hardware, Garden Supply, And Mobile Home Dealers',
  '53': 'General Merchandise Stores', '54': 'Food Stores', '55': 'Automotive Dealers And Gasoline Service Stations', '56': 'Apparel And Accessory Stores',
  '57': 'Home Furniture, Furnishings, And Equipment Stores', '58': 'Eating And Drinking Places', '59': 'Miscellaneous Retail',
  '60': 'Depository Institutions', '61': 'Non-depository Credit Institutions', '62': 'Security And Commodity Brokers, Dealers, Exchanges, And Services',
  '63': 'Insurance Carriers', '64': 'Insurance Agents, Brokers, And Service', '65': 'Real Estate', '67': 'Holding And Other Investment Offices',
  '70': 'Hotels, Rooming Houses, Camps, And Other Lodging Places', '72': 'Personal Services', '73': 'Business Services',
  '75': 'Automotive Repair, Services, And Parking', '76': 'Miscellaneous Repair Services', '78': 'Motion Pictures', '79': 'Amusement And Recreation Services',
  '80': 'Health Services', '81': 'Legal Services', '82': 'Educational Services', '83': 'Social Services',
  '84': 'Museums, Art Galleries, And Botanical And Zoological Gardens', '86': 'Membership Organizations',
  '87': 'Engineering, Accounting, Research, Management, And Related Services', '88': 'Private Households', '89': 'Miscellaneous Services',
  '91': 'Executive, Legislative, And General Government, Except Finance', '92': 'Justice, Public Order, And Safety',
  '93': 'Public Finance, Taxation, And Monetary Policy', '94': 'Administration Of Human Resource Programs',
  '95': 'Administration Of Environmental Quality And Housing Programs', '96': 'Administration Of Economic Programs',
  '97': 'National Security And International Affairs', '99': 'Nonclassifiable Establishments',
};

export const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
export const via = args.via ?? 'sec';
if (via !== 'sec' && via !== 'wayback') throw new Error(`--via is sec or wayback, not ${via}`);
export const cache = args.cache ?? join(tmpdir(), 'learn-classify-cache');

export const rank = (salt, cik) => createHash('sha256').update(`learn-classify:${salt}:${cik}`).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ungzip = (buf) => (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf);

// Where each input came from and when it was read, for the build report.
export const provenance = { secFiles: {}, wikidata: null };
const snapshotTime = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`;
const cachedAt = async (file) => (await stat(file)).mtime.toISOString();

// The SEC asks for fewer than 10 requests per second; this stays under 4.
let lastSec = 0;
export async function secFile(name) {
  const file = join(cache, `${via}-${name}`);
  const { url, wayback } = SEC_FILES[name];
  const from = via === 'wayback' ? `https://web.archive.org/web/${wayback}id_/${url}` : url;
  const record = async () => {
    provenance.secFiles[name] = { url, fetchedFrom: from, ...(via === 'wayback' ? { snapshot: snapshotTime(wayback) } : {}), retrievedAt: await cachedAt(file) };
  };
  try {
    const body = await readFile(file);
    await record();
    return body;
  } catch {}
  if (via === 'sec') await sleep(Math.max(0, lastSec + 300 - Date.now()));
  lastSec = Date.now();
  const res = await fetch(from, { headers: { 'user-agent': via === 'sec' ? SEC_UA : OPEN_UA, 'accept-encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`${from} answered ${res.status}${res.status === 403 && via === 'sec' ? '; sec.gov may refuse this network, try --via=wayback' : ''}`);
  const body = ungzip(Buffer.from(await res.arrayBuffer()));
  await writeFile(file, body);
  await record();
  return body;
}

export async function wikidata({ query = SPARQL, name = 'wikidata' } = {}) {
  const file = join(cache, `${name}.json`);
  const record = async () => {
    provenance[name] = { endpoint: WIKIDATA, query, retrievedAt: await cachedAt(file) };
  };
  try {
    const json = JSON.parse(await readFile(file, 'utf8'));
    await record();
    return json;
  } catch {}
  const res = await fetch(`${WIKIDATA}?query=${encodeURIComponent(query)}`, { headers: { 'user-agent': OPEN_UA, accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  const json = await res.json();
  await writeFile(file, JSON.stringify(json));
  await record();
  return json;
}

// An entry's stored bytes and compression method (0 stored, 8 deflate).
export function zipEntry(zip, name) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    const nameLength = zip.readUInt16LE(at + 28);
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      return { data: zip.subarray(start, start + zip.readUInt32LE(at + 20)), method: zip.readUInt16LE(at + 10) };
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  throw new Error(`${name} is not in the zip`);
}

export function unzipEntry(zip, name) {
  const { data, method } = zipEntry(zip, name);
  return method === 0 ? data : inflateRawSync(data);
}

export function readTsv(text) {
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const keys = head.split('\t');
  return lines.map((line) => Object.fromEntries(line.split('\t').map((value, i) => [keys[i], value])));
}

export function readSicList(html) {
  const codes = {};
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  for (const m of html.matchAll(/<tr><td>(\d{3,4})<\/td><td>[^<]*<\/td><td>([^<]*)<\/td><\/tr>/g)) codes[m[1].padStart(4, '0')] = decode(m[2]);
  if (Object.keys(codes).length < 300) throw new Error(`the SEC SIC list parsed to ${Object.keys(codes).length} codes; its page layout changed`);
  return codes;
}

// Words that name no company on their own: legal forms, and industry words many filers share.
const LEGAL = new Set(['inc', 'corp', 'corporation', 'co', 'com', 'company', 'companies', 'holdings', 'holding', 'group', 'ltd', 'limited', 'plc', 'llc', 'lp', 'nv', 'sa', 'ag', 'de', 'incorporated', 'trust', 'international', 'intl']);
const GENERIC = new Set(['the', 'of', 'and', 'american', 'america', 'national', 'united', 'first', 'global', 'insurance', 'bank', 'bancorp', 'bancshares', 'financial', 'energy', 'technologies', 'technology', 'systems', 'services', 'solutions', 'industries', 'products', 'resources', 'capital', 'health', 'therapeutics', 'pharmaceuticals', 'partners', 'properties', 'brands']);

// Wikidata's website must belong to this filer: its domain holds the filer's name, a distinctive word of it, its initials or
// its ticker. This drops stale sites (a former name) and a product's site filed under its parent's CIK.
export function siteNamesCompany(website, { name, ticker }) {
  const label = domainOf(website).split('.')[0].replace(/[^a-z0-9]/g, '');
  const words = name.toLowerCase().replace(/\/[a-z]{2}\/?$/, '').split(/[^a-z0-9]+/).filter((w) => w && !LEGAL.has(w));
  const initials = words.filter((w) => !['the', 'of', 'and'].includes(w)).map((w) => w[0]).join('');
  const symbol = ticker.toLowerCase().replace(/[^a-z0-9]/g, '');
  return label.includes(words.join(''))
    || words.some((w) => w.length >= 3 && !GENERIC.has(w) && label.includes(w))
    || (initials.length >= 2 && label === initials)
    || (symbol.length >= 2 && label.startsWith(symbol));
}

// One website per company: a site root (or a bare locale path) that names the filer, https first, then the shortest.
export function pickWebsite(urls, company) {
  const roots = [...urls].map((raw) => {
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  }).filter((url) => url && /^https?:$/.test(url.protocol) && /^\/([a-z]{2}(-[a-z]{2})?\/?)?$/i.test(url.pathname) && !url.search && siteNamesCompany(url.href, company));
  const bare = (url) => url.href.replace(/\/$/, '');
  roots.sort((a, b) => (b.protocol === 'https:') - (a.protocol === 'https:') || bare(a).length - bare(b).length || a.href.localeCompare(b.href));
  return roots[0]?.href ?? null;
}

async function pool() {
  const tickers = new Map();
  for (const row of Object.values(JSON.parse((await secFile('tickers')).toString('utf8')))) {
    if (!tickers.has(row.cik_str)) tickers.set(row.cik_str, row);
  }
  const filings = new Map();
  const sub = readTsv(unzipEntry(await secFile('fsds'), 'sub.txt').toString('utf8')).sort((a, b) => a.filed.localeCompare(b.filed));
  for (const row of sub) if (PERIODIC.has(row.form)) filings.set(Number(row.cik), row);
  const sicList = readSicList((await secFile('sicList')).toString('utf8'));
  const sites = new Map();
  for (const b of (await wikidata()).results.bindings) {
    if (!/^\d+$/.test(b.cik.value)) continue;
    const cik = Number(b.cik.value);
    const entry = sites.get(cik) ?? { websites: new Set(), items: new Set(), wikipedia: b.article.value };
    entry.websites.add(b.website.value);
    entry.items.add(b.item.value);
    sites.set(cik, entry);
  }
  // A CIK on two Wikidata items (a predecessor, a namesake) has no single website to trust.
  for (const [cik, entry] of sites) if (entry.items.size > 1) sites.delete(cik);
  const candidates = [];
  for (const [cik, ticker] of tickers) {
    const filing = filings.get(cik);
    const site = sites.get(cik);
    if (!filing || !site || filing.countryba !== 'US' || !US.has(filing.stprba)) continue;
    if (!filing.sic) continue;
    const sic = filing.sic.padStart(4, '0');
    if (EXCLUDED_SIC.has(sic) || !sicList[sic] || !MAJOR_GROUPS[sic.slice(0, 2)]) continue;
    const website = pickWebsite(site.websites, { name: ticker.title, ticker: ticker.ticker });
    if (!website || refusedHost(new URL(website).hostname)) continue;
    candidates.push({
      cik: String(cik).padStart(10, '0'), name: ticker.title, ticker: ticker.ticker, website, sic, sic2: sic.slice(0, 2),
      sicDescription: sicList[sic], wikipedia: site.wikipedia, domain: domainOf(website), filed: filing.filed,
    });
  }
  // A domain two filers share (a parent and its subsidiary) describes neither on its own.
  const byDomain = new Map();
  for (const c of candidates) byDomain.set(c.domain, (byDomain.get(c.domain) ?? 0) + 1);
  return { candidates: candidates.filter((c) => byDomain.get(c.domain) === 1), sources: { sec: sub.length, tickers: tickers.size, wikidata: sites.size, sicCodes: Object.keys(sicList).length } };
}

export async function check(company, checks) {
  if (checks[company.cik]?.website === company.website) return checks[company.cik];
  const tool = fetchPageTool({ allowDomain: company.domain });
  const started = Date.now();
  const page = await tool.run({ url: company.website });
  const result = {
    cik: company.cik, website: company.website, checkedAt: new Date(started).toISOString(), ms: Date.now() - started,
    pageOk: page.ok, status: page.status, url: page.url, title: page.title, textChars: page.text.length, links: page.links.length,
    ...(page.refused ? { refused: page.refused } : {}),
    ...(page.error ? { error: page.error } : {}),
    // The run must find the label from what the company does; a page naming SIC codes is flagged for review.
    mentionsSic: /\bSIC\b|Standard Industrial Classification/.test(page.text),
  };
  checks[company.cik] = result;
  return result;
}

// A bot wall answers 200 with a challenge page that says nothing about the company.
export const CHALLENGE = /^(client challenge|just a moment|attention required|access denied|security check|pardon our interruption|are you a robot)/i;
export function usable(check) {
  if (!check.pageOk) return { ok: false, why: check.refused ?? check.error };
  if (CHALLENGE.test(check.title)) return { ok: false, why: `a bot challenge page (${check.title})` };
  if (check.textChars < MIN_TEXT) return { ok: false, why: `only ${check.textChars} characters of text` };
  return { ok: true };
}

export async function checkAll(companies, checks) {
  const queue = companies.filter((c) => checks[c.cik]?.website !== c.website);
  const workers = Array.from({ length: CHECK_CONCURRENCY }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const r = await check(c, checks);
      const { ok, why } = usable(r);
      console.error(`${ok ? 'ok  ' : 'drop'} ${c.cik} ${c.website} ${r.status} ${r.textChars}${why ? ` (${why})` : ''}`);
    }
  });
  await Promise.all(workers);
}

// Highest-quotient seats (D'Hondt) over groups weighted by pool size^GROUP_WEIGHT, at most GROUP_CAP a group, taking each
// group's companies in a fixed hash order and skipping any whose website check failed.
function allocate(byGroup, failed) {
  const taken = new Map();
  const next = new Map();
  const weight = new Map([...byGroup].map(([g, list]) => [g, list.length ** GROUP_WEIGHT]));
  const chosen = [];
  const advance = (g) => {
    const list = byGroup.get(g);
    let i = next.get(g) ?? 0;
    while (i < list.length && failed.has(list[i].cik)) i++;
    next.set(g, i);
    return list[i];
  };
  while (chosen.length < TOTAL) {
    let best = null;
    for (const g of [...byGroup.keys()].sort()) {
      if ((taken.get(g) ?? 0) >= GROUP_CAP || !advance(g)) continue;
      const q = weight.get(g) / ((taken.get(g) ?? 0) + 1);
      if (!best || q > best.q) best = { g, q };
    }
    if (!best) throw new Error(`only ${chosen.length} companies passed; the pool is too small`);
    chosen.push(advance(best.g));
    taken.set(best.g, (taken.get(best.g) ?? 0) + 1);
    next.set(best.g, next.get(best.g) + 1);
  }
  return chosen;
}

// 30 sealed, spread like the whole set, and never a group's last company in the run split.
function split(chosen) {
  const byGroup = Map.groupBy(chosen, (c) => c.sic2);
  const sealedCount = new Map();
  for (let seat = 0; seat < SEALED; seat++) {
    let best = null;
    for (const [g, list] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
      const have = sealedCount.get(g) ?? 0;
      if (have >= list.length - 1) continue;
      const q = list.length / (have + 1);
      if (!best || q > best.q) best = { g, q };
    }
    sealedCount.set(best.g, (sealedCount.get(best.g) ?? 0) + 1);
  }
  const sealed = new Set();
  for (const [g, list] of byGroup) {
    const order = [...list].sort((a, b) => rank('sealed', a.cik).localeCompare(rank('sealed', b.cik)));
    for (const c of order.slice(0, sealedCount.get(g) ?? 0)) sealed.add(c.cik);
  }
  // Run order: a fixed shuffle, then no two neighbours from the same group.
  const run = chosen.filter((c) => !sealed.has(c.cik)).sort((a, b) => rank('order', a.cik).localeCompare(rank('order', b.cik)));
  const g = (k) => run[k]?.sic2;
  for (let i = 1; i < run.length; i++) {
    if (g(i) !== g(i - 1)) continue;
    const j = run.findIndex((_, k) => k > i + 1 && g(k) !== g(i - 1) && g(k) !== g(i + 1) && g(k - 1) !== g(i) && g(k + 1) !== g(i));
    if (j > 0) [run[i], run[j]] = [run[j], run[i]];
  }
  return { run, sealed: chosen.filter((c) => sealed.has(c.cik)) };
}

const row = (c, split, order) => ({
  cik: c.cik, name: c.name, ticker: c.ticker, website: c.website, sic: c.sic, sic2: c.sic2, sicDescription: c.sicDescription, split, order,
});

async function main() {
  await mkdir(cache, { recursive: true });
  const checksFile = join(cache, 'checks.json');
  let checks = {};
  if (args.recheck !== 'true') {
    try {
      checks = JSON.parse(await readFile(checksFile, 'utf8'));
    } catch {}
  }
  const { candidates, sources } = await pool();
  const byGroup = new Map();
  for (const c of [...candidates].sort((a, b) => rank('pick', a.cik).localeCompare(rank('pick', b.cik)))) {
    byGroup.set(c.sic2, [...(byGroup.get(c.sic2) ?? []), c]);
  }
  const failed = new Set();
  let chosen;
  for (;;) {
    chosen = allocate(byGroup, failed);
    await checkAll(chosen, checks);
    await writeFile(checksFile, JSON.stringify(checks, null, 1));
    const bad = chosen.filter((c) => !usable(checks[c.cik]).ok);
    if (bad.length === 0) break;
    for (const c of bad) failed.add(c.cik);
  }
  const { run, sealed } = split(chosen);
  const companies = [...run.map((c, i) => row(c, 'run', i + 1)), ...sealed.sort((a, b) => a.cik.localeCompare(b.cik)).map((c) => row(c, 'sealed', null))];

  const groups = (list) => new Map([...Map.groupBy(list, (c) => c.sic2)].map(([g, l]) => [g, l.length]));
  const all = groups(companies);
  const runGroups = groups(run);
  if (companies.length !== TOTAL || run.length !== RUN) throw new Error(`built ${companies.length} companies, ${run.length} run`);
  if (runGroups.size < MIN_RUN_GROUPS) throw new Error(`only ${runGroups.size} groups in the run split`);
  if (Math.max(...all.values()) > GROUP_CAP) throw new Error('a group holds more than the cap');
  for (const c of sealed) if (!runGroups.has(c.sic2)) throw new Error(`sealed ${c.cik} has a group the run never sees`);

  // Written by hand: JSON.stringify puts integer-like keys ("10") before the rest ("01").
  const sic2 = `{\n${Object.entries(MAJOR_GROUPS).sort(([a], [b]) => a.localeCompare(b)).map(([g, name]) => `  ${JSON.stringify(g)}: ${JSON.stringify(name)}`).join(',\n')}\n}\n`;
  const conventions = CONVENTIONS.map(({ ciks, convention }) => ({
    convention,
    companies: ciks.map((cik) => companies.find((c) => c.cik === cik)).filter(Boolean).map((c) => ({ cik: c.cik, name: c.name, sic: c.sic, sic2: c.sic2, split: c.split, order: c.order })),
  })).filter((entry) => entry.companies.length > 0);
  const byCik = new Map(candidates.map((c) => [c.cik, c]));
  const checked = Object.values(checks).filter((r) => byCik.has(r.cik) && r.website === byCik.get(r.cik).website).sort((a, b) => a.cik.localeCompare(b.cik));
  const report = {
    builtWith: { via, ...provenance },
    rules: { total: TOTAL, run: RUN, sealed: SEALED, groupCap: GROUP_CAP, groupWeight: GROUP_WEIGHT, minText: MIN_TEXT, excludedSic: [...EXCLUDED_SIC] },
    sources,
    counts: {
      pool: candidates.length, poolGroups: byGroup.size, checked: checked.length, passed: checked.filter((r) => usable(r).ok).length,
      dropped: checked.filter((r) => !usable(r).ok).length, groups: all.size, runGroups: runGroups.size,
      byGroup: Object.fromEntries([...all].sort(([a], [b]) => a.localeCompare(b)).map(([g, n]) => [g, { total: n, run: runGroups.get(g) ?? 0 }])),
    },
    conventions,
    checks: checked.map((r) => {
      const { ok, why } = usable(r);
      const c = byCik.get(r.cik);
      return { cik: r.cik, name: c.name, sic: c.sic, website: r.website, wikipedia: c.wikipedia, usable: ok, ...(why ? { why } : {}), selected: companies.some((x) => x.cik === r.cik), ...r };
    }),
  };
  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, 'companies.json'), `${JSON.stringify(companies, null, 2)}\n`);
  await writeFile(join(DATA, 'sic2.json'), sic2);
  await writeFile(join(DATA, 'build-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify({ ...report.counts, byGroup: undefined }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
