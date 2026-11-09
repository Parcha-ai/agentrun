// The learning lane's end-of-run turn on the runner (loop-contract.ts EndOfRunTurn), the server's rules moved
// (learning-run.ts reflectSkip, reflect, closeLearning; propose.ts proposeRun's checks through `check`): whether a run
// looks back, its prompt, how its turn ended, and the rows that keep its learning beside the run's end. A proposal is
// kept with the turn that gave it (learning_proposals) and queues one learning run (learning_run) that grades and merges
// it; a learning dropped at any step is kept with its reason and words, and queues none. What the run must never learn
// (`refuse`: the host's secrets and what it was handed, its sign-in pointer among them) is refused by the checks, and cut
// from everything the hook keeps; a run whose list can't be read learns nothing.
import { cutStrings } from "../key-refusal.js";
import { reflectAgain, reflectPrompt, redactSecrets } from "../learn/index.js";
import { said, STOPPED } from "../learning-words.js";
import type { AlsoRow, EndOfRunTurn } from "./loop-contract.js";

/** How long a run's end-of-run turn may take before it is aborted and the run ends without it. */
export const REFLECT_TIMEOUT_MS = 5 * 60_000;
/** The folder of a run's copy of what its agent learned, relative to its work: what the prompt names. */
const LEARNED_DIR = ".learning";
/** A turn the spend cap refused (the cap's refusal words, cap.ts CAP_REFUSAL_PREFIX). */
export const CAP_REFUSAL = /^spend_cap_reached(?: \([^)]*\))?: /;

/** What a run's turn answered, and what the person and a trigger said in the run (learning.ts Turn). */
export interface ReflectTurn {
  readonly answer: string;
  readonly asked: readonly string[];
  readonly triggered?: readonly { readonly source: string; readonly text: string }[];
}

/** What the checks made of a turn (propose.ts Proposed), with the proposal they kept. */
export type Checked =
  | { readonly state: "proposed"; readonly notes: number; readonly skills: number; readonly workflows: number; readonly left?: readonly unknown[]; readonly proposal: unknown }
  | { readonly state: "dropped"; readonly reason: "empty" }
  | { readonly state: "dropped"; readonly reason: "unparsed"; readonly detail: string }
  | { readonly state: "dropped"; readonly reason: "checker"; readonly problems: readonly { readonly rule: string; readonly path?: string }[] };

/** What the hook reads of the run and the host. */
export interface ReflectDeps {
  /** The run's facts for reflectSkip: whether it learns, a person's cancel, its cap reached, its cap and spend so far. */
  readonly facts: (runId: string) => Promise<{ learns: boolean; cancelled?: boolean; capReached?: boolean; capUsd?: number; costUsd: number | null }>;
  /** The prompt's facts: how many notes the run started from, and the tools a workflow draft may name. */
  readonly promptFacts: (runId: string, agentId: string) => Promise<{ active: number; tools: readonly string[] }>;
  /** What the person said in the run, and a trigger's input, as the checks and the grader read them. */
  readonly asked: (runId: string) => Promise<{ asked: readonly string[]; triggered?: ReflectTurn["triggered"] }>;
  /** Every value the run must never learn (learning-run.ts refused): the host's secrets, the keys saved on the server, and
   *  what the run was handed, its sign-in pointer among them; `unreadable` when what it was handed can't be read back, and
   *  the run learns nothing (as it does when the list can't be read at all). Absent, none. */
  readonly refuse?: (runId: string) => Promise<readonly string[] | "unreadable">;
  /** proposeRun's checks over the turn, against the seed the run started from, refusing `refuse`. */
  readonly check: (input: { runId: string; agentId: string; turn: ReflectTurn; outcome: "completed" | "failed"; refuse: readonly string[] }) => Promise<Checked>;
  /** A new run's id, for the learning run. */
  readonly newRunId: () => string;
  /** The grade model the server names (learning.ts gradeModelOf: --grade-model, AGENTRUN_SERVE_GRADE_MODEL, else
   *  AGENT_MODEL_STRONG), carried on the learning run's launch; none, the agent's own model grades it, as main's. */
  readonly gradeModel?: string;
  /** The turn's deadline. Default REFLECT_TIMEOUT_MS. Its re-ask is inside it. */
  readonly deadlineMs?: number;
  /** For tests: the clock the turn's deadline is measured by. Default Date.now. */
  readonly now?: () => number;
}

/** A learning dropped before its turn answered: kept with its reason and words, beside the end. */
const droppedRow = (turn: ReflectTurn | null, reason: string, detail: string, extra: object = {}): AlsoRow => ({ table: "learning_proposals", row: { turn, proposal: { ...extra, state: "dropped", reason, detail } } });

/** A kept-learning row with every string in it cut of `refuse` in every form (learn/secrets.ts redactSecrets, as
 *  proposeRun cuts what the person said): the turn as it answered, and the proposal's words. A proposal the checks kept
 *  holds none of them already (unstorable refuses it whole). */
const cutRow = (row: AlsoRow, refuse: readonly string[]): AlsoRow =>
  row.table === "learning_proposals" && refuse.length ? { table: row.table, row: cutStrings(row.row, (text) => redactSecrets(text, refuse, Number.POSITIVE_INFINITY)) as typeof row.row } : row;

