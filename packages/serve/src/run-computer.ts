// A run's computer as the run read shows it: `computer: {kind, provider, state, why?}`. What the computer is doing comes
// from the runner that holds it, when it says; with no word from it, the run's own state says it. A run whose computer
// could not be had fails with the code computer_unavailable and the server's words, which the field carries as why.
import type { ComputerKind, ComputerSetting } from "./computer-setting.js";
import { COMPUTER_UNAVAILABLE } from "./computers.js";

/** What a computer is doing, as a run reads it. */
export type ComputerState = "starting" | "ready" | "taken_over" | "ended" | "failed";

/** What the runner holding a run's computer says of it now: its state, and why when failed. */
export interface ComputerLive {
  readonly state: ComputerState;
  readonly why?: string;
}

/** A run's state, as much of it as its computer's field reads. */
export type RunStateRead = { status: string; error?: { code: string; message: string } };

export type RunComputerField = { kind: ComputerKind; provider: string; state: ComputerState; why?: string };

const ENDED = new Set(["completed", "failed", "cancelled", "expired"]);

/** The run's `computer` field: absent for a run with none; its live state when its runner says it, else what the run's
 *  own state says (not started yet: starting; going: ready; over: ended, or failed with why when its computer could not
 *  be had). */
export function runComputerField(setting: ComputerSetting, run: RunStateRead, live?: ComputerLive): RunComputerField | undefined {
  if (setting.kind === "none") return undefined;
  const base = { kind: setting.kind, provider: setting.provider };
  if (run.error?.code === COMPUTER_UNAVAILABLE) return { ...base, state: "failed", why: run.error.message };
  if (ENDED.has(run.status)) return { ...base, state: "ended" };
  if (live) return { ...base, state: live.state, ...(live.why ? { why: live.why } : {}) };
  return { ...base, state: run.status === "queued" ? "starting" : "ready" };
}
