#!/usr/bin/env node
// The adjudication pass (learn-mcc's ADJUDICATION.md): one run per merchant of the sealed DEV sample, by learn-mcc's
// adjudicator home (SETS.adjudicate), at the seed, with nothing proposed or learned. A run gets the merchant's name and
// website; its host tools `site` and `codes` (adjudicate-job.mjs) record stage 1 before any candidate is shown, then give
// the merchant's candidates (adjudication.mjs candidates: the teacher's and the arms' codes, each once, salted, no source).
// Each verdict's stage 1 and stage 2 go to <out>/adjudication/<passId>/stage1.json and stage2.json for adjudication.mjs
// unblind; each attempt adds a line to manifest.jsonl, with its cost, its grounding and its recording. A verdict whose
// evidence does not ground (SPEC.md's grounding) is judged once more, and the pass reports the ones that still do not.
// meta.json pins, before the first verdict, the sha256 of the sample's commitments, the order salt, the candidates, the
// sample file, the adjudicator home and the protocol (learn-mcc's ADJUDICATION.md); a resumed pass with any of them
// changed is refused. A live pass first runs its self-test (selftest.mjs adjudicationSelfTest) at $0.
// A stage-2-only pass (--stage1-from <an earlier pass's dir>) judges a later arm's codes: it reuses that pass's stage 1
// (the same sample, salt and adjudicator home, or it is refused), carries over every merchant with no new code and every
// unjudgeable one, and runs the rest with stage 1 recorded; only the codes the earlier pass never judged are merged into
// stage2.json, and the earlier codes judged again go to rejudged.json.
//   node examples/learn-classify/eval-adjudicate.mjs --out <dir> --pass-id <id> --sample <adjudication.json>
//       --candidates <candidates.json> --commitments <commitments.json> --order-salt <file>
//       (--scripted | --live --cap-usd <usd>) [--run-cap-usd <usd>] [--data <dir>] [--concurrency <n>] [--jobs <n>]
//       [--model claude-opus-5-5] [--thinking high] [--stage1-from <earlier pass dir> [--show all|new]]
import { AGENT_STORE_FILE, carryBack, createAgentHome, openAgentHome, runPaths } from '@parcha/pi-durable-agent';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { adjudicationGrounding, adjudicationRun, sampleJobs, STAGE1_RECORDED } from './adjudicate-job.mjs';
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

/** The protocol the pass follows, pinned with its inputs. */
export const PROTOCOL = join(import.meta.dirname, '..', 'learn-mcc', 'ADJUDICATION.md');

/** What a pass pins before its first verdict: the sha256 of each input file it reads or that fixed what it reads. */
function pinsOf({ sample, candidates, commitments, orderSalt, protocol = PROTOCOL, agentSha256 }) {
  return {
    sample: { sha256: fileSha(sample) },
    candidates: { sha256: fileSha(candidates) },
    commitments: { sha256: fileSha(commitments) },
    orderSalt: { sha256: fileSha(orderSalt) },
    adjudicator: { sha256: agentSha256 },
    protocol: { sha256: fileSha(protocol) },
  };
}

/** The earlier pass a stage-2-only pass reuses: its meta, stage 1 and stage 2, complete for every sample merchant, and
 *  each merchant's codes it never judged. Every code it judged must still be a candidate. */
function earlierPass(dir, jobs, candidates) {
  const paths = { meta: join(dir, 'meta.json'), stage1: join(dir, 'stage1.json'), stage2: join(dir, 'stage2.json') };
  for (const [what, path] of Object.entries(paths)) if (!existsSync(path)) throw new Error(`the earlier pass has no ${what} (${path})`);
  const earlier = { dir, paths, meta: readJson(paths.meta), stage1: readJson(paths.stage1), stage2: readJson(paths.stage2), newCodes: {} };
  for (const { merchantId: id } of jobs) {
    if (!earlier.stage1[id]) throw new Error(`the earlier pass has no stage 1 for ${id}`);
    const judged = Object.keys(earlier.stage2[id]?.codes ?? {});
    const listed = candidates[id].map((c) => c.code);
    const dropped = judged.filter((code) => !listed.includes(code));
    if (dropped.length) throw new Error(`the candidates for ${id} leave out ${dropped.join(', ')}, which the earlier pass judged: a stage-2-only pass adds codes`);
    earlier.newCodes[id] = earlier.stage1[id].unjudgeable ? [] : listed.filter((code) => !judged.includes(code));
  }
  return earlier;
}

/**
 * The adjudication pass over `sample` (the sealed rows) with `candidates` (merchant id to `[{ code, title }]`). Each
 * merchant without a stage 1 is judged; one judged before is never judged again under that pass id. `files` names the
 * sample, candidates, commitments and order-salt files, and the protocol (PROTOCOL unless named), whose sha256 meta.json
 * pins; the sample's commitments file must hold one commitment per sample row, by order. With `stage1From` (an earlier
 * pass's dir) the pass is stage-2-only; `show` is the candidates such a run is given: 'all' of the merchant's (the
 * earlier codes judged again beside the new ones) or only the 'new' ones.
 */
