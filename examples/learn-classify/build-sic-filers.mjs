#!/usr/bin/env node
// The SEC's own SIC vocabulary for v4's code tools: data/sic-filers.json, for each code of the SEC's list how many filers
// the SEC files under it and the largest of them, and for each 2-digit group its largest filers. It reads the same
// pinned Financial Statement Data Sets as truth set v4 (each filer at the code of its latest submission) and the SEC's
// company_tickers.json, whose order is largest first. Every company of a truth set here is left out, run and sealed
// alike, so no code is offered or named because a company the loop is scored on files under it.
//
//   node examples/learn-classify/build-sic-filers.mjs [--via=sec|wayback] [--cache=DIR]
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, provenance, readTsv, secFile, unzipEntry, via } from './build-truth.mjs';
import { QUARTERS } from './build-truth-v4.mjs';

const plainCik = (cik) => String(cik).replace(/^0+/, '');

/**
 * `{ codes: { [code]: { filers, examples } }, groups: { [group]: { examples } } }` over the codes of `codes`: `sub` is
 * sub.txt's rows oldest first (a filer counts once, at its last code), `tickers` the SEC's tickers file in its order
 * (largest first), `exclude` the CIKs to leave out. A code no filer has is absent, and so is a group with no such code.
 */
export function sicVocabulary({ sub, tickers, codes, exclude = [], perCode = 3, perGroup = 4 }) {
  const left = new Set([...exclude].map(plainCik));
  const codeOf = new Map();
  for (const row of sub) {
    const sic = String(row.sic ?? '').trim().padStart(4, '0');
    if (/^[0-9]{4}$/.test(sic) && sic !== '0000' && codes[sic]) codeOf.set(plainCik(row.cik), sic);
  }
  for (const cik of left) codeOf.delete(cik);
  const out = { codes: {}, groups: {} };
  for (const sic of [...codeOf.values()].sort()) {
    (out.codes[sic] ??= { filers: 0, examples: [] }).filers++;
    out.groups[sic.slice(0, 2)] ??= { examples: [] };
  }
  const named = new Set();
  for (const { cik_str: cik, title } of tickers) {
    const sic = codeOf.get(plainCik(cik));
    if (!sic || named.has(plainCik(cik))) continue;
    named.add(plainCik(cik));
    if (out.codes[sic].examples.length < perCode) out.codes[sic].examples.push(title);
    if (out.groups[sic.slice(0, 2)].examples.length < perGroup) out.groups[sic.slice(0, 2)].examples.push(title);
  }
  return out;
}

async function main() {
  const readJson = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
  const exclude = ['companies.json', 'companies-v2.json', 'companies-v4.json'].flatMap((name) => readJson(name).map((c) => c.cik));
  const sub = [];
  for (const name of QUARTERS) {
    const rows = readTsv(unzipEntry(await secFile(name), 'sub.txt').toString('utf8'));
    sub.push(...rows.sort((a, b) => a.filed.localeCompare(b.filed)));
  }
  const tickers = Object.values(JSON.parse((await secFile('tickers')).toString('utf8')));
  const vocabulary = sicVocabulary({ sub, tickers, codes: readJson('sic-codes.json'), exclude });
  await writeFile(join(DATA, 'sic-filers.json'), `${JSON.stringify(vocabulary, null, 1)}\n`);
  const sources = Object.fromEntries([...QUARTERS, 'tickers'].map((name) => [name, provenance.secFiles[name]]));
  console.log(JSON.stringify({ via, codes: Object.keys(vocabulary.codes).length, groups: Object.keys(vocabulary.groups).length, excluded: new Set(exclude).size, sources }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
