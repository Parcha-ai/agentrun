// The part of the store (module A, store/store.ts) a runner calls: the runner names only this, so no SQL, pragma or
// file reaches runner/. A's SqliteStore is one.
import { Fenced, type Store } from "../store/store.js";

export type RunnerStore = Pick<Store, "claim" | "renew" | "renewMany" | "release" | "journal" | "flush" | "commands" | "commandsOf" | "take" | "retry"> & {
  readonly runs: Pick<Store["runs"], "claimMany" | "claimable" | "update">;
  /** The runs' live view (run_live): the runner's live ticker writes each run's held state there. A store without it (a
   *  test's) has no live view. */
  readonly live?: Store["live"];
  /** The server's settings, for the one the runner removes at a run's end (browser-wait-ended.ts). A store without it (a
   *  test's) keeps none. */
  readonly settings?: Store["settings"];
};

/** The store's fence: a write under an epoch that moved. */
export function isFenced(error: unknown): boolean {
  return error instanceof Fenced;
}
