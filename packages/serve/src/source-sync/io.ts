/** Private durable I/O ownership, not a lease. Deletion first marks the agent archived/purging, then checks these
 * receipts before removing any folders/disks. Writers insert first, then check that mark, then touch the filesystem.
 * Those opposite orders prevent either process from overlooking an already admitted writer. Never use a read-only
 * store snapshot here: each read must see the preceding committed insertion/mark from the other process.
 *
 * A returned/aborted remote request need not mean its remote writes stopped. Unknown outcomes remain recorded,
 * regardless of age. Recovery needs independent proof that the old writer AND any remote operations have settled;
 * this module deliberately offers no timeout takeover or bulk clear. */
import { createHash, randomUUID } from "node:crypto";
import { purgingKey } from "../agent-delete.js";
import { ApiError } from "../errors.js";
import { canonical } from "../store/agent-body.js";
import type { Store } from "../store/store.js";

type IOStore = Pick<Store, "agents" | "settings">;
export const SOURCE_IO_LIMIT = 32;
export const sourceIOPrefix = (agentId: string): string => `source-sync.io.${createHash("sha256").update(agentId).digest("hex")}.`;
const instance = randomUUID();
const busy = (): ApiError => new ApiError("agent_not_runnable", "A source operation is still writing or has an unresolved outcome. Confirm that its owning writer and remote operations have stopped before deleting this agent or recovering its source write receipt.");
export interface SourceIOReceipt {
  /** Call only after every owned write/exec and resource cleanup settled. For placement, this includes confirmed
   * admission (the live run now protects the files) or confirmed rollback. Never call after an uncertain failure. */
  settled(): Promise<void>;
}
export async function beginSourceIO(store: IOStore, agentId: string, kind: "snapshot" | "placement"): Promise<SourceIOReceipt> {
  const prefix = sourceIOPrefix(agentId), token = randomUUID(), key = prefix + token;
  const value = { version: 1, token, instance, kind, startedAt: Date.now() };
  const saved = await store.settings.putIfAbsent(key, value, { prefix, limit: SOURCE_IO_LIMIT });
  if (canonical(saved ?? null) !== canonical(value)) throw busy();
  const receipt: SourceIOReceipt = { async settled() {
    if (!await store.settings.removeIf(key, value) && await store.settings.get(key) !== undefined)
      throw new ApiError("precondition_failed", "The source write receipt changed; its new owner must resolve it.");
  } };
  try {
    const agent = await store.agents.get(agentId);
    if (!agent || agent.archivedAt !== null || agent.purgedAt !== null || await store.settings.get(purgingKey(agentId)) !== undefined)
      throw new ApiError("agent_not_runnable", "Source writes require an active agent that is not being deleted.");
  } catch (error) {
    // No filesystem callback has been dispatched, so this exact receipt is safe to release, even on a failed read.
    await receipt.settled().catch(() => undefined);
    throw error;
  }
  return receipt;
}
export async function withSourceIO<T>(store: IOStore, agentId: string, kind: "snapshot" | "placement", work: () => Promise<T>): Promise<T> {
  const receipt = await beginSourceIO(store, agentId, kind);
  const result = await work();
  await receipt.settled();
  return result;
}
/** Call only AFTER deletion's durable archive/purging mark and BEFORE any folder/disk removal. The caller must keep
 * that mark through failure/retry. Reading this alone does not reserve deletion or authorize an unmarked purge. */
export async function requireSourceIOIdle(store: Pick<Store, "settings">, agentId: string): Promise<void> {
  if ((await store.settings.all({ prefix: sourceIOPrefix(agentId) })).length) throw busy();
}
