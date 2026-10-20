#!/usr/bin/env node
// Truth set v4, the dollar job: data/companies-v4.json and data/build-report-v4.json. The same 130 companies, split and
// order as v2 (companies-v2.json), and for each, from its latest annual report in the SEC's Financial Statement Data
// Sets: every reportable segment with its revenue and share (num.txt), the head office (sub.txt cityba, stprba,
// countryba) and the report itself (form, fiscal year, period, accession). Subsidiaries come from the report's exhibit
// (EX-21 for a 10-K, EX-8 for a 20-F; a 40-F has none), read from the EDGAR filing's archived copy. --via=wayback reads
// every SEC file from the Internet Archive and records each copy's URL and capture time.
//
// A one-segment report (a lone segment member, or only a member for all segments together) is { oneSegment }; a report
// with no segment facts and no such evidence has no segment truth (null), never oneSegment.
//
//   node examples/learn-classify/build-truth-v4.mjs [--via=sec|wayback] [--cache=DIR]
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { cache, DATA, OPEN_UA, provenance, readTsv, secFile, unzipEntry, via } from './build-truth.mjs';
import { numRows, segmentTruth } from './build-truth-v2.mjs';

// Oldest first; `fsds` is 2026q1. A later quarter's annual report replaces an earlier one.
const QUARTERS = ['fsds2025q3', 'fsds2025q4', 'fsds', 'fsds2026q2'];
const ANNUAL = new Set(['10-K', '10-KT', '20-F', '40-F']);
const EXHIBIT = { '10-K': /^EX-21(\.\d+)?$/, '10-KT': /^EX-21(\.\d+)?$/, '20-F': /^EX-8(\.\d+)?$/ };
// The newest pinned quarter ends 2026-06-30; a report whose next fiscal year ended 60 days or more before AS_OF may have a
// newer one this set does not hold.
const AS_OF = '2026-10-20';
const SEC_UA = 'agentrun learn-classify demo (claudio-michel[bot]@users.noreply.github.com)';

