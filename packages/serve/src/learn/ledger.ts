// The ledger: one row a run, written by its end, and one spend row a learning cost (a compile turn, a check's replay run,
// an audit's shadow run), keyed to the workflow revision it is for. record() is what a run's end writes, in the end's own
// transaction (store/sqlite/run-patch.ts); summarize() is the one reading of them, which GET /agents/{id}/learning/cost,
// GET /runs/{id}'s cost and the money rule (runner/workflow-first.ts costLineOf, over RunFigures) all take. Pure: no
// store, no clock.
import { amortize, type Bill, billOf, costSummary, type CostRun, type CostSummary, JOB_PATHS, NOT_SERVED, type NotServed, noiseOff, type RevisionSpend, RUN_PATHS, type RunPath, SERVED_PATHS, tookOverOf } from "../learning-cost.js";
import { FINAL_STATES, type RunRow } from "../store/store.js";

/** A run's own cost as its row stores it: `known`, an exact figure; `unknown`, none; `at_most`, only a bound (a request
 *  cut at its cap hold), never shown as a cost. */
export const COST_STATES = ["known", "unknown", "at_most"] as const;
export type CostState = (typeof COST_STATES)[number];

/** One ended run: who answered it (`path`, null when its end named none), the learned workflow revision that ran it
 *  (`workflow` at `digest`; for an audit's shadow, the revision it audits), why that workflow did not serve it alone,
 *  the job's own $ (`jobUsd`: what it had cost when its answer was final, its look-back left out) and everything its
 *  rounds looked back for (`lookBackUsd`: its compile turns and its follow-up rounds' turns); each null when unknown. */
export type LedgerRow = {
  readonly runId: string;
  readonly agentId: string;
  readonly startedAt: number;
  readonly path: RunPath | null;
  readonly workflow: string | null;
  readonly digest: string | null;
  readonly notServed: NotServed | null;
  readonly jobUsd: number | null;
  readonly lookBackUsd: number | null;
  readonly cost: CostState;
};

/** What a spend row paid for: a compile turn that drafted a revision (`compile`), a replay run checking one (`check`), or
 *  an audit's shadow run of a served run (`audit`). */
