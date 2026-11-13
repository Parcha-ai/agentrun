// Step guards in a learned workflow's run (the DSL's `guard` on a step, its WorkflowDeps.guardStep): after a guarded step
// ran, the chance it is right, p, from its signal; below its threshold the DSL escalates (kind `guard`) and the run hands
// the job back to its agent, in the same run, with the workflow's trace and the guard's row (#2603's hand-back).
//   - self: the step's own confidence (an agent or decide node submits one beside its record; a judge, pick or sift's is
//     its weakest answer's), read by the DSL.
//   - jev: one Jev call (TypeSafe's System One, JEV_GUARD_MODEL pinned) over the step's input and output, a yes/no
//     question (the guard's `question`, else DEFAULT_GUARD_QUESTION); its yes-probability is the signal. Asked as a
//     decision of the call (guardJevOn, over the learned workflow's own judge: learned-workflow.ts learnedJudge, the
//     run's decision providers, its gate on the provider jev, its one cap), so it is booked and capped as a decision
//     node's is: the workflow's cost.
//   - both: a logistic the job's graded runs fitted (`fit`: p = 1 / (1 + e^-(b + w·[self, jev])), raw probabilities in,
//     never logits), else the lower of the two. A single signal with a fit goes through it too (a Platt fit): a raw Jev
//     probability is badly calibrated until fitted (OG1: ECE 0.21 raw, 0.03 fitted), so a threshold is set on fitted p.
// No signal is no evidence the step is right: a guard whose Jev call failed, or a step that reported no confidence, has
// no p and hands back, never passes: so does a run with no Jev (no key, or jev set to deny). Every check is a row the
// run keeps (GuardRow, in its LEARNED_NODES entry's `guards`, never capped, and its metrics `guards`): B4's promotion replay and threshold refit
// read them.
import type { DecisionProvider, GuardStepParams, GuardVerdict, StepGuard, WorkflowDeps } from "@parcha/agentrun-dsl";
import { JEV_OPENROUTER_KEY_ENV } from "../decisions.js";
import type { GuardRow } from "../learned-nodes.js";

/** The Jev model a guard asks, pinned (https://docs.typesafe.ai/models, read 2026-11-13: jev-1.14.0 is current, and
 *  jev-latest points to it), by route: TypeSafe's own name, or OpenRouter's. A new Jev is a new pin and a new fit. */
export const JEV_GUARD_MODEL = { typesafe: "jev-1.14.0", openrouter: "typesafe/jev-1.14" } as const;
/** The question a jev guard asks when its guard names none. */
export const DEFAULT_GUARD_QUESTION = "Is this output correct for this input?";
/** The most bytes of a step's input and of its output a guard sends Jev, each: a longer one goes as its first part, said
 *  to be cut. */
export const GUARD_PART_BYTES = 24_000;
/** What the guard's yes and no mean to Jev. */
const GUARD_CRITERIA = { true: "the output is right for this input", false: "the output is wrong, incomplete, or not supported by the input" };
/** The question id a guard's request asks under. */
const GUARD_QUESTION_ID = "right";

/** One guard check, as the run keeps it (learned-nodes.ts GuardRow). */
export type { GuardRow };

/** One Jev request as a guard sends it: the step it guards (its label, its execution path, its item in a map), the
 *  state and its questions; answered with their answers. */
export type GuardJev = (request: { label: string; executionPath: string; item?: { index: number }; state: unknown; questions: Record<string, unknown>; signal?: AbortSignal }) => Promise<{ answers: Record<string, { type: string; noul?: number }> }>;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** p from a guard's signals: through its fit when it has one, else the one signal, or the lower of the two for both;
 *  null when a signal it reads is missing. */
export function guardP(guard: Pick<StepGuard, "signal" | "fit">, signals: { self: number | null; jev: number | null }): number | null {
  const x = guard.signal === "self" ? [signals.self] : guard.signal === "jev" ? [signals.jev] : [signals.self, signals.jev];
  if (x.some((value) => value === null || !Number.isFinite(value))) return null;
  const read = x as number[];
  const fit = guard.fit;
  if (fit && Array.isArray(fit.w) && fit.w.length === read.length) return sigmoid(fit.b + fit.w.reduce((sum, w, i) => sum + w * read[i]!, 0));
  return Math.min(...read);
}

