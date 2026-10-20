#!/usr/bin/env node
// Backfills the v3 chart fields (CLASSIFY-CONTRACT.md v3) into a finished v2 pass, from the pass's own files: its rows, its
// agent repository and the truth set's companies. It writes <out>/runs.v3.jsonl and, per sealed pass, <out>/v3-sealed-
// <sha12>.jsonl; it never rewrites runs.jsonl or a sealed file, never fetches anything and never calls a model.
//   node examples/learn-classify/rerow.mjs <out> [--data <dir>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bareRepoReader, lineageOf } from './lineage.mjs';

const DATA = join(import.meta.dirname, 'data');
const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const writeRows = (file, rows) => writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));

/** A row with its v3 fields, every other field as it was. */
async function v3Of(row, { companies, reader, seedSha }) {
  const company = companies.get(row.cik);
  const sealed = row.split === 'sealed';
  const lineage = sealed ? { born: [], rewritten: [] } : await lineageOf({ admitted: row.curate?.admitted ?? [], seedSha: row.seedSha, afterSha: row.afterSha, ...reader });
  return { ...row, ...(sealed ? { phase: row.seedSha === seedSha ? 'before' : 'after' } : {}), company: company?.name ?? null, ticker: company?.ticker ?? null, ...lineage };
}

/** Writes the v3 rows of the pass in `out`; returns how many rows each file holds. */
export async function rerow({ out, data = DATA }) {
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
  if (meta.set !== 'v2') throw new Error(`${out} holds a ${meta.set ?? 'v1'} pass; the v3 fields are v2's`);
  const companies = new Map(JSON.parse(readFileSync(join(data, 'companies-v2.json'), 'utf8')).map((c) => [c.cik, c]));
  const context = { companies, reader: bareRepoReader(join(out, 'agent.git')), seedSha: meta.seedSha };
  const runs = [];
  for (const row of readRows(join(out, 'runs.jsonl'))) runs.push(await v3Of(row, context));
  writeRows(join(out, 'runs.v3.jsonl'), runs);
  const sealed = {};
  for (const file of readdirSync(out).filter((f) => /^sealed-[0-9a-f]{12}\.jsonl$/.test(f))) {
    const rows = [];
    for (const row of readRows(join(out, file))) rows.push(await v3Of(row, context));
    writeRows(join(out, `v3-${file}`), rows);
    sealed[`v3-${file}`] = rows.length;
  }
  return { runs: runs.length, sealed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { data: { type: 'string' } } });
  if (positionals.length !== 1) {
    console.error('usage: node examples/learn-classify/rerow.mjs <out> [--data <dir>]');
    process.exit(2);
  }
  const out = resolve(positionals[0]);
  console.log(JSON.stringify(await rerow({ out, ...(values.data ? { data: resolve(values.data) } : {}) })));
}
