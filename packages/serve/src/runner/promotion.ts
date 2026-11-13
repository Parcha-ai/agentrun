// Promotion by replay, at a run's claim (champion/challenger, shadow deployment): the learned workflow that fits the run's
// input serves first only when its digest is promoted (learn/promote.ts). A digest with no record yet is replayed on the
// agent's last REPLAY_INPUTS graded inputs (runs a person or an eval graded, PUT /runs/{id}/grade, whose answer was the
// agent's): each a queued replay run of its own (RunLaunch.replay, at workflow cost, its guards record-only), the agent
// taking the runs meanwhile. A later claim that finds every replay run ended scores them (replayScore at the serving
// thresholds: a hand-back is the agent's recorded answer) and promotes the digest when it is within PROMOTE_BAR of the
// agent path, else holds it; a held digest whose workflow has guards gets one threshold refit over the replay's rows
// (learn/refit.ts), a new revision that serves when the refit clears the bar. Fewer than REPLAY_MIN graded inputs: the
// digest is promoted on its passing dry run, as before, and its record says so. A serving digest is checked once per
// REFIT_EVERY more graded runs it served: its thresholds refit (a new revision when they move and still clear the bar),
// and held when its graded runs fall below the bar. Escalation never holds a workflow: a hand-back is the agent's answer.
// The champion keeps serving meanwhile: while the folder's revision (the challenger) replays, or once it is held, the
// digest promoted last (learn/promote.ts championOf) serves the run, read from the learning commit its record names, so
// a wrong served grade asks for a revision and never stops the workflow serving. The challenger serves once its replay
// promotes it. Only the money rule (workflow-first.ts) and a graded hold of the champion itself stop it.
// One challenger at a time: a newer revision (a claim launched after the replaying one's replay started, so its seed is
// at least as new) supersedes the revision still replaying: that one's replay runs are cancelled (in-flight ones stop as
// any cancelled run does, what they spent stays booked on their rows), none starts again, and its record says superseded.
// The newer revision is compiled on the folder's main, the challenger's own text, so it already carries that change.
import type { Context } from "@earendil-works/chord";
import type { LearnedWorkflow } from "../learning.js";
import { LEARNING_LABEL } from "../learning.js";
import type { GuardRow } from "../learned-nodes.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { uuidv7 } from "../runs-over-store.js";
import { FINAL_STATES, RunFinal, type RunRow, type Store, StoreConstraint } from "../store/store.js";
import { runTimeline } from "../store-reads/journal.js";
import { isObject, type Json } from "../validate.js";
import { championOf, clears, type Grade, gradesOf, PROMOTE_BAR, type PromotionRecord, promotionOf, promotionsOf, recordPromotion, REFIT_EVERY, REPLAY_INPUTS, REPLAY_MIN, type ReplayRow, replayingOf, replayScore, answerCorrect, thresholdsOf } from "../learn/promote.js";
import { sendCommand } from "./commands.js";
import { type RefitRow, refitGuards } from "../learn/refit.js";
import { fits, workflowDigest } from "./workflow-first.js";
import { learningCommit } from "../learn/commit.js";
import type { LearningFolder } from "../learn/folder.js";
import { recordOnly } from "../learn/promote.js";
import type { Shown } from "../learning.js";
import { workflowsAt } from "./learning-seed.js";

/** A replay run still not ended this long after its replay started counts as handed back (the agent's answer). */
export const REPLAY_DEADLINE_MS = 60 * 60 * 1000;

export interface PromotionDeps {
  readonly store: Store;
  readonly agentId: string;
  /** The run being claimed: never one of its own replay's inputs. */
  readonly runId: string;
  /** The revision the claimed run runs: its replay runs run it too. */
  readonly revisionId: string;
  /** The claimed run's launch: a replay run's is this one with the graded run's input. */
  readonly launch: RunLaunch;
  readonly context: Context;
  readonly log: (line: string) => void;
  /** Writes a refit's new workflow text onto the agent's learning folder (a merge as `id`, from the claim's seed); the
   *  learning commit it landed as, or null when it did not. Absent: no refit is written. */
  readonly commit?: (files: { path: string; text: string }[], reason: string, id: string) => Promise<string | null>;
  /** The learned workflow `name` as the learning folder held it active at `commit` (a champion's text), or undefined when
   *  it held none by that name. Absent: no champion serves. */
  readonly champion?: (name: string, commit: string) => Promise<LearnedWorkflow | undefined>;
  readonly now?: () => number;
}