/** A part of what a guard sends, whole up to GUARD_PART_BYTES, else its first part and how long it was. */
function part(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text, "utf8") <= GUARD_PART_BYTES) return value ?? null;
  return { cut: `${Buffer.from(text, "utf8").subarray(0, GUARD_PART_BYTES).toString("utf8")}…`, bytes: Buffer.byteLength(text, "utf8") };
}

/** A guard's Jev as a decision of the run: `judge` (the learned workflow's own, learned-workflow.ts learnedJudge: held to
 *  the run's gate on the provider jev, admitted on its one cap, settled at what it charged) asked of Jev, on the pinned
 *  model of `jev`'s route (its key's: TypeSafe's own, or OpenRouter's), under the step's label and execution path with
 *  `#guard`, so its receipt is its own. */
export function guardJevOn(judge: NonNullable<WorkflowDeps["runJudge"]>, jev: Pick<DecisionProvider, "needs">): GuardJev {
  const model = jev.needs.includes(JEV_OPENROUTER_KEY_ENV) ? JEV_GUARD_MODEL.openrouter : JEV_GUARD_MODEL.typesafe;
  return async (request) => (await judge({ label: `${request.label} guard`, kind: "judge", provider: "jev", model, state: request.state, questions: request.questions, executionPath: `${request.executionPath}#guard`, ...(request.item ? { item: request.item } : {}), ...(request.signal ? { signal: request.signal } : {}) } as never)) as never;
}

/** The DSL's guardStep for one learned_workflow call: Jev asked (`jev`; none: no Jev signal) only for a guard that reads
 *  it; p by guardP, NaN (no p, so the step hands back) when a signal it reads is missing. */
export function stepGuard(jev: GuardJev | undefined): (params: GuardStepParams) => Promise<GuardVerdict> {
  return async (params) => {
    const { guard } = params;
    let read: number | null = null;
    if (guard.signal !== "self" && jev) {
      try {
        const answered = await jev({ label: params.label, executionPath: params.executionPath, ...(params.item ? { item: params.item } : {}), state: { step: params.label, input: part(params.input), output: part(params.output) }, questions: { [GUARD_QUESTION_ID]: { type: "noul", instructions: guard.question?.trim() || DEFAULT_GUARD_QUESTION, criteria: GUARD_CRITERIA } }, ...(params.signal ? { signal: params.signal } : {}) });
        const noul = answered.answers?.[GUARD_QUESTION_ID]?.noul;
        read = typeof noul === "number" && Number.isFinite(noul) ? noul : null;
      } catch (error) {
        // A stop is the call's stop; any other failure (a refusal of the gate or the cap, Jev's own) leaves no Jev
        // signal, so the step hands back.
        if (params.signal?.aborted) throw error;
      }
    }
    const p = guardP(guard, { self: params.self, jev: read });
    return { p: p ?? Number.NaN, jev: read };
  };
}

/** A guard.evaluated event's detail as the run's row of it (GuardRow), under the step's label. */
export function rowOf(label: string, detail: unknown): GuardRow | undefined {
  const d = (detail ?? {}) as { signal?: unknown; threshold?: unknown; p?: unknown; self?: unknown; jev?: unknown; escalated?: unknown };
  if (d.signal !== "self" && d.signal !== "jev" && d.signal !== "both") return undefined;
  if (typeof d.threshold !== "number") return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const self = num(d.self);
  const jev = num(d.jev);
  return { node: label, signal: d.signal, ...(self === undefined ? {} : { self }), ...(jev === undefined ? {} : { jev }), p: num(d.p) ?? null, threshold: d.threshold, escalated: d.escalated === true };
}

/** A guard row in words, for the hand-back: what it read and where p fell against its threshold. */
export function guardLine(row: GuardRow): string {
  const said = (n: number | undefined | null) => (typeof n === "number" ? n.toFixed(2) : "none");
  const read = [row.self !== undefined || row.signal !== "jev" ? `its own confidence ${said(row.self)}` : "", row.signal !== "self" ? `Jev ${said(row.jev)}` : ""].filter(Boolean).join(", ");
  return `guard on "${row.node}" (${row.signal}): p ${said(row.p)} against threshold ${row.threshold} (${read}); ${row.escalated ? "handed back" : "passed"}`;
}
