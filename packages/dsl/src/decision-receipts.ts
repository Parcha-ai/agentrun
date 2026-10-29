// Decision receipts: one record per typed-question request, holding what was asked, what came back, the
// rule that turns those answers into an action (its thresholds included) and the action itself. A receipt
// alone explains a decision: `rederiveDecision` recomputes the action from it without a model call.
import type { DecisionEvidence } from "./decision-provider.js";
import { answerConfidence, answersToValue, type CompiledQuestions, type ConfidenceSource, type SystemOneAnswer, type SystemOneQuestion } from "./system-one.js";

export const DECISION_RECEIPT_VERSION = 1;

/** The escalation kind of a decision its provider refused: the run ends `escalated` at stage "decision", for a person. */
export const DECISION_REFUSED = "decision_refused";

/** The escalation kind of a run whose decision was asked by an earlier process and never answered there: it is routed to
 *  review instead of being asked, and paid for, again. Its stage is `decision`. */
export const DECISION_INTERRUPTED = "decision_interrupted";

/** The typed questions the interpreter asks: the five question nodes and predicates, and a generative
 *  node's `verify` clause. */
export type DecisionKind = "judge" | "pick" | "sift" | "route" | "ask" | "verify";

/** How answers become the action, with every threshold applied. */
export type DecisionRule =
  /** judge: each question's decoded value (a choice, a yes/no at 0.5, a rounded score). */
  | { kind: "judge" }
  /** pick: the chosen option names an item by its position, or none. */
  | { kind: "pick"; options: string[]; none: string | null }
  /** route: the chosen branch, or the unsure branch when the choice's confidence is below `gte`. The chosen
   *  branch names one of `branches`; `unsure`, when set, judges its confidence against `gte`. `branches` is
   *  absent on a rule recorded before it was added, and such a rule skips the branch-membership check. */
  | { kind: "route"; branches?: string[]; unsure: { gte: number; branch: string } | null }
  /** sift: an item of this request is kept when its `keep` measure meets `gte`; every item without a keep
   *  rule. `items` counts this request's items; the action names them by their position in the request. */
  | { kind: "sift"; items: number; ids: string[]; keep: { id: string; measure: "confidence" | "value"; gte: number } | null }
  /** ask: the predicate holds when the yes-probability meets `gte`. */
  | { kind: "ask"; gte: number }
  /** verify: a yes/no question fails when its yes-probability is below its threshold (null: not judged).
   *  A failed question the submission holds is doubted; a failed one it lacks is unmet. */
  | { kind: "verify"; thresholds: Record<string, number | null>; present: string[] };

export type DecisionReceipt = {
  v: typeof DECISION_RECEIPT_VERSION;
  /** The request's identity: where it sits in the run (execution path, kind, position among its node's
   *  requests) and what it asked (questions and state). The same request asked again has the same id. */
  id: string;
  /** When the receipt was made, ISO 8601. */
  at: string;
  /** The label the request carried, a child workflow's prefix included. */
  node: string;
  kind: DecisionKind;
  /** The map item the request ran for, by index; null outside a map. */
  item: number | null;
  execution_path: string;
  /** This request among the requests its node makes at this path. A sift over the host's limits sends
   *  `count` requests, and `items` lists the positions in the sifted list this one covers, in the order it
   *  asked about them. A verify clause's nth review has index n - 1 and `count` is the most it may ask.
   *  Every other kind asks once. */
  request: { index: number; count: number; items?: number[] };
  /** `answered`: the answers came back and decided `action`. `failed`: the judge rejected, or its answers
   *  were refused. `cancelled`: the request's signal was aborted before it settled, so whether it was
   *  served is not known. */
  status: "answered" | "failed" | "cancelled";
  /** SHA-256 of the canonical JSON of the state the judge was given. */
  state_sha256: string;
  questions: Record<string, SystemOneQuestion>;
  /** What came back, as it came back; empty when nothing did. */
  answers: Record<string, SystemOneAnswer>;
  /** Null unless `status` is `answered`. */
  rule: DecisionRule | null;
  /** What the answers decide under `rule`; null unless `status` is `answered`. */
  action: unknown;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  request_sha256: string | null;
  /** Wall time of the judge call, in milliseconds. */
  latency_ms: number;
  /** The questions whose answer came back as a refusal, when any did. A refusal decodes to no value: the request is
   *  `failed` and the run escalates (DECISION_REFUSED), except a route with an `unsure` branch, which takes that branch. */
  refused?: string[];
  /** For each choice and score answer, whether its confidence is the provider's own or was derived from its
   *  probabilities; present when the judge said. */
  confidence_source?: Record<string, ConfidenceSource>;
  /** The provider that answered, when the host's judge names it or the node pins it. */
  provider?: string;
  /** The sources the provider grounded its answers in, unless the node said `evidence: "off"`; absent when it gave none. */
  evidence?: DecisionEvidence[];
  error?: string;
};

