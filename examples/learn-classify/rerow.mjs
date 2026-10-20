#!/usr/bin/env node
// Backfills the v3 chart fields (CLASSIFY-CONTRACT.md v3) into a finished v2 or v4 pass, from the pass's own files: its rows, its
// recordings (the workflow part, job-record.mjs), its agent repository and the truth set's companies. It writes <out>/runs.v3.jsonl and, per sealed pass, <out>/v3-sealed-
// <sha12>.jsonl; it never rewrites runs.jsonl or a sealed file, never fetches anything and never calls a model.
//   node examples/learn-classify/rerow.mjs <out> [--data <dir>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hostRecord } from './dispatch.mjs';
import { jobRecordOf } from './job-record.mjs';
import { bareRepoReader, lineageOf } from './lineage.mjs';

const DATA = join(import.meta.dirname, 'data');
/** The truth set a hard pass's companies come from, by its set. */
const TRUTH = { v2: 'companies-v2.json', v4: 'companies-v4.json' };
const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const writeRows = (file, rows) => writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));

/** A row with its v3 fields, every other field as it was. The workflow part is job-record.mjs's, over the run's
 *  recording; a row whose recording was not kept has none of it. */
async function v3Of(row, { companies, reader, seedSha, recordings }) {
  const company = companies.get(row.cik);
  const sealed = row.split === 'sealed';
  const lineage = sealed ? { born: [], rewritten: [] } : await lineageOf({ admitted: row.curate?.admitted ?? [], seedSha: row.seedSha, afterSha: row.afterSha, ...reader });
  const events = row.recording ? join(recordings, row.recording, 'events.jsonl') : undefined;
  const record = events && existsSync(events) ? hostRecord(jobRecordOf(readRows(events)), row.dispatch) : undefined;
  return {
    ...row, ...(sealed ? { phase: row.seedSha === seedSha ? 'before' : 'after' } : {}), company: company?.name ?? null, ticker: company?.ticker ?? null, ...lineage,
    ...(record ? { executions: record.executions, workflowShare: record.workflowShare, agentFallback: record.agentFallback } : {}),
  };
}

/** Writes the v3 rows of the pass in `out`; returns how many rows each file holds. */
export async function rerow({ out, data = DATA }) {
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
  const truthFile = TRUTH[meta.set];
  if (!truthFile) throw new Error(`${out} holds a ${meta.set ?? 'v1'} pass; the v3 fields are the hard jobs' (v2 and v4)`);
  const companies = new Map(JSON.parse(readFileSync(join(data, truthFile), 'utf8')).map((c) => [c.cik, c]));
  const context = { companies, reader: bareRepoReader(join(out, 'agent.git')), seedSha: meta.seedSha, recordings: join(out, 'recordings') };
  const runs = [];
  for (const row of readRows(join(out, 'runs.jsonl'))) runs.push(await v3Of(row, context));
  writeRows(join(out, 'runs.v3.jsonl'), runs);
  const sealed = {};
  for (const file of readdirSync(out).filter((f) => /^sealed-[0-9a-f]{12}\.jsonl$/.test(f))) {
    const rows = [];
    const sealedContext = { ...context, recordings: join(out, 'sealed', file.slice('sealed-'.length, -'.jsonl'.length), 'recordings') };
    for (const row of readRows(join(out, file))) rows.push(await v3Of(row, sealedContext));
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
