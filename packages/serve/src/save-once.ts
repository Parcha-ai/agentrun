// A file saved once in a run's files, never over anything: what web_save writes, and the results a server's reply
// carries that the gateway files (fal's completed jobs, mcp-gateway.ts). One set of rules for both: the Workspace walks
// to the path without following a link (a link on the way is ESCAPE), and whatever is already at the path (a file, a
// folder, a link) is kept, so a second save of the same name never follows or replaces it.
import type { Stat, Workspace } from "./workspace/index.js";

/** What is already at `at`, never followed: undefined when nothing is. Throws the Workspace's error (a link on the way). */
export const heldAt = async (work: Workspace, at: string): Promise<Stat["kind"] | undefined> => (await work.stat(at))?.kind;

/** `bytes` saved at `at` when nothing is there (`saved`), else what is there, kept (`held`). Throws the Workspace's
 *  error (a link on the way, a write that failed). The check and the write are two steps: a file made at `at` between
 *  them is replaced, as the Workspace's write replaces a file. */
export async function saveOnce(work: Workspace, at: string, bytes: Uint8Array | string): Promise<{ saved: true } | { held: Stat["kind"] }> {
  const held = await heldAt(work, at);
  if (held) return { held };
  await work.write(at, bytes);
  return { saved: true };
}
