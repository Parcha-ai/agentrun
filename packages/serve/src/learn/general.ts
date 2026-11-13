// The generality pre-check: before the grader reads what a run proposes, Jev (TypeSafe's System One, the provider a
// workflow's decision nodes use when they name none, on the same client and model) is asked one Noul per proposed note:
// does it hold for inputs of this job other than the one it came from? A note scored below the threshold (default
// GENERAL_THRESHOLD) rests on one input's names, ids, amounts or pages, and is dropped before the grader, its why said
// where a grader's drop is (the learning run's verdict items). Offline, on Run B's 388 kept MCC notes, this question
// agreed with an Opus label 97.4% of the time (kappa 0.95). It calls no model itself: the host passes the provider.
import { createHash } from "node:crypto";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import type { NoteText } from "./grade.js";
import { withoutRiskyMark } from "./notes.js";

/** The lowest Jev probability that a note holds beyond its one input at which it goes on to the grader. */
export const GENERAL_THRESHOLD = 0.5;
/** Where the host reads another threshold: a number from 0 to 1. */
export const GENERAL_THRESHOLD_ENV = "AGENTRUN_SERVE_LEARNING_GENERAL_THRESHOLD";
/** The most of the job's instructions, the run's input and the note the state holds, in UTF-16 units: well within one
 *  Jev request's 32k tokens a question. */
export const GENERAL_STATE_CAPS = Object.freeze({ job: 4_000, input: 8_000, note: 8_000 });
/** How long the check waits for Jev, every note's request included. */
export const GENERAL_DEADLINE_MS = 30_000;

/** The question, as the lead's spec states it. */
export const GENERAL_QUESTION = "Does `note` state a method, source, fact or preference that holds for inputs of this job other than `input`, the one it came from?";
export const GENERAL_CRITERIA = Object.freeze({
  true: "It holds for other inputs of this job: a method, a source, a fact about the job or the user's own world, or the user's standing preference.",
  false: "It rests on names, ids, amounts or pages of that one input: it would only help on that same input again.",
});

/** The threshold `env` names, else GENERAL_THRESHOLD. Any value that is not a number from 0 to 1 is an error. */
export function generalThresholdOf(env: NodeJS.ProcessEnv): number {
  const named = env[GENERAL_THRESHOLD_ENV]?.trim();
  if (!named) return GENERAL_THRESHOLD;
  const value = Number(named);
  if (!/^\d*\.?\d+$/.test(named) || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${GENERAL_THRESHOLD_ENV} is a number from 0 to 1, not ${named}`);
  return value;
}

/** What the check reads of the run a note came from: the agent's standing instructions (the job), and the run's input
 *  (the first message it was sent, else the first trigger's input). */
export type GeneralSource = { readonly job?: string; readonly input?: string };

const cut = (text: string | undefined, max: number) => (text === undefined ? "" : text.length > max ? `${text.slice(0, max)} [cut]` : text);

/** The one Jev request for `note`: its state (the job, the input, the note without its run's risky mark) and one Noul. */
export function generalRequest(note: NoteText, source: GeneralSource): { label: string; kind: "judge"; state: Record<string, string>; questions: { general: { type: "noul"; instructions: string; criteria: { true: string; false: string } } } } {
  return {
    label: `learning: general ${note.file}`,
    kind: "judge",
    state: { job: cut(source.job, GENERAL_STATE_CAPS.job), input: cut(source.input, GENERAL_STATE_CAPS.input), note: cut(withoutRiskyMark(note.text), GENERAL_STATE_CAPS.note) },
    questions: { general: { type: "noul", instructions: GENERAL_QUESTION, criteria: { ...GENERAL_CRITERIA } } },
  };
}

/** Each note's probability that it holds beyond its one input, by file, and what the requests cost (null once any is
 *  unknown). */
export type GeneralScores = { readonly scores: Readonly<Record<string, number>>; readonly usd: number | null };

/** What a learning run's end says when the check could not run (its provider's error stays in the run's journal and the
 *  runner's log, never here). */
export const GENERAL_UNCHECKED = "The generality check could not run, so the grader read every note.";

/** Asks `jev` the question of each note, one request a note, all at once. Throws when any request fails or answers out of
 *  shape, whatever the others answered: the caller grades every note as it would without the check, never drops one on an
 *  error, and books what the check spent as unknown (null), never 0, since a request that failed may still have been
 *  charged and the others were. */
export async function generalScores(jev: DecisionProvider, notes: readonly NoteText[], source: GeneralSource, signal: AbortSignal, run: string): Promise<GeneralScores> {
  const bound = AbortSignal.any([signal, AbortSignal.timeout(GENERAL_DEADLINE_MS)]);
  const answers = await Promise.all(notes.map(async (note) => {
    const request = generalRequest(note, source);
    const decisionId = createHash("sha256").update(`agentrun-learn general ${run} ${note.file} ${note.text}`).digest("hex").slice(0, 32);
    const outcome = await jev.decide(request, { decisionId, signal: bound, deadlineMs: GENERAL_DEADLINE_MS });
    const answer = outcome.answers.general as { type?: unknown; noul?: unknown } | undefined;
    if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error(`Jev's answer for ${note.file} is no probability`);
    return { file: note.file, p: answer.noul, usd: outcome.cost_usd };
  }));
  const usd = answers.reduce<number | null>((sum, { usd: one }) => (sum === null || one === null || !Number.isFinite(one) ? null : sum + one), 0);
  return { scores: Object.fromEntries(answers.map(({ file, p }) => [file, p])), usd };
}

/** The why of a note the check drops, in the host's words (no word of the note's). */
export const ONE_CASE = (p: number, threshold: number) =>
  `Jev rates it ${p.toFixed(2)} likely to hold for inputs other than the one it came from, under the bar of ${threshold}: it rests on that one input, so it was dropped before the grader.`;
