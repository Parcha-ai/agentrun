// The line every harness's system prompt starts with: today's date in the run's time zone, and where the run works. A
// model knows only the date its training ended, so a question about "the latest" release is answered from then unless the
// run says what day it is. One line for every harness, made as each claim opens. pi re-makes its system prompt at each
// open; Codex adds its own current date to each turn's context; claude-agent's CLI resends the prompt recorded at the
// session's first request, so its harness tells a later day in that day's first turn (run-adapters-claude-agent
// harness.ts dateLine).
//
// The line carries no hour: it changes once a day, so a prompt cache holds within the day. The hour comes from the
// model's clock tool or a trigger's own line (triggers.ts inputOf).
import { validZone } from "./trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";

/** A zone this server's ICU knows, else UTC. */
const known = (zone: string | undefined): string => (zone !== undefined && validZone(zone) ? zone : "UTC");

/** This server's zone (TZ), UTC when that is not one ICU knows. */
export const serverZone = (): string => known(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** `at`'s day as a person in `zone` reads it ("Sunday 15 November 2026"); an unknown zone reads as UTC. */
export function dayIn(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: known(zone), weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(at)
    .replace(",", "");
}

/** The zone a run's day is told in: its trigger's when a schedule started it, else this server's (TZ), else UTC. */
export async function runZone(
  store: { triggers: { get(id: string): Promise<{ source: unknown } | undefined | null> } },
  origin?: { kind: string; trigger_id?: string },
): Promise<string> {
  if (origin?.kind === "trigger" && origin.trigger_id !== undefined) {
    const row = await store.triggers.get(origin.trigger_id);
    const source = row?.source as { kind?: string } | undefined;
    const zone = source?.kind === undefined ? undefined : TRIGGER_ADAPTERS.find((a) => a.id === source.kind)?.zone?.(source as never);
    if (zone !== undefined) return known(zone);
  }
  return serverZone();
}

/**
 * The environment line on `now`'s day in `zone` (default: this server's zone, UTC when that is not valid). `folder`, the
 * run's folder by its absolute name, is told when the shell's home is elsewhere (a computer's own home, such as /work), so
 * a file the run keeps is written in the folder rather than in the home directory, where no one reads it.
 */
export function environmentLine(now: Date = new Date(), zone: string = serverZone(), folder?: string): string {
  const named = known(zone);
  const where = folder === undefined
    ? "your workspace is your working directory, and file paths are relative to it."
    : `your workspace is your working directory, ${folder}, and file paths are relative to it. Only files under ${folder} are the run's files: save what the run keeps there, not in your home directory.`;
  return `Today is ${dayIn(now, named)} (${named}). You are running on AgentRun; ${where}`;
}
