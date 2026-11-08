// An agent's saved browser sign-ins, over the one store (A: store.signIns), the store-backed replacement for sign-ins.ts's
// file store (tl-browser's rules, the E1 store half of the E1/E2/E3 split). The cookies stay at the browser's vendor (a
// Browserbase context, a Kernel profile); this server keeps one sealed pointer per agent and provider, sealed with the
// store's one rule (store/seal.ts, AAD sign_ins|<agent>:<provider>|pointer), never served, never written to a run in the
// clear. Only the owner reads a sign-in's name ("default") and state. A run gets the pointer only at its launch, over its
// secrets' pipe (E2's run path), and its served output is cut by every handed pointer (E3's readers).
//
// Forgetting a sign-in moves its pointer into a sealed tombstone (kept only to cut it from what a run it was handed shows),
// and is refused while a running run holds the pointer's hash in its sign_in_handed list. The forget is one store
// transaction, which is the per-agent lock a launch shares: the store's one writer serializes it with the launch that
// writes sign_in_handed.
import { createHash } from "node:crypto";
import { sealColumn, sealedAt, SignInHandedTo, SignInMissing, type Store, unsealColumn } from "./store/index.js";

/** The one saved sign-in an agent keeps per provider is named this; the owner's label, never the model's. */
export const SIGN_IN_NAME = "default";

/** The SHA-256 of a sign-in pointer: what a run's launch keeps (sign_in_handed), and what forget asks after. Never the
 *  pointer. */
export const pointerHash = (pointer: string): string => createHash("sha256").update(pointer, "utf8").digest("hex");

/** A saved sign-in as the owner sees it: its name and when it was saved, and its state. `ready`: its pointer opens under
 *  this server's seal key. `unreadable`: it does not (no seal key now, another key, or a damaged row); the owner may
 *  forget it or save again, and no run starts from it. Never the pointer. */
export type SavedSignIn = { name: string; provider: string; saved_at: number; state: "ready" | "unreadable" };

/** The vendor side forget needs: delete an agent's object (its pointer) at the provider. The REST client (sign-ins.ts's
 *  vendorsOver) is one; a test's fake is another. */
export type SignInVendors = { remove(provider: string, pointer: string): Promise<void> };

/** The store slice this module needs. */
export type SignInsStore = Pick<Store, "signIns">;

/** Refuses an agent or provider holding ":", before it is used in a composite seal binding (store/seal.ts refuses it too;
 *  this names it the same way for every entry point). */
function checkParts(agentId: string, provider: string): void {
  for (const part of [agentId, provider]) if (part.includes(":")) throw new Error(`a sign-in's agent and provider never hold ":": ${JSON.stringify(part)}`);
}

/** Opens a sealed pointer under this server's seal key and binding; undefined when it does not open (no key, another key,
 *  or damaged). */
