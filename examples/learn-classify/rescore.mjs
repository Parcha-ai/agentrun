#!/usr/bin/env node
// Scores a finished v4 pass again with today's scorer and a truth set, from the pass's own files: each run's answer (its
// progress file) and what it read (its store). It writes <into>/runs.rescored.jsonl, each row as it was with the v4 score
// in place and scoreCostUsd the new scoring's; it never rewrites runs.jsonl and never fetches. Unlike rerow.mjs it calls
// Jev, through the gateway (models.mjs), to judge what the scorer leaves to Jev.
//   node examples/learn-classify/rescore.mjs <out> --data <dir> [--into <dir>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { meteredJudge, textsRead, toolResultsOf } from './host.mjs';
import { scoreV4 } from './score-v4.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

/** Writes the rescored rows of the v4 pass in `out`; `judge` is a runJudge port. Returns the rows, before and after. */
export async function rescore({ out, data, judge, into = out }) {
  const meta = readJson(join(out, 'meta.json'));
  if (meta.set !== 'v4') throw new Error(`${out} holds a ${meta.set ?? 'v1'} pass; rescore scores v4 passes`);
  const companies = new Map(readJson(join(data, 'companies-v4.json')).map((c) => [c.cik, c]));
  const codes = readJson(join(data, 'sic-codes.json'));
  const before = readRows(join(out, 'runs.jsonl'));
  const after = [];
  for (const row of before) {
    const base = `run-${String(row.run).padStart(3, '0')}`;
    const progress = readJson(join(out, 'progress', `${base}.json`));
    const runId = progress.attempt === 1 ? base : `${base}-a${progress.attempt}`;
    const company = companies.get(row.cik);
    if (!company) throw new Error(`run ${row.run}: ${row.cik} is not in ${data}`);
    const metered = meteredJudge(judge);
    const read = textsRead(toolResultsOf(join(out, 'home', 'runs', runId, 'store', 'run.sqlite')));
    const score = await scoreV4({ answer: progress.measure.answer, company, read, codes, judge: metered.run });
    after.push({ ...row, ...score, truth: score.sic4Truth, scoreCostUsd: metered.meter.unknown ? null : metered.meter.costUsd });
  }
  writeFileSync(join(into, 'runs.rescored.jsonl'), after.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { before, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { data: { type: 'string' }, into: { type: 'string' } } });
  if (positionals.length !== 1 || !values.data) {
    console.error('usage: node examples/learn-classify/rescore.mjs <out> --data <dir> [--into <dir>]');
    process.exit(2);
  }
  const { gatewayJev, gatewayOf } = await import('./models.mjs');
  const out = resolve(positionals[0]);
  const { before, after } = await rescore({ out, data: resolve(values.data), judge: gatewayJev(gatewayOf()), ...(values.into ? { into: resolve(values.into) } : {}) });
  for (const [i, row] of after.entries()) {
    const was = before[i];
    console.log(`run ${row.run} ${row.ticker}: correct ${was.correct} -> ${row.correct}, cites ${was.evidenceSupported?.toFixed(2) ?? '-'} -> ${row.evidenceSupported?.toFixed(2) ?? '-'}, hq ${was.hqCorrect} -> ${row.hqCorrect}, scorer $${row.scoreCostUsd?.toFixed(4) ?? '?'}`);
  }
}