const ungzip = (buf) => (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One EDGAR archive file: from sec.gov, or the Internet Archive's capture nearest 2026-01-01 (filings never change).
// Cached with the copy it came from.
let lastFetch = 0;
async function edgarFile(url) {
  const key = url.replace(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//, '').replaceAll('/', '_');
  const file = join(cache, 'edgar', key);
  const meta = `${file}.json`;
  try {
    return { body: await readFile(file), ...JSON.parse(await readFile(meta, 'utf8')) };
  } catch {}
  const from = via === 'wayback' ? `https://web.archive.org/web/2026id_/${url}` : url;
  // A failed connection or server error is tried once more, then left uncached for the next build.
  let record;
  let body = Buffer.alloc(0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(Math.max(0, lastFetch + (attempt ? 15_000 : via === 'sec' ? 300 : 2000) - Date.now()));
    lastFetch = Date.now();
    try {
      const res = await fetch(from, { headers: { 'user-agent': via === 'sec' ? SEC_UA : OPEN_UA }, signal: AbortSignal.timeout(90_000) });
      record = { url, copy: res.ok ? res.url : null, status: res.status };
      if (res.ok) body = ungzip(Buffer.from(await res.arrayBuffer()));
      else await res.body?.cancel();
    } catch (error) {
      record = { url, copy: null, status: 0, error: String(error?.cause?.code ?? error?.message ?? error) };
    }
    if (record.status === 200 || record.status === 404) break;
  }
  await mkdir(join(cache, 'edgar'), { recursive: true });
  if (record.status === 200 || record.status === 404) {
    await writeFile(file, body);
    await writeFile(meta, JSON.stringify(record));
  }
  return { body, ...record };
}

const cellText = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&#8217;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&[a-z]+;/gi, ' ').replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '').replace(/\s+/g, ' ').trim();
// A column heading: the name column, or one naming where a subsidiary is organized or how much is owned.
const NAME_HEAD = /^(legal |registered |group |company |entity |subsidiary )*names?\b|^(significant )?subsidiar(y|ies)$|^(group )?compan(y|ies)( name)?$|^entity$/i;
const PLACE_HEAD = /jurisdiction|incorporat|organi[sz]|domicile|^state\b|country|^place\b|location/i;
const OTHER_HEAD = /% owned|percent|ownership|interest|abbreviation|business as|d\/b\/a|segment|registrant|^status$/i;
const PERCENT = /^\(?\d{0,3}(\.\d+)?\s*%?\)?$/;
// Places a list gives as a subsidiary's jurisdiction, so a place on its own line or row belongs to the entry above it.
const PLACES = new Set((
  'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|' +
  'Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|' +
  'Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|' +
  'Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|' +
  'Wyoming|District of Columbia|Puerto Rico|Canada|Ontario|Quebec|Alberta|British Columbia|Nova Scotia|Mexico|Brazil|' +
  'Argentina|Chile|Colombia|Peru|Uruguay|Panama|Costa Rica|Guatemala|Dominican Republic|United Kingdom|England|' +
  'England and Wales|Scotland|Ireland|Jersey|Guernsey|Isle of Man|Gibraltar|Malta|Cyprus|Netherlands|The Netherlands|' +
  'Belgium|Luxembourg|France|Germany|Austria|Switzerland|Liechtenstein|Italy|Spain|Portugal|Greece|Denmark|Norway|Sweden|' +
  'Finland|Iceland|Poland|Czech Republic|Slovakia|Hungary|Romania|Bulgaria|Croatia|Serbia|Slovenia|Estonia|Latvia|' +
  'Lithuania|Ukraine|Moldova|Russia|Turkey|Israel|Egypt|Morocco|Nigeria|Kenya|South Africa|United Arab Emirates|UAE|' +
  'Saudi Arabia|Qatar|Kuwait|Bahrain|Oman|India|Pakistan|Bangladesh|Sri Lanka|China|Hong Kong|Macau|Taiwan|Japan|Korea|' +
  'South Korea|Singapore|Malaysia|Thailand|Vietnam|Philippines|Indonesia|Australia|New Zealand|Bermuda|Cayman Islands|' +
  'British Virgin Islands|Bahamas|Barbados|United States|USA|U.S.A.'
).split('|').map((place) => place.toLowerCase()));
const isPlace = (text) => PLACES.has(text.toLowerCase().replace(/[.,;]$/, ''));
const NUMBERED = /^\(?\d{1,4}[.)]?$/;
// What the archived copy wraps around the document (its EDGAR type, sequence and file name) and the exhibit's titles.
const NOT_AN_ENTRY = /^ex-\d|\.(htm|html|txt)$|="|^exhibit\b|^list of\b|list of subsidiaries|^subsidiaries\b|subsidiaries of\b|subsidiaries:?$|^document\b|^page \d/i;
const HEADING_CELL = (c) => PLACE_HEAD.test(c) || OTHER_HEAD.test(c) || NAME_HEAD.test(c) || /^(by )?registrant$|^state of$|^incorporation$/i.test(c);
const TRAILING_PLACE = /^(.*\S)\s*[([]([^()[\]]+)[)\]]\.?$/;
const FORMER = /\b(formerly|f\/k\/a|d\/b\/a|doing business)\b/i;
const asEntry = (text) => {
  const m = TRAILING_PLACE.exec(text);
  return m && !FORMER.test(m[2]) && !PERCENT.test(m[2]) ? { name: m[1].replace(/[,;]$/, ''), jurisdiction: m[2].trim() } : { name: text };
};

// The exhibit's subsidiaries, as listed. A table is read by its heading row when it has one (the name column, the
// jurisdiction column), else as name then the last cell that is not a percentage; a row of several "Name (Place)" cells
// is several entries. Without a table, each line is an entry, a trailing "(Place)" or "[Place]" its jurisdiction.
export function readSubsidiaries(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ');
  const items = [];
  let columns = null;
  for (const row of source.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    let cells = (row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText).filter(Boolean);
    if (cells.some((c) => NAME_HEAD.test(c)) && cells.some((c) => PLACE_HEAD.test(c) || OTHER_HEAD.test(c))) {
      columns = { count: cells.length, name: cells.findIndex((c) => NAME_HEAD.test(c)), place: cells.findIndex((c) => PLACE_HEAD.test(c)) };
      continue;
    }
    while (cells.length > 1 && NUMBERED.test(cells[0])) cells = cells.slice(1);
    if (!cells.length || cells.every(HEADING_CELL) || NOT_AN_ENTRY.test(cells[0]) || NAME_HEAD.test(cells[0]) || cells[0].length < 3) continue;
    if (cells.length > 1 && cells.every((c) => TRAILING_PLACE.test(c))) {
      items.push(...cells.map(asEntry));
      continue;
    }
    const aligned = columns && cells.length === columns.count && columns.name >= 0;
    const name = aligned ? cells[columns.name] : cells[0];
    const mapped = aligned && columns.place >= 0 ? cells[columns.place] : undefined;
    const place = mapped && !PERCENT.test(mapped) ? mapped : cells.filter((c) => c !== name && !PERCENT.test(c) && !PLACE_HEAD.test(c)).at(-1);
    items.push(place ? { name, jurisdiction: place } : asEntry(name));
  }
  if (items.length) return tidyEntries(items, { table: true });
  {
    const text = source.replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
    for (const raw of text.split('\n')) {
      const line = cellText(raw);
      if (line.length < 3 || NOT_AN_ENTRY.test(line) || HEADING_CELL(line) || PERCENT.test(line)) continue;
      const trailing = /^(.*\S)\s+(\S+(?: \S+){0,2})$/.exec(line);
      const split = trailing && [3, 2, 1].map((n) => line.split(' ').slice(-n).join(' ')).find((tail) => isPlace(tail) && line.length - tail.length > 4);
      items.push(isPlace(line) ? { name: line } : split && !TRAILING_PLACE.test(line) ? { name: line.slice(0, -split.length).trim().replace(/,$/, ''), jurisdiction: split } : asEntry(line));
    }
  }
  return tidyEntries(items, { table: false });
}

// A place standing alone is the jurisdiction of the entry above it; a block longer than any name is not an entry; in a
// table where most entries give a jurisdiction, one without is a section heading.
function tidyEntries(items, { table }) {
  const out = [];
  for (const item of items) {
    if (!item.jurisdiction && isPlace(item.name)) {
      if (out.length && !out.at(-1).jurisdiction) out.at(-1).jurisdiction = item.name;
      continue;
    }
    if (item.name.length > 200) continue;
    out.push({ ...item });
  }
  const placed = out.filter((i) => i.jurisdiction);
  return table && placed.length > out.length / 2 ? placed : out;
}

async function subsidiariesOf(cik, filing) {
  const pattern = EXHIBIT[filing.form];
  if (!pattern) return { truth: null, why: `a ${filing.form} files no subsidiaries exhibit` };
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.adsh.replaceAll('-', '')}/`;
  const index = await edgarFile(`${base}${filing.adsh}-index.htm`);
  if (index.status !== 200) return { truth: null, why: `no copy of the filing index (${index.status})` };
  let exhibit;
  for (const row of index.body.toString('utf8').match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<td\b[\s\S]*?<\/td>/gi) ?? []).map(cellText);
    const link = /href="([^"]+)"/i.exec(row)?.[1];
    if (cells.length >= 4 && link && pattern.test(cells[3])) {
      exhibit = { type: cells[3], file: link.split('/').pop().split('?')[0] };
      break;
    }
  }
  if (!exhibit) return { truth: null, why: `the filing index lists no ${filing.form === '20-F' ? 'EX-8' : 'EX-21'}`, index };
  const copy = await edgarFile(base + exhibit.file);
  if (copy.status !== 200) return { truth: null, why: `no copy of ${exhibit.file} (${copy.status})`, index };
  const items = readSubsidiaries(copy.body.toString('utf8'));
  if (!items.length) return { truth: null, why: `${exhibit.file} lists nothing this reader can read`, index, copy };
  return { truth: { exhibit: exhibit.type, url: copy.url, count: items.length, items }, index, copy };
}

// The latest annual report the pinned quarters hold: an original before an amendment, then the latest filed.
function latestAnnual(rows) {
  const annual = rows.filter((r) => ANNUAL.has(r.form));
  return annual.sort((a, b) => a.filed.localeCompare(b.filed) || a.adsh.localeCompare(b.adsh)).at(-1) ?? null;
}

const isoDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
function newerPossible(period) {
  const next = new Date(`${isoDate(period)}T00:00:00Z`);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  next.setUTCDate(next.getUTCDate() + 60);
  return next.toISOString().slice(0, 10) <= AS_OF;
}

// Why a company has no subsidiaries truth, counted by kind.
function nullReasons(report) {
  const kind = (why) => (/files no subsidiaries exhibit/.test(why) ? 'a 40-F files no subsidiaries exhibit'
    : /^no copy of the filing index/.test(why) ? 'the archive holds no copy of the filing index'
    : /^the filing index lists no/.test(why) ? 'the filing index lists no EX-21 / EX-8'
    : /^no copy of .*\(404\)$/.test(why) ? 'the archive holds no copy of the exhibit'
    : /^no copy of/.test(why) ? 'the exhibit could not be fetched'
    : /lists nothing this reader can read/.test(why) ? 'the reader found no subsidiaries in the exhibit' : why);
  const counts = {};
  for (const r of report) {
    const why = r.latestAnnual ?? r.subsidiaries?.why;
    if (why) counts[kind(why)] = (counts[kind(why)] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const v2 = JSON.parse(readFileSync(join(DATA, 'companies-v2.json'), 'utf8'));
  const ciks = new Set(v2.map((c) => c.cik));
  const zips = {};
  const rowsByCik = new Map();
  for (const name of QUARTERS) {
    zips[name] = await secFile(name);
    for (const row of readTsv(unzipEntry(zips[name], 'sub.txt').toString('utf8'))) {
      const cik = row.cik.padStart(10, '0');
      if (ciks.has(cik)) rowsByCik.set(cik, [...(rowsByCik.get(cik) ?? []), { ...row, quarter: name }]);
    }
  }
  const filings = new Map(v2.map((c) => [c.cik, latestAnnual(rowsByCik.get(c.cik) ?? [])]));
  const facts = new Map();
  for (const name of QUARTERS) {
    const adshs = new Set([...filings.values()].filter((f) => f?.quarter === name).map((f) => f.adsh));
    if (!adshs.size) continue;
    for await (const row of numRows(zips[name], adshs)) facts.set(row.adsh, [...(facts.get(row.adsh) ?? []), row]);
  }

  const companies = [];
  const report = [];
  for (const c of v2) {
    const f = filings.get(c.cik);
    const row = {
      cik: c.cik, name: c.name, ticker: c.ticker, website: c.website, split: c.split, order: c.order, categories: c.categories,
      sic: c.sic, sic2: c.sic2, sicDescription: c.sicDescription, segments: null, hq: null, latestAnnual: null, subsidiaries: null,
    };
    const notes = { cik: c.cik, name: c.name };
    if (!f) {
      notes.latestAnnual = 'no annual report in the pinned quarters';
    } else {
      row.latestAnnual = { form: f.form, fy: Number(f.fy), period: isoDate(f.period), adsh: f.adsh, filed: isoDate(f.filed), ...(newerPossible(f.period) ? { newerPossible: true } : {}) };
      row.hq = f.cityba || f.countryba ? { city: f.cityba || null, state: f.stprba || null, country: f.countryba || null } : null;
      notes.source = { quarter: provenance.secFiles[f.quarter]?.fetchedFrom ?? f.quarter };
      const seg = segmentTruth({ adsh: f.adsh, form: f.form, period: f.period }, facts.get(f.adsh) ?? []);
      if (!seg.truth) notes.segments = seg.why;
      else {
        const t = seg.truth;
        notes.segmentFacts = {
          tag: t.tag, uom: t.uom, total: t.total, totalFrom: t.totalFrom, period: t.period, qtrs: t.qtrs, ...(seg.sumShare ? { sumShare: seg.sumShare } : {}),
          ...(t.kind === 'single' ? { oneSegmentFrom: { member: t.member, label: t.name, revenue: t.value } } : {}),
        };
        // A member with negative revenue offsets the others (an elimination), so it is no segment.
        const members = seg.members.filter((m) => m.value >= 0);
        const offsets = seg.members.filter((m) => m.value < 0).map((m) => ({ member: m.member, revenue: m.value }));
        if (offsets.length) notes.segmentFacts.offsets = offsets;
        if (t.kind === 'single') row.segments = { oneSegment: true };
        else if (members.length >= 2) row.segments = members.map((m) => ({ member: m.member, label: m.name, revenue: m.value, share: m.share }));
        else notes.segments = 'one segment member left after dropping negative revenue';
      }
      const subs = await subsidiariesOf(c.cik, f);
      row.subsidiaries = subs.truth;
      notes.subsidiaries = {
        ...(subs.truth ? {} : { why: subs.why }),
        ...(subs.index ? { index: { url: subs.index.url, copy: subs.index.copy } } : {}),
        ...(subs.copy ? { exhibit: { url: subs.copy.url, copy: subs.copy.copy } } : {}),
      };
    }
    companies.push(row);
    report.push(notes);
  }

  const count = (pred) => companies.filter(pred).length;
  const byForm = (pred) => Object.fromEntries([...new Set(companies.map((c) => c.latestAnnual?.form ?? 'none'))].sort().map((form) => [form, {
    of: count((c) => (c.latestAnnual?.form ?? 'none') === form), with: count((c) => (c.latestAnnual?.form ?? 'none') === form && pred(c)),
  }]));
  const field = (pred) => ({ truth: count(pred), null: count((c) => !pred(c)) });
  // Segments: truth is a list of segments; oneSegment a one-segment report; null no segment facts and no one-segment evidence.
  const coverage = {
    total: companies.length,
    latestAnnual: { ...field((c) => c.latestAnnual), newerPossible: count((c) => c.latestAnnual?.newerPossible) },
    hqCity: field((c) => c.hq?.city), hqState: field((c) => c.hq?.state), hqCountry: field((c) => c.hq?.country),
    segments: { truth: count((c) => Array.isArray(c.segments)), oneSegment: count((c) => c.segments?.oneSegment), null: count((c) => !c.segments) },
    subsidiaries: { ...field((c) => c.subsidiaries), byForm: byForm((c) => c.subsidiaries), nullReasons: nullReasons(report) },
  };
  const out = {
    builtWith: { via, asOf: AS_OF, secFiles: provenance.secFiles, edgar: via === 'wayback' ? 'each file from https://web.archive.org/web/2026id_/<sec.gov url>, the capture in companies[].subsidiaries' : 'sec.gov' },
    rules: {
      quarters: QUARTERS, annualForms: [...ANNUAL], exhibits: Object.fromEntries(Object.entries(EXHIBIT).map(([k, v]) => [k, v.source])),
      segments: 'build-truth-v2.mjs segmentTruth on the latest annual report: every member of the business-segment axis; a single-segment report is { oneSegment }',
      newerPossible: 'the next fiscal year ended 60 days or more before asOf, so a newer annual report may exist beyond the pinned quarters',
    },
    coverage,
    companies: report,
  };
  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, 'companies-v4.json'), `${JSON.stringify(companies, null, 2)}\n`);
  await writeFile(join(DATA, 'build-report-v4.json'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify(coverage));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