function open(sealKey: Buffer | undefined, agentId: string, provider: string, pointerSealed: Uint8Array): string | undefined {
  if (!sealKey) return undefined;
  try {
    return unsealColumn(sealKey, sealedAt.signIn(agentId, provider), pointerSealed).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Saves the one live sign-in for the agent and provider: its pointer sealed, its name (default SIGN_IN_NAME), inserted or
 *  replaced in place. Refused with no seal key (a pointer is never kept in the clear). */
export async function saveSignIn(
  store: SignInsStore,
  sealKey: Buffer | undefined,
  signIn: { agentId: string; provider: string; pointer: string; name?: string },
): Promise<SavedSignIn> {
  if (!sealKey) throw new Error("this server keeps no sign-in without a seal key, never in the clear");
  checkParts(signIn.agentId, signIn.provider);
  const pointerSealed = sealColumn(sealKey, sealedAt.signIn(signIn.agentId, signIn.provider), signIn.pointer);
  const row = await store.signIns.save({ agentId: signIn.agentId, provider: signIn.provider, name: signIn.name ?? SIGN_IN_NAME, pointerSealed });
  return { name: row.name, provider: row.provider, saved_at: row.savedAt, state: "ready" };
}

/** The agent's saved sign-ins, as the owner sees them (never a pointer): each with its name, when it was saved, and whether
 *  it opens under this server's seal key (ready) or not (unreadable). */
export async function savedSignIns(store: SignInsStore, sealKey: Buffer | undefined, agentId: string): Promise<SavedSignIn[]> {
  const rows = await store.signIns.list(agentId);
  return rows.map((row) => ({
    name: row.name,
    provider: row.provider,
    saved_at: row.savedAt,
    state: open(sealKey, agentId, row.provider, row.pointerSealed) === undefined ? "unreadable" : "ready",
  }));
}

/** The pointer of the agent's sign-in for the provider, read only: for a run's launch to hand it (E2). `unreadable` when
 *  the agent keeps one that does not open under this server's seal key (no key now, another, or damaged); undefined when it
 *  has none. No lease is taken, nothing is written. */
export async function openSavedPointer(store: SignInsStore, sealKey: Buffer | undefined, agentId: string, provider: string): Promise<{ pointer: string } | "unreadable" | undefined> {
  const row = await store.signIns.get(agentId, provider);
  if (!row) return undefined;
  const pointer = open(sealKey, agentId, provider, row.pointerSealed);
  return pointer === undefined ? "unreadable" : { pointer };
}

/** The pointers of the agent's forgotten sign-ins for the provider that open under this server's seal key, and whether any
 *  does not: for cutting a handed pointer from what a run still going shows, after its sign-in was forgotten (E3/the
 *  runner). Never a live sign-in. */
export async function forgottenPointers(store: SignInsStore, sealKey: Buffer | undefined, agentId: string, provider: string): Promise<{ pointers: string[]; unreadable: boolean }> {
  const tombstones = await store.signIns.tombstones(agentId, provider);
  const opened = tombstones.map((t) => open(sealKey, agentId, provider, t.pointerSealed));
  return { pointers: opened.filter((p): p is string => p !== undefined), unreadable: opened.some((p) => p === undefined) };
}

/** What forget answers: the provider it forgot, and whether its object was deleted at the vendor. */
export type Forgotten = { provider: string; at_vendor: "deleted" | "not_deleted"; message?: string };

/** Forgets the agent's live sign-in for the provider. In one store transaction (the lock a launch shares): refused with
 *  SignInHandedTo while a running run holds this pointer's hash in its sign_in_handed (or, when the pointer does not open,
 *  while any running run was handed a sign-in at all — any such run may hold it); otherwise the sealed pointer moves to a
 *  tombstone (the newest kept) and the live row goes. The vendor's object is then deleted, best effort (what failed is
 *  said; this server no longer points to it either way). SignInMissing when the agent has no sign-in for the provider. */
export async function forgetSignIn(
  store: SignInsStore,
  sealKey: Buffer | undefined,
  vendors: SignInVendors,
  agentId: string,
  provider: string,
): Promise<Forgotten> {
  checkParts(agentId, provider);
  const row = await store.signIns.get(agentId, provider);
  if (!row) throw new SignInMissing(agentId, provider);
  const pointer = open(sealKey, agentId, provider, row.pointerSealed);
  // The atomic hold check and move: a running run holding the hash (or, for a pointer that does not open, any handed run)
  // refuses it, nothing written. Throws SignInHandedTo or SignInMissing.
  await store.signIns.forget(agentId, provider, pointer === undefined ? { heldUnreadable: true } : { hash: pointerHash(pointer) });
  // Moved here and the live row gone: the vendor object is deleted best effort. A pointer that did not open cannot be.
  if (pointer === undefined) return { provider, at_vendor: "not_deleted", message: "its pointer does not open under this server's seal key, so its object could not be deleted at the vendor. This server no longer points to it." };
  const error = await vendors.remove(provider, pointer).then(() => undefined, (e: Error) => e);
  return error
    ? { provider, at_vendor: "not_deleted", message: `Not deleted at ${provider}: ${error.message}. This server no longer points to it.` }
    : { provider, at_vendor: "deleted" };
}

/** Which run still going was handed the sign-in whose pointer hashes to `hash`, if one was: the check the runner makes
 *  before it serves a run's output. Exposes store.signIns.handedHolder. */
export async function handedTo(store: SignInsStore, hash: string): Promise<string | undefined> {
  return store.signIns.handedHolder(hash);
}

export { SignInHandedTo, SignInMissing };
