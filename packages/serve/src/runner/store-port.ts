// The part of the store (module A, store/store.ts) a runner calls: the runner names only this, so no SQL, pragma or
// file reaches runner/. A's SqliteStore is one.
import { Fenced, type Store } from "../store/store.js";

export type RunnerStore = Pick<Store, "claim" | "renew" | "renewMany" | "release" | "journal" | "flush" | "commands" | "commandsOf" | "take" | "retry"> & {
  readonly runs: Pick<Store["runs"], "claimMany" | "update">;
  /** The runs' live view (run_live): the runner's live ticker writes each run's held state there. A store without it (a
   *  test's) has no live view. */
  readonly live?: Store["live"];
};

/** The store's fence: a write under an epoch that moved. */
export function isFenced(error: unknown): boolean {
  return error instanceof Fenced;
}
