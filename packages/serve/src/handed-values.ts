// What a run was handed of its agent's browser sign-in, read back from the one store: the run row's `sign_in_handed`
// mark (the SHA-256 of each pointer, never the pointer), the browser vendor its launch's plane kept, and the agent's
// sign-ins (live and forgotten) opened to find each pointer the mark names (run-view.ts handedPointers). One read for
// every place that must cut a run of what it was handed: the store-backed run view (store-view.ts) and the runner's
// learning end (runner/learning-end.ts), which refuses to learn it.
import { type Handed, handedMark, handedPointers } from "./run-view.js";
import { type RunLaunch, readLaunchBody } from "./run-launch.js";
import type { SignIns } from "./sign-ins.js";
import type { RunRow, Store } from "./store/store.js";
import { keptVendor, type Plane } from "./tool-plane.js";

/** What reading a run's handed pointers back needs of the sign-ins: the live pointer and the forgotten ones, opened.
 *  The server's SignIns and the store's (sign-ins-store.ts signInReads) both give it. */
export type HandedReads = Pick<SignIns, "peek" | "forgotten">;

/** The run's launch body read back, or undefined when it has none (an old run, or one not started with one). */
export async function launchOf(store: Pick<Store, "runs">, runId: string): Promise<RunLaunch | undefined> {
  try {
    const row = await store.runs.launch(runId);
    return readLaunchBody(row.body);
  } catch {
    return undefined;
  }
}

/** The pointers a run was handed, as its row kept them (never the pointers, their SHA-256), read by the one rule a
 *  serve.json's mark is read by (run-view.ts handedMark): a column that is absent or null is no mark; a non-empty array
 *  of SHA-256 hashes is the mark; anything else (`true`, an object, a string, an empty array, which no writer writes, or
 *  an array holding anything but a hash) is MALFORMED, which handedPointers reads as unreadable: fails closed. */
export const handedOf = (runRow: RunRow): Handed | undefined => (runRow.signInHanded === null || runRow.signInHanded === undefined ? undefined : handedMark(runRow.signInHanded));

/** The pointers run `runId` was handed, read back (handedPointers): none for a run with no mark, else each one, or
 *  `unreadable` when what it was handed can't be known here (a mark with no vendor browser kept beside it, no sign-ins to
 *  read, a hash that matches no pointer that opens). A run whose row can't be read is `unreadable` too: fails closed.
 *  `known`, the run's row and launch when the caller has read them already. Every ref is returned; a caller that cuts
 *  text drops those shorter than MIN_SECRET, as every cut does. */
export async function handedValuesOf(deps: { readonly signIns?: HandedReads }, store: Pick<Store, "runs">, runId: string, known?: { readonly runRow: RunRow; readonly launch: RunLaunch | undefined }): Promise<{ refs: string[] } | "unreadable"> {
  const runRow = known ? known.runRow : await store.runs.get(runId).catch(() => undefined);
  if (!runRow) return "unreadable";
  const launch = known ? known.launch : await launchOf(store, runId);
  const browser = launch?.plane ? keptVendor(launch.plane as Plane).browser : undefined;
  return handedPointers(deps.signIns, runRow.agentId, browser, handedOf(runRow));
}
