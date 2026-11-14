// The runner's half of the end-of-run turn (the learning lane's reflect turn): its request id, the words a write or edit
// of its under work/.learning/ is refused with, and the path rule that refuses it. Its notes are kept only from its
// answer's note blocks, never from a file it writes there. The words and the rule are the tool gate's own
// (tool-gate.ts NOTE_ONLY_TEXT, underLearning), kept equal by a test.
import { posix, resolve, sep, join } from "node:path";
import { KINDS } from "./journal-kinds.js";

/** The prefix of the end-of-run turn's request id: the server's own (turns.ts REFLECT_REQUEST). */
export const REFLECT_PREFIX = "learn-reflect-";
/** The label a reader puts on the end-of-run turn's rows and messages: the server's (learning.ts LEARNING_LABEL). */
export const REFLECT_LABEL = "learning";

/** The end-of-run turn's request id, one per round of a run: pi answers a repeat of it from its submission, so a turn
 *  asked again on a later claim is never asked of the model twice. A run's first end is round 1; an end after a follow-up
 *  opened the run again is the next round, whose turn is asked of the model anew under an id of its own. The server's own
 *  prefix, so the run's readers tell the turn's rows apart by it (reflectRanges). */
export const reflectRequestId = (runId: string, again = false, round = 1) => `${REFLECT_PREFIX}${runId}${round > 1 ? `${REFLECT_ROUND}${round}` : ""}${again ? REFLECT_AGAIN : ""}`;
/** The suffix of the end-of-run turn's re-ask's request id (EndOfRunTurn ask's `again`): one per round too, so a repeat
 *  is answered from its submission, never asked of the model twice. */
export const REFLECT_AGAIN = ":again";
/** What names a later round in the end-of-run turn's request id, before its number. */
const REFLECT_ROUND = ":round-";

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
    const round = requestId.endsWith(REFLECT_AGAIN) ? requestId.slice(0, -REFLECT_AGAIN.length) : requestId;
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

/** The refusal of the end-of-run turn's write or edit under work/.learning/: the tool gate's one text (NOTE_ONLY_TEXT), so
 *  the adapter loop's refusal and the gate's are the same words. */
export { NOTE_ONLY_TEXT as REFLECT_NOTE_ONLY } from "../tool-gate.js";

/** The folder of a run's copy of what its agent learned, relative to its work. */
const LEARNED_DIR = ".learning";
/** A computer's work folder, as a box names it. */
const BOX_WORK = "/workspace";
/** The work a relative path resolves against when the run's own work folder is not known to the loop. */
const NO_WORK = "/.agentrun-run-work";

/** Whether `args.path`, as a file tool resolves it (a leading `@` dropped, Unicode spaces made plain, then lexically),
 *  names work/.learning/ or a path under it: by the run's `work` (when the loop knows it), or the box's. */
export function underLearning(work: string | undefined, args: unknown): boolean {
  const path = (args as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string") return false;
  const plain = path.replace(/[  -   　]/g, " ").replace(/^@/, "");
  const under = (base: string, at: string) => at === join(base, LEARNED_DIR) || at.startsWith(`${join(base, LEARNED_DIR)}${sep}`);
  const root = work ?? NO_WORK;
  return under(resolve(root), resolve(root, plain)) || under(BOX_WORK, posix.resolve(BOX_WORK, plain));
}

/** The tools whose write the end-of-run turn is refused under work/.learning/. */
export const WRITES = new Set(["write", "edit"]);

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
