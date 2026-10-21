// The promotion gate of the learning redesign's ARM A ("learn-open"). A trial that pi-agent-learn's uses would promote is
// promoted only when it does better than the revision serving its name on a replay bank of TRAIN companies that the host
// runs alone (never the agent), each part scored against truth by a ±1 utility: +1 right, -1 wrong, 0 no answer (the
// agent would do that job), so a silent wrong answer costs what a right one earns:
// - With a revision serving (the trial's last proven one, which dispatch.mjs serves while it is on trial), the paired
//   difference, candidate minus serving over every scored part of every bank company, must have a 95% lower bound above 0.
// - With none (a first promotion), the share of bank companies the candidate gets right in every scored part must have a
//   Wilson 95% lower bound above the floor.
// The gate never stops the stream: asked when curate would promote, it queues the comparison and the trial stays a trial,
// the serving revision serving, until the verdict lands; the next curate applies it. A bank run is kept per (revision
// digest, company), so a revision runs on a bank company once per pass, and a verdict once landed answers at once.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyDecision, currentRevision, parseTrial, promotionDecision, readTrial, renderTrial, trialPath } from '@parcha/pi-agent-learn';
import { lastProven, recordedWorkflow } from './dispatch.mjs';

/** Pre-registered 2026-10-21 22:32Z (section 1 of the design, §1.6, the TL's rulings): the parts `correct` counts, valued by
 *  the ±1 utility; the bootstrap; the first promotion's floor; and the bank runs in flight at once (the slots the cell's
 *  schedule keeps for the gate under its ceiling of 48). */
export const GATE = Object.freeze({ parts: Object.freeze(['sic4', 'segments', 'hq']), resamples: 10_000, seed: 20261021, floor: 0.5, concurrency: 8 });
const Z = 1.959963984540054;

/** A bank run's scored parts (scoreV4's score): 1 right, 0 wrong, null where the company has no truth for it. */
export const partsOf = (score) => ({
  sic4: score.sicCorrect4 ? 1 : 0,
  segments: score.segmentsF1 === null ? null : score.segmentsF1 >= 0.8 ? 1 : 0,
  hq: score.hqCorrect === null ? null : score.hqCorrect ? 1 : 0,
});

/** A bank run's value per part, the ±1 utility: +1 right, -1 wrong, 0 when the host gave no answer (it escalated, failed,
 *  or does not take the input), null where the company has no truth for the part. */
export const valuesOf = ({ answered, parts }) => Object.fromEntries(Object.entries(parts).map(([part, right]) => [part, right === null ? null : !answered ? 0 : right ? 1 : -1]));

