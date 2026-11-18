// The runner's half of the end-of-run turn (the learning lane's compile turn): its request id, and where its rounds are
// in a run's journal.
import { KINDS } from "./journal-kinds.js";

/** The prefix of the end-of-run turn's request id: the server's own (turns.ts REFLECT_REQUEST). */
export const REFLECT_PREFIX = "learn-reflect-";
/** The label a reader puts on the end-of-run turn's rows and messages: the server's (learning.ts LEARNING_LABEL). */
export const REFLECT_LABEL = "learning";

/** The end-of-run turn's request id, one per round of a run, and one per `step` of a round (the compile turn's attempts,
 *  `compile-<n>`): pi answers a repeat of it from its submission, so a turn asked again on a later claim is never asked of
 *  the model twice. A run's first end is round 1; an end after a follow-up opened the run again is the next round, whose
 *  turn is asked of the model anew under an id of its own. The server's own prefix, so the run's readers tell the turn's
 *  rows apart by it (reflectRanges). */
export const reflectRequestId = (runId: string, again = false, round = 1, step?: string) => `${REFLECT_PREFIX}${runId}${round > 1 ? `${REFLECT_ROUND}${round}` : ""}${step !== undefined ? `:${step}` : again ? REFLECT_AGAIN : ""}`;
/** The suffix of the end-of-run turn's re-ask's request id (EndOfRunTurn ask's `again`): one per round too, so a repeat
 *  is answered from its submission, never asked of the model twice. */
export const REFLECT_AGAIN = ":again";
/** What names a later round in the end-of-run turn's request id, before its number. */
const REFLECT_ROUND = ":round-";
/** What a round's re-ask or step adds to its request id (reflectRequestId): the round is the id without it. */
const REFLECT_STEP = /:(?:again|compile-\d+)$/;
/** The round shared by its re-ask and compile attempts, for range and durable accounting reads. */
export const reflectRoundId = (requestId: string): string => requestId.replace(REFLECT_STEP, "");

/** One round of a run's end-of-run turn in its journal: `from`, the entry its input placed (the turn's first); `until`, the
 *  run's end entry that closed it, once written. Every entry between is the turn's. */
export type ReflectRange = { readonly from: number; readonly until?: number };

/** Each round of the end-of-run turn in a run's journal, oldest first: each begins at the entry its input placed, from the
 *  input submissions under its request ids (its re-ask's within it); else, on a CLI harness, at the turn's prompt the CLI
 *  record wrote as it asked it (`entries`: adapter-loop.ts answering, an end-of-run-turn entry of the person's with its
 *  request id, written before the turn's submission, which only its answer writes). Each ends at the first end entry
 *  after it (the run's end that round closed with); the newest may not have ended yet. None for a run that asked none.
 *  A follow-up's messages, between one round's end and the next round, are no round's. */
export function reflectRanges(submissions: readonly { readonly type?: string; readonly requestId?: string; readonly entry?: unknown }[], entries: readonly { readonly kind?: string; readonly id?: unknown; readonly data?: unknown }[] = []): ReflectRange[] {
  const starts = new Map<string, number>();
  const note = (requestId: string, entry: number) => {
    if (!Number.isFinite(entry)) return;
    const round = reflectRoundId(requestId);
    starts.set(round, Math.min(starts.get(round) ?? entry, entry));
  };
  for (const record of submissions) {
    if (record.type === "input" && typeof record.requestId === "string" && record.requestId.startsWith(REFLECT_PREFIX) && record.entry !== undefined) note(record.requestId, Number(record.entry));
  }
  for (const entry of entries) {
    const data = entry.data as { role?: unknown; requestId?: unknown } | null | undefined;
    if (entry.kind === KINDS.endOfRunTurn && data?.role === "person" && typeof data.requestId === "string" && data.requestId.startsWith(REFLECT_PREFIX)) note(data.requestId, Number(entry.id));
  }
  const ends = entries.filter((entry) => entry.kind === KINDS.end).map((entry) => Number(entry.id)).sort((a, b) => a - b);
  return [...starts.values()].sort((a, b) => a - b).map((from) => {
    const until = ends.find((end) => end >= from);
    return until === undefined ? { from } : { from, until };
  });
}

/** Whether entry `entry` (a number) is one of `ranges`' end-of-run turns. */
export const inReflect = (ranges: readonly ReflectRange[], entry: number): boolean => ranges.some(({ from, until }) => entry >= from && (until === undefined || entry <= until));

/** The text an answer entry gave (pi's assistant entry): the text parts of the messages it adds to the model's context,
 *  joined. */
export function answerText(entry: { readonly model?: readonly unknown[] } | undefined): string {
  return (entry?.model ?? [])
    .flatMap((message) => {
      const content = (message as { content?: unknown } | null)?.content;
      return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [];
    })
    .map((part) => (part?.type === "text" ? part.text ?? "" : ""))
    .join("");
}