/** The action a receipt's answers and rule determine, recomputed without a model call: for an answered
 *  receipt it equals `receipt.action`. Null for a receipt that decided nothing. */
export function rederiveDecision(receipt: Pick<DecisionReceipt, "rule" | "answers" | "questions">): unknown {
  const rule = receipt.rule;
  const answers = receipt.answers as Record<string, any>;
  if (!rule) return null;
  switch (rule.kind) {
    case "judge": return answersToValue(receipt.answers, receipt.questions as CompiledQuestions);
    case "pick": {
      // An answered pick carries its pick answer; a receipt without one decided nothing.
      const answer = answers.pick;
      if (!answer || typeof answer !== "object") return null;
      const choice = answer.choice;
      // The choice must be a string that names an option, or the none option. Anything else (no string
      // choice, or a choice in neither set) is a malformed answer, never a fail-open {index: -1}.
      if (typeof choice !== "string") return null;
      const none = rule.none !== null && choice === rule.none;
      if (!none && !rule.options.includes(choice)) return null;
      return { index: none ? null : rule.options.indexOf(choice), none };
    }
    case "route": {
      // An answered route carries its branch answer; a receipt without one decided nothing.
      const answer = answers.branch;
      if (!answer || typeof answer !== "object") return null;
      // A refused route has no branch of its own: it took the unsure branch, and without one it decided nothing.
      if (answer.type === "refusal") return rule.unsure ? { branch: null, taken: rule.unsure.branch, unsure: true, refused: true } : null;
      const branch = answer.choice;
      // The chosen branch must be a string; when the rule carries `branches` (recorded since this check was
      // added) it must name one of them. A rule recorded before `branches` skips the membership check, so an
      // older route receipt re-derives as it did before, never throwing on a missing field.
      if (typeof branch !== "string" || (rule.branches && !rule.branches.includes(branch))) return null;
      // When unsure is set, judging SURE/UNSURE needs a finite numeric confidence. A missing or non-numeric
      // confidence must not compare false and re-derive as SURE (a fail-open onto the chosen branch).
      if (rule.unsure && !(typeof answer.confidence === "number" && Number.isFinite(answer.confidence))) return null;
      const unsure = Boolean(rule.unsure && answer.confidence < rule.unsure.gte);
      return { branch, taken: unsure ? rule.unsure!.branch : branch, unsure };
    }
    case "sift": {
      const kept: number[] = [];
      for (let i = 0; i < rule.items; i += 1) {
        if (!rule.keep) { kept.push(i); continue; }
        const answer = answers[`${i}.${rule.keep.id}`];
        const measure = !answer ? NaN : rule.keep.measure === "confidence" ? answerConfidence(answer) : answer.type === "noul" ? answer.noul : answer.type === "score" ? answer.score : NaN;
        if (Number.isFinite(measure) && measure >= rule.keep.gte) kept.push(i);
      }
      return { kept };
    }
    case "ask": return { holds: Number(answers.holds?.noul) >= rule.gte };
    case "verify": {
      const doubted: string[] = [];
      const unmet: string[] = [];
      for (const [id, threshold] of Object.entries(rule.thresholds)) {
        if (threshold === null) continue;
        // A field with a threshold needs its yes/no answer; a receipt missing one, or holding another shape, decided
        // nothing (null), never a fail-open "accepted".
        const answer = answers[id];
        // The answer must be a noul with a finite numeric probability. A noul-typed answer whose noul is
        // absent or not a finite number would compare NaN < threshold (false), reading as supported: a
        // fail-open one level down. It decided nothing.
        if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) return null;
        if (answer.noul < threshold) (rule.present.includes(id) ? doubted : unmet).push(id);
      }
      return { accepted: doubted.length === 0 && unmet.length === 0, doubted, unmet };
    }
  }
}