/** The end-of-run turn for runs that learn. */
export function createReflectHook(deps: ReflectDeps): EndOfRunTurn {
  return async (input) => {
    const facts = await deps.facts(input.runId);
    if (!facts.learns) return undefined;
    // closeLearning for a run cut before it could look back: a person's stop, before or during the turn, or a fault.
    if (input.cut === "stopped") return { also: [droppedRow(null, "cancelled", said.stopped(STOPPED.cancelled))] };
    if (input.cut === "stopped-looking") return { also: [droppedRow(null, "cancelled", said.stopped(STOPPED.cancelledLooking))] };
    if (input.cut === "faulted") return { also: [droppedRow(null, "crashed", said.stopped(STOPPED.crashed))] };
    // reflectSkip: the cap keeps no reserve; a run its cap stopped has no room left, and one whose spend is unknown
    // cannot be kept within its cap.
    if (facts.cancelled) return { also: [droppedRow(null, "cancelled", said.stopped(STOPPED.cancelled))] };
    if (facts.capReached) return { also: [droppedRow(null, "no_budget", said.noBudget)] };
    if (facts.capUsd !== undefined && facts.costUsd === null) return { also: [droppedRow(null, "unknown_cost", said.unknownCost)] };
    const now = deps.now ?? Date.now;
    // When the job answered and what it cost (learning-run.ts setLearning "reflecting"): as the turn starts, the run's
    // spend so far is the job's.
    const answeredAt = new Date(now()).toISOString();
    const job = facts.costUsd;
    // closeLearning: what looking back cost, the run's spend once the turn closed (its re-ask included) less the job's,
    // unknown when either is. Kept with every end the turn reaches from here, beside when the job answered and its cost.
    const looked = async (rows: { readonly also: readonly AlsoRow[] }) => {
      const total = (await deps.facts(input.runId)).costUsd;
      const answered = { answered_at: answeredAt, job_cost_usd: job, look_back_usd: total === null || job === null ? null : Math.max(0, Math.round((total - job) * 1e9) / 1e9) };
      return { also: rows.also.map((row): AlsoRow => (row.table === "learning_proposals" ? { ...row, row: { ...row.row, proposal: { ...(row.row as { proposal: object }).proposal, ...answered } } } : row)) };
    };
    // What the run must never learn, read once, before it is asked anything: a run whose list can't be read learns
    // nothing, never over a shorter one.
    // A list that could not be read at all (the store's saved keys, say) is a fault, said as one; one the run's handed mark
    // can't be read back for says so.
    const read = deps.refuse ? await deps.refuse(input.runId).catch(() => "failed" as const) : [];
    const refuse = read === "unreadable" || read === "failed" ? [] : read;
    // Every end from here closes through this one function: looked's timings first, then the cut LAST, over every
    // string the kept rows hold, whatever looked adds now or later.
    const close = async (rows: AlsoRow[]) => ({ also: (await looked({ also: rows })).also.map((row) => cutRow(row, refuse)) });
    if (read === "unreadable") return close([droppedRow(null, "propose_failed", said.stopped(STOPPED.signInUnread))]);
    if (read === "failed") return close([droppedRow(null, "propose_failed", said.stopped(STOPPED.notChecked))]);
    const { active, tools } = await deps.promptFacts(input.runId, input.agentId);
    const deadlineMs = deps.deadlineMs ?? REFLECT_TIMEOUT_MS;
    const started = now();
    const end = await input.ask(reflectPrompt({ dir: LEARNED_DIR, active, tools }), { origin: "reflect", deadlineMs });
    // closeLearning: how the turn ended.
    if ("timedOut" in end) return close([droppedRow(null, "reflect_timeout", said.stopped(STOPPED.timedOut))]);
    if ("failed" in end) return close([CAP_REFUSAL.test(end.failed.message) ? droppedRow(null, "no_budget", said.noBudget) : droppedRow(null, "reflect_failed", said.stopped(STOPPED.failed))]);
    const said_ = await deps.asked(input.runId);
    const turnOf = (answer: string): ReflectTurn => ({ answer, asked: [...said_.asked], ...(said_.triggered?.length ? { triggered: said_.triggered } : {}) });
    const checkOf = async (turn: ReflectTurn): Promise<Checked | undefined> => {
      try {
        return await deps.check({ runId: input.runId, agentId: input.agentId, turn, outcome: input.outcome, refuse });
      } catch {
        return undefined;
      }
    };
    let turn = turnOf(end.answer);
    let checked = await checkOf(turn);
    if (!checked) return close([droppedRow(turn, "propose_failed", said.stopped(STOPPED.notChecked))]);
    // An answer the parser refused is asked for again once, in the same turn, saying why in the parser's own words: the
    // second answer is checked as the first was, and refused again it is dropped as before. Never a third time, and only
    // within the turn's own deadline; a re-ask that times out or fails leaves the first answer's drop.
    if (checked.state === "dropped" && checked.reason === "unparsed") {
      const left = deadlineMs - (now() - started);
      const again = left > 0 ? await input.ask(reflectAgain(checked.detail), { origin: "reflect", deadlineMs: left, again: true }) : undefined;
      if (again && "ended" in again) {
        turn = turnOf(again.answer);
        checked = await checkOf(turn);
        if (!checked) return close([droppedRow(turn, "propose_failed", said.stopped(STOPPED.notChecked))]);
      }
    }
    if (checked.state === "dropped") {
      const detail = checked.reason === "empty" ? said.empty : checked.reason === "unparsed" ? said.unparsed : said.checker(checked.problems as never);
      return close([droppedRow(turn, checked.reason, detail, checked)]);
    }
    return close([
      { table: "learning_proposals", row: { turn, proposal: { ...checked, detail: said.proposed(checked.notes, checked.skills, checked.workflows) } } },
      { table: "learning_run", row: { id: deps.newRunId(), ...(deps.gradeModel ? { model: deps.gradeModel } : {}) } },
    ]);
  };
}
