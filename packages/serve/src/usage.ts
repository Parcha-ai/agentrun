// What learning spends outside any run, for GET /usage's `learning` meter: a run's grade (its grader on the agent's
// model, and the injection screen when Jev is its judge) runs on the host after the run has ended, so it is in no run's
// journal and no run's total. Each grade is booked once, after its result is kept in the run's serve.json, as one line
// of `<data>/learning-usage.jsonl`: the run, its agent, when, the dollars (null when unknown, never 0) and the tokens. A
// line is read once per run: a booking written again (a restart that found its run's grade kept and its line maybe
// missing) is not counted twice.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tokens } from "./learning.js";
import { isObject } from "./validate.js";

export type Booking = { run: string; agent: string; at: string; usd: number | null; tokens: Tokens | null };

const ledger = (data: string) => join(data, "learning-usage.jsonl");

/** Every booking, one per run (its first line): a line cut short by a crash, or out of shape, is skipped. */
export async function bookings(data: string): Promise<Booking[]> {
  const text = await readFile(ledger(data), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  const out = new Map<string, Booking>();
  for (const line of text.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || typeof entry.run !== "string" || typeof entry.agent !== "string" || typeof entry.at !== "string" || !(entry.usd === null || typeof entry.usd === "number")) continue;
    if (!out.has(entry.run)) out.set(entry.run, entry as Booking);
  }
  return [...out.values()];
}

/** Books one run's grade. A ledger line starts on a line of its own, so one a crash cut short spoils nothing after it. */
export const book = (data: string, entry: Booking): Promise<void> => appendFile(ledger(data), `\n${JSON.stringify(entry)}\n`, { mode: 0o600 });