/** The claim's promotion ports: `folder`, the agent's learning folder where the run's place keeps it, a refit's revision
 *  written on it as a merge from the claim's seed (a workflow.json changed on main since is a conflict, never written over),
 *  and a champion read from it at its record's commit, cut of the server's secrets (`shown`) as the claim's lay is. */
export function claimPromotion(deps: Omit<PromotionDeps, "commit" | "champion"> & { readonly folder: () => LearningFolder; readonly shown: () => Promise<Shown> }): PromotionDeps {
  const seed = deps.launch.learning?.seed;
  return {
    ...deps,
    commit: async (files, reason, id) => {
      const folder = deps.folder();
      try {
        const done = await learningCommit(folder.workspace, { kind: "merge", runId: id, reason, files, graded: {}, ...(seed ? { seed } : {}) });
        if (!done.ok) deps.log(`workflow-first: a refit could not be written (${done.reason})`);
        return done.ok ? done.commit : null;
      } finally {
        await folder.end();
      }
    },
    champion: async (name, commit) => (await workflowsAt({ folder: deps.folder, shown: deps.shown }, commit)).find((one) => one.name === name),
  };
}

/** The workflows a replay run's claim lays (`laid`, the seed lay's): the one it replays record-only (learn/promote.ts
 *  recordOnly: every guard at the least threshold the DSL takes, so each step's p is read and none hands back on it), or none by that name when
 *  the laid one is not the digest it replays (the replay then fails, never scoring another revision). Any other run's,
 *  as laid. */
export function replayLaid(launch: RunLaunch, laid: readonly LearnedWorkflow[]): LearnedWorkflow[] {
  if (!launch.replay) return [...laid];
  const { workflow, digest } = launch.replay;
  return laid.flatMap((one) => (one.name !== workflow ? [one] : workflowDigest(one) === digest ? [{ ...one, workflow: recordOnly(one.workflow) }] : []));
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The claim's seed as a record's `commit`: the learning commit the laid workflow's text was read from. */
const seedOf = (deps: Pick<PromotionDeps, "launch">): { commit?: string } => (deps.launch.learning?.seed ? { commit: deps.launch.learning.seed } : {});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The gate workflowFirstOf asks (its `promoted`): the workflow that serves this run first, when `workflow` (laid at
 *  `digest`, the folder's revision) is the one, or its champion while that revision replays or is held (championOf, its
 *  text read from its record's commit); undefined when none serves (the agent takes the run). */
export const promotionGate = (deps: PromotionDeps) => async (workflow: LearnedWorkflow, digest: string): Promise<LearnedWorkflow | undefined> => {
  try {
    if (await promoted(deps, workflow, digest)) return workflow;
    return await championFor(deps, workflow, digest);
  } catch (error) {
    // A promotion that could not be read or written leaves the run to its agent: never a workflow served unchecked.
    deps.log(`workflow-first: ${workflow.name}'s promotion could not be read (${(error as Error)?.message ?? error}); the agent takes this run`);
    return undefined;
  }
};

/** The champion of `workflow` when it is not the laid revision at `digest`: its text at its record's commit (its digest
 *  checked), still serving after its graded check (stillServing, with no refit: a refit written now would land over the
 *  challenger on the folder's main). Undefined when there is none, it cannot be read, or its graded runs held it. */
async function championFor(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string): Promise<LearnedWorkflow | undefined> {
  const champion = championOf(await promotionsOf(deps.store.settings, deps.agentId), workflow.name);
  if (!champion || champion.digest === digest || !deps.champion) return undefined;
  const text = champion.commit ? await deps.champion(workflow.name, champion.commit).catch(() => undefined) : undefined;
  if (!text || workflowDigest(text) !== champion.digest) {
    deps.log(`workflow-first: ${workflow.name}'s champion at ${champion.digest} could not be read from its learning commit; the agent takes this run`);
    return undefined;
  }
  if (!(await stillServing({ ...deps, commit: undefined }, text, champion.digest, champion))) return undefined;
  deps.log(`workflow-first: ${workflow.name}'s champion at ${champion.digest} serves this run while ${digest} is not promoted`);
  return text;
}

async function promoted(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string): Promise<boolean> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const record = promotionOf(await promotionsOf(store.settings, agentId), workflow.name, digest);
  if (record?.decided === "promote") return await stillServing(deps, workflow, digest, record);
  if (record?.decided === "hold") {
    log(`workflow-first: ${workflow.name} at ${digest} is held (${record.reason}); it does not serve this run`);
    return false;
  }
  if (record?.decided === "superseded") {
    log(`workflow-first: ${workflow.name} at ${digest} was superseded by ${record.superseded_by ?? "a newer revision"} while it replayed; it does not serve this run`);
    return false;
  }
  if (record?.decided === "replaying") {
    const decided = await settle(deps, workflow, digest, record);
    if (!decided) {
      log(`workflow-first: ${workflow.name} at ${digest} is replaying on ${plural(record.runs?.length ?? 0, "graded input")}; it does not serve this run`);
      return false;
    }
    return decided.decided === "promote";
  }
  // A new revision. One challenger at a time: one still replaying is superseded by it, when this run was launched after
  // that replay started (its seed is at least as new); a run launched before may lay an older text, and starts nothing.
  const rivals = replayingOf(await promotionsOf(store.settings, agentId), workflow.name, digest);
  if (rivals.length) {
    const claimed = (await store.runs.get(deps.runId))?.startedAt;
    const since = Math.min(...(await Promise.all(rivals.map((one) => replayStartOf(deps, one)))));
    if (claimed === undefined || claimed < since) {
      log(`workflow-first: ${workflow.name} at ${digest} came on a run launched before ${rivals[0]!.digest}'s replay started; it does not serve this run`);
      return false;
    }
    for (const rival of rivals) await supersede(deps, rival, digest);
  }
  const graded = await gradedInputs(deps, workflow);
  if (graded.length < REPLAY_MIN) {
    const reason = graded.length ? `${plural(graded.length, "graded input")} it fits, fewer than ${REPLAY_MIN}: promoted on its passing dry run` : `no graded input it fits: promoted on its passing dry run`;
    const kept = await recordPromotion(store.settings, agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "promote", source: "dry_run", reason, ...seedOf(deps) }, (was) => was === undefined);
    if (kept.decided === "promote" && kept.source === "dry_run") log(`workflow-first: ${workflow.name} at ${digest}: ${kept.reason}`);
    return kept.decided === "promote";
  }
  // Replay runs, one per graded input, each under an origin key of its own, so two claims deciding the same digest at once
  // start each once.
  const runs: string[] = [];
  for (const one of graded) runs.push(await startReplay(deps, workflow, digest, one));
  const kept = await recordPromotion(store.settings, agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "replaying", source: "replay", reason: `replaying on the agent's last ${plural(graded.length, "graded input")} it fits`, runs, ...seedOf(deps) }, (was) => was === undefined);
  log(`workflow-first: ${workflow.name} at ${digest} is new: replaying it on the agent's last ${plural(graded.length, "graded input")} before it serves`);
  return kept.decided === "promote";
}

