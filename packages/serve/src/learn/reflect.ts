// What a host asks of an agent once its run has answered or failed: one more turn in the same session, in which the agent
// may add notes to its run's copy of its learning folder, with its own tools. The host checks what it added (check.ts),
// a grader judges it (grade.ts), and the host merges it, rebuilding the index; the agent never edits what is there.
import { INDEX_FILE, INDEX_LINES } from "./notes.js";

/** Control and invisible characters: none may reach the prompt through a value the host puts in it. */
const UNSEEN = /[\p{Cc}\p{Cf}]/u;

/** The end-of-run turn's message. `dir` is the run's copy of the folder relative to the run's workspace (`.learning`),
 *  where every harness's file tools resolve a relative path: the prompt never names a path of the host's, which a box
 *  would not see. `active` is how many notes are active in it, so how many lines the index has left. */
export function reflectPrompt(options: { dir: string; active: number }): string {
  const { dir, active } = options;
  if (typeof dir !== "string" || dir === "" || dir.startsWith("/") || UNSEEN.test(dir)) throw new Error("the directory must be a path relative to the run's workspace, with no control or unseen characters");
  if (!Number.isSafeInteger(active) || active < 0) throw new Error("the count of active notes must be a whole number, 0 or more");
  const left = Math.max(0, INDEX_LINES - active);
  return [
    "The task is done. Before the run ends, keep what this run taught you that will help in later runs, if anything.",
    "",
    `Your notes from earlier runs are in \`${dir}/\`, in your working directory: one file per note, and ${INDEX_FILE}, their`,
    `index. To keep something new, add one file there for each memory, named for its topic (\`${dir}/refund-policy-path.md\`),`,
    "in this format:",
    "",
    "---",
    "name: A short title",
    "description: One line that says when it applies",
    "type: user, feedback, project or reference",
    "---",
    "The memory itself, in a few lines.",
    "",
    "The type is `user` for who the user is and what they prefer, `feedback` for how they want the work done, `project`",
    "for facts about the work, and `reference` for where to find things. To replace a memory, add a new file with",
    "`supersedes: [old-file.md]` in its front matter. Never edit or delete a file that is there, and leave",
    `${INDEX_FILE} alone: the host rebuilds it.`,
    "",
    left > 0
      ? `The index has room for ${left} more ${left === 1 ? "line" : "lines"}, one per note.`
      : "The index is full: replace a memory rather than add one.",
    "Writing nothing is fine: most runs teach nothing new.",
    "",
    "Do not keep setup or environment failures, that a tool does not work, one-off events, or names, ids, dates or",
    "amounts from this run's input.",
  ].join("\n");
}
