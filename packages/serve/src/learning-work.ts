// The learning work a run started beside its own turn, and the run view's `learning_work` (GET /v2/runs/{run_id}): what
// its caller reads to know when the run's own model key may be revoked, with no timer.
//
// A run's claim writes one settings row per run (learningWorkKey), appending each child it starts BEFORE the child is
// created: its learned workflow's check replay runs (runner/promotion.ts) and its audit's shadow run (runner/audit.ts), so
// no child exists that its run does not name. A child that drops before it starts (a check or a shadow its run's cap
// leaves no room for) is appended as dropped, so the run reads `ended`, never `none`, once it ends. The row holds run ids,
// kinds and times, nothing of a run's text or secrets, and goes with the run's purge (server.ts forgetRun).
//
// A child that spends on its run's own model key (`keyed`, resealed into its launch from the claiming run's) counts against
// that run's cap beside its own spend (keyedBesideOf, learning-end.ts capSpendOf): at its cost once it ended, at its own
// cap while it has not, so the run, its compile turn and its children never spend past the cap together.
//
// The row also keeps the run's learning deadline (`deadline`, ms): the latest instant any learning work it started may
// still spend, its caller's key-expiry backstop for a lost signal (the view's `deadline_at`). Each started child moves it
// to its start + LEARNING_CHILD_MS in the write that names it, and the compile turn's start to its start + its timeout
// (noteLearningDeadline), never earlier. The bound on a child is enforced: its launch carries its deadline (run-launch.ts
// Replay.deadlineAt), and the runner holding it cancels it there as a person's cancel is (runner.ts).
import { FINAL_STATES, type RunRow, type Settings, type Store } from "./store/store.js";
import { readLaunchBody } from "./run-launch.js";
import { said } from "./learning-words.js";

/** The smallest cap a run is started with: a child its run's cap leaves less than this for is dropped (`no_budget`). */
export const RUN_CAP_MIN_USD = 0.01;

/** The most a learning child (a check's replay run, an audit's shadow run) may take from its start: its runner cancels one
 *  still at work then. A replay runs one learned workflow on one input and a shadow one agent turn, minutes at most;
 *  half an hour leaves room for a slow model and a queue, and ends inside a check's own deadline (promotion.ts
 *  REPLAY_DEADLINE_MS), so a cancelled replay is one failed input of its check. A tuning parameter: this one name sets it. */
export const LEARNING_CHILD_MS = 30 * 60_000;

/** Work a claim holding its run's own key starts at its run's end instead of its start (a learned workflow's check):
 *  queued by its claim (`later`), run by its end-of-run step after the step and before its audit (runner/audit.ts
 *  withAudit), when what the run's cap leaves is known. A claim cut short, or lost, runs none: the next claim decides
 *  again. */
export type AtRunEnd = {
  readonly later: (start: () => Promise<void>) => void;
  readonly run: () => Promise<void>;
};

/** One claim's AtRunEnd, each queued start run once, in order; one that throws is logged and the next one runs. */
export function atRunEnd(log: (line: string) => void): AtRunEnd {
  const queued: (() => Promise<void>)[] = [];
  return {
    later: (start) => void queued.push(start),
    run: async () => {
      for (let start = queued.shift(); start; start = queued.shift()) {
        await start().catch((error: unknown) => log(`workflow-first: learning work at this run's end did not start (${(error as Error)?.message ?? error})`));
      }
    },
  };
}

/** The settings row that names the learning work run `runId` started. */
export const learningWorkKey = (runId: string): string => `learning_work:${runId}`;

/** One piece of learning work a run started beside its turn: a run it created (`run`), or one that dropped before it was
 *  created (`run` null, `dropped` why). `keyed`: the child spends on the run's own model key. `at`: when it was started or
 *  dropped (ms). */
export type LearningChild = {
  readonly run: string | null;
  readonly kind: "replay" | "shadow";
  readonly at: number;
  readonly keyed?: true;
  readonly dropped?: "no_budget";
};

/** A piece of learning work that dropped before it started, as a run's view and its timeline say it: its kind, why
 *  (`no_budget`: its run's cap left too little for it), when, and the reason in words. */