/** When `record`'s replay started: its first replay run's launch, else its record's time. */
async function replayStartOf(deps: PromotionDeps, record: PromotionRecord): Promise<number> {
  const first = record.runs?.[0] ? await deps.store.runs.get(record.runs[0]) : undefined;
  return first?.startedAt ?? Date.parse(record.at);
}

/** Supersedes `record`, a revision still replaying, by the newer revision at `by`: its record decided superseded (kept only
 *  while it still says replaying: a replay that settled first keeps its decision), then each of its replay runs not ended
 *  is cancelled, as a person's cancel is (a queued one never runs; an in-flight one stops, what it spent booked on its row). */
async function supersede(deps: PromotionDeps, record: PromotionRecord, by: string): Promise<void> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const runs = record.runs ?? [];
  const reason = `superseded by ${by}, a newer revision, while it replayed: its replay runs were cancelled`;
  const kept = await recordPromotion(store.settings, agentId, {
    workflow: record.workflow, digest: record.digest, at: iso(now()), decided: "superseded", source: "replay", reason, superseded_by: by,
    ...(runs.length ? { runs } : {}), ...(record.commit ? { commit: record.commit } : {}),
  }, (was) => was?.decided === "replaying");
  if (kept.decided !== "superseded" || kept.superseded_by !== by) return;
  let cancelled = 0;
  for (const id of runs) {
    const row = await store.runs.get(id);
    if (!row || FINAL_STATES.includes(row.state)) continue;
    try {
      await sendCommand(store, id, { kind: "cancel", body: {} });
      cancelled += 1;
    } catch (error) {
      if (!(error instanceof RunFinal)) throw error;
    }
  }
  log(`workflow-first: ${record.workflow} at ${record.digest} superseded by ${by} while it replayed; ${plural(cancelled, "replay run")} cancelled`);
}

