// A run's computer as the run read shows it: `computer: {kind, provider, state, why?}`. The run's own state says where
// its computer is (not started yet: starting; going: ready; waiting on its person with its computer let go: released;
// over: ended), and a run whose computer could not be had
// fails with the code computer_unavailable and the server's words, which the field carries as why. Whether the owner
// has taken it over comes through the port ComputerStateOf, passed in where the run read is answered (server.ts, from
// the store-backed take-over's computerHoldOf).
import type { ComputerKind, ComputerSetting } from "./computer-setting.js";
import { COMPUTER_UNAVAILABLE } from "./computers.js";

/** What a computer is doing, as a run reads it. */
export type ComputerState = "starting" | "ready" | "taken_over" | "released" | "ended" | "failed";
/** The states of a computer its run still has. */
export const COMPUTER_UP: ReadonlySet<ComputerState> = new Set(["starting", "ready", "taken_over"]);

/** The port the run read's computer field reads: run `runId`'s computer state with the owner's hold, "taken_over" while
 *  the owner holds it, else `state` as given. */
export type ComputerStateOf = (runId: string, state: ComputerState) => ComputerState;

/** A run, as much of it as its computer's field reads. `released`: the run waits on its person (parked) and its claim let
 *  its computer go, none kept for its resume (workspace/computer-kept.ts). */
export type RunStateRead = { id: string; status: string; error?: { code: string; message: string }; released?: boolean };

export type RunComputerField = { kind: ComputerKind; provider: string; state: ComputerState; why?: string };

const ENDED = new Set(["completed", "failed", "cancelled", "expired"]);

/** The run's `computer` field: absent for a run with none; failed with why when its computer could not be had; ended
 *  once the run is over; released while it waits with its computer let go; else starting (queued) or ready (going),
 *  taken_over while the owner holds it (`stateOf`). */
export function runComputerField(setting: ComputerSetting, run: RunStateRead, stateOf?: ComputerStateOf): RunComputerField | undefined {
  if (setting.kind === "none") return undefined;
  const base = { kind: setting.kind, provider: setting.provider };
  if (run.error?.code === COMPUTER_UNAVAILABLE) return { ...base, state: "failed", why: run.error.message };
  if (ENDED.has(run.status)) return { ...base, state: "ended" };
  if (run.released) return { ...base, state: "released" };
  const state: ComputerState = run.status === "queued" ? "starting" : "ready";
  return { ...base, state: stateOf ? stateOf(run.id, state) : state };
}
