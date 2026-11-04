// The learning ledger, `<data>/learning-usage.jsonl`: one line per run whose learning ended (merged or dropped), written
// once its serve.json holds that end. GET /v2/stats counts from it how the runs that tried to learn fared, and GET
// /usage's `learning` meter reads from it what learning spent outside any run, so neither opens a run's files. A line
// holds the run, its agent, how its learning ended and when, how many notes it started from, when its answer was final
// and what its job and its look-back cost (GET /v2/agents/{id}/learning's `impact` reads these), and what its grade
// spent on the host after the run (the
// grader on the agent's model, and the injection screen when Jev is its judge), which is in no run's journal and no
// run's total: `cost` in dollars and `tokens`, each null when unknown, never 0, and 0 when nothing was graded. A run's
// learning ends once and never moves again, so a line is read once per run: one written again (a restart that found
// its run's end saved and its line maybe missing) is not counted twice.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Learning, LEARNING_REASONS, type LearningReason, NO_TOKENS, type Tokens } from "./learning.js";
import { isObject } from "./validate.js";

/** On a line written since they were kept (learning.ts Learning): `seed_notes`, how many notes the run started from;
 *  `answered_at` and `job_cost_usd`, when its job's answer was final and what it had cost then, once it looked back;
 *  `look_back_usd`, what looking back cost (0 when it did not; null when unknown). */
export type Outcome = { run: string; agent: string; state: "merged" | "dropped"; reason: LearningReason | null; at: string; cost: number | null; tokens: Tokens | null; seed_notes?: number; answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null };
type Ended = Learning & { state: "merged" | "dropped" };

const ledger = (data: string) => join(data, "learning-usage.jsonl");

/** Whether a run's learning has ended: merged or dropped, which never moves again. */
export const ended = (learning: Learning | undefined | null): learning is Ended => learning?.state === "merged" || learning?.state === "dropped";

/** The line of run `run` of agent `agent`, whose learning ended as `learning` says. */
export const outcomeOf = (run: string, agent: string, learning: Ended): Outcome => ({
  run, agent, state: learning.state, reason: learning.reason, at: learning.at,
  ...(learning.cost_usd ? { cost: learning.cost_usd.grade, tokens: learning.tokens?.grade ?? null } : { cost: 0, tokens: { ...NO_TOKENS } }),
  ...(isCount(learning.seed_notes) ? { seed_notes: learning.seed_notes } : {}),
  ...(learning.answered_at === undefined ? { look_back_usd: 0 } : { answered_at: learning.answered_at, job_cost_usd: learning.job_cost_usd ?? null, look_back_usd: learning.look_back_usd ?? null }),
});
const isUsd = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Every run's line, by run (its first): a line cut short by a crash, or out of shape, is skipped. */
export async function outcomes(data: string): Promise<Map<string, Outcome>> {
  const text = await readFile(ledger(data), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  const out = new Map<string, Outcome>();
  for (const line of text.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || typeof entry.run !== "string" || typeof entry.agent !== "string" || typeof entry.at !== "string") continue;
    if ((entry.state !== "merged" && entry.state !== "dropped") || !(entry.reason === null || (LEARNING_REASONS as readonly unknown[]).includes(entry.reason))) continue;
    if (!(entry.cost === null || typeof entry.cost === "number")) continue;
    if (entry.seed_notes !== undefined && !isCount(entry.seed_notes)) delete entry.seed_notes;
    if (entry.answered_at !== undefined && (typeof entry.answered_at !== "string" || !Date.parse(entry.answered_at))) delete entry.answered_at;
    for (const key of ["job_cost_usd", "look_back_usd"] as const) if (entry[key] !== undefined && !isUsd(entry[key])) delete entry[key];
    if (!out.has(entry.run)) out.set(entry.run, entry as Outcome);
  }
  return out;
}

/** Writes one run's line. A line starts on a line of its own, so one a crash cut short spoils nothing after it. */
export const record = (data: string, outcome: Outcome): Promise<void> => appendFile(ledger(data), `\n${JSON.stringify(outcome)}\n`, { mode: 0o600 });
