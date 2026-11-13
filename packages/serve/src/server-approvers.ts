// Whether anyone can answer an ask on this server: its accounts on, so the owner's password session answers a parked
// call's approval. One row of the one store (store.settings, APPROVERS_KEY), which the server writes at its start, and a
// runner reads at each claim (runner/adapter-run-spec.ts adapterRunGate): a runner may run on another machine, with no
// server environment to read, and a server started again with its accounts set otherwise says so to the next claim.
// Accounts off, no one can: the runner's gate refuses an asked call at once in words (tool-gate.ts noApproverText), never
// parking a run no one could resume. A missing row (a server from before the row, or one that has not written it yet)
// reads as approvers: an ask parks, as it always did where someone could answer it, and nothing runs without an answer.
import type { Settings } from "./store/index.js";

/** The store.settings key: `{ approvers: boolean }`. */
export const APPROVERS_KEY = "approvers";

/** Writes whether anyone can answer an ask here (`approvers`: the server's accounts on). */
export async function writeApprovers(settings: Pick<Settings, "put">, approvers: boolean): Promise<void> {
  await settings.put(APPROVERS_KEY, { approvers });
}

/** Whether anyone can answer an ask, as the store says now: false only where the server wrote that no one can; a missing
 *  row, or one that does not read, is true (an ask parks). */
export async function readApprovers(settings: Pick<Settings, "get">): Promise<boolean> {
  const value = await settings.get(APPROVERS_KEY).catch(() => undefined);
  return !(typeof value === "object" && value !== null && (value as { approvers?: unknown }).approvers === false);
}
