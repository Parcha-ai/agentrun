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
import { ApiError } from "./errors.js";
import { type Claim, sealColumn, sealedAt, SignInHandedTo, SignInMissing, type Store, unsealColumn } from "./store/index.js";

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

/** A run's handed sign-in, as the browser binding takes it: the vendor, the pointer, and whether the run saves to it. */
export type RunSignIn = { provider: Vendor; ref: string; save: boolean };

/**
 * The sign-in run `claim.runId`'s browser starts from on the runner, read from the store under that run's own claim: its
 * agent's saved pointer for `resolution`'s vendor, opened under `sealKey`. The runner is one process holding many claims,
 * so this is the only way a run gets its pointer there (never the process's environment or secrets' pipe, which the old
 * per-run process read with handedSignIn).
 *
 * As the old launch did, the run keeps that it was handed the pointer (its hash added to sign_in_handed, under the claim)
 * before it is handed it, so a forget sees the run: one it could not keep (a stale or lost claim: Fenced) is handed none.
 * The pointer is read again after that write: a forget that landed between the two moved it to a tombstone, and the run
 * is handed none. It saves to it unless another running run holds it (the store's handed holder); a run resumed on the
 * pointer it held keeps saving. None, too, with no seal key, a pointer that does not open, a browser that keeps none, or
 * an agent that saved none for the vendor. Never throws, and never names the pointer.
 */
