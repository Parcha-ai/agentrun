#!/usr/bin/env node
// cost-on-ties-price.mjs <runs.jsonl> [--through <run>]: COST_ON_TIES.agentFinishUsd's derivation (proposal C, Amendment 2):
// the mean cost the agent pays to finish a job its workflow escalated or failed, over a stream's rows up to stream run
// `through`: each such row's cost less what its host workflow spent. Prints the read as JSON; cost-on-ties-price.json holds
// the one pinned (the MCC challenge stream B's TRAIN rows, runs 1-237), and the constant is that mean to the cent.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The agent's finishing cost of each escalated or failed host run among `lines` (runs.jsonl text lines). */
export function finishCosts(lines) {
  const out = [];
  for (const line of lines) {
    const row = JSON.parse(line);
    if (!['escalated', 'failed'].includes(row.dispatch?.outcome) || typeof row.costUsd !== 'number') continue;
    const workflow = (row.executions ?? []).filter((e) => String(e.key ?? '').startsWith('host:')).reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    out.push(row.costUsd - workflow);
  }
  return out;
}

export function priceOf(text, through) {
  const lines = text.split('\n').filter((l) => l.trim() && (through === undefined || JSON.parse(l).run <= through));
  const costs = finishCosts(lines);
  const sorted = [...costs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  return {
    rows: lines.length, rowsSha256: createHash('sha256').update(lines.join('\n')).digest('hex'), through: through ?? null,
    n: costs.length, meanUsd: Math.round(mean * 1e4) / 1e4, medianUsd: Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 1e4) / 1e4,
    agentFinishUsd: Math.round(mean * 100) / 100,
  };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [file, flag, at] = process.argv.slice(2);
  if (!file || (flag !== undefined && flag !== '--through')) { console.error('usage: cost-on-ties-price.mjs <runs.jsonl> [--through <run>]'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(priceOf(readFileSync(file, 'utf8'), at === undefined ? undefined : Number(at)), null, 1)}\n`);
}
