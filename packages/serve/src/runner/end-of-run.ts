// The runner's half of the end-of-run turn (the learning lane's reflect turn): its request id, the words a write or edit
// of its under work/.learning/ is refused with, and the path rule that refuses it. Its notes are kept only from its
// answer's note blocks, never from a file it writes there. The words and the rule are the tool gate's own
// (tool-gate.ts NOTE_ONLY_TEXT, underLearning), kept equal by a test.
import { posix, resolve, sep, join } from "node:path";

/** The prefix of the end-of-run turn's request id: the server's own (turns.ts REFLECT_REQUEST). */
export const REFLECT_PREFIX = "learn-reflect-";
/** The label a reader puts on the end-of-run turn's rows and messages: the server's (learning.ts LEARNING_LABEL). */
export const REFLECT_LABEL = "learning";

/** The end-of-run turn's request id, one per run: pi answers a repeat of it from its submission, so a turn asked again
 *  on a later claim is never asked of the model twice. The server's own prefix, so the run's readers tell the turn's
 *  rows apart by it (reflectFrom). */
export const reflectRequestId = (runId: string) => `${REFLECT_PREFIX}${runId}`;

/** Where the end-of-run turn began in a run's journal: the entry its input placed, from the input submission under the
 *  turn's request id; undefined before it is placed, or for a run that asked none. Every entry from it on, until the
 *  run's end, is the turn's (the server's labelled: after the entry before it). */
export function reflectFrom(submissions: readonly { readonly type?: string; readonly requestId?: string; readonly entry?: unknown }[]): number | undefined {
  const placed = submissions.filter((record) => record.type === "input" && typeof record.requestId === "string" && record.requestId.startsWith(REFLECT_PREFIX) && record.entry !== undefined);
  return placed.length ? Math.min(...placed.map((record) => Number(record.entry))) : undefined;
}

/** The refusal of the end-of-run turn's write or edit under work/.learning/. */
export const REFLECT_NOTE_ONLY = "A note is kept only from your answer: write it in a ```note block, not to a file.";

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
