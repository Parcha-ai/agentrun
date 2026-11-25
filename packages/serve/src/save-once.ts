// A file saved once in a run's files, never over anything: what web_save writes, and the results a server's reply
// carries that the gateway files (fal's completed jobs, mcp-gateway.ts). One set of rules for both: the Workspace walks
// to the path without following a link (a link on the way is ESCAPE), and whatever is already at the path (a file, a
// folder, a link) is kept, so a save never follows or replaces it. The create itself never replaces (Workspace.writeNew):
// a file that lands at the path after the check is kept too. A Workspace with no such create saves nothing.
import { type Stat, type Workspace, WorkspaceError } from "./workspace/index.js";

/** What is already at `at`, never followed: undefined when nothing is. Throws the Workspace's error (a link on the way). */
export const heldAt = async (work: Workspace, at: string): Promise<Stat["kind"] | undefined> => (await work.stat(at))?.kind;

/** `bytes` saved at `at` when nothing is there (`saved`), else what is there, kept (`held`). Throws the Workspace's
 *  error (a link on the way, a write that failed), and REFUSED for a Workspace that cannot make a file without the
 *  chance of replacing one (no writeNew): it never falls back to a write that replaces. */
export async function saveOnce(work: Workspace, at: string, bytes: Uint8Array | string): Promise<{ saved: true } | { held: Stat["kind"] }> {
  if (typeof work.writeNew !== "function") throw new WorkspaceError("REFUSED", "this run's files cannot make a file without the chance of replacing one, so nothing is saved there once", { path: at });
  const held = await heldAt(work, at);
  if (held) return { held };
  if (await work.writeNew(at, bytes)) return { saved: true };
  // Something landed at the path after the check: what it is now, kept.
  return { held: (await heldAt(work, at)) ?? "other" };
}
