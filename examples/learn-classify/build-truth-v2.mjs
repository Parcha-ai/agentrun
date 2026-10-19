#!/usr/bin/env node
// Truth set v2, the hard one: data/companies-v2.json, data/sic-codes.json and data/build-report-v2.json. The answer is the
// 4-digit SIC plus the primary operating segment (the largest revenue member on the business-segment axis) and its share
// of revenue, both from the SEC's Financial Statement Data Set 2026q1 (sub.txt, num.txt). Every company falls in at least
// one hard category, and each category holds about a fifth of the set:
//   multi-segment  3 or more reportable segments with revenue in the filing's XBRL;
//   holding        a holding name ("Holdings", "Enterprises", "Diversified") or SIC 6799: the parent's SIC is not what
//                  the name says, and the business sits in subsidiaries;
//   small-cap      revenue in the lowest quartile of the pool;
//   renamed        sub.txt names a former name, changed since 2015;
//   foreign        files 20-F or 40-F from outside the US;
//   bot-wall       its website answers fetch_page with a bot wall (401/403/429/503, a challenge page) or no text.
// Same inputs and flags as build-truth.mjs (the SEC files from sec.gov or their Wayback copies, Wikidata, one fetch_page
// check per website), and the same cache. v1's companies are left out.
//
//   node examples/learn-classify/build-truth-v2.mjs [--via=sec|wayback] [--cache=DIR]
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createInflateRaw } from 'node:zlib';
import {
  args, cache, CHALLENGE, checkAll, DATA, EXCLUDED_SIC, GROUP_CAP, MAJOR_GROUPS, MIN_RUN_GROUPS, pickWebsite, provenance, rank,
  readSicList, readTsv, secFile, unzipEntry, via, wikidata, zipEntry,
} from './build-truth.mjs';
import { domainOf } from './tools.mjs';

const TOTAL = 130;
const RUN = 100;
const SEALED = TOTAL - RUN;
const TARGET = Math.round(0.2 * TOTAL);
const WEBSITES_SHOWN = Math.round(TOTAL / 2);
export const CATEGORIES = ['multi-segment', 'holding', 'small-cap', 'renamed', 'foreign', 'bot-wall'];

const ANNUAL = new Set(['10-K', '10-KT', '20-F', '40-F']);
const FORMS = new Set([...ANNUAL, '10-Q', '10-K/A', '10-Q/A', '20-F/A', '40-F/A']);
const FOREIGN_FORMS = new Set(['20-F', '20-F/A', '40-F', '40-F/A']);
// Standard revenue tags, us-gaap and ifrs-full, in the order a tie is broken.
const REVENUE_TAGS = [
  'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenue',
  'RevenueFromContractsWithCustomers', 'RevenuesNetOfInterestExpense', 'RevenueFromSaleOfGoods',
];
// num.txt writes a dimension as Axis=Member with both suffixes dropped: us-gaap's StatementBusinessSegmentsAxis is
// BusinessSegments, ifrs-full's SegmentsAxis is Segments.
const SEGMENT_AXES = new Set(['BusinessSegments', 'Segments']);
const OPERATING_ONLY = new Set(['ConsolidationItems=OperatingSegments', 'SegmentConsolidationItems=OperatingSegments']);
const NOT_A_SEGMENT = /elimination|reconcil|corporate|unallocated|consolidat|^total|allother|^other(segments?)?$|intersegment|^operatingsegments$/i;
// Members that stand for all reportable segments together (ASU 2023-07 tagging), not for one of them.
const ALL_SEGMENTS = /^(reportablesegments?|reportablesegmentaggregationbeforeotheroperatingsegment|\w*singlereport\w*|primaryreporting\w*|globalsegments?|(all)?segments?|reportingsegments?)$/i;
// A lone member this close to the whole is a single-segment company; several members must add up to about the whole.
const SINGLE_SHARE = 0.95;
const MEMBERS_MIN = 0.85;
const MEMBERS_MAX = 1.2;
const RENAMED_SINCE = '20150101';
const HOLDING_NAME = /\b(HOLDINGS?|HLDGS|ENTERPRISES|DIVERSIFIED)\b/;
const HOLDING_SIC = new Set(['6799']);
const REIT = '6798';
const WALL_STATUS = new Set([401, 403, 429, 503]);