export type DroppedWork = {
  readonly kind: "replay" | "shadow";
  readonly reason: "no_budget";
  readonly at: string;
  readonly detail: string;
};

/** The `learning_work` field of a run's view. `dropped`: each piece that dropped before it started, oldest first; present
 *  only when one did. */
export type LearningWork = {
  readonly state: "none" | "running" | "ended";
  readonly runs: string[];
  readonly ended_at: string | null;
  readonly deadline_at: string | null;
  readonly dropped?: DroppedWork[];
};

/** Each piece of learning work in `children` that dropped before it started, in words. */
export const droppedWorkOf = (children: readonly LearningChild[]): DroppedWork[] =>
  children.flatMap((child) => (child.dropped ? [{ kind: child.kind, reason: child.dropped, at: new Date(child.at).toISOString(), detail: said.childDropped(child.kind) }] : []));

const childOf = (value: unknown): LearningChild | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const one = value as Record<string, unknown>;
  if (!(typeof one.run === "string" || one.run === null) || (one.kind !== "replay" && one.kind !== "shadow") || typeof one.at !== "number") return undefined;
  return { run: one.run, kind: one.kind, at: one.at, ...(one.keyed === true ? { keyed: true as const } : {}), ...(one.dropped === "no_budget" ? { dropped: "no_budget" as const } : {}) };
};

/** The learning work run `runId` started, in the order it started it; none for a run that started none. */
export async function learningChildrenOf(settings: Pick<Settings, "get">, runId: string): Promise<LearningChild[]> {
  const saved = (await settings.get(learningWorkKey(runId))) as { children?: unknown } | undefined | null;
  return Array.isArray(saved?.children) ? saved.children.map(childOf).filter((one): one is LearningChild => one !== undefined) : [];
}

/** Run `runId`'s learning deadline as its row keeps it (ms), or undefined when it keeps none. */
const deadlineIn = (saved: unknown): number | undefined => {
  const deadline = (saved as { deadline?: unknown } | undefined | null)?.deadline;
  return typeof deadline === "number" && Number.isFinite(deadline) ? deadline : undefined;
};

/** The later of a kept deadline and a new bound: a deadline only moves later. */
const later = (kept: number | undefined, bound: number | undefined): number | undefined => (kept === undefined ? bound : bound === undefined ? kept : Math.max(kept, bound));

/** Appends `child` to the learning work run `runId` started, and moves the run's learning deadline to the child's start +
 *  LEARNING_CHILD_MS when later (a dropped child spends nothing and moves nothing), in one guarded write (a
 *  compare-and-set, tried again while another write lands first). A child already named is not named twice. Written
 *  before the child is created. */
export async function noteLearningChild(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, runId: string, child: LearningChild): Promise<void> {
  await changeWork(settings, runId, (children, deadline) => {
    if (child.run !== null && children.some((one) => one.run === child.run)) return undefined;
    return { children: [...children, child], deadline: later(deadline, child.run === null ? undefined : child.at + LEARNING_CHILD_MS) };
  });
}

/** Moves run `runId`'s learning deadline to `until` (ms) when later, never earlier, in one guarded write: its compile
 *  turn's start + its timeout, written before the turn asks the model (runner/learning-end.ts). */
export async function noteLearningDeadline(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, runId: string, until: number): Promise<void> {
  await changeWork(settings, runId, (children, deadline) => (deadline !== undefined && deadline >= until ? undefined : { children, deadline: until }));
}

/** One guarded write of run `runId`'s learning work row: `change` given its children and deadline, the row it writes, or
 *  undefined for none (nothing to change). */
async function changeWork(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, runId: string, change: (children: LearningChild[], deadline: number | undefined) => { children: LearningChild[]; deadline: number | undefined } | undefined): Promise<void> {
  const key = learningWorkKey(runId);
  for (let tries = 0; tries < 20; tries++) {
    const was = await settings.get(key);
    const children = await learningChildrenOf({ get: async () => was }, runId);
    const next = change(children, deadlineIn(was));
    if (!next) return;
    const value = { children: next.children, ...(next.deadline !== undefined ? { deadline: next.deadline } : {}) };
    if (was === undefined) {
      const saved = await settings.putIfAbsent(key, value);
      if (JSON.stringify(saved) === JSON.stringify(value)) return;
      continue;
    }
    if (await settings.replaceIf(key, was, value)) return;
  }
  throw new Error(`${key} kept changing under this write; try again`);
}

