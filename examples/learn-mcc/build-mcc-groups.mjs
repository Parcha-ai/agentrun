// Builds data/mcc-groups.json, the MCC group table the scorer reads, from two public documents as `pdftotext -layout`
// prints them: the range groups from Citi's "Merchant Category Codes" reference, and the codes and their titles from
// Visa's Merchant Data Standards Manual (Section 2, the MCC listing). ISO 18245 itself is sold by ISO; these two print
// what the scorer needs from it.
//
//   node build-mcc-groups.mjs CITI.txt VISA.txt SOURCES.json > data/mcc-groups.json
//
// SOURCES.json names each document: { ranges: { url, sha256, ... }, codes: { url, sha256, ... }, retrieved }.
import { readFileSync } from 'node:fs';

const RANGE = /^MCCs (\d{4})–(\d{4}) \((.+)\)\s*$/;
const BRANDS = /\s{2,}((?:V|M|TSYS)(?:, (?:V|M|TSYS))*)(?:\s{2,}\S.*)?\s*$/;

/** The groups as the range reference heads its tables ("MCCs 3000–3299 (Airlines)"), in code order, and every code
 *  each table lists with its description and payment brands. A code whose row wraps sits alone on its line, its
 *  description's first line and its brands on the line before, the rest on the line after. */
export function rangesOf(text) {
  const lines = text.split('\n');
  const groups = [];
  let current = null;
  for (const [i, line] of lines.entries()) {
    const head = RANGE.exec(line);
    if (head) {
      current = { from: head[1], to: head[2], name: head[3].trim(), listed: {} };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    const row = /^(\s*(\d{4}))(\s{2,}\S.*)?$/.exec(line);
    if (!row) continue;
    const alone = row[3] === undefined;
    const host = alone ? lines[i - 1] ?? '' : line;
    const brands = BRANDS.exec(host);
    if (!brands) continue;
    const name = host.slice(alone ? 0 : row[1].length, brands.index).trim();
    current.listed[row[2]] = { name: alone ? `${name} ${(lines[i + 1] ?? '').trim()}` : name, brands: brands[1].split(', ') };
  }
  return groups.sort((a, b) => a.from.localeCompare(b.from));
}

const BLOCKS = [[/^AIRLINES AND AIR CARRIERS/, 'airlines'], [/^CAR RENTAL AGENCIES/, 'car-rental'], [/^LODGING/, 'lodging']];

/**
 * Visa's MCC listing (Section 2 up to Section 3): each code at the start of its line with its title, a title's wrapped
 * lines joined up to the blank line after it, and for a T&E merchant-specific code the block it is listed under. A code
 * listed twice keeps its first title; `repeats` names the second listing, for the build to settle.
 */
export function visaCodesOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Section 2: Merchant Category Code Listing'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('Section 3:'));
  if (start < 0 || end < 0) throw new Error('the Visa text has no Section 2 MCC listing');
  const codes = {};
  const repeats = [];
  let block = null;
  const listing = lines.slice(start, end);
  for (const [i, line] of listing.entries()) {
    const named = BLOCKS.find(([re]) => re.test(line));
    if (named) block = named[1];
    const row = /^(\d{4})\s{2,}(\S.*?)\s*$/.exec(line);
    if (!row) continue;
    const parts = [row[2].split(/\s{3,}/)[0]];
    for (let j = i + 1; j < listing.length && /^\s+\S/.test(listing[j]); j += 1) parts.push(listing[j].trim().split(/\s{3,}/)[0]);
    const title = parts.join(' ');
    const entry = { name: title, ...(row[1].startsWith('3') && block ? { block } : {}) };
    if (codes[row[1]]) repeats.push({ code: row[1], name: title });
    else codes[row[1]] = entry;
  }
  return { codes, repeats };
}

const slug = (name) => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The generic MCC Visa names for an airline, car rental or lodging merchant without its own code (VMDSM, General
 *  Requirements e). */
export const TE_GENERIC = Object.freeze({ airlines: '4511', 'car-rental': '7512', lodging: '7011' });

/**
 * The table: the groups with their ranges; `overrides`, the codes Visa lists under a T&E block outside that block's
 * range; the generic code of each T&E block; `codes`, Visa's listing (code to title); and `mastercardOnly`, the codes
 * Citi lists for Mastercard that Visa does not list. `fixes` settles a code Visa lists twice: `{ code: trueCode }` moves
 * the second listing to its true code.
 */
export function buildTable({ citi, visa, sources, fixes = {} }) {
  const { sample: _sample, ...cited } = sources;
  const ranges = rangesOf(citi);
  const groups = ranges.map((g) => ({ id: slug(g.name), from: g.from, to: g.to, name: g.name }));
  const inRange = (code) => groups.find((g) => code >= g.from && code <= g.to)?.id ?? null;
  const { codes: visaCodes, repeats } = visaCodesOf(visa);
  for (const r of repeats) {
    const to = fixes[r.code];
    if (!to) throw new Error(`Visa lists ${r.code} twice (${r.name}); name its true code in fixes`);
    if (visaCodes[to]) throw new Error(`the fix for ${r.code} moves it onto ${to}, which Visa already lists`);
    visaCodes[to] = { name: r.name };
  }
  const overrides = Object.fromEntries(Object.entries(visaCodes).filter(([code, c]) => c.block && inRange(code) !== c.block).map(([code, c]) => [code, c.block]));
  const sorted = (entries) => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  // A code Citi gives Visa alone that Visa's own listing no longer has is retired, so it is left out.
  const mastercardOnly = sorted(ranges.flatMap((g) => Object.entries(g.listed)).filter(([code, l]) => !visaCodes[code] && l.brands.includes('M')).map(([code, l]) => [code, l.name]));
  const groupOf = (code) => overrides[code] ?? inRange(code);
  // Each sample code as both documents print it: Visa's title, and the Citi table it is listed under.
  const sample = (sources.sample ?? []).map((code) => ({ code, visa: visaCodes[code]?.name ?? null, citiTable: ranges.find((g) => g.listed[code])?.name ?? null, group: groupOf(code) }));
  const outside = ranges.flatMap((g) => Object.keys(g.listed).filter((code) => code < g.from || code > g.to).map((code) => ({ code, listedUnder: g.name })));
  return {
    source: {
      ...cited,
      note: 'ISO 18245 is sold by ISO. groups are the ranges as the Citi reference heads its tables; codes is Visa\'s Section 2 listing; mastercardOnly is what Citi lists for Mastercard (brand M) that Visa does not list, under Citi\'s description; overrides are the codes Visa lists under a T&E block outside that block\'s range.',
    },
    groups,
    overrides,
    teGeneric: TE_GENERIC,
    codes: sorted(Object.entries(visaCodes).map(([code, c]) => [code, c.name])),
    mastercardOnly,
    checks: {
      listedPerGroup: Object.fromEntries(ranges.map((g) => [slug(g.name), Object.keys(g.listed).length])),
      listedOutsideTheirRange: outside,
      sample,
      visaRepeatsFixed: repeats.map((r) => ({ listedAs: r.code, name: r.name, movedTo: fixes[r.code] })),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [citiPath, visaPath, sourcesPath] = process.argv.slice(2);
  if (!citiPath || !visaPath || !sourcesPath) throw new Error('usage: node build-mcc-groups.mjs CITI.txt VISA.txt SOURCES.json');
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'));
  const table = buildTable({ citi: readFileSync(citiPath, 'utf8'), visa: readFileSync(visaPath, 'utf8'), sources, fixes: sources.fixes ?? {} });
  process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
}