/** A graded input a replay runs on: the graded run, its grade, its launch. */
type GradedInput = { readonly grade: Grade; readonly launch: RunLaunch };

/** The agent's newest graded runs whose answer was the agent's (path `agent`, or `handed_back`: the agent finished it), at
 *  most REPLAY_INPUTS, newest first: each with a launch read back, no uploaded file, an input `workflow` fits, never the
 *  run being claimed, nor an archived or imported one. */
async function gradedInputs(deps: PromotionDeps, workflow: LearnedWorkflow): Promise<GradedInput[]> {
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  const out: GradedInput[] = [];
  const grades = (await gradesOf(deps.store.settings, deps.agentId)).filter((grade) => grade.path === "agent" || grade.path === "handed_back");
  for (const grade of grades.reverse()) {
    if (out.length >= REPLAY_INPUTS) break;
    if (grade.run === deps.runId) continue;
    const row = await deps.store.runs.get(grade.run);
    if (!row || row.archivedAt !== null || row.importedFrom) continue;
    const launch = await deps.store.runs.launch(grade.run).then((one) => readLaunchBody(one.body), () => undefined);
    if (!launch || launch.files?.length || launch.replay || !fits(workflow, launch.input, resolveSchemaForWorkflow as never)) continue;
    out.push({ grade, launch });
  }
  return out;
}

/** Starts the replay of `workflow` at `digest` on graded input `one` (once: its origin key's run when there is one). */
async function startReplay(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, one: GradedInput): Promise<string> {
  const { store, agentId, launch } = deps;
  const key = `replay:${agentId}:${workflow.name}:${digest}:${one.grade.run}`;
  const replay: RunLaunch = {
    input: one.launch.input,
    title: `Replay of ${workflow.name}: ${one.launch.title}`.slice(0, 200),
    place: launch.place,
    ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
    ...(launch.maxCostUsd !== undefined ? { maxCostUsd: launch.maxCostUsd } : {}),
    ...(launch.capMode !== undefined ? { capMode: launch.capMode } : {}),
    ...(launch.plane ? { plane: launch.plane } : {}),
    ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
    ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
    ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
    ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
    ...(launch.learning ? { learning: launch.learning } : {}),
    ...(launch.archilDisk ? { archilDisk: launch.archilDisk } : {}),
    replay: { of: one.grade.run, workflow: workflow.name, digest },
  };
  try {
    return (await store.runs.create({ id: uuidv7(), agentId, revisionId: deps.revisionId, origin: { key } }, { body: launchBody(replay) as Json })).id;
  } catch (error) {
    if (!(error instanceof StoreConstraint)) throw error;
    const existing = await store.runOfOrigin(key);
    if (existing) return existing.runId;
    throw error;
  }
}

/** A run's final answer, whole (its last final answer row that is not its end-of-run turn's), or null: none, or its
 *  record could not be read (a grade's `expected` fields still score a replay without it). */
async function answerOf(store: PromotionDeps["store"], runId: string, context: Context): Promise<string | null> {
  try {
    const rows = await runTimeline(store, runId, context, { settled: true, caps: { text: Number.POSITIVE_INFINITY } });
    return rows.findLast((row) => row.kind === "final_answer" && row.agent_label !== LEARNING_LABEL)?.text ?? null;
  } catch {
    return null;
  }
}

