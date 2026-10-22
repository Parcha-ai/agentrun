#!/usr/bin/env node
// The adjudication pass (learn-mcc's ADJUDICATION.md): one run per merchant of the sealed DEV sample, by learn-mcc's
// adjudicator home (SETS.adjudicate), at the seed, with nothing proposed or learned. A run gets the merchant's name and
// website; its host tools `site` and `codes` (adjudicate-job.mjs) record stage 1 before any candidate is shown, then give
// the merchant's candidates (adjudication.mjs candidates: the teacher's and the arms' codes, each once, salted, no source).
// Each verdict's stage 1 and stage 2 go to <out>/adjudication/<passId>/stage1.json and stage2.json for adjudication.mjs
// unblind; each attempt adds a line to manifest.jsonl, with its cost, its grounding and its recording. A verdict whose
// evidence does not ground (SPEC.md's grounding) is judged once more, and the pass reports the ones that still do not.
// meta.json pins, before the first verdict, the sha256 of the sample's commitments, the order salt, the candidates, the
// sample file and the adjudicator home; a resumed pass with any of them changed is refused. A live pass first runs its
// self-test (selftest.mjs adjudicationSelfTest) at $0.
//   node examples/learn-classify/eval-adjudicate.mjs --out <dir> --pass-id <id> --sample <adjudication.json>
//       --candidates <candidates.json> --commitments <commitments.json> --order-salt <file>
//       (--scripted | --live --cap-usd <usd>) [--run-cap-usd <usd>] [--data <dir>] [--concurrency <n>] [--jobs <n>]
//       [--model claude-opus-5-5] [--thinking high]
import { AGENT_STORE_FILE, carryBack, createAgentHome, openAgentHome, runPaths } from '@parcha/pi-durable-agent';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { adjudicationGrounding, adjudicationRun, sampleJobs } from './adjudicate-job.mjs';
import { finishJob, meteredJudge, prepareRun, readAgentAt, runJob, toolResultsOf, toolStats } from './host.mjs';
import { mccLookupRefusalsOf } from './mcc.mjs';
import { writeRecording } from './recording.mjs';
import { spendOf } from './row.mjs';
import { liveParts, openOut, scriptedParts } from './runner.mjs';
import { adjudicationSelfTest } from './selftest.mjs';
import { SETS } from './sets.mjs';

const HOST = 'learn-classify-adjudicate';
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (file) => sha256(readFileSync(file));

/** One step on the home, the repository or the verdict files at a time; the runs themselves go on side by side. */
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

