#!/usr/bin/env node
// The facts pass (learning redesign, section 3's replay arms): one read of each company's latest annual report by the facts
// agent (SETS.facts: facts-job.mjs's rules and answer, no code tool), at the seed, with nothing proposed or learned. Each
// company's facts are written once to <out>/facts/<passId>/<cik>.json with their meta, and every attempt adds a line to
// <out>/facts/<passId>/manifest.jsonl. A company with facts is never read again for that pass id; one without is retried.
//   node examples/learn-classify/eval-facts.mjs --out <dir> --pass-id <id> --live --cap-usd <usd> [--run-cap-usd <usd>]
//       [--data <dir>] [--split dev] [--concurrency <n>] [--jobs <n>] [--model gpt-6-luna] [--thinking low]
import { AGENT_STORE_FILE, carryBack, createAgentHome, openAgentHome, runPaths } from '@parcha/pi-durable-agent';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { finishJob, meteredJudge, prepareRun, readAgentAt, runJob } from './host.mjs';
import { liveParts, openOut, splitOf } from './runner.mjs';
import { passSelfTest } from './selftest.mjs';
import { SETS } from './sets.mjs';

const HOST = 'learn-classify-facts';
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** One step on the home or the repository at a time; the runs themselves go on side by side. */
function serial() {
  let last = Promise.resolve();
  return (step) => {
    const next = last.then(step, step);
    last = next.catch(() => {});
    return next;
  };
}

async function homeAt(dir, repo, sha) {
  if (existsSync(join(dir, AGENT_STORE_FILE))) return openAgentHome(dir);
  const { definition, skills } = await readAgentAt(repo, sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return createAgentHome(dir, { definition, skills, sha });
}

/** The facts of `split`'s companies (by CIK; `jobs` caps this call), `concurrency` at once, until `capUsd` is spent. */
export async function runFacts({ out, parts, passId, split = 'dev', concurrency = 1, jobs, capUsd, runCapUsd, log = () => {} }) {
  if (parts.set !== SETS.facts) throw new Error('a facts pass takes the facts set');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(passId ?? '')) throw new Error('passId is a plain name');
  out = resolve(out);
  const { repo, meta } = await openOut(out, { mode: parts.mode, set: parts.set });
  const dir = join(out, 'facts', passId);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.jsonl');
  const fileOf = (cik) => join(dir, `${cik}.json`);
  const pending = splitOf(parts.companies, split).sort((a, b) => a.cik.localeCompare(b.cik)).filter((c) => !existsSync(fileOf(c.cik))).slice(0, jobs ?? Infinity);
  const home = await homeAt(join(out, 'facts-home'), repo, meta.seedSha);
  log(`learn-classify facts ${passId}: ${pending.length} companies of ${split} at the seed ${meta.seedSha.slice(0, 7)}${concurrency > 1 ? `, ${concurrency} at once` : ''}`);
  if (pending.length && parts.mode === 'live') await passSelfTest({ out, repo, parts, log });
  const lock = concurrency > 1 ? serial() : (step) => step();
  let spent = readLines(manifestPath).reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const written = [];
  const failed = [];
  let stoppedBy = null;
  const one = async (job) => {
    const prepared = await lock(async () => {
      let attempt = 1;
      const idOf = (n) => `facts-${job.cik}${n === 1 ? '' : `-a${n}`}`;
      while (existsSync(runPaths(home, idOf(attempt)).dir)) {
        await carryBack(home, { runId: idOf(attempt) }, { outcome: 'abandoned' }).catch(() => {});
        attempt += 1;
      }
      return prepareRun({ home, repo, host: HOST, runId: idOf(attempt), input: parts.set.input(job), ref: meta.seedSha });
    });
    const run = { runId: prepared.runId, ...runPaths(home, prepared.runId) };
    const effects = [...(await parts.toolsFor(job, prepared)), ...parts.set.labelTools(parts.data)];
    const model = await parts.modelFor(job, prepared);
    const start = new Date().toISOString();
    let measure;
    try {
      measure = await runJob({ run: prepared, job, model, judge: meteredJudge(parts.judge()), effects, answer: parts.set.answer(parts.data), text: parts.set.text, limitUsd: runCapUsd });
    } finally {
      await Promise.all(effects.map((effect) => effect.dispose?.()));
    }
    await lock(() => finishJob({ home, repo, run, job, measure, propose: false }));
    const end = new Date().toISOString();
    const costUsd = measure.unpricedAnswers ? null : measure.usage?.costUsd ?? null;
    spent += costUsd ?? 0;
    const facts = measure.answer;
    if (!facts) {
      appendFileSync(manifestPath, `${JSON.stringify({ cik: job.cik, ticker: job.ticker ?? null, ok: false, reason: measure.stopped ?? measure.reason ?? measure.status ?? 'no answer', runId: prepared.runId, costUsd, start, end })}\n`);
      failed.push(job.cik);
      log(`  ${job.cik} ${job.ticker ?? ''}: no facts (${measure.stopped ?? measure.reason ?? measure.status ?? 'no answer'})`);
      return;
    }
    const body = `${JSON.stringify({
      facts,
      meta: {
        passId, cik: job.cik, ticker: job.ticker ?? null, name: job.name, model: parts.modelName, thinking: model?.agent?.thinkingLevel ?? null,
        costUsd, start, end, runId: prepared.runId, seedSha: meta.seedSha,
        sha256: Object.fromEntries(Object.entries(facts).map(([field, value]) => [field, sha256(JSON.stringify(value))])),
      },
    }, null, 2)}\n`;
    writeFileSync(`${fileOf(job.cik)}.tmp`, body);
    renameSync(`${fileOf(job.cik)}.tmp`, fileOf(job.cik));
    appendFileSync(manifestPath, `${JSON.stringify({ cik: job.cik, ticker: job.ticker ?? null, ok: true, file: `${job.cik}.json`, sha256: sha256(body), costUsd, start, end })}\n`);
    written.push(job.cik);
    log(`  ${job.cik} ${job.ticker ?? ''}: facts written ($${(costUsd ?? 0).toFixed(4)})`);
  };
  let next = 0;
  const worker = async () => {
    while (next < pending.length && !stoppedBy) {
      if (capUsd !== undefined && spent >= capUsd) { stoppedBy = `spent $${spent.toFixed(4)}, at or over the cap of $${capUsd.toFixed(4)}`; break; }
      await one(pending[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pending.length)) }, worker));
  if (stoppedBy) log(`stopped: ${stoppedBy}`);
  return { written, failed, spentUsd: spent, stoppedBy, seedSha: meta.seedSha };
}

