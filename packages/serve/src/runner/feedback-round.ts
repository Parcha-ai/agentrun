// A grade's feedback round: what a run's grade (PUT /runs/{id}/grade, a person's feedback or an eval's label) asks of its
// learning, and how the run's next end reads it. The run's path is who wrote its final answer, so a grade never makes
// the agent answer the job again:
//   - a run its learned workflow answered alone (path `workflow`), graded right or wrong: the grade is kept and nothing else happens: no round, no turn, $0. One wrong answer is one sample;
//   - a run the agent finished (path `agent` or `handed_back`) graded with words (`label`): a correction round on them.
//     The run opens again on it: the grade's words are on its record, the agent is asked no turn of the job's, and the
//     run goes straight to its end-of-run step, which appends the words to corrections.md as one line (and compiles, when
//     a compile is due). Its spend is learning spend.
// A grade with neither asks for nothing more. The server writes the round's steer (server.ts gradeRun, runs.reopen); the
// adapter loop takes it (adapter-loop.ts steer: a FEEDBACK entry, no turn), and the end-of-run step reads it
// (learning-end.ts: heard, never "nothing new"; adapter-loop.ts askEndOfRun: feedbackAsk before the prompt).
import { type Grade, markGradeRound, putGrade } from "../learn/promote.js";
import type { RunPath } from "../learning-cost.js";
import { readLaunchBody } from "../run-launch.js";
import { type Command, RunFinal, type Store } from "../store/store.js";
import { KINDS } from "./journal-kinds.js";
import { commandRequest } from "./loop.js";

export const FEEDBACK_ROUNDS = ["correction"] as const;
export type FeedbackRound = (typeof FEEDBACK_ROUNDS)[number];

/** A feedback round, as its steer's body carries it (`feedback`) and its FEEDBACK entry keeps it: the round, whether the
 *  grade said right, and the grade's words (`text`). */
export interface FeedbackData {
  readonly round: FeedbackRound;
  readonly correct: boolean;
  readonly text: string;
}

/** What a grade asks for: `correction` for a graded run the agent finished when the grade has words, else none
 *  (undefined): a run its learned workflow answered alone opens none, right or wrong (its grade is kept). A replay run
 *  is never graded. */
export function feedbackRoundOf(grade: { readonly path: RunPath }, label: string | undefined): FeedbackRound | undefined {
  return (grade.path === "agent" || grade.path === "handed_back") && label ? "correction" : undefined;
}

/** The feedback round a steer's body asks for (`body.feedback`, the server's own: server.ts gradeRun writes it, and the
 *  message API never does), else undefined. */
export function feedbackOf(body: unknown): FeedbackData | undefined {
  const fed = (body as { feedback?: unknown; text?: unknown } | null)?.feedback as Partial<FeedbackData> | undefined;
  const text = (body as { text?: unknown } | null)?.text;
  if (!fed || typeof fed !== "object" || !FEEDBACK_ROUNDS.includes(fed.round as FeedbackRound) || typeof fed.correct !== "boolean" || typeof text !== "string") return undefined;
  return { round: fed.round as FeedbackRound, correct: fed.correct, text };
}

/** The feedback round the run's root `entries` say its next end closes: its newest FEEDBACK entry when no end came after
 *  it, else undefined. */
export function pendingFeedbackOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): FeedbackData | undefined {
  const at = entries.findLastIndex((entry) => entry.kind === KINDS.feedback);
  if (at < 0 || entries.slice(at + 1).some((entry) => entry.kind === KINDS.end)) return undefined;
  return feedbackOf({ feedback: entries[at]!.data, text: (entries[at]!.data as { text?: unknown } | undefined)?.text });
}

