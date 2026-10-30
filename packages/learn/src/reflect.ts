// What a host asks of an agent once its run has answered: one more turn in the same session, in which the agent writes
// its memo and notes into the learning repository with its own tools, as the reflect skill says. The host writes the
// memo's front matter; the agent writes the four sections under it. `reflectBudget` is the share of the run's cap held
// back for that turn.
import { MEMO_SECTIONS } from "./formats.js";
import { RUN_ID } from "./layout.js";

/** The share of a run's cap its reflection may spend, at most `REFLECT_MAX_USD`. */
export const REFLECT_SHARE = 0.1;
export const REFLECT_MAX_USD = 0.25;
/** The reflection's reserve for a run with no cap. */
export const REFLECT_UNCAPPED_USD = 0.05;

/** The reserve for a run's reflection, in dollars: a tenth of `capUsd`, at most $0.25; $0.05 when the run has no cap. */
export function reflectBudget(capUsd: number | undefined): number {
  if (capUsd === undefined) return REFLECT_UNCAPPED_USD;
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd <= 0) throw new Error("a run's cap must be a number of dollars above 0");
  // Rounded to 12 significant digits, never to fixed decimals: a cap above 0, however small, keeps a reserve above 0.
  return Math.min(REFLECT_MAX_USD, Number((capUsd * REFLECT_SHARE).toPrecision(12)));
}

/** Control and invisible characters: none may reach the prompt through a value the host puts in it. */
const UNSEEN = /[\p{Cc}\p{Cf}]/u;

/** The message a host sends once the run has answered. `run` is the run id, `dir` where the learning repository is
 *  checked out on `runs/<run>` with the memo's front matter already in `memos/<run>.md`. */
export function reflectPrompt(options: { run: string; dir: string }): string {
  const { run, dir } = options;
  if (typeof run !== "string" || !RUN_ID.test(run)) throw new Error("the run id is not one the learning layout accepts");
  if (typeof dir !== "string" || !dir.startsWith("/") || /\s/.test(dir) || UNSEEN.test(dir)) throw new Error("the directory must be an absolute path with no spaces or unseen characters");
  return [
    "The task is done. Before the run ends, reflect on it for your learning repository, following the reflect skill.",
    "",
    `The repository is checked out in ${dir}, on the branch runs/${run}. The memo memos/${run}.md is there with the host's`,
    "front matter: keep the front matter as it is, and write these sections below it, each once, in this order:",
    ...MEMO_SECTIONS.map((title) => `## ${title}`),
    "",
    "Add a note under learnings/ for each general rule this run taught you that would help on other inputs, add this run to",
    "the runs of each note that held again, and keep learnings/INDEX.md in step. Write no note when the run taught nothing",
    "general.",
    "",
    `Commit what you wrote on runs/${run} if you can run git here; never commit to main.`,
    "",
    "Write about the work, never about this case's data: never a name, an id, an amount, an address or a document from the",
    "input, and never a key or a password.",
  ].join("\n");
}
