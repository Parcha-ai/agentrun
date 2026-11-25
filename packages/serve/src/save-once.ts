// A file saved once in a run's files, never over anything: what web_save writes, and the results a server's reply
// carries that the gateway files (fal's completed jobs, mcp-gateway.ts). One set of rules for both: the Workspace walks
// to the path without following a link (a link on the way is ESCAPE), and whatever is already at the path (a file, a
// folder, a link) is kept, so a save never follows or replaces it. The create itself never replaces (Workspace.writeNew,
// on the local Workspace and an attached one): a file that lands at the path after the check is kept too.
// A Workspace with no such create (an Archil run disk, follow-up Parcha-ai/agentrun#3777): a filed result is not saved
// there at all, while web_save, asking for `checkThenWrite`, keeps its check then a write, so a file that lands at the
// path between the two can be replaced there, as before writeNew.
import { type Stat, type Workspace, WorkspaceError } from "./workspace/index.js";

/** What is already at `at`, never followed: undefined when nothing is. Throws the Workspace's error (a link on the way). */
export const heldAt = async (work: Workspace, at: string): Promise<Stat["kind"] | undefined> => (await work.stat(at))?.kind;

/** `bytes` saved at `at` when nothing is there (`saved`), else what is there, kept (`held`). Throws the Workspace's
 *  error (a link on the way, a write that failed). On a Workspace that cannot make a file without the chance of
 *  replacing one (no writeNew) it throws REFUSED, unless `checkThenWrite` is set: then it checks, then writes, and
 *  a file landing between the two is not kept (Parcha-ai/agentrun#3777). */
export async function saveOnce(work: Workspace, at: string, bytes: Uint8Array | string, options: { checkThenWrite?: boolean } = {}): Promise<{ saved: true } | { held: Stat["kind"] }> {
  const create = typeof work.writeNew === "function" ? work.writeNew.bind(work) : undefined;
  if (!create && !options.checkThenWrite) throw new WorkspaceError("REFUSED", "this run's files cannot make a file without the chance of replacing one, so nothing is saved there once", { path: at });
  const held = await heldAt(work, at);
  if (held) return { held };
  if (!create) {
    await work.write(at, bytes);
    return { saved: true };
  }
  if (await create(at, bytes)) return { saved: true };
  // Something landed at the path after the check: what it is now, kept.
  return { held: (await heldAt(work, at)) ?? "other" };
}