/** Wilson score interval, 95%, as lanes/C1/ci.py computes it. */
export function wilson(k, n) {
  if (!n) return { p: null, lo: null, hi: null };
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / d;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** mulberry32: the bootstrap's seeded draws, so a verdict rebuilds the same. */
function draws(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The paired difference over company x part, from per-company `{ d, m }` (the sum of candidate minus serving over the
 * company's `m` scored parts), with a percentile 95% interval from a bootstrap that resamples companies, so a company's
 * parts move together.
 */
export function pairedDifference(pairs, { resamples = GATE.resamples, seed = GATE.seed } = {}) {
  const scored = pairs.filter((p) => p.m > 0);
  const cells = scored.reduce((sum, p) => sum + p.m, 0);
  if (!cells) return { companies: 0, cells: 0, diff: null, lo: null, hi: null };
  const next = draws(seed);
  const boots = [];
  for (let r = 0; r < resamples; r += 1) {
    let d = 0;
    let m = 0;
    for (let i = 0; i < scored.length; i += 1) {
      const p = scored[Math.floor(next() * scored.length)];
      d += p.d;
      m += p.m;
    }
    boots.push(d / m);
  }
  boots.sort((a, b) => a - b);
  return { companies: scored.length, cells, diff: scored.reduce((sum, p) => sum + p.d, 0) / cells, lo: boots[Math.floor(0.025 * resamples)], hi: boots[Math.floor(0.975 * resamples) - 1] };
}

const fixed = (x) => (x === null ? 'none' : x.toFixed(3));

/** The verdict from the bank's values per company (`Map` cik to `valuesOf`): `serving` null is a first promotion, where a
 *  company counts as right when every part with truth is. */
export function verdictOf({ bank, candidate, serving, floor = GATE.floor, resamples, seed }) {
  if (!serving) {
    const k = bank.filter((c) => GATE.parts.every((part) => candidate.get(c.cik)[part] === null || candidate.get(c.cik)[part] === 1)).length;
    const w = wilson(k, bank.length);
    const promote = w.lo > floor;
    return { promote, first: true, k, n: bank.length, lo: w.lo, hi: w.hi, floor, reason: `first promotion: right on ${k} of ${bank.length} bank companies, Wilson lower bound ${fixed(w.lo)} ${promote ? 'above' : 'not above'} the floor ${floor}` };
  }
  const pairs = bank.map((c) => {
    const a = candidate.get(c.cik);
    const b = serving.get(c.cik);
    const parts = GATE.parts.filter((part) => a[part] !== null && b[part] !== null);
    return { d: parts.reduce((sum, part) => sum + a[part] - b[part], 0), m: parts.length };
  });
  const paired = pairedDifference(pairs, { ...(resamples ? { resamples } : {}), ...(seed !== undefined ? { seed } : {}) });
  const promote = paired.lo !== null && paired.lo > 0;
  return { promote, first: false, ...paired, reason: `±1 utility, candidate minus serving ${fixed(paired.diff)} over ${paired.cells} parts of ${paired.companies} bank companies, 95% CI [${fixed(paired.lo)}, ${fixed(paired.hi)}]: lower bound ${promote ? 'above' : 'not above'} 0` };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.pending`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.pending`, file);
};
const bankFile = (dir, sha256, cik) => join(dir, 'bank', sha256, `${cik}.json`);
const verdictFile = (dir, key) => join(dir, 'verdicts', `${key}.json`);
const keyOf = (name, candidate, serving) => `${name}/${candidate}-${serving ?? 'first'}`;

/** What the gate's bank runs under `dir` have cost, as far as it is known. */
export function gateSpend(dir) {
  const bank = join(dir, 'bank');
  if (!existsSync(bank)) return 0;
  return readdirSync(bank).flatMap((rev) => readdirSync(join(bank, rev)).filter((f) => f.endsWith('.json')).map((f) => readJson(join(bank, rev, f))?.costUsd ?? 0))
    .reduce((sum, usd) => sum + usd, 0);
}

/**
 * One comparison on the bank, to its verdict. `bank` is the bank's companies (truth rows); `runOne({ name, sha256,
 * workflow, company, main })` runs one revision on one company by the host alone and returns `{ outcome, score, costUsd }`,
 * `score` being scoreV4's and `outcome` the host's run's (only `complete` is an answer). A run that throws is not kept, and
 * while any did the verdict is a hold with `failed`. Under `dir` go the bank runs (bank/<digest>/<cik>.json) and every
 * verdict (verdicts.jsonl).
 */
export function replayGate({ bank, runOne, dir, concurrency = GATE.concurrency, floor = GATE.floor, log = () => {} }) {
  if (!bank.length) throw new Error('the promotion gate needs a bank of companies');
  return async ({ name, candidate, serving, main }) => {
    const revisions = serving ? [candidate, serving] : [candidate];
    const values = new Map(revisions.map((r) => [r.sha256, new Map()]));
    const todo = [];
    for (const revision of revisions) {
      for (const company of bank) {
        const kept = readJson(bankFile(dir, revision.sha256, company.cik));
        if (kept) values.get(revision.sha256).set(company.cik, valuesOf(kept));
        else todo.push({ revision, company });
      }
    }
    const failed = [];
    let costUsd = 0;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const { revision, company } = todo[next++];
        try {
          const result = await runOne({ name, sha256: revision.sha256, workflow: revision.workflow, company, main });
          const record = { revision: revision.sha256, cik: company.cik, outcome: result.outcome, answered: result.outcome === 'complete', parts: partsOf(result.score), costUsd: result.costUsd ?? null, at: new Date().toISOString() };
          writeJson(bankFile(dir, revision.sha256, company.cik), record);
          values.get(revision.sha256).set(company.cik, valuesOf(record));
          costUsd += record.costUsd ?? 0;
        } catch (error) {
          failed.push(`${company.cik}: ${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
    const verdict = failed.length
      ? { promote: false, reason: `${failed.length} bank run(s) failed, so nothing was compared; they run again at the next ask`, failed }
      : verdictOf({ bank, candidate: values.get(candidate.sha256), serving: serving ? values.get(serving.sha256) : null, floor });
    const line = { at: new Date().toISOString(), name, candidate: candidate.sha256, serving: serving?.sha256 ?? null, main, bank: bank.length, concurrency, ran: todo.length - failed.length, kept: bank.length * revisions.length - todo.length, costUsd, ...verdict };
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'verdicts.jsonl'), `${JSON.stringify(line)}\n`);
    log(`  promotion gate on ${name} ${candidate.sha256.slice(0, 8)}${serving ? ` vs ${serving.sha256.slice(0, 8)}` : ''}: ${verdict.promote ? 'passes' : 'holds'}; ${verdict.reason} (${line.ran} bank runs, ${line.kept} kept)`);
    return line;
  };
}

/**
 * The gate as `gatedSettler` asks it, off the stream's path. `ask` answers at once: the landed verdict for that candidate
 * over that serving revision, or that its comparison (`replayGate`) is running or queued, asking queuing it. One comparison
 * runs at a time, in the background, never under the pass's repository lock (the bank runs have their own clone and home),
 * and a name has at most one queued, its newest candidate. A verdict lands in <dir>/verdicts/<name>/<candidate>-<serving or
 * first>.json once every bank run finished: a crash or a failed run lands nothing, the trial stays a trial, and the next ask
 * runs only what is missing. `apply` is the next curate's step, under the lock: each landed verdict is reported once, and
 * a promotion that still holds on main is committed there.
 */
export function asyncGate({ bank, runOne, dir, concurrency, floor, log = () => {} }) {
  const compare = replayGate({ bank, runOne, dir, ...(concurrency ? { concurrency } : {}), ...(floor === undefined ? {} : { floor }), log });
  const queued = new Map();
  let running = null;
  const pump = () => {
    if (running || !queued.size) return;
    const [name, job] = queued.entries().next().value;
    queued.delete(name);
    const done = compare(job)
      .then((line) => { if (!line.failed) writeJson(verdictFile(dir, job.key), { ...line, key: job.key }); },
        (error) => log(`  promotion gate on ${name}: ${String(error?.message ?? error).slice(0, 200)}; no verdict`))
      .finally(() => { running = null; pump(); });
    running = { key: job.key, done };
  };
  return {
    ask({ name, candidate, serving, main }) {
      const key = keyOf(name, candidate.sha256, serving?.sha256);
      const landed = readJson(verdictFile(dir, key));
      if (landed) return { status: 'landed', key, verdict: landed };
      if (running?.key === key) return { status: 'running', key };
      const before = queued.get(name);
      if (before && before.key !== key) log(`  promotion gate on ${name}: ${candidate.sha256.slice(0, 8)} replaces the queued ${before.candidate.sha256.slice(0, 8)}`);
      queued.set(name, { name, candidate, serving, main, key });
      pump();
      return { status: running?.key === key ? 'running' : 'queued', key };
    },
    /** Resolves when nothing is running or queued. */
    async idle() {
      while (running) await running.done;
    },
    /**
     * The landed verdicts not yet applied, each reported once as `{ name, candidate, serving, promote, applied, reason }`:
     * `promoted` (committed to main now, or promoted already at an ask), `held`, or `stale` when main's trial has moved on
     * (another live revision or serving one) or its uses no longer call for the promotion; a stale verdict still answers
     * a later ask for the same pair. `thresholds` are the pass's promotion rule.
     */
    async apply({ repo, thresholds }) {
      const root = join(dir, 'verdicts');
      if (!existsSync(root)) return [];
      const landed = readdirSync(root).flatMap((name) => readdirSync(join(root, name)).filter((f) => f.endsWith('.json')).map((f) => readJson(join(root, name, f))))
        .filter((v) => v && !v.applied).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const reported = [];
      for (const v of landed) {
        try {
          await repo.fetch();
          const main = await repo.resolve('main');
          const trial = await readTrial(repo, v.name, main).catch(() => undefined);
          const live = trial && currentRevision(trial);
          const same = live?.sha256 === v.candidate && (lastProven(trial)?.sha256 ?? null) === v.serving;
          let applied = !same ? 'stale' : live.status === 'active' ? 'promoted' : v.promote ? null : 'held';
          if (applied === null) {
            const rules = thresholds ? { thresholds } : {};
            if (promotionDecision(trial, rules).action !== 'promote') applied = 'stale';
            else {
              const promoted = applyDecision(trial, { action: 'promote', sha256: v.candidate, reason: v.reason }, new Date().toISOString());
              const commit = await repo.commitTo('main', { files: { [trialPath(v.name)]: renderTrial(promoted) }, message: `promotion gate: promote ${v.name} ${v.candidate.slice(0, 12)}: ${v.reason}`, parent: main });
              await repo.push(commit.sha, 'main');
              applied = 'promoted';
            }
          }
          writeJson(verdictFile(dir, v.key), { ...v, applied: { as: applied, at: new Date().toISOString(), main } });
          reported.push({ name: v.name, candidate: v.candidate, serving: v.serving, promote: v.promote, applied, reason: v.reason });
          log(`  promotion gate on ${v.name} ${v.candidate.slice(0, 8)}: verdict ${applied}`);
        } catch (error) {
          log(`  promotion gate on ${v.name} ${v.candidate.slice(0, 8)}: not applied yet (${String(error?.message ?? error).slice(0, 200)})`);
        }
      }
      return reported;
    },
  };
}

const useKey = (use) => `${use.run}\n${use.sha256}`;

/**
 * The folded trial `after` with the promotion of `sha256` undone: the revision back on trial as it stood in `before`
 * (main's trial), its standing starting where it did, counted among the uses `after` kept, and the trial's own status
 * back. Every use stays folded.
 */
export function undoPromotion(before, after, sha256) {
  const was = before.revisions.find((r) => r.sha256 === sha256);
  const prefix = new Set(before.uses.slice(0, was.after).map(useKey));
  const kept = after.uses.filter((use) => prefix.has(useKey(use))).length;
  return { ...after, status: before.status, revisions: after.revisions.map((r) => (r.sha256 === sha256 ? { ...was, after: kept } : r)) };
}

/**
 * The `settleUses` port with the gate on promotion. `settle` (pi-agent-learn's usesSettler) folds the run's uses as it
 * always does; each promotion it decides is asked of `gate` (`asyncGate`). It stands only on a landed verdict that passes
 * it; one held, still on the bank, or that cannot be asked is undone (`undoPromotion`) and becomes a hold that says why.
 * Demotions and holds pass as they are.
 */
export function gatedSettler({ settle, gate }) {
  return async (input) => {
    const result = await settle(input);
    if (!result.decisions.some((d) => d.action === 'promote')) return result;
    const files = { ...result.files };
    const decisions = [];
    for (const decision of result.decisions) {
      if (decision.action !== 'promote') {
        decisions.push(decision);
        continue;
      }
      const { name } = decision;
      const path = trialPath(name);
      let before;
      let after;
      try {
        before = parseTrial(await input.read(path, input.main), name);
        after = parseTrial(files[path], name);
      } catch {
        // Nothing to undo from: the run's uses of the name are left out rather than promote unjudged.
        delete files[path];
        decisions.push({ name, action: 'hold', reason: 'promotion gate: the trial could not be read, so this run\'s uses of it were left out' });
        continue;
      }
      const live = currentRevision(before);
      const proven = lastProven(before);
      let verdict;
      try {
        const workflow = live && await recordedWorkflow(input, name, live.sha256, input.main);
        const served = proven && await recordedWorkflow(input, name, proven.sha256, input.main);
        if (!workflow) throw new Error('the candidate\'s record is not on main');
        if (proven && !served) throw new Error('the serving revision\'s record is not on main');
        const asked = await gate.ask({ name, candidate: { sha256: live.sha256, workflow }, serving: proven ? { sha256: proven.sha256, workflow: served } : null, main: input.main });
        verdict = asked.status === 'landed' ? asked.verdict : { promote: false, reason: `${asked.status === 'running' ? 'on the bank now' : 'queued for the bank'}; it stays a trial until the verdict lands` };
      } catch (error) {
        verdict = { promote: false, reason: `it could not run: ${String(error?.message ?? error).slice(0, 120)}` };
      }
      if (verdict.promote) {
        decisions.push({ ...decision, reason: `${decision.reason}; promotion gate: ${verdict.reason}` });
        continue;
      }
      files[path] = renderTrial(undoPromotion(before, after, live.sha256));
      decisions.push({ name, action: 'hold', reason: `promotion gate: ${verdict.reason}` });
    }
    return { files, decisions };
  };
}