/** What the end-of-run turn of a feedback round is told before its prompt: the grade and its words. */
export function feedbackAsk(feedback: FeedbackData): string {
  return [`A reviewer graded this run's answer ${feedback.correct ? "right" : "wrong"}. What they said:`, "", feedback.text].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

/** How a feedback round stands (GET /runs/{id}/learning `graded.feedback_status`): `running` until it settles; `ended`,
 *  its run took the grade's words and ended after them; `not_run`, its run ended before it took them. */
export const FEEDBACK_STATUSES = ["running", "ended", "not_run"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** How the feedback round opened on steer `command` (store.runs.reopen's row, read now) stands, never by a clock:
 *  - `ended`: in its run's root `entries`, the FEEDBACK entry that took the steer (its requestId names the command) has
 *    the run's end entry after it, both in journal order (one writer, the run's runner);
 *  - `not_run`: no FEEDBACK entry took it and the row is refused. A runner writes nothing for the steer before that entry,
 *    so a reopened run that ends first (its claim refused, an end with nothing sent) leaves no trace of the round in its
 *    journal: its end's own commit refuses the row (the store's refuseLeftovers), in the same transaction as that end;
 *  - else `running`: the steer untaken (no runner took it yet; an end that left it so opened the run again with it), or
 *    taken with no end since, or a row that can't be read. */
export function feedbackStatus(entries: readonly { readonly kind: string; readonly data?: unknown }[], command: Pick<Command, "id" | "refused"> | undefined): FeedbackStatus {
  if (!command) return "running";
  const request = commandRequest(command.id);
  const at = entries.findIndex((entry) => entry.kind === KINDS.feedback && (entry.data as { requestId?: unknown } | undefined)?.requestId === request);
  if (at >= 0) return entries.slice(at + 1).some((entry) => entry.kind === KINDS.end) ? "ended" : "running";
  return command.refused !== null ? "not_run" : "running";
}

/** A feedback round opened: the round, and the steer command it opened the run again on (feedbackStatus reads how it
 *  stands). */
export interface OpenedRound {
  readonly round: FeedbackRound;
  readonly command: number;
}

/** Opens run `grade.run` again on the feedback round its grade asks for (feedbackRoundOf), with the grade's words
 *  (`label`), and says which, with its steer: only a run that learns (its launch's learning start,
 *  never one that only uses what was learned), whose runner supports managed feedback, neither archived nor of an archived
 *  agent (closed history: a grade of it starts no paid work), and one the store opens again (an agentic run that answered
 *  or that a person stopped). Null when the grade asks for nothing more, or the run can't be opened again (the grade is
 *  kept either way). */
export async function openFeedbackRound(store: Pick<Store, "runs" | "agents">, grade: Grade, label: string | undefined): Promise<OpenedRound | null> {
  const words = label?.trim() ? label.trim() : undefined;
  const round = feedbackRoundOf(grade, words);
  if (!round || !words) return null;
  const run = await store.runs.get(grade.run);
  if (!run || run.archivedAt !== null || (await store.agents.get(run.agentId))?.archivedAt !== null) return null;
  const launched = await store.runs.launch(grade.run).catch(() => undefined);
  const launch = launched ? readLaunchBody(launched.body) : undefined;
  // Source sessions and application-owned SDK tasks cannot consume a managed feedback steer.
  if (launch?.native || launch?.sdk) return null;
  const learning = launch?.learning;
  if (!learning || learning.use) return null;
  const feedback = { round, correct: grade.correct };
  try {
    const steer = await store.runs.reopen(grade.run, { kind: "steer", body: { text: words, feedback } });
    return { round, command: steer.id };
  } catch (error) {
    if (error instanceof RunFinal) return null;
    throw error;
  }
}

/** A grade's write (PUT /runs/{id}/grade): keeps `grade` for agent `agentId` naming no round, opens its run again on the
 *  round it asks for (openFeedbackRound), and only then marks the kept grade with that round and its steer. The grade is
 *  kept first, so the round's end reads it; the round is named last, so a reopen that fails (thrown, or a run that can't
 *  be opened again) leaves a grade naming none, never one claiming a round that didn't open. The grade as kept. */
export async function keepGrade(store: Pick<Store, "runs" | "agents" | "settings">, agentId: string, grade: Grade, label: string | undefined): Promise<Grade> {
  const kept = await putGrade(store.settings, agentId, { ...grade, feedback: null });
  const opened = await openFeedbackRound(store, kept, label);
  return opened ? markGradeRound(store.settings, agentId, kept, opened) : kept;
}