const SPARQL_V2 = `SELECT ?item ?cik ?website ?article WHERE {
  ?item wdt:P5531 ?cik .
  OPTIONAL { ?item wdt:P856 ?website . }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
}`;

const LEGAL = /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LP|L P|SA|S A|NV|N V|AG|SE|THE|HOLDINGS?|GROUP)\b/g;
const plainName = (name) => name.toUpperCase().replace(/\/[A-Z]{2,3}\/?$/, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, '').trim();

// "AmazonWebServicesSegment" reads "Amazon Web Services".
export const segmentName = (member) =>
  member.replace(/Member$/, '').replace(/(Reportable)?(Operating)?(Business)?Segment$/, '').replace(/ReportableSegments?/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim() || member;

async function* numRows(zip, adshs) {
  const { data, method } = zipEntry(zip, 'num.txt');
  if (method !== 8) throw new Error('num.txt is not deflated');
  const lines = createInterface({ input: Readable.from([data]).pipe(createInflateRaw()), crlfDelay: Infinity });
  let keys;
  const wanted = new Set(REVENUE_TAGS);
  for await (const line of lines) {
    const cells = line.split('\t');
    if (!keys) {
      keys = cells;
      continue;
    }
    if (!adshs.has(cells[0]) || !wanted.has(cells[1])) continue;
    const row = Object.fromEntries(keys.map((k, i) => [k, cells[i]]));
    if (row.version === row.adsh) continue;
    yield row;
  }
}

// The filing a company's facts come from: an annual report before a quarterly one, an original before an amendment,
// then the latest.
function filingFor(rows) {
  const priority = (r) => (r.form.endsWith('/A') ? 2 : ANNUAL.has(r.form) ? 0 : 1);
  return [...rows].sort((a, b) => priority(a) - priority(b) || b.filed.localeCompare(a.filed) || a.adsh.localeCompare(b.adsh))[0];
}

// The primary segment: the largest revenue member on the business-segment axis, for the filing's own period, over the
// consolidated total of the same tag. kind "single" when the filing reports one segment (one member near the whole, or
// only a member standing for all reportable segments together). Null when there is no segment revenue, or the members
// overlap or leave out too much to trust which is largest.
export function segmentTruth(filing, rows) {
  const qtrs = ANNUAL.has(filing.form.replace('/A', '')) ? '4' : '1';
  const at = rows.filter((r) => r.ddate === filing.period);
  const periodQtrs = at.some((r) => r.qtrs === qtrs) ? qtrs : at.map((r) => r.qtrs).sort().at(-1);
  const facts = at.filter((r) => r.qtrs === periodQtrs);
  let best = null;
  for (const tag of REVENUE_TAGS) {
    const tagged = facts.filter((r) => r.tag === tag);
    const total = tagged.find((r) => r.segments === '');
    const members = new Map();
    const aggregates = new Map();
    for (const r of tagged) {
      if (!r.segments) continue;
      const pairs = r.segments.split(';').filter(Boolean);
      const axisPair = pairs.find((p) => SEGMENT_AXES.has(p.split('=')[0]));
      if (!axisPair || pairs.some((p) => p !== axisPair && !OPERATING_ONLY.has(p))) continue;
      const [axis, member] = axisPair.split('=');
      if (NOT_A_SEGMENT.test(member) || (total && r.uom !== total.uom)) continue;
      const into = ALL_SEGMENTS.test(member) ? aggregates : members;
      const value = Number(r.value);
      if (!(value > (into.get(member)?.value ?? -Infinity))) continue;
      into.set(member, { member, axis, value, uom: r.uom });
    }
    const size = members.size || (aggregates.size ? 0.5 : 0);
    if (size > (best?.size ?? 0)) best = { tag, total, members, aggregates, size };
  }
  if (!best) return { truth: null, why: 'no revenue on the business-segment axis for the filing period' };
  const round = (x) => Math.round(x * 10000) / 10000;
  const list = [...best.members.values()].sort((a, b) => b.value - a.value || a.member.localeCompare(b.member));
  const sum = list.reduce((s, m) => s + m.value, 0);
  const total = best.total ? Number(best.total.value) : sum;
  const base = { tag: best.tag, total, totalFrom: best.total ? 'tag' : 'sum', period: filing.period, qtrs: Number(periodQtrs), adsh: filing.adsh, form: filing.form };
  const members = list.map((m) => ({ name: segmentName(m.member), member: m.member, value: m.value, share: total > 0 ? round(m.value / total) : null }));
  if (list.length === 0) {
    const [aggregate] = [...best.aggregates.values()].sort((a, b) => b.value - a.value);
    const whole = best.total ? total : aggregate.value;
    const cover = aggregate.value / whole;
    if (!(whole > 0) || cover < SINGLE_SHARE || cover > 2 - SINGLE_SHARE) return { truth: null, why: `only a member for all segments together, covering ${round(cover)} of revenue`, members };
    return { truth: { kind: 'single', name: null, member: aggregate.member, axis: aggregate.axis, share: 1, value: aggregate.value, uom: aggregate.uom, segments: 1, ...base, total: whole }, members };
  }
  const top = list[0];
  const share = top.value / total;
  const sumShare = round(sum / total);
  if (!(top.value > 0) || !(total > 0) || share > 1.0001) return { truth: null, why: `the largest member is ${top.value} of ${total}`, members };
  if (list.length === 1 && share < SINGLE_SHARE) return { truth: null, why: `one segment member, covering only ${round(share)} of revenue`, members };
  if (list.length > 1 && (sumShare > MEMBERS_MAX || sumShare < MEMBERS_MIN)) {
    return { truth: null, why: `the segment members add up to ${sumShare} of revenue, so they overlap or leave segments out`, sumShare, members };
  }
  return {
    truth: {
      kind: list.length === 1 ? 'single' : 'largest', name: segmentName(top.member), member: top.member, axis: top.axis, share: round(share),
      value: top.value, uom: top.uom, segments: list.length, ...base,
    },
    sumShare,
    members,
  };
}

const consolidatedRevenue = (filing, rows) => {
  for (const tag of REVENUE_TAGS) {
    const r = rows.find((x) => x.tag === tag && x.segments === '' && x.ddate === filing.period && x.uom === 'USD');
    if (r && Number(r.value) > 0) return Number(r.value) * (4 / Number(r.qtrs || 4));
  }
  return null;
};

function isWall(c) {
  if (!c) return false;
  return WALL_STATUS.has(c.status) || /no readable text/.test(c.error ?? '') || (c.pageOk && CHALLENGE.test(c.title));
}

async function pool() {
  const v1 = new Set(JSON.parse(readFileSync(join(DATA, 'companies.json'), 'utf8')).map((c) => c.cik));
  const tickers = new Map();
  for (const row of Object.values(JSON.parse((await secFile('tickers')).toString('utf8')))) {
    if (!tickers.has(row.cik_str)) tickers.set(row.cik_str, row);
  }
  const zip = await secFile('fsds');
  const sub = readTsv(unzipEntry(zip, 'sub.txt').toString('utf8'));
  const sicList = readSicList((await secFile('sicList')).toString('utf8'));
  const byCik = Map.groupBy(sub.filter((r) => FORMS.has(r.form)), (r) => Number(r.cik));
  const sites = new Map();
  for (const b of (await wikidata({ query: SPARQL_V2, name: 'wikidata-v2' })).results.bindings) {
    if (!/^\d+$/.test(b.cik.value)) continue;
    const cik = Number(b.cik.value);
    const entry = sites.get(cik) ?? { websites: new Set(), items: new Set(), wikipedia: null };
    if (b.website) entry.websites.add(b.website.value);
    if (b.article) entry.wikipedia ??= b.article.value;
    entry.items.add(b.item.value);
    sites.set(cik, entry);
  }
  const candidates = [];
  for (const [cik, rows] of byCik) {
    const ticker = tickers.get(cik);
    const filing = filingFor(rows);
    const cikText = String(cik).padStart(10, '0');
    if (!ticker || !filing.sic || v1.has(cikText)) continue;
    const sic = filing.sic.padStart(4, '0');
    if (EXCLUDED_SIC.has(sic) || !sicList[sic] || !MAJOR_GROUPS[sic.slice(0, 2)]) continue;
    const site = sites.get(cik);
    const single = site && site.items.size === 1;
    const website = single ? pickWebsite(site.websites, { name: ticker.title, ticker: ticker.ticker }) : null;
    candidates.push({
      cik: cikText, name: filing.name, ticker: ticker.ticker, website, domain: website && domainOf(website), wikipedia: single ? site.wikipedia : null,
      sic, sic2: sic.slice(0, 2), sicDescription: sicList[sic], filing,
    });
  }
  const adshs = new Set(candidates.map((c) => c.filing.adsh));
  const facts = new Map();
  for await (const row of numRows(zip, adshs)) facts.set(row.adsh, [...(facts.get(row.adsh) ?? []), row]);
  for (const c of candidates) {
    const rows = facts.get(c.filing.adsh) ?? [];
    c.segment = segmentTruth(c.filing, rows);
    c.revenueUsd = consolidatedRevenue(c.filing, rows);
  }
  const revenues = candidates.map((c) => c.revenueUsd).filter((v) => v > 0).sort((a, b) => a - b);
  const smallBelow = revenues[Math.floor(revenues.length / 4)];
  for (const c of candidates) {
    const f = c.filing;
    c.facts = {
      form: f.form, filed: f.filed, period: f.period, countryba: f.countryba || null, stprba: f.stprba || null,
      former: f.former || null, changed: f.changed || null, revenueUsdAnnual: c.revenueUsd,
    };
    c.base = new Set();
    if ((c.segment.truth?.segments ?? 0) >= 3) c.base.add('multi-segment');
    if (c.sic !== REIT && (HOLDING_NAME.test(f.name.toUpperCase()) || HOLDING_SIC.has(c.sic))) c.base.add('holding');
    if (c.revenueUsd > 0 && c.revenueUsd < smallBelow) c.base.add('small-cap');
    if (f.former && f.changed >= RENAMED_SINCE && plainName(f.former) !== plainName(f.name)) c.base.add('renamed');
    if (FOREIGN_FORMS.has(f.form) && f.countryba && f.countryba !== 'US') c.base.add('foreign');
  }
  return { candidates, smallBelow, sources: { sub: sub.length, filers: byCik.size, tickers: tickers.size, wikidata: sites.size, sicCodes: Object.keys(sicList).length }, sicList };
}

const categoriesOf = (c, checks) => {
  const known = checks[c.cik]?.website === c.website ? checks[c.cik] : null;
  return CATEGORIES.filter((k) => (k === 'bot-wall' ? Boolean(c.website) && isWall(known) : c.base.has(k)));
};

// Greedy: first fill every category to TARGET, taking the company that lifts the most short categories; then fill to
// TOTAL from the least-filled category. Ties go to a company with segment truth, then one with a known website (so half
// the set can show one), then a fixed hash order. At most GROUP_CAP a 2-digit group.
function choose(candidates, checks) {
  const order = [...candidates].sort((a, b) => rank('v2-pick', a.cik).localeCompare(rank('v2-pick', b.cik)));
  const cats = new Map(order.map((c) => [c.cik, categoriesOf(c, checks)]));
  const count = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  const groups = new Map();
  const chosen = [];
  const taken = new Set();
  while (chosen.length < TOTAL) {
    const short = CATEGORIES.filter((k) => count[k] < TARGET);
    let best = null;
    for (const c of order) {
      if (taken.has(c.cik) || (groups.get(c.sic2) ?? 0) >= GROUP_CAP) continue;
      const mine = cats.get(c.cik);
      if (mine.length === 0) continue;
      const lift = short.length ? mine.filter((k) => short.includes(k)).length : 1 / (1 + Math.min(...mine.map((k) => count[k])));
      if (lift === 0) continue;
      const score = [lift, c.segment.truth ? 1 : 0, c.website ? 1 : 0];
      const i = best ? score.findIndex((v, n) => v !== best.score[n]) : 0;
      if (!best || (i >= 0 && score[i] > best.score[i])) best = { c, score };
    }
    if (!best) throw new Error(`stopped at ${chosen.length} companies: no candidate adds to a category`);
    chosen.push(best.c);
    taken.add(best.c.cik);
    groups.set(best.c.sic2, (groups.get(best.c.sic2) ?? 0) + 1);
    for (const k of cats.get(best.c.cik)) count[k]++;
  }
  return { chosen, cats };
}

// 30 sealed, each category sealed in about its share, never a group's last company in the run split; the run in a fixed
// shuffle with no two neighbours from the same group.
function split(chosen, cats) {
  const count = Object.fromEntries(CATEGORIES.map((k) => [k, chosen.filter((c) => cats.get(c.cik).includes(k)).length]));
  const cap = Object.fromEntries(CATEGORIES.map((k) => [k, Math.ceil((count[k] * SEALED) / TOTAL)]));
  const inGroup = Map.groupBy(chosen, (c) => c.sic2);
  const sealed = new Set();
  const sealedIn = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  const runLeft = (c) => inGroup.get(c.sic2).filter((x) => !sealed.has(x.cik)).length;
  const order = [...chosen].sort((a, b) => rank('v2-sealed', a.cik).localeCompare(rank('v2-sealed', b.cik)));
  for (const strict of [true, false]) {
    for (const c of order) {
      if (sealed.size >= SEALED || sealed.has(c.cik) || runLeft(c) <= 1) continue;
      if (strict && cats.get(c.cik).some((k) => sealedIn[k] >= cap[k])) continue;
      sealed.add(c.cik);
      for (const k of cats.get(c.cik)) sealedIn[k]++;
    }
  }
  const run = chosen.filter((c) => !sealed.has(c.cik)).sort((a, b) => rank('v2-order', a.cik).localeCompare(rank('v2-order', b.cik)));
  const g = (k) => run[k]?.sic2;
  for (let i = 1; i < run.length; i++) {
    if (g(i) !== g(i - 1)) continue;
    const j = run.findIndex((_, k) => k > i + 1 && g(k) !== g(i - 1) && g(k) !== g(i + 1) && g(k - 1) !== g(i) && g(k + 1) !== g(i));
    if (j > 0) [run[i], run[j]] = [run[j], run[i]];
  }
  return { run, sealed: chosen.filter((c) => sealed.has(c.cik)).sort((a, b) => a.cik.localeCompare(b.cik)) };
}

// Half the set shows its website, spread so each category shows about half of the websites it has.
function showWebsites(chosen, cats) {
  const withSite = chosen.filter((c) => c.website).sort((a, b) => rank('v2-website', a.cik).localeCompare(rank('v2-website', b.cik)));
  const want = Object.fromEntries(CATEGORIES.map((k) => [k, withSite.filter((c) => cats.get(c.cik).includes(k)).length / 2]));
  const have = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  const shown = new Set();
  while (shown.size < Math.min(WEBSITES_SHOWN, withSite.length)) {
    let best = null;
    for (const c of withSite) {
      if (shown.has(c.cik)) continue;
      const need = cats.get(c.cik).reduce((s, k) => s + (want[k] - have[k]) / Math.max(want[k], 1), 0);
      if (!best || need > best.need) best = { c, need };
    }
    shown.add(best.c.cik);
    for (const k of cats.get(best.c.cik)) have[k]++;
  }
  return shown;
}

async function main() {
  await mkdir(cache, { recursive: true });
  const checksFile = join(cache, 'checks.json');
  let checks = {};
  try {
    checks = JSON.parse(await readFile(checksFile, 'utf8'));
  } catch {}
  const { candidates, smallBelow, sources, sicList } = await pool();
  let chosen;
  let cats;
  // A check can add bot-wall to a company, which can change the choice; stop when every chosen website has its check.
  for (;;) {
    ({ chosen, cats } = choose(candidates, checks));
    const unchecked = chosen.filter((c) => c.website && checks[c.cik]?.website !== c.website);
    if (unchecked.length === 0) break;
    if (args.dry === 'true') {
      console.log(JSON.stringify({ unchecked: unchecked.length, pool: candidates.length, smallBelow, sources }));
      for (const k of CATEGORIES) console.log(k, candidates.filter((c) => c.base.has(k)).length, chosen.filter((c) => cats.get(c.cik).includes(k)).length);
      console.log('segment truth pool', candidates.filter((c) => c.segment.truth).length, 'chosen', chosen.filter((c) => c.segment.truth).length);
      return;
    }
    await checkAll(unchecked, checks);
    await writeFile(checksFile, JSON.stringify(checks, null, 1));
  }
  const { run, sealed } = split(chosen, cats);
  const shown = showWebsites(chosen, cats);
  const row = (c, splitName, order) => ({
    cik: c.cik, name: c.name, ticker: c.ticker, website: shown.has(c.cik) ? c.website : null, split: splitName, order,
    categories: cats.get(c.cik), sic: c.sic, sic2: c.sic2, sicDescription: c.sicDescription, segmentTruth: c.segment.truth,
  });
  const companies = [...run.map((c, i) => row(c, 'run', i + 1)), ...sealed.map((c) => row(c, 'sealed', null))];

  const inCategory = (list, k) => list.filter((c) => c.categories.includes(k)).length;
  const runRows = companies.filter((c) => c.split === 'run');
  const groupCount = (list) => new Map([...Map.groupBy(list, (c) => c.sic2)].map(([g, l]) => [g, l.length]));
  if (companies.length !== TOTAL || runRows.length !== RUN) throw new Error(`built ${companies.length} companies, ${runRows.length} run`);
  if (groupCount(runRows).size < MIN_RUN_GROUPS) throw new Error(`only ${groupCount(runRows).size} groups in the run split`);
  for (const c of companies) if (c.categories.length === 0) throw new Error(`${c.cik} is in no hard category`);

  const report = {
    builtWith: { via, secFiles: provenance.secFiles, wikidata: provenance['wikidata-v2'] },
    rules: {
      total: TOTAL, run: RUN, sealed: SEALED, categoryTarget: TARGET, groupCap: GROUP_CAP, websitesShown: WEBSITES_SHOWN,
      excludedSic: [...EXCLUDED_SIC], renamedSince: RENAMED_SINCE, holdingName: HOLDING_NAME.source, holdingSic: [...HOLDING_SIC],
      smallCapBelowUsd: smallBelow, revenueTags: REVENUE_TAGS, segmentAxes: [...SEGMENT_AXES], notASegment: NOT_A_SEGMENT.source,
      allSegments: ALL_SEGMENTS.source, singleShare: SINGLE_SHARE, membersSum: [MEMBERS_MIN, MEMBERS_MAX],
      wall: { status: [...WALL_STATUS], challengeTitle: CHALLENGE.source, noText: true },
    },
    sources,
    counts: {
      pool: candidates.length,
      poolByCategory: Object.fromEntries(CATEGORIES.map((k) => [k, candidates.filter((c) => (k === 'bot-wall' ? cats.get(c.cik)?.includes(k) : c.base.has(k))).length])),
      poolSegmentTruth: candidates.filter((c) => c.segment.truth).length,
      byCategory: Object.fromEntries(CATEGORIES.map((k) => [k, { total: inCategory(companies, k), run: inCategory(runRows, k), websiteShown: companies.filter((c) => c.categories.includes(k) && c.website).length }])),
      categoriesPerCompany: Object.fromEntries([...Map.groupBy(companies, (c) => c.categories.length)].sort(([a], [b]) => a - b).map(([n, l]) => [n, l.length])),
      segmentTruth: companies.filter((c) => c.segmentTruth).length,
      segmentTruthByCategory: Object.fromEntries(CATEGORIES.map((k) => [k, companies.filter((c) => c.categories.includes(k) && c.segmentTruth).length])),
      websiteShown: companies.filter((c) => c.website).length,
      groups: groupCount(companies).size, runGroups: groupCount(runRows).size, largestGroup: Math.max(...groupCount(companies).values()),
    },
    companies: chosen.map((c) => {
      const k = checks[c.cik]?.website === c.website ? checks[c.cik] : null;
      return {
        cik: c.cik, name: c.name, website: c.website, wikipedia: c.wikipedia, facts: c.facts,
        segments: c.segment.members ?? [], ...(c.segment.sumShare ? { segmentSumShare: c.segment.sumShare } : {}),
        ...(c.segment.truth ? {} : { segmentTruthNull: c.segment.why }),
        check: k && { status: k.status, url: k.url, title: k.title, textChars: k.textChars, ...(k.error ? { error: k.error } : {}), ...(k.refused ? { refused: k.refused } : {}), checkedAt: k.checkedAt },
      };
    }).sort((a, b) => a.cik.localeCompare(b.cik)),
  };
  const sicCodes = `{\n${Object.entries(sicList).sort(([a], [b]) => a.localeCompare(b)).map(([code, title]) => `  ${JSON.stringify(code)}: ${JSON.stringify(title)}`).join(',\n')}\n}\n`;
  await writeFile(join(DATA, 'companies-v2.json'), `${JSON.stringify(companies, null, 2)}\n`);
  await writeFile(join(DATA, 'sic-codes.json'), sicCodes);
  await writeFile(join(DATA, 'build-report-v2.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report.counts));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