export async function runAdjudication({ out, parts, passId, files, concurrency = 1, jobs, capUsd, runCapUsd, stage1From, show = 'all', log = () => {} }) {
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
  if (!['all', 'new'].includes(show)) throw new Error('show is all or new');
  const earlier = stage1From ? earlierPass(resolve(stage1From), jobsAll, candidates) : null;

  const { repo, meta } = await openOut(out, { mode: parts.mode, set: parts.set });
  const dir = join(out, 'adjudication', passId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pins = pinsOf({ ...files, agentSha256: meta.agentSha256 });
  if (earlier) {
    // Stage 1 is reused only for the same merchants, blinded the same way, by the same judge.
    const other = ['sample', 'commitments', 'orderSalt', 'adjudicator'].filter((k) => earlier.meta.pins?.[k]?.sha256 !== pins[k].sha256);
    if (other.length) throw new Error(`the earlier pass ${earlier.meta.passId} was pinned with another ${other.join(', ')}: a stage-2-only pass reuses stage 1 only for the same sample, salt and adjudicator`);
    pins.stage1From = { sha256: fileSha(earlier.paths.stage1) };
    pins.stage2From = { sha256: fileSha(earlier.paths.stage2) };
  }
  const metaPath = join(dir, 'meta.json');
  if (existsSync(metaPath)) {
    const held = readJson(metaPath);
    const moved = [...new Set([...Object.keys(pins), ...Object.keys(held.pins ?? {})])].filter((k) => held.pins?.[k]?.sha256 !== pins[k]?.sha256);
    if (earlier && held.stage1From?.show !== show) moved.push('show');
    if (moved.length) throw new Error(`pass ${passId} was pinned with other inputs (${moved.join(', ')}); a changed input is a new pass id`);
  } else {
    const from = earlier ? { stage1From: { passId: earlier.meta.passId, protocol: earlier.meta.pins?.protocol?.sha256 ?? null, show } } : {};
    writeWhole(metaPath, { passId, mode: parts.mode, model: parts.modelName, seedSha: meta.seedSha, pins, merchants: jobsAll.length, ...from, created: new Date().toISOString() });
  }
  const stage1Path = join(dir, 'stage1.json');
  const stage2Path = join(dir, 'stage2.json');
  const manifestPath = join(dir, 'manifest.jsonl');
  const rejudgedPath = join(dir, 'rejudged.json');
  const stage1 = existsSync(stage1Path) ? readJson(stage1Path) : {};
  const stage2 = existsSync(stage2Path) ? readJson(stage2Path) : {};
  const rejudged = existsSync(rejudgedPath) ? readJson(rejudgedPath) : {};
  if (earlier && !existsSync(stage1Path)) {
    // Carried over without a run: an unjudgeable merchant, and one with no code the earlier pass did not judge.
    for (const { merchantId: id } of jobsAll) {
      if (earlier.newCodes[id].length) continue;
      stage1[id] = earlier.stage1[id];
      stage2[id] = earlier.stage2[id];
    }
    writeWhole(stage2Path, stage2);
    writeWhole(stage1Path, stage1);
  }
  const pending = jobsAll.filter((job) => !stage1[job.merchantId]).slice(0, jobs ?? Infinity);
  const home = await homeAt(join(out, 'adjudicate-home'), repo, meta.seedSha);
  // A run stops past the home's max_cost_usd unless the pass names its own run cap.
  const runCap = runCapUsd ?? (await readAgentAt(repo, meta.seedSha)).definition.max_cost_usd;
  log(`learn-classify adjudication ${passId}: ${pending.length} of ${jobsAll.length} sample merchants to judge at the seed ${meta.seedSha.slice(0, 7)}${earlier ? `, stage 2 only on ${earlier.meta.passId}'s stage 1 (${show} candidates shown)` : ''}, $${runCap} a run at most${concurrency > 1 ? `, ${concurrency} at once` : ''}`);
  if (pending.length && parts.mode === 'live') {
    const [job] = pending;
    await adjudicationSelfTest({ out, repo, parts, job, adjudicator: adjudicationRun({ candidates: candidates[job.merchantId], groups: parts.data.table }), log });
  }
  const lock = concurrency > 1 ? serial() : (step) => step();
  let spent = readLines(manifestPath).reduce((sum, m) => sum + (m.knownUsd ?? m.costUsd ?? 0), 0);
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
    const id = job.merchantId;
    const shown = earlier && show === 'new' ? candidates[id].filter((c) => earlier.newCodes[id].includes(c.code)) : candidates[id];
    const adjudicator = adjudicationRun({ candidates: shown, groups: parts.data.table, stage1: earlier?.stage1[id] ?? null });
    const effects = [...(await parts.toolsFor(job, prepared)), ...parts.set.labelTools(parts.data), ...adjudicator.tools];
    const text = earlier ? (j) => `${parts.set.text(j)}\n${STAGE1_RECORDED}` : parts.set.text;
    const model = await parts.modelFor(job, prepared);
    const started = Date.now();
    let measure;
    try {
      measure = await runJob({ run: prepared, job, model, judge: meteredJudge(parts.judge()), effects, answer: adjudicator.answer, text, limitUsd: runCap, learning: false });
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
    const grounding = recorded ? adjudicationGrounding(lines, recorded, job, earlier ? { codes: earlier.newCodes[id] } : {}) : null;
    const line = {
      merchantId: job.merchantId, runId: prepared.runId, rerunOf: rerunOf ?? null, ok: Boolean(recorded), reason: recorded ? null : measure.stopped ?? measure.reason ?? measure.status ?? 'no answer',
      unjudgeable: recorded?.stage1.unjudgeable ? true : undefined, grounded: grounding?.grounded ?? null, ungrounded: grounding?.ungrounded ?? [],
      // costUsd is null when a part went unpriced (a model answer the gateway did not price); knownUsd is what was priced.
      mccLookupRefused: mccLookupRefusalsOf(lines), costUsd: spend.costUsd, knownUsd: spend.knownUsd, unpriced: spend.unpriced, model: parts.modelName, thinking: model?.agent?.thinkingLevel ?? null,
      start: new Date(started).toISOString(), end: new Date(ended).toISOString(), recording: recording ? join('recordings', prepared.runId) : null,
      ...(earlier ? { stage2Only: true, newCodes: earlier.newCodes[id] } : {}),
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
      const id = job.merchantId;
      if (earlier) {
        // The earlier stage 1 and its judgments stand; the run adds the codes it never judged.
        const now = result.recorded.stage2.codes;
        const before = earlier.stage2[id]?.codes ?? {};
        stage1[id] = earlier.stage1[id];
        stage2[id] = { codes: { ...before, ...Object.fromEntries(earlier.newCodes[id].map((code) => [code, now[code]])) } };
        const again = Object.keys(before).filter((code) => now[code]);
        if (again.length) {
          rejudged[id] = Object.fromEntries(again.map((code) => [code, { earlier: before[code].acceptable, now: now[code].acceptable }]));
          writeWhole(rejudgedPath, rejudged);
        }
      } else {
        stage1[id] = result.recorded.stage1;
        stage2[id] = result.recorded.stage2;
      }
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
  const again = Object.values(rejudged).flatMap((codes) => Object.values(codes));
  const consistency = earlier ? { rejudged: again.length, same: again.filter((v) => v.earlier === v.now).length } : undefined;
  return { judged, failed, ungrounded, spentUsd: spent, stoppedBy, seedSha: meta.seedSha, pins, runCapUsd: runCap, ...(earlier ? { carried: jobsAll.length - jobsAll.filter((j) => earlier.newCodes[j.merchantId].length).length, consistency } : {}) };
}

const USAGE = 'usage: node examples/learn-classify/eval-adjudicate.mjs --out <dir> --pass-id <id> --sample <adjudication.json> --candidates <candidates.json> --commitments <commitments.json> --order-salt <file> (--scripted | --live --cap-usd <usd>) [--run-cap-usd <usd>] [--data <dir>] [--concurrency <n>] [--jobs <n>] [--model claude-opus-5-5] [--thinking high] [--stage1-from <earlier pass dir> [--show all|new]]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      out: { type: 'string' }, 'pass-id': { type: 'string' }, sample: { type: 'string' }, candidates: { type: 'string' }, commitments: { type: 'string' }, 'order-salt': { type: 'string' },
      scripted: { type: 'boolean' }, live: { type: 'boolean' }, 'cap-usd': { type: 'string' }, 'run-cap-usd': { type: 'string' },
      data: { type: 'string' }, concurrency: { type: 'string' }, jobs: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' },
      'stage1-from': { type: 'string' }, show: { type: 'string' },
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
  if (values.show !== undefined && (!values['stage1-from'] || !['all', 'new'].includes(values.show))) { console.error(`--show is all or new, with --stage1-from\n${USAGE}`); process.exit(2); }
  try {
    const data = values.data ? { data: resolve(values.data) } : {};
    const parts = values.live
      ? await liveParts({ set: SETS.adjudicate, ...data, model: values.model ?? 'claude-opus-5-5', thinking: values.thinking ?? 'high' })
      : scriptedParts({ set: SETS.adjudicate, ...data });
    const result = await runAdjudication({
      out: values.out, parts, passId: values['pass-id'],
      files: { sample: resolve(values.sample), candidates: resolve(values.candidates), commitments: resolve(values.commitments), orderSalt: resolve(values['order-salt']) },
      concurrency: number('concurrency', true) ?? 1, jobs: number('jobs', true), capUsd: number('cap-usd'), runCapUsd: number('run-cap-usd'),
      ...(values['stage1-from'] ? { stage1From: resolve(values['stage1-from']), show: values.show ?? 'all' } : {}), log: (line) => console.log(line),
    });
    console.log(JSON.stringify({ judged: result.judged.length, failed: result.failed, ungroundedAfterRerun: result.ungrounded.length, spentUsd: Number(result.spentUsd.toFixed(4)), stoppedBy: result.stoppedBy, ...(result.consistency ? { carried: result.carried, consistency: result.consistency } : {}) }));
    if (result.stoppedBy) process.exitCode = 3;
  } catch (error) {
    console.error(`learn-classify adjudication failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