const metricsOf = (row: RunRow | undefined) => (isObject(row?.metrics as Json) ? (row!.metrics as { replay?: { outcome?: unknown }; guards?: unknown; path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});

/** The replay's rows, once every replay run ended (or REPLAY_DEADLINE_MS passed: one not ended is handed back); undefined
 *  while one is at work. With what the replay runs cost (null when one's is unknown). */
async function replayRows(deps: PromotionDeps, record: PromotionRecord): Promise<{ rows: ReplayRow[]; cost: number | null } | undefined> {
  const { store, context } = deps;
  const now = (deps.now ?? Date.now)();
  const grades = new Map((await gradesOf(store.settings, deps.agentId)).map((grade) => [grade.run, grade]));
  const runs = await Promise.all((record.runs ?? []).map((id) => store.runs.get(id)));
  const late = now - Date.parse(record.at) > REPLAY_DEADLINE_MS;
  if (!late && runs.some((row) => row && !FINAL_STATES.includes(row.state))) return undefined;
  const rows: ReplayRow[] = [];
  let cost: number | null = 0;
  for (const run of runs) {
    if (!run) continue;
    const launch = await store.runs.launch(run.id).then((one) => readLaunchBody(one.body), () => undefined);
    const of = launch?.replay?.of;
    const grade = of ? grades.get(of) : undefined;
    if (!of || !grade) continue;
    const ended = FINAL_STATES.includes(run.state);
    cost = cost === null || !ended || run.costUsd === null ? null : cost + run.costUsd;
    const m = metricsOf(run);
    const outcome = ended && run.state === "ended" && (m.replay?.outcome === "answered" || m.replay?.outcome === "handed_back") ? m.replay.outcome : "failed";
    rows.push({
      of,
      recorded: { answer: await answerOf(store, of, context), correct: grade.correct, ...(grade.expected ? { expected: grade.expected } : {}) },
      outcome,
      answer: outcome === "answered" ? await answerOf(store, run.id, context) : null,
      guards: Array.isArray(m.guards) ? (m.guards as GuardRow[]) : [],
    });
  }
  return { rows, cost: cost === null ? null : Math.round(cost * 1e6) / 1e6 };
}

/** A replaying digest's decision, once its replay runs ended: promote within the bar, else hold, then one refit when its
 *  workflow has guards. Undefined while a replay run is at work. */
async function settle(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<PromotionRecord | undefined> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const read = await replayRows(deps, record);
  if (!read) return undefined;
  const score = replayScore(read.rows, thresholdsOf(workflow.workflow));
  const ok = read.rows.length >= REPLAY_MIN && clears(score);
  const pts = (value: number) => `${(value * 100).toFixed(1)}%`;
  const said = `on ${plural(score.n, "graded input")}: the workflow ${pts(score.wf_acc)} (${score.handed_back} handed back, the agent's answer), the agent ${pts(score.agent_acc)}, ${score.delta >= 0 ? "+" : ""}${(score.delta * 100).toFixed(1)} pts`;
  const reason = read.rows.length < REPLAY_MIN ? `only ${plural(read.rows.length, "replay")} could be read back, fewer than ${REPLAY_MIN}` : ok ? `replayed ${said}: within ${PROMOTE_BAR * 100} pts` : `replayed ${said}: more than ${PROMOTE_BAR * 100} pts under the agent`;
  const decided = await recordPromotion(store.settings, agentId, {
    workflow: workflow.name, digest, at: iso(now()), decided: ok ? "promote" : "hold", source: "replay", reason,
    replay: { ...score, of: read.rows.map((row) => row.of), cost_usd: read.cost }, ...(record.runs ? { runs: record.runs } : {}),
    ...(record.commit ? { commit: record.commit } : seedOf(deps)),
  }, (was) => was?.decided === "replaying");
  if (decided.decided === "replaying") return undefined;
  log(`workflow-first: ${workflow.name} at ${digest} ${decided.decided === "promote" ? "promoted" : "held"}: ${decided.reason}`);
  if (decided.decided === "hold" && read.rows.length >= REPLAY_MIN) {
    // Held with guards: one refit over the replay's rows (each step's p known: its guards read record-only).
    await refitAndWrite(deps, workflow, digest, read.rows.map(replayRefitRow), "its replay held it", read.rows);
  }
  return decided;
}

/** A replayed input as a refit row: answered alone only when every guard read a p (record-only, none handed back). */
const replayRefitRow = (row: ReplayRow): RefitRow => {
  const answered = row.outcome === "answered" && row.guards.every((guard) => guard.p !== null);
  return { guards: row.guards, answered, wfCorrect: answered ? answerCorrect(row.answer, row.recorded) : null, agentCorrect: row.recorded.correct ? 1 : 0 };
};

/** A serving digest, checked once per REFIT_EVERY more graded runs it served: its thresholds refit over those runs and its
 *  replay's rows (a new revision when they move and still clear the bar), and held when its graded runs' accuracy fell
 *  more than PROMOTE_BAR under the agent's. True: it still serves this run. */
async function stillServing(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, record: PromotionRecord): Promise<boolean> {
  const { store, agentId, log } = deps;
  const now = deps.now ?? Date.now;
  const grades = await gradesOf(store.settings, agentId);
  const served = grades.filter((grade) => grade.workflow === workflow.name && grade.digest === digest && (grade.path === "workflow" || grade.path === "handed_back"));
  const checked = record.checked ?? 0;
  if (served.length < checked + REFIT_EVERY) return true;
  // The agent's accuracy by hand: its newest graded runs on the agent path, else the replay's.
  const byHand = grades.filter((grade) => grade.path === "agent").slice(-REPLAY_INPUTS);
  const agentAcc = byHand.length ? byHand.filter((grade) => grade.correct).length / byHand.length : record.replay?.agent_acc;
  // Marked checked at this count first, so two claims never check the same window twice.
  const marked = await recordPromotion(store.settings, agentId, { ...record, at: iso(now()), checked: served.length }, (was) => was?.decided === "promote" && (was.checked ?? 0) === checked);
  if ((marked.checked ?? 0) !== served.length || agentAcc === undefined) return marked.decided === "promote";
  const rows: RefitRow[] = [];
  for (const grade of served) {
    const run = await store.runs.get(grade.run);
    const m = metricsOf(run);
    const guards = Array.isArray(m.guards) ? (m.guards as GuardRow[]) : [];
    rows.push(grade.path === "workflow" ? { guards, answered: true, wfCorrect: grade.correct, agentCorrect: agentAcc } : { guards, answered: false, wfCorrect: null, agentCorrect: grade.correct ? 1 : 0 });
  }
  const replayed = record.source === "replay" && record.runs?.length ? await replayRows(deps, record) : undefined;
  const all = [...rows, ...(replayed?.rows ?? []).map(replayRefitRow)];
  const wrote = await refitAndWrite(deps, workflow, digest, all, `${plural(served.length, "graded run")} it served`, replayed?.rows ?? []);
  const servedAcc = served.filter((grade) => grade.correct).length / served.length;
  if (!wrote && servedAcc < agentAcc - PROMOTE_BAR - 1e-9) {
    const reason = `${plural(served.length, "graded run")} it served were right ${(servedAcc * 100).toFixed(1)}% of the time, more than ${PROMOTE_BAR * 100} pts under the agent's ${(agentAcc * 100).toFixed(1)}% by hand`;
    const held = await recordPromotion(store.settings, agentId, { workflow: workflow.name, digest, at: iso(now()), decided: "hold", source: "graded", reason }, (was) => was?.decided === "promote");
    log(`workflow-first: ${workflow.name} at ${digest} held: ${held.reason}`);
    return held.decided === "promote";
  }
  return true;
}

/** One refit of `workflow` over `rows`; when it moves a guard and the rows clear the bar at the new thresholds, the new
 *  text is written as a new revision (a merge from the claim's seed) and promoted with the rows' numbers. True when one
 *  was written. */
async function refitAndWrite(deps: PromotionDeps, workflow: LearnedWorkflow, digest: string, rows: RefitRow[], why: string, replayed: readonly ReplayRow[]): Promise<boolean> {
  if (!deps.commit || rows.length < REPLAY_MIN) return false;
  const now = deps.now ?? Date.now;
  const refit = refitGuards(workflow.workflow, rows, iso(now()));
  if (!refit.text || !clears(refit)) return false;
  const next = workflowDigest({ workflow: refit.text });
  const moved = refit.guards.map((one) => `${one.node} ${one.was} -> ${one.threshold}${one.fit ? " (fit)" : ""}`).join(", ");
  const reason = `refit ${workflow.name}'s guards over ${why} (${plural(rows.length, "row")}): ${moved}`;
  const landed = await deps.commit([{ path: `workflows/${workflow.name}/workflow.json`, text: refit.text }], reason, `refit-${digest}-${next}`);
  if (landed === null) {
    deps.log(`workflow-first: ${workflow.name}'s refit did not land on its learning folder; it keeps its thresholds`);
    return false;
  }
  const agree = replayed.length ? replayScore(replayed, new Map(refit.guards.map((one) => [one.node, one.threshold]))).agree : 0;
  await recordPromotion(deps.store.settings, deps.agentId, {
    workflow: workflow.name, digest: next, at: iso(now()), decided: "promote", source: "refit",
    reason: `${reason}: the workflow ${(refit.wf_acc * 100).toFixed(1)}%, the agent ${(refit.agent_acc * 100).toFixed(1)}% on those rows`,
    replay: { n: refit.n, agree, agent_acc: refit.agent_acc, wf_acc: refit.wf_acc, delta: refit.delta, handed_back: refit.handed_back, of: replayed.map((row) => row.of) },
    refit: { from: digest, guards: refit.guards }, commit: landed,
  }, (was) => was === undefined);
  deps.log(`workflow-first: ${reason}; the new revision (${next}) serves from the next run`);
  return true;
}