const USAGE = 'usage: node examples/learn-classify/eval-facts.mjs --out <dir> --pass-id <id> --live --cap-usd <usd> [--run-cap-usd <usd>] [--data <dir>] [--split dev] [--concurrency <n>] [--jobs <n>] [--model gpt-6-luna] [--thinking low]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      out: { type: 'string' }, 'pass-id': { type: 'string' }, live: { type: 'boolean' }, 'cap-usd': { type: 'string' }, 'run-cap-usd': { type: 'string' },
      data: { type: 'string' }, split: { type: 'string' }, concurrency: { type: 'string' }, jobs: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' },
    } }));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const number = (name, whole) => {
    if (values[name] === undefined) return undefined;
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < (whole ? 1 : 0) || (whole && !Number.isInteger(n))) { console.error(`--${name} is not a ${whole ? 'whole number from 1' : 'non-negative number'}\n${USAGE}`); process.exit(2); }
    return n;
  };
  if (!values.out || !values['pass-id'] || !values.live || values['cap-usd'] === undefined) { console.error(USAGE); process.exit(2); }
  if (values.thinking === 'off') { console.error('--thinking off is not allowed: every model call thinks'); process.exit(2); }
  try {
    const parts = await liveParts({ set: SETS.facts, ...(values.data ? { data: resolve(values.data) } : {}), model: values.model ?? 'gpt-6-luna', thinking: values.thinking ?? 'low' });
    const result = await runFacts({
      out: values.out, parts, passId: values['pass-id'], split: values.split ?? 'dev', concurrency: number('concurrency', true) ?? 1, jobs: number('jobs', true),
      capUsd: number('cap-usd'), runCapUsd: number('run-cap-usd'), log: (line) => console.log(line),
    });
    if (result.stoppedBy) process.exitCode = 3;
  } catch (error) {
    console.error(`learn-classify facts failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