/** A JSON file written whole: to a temporary name, then renamed over its own. */
function writeWhole(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** What a pass pins before its first verdict: the sha256 of each input file it reads or that fixed what it reads. */
function pinsOf({ sample, candidates, commitments, orderSalt, agentSha256 }) {
  return {
    sample: { sha256: fileSha(sample) },
    candidates: { sha256: fileSha(candidates) },
    commitments: { sha256: fileSha(commitments) },
    orderSalt: { sha256: fileSha(orderSalt) },
    adjudicator: { sha256: agentSha256 },
  };
}

/**
 * The adjudication pass over `sample` (the sealed rows) with `candidates` (merchant id to `[{ code, title }]`). Each
 * merchant without a stage 1 is judged; one judged before is never judged again under that pass id. `files` names the
 * sample, candidates, commitments and order-salt files, whose sha256 meta.json pins; the sample's commitments file must
 * hold one commitment per sample row, by order.
 */
export async function runAdjudication({ out, parts, passId, files, concurrency = 1, jobs, capUsd, runCapUsd, log = () => {} }) {
  if (parts.set !== SETS.adjudicate) throw new Error('an adjudication pass takes the adjudicate set');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(passId ?? '')) throw new Error('passId is a plain name');
  for (const key of ['sample', 'candidates', 'commitments', 'orderSalt']) if (!files?.[key] || !existsSync(files[key])) throw new Error(`the pass needs the ${key} file`);
  out = resolve(out);
  const sample = readJson(files.sample);
  const candidates = readJson(files.candidates);
  const commitments = readJson(files.commitments);
  const orders = (commitments.commitments ?? []).map((c) => c.order).sort((a, b) => a - b);
  const sampleOrders = sample.map((m) => m.order).sort((a, b) => a - b);
  if (orders.length !== sample.length || orders.some((o, i) => o !== sampleOrders[i])) throw new Error('the commitments do not hold one commitment per sample row, by order');
  const jobsAll = sampleJobs(sample);
  for (const job of jobsAll) if (!Array.isArray(candidates[job.merchantId])) throw new Error(`the candidates have no list for ${job.merchantId}`);

  const { repo, meta } = await openOut(out, { mode: parts.mode, set: parts.set });
  const dir = join(out, 'adjudication', passId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pins = pinsOf({ ...files, agentSha256: meta.agentSha256 });
  const metaPath = join(dir, 'meta.json');
  if (existsSync(metaPath)) {
    const held = readJson(metaPath).pins;
    const moved = Object.keys(pins).filter((k) => held?.[k]?.sha256 !== pins[k].sha256);
    if (moved.length) throw new Error(`pass ${passId} was pinned with other inputs (${moved.join(', ')}); a changed input is a new pass id`);
  } else {
    writeWhole(metaPath, { passId, mode: parts.mode, model: parts.modelName, seedSha: meta.seedSha, pins, merchants: jobsAll.length, created: new Date().toISOString() });
  }
  const stage1Path = join(dir, 'stage1.json');
  const stage2Path = join(dir, 'stage2.json');
  const manifestPath = join(dir, 'manifest.jsonl');
  const stage1 = existsSync(stage1Path) ? readJson(stage1Path) : {};
  const stage2 = existsSync(stage2Path) ? readJson(stage2Path) : {};
  const pending = jobsAll.filter((job) => !stage1[job.merchantId]).slice(0, jobs ?? Infinity);
  const home = await homeAt(join(out, 'adjudicate-home'), repo, meta.seedSha);
  log(`learn-classify adjudication ${passId}: ${pending.length} of ${jobsAll.length} sample merchants to judge at the seed ${meta.seedSha.slice(0, 7)}${concurrency > 1 ? `, ${concurrency} at once` : ''}`);
  if (pending.length && parts.mode === 'live') {
    const [job] = pending;
    await adjudicationSelfTest({ out, repo, parts, job, adjudicator: adjudicationRun({ candidates: candidates[job.merchantId], groups: parts.data.table }), log });
  }
  const lock = concurrency > 1 ? serial() : (step) => step();
  let spent = readLines(manifestPath).reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const judged = [];
  const failed = [];
  const ungrounded = [];
  let stoppedBy = null;

  /** One run of a merchant: a fresh adjudicator over its candidates, recorded and costed, its verdict checked for grounding. */
  const attempt = async (job, rerunOf) => {
    const prepared = await lock(async () => {
      let n = 1;
      const idOf = (k) => `adjudicate-${job.merchantId}${k === 1 ? '' : `-a${k}`}`;
      while (existsSync(runPaths(home, idOf(n)).dir)) {
        await carryBack(home, { runId: idOf(n) }, { outcome: 'abandoned' }).catch(() => {});
        n += 1;
      }
      return prepareRun({ home, repo, host: HOST, runId: idOf(n), input: parts.set.input(job), ref: meta.seedSha });
    });
    const run = { runId: prepared.runId, ...runPaths(home, prepared.runId) };
    const adjudicator = adjudicationRun({ candidates: candidates[job.merchantId], groups: parts.data.table });
    const effects = [...(await parts.toolsFor(job, prepared)), ...parts.set.labelTools(parts.data), ...adjudicator.tools];
    const model = await parts.modelFor(job, prepared);
    const started = Date.now();
    let measure;
    try {
      measure = await runJob({ run: prepared, job, model, judge: meteredJudge(parts.judge()), effects, answer: adjudicator.answer, text: parts.set.text, limitUsd: runCapUsd, learning: false });
    } finally {
      await Promise.all(effects.map((effect) => effect.dispose?.()));
    }
    await lock(() => finishJob({ home, repo, run, job, measure, propose: false }));
    const ended = Date.now();
    const stats = toolStats(toolResultsOf(run.storePath));
    const spend = spendOf(measure, undefined, [stats.browserCostUsd, stats.searchCostUsd, stats.documentCostUsd]);
    const recording = await writeRecording({ into: join(dir, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started, ended, spend, modelUsd: measure.unpricedAnswers ? null : measure.usage.costUsd });
    const lines = recordingLines(run.storePath).lines;
    const recorded = measure.answer ? adjudicator.record(measure.answer) : null;
    const grounding = recorded ? adjudicationGrounding(lines, recorded, job) : null;
    const line = {
      merchantId: job.merchantId, runId: prepared.runId, rerunOf: rerunOf ?? null, ok: Boolean(recorded), reason: recorded ? null : measure.stopped ?? measure.reason ?? measure.status ?? 'no answer',
      unjudgeable: recorded?.stage1.unjudgeable ? true : undefined, grounded: grounding?.grounded ?? null, ungrounded: grounding?.ungrounded ?? [],
      mccLookupRefused: mccLookupRefusalsOf(lines), costUsd: spend.costUsd, model: parts.modelName, thinking: model?.agent?.thinkingLevel ?? null,
      start: new Date(started).toISOString(), end: new Date(ended).toISOString(), recording: recording ? join('recordings', prepared.runId) : null,
    };
    spent += spend.knownUsd ?? spend.costUsd ?? 0;
    await lock(() => appendFileSync(manifestPath, `${JSON.stringify(line)}\n`));
    return { recorded, grounding, line };
  };

  const one = async (job) => {
    let result = await attempt(job);
    // A run with no verdict, or a verdict whose evidence does not ground, is judged once more; the second stands.
    if (!result.recorded || result.grounding.grounded === false) {
      log(`  ${job.merchantId}: ${result.recorded ? `evidence does not ground (${result.grounding.ungrounded.join(', ')})` : `no verdict (${result.line.reason})`}: judging it once more`);
      result = await attempt(job, result.line.runId);
    }
    if (!result.recorded) {
      failed.push(job.merchantId);
      log(`  ${job.merchantId}: no verdict`);
      return;
    }
    if (result.grounding.grounded === false) ungrounded.push({ merchantId: job.merchantId, ungrounded: result.grounding.ungrounded });
    await lock(() => {
      stage1[job.merchantId] = result.recorded.stage1;
      stage2[job.merchantId] = result.recorded.stage2;
      writeWhole(stage2Path, stage2);
      writeWhole(stage1Path, stage1);
    });
    judged.push(job.merchantId);
    log(`  ${job.merchantId}: judged${result.recorded.stage1.unjudgeable ? ' unjudgeable' : ''}${result.grounding.grounded === false ? ', evidence still not grounded' : ''} ($${(result.line.costUsd ?? 0).toFixed(4)})`);
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
  return { judged, failed, ungrounded, spentUsd: spent, stoppedBy, seedSha: meta.seedSha, pins };
}

const USAGE = 'usage: node examples/learn-classify/eval-adjudicate.mjs --out <dir> --pass-id <id> --sample <adjudication.json> --candidates <candidates.json> --commitments <commitments.json> --order-salt <file> (--scripted | --live --cap-usd <usd>) [--run-cap-usd <usd>] [--data <dir>] [--concurrency <n>] [--jobs <n>] [--model claude-opus-5-5] [--thinking high]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      out: { type: 'string' }, 'pass-id': { type: 'string' }, sample: { type: 'string' }, candidates: { type: 'string' }, commitments: { type: 'string' }, 'order-salt': { type: 'string' },
      scripted: { type: 'boolean' }, live: { type: 'boolean' }, 'cap-usd': { type: 'string' }, 'run-cap-usd': { type: 'string' },
      data: { type: 'string' }, concurrency: { type: 'string' }, jobs: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' },
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
  const required = ['out', 'pass-id', 'sample', 'candidates', 'commitments', 'order-salt'];
  if (required.some((k) => !values[k]) || values.live === values.scripted || (values.live && values['cap-usd'] === undefined)) { console.error(USAGE); process.exit(2); }
  if (values.thinking === 'off') { console.error('--thinking off is not allowed: every model call thinks'); process.exit(2); }
  try {
    const data = values.data ? { data: resolve(values.data) } : {};
    const parts = values.live
      ? await liveParts({ set: SETS.adjudicate, ...data, model: values.model ?? 'claude-opus-5-5', thinking: values.thinking ?? 'high' })
      : scriptedParts({ set: SETS.adjudicate, ...data });
    const result = await runAdjudication({
      out: values.out, parts, passId: values['pass-id'],
      files: { sample: resolve(values.sample), candidates: resolve(values.candidates), commitments: resolve(values.commitments), orderSalt: resolve(values['order-salt']) },
      concurrency: number('concurrency', true) ?? 1, jobs: number('jobs', true), capUsd: number('cap-usd'), runCapUsd: number('run-cap-usd'), log: (line) => console.log(line),
    });
    console.log(JSON.stringify({ judged: result.judged.length, failed: result.failed, ungroundedAfterRerun: result.ungrounded.length, spentUsd: Number(result.spentUsd.toFixed(4)), stoppedBy: result.stoppedBy }));
    if (result.stoppedBy) process.exitCode = 3;
  } catch (error) {
    console.error(`learn-classify adjudication failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