export const SPEND_KINDS = ["compile", "check", "audit"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

/** One learning cost: the run whose end booked it (`runId`, with its `round` for a compile turn, 0 otherwise), the run
 *  an audit's shadow audited (`ofRun`), the revision it is for (`workflow` at `digest`; a compile that kept no draft drafted
 *  none: both null; one whose drafts failed their checks, the workflow alone) and its $ (null: unknown). */
export type SpendRow = {
  readonly runId: string;
  readonly round: number;
  readonly agentId: string;
  readonly kind: SpendKind;
  readonly ofRun: string | null;
  readonly workflow: string | null;
  readonly digest: string | null;
  readonly usd: number | null;
};

/** What record() reads of an ended run: its row (its cost, the bound beside it, its metrics: the run-end classifier's
 *  path, workflow and digest, runner/workflow-first.ts pathMetrics), every round its learning kept (learning_proposals)
 *  and, for an audit's shadow run, the run its launch audits (`auditOf`: its end may name no audit, when it failed first).
 *  `learns`: whether its launch learns (learnsOfLaunch); false, an end that named no path is the agent's. */
export type RunEnd = {
  readonly id: string;
  readonly agentId: string;
  readonly startedAt: number;
  readonly costUsd: number | null;
  readonly costAtMostUsd: number | null;
  readonly metrics: unknown;
  readonly rounds: readonly { readonly round: number; readonly proposal: unknown }[];
  readonly auditOf?: string | null;
  readonly learns?: boolean;
};

const usdOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** RunEnd.auditOf of run `runId` from its stored launch body (`body`, undefined with none): the run its launch audits
 *  (null when it names none) for an audit's shadow run (learn/audit.ts SHADOW_PREFIX "audit."), undefined for any other. */
export const auditOfLaunch = (runId: string, body: unknown): string | null | undefined =>
  runId.startsWith("audit.") ? textOrNull(objectOf(objectOf(body).audit).of) : undefined;
/** RunEnd.learns from a run's stored launch body (`body`, undefined with none): whether it holds a learning start, as
 *  run-launch.ts learningStartOfStored reads one. No launch reads as a run that does not learn. */
export const learnsOfLaunch = (body: unknown): boolean => objectOf(body).learning !== undefined;
/** A sum of parts, null once one is unknown; 0 for none. */
const sumOf = (parts: readonly (number | null)[]): number | null => (parts.some((one) => one === null) ? null : noiseOff(parts.reduce<number>((total, one) => total + one!, 0)));

/** What a kept round says of its job as it answered (runner/reflect-hook.ts): when, what the job had cost by then, and
 *  what looking back cost after it. */
export type Answered = { readonly answered_at: string; readonly job_cost_usd: number | null; readonly look_back_usd: number | null };
/** A kept round's Answered; undefined for one that never answered. */
export const answeredOf = (proposal: unknown): Answered | undefined => {
  const kept = objectOf(proposal);
  return typeof kept.answered_at === "string" ? { answered_at: kept.answered_at, job_cost_usd: usdOrNull(kept.job_cost_usd), look_back_usd: usdOrNull(kept.look_back_usd) } : undefined;
};

/** A run a follow-up opened again: its job is what it had cost when its first round answered, and everything its row
 *  (`rowUsd`) spent after that (each later round's follow-up turn and every round's look-back: feedback the run was given
 *  is learning, never the job) is its look-back; unknown when the row's cost is and the job's is known (a later round
 *  stopped mid-request keeps no figures, so the rounds' sum would read short as if settled); the rounds' look-backs added
 *  up when the job's cost is unknown. The impact read (store-reads/learning.ts impactLearningOf) takes the same. */
export function roundsLooked(rounds: Answered, rowUsd: number | null): Answered {
  const after = rounds.job_cost_usd === null ? rounds.look_back_usd : rowUsd === null ? null : Math.max(0, Math.round((rowUsd - rounds.job_cost_usd) * 1e9) / 1e9);
  return { answered_at: rounds.answered_at, job_cost_usd: rounds.job_cost_usd, look_back_usd: after };
}

/** Over a run's kept rounds, oldest first: with two or more and one that answered, what they kept together (its first
 *  answer's job, every round's look-back added up, null once one is unknown); else undefined. */
export function roundsSpentIn(proposals: readonly unknown[]): Answered | undefined {
  if (proposals.length < 2) return undefined;
  let first: Answered | undefined;
  let look: number | null = 0;
  for (const proposal of proposals) {
    const answered = answeredOf(proposal);
    if (!first && answered) first = answered;
    // A round that never looked back (no figures kept) added none.
    if (answered) look = look === null || answered.look_back_usd === null ? null : look + answered.look_back_usd;
  }
  return first ? { answered_at: first.answered_at, job_cost_usd: first.job_cost_usd, look_back_usd: look } : undefined;
}

/** What a run's rounds kept as it answered, as its cost reads it: over every round (roundsLooked) for one a follow-up
 *  opened again, else its one round's; undefined for one that never answered. */
export function lookedOf(proposals: readonly unknown[], rowUsd: number | null): Answered | undefined {
  const together = roundsSpentIn(proposals);
  return together ? roundsLooked(together, rowUsd) : proposals.length ? answeredOf(proposals.at(-1)) : undefined;
}

/** The compile turns a run's rounds asked (each round's `look_back_usd`: the end-of-run step's only model turn is its
 *  compile turn), oldest first: the revision each drafted (its digest only when no draft failed its checks), none for a
 *  round that asked no turn. A turn that kept no draft (the cap stopped it, or a stop or fault ended the step after a
 *  claim asked it) drafted no revision: its workflow and digest are null. */
type Compiled = { round: number; workflow: string | null; digest: string | null; usd: number | null };
function compilesIn(rounds: readonly { readonly round: number; readonly proposal: unknown }[]): Compiled[] {
  return rounds.flatMap(({ round, proposal }): Compiled[] => {
    const kept = objectOf(proposal);
    const usd = "look_back_usd" in kept ? usdOrNull(kept.look_back_usd) : 0;
    const compiled = objectOf(kept.compiled);
    if (typeof compiled.workflow !== "string") return usd === 0 ? [] : [{ round, workflow: null, digest: null, usd }];
    const failed = Array.isArray(kept.draft_errors) && kept.draft_errors.some((one) => typeof one === "string");
    const digest = typeof compiled.digest === "string" && /^[0-9a-f]{16}$/.test(compiled.digest) && !failed ? compiled.digest : null;
    return [{ round, workflow: compiled.workflow, digest, usd }];
  });
}

/** The ledger row and spend rows a run's end writes, from its row and its kept rounds (RunEnd). The job's own $ is its
 *  row's cost less every look-back, never under what it had cost when it answered (a later turn's spend is the job's
 *  too); its row's cost for a run that did not look back. Its compile turns are spend rows of the revision each drafted.
 *  A replay run's cost is its revision's check, and an audit's shadow run's the run it audits: a spend row each, beside
 *  its own ledger row. */
export function record(end: RunEnd): { row: LedgerRow; spend: SpendRow[] } {
  const metrics = objectOf(end.metrics);
  const cost: CostState = typeof end.costAtMostUsd === "number" ? "at_most" : end.costUsd === null ? "unknown" : "known";
  const rowUsd = cost === "known" ? end.costUsd : null;
  const rounds = [...end.rounds].sort((a, b) => a.round - b.round);
  const looked = lookedOf(rounds.map((one) => one.proposal), rowUsd);
  const asAnswered = looked ? looked.job_cost_usd : rowUsd;
  const back = looked ? looked.look_back_usd : 0;
  // What the row holds past the answer and its look-back is a later turn's spend, unknown once the row's cost is; with the
  // look-back's cost unknown the two can't be told apart, and the job is what it had cost when it answered.
  const job = !looked || asAnswered === null || back === null ? asAnswered : rowUsd === null ? null : Math.max(asAnswered, rowUsd - back);
  const audited = metrics.path === "audit" || end.auditOf !== undefined;
  // The one by-hand rule (the window's read and Learning.byHandBefore read the row's path, each leaving a workflow
  // revision's runs out): a run whose end named no path is the agent's when its launch does not learn; one that learns
  // and named none is unknown (null).
  const named = RUN_PATHS.includes(metrics.path as RunPath) ? (metrics.path as RunPath) : null;
  const path = audited ? "audit" : named ?? (end.learns === false ? "agent" : null);
  const audit = objectOf(metrics.audit);
  const workflow = textOrNull(audited ? audit.workflow : metrics.workflow);
  const digest = textOrNull(audited ? audit.digest : metrics.workflow_digest);
  // A hand-back a restart cut (pathMetrics workflow_cut) is `cut`, never the workflow's own `back`.
  const cut = path === "handed_back" && metrics.workflow_cut === true;
  const notServed = cut ? "cut" : NOT_SERVED.includes(metrics.not_served as NotServed) ? (metrics.not_served as NotServed) : null;
  const row: LedgerRow = {
    runId: end.id, agentId: end.agentId, startedAt: end.startedAt, path, workflow, digest, notServed,
    jobUsd: job === null ? null : noiseOff(job), lookBackUsd: back === null ? null : noiseOff(back), cost,
  };
  const base = { runId: end.id, agentId: end.agentId };
  const spend: SpendRow[] = compilesIn(rounds).map((one) => ({ ...base, round: one.round, kind: "compile", ofRun: null, workflow: one.workflow, digest: one.digest, usd: one.usd }));
  if (path === "replay") spend.push({ ...base, round: 0, kind: "check", ofRun: null, workflow, digest, usd: rowUsd });
  if (audited) spend.push({ ...base, round: 0, kind: "audit", ofRun: textOrNull(audit.of) ?? end.auditOf ?? null, workflow, digest, usd: rowUsd });
  return { row, spend };
}

/** An audit's shadow run of a run, as the reader finds it: `open` while it is queued or running (its cost not known yet),
 *  `ended` once it ended, stopped or failed. A run with none has no entry. */
export type Shadow = "open" | "ended";

/** A run's figures (figuresOf), null when unknown: `series_*` are the cost series', the rest GET /runs/{id}'s. */
export type RunFigures = {
  readonly usd: number | null;
  readonly compile_usd: number | null;
  readonly followup_usd: number | null;
  readonly shadow_usd: number | null;
  readonly share_usd: number | null;
  readonly series_learning_usd: number | null;
  readonly series_total_usd: number | null;
  readonly learning_usd: number | null;
  readonly all_in_usd: number | null;
};

/** One run's figures (RunFigures) from its row and the parts the spend rows give it (its compile turns, its shadow's
 *  cost, its share): the one formula every reader of a run's cost takes. */
export function figuresOf(row: Pick<LedgerRow, "path" | "jobUsd" | "lookBackUsd">, parts: { readonly compile: number | null; readonly shadow: number | null; readonly share: number | null }): RunFigures {
  const { compile, shadow, share } = parts;
  const back = row.lookBackUsd;
  const followup = back === null || compile === null ? null : noiseOff(Math.max(0, back - compile));
  const seriesLearning = sumOf([back, shadow]);
  const learns = row.path !== "replay" && row.path !== "audit";
  const learning = learns ? sumOf([followup, shadow, share]) : 0;
  return {
    usd: row.jobUsd, compile_usd: compile, followup_usd: followup, shadow_usd: shadow, share_usd: learns ? share : 0,
    series_learning_usd: seriesLearning, series_total_usd: sumOf([row.jobUsd, seriesLearning]),
    learning_usd: learning, all_in_usd: learns ? sumOf([row.jobUsd, learning]) : 0,
  };
}

/** The spend rows read by run: each run's compile turns (null once one is unknown) and each audited run's shadow cost. */
export function spendByRun(spend: readonly SpendRow[]): { compile: Map<string, number | null>; audit: Map<string, number | null> } {
  const compile = new Map<string, number | null>();
  const audit = new Map<string, number | null>();
  const add = (map: Map<string, number | null>, key: string, usd: number | null) => map.set(key, map.has(key) ? sumOf([map.get(key)!, usd]) : usd);
  for (const one of spend) {
    if (one.kind === "compile") add(compile, one.runId, one.usd);
    else if (one.kind === "audit" && one.ofRun !== null) add(audit, one.ofRun, one.usd);
  }
  return { compile, audit };
}

/** An audit's shadow run as its cost reads: `ended` once it is final (FINAL_STATES), `usd` its cost (null while unknown
 *  or only a bound). */
export type ShadowCost = { readonly ended: boolean; readonly usd: number | null };

/** A shadow run's row as a ShadowCost. */
export const shadowOfRun = (run: Pick<RunRow, "state" | "costUsd" | "costAtMostUsd">): ShadowCost =>
  ({ ended: FINAL_STATES.includes(run.state), usd: typeof run.costAtMostUsd === "number" ? null : run.costUsd });

/** A run's shadow cost, the one rule the ledger, GET /stats and analytics read: 0 with no shadow (undefined); unknown
 *  (null) while it is queued or running, or once it ended at an unknown cost, never $0; its cost once known. */
export const shadowUsdOf = (shadow: ShadowCost | undefined): number | null => (shadow === undefined ? 0 : shadow.ended ? shadow.usd : null);

/** A run's shadow cost (shadowUsdOf) from the reader's shadows and the audit spend rows: an ended shadow costs its
 *  spend row's, unknown with none. */
export function shadowCostOf(runId: string, audit: ReadonlyMap<string, number | null>, shadows: ReadonlyMap<string, Shadow>): number | null {
  const state = shadows.get(runId);
  if (state === undefined && !audit.has(runId)) return 0;
  return shadowUsdOf({ ended: state !== "open", usd: audit.has(runId) ? audit.get(runId)! : null });
}

/** A revision of a learned workflow as its records say it now (store-reads/learning.ts revisionsOf): the served runs its
 *  spend is spread over (`k`, its check's compile_after) and where it stands. Order is the records'. */
export type RevisionAt = { readonly workflow: string; readonly digest: string; readonly k: number; readonly state: RevisionSpend["state"] };

/** What summarize reads: the series' rows and spend, shadows by audited run, learning runs (absent: all), revisions. */
export type LedgerRead = {
  readonly rows: readonly LedgerRow[];
  readonly spend: readonly SpendRow[];
  readonly shadows: ReadonlyMap<string, Shadow>;
  readonly learning?: ReadonlySet<string>;
  readonly revisions: readonly RevisionAt[];
  readonly compileAfter: number;
  readonly named?: (row: LedgerRow) => string | null;
};

export type Summarized = { runs: CostRun[]; summary: CostSummary; bill: Omit<Bill, "holds">; figures: Map<string, RunFigures>; unknown_path_runs: number };

/** What the ledger says over an agent's series: each run of it (`runs`, oldest first, every one), what they show
 *  (`summary`), the owner's bill (`bill`, its holds aside: they are the records'), each run's figures by id (`figures`)
 *  and the rows whose end named no path (`unknown_path_runs`, left out of all of it). Every sum is over every run.
 *
 *  A revision is its workflow and its digest, never the digest alone: two workflows of the same text share a digest, and
 *  each pays its own way. Its spend is its compile turns and its check's replay runs (spend rows of its workflow at its
 *  digest), whether or not a record names it or the records were trimmed: one no record names follows the ones that do,
 *  at `compileAfter`, `checking` while it is its workflow's newest spend, else `stopped`. It is spread over its first K
 *  served runs (amortize). What no run carries is the booked total less every run's all-in, unknown while any run's
 *  figures are. */
export function summarize(read: LedgerRead): Summarized {
  const ordered = read.rows.filter((row) => row.path !== null && row.path !== "audit").sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const unknownPath = read.rows.filter((row) => row.path === null).length;
  const place = new Map(ordered.map((row, at) => [row.runId, at]));
  const learns = (runId: string) => place.has(runId) && (read.learning?.has(runId) ?? true);
  const spend = read.spend.filter((one) => (one.kind === "audit" ? place.has(one.ofRun ?? "") : learns(one.runId)));
  const { compile, audit } = spendByRun(spend);
  const partsOf = (row: LedgerRow, share: number | null) => ({ compile: compile.has(row.runId) ? compile.get(row.runId)! : 0, shadow: shadowCostOf(row.runId, audit, read.shadows), share });
  // One numbering, the bill's: the runs that do a job, 1 the first; a replay checks a revision and has none.
  let jobs = 0;
  const series = ordered.map((row): Omit<CostRun, "took_over"> => {
    const figures = figuresOf(row, partsOf(row, 0));
    const path = row.path!;
    return {
      n: JOB_PATHS.includes(path) ? (jobs += 1) : null, run_id: row.runId, started_at: new Date(row.startedAt).toISOString(), path,
      workflow: path === "agent" ? null : read.named ? read.named(row) : row.workflow,
      digest: path === "agent" || row.workflow === null ? null : row.digest,
      audited: read.shadows.has(row.runId) || audit.has(row.runId),
      cost_usd: figures.usd, cost_upper_bound: row.cost === "at_most", learning_usd: figures.series_learning_usd, total_usd: figures.series_total_usd,
      compile_usd: figures.compile_usd, followup_usd: figures.followup_usd, shadow_usd: figures.shadow_usd, share_usd: 0, not_served: row.notServed,
    };
  });
  const summary = costSummary(tookOverOf(series), null, new Set(series.flatMap((run) => (run.not_served === "cut" ? [run.run_id] : []))));
  const booked = billOf(tookOverOf(series), summary);
  // Each revision's compile and check, in spend order (the runs' order, then the rounds').
  const key = (workflow: string, digest: string) => `${workflow}\0${digest}`;
  const parts = new Map<string, { workflow: string; digest: string; compile: (number | null)[]; check: (number | null)[] }>();
  const newest = new Map<string, string>();
  // An audit's row is the run it audits' (its shadow is no run of the series): it is no revision's spend.
  for (const one of spend.filter((each) => each.kind !== "audit").sort((a, b) => place.get(a.runId)! - place.get(b.runId)! || a.round - b.round)) {
    if (one.workflow === null || one.digest === null) continue;
    const at = key(one.workflow, one.digest);
    const entry = parts.get(at) ?? { workflow: one.workflow, digest: one.digest, compile: [], check: [] };
    (one.kind === "compile" ? entry.compile : entry.check).push(one.usd);
    parts.set(at, entry);
    newest.set(one.workflow, at);
  }
  const spendOf = (workflow: string, digest: string, k: number, state: RevisionSpend["state"]): RevisionSpend => {
    const entry = parts.get(key(workflow, digest));
    const compileUsd = sumOf(entry?.compile ?? []);
    const checkUsd = sumOf(entry?.check ?? []);
    return { workflow, digest, compile_usd: compileUsd, check_usd: checkUsd, spend_usd: sumOf([compileUsd, checkUsd]), k, state };
  };
  const named = new Set(read.revisions.map((one) => key(one.workflow, one.digest)));
  const revisions: RevisionSpend[] = [
    ...read.revisions.map((one) => spendOf(one.workflow, one.digest, one.k, one.state)),
    ...[...parts].filter(([at]) => !named.has(at)).map(([at, entry]) => spendOf(entry.workflow, entry.digest, read.compileAfter, newest.get(entry.workflow) === at ? "checking" : "stopped")),
  ];
  const served = ordered.flatMap((row) => (learns(row.runId) && SERVED_PATHS.includes(row.path!) && row.workflow !== null && row.digest !== null ? [{ run_id: row.runId, workflow: row.workflow, digest: row.digest }] : []));
  const split = amortize(revisions, served);
  const figures = new Map(ordered.map((row) => [row.runId, figuresOf(row, partsOf(row, split.shares.has(row.runId) ? split.shares.get(row.runId)! : 0))]));
  const runs = tookOverOf(series.map((run) => ({ ...run, share_usd: figures.get(run.run_id)!.share_usd })));
  let carried: number | null = 0;
  for (const row of ordered) {
    const all = row.path === "replay" ? 0 : row.cost === "at_most" ? null : figures.get(row.runId)!.all_in_usd;
    carried = carried === null || all === null ? null : noiseOff(carried + all);
  }
  const unattributed = booked.withheld > 0 || carried === null ? null : noiseOff(booked.booked_usd - carried);
  return { runs, summary, bill: { ...booked, revisions: split.revisions, unattributed_usd: unattributed }, figures, unknown_path_runs: unknownPath };
}