const figure = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;

/** What the replay runs run `runId` started on its own model key took beside it: each at its cost once it ended, at its
 *  own cap while it has not (the most it may take) or when it ended at a cost not known; 0 for none. Null: unknown (one
 *  with neither a cost nor a cap). Its audit's shadow is counted apart (learning-end.ts shadowBesideOf). */
export async function keyedBesideOf(store: Pick<Store, "runs" | "settings">, runId: string): Promise<number | null> {
  let sum = 0;
  for (const child of await learningChildrenOf(store.settings, runId)) {
    if (!child.keyed || child.kind !== "replay" || child.run === null) continue;
    const row = await store.runs.get(child.run);
    if (!row) continue;
    if (FINAL_STATES.includes(row.state) && figure(row.costUsd)) {
      sum += row.costUsd;
      continue;
    }
    const cap = await store.runs.launch(child.run).then((one) => readLaunchBody(one.body)?.maxCostUsd, () => undefined);
    if (!figure(cap)) return null;
    sum += cap;
  }
  return sum;
}

/** What a run's view knows of its own learning, beside its children: whether it learns at all (a learning start, and no
 *  replay or shadow run), whether its end-of-run (compile) turn is going now, whether one began, and when its learning
 *  ended (its learning end's time, else its end's). `compileBy`: while it looks back, the most its compile turn may take
 *  as the view knows it from the job's end (that end + the turn's timeout; the turn's own start, later, is kept in the row
 *  by noteLearningDeadline), else null. */
export type OwnLearning = {
  readonly learns: boolean;
  readonly compiling: boolean;
  readonly compiled: boolean;
  readonly endedAt: number | null;
  readonly compileBy: number | null;
};

/** Run `runId`'s `learning_work`: `running` while its compile turn goes or a child it started has not ended (`runs`, the
 *  child run ids not ended), `ended` once every piece it started has finished or dropped (`ended_at`, the last one's end),
 *  else `none`. A child whose row is gone or was never created counts as ended at the time it was named: its own end, or
 *  its absence, settles it, so the state cannot stay `running` forever. `deadline_at` while running: the later of the
 *  row's deadline and the compile turn's bound (`own.compileBy`); null otherwise. */
export async function learningWorkOf(store: Pick<Store, "runs" | "settings">, runId: string, own: OwnLearning): Promise<LearningWork> {
  const saved = await store.settings.get(learningWorkKey(runId));
  const children = await learningChildrenOf({ get: async () => saved }, runId);
  const going: string[] = [];
  let last = own.compiled && own.endedAt !== null ? own.endedAt : Number.NEGATIVE_INFINITY;
  for (const child of children) {
    const row: RunRow | undefined = child.run === null ? undefined : await store.runs.get(child.run);
    if (row && !FINAL_STATES.includes(row.state)) {
      going.push(row.id);
      continue;
    }
    last = Math.max(last, row?.endedAt ?? child.at);
  }
  // What dropped before it started is said in words beside the state, so a caller sees why less ran than asked.
  const dropped = droppedWorkOf(children);
  const told = dropped.length ? { dropped } : {};
  if (going.length || (own.learns && own.compiling)) {
    const deadline = later(deadlineIn(saved), own.learns && own.compiling && own.compileBy !== null ? own.compileBy : undefined);
    return { state: "running", runs: going, ended_at: null, deadline_at: deadline === undefined ? null : new Date(deadline).toISOString(), ...told };
  }
  if (!children.length && !(own.learns && own.compiled)) return { state: "none", runs: [], ended_at: null, deadline_at: null };
  return { state: "ended", runs: [], ended_at: Number.isFinite(last) ? new Date(last).toISOString() : null, deadline_at: null, ...told };
}
