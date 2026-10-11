// Who answers a message: the trained 1B in the tab, or the cloud model. Compute (where the run is) stays the placer's job; this only picks
// the brain. Offline, a rule: the tab answers (a request that needs the cloud is the 1B's to answer, by calling go_online). Online with no
// trained 1B yet, a rule: the cloud. Online with the 1B, a typed choice over two options, asked of TypeSafe Jev on the server: the option
// order is shuffled on every call (Jev leans to the first option), the 1B answers only when Jev picks it at or above `minLocalConfidence`,
// and an error or no answer within `timeoutMs` falls back to the cloud with the reason saying so. Each decision is one stage event, for
// the decision card. Portable: no Node API, and no Jev import (the runner is passed in, as the placer's is).

export type Brain = "tab-local" | "cloud";

export interface BrainState {
  /** The tab is online (the cloud is reachable). */
  readonly online: boolean;
  /** The trained 1B, when the tab has one loaded and ready to answer. */
  readonly localModel: { readonly id: string } | null;
}

export interface BrainDecision {
  readonly brain: Brain;
  /** One plain line for the decision card: why this brain answers. */
  readonly reason: string;
  /** Jev's probability of the brain it chose; null when a rule decided or Jev did not answer. */
  readonly confidence: number | null;
  readonly decidedBy: "jev" | "rule";
  /** Measured around the decision, on the server's clock. */
  readonly ms: number;
  /** Jev's probabilities, when Jev answered. */
  readonly probabilities?: { readonly local: number; readonly cloud: number };
  /** The model that answered the question ("scripted" for a stand-in client), when Jev was asked. */
  readonly judge?: string | null;
}

/** The judge adapter's shape (`runJudge` of the DSL, as `createJevRunner` returns it), as far as the router uses it. */
export type JudgeRunner = (params: {
  label: string;
  kind: "judge";
  state: unknown;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string | null> }>;
  signal?: AbortSignal;
}) => Promise<{ answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }>; model?: string | null }>;

export const BRAIN_QUESTION = "Who should answer this message?";
/**
 * The two options, one line each: the criteria of the choice. Measured live (scripts/brain-check.ts): with "anything needing the
 * internet" alone, Jev put `pip install` and `git push` in the tab (p 0.78 to 0.95); naming the network for both options sent them to
 * the cloud (p local 0.00 to 0.09) with every labelled case still right.
 */
export const BRAIN_CRITERIA: Readonly<Record<"local" | "cloud", string>> = {
  local: "a simple file or code task the small model can do here, on local files, with no network",
  cloud: "training, GPU, the internet (web, APIs, installing packages, git push or pull), or a big model",
};
export const DEFAULT_MIN_LOCAL_CONFIDENCE = 0.7;
export const DEFAULT_TIMEOUT_MS = 1_000;

export interface BrainRouterOptions {
  readonly runJudge: JudgeRunner;
  /** The 1B answers only when Jev picks it with at least this probability; below it, the cloud answers. */
  readonly minLocalConfidence?: number;
  /** Jev's answer is waited for this long; then the cloud answers. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** For the option order: a number in [0, 1). */
  readonly random?: () => number;
  /** The two options' lines (default BRAIN_CRITERIA). */
  readonly criteria?: Readonly<Record<"local" | "cloud", string>>;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** A router over a judge runner: `decide(message, state)` returns who answers, why, how sure, and who decided. */
export function brainRouter(options: BrainRouterOptions): { decide(message: string, state: BrainState, signal?: AbortSignal): Promise<BrainDecision> } {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const minLocal = options.minLocalConfidence ?? DEFAULT_MIN_LOCAL_CONFIDENCE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lines = options.criteria ?? BRAIN_CRITERIA;
  if (!(minLocal > 0 && minLocal <= 1)) throw new Error(`minLocalConfidence ${minLocal} is not in (0, 1]`);
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new Error(`timeoutMs ${timeoutMs} is not a positive whole number`);
  return {
    async decide(message, state, signal) {
      const started = now();
      const rule = (brain: Brain, reason: string): BrainDecision => ({ brain, reason, confidence: null, decidedBy: "rule", ms: now() - started });
      if (!state.online) return rule("tab-local", "offline: the model in this tab answers");
      if (!state.localModel) return rule("cloud", "no trained model in this tab yet");

      // The option order, shuffled per call: Jev leans to whichever option comes first.
      const order = random() < 0.5 ? (["local", "cloud"] as const) : (["cloud", "local"] as const);
      const criteria: Record<string, string> = {};
      for (const id of order) criteria[id] = lines[id];
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      const signals = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
      let result: Awaited<ReturnType<JudgeRunner>>;
      try {
        result = await Promise.race([
          options.runJudge({ label: "brain", kind: "judge", state: { message }, questions: { who: { type: "choice", instructions: BRAIN_QUESTION, criteria } }, signal: signals }),
          new Promise<never>((_, reject) => signals.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
        ]);
      } catch (e) {
        if (signal?.aborted) throw e; // the caller cancelled: no decision to announce
        return rule("cloud", deadline.signal.aborted ? `Jev did not answer within ${timeoutMs} ms, so the cloud answers` : `Jev failed (${(e as Error).message.slice(0, 80)}), so the cloud answers`);
      } finally {
        clearTimeout(timer);
      }
      const answer = result.answers.who;
      const p = answer?.probabilities;
      const local = p?.local, cloud = p?.cloud;
      const valid = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
      if (!answer || answer.type !== "choice" || (answer.choice !== "local" && answer.choice !== "cloud") || !valid(local) || !valid(cloud)) {
        return rule("cloud", "Jev's answer was not a choice with probabilities, so the cloud answers");
      }
      const base = { decidedBy: "jev" as const, probabilities: { local, cloud }, judge: result.model ?? null };
      if (answer.choice === "cloud") return { brain: "cloud", reason: "this needs the cloud", confidence: cloud, ms: now() - started, ...base };
      if (local < minLocal) return { brain: "cloud", reason: `Jev leaned to this tab at ${pct(local)}, under the ${pct(minLocal)} it takes, so the cloud answers`, confidence: local, ms: now() - started, ...base };
      return { brain: "tab-local", reason: "a simple task the model in this tab handles", confidence: local, ms: now() - started, ...base };
    },
  };
}

/** The stage event for one decision (beats 6 and 10's decision card): who answers, why, how sure, who decided. */
export function brainEvent(d: BrainDecision, labels: { readonly local: string; readonly cloud: string }) {
  return {
    event: "brain.decision" as const,
    brain: d.brain,
    answering: d.brain === "tab-local" ? labels.local : labels.cloud,
    reason: d.reason,
    confidence: d.confidence,
    decidedBy: d.decidedBy,
    ms: Math.round(d.ms),
    ...(d.probabilities ? { probabilities: d.probabilities } : {}),
  };
}
