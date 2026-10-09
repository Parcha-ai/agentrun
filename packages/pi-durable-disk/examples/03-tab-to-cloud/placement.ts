// Where the run should be: a typed question the server asks (TypeSafe Jev in the demo), not the agent's own tool call. On the
// user's message the server asks "Where should this run?"; when the agent's turn ends it asks again whether the task is done and
// where the agent should run now. The server places the run on the answer and says why in the agent's notice. The question and its
// criteria (one line per environment) live here and in the placer's module; the engine of the interpreter knows nothing of them.
// Portable: no Node API, and no Jev import (the runner is passed in).

export type PlacementPhase = "start" | "done";

/** One option of a decision, as the stage's card shows it. */
export interface PlacementOption {
  readonly id: string;
  readonly label: string;
  /** Jev's probability of this option; the options of one decision sum to 1 (within rounding). */
  readonly probability: number;
}

/** A decision the server took and announced (the `decision` pipe frame). */
export interface PlacementDecision {
  /** Unique per decision. */
  readonly id: string;
  readonly phase: PlacementPhase;
  readonly question: string;
  readonly options: readonly PlacementOption[];
  /** The id of the chosen option. */
  readonly choice: string;
  /** Measured by the server around the call, on its own clock. */
  readonly latency_ms: number;
  /** "jev": TypeSafe's answer; "scripted": a stand-in client, never presented as Jev's. */
  readonly model: "jev" | "scripted";
}

export interface PlacementQuery {
  readonly phase: PlacementPhase;
  /** The user's message that started the task. */
  readonly message: string;
  /** The environment the run is in now (an id). */
  readonly current: string;
  /** The ids of the environments the server can place the run in. */
  readonly environments: readonly string[];
  readonly signal?: AbortSignal;
}

export interface Placer {
  decide(query: PlacementQuery): Promise<PlacementDecision>;
  /** The one line why the placer prefers an environment, for the agent's notice. */
  describe(env: string): string;
}

export const PLACEMENT_QUESTIONS: Record<PlacementPhase, string> = {
  start: "Where should this run?",
  done: "The task is done; where should the agent run now?",
};

/** The judge adapter's shape (`runJudge` of the DSL), as far as the placer uses it. */
export type JudgeRunner = (params: {
  label: string;
  kind: "judge";
  state: unknown;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string | null> }>;
  signal?: AbortSignal;
}) => Promise<{ answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }>; model?: string | null }>;

export interface PlacerOptions {
  readonly runJudge: JudgeRunner;
  /** One line per environment id: what it can do. Ids the server does not offer are left out of the question. */
  readonly criteria: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  /** What the decisions are tagged: "jev" for the real client, "scripted" for any other. */
  readonly model: "jev" | "scripted";
  readonly now?: () => number;
}

let counter = 0;

/** A placer over a judge runner: one choice question per decision, criteria one line per environment. */
export function judgePlacer(options: PlacerOptions): Placer {
  const now = options.now ?? Date.now;
  return {
    describe: (env) => options.criteria[env] ?? env,
    async decide(query) {
      const ids = query.environments.filter((id) => options.criteria[id] !== undefined);
      if (ids.length === 0) throw new Error("no environment has a criterion");
      const criteria: Record<string, string> = {};
      for (const id of ids) criteria[id] = options.criteria[id]!;
      const question = PLACEMENT_QUESTIONS[query.phase];
      const started = now();
      const result = await options.runJudge({
        label: `placement-${query.phase}`,
        kind: "judge",
        state: { task: query.message, running_now_in: query.current, ...(query.phase === "done" ? { status: "the agent finished the task" } : {}) },
        questions: { where: { type: "choice", instructions: question, criteria } },
        ...(query.signal ? { signal: query.signal } : {}),
      });
      const latency_ms = now() - started;
      const answer = result.answers.where;
      if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || !answer.probabilities) throw new Error("the placement answer is not a choice with probabilities");
      if (!ids.includes(answer.choice)) throw new Error(`the placement answer ${answer.choice} is not one of ${ids.join(", ")}`);
      const options_: PlacementOption[] = ids.map((id) => ({ id, label: options.labels[id] ?? id, probability: answer.probabilities![id] ?? 0 }));
      if (options_.some((o) => !Number.isFinite(o.probability) || o.probability < 0 || o.probability > 1)) throw new Error("the placement probabilities are not within 0 to 1");
      return { id: `dec-${Date.now().toString(36)}-${(counter++).toString(36)}`, phase: query.phase, question, options: options_, choice: answer.choice, latency_ms, model: options.model };
    },
  };
}
