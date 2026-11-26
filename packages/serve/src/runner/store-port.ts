// The part of the store (module A, store/store.ts) a runner calls: the runner names only this, so no SQL, pragma or
// file reaches runner/. A's SqliteStore is one.
import { Fenced, type Store } from "../store/store.js";

export type RunnerStore = Pick<Store, "leaseClock" | "claim" | "renew" | "renewMany" | "release" | "journal" | "flush" | "commands" | "commandsOf" | "take" | "retry" | "watchCommands"> & {
  readonly runs: Pick<Store["runs"], "claimMany" | "claimable" | "claimsOf" | "update"> & Partial<Pick<Store["runs"], "launch" | "get" | "learningDeadlines">>;
  /** The revision's kind, read for a run's start line (runner.ts). A store without it (a test's) says no start or end line. */
  readonly agents?: Pick<Store["agents"], "revision">;
  /** Writes a command row: the cancel of a learning child held at its deadline (runner.ts endOverdue). A store without
   *  it (a test's) cancels none. */
  readonly command?: Store["command"];
  /** The runs' live view (run_live): the runner's live ticker writes each run's held state there. A store without it (a
   *  test's) has no live view. */
  readonly live?: Store["live"];
  /** The server's settings, for the one the runner removes at a run's end (browser-wait-ended.ts). A store without it (a
   *  test's) keeps none. */
  readonly settings?: Store["settings"];
  /** Every runner's word that it is there (runner/presence.ts): the runner keeps its own for as long as it runs. A store
   *  without it (a test's) keeps none. */
  readonly runners?: Store["runners"];
  /** Each claim's turn and attempt: the runner says a claim it lost was cut by its lease's lapse. A store without it (a
   *  test's) keeps none. */
  readonly runAttempts?: Pick<Store["runAttempts"], "lapsed">;
};

/** The store's fence: a write under an epoch that moved. */
export function isFenced(error: unknown): boolean {
  return error instanceof Fenced;
}
