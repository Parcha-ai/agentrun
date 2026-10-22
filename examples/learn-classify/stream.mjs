#!/usr/bin/env node
// The TRAIN stream: the companies of one split, `epochs` times, each epoch in an order the seed fixes, written as the list
// a learning pass runs (runner.mjs --list): `{ cik, ticker, epoch }` per job, in stream order.
//   node examples/learn-classify/stream.mjs --data <dir> [--set mcc] [--split train] [--epochs 1] [--seed 1] [--first <n>] [--same-order] [--exclude <file>]
// A company's place in an epoch is the order of sha256(seed:epoch:cik), so it never depends on the other companies, and
// --first keeps the first n of epoch 1 in every epoch. --same-order runs every epoch in epoch 1's order. --exclude holds
// out a list of `{ cik }` (a replay bank) from every epoch; the others keep their places. With --set mcc the jobs are the
// data's merchants.json, each keyed by its id as `cik` (and a bank may list `{ id }`).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const rank = (seed, epoch, cik) => createHash('sha256').update(`${seed}:${epoch}:${cik}`).digest('hex');
const orderOf = (companies, seed, epoch) => [...companies].sort((a, b) => rank(seed, epoch, a.cik).localeCompare(rank(seed, epoch, b.cik)));

export function streamOf(companies, { split = 'train', epochs = 1, seed = 1, reshuffle = true, first, exclude = [] } = {}) {
  if (split === 'test') throw new Error('the test split is opened once per finalist, never streamed');
  if (!(Number.isInteger(epochs) && epochs >= 1)) throw new Error('epochs is a whole number from 1');
  const held = new Set(exclude.map((e) => String(e?.cik ?? e?.id ?? e)));
  // A company of another split (a bank given its own) is already out of the stream; one the set lacks is a mistake.
  for (const cik of held) if (!companies.some((c) => c.cik === cik)) throw new Error(`${cik} is not a company of the set`);
  const pool = companies.filter((c) => c.split === split && !held.has(c.cik));
  if (!pool.length) throw new Error(`no company is in the ${split} split`);
  const chosen = new Set(orderOf(pool, seed, 1).slice(0, first ?? pool.length).map((c) => c.cik));
  const kept = pool.filter((c) => chosen.has(c.cik));
  return Array.from({ length: epochs }, (_, i) => i + 1).flatMap((epoch) => orderOf(kept, seed, reshuffle ? epoch : 1)
    .map((c) => ({ cik: c.cik, ...(c.ticker ? { ticker: c.ticker } : {}), epoch })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'usage: node examples/learn-classify/stream.mjs --data <dir> [--set mcc] [--split train] [--epochs 1] [--seed 1] [--first <n>] [--same-order] [--exclude <file>]';
  let values;
  try {
    ({ values } = parseArgs({ options: { data: { type: 'string' }, set: { type: 'string' }, split: { type: 'string' }, epochs: { type: 'string' }, seed: { type: 'string' }, first: { type: 'string' }, 'same-order': { type: 'boolean' }, exclude: { type: 'string' } } }));
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    process.exit(2);
  }
  const whole = (name, fallback) => {
    if (values[name] === undefined) return fallback;
    const n = Number(values[name]);
    if (!(Number.isInteger(n) && n >= 1)) { console.error(`--${name} is a whole number from 1\n${usage}`); process.exit(2); }
    return n;
  };
  if (!values.data || (values.set !== undefined && values.set !== 'mcc')) { console.error(usage); process.exit(2); }
  try {
    const companies = values.set === 'mcc'
      ? JSON.parse(readFileSync(join(resolve(values.data), 'merchants.json'), 'utf8')).map((m) => ({ cik: m.id, split: m.split }))
      : JSON.parse(readFileSync(join(resolve(values.data), 'companies-v4.json'), 'utf8'));
    const exclude = values.exclude ? JSON.parse(readFileSync(resolve(values.exclude), 'utf8')) : [];
    const stream = streamOf(companies, { split: values.split ?? 'train', epochs: whole('epochs', 1), seed: whole('seed', 1), first: whole('first', undefined), reshuffle: !values['same-order'], exclude });
    process.stdout.write(`${JSON.stringify(stream, null, 1)}\n`);
  } catch (error) {
    console.error(`stream: ${error.message}`);
    process.exit(2);
  }
}