export async function runSignIn(store: Pick<Store, "runs" | "signIns">, sealKey: Buffer | undefined, claim: Claim, resolution: string): Promise<RunSignIn | undefined> {
  const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
  if (!vendor || !sealKey) return undefined;
  try {
    const run = await store.runs.get(claim.runId);
    if (!run) return undefined;
    const opened = await openSavedPointer(store, sealKey, run.agentId, vendor);
    if (opened === undefined || opened === "unreadable") return undefined;
    const hash = pointerHash(opened.pointer);
    const holder = await store.signIns.handedHolder(hash);
    const save = holder === undefined || holder === claim.runId;
    const before = run.signInHanded ?? [];
    // Always written, even when the hash is there already: the write is the claim's fence.
    await store.runs.update(claim, { signInHanded: before.includes(hash) ? [...before] : [...before, hash] });
    const now = await openSavedPointer(store, sealKey, run.agentId, vendor);
    if (now === undefined || now === "unreadable" || now.pointer !== opened.pointer) return undefined;
    return { provider: vendor, ref: opened.pointer, save };
  } catch {
    return undefined;
  }
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

// ---------------------------------------------------------------------------------------------------------------------
// View bridge: the old SignIns interface's shapes (sign-ins.ts), byte for byte, so the v2 API answers unchanged when the
// switch wires the store version in. The lease and Browserbase-settle machinery is gone; a sign-in is "held" when a live
// run (running, not final) was handed its pointer's hash (store.signIns.handedHolder), and verified_at is the time a run
// last verified it (store column, written by E2's run path through store.signIns.verify).

/** A browser the server keeps a sign-in for; a local Chrome keeps none. Ported from sign-ins.ts, kept here so this module
 *  does not depend on the file store the switch deletes. */
export type Vendor = "browserbase" | "kernel";
/** A saved sign-in as GET /agents/{id} shows it (the v2 SignIn), never its pointer. Identical to the old SignInView. */
export type SignInView = { key: string; provider: Vendor; state: "ready" | "held" | "unreadable"; held_by: string | null; verified_at: string | null };

/** The vendor a run's browser resolves to keeps a sign-in for: Browserbase's and Kernel's; a local Chrome is refused by
 *  name; an unavailable browser has none. Ported from sign-ins.ts. */
export function vendorOf(resolution: string): Vendor | undefined {
  if (resolution === "browserbase" || resolution === "kernel") return resolution;
  if (resolution === "chrome" || resolution === "cdp") throw new Error("a local Chrome keeps no saved sign-in: its cookies would sit on this server's disk");
  return undefined;
}

const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The agent's sign-ins as the v2 API shows them (the old SignIns.view), never a pointer. Per sign-in: `held`/`held_by`
 *  when a live run holds its pointer's hash (store.signIns.handedHolder); `unreadable` when its pointer does not open under
 *  this server's seal key (then held_by is null — no hash to match a run by); `verified_at` from the store. */
export async function signInViews(store: SignInsStore, sealKey: Buffer | undefined, agentId: string): Promise<SignInView[]> {
  const rows = await store.signIns.list(agentId);
  return Promise.all(rows.map(async (row): Promise<SignInView> => {
    const pointer = open(sealKey, agentId, row.provider, row.pointerSealed);
    const heldBy = pointer === undefined ? null : (await store.signIns.handedHolder(pointerHash(pointer))) ?? null;
    const base = { key: row.name, provider: row.provider as Vendor, held_by: heldBy, verified_at: isoOf(row.verifiedAt) };
    if (pointer === undefined) return { ...base, state: "unreadable" };
    return { ...base, state: heldBy ? "held" : "ready" };
  }));
}

/** The pointer of the agent's sign-in for `resolution`'s vendor (the old SignIns.peek): `{ ref }`, `unreadable` when it
 *  does not open, or undefined when there is none or the browser keeps none. */
export async function peekSignIn(store: SignInsStore, sealKey: Buffer | undefined, agentId: string, resolution: string): Promise<{ ref: string } | "unreadable" | undefined> {
  const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
  if (!vendor) return undefined;
  const opened = await openSavedPointer(store, sealKey, agentId, vendor);
  return opened === undefined ? undefined : opened === "unreadable" ? "unreadable" : { ref: opened.pointer };
}

/** The agent's forgotten pointers for `resolution`'s vendor that open here, and whether any does not (the old
 *  SignIns.forgotten): `{ refs, unreadable }`, or `{ refs: [], unreadable: false }` for a browser that keeps none. */
export async function forgottenSignIns(store: SignInsStore, sealKey: Buffer | undefined, agentId: string, resolution: string): Promise<{ refs: string[]; unreadable: boolean }> {
  const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
  if (!vendor) return { refs: [], unreadable: false };
  const { pointers, unreadable } = await forgottenPointers(store, sealKey, agentId, vendor);
  return { refs: pointers, unreadable };
}

/** Forgets the agent's sign-in named `key`, across every provider that keeps it (the old SignIns.forget): each held check
 *  runs first, so one held refuses the whole forget (409 sign_in_held) and removes none; then each is moved to a tombstone
 *  and deleted at its vendor best effort. 404 when the agent has no sign-in named `key`. */
export async function forgetSignInView(
  store: SignInsStore,
  sealKey: Buffer | undefined,
  vendors: SignInVendors,
  agentId: string,
  key: string,
): Promise<{ key: string; removed: Array<{ provider: Vendor; at_vendor: "deleted" | "not_deleted"; message?: string }> }> {
  const named = (await store.signIns.list(agentId)).filter((row) => row.name === key);
  if (!named.length) throw new ApiError("not_found", `The agent ${agentId} has no sign-in ${key}.`);
  // Check every provider's hold before removing any: a sign-in handed to a running run refuses the whole forget.
  for (const row of named) {
    const pointer = open(sealKey, agentId, row.provider, row.pointerSealed);
    const runId = pointer === undefined ? await store.signIns.handedAny() : await store.signIns.handedHolder(pointerHash(pointer));
    if (runId) throw new ApiError("sign_in_held", `The sign-in ${key} was handed to the run ${runId}, which is still going: forget it once that run ends.`, { details: { handed_to: runId } });
  }
  const removed: Array<{ provider: Vendor; at_vendor: "deleted" | "not_deleted"; message?: string }> = [];
  for (const row of named) {
    try {
      removed.push({ ...(await forgetSignIn(store, sealKey, vendors, agentId, row.provider)), provider: row.provider as Vendor });
    } catch (error) {
      // A run grabbed it between the pre-check and the move (server and runner are separate processes): the store's forget
      // refused it atomically; map it to the same 409 the pre-check raises.
      if (error instanceof SignInHandedTo) throw new ApiError("sign_in_held", `The sign-in ${key} was handed to the run ${error.runId}, which is still going: forget it once that run ends.`, { details: { handed_to: error.runId } });
      throw error;
    }
  }
  return { key, removed };
}

/** The old SignIns interface's read and forget surface over the store (view, peek, forgotten, forget), so the switch can
 *  wire it where `new SignIns(...)` was, with the v2 answers unchanged. */
export function signInsOverStore(store: SignInsStore, sealKey: Buffer | undefined, vendors: SignInVendors) {
  return {
    view: (agentId: string) => signInViews(store, sealKey, agentId),
    peek: (agentId: string, resolution: string) => peekSignIn(store, sealKey, agentId, resolution),
    forgotten: (agentId: string, resolution: string) => forgottenSignIns(store, sealKey, agentId, resolution),
    forget: (agentId: string, key: string) => forgetSignInView(store, sealKey, vendors, agentId, key),
  };
}
