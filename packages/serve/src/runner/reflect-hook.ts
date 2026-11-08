// The learning lane's end-of-run turn on the runner (loop-contract.ts EndOfRunTurn), the server's rules moved
// (learning-run.ts reflectSkip, reflect, closeLearning; propose.ts proposeRun's checks through `check`): whether a run
// looks back, its prompt, how its turn ended, and the rows that keep its learning beside the run's end. A proposal is
// kept with the turn that gave it (learning_proposals) and queues one learning run (learning_run) that grades and merges
// it; a learning dropped at any step is kept with its reason and words, and queues none.
import { reflectPrompt } from "../learn/index.js";
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
  /** proposeRun's checks over the turn, against the seed the run started from. */
  readonly check: (input: { runId: string; agentId: string; turn: ReflectTurn; outcome: "completed" | "failed" }) => Promise<Checked>;
  /** A new run's id, for the learning run. */
  readonly newRunId: () => string;
  /** The turn's deadline. Default REFLECT_TIMEOUT_MS. */
  readonly deadlineMs?: number;
}

/** A learning dropped before its turn answered: kept with its reason and words, beside the end. */
const droppedRow = (turn: ReflectTurn | null, reason: string, detail: string, extra: object = {}): AlsoRow => ({ table: "learning_proposals", row: { turn, proposal: { ...extra, state: "dropped", reason, detail } } });

/** The end-of-run turn for runs that learn. */
export function createReflectHook(deps: ReflectDeps): EndOfRunTurn {
  return async (input) => {
    const facts = await deps.facts(input.runId);
    if (!facts.learns) return undefined;
    // reflectSkip: the cap keeps no reserve; a run its cap stopped has no room left, and one whose spend is unknown
    // cannot be kept within its cap.
    if (facts.cancelled) return { also: [droppedRow(null, "cancelled", said.stopped(STOPPED.cancelled))] };
    if (facts.capReached) return { also: [droppedRow(null, "no_budget", said.noBudget)] };
    if (facts.capUsd !== undefined && facts.costUsd === null) return { also: [droppedRow(null, "unknown_cost", said.unknownCost)] };
    const { active, tools } = await deps.promptFacts(input.runId, input.agentId);
    const end = await input.ask(reflectPrompt({ dir: LEARNED_DIR, active, tools }), { origin: "reflect", deadlineMs: deps.deadlineMs ?? REFLECT_TIMEOUT_MS });
    // closeLearning: how the turn ended.
    if ("timedOut" in end) return { also: [droppedRow(null, "reflect_timeout", said.stopped(STOPPED.timedOut))] };
    if ("failed" in end) return { also: [CAP_REFUSAL.test(end.failed.message) ? droppedRow(null, "no_budget", said.noBudget) : droppedRow(null, "reflect_failed", said.stopped(STOPPED.failed))] };
    const said_ = await deps.asked(input.runId);
    const turn: ReflectTurn = { answer: end.answer, asked: [...said_.asked], ...(said_.triggered?.length ? { triggered: said_.triggered } : {}) };
    let checked: Checked;
    try {
      checked = await deps.check({ runId: input.runId, agentId: input.agentId, turn, outcome: input.outcome });
    } catch {
      return { also: [droppedRow(turn, "propose_failed", said.stopped(STOPPED.notChecked))] };
    }
    if (checked.state === "dropped") {
      const detail = checked.reason === "empty" ? said.empty : checked.reason === "unparsed" ? said.unparsed : said.checker(checked.problems as never);
      return { also: [droppedRow(turn, checked.reason, detail, checked)] };
    }
    return {
      also: [
        { table: "learning_proposals", row: { turn, proposal: { ...checked, detail: said.proposed(checked.notes, checked.skills, checked.workflows) } } },
        { table: "learning_run", row: { id: deps.newRunId() } },
      ],
    };
  };
}
