// An agent's saved browser sign-ins, over the one store (store.signIns). The cookies stay at the browser's vendor (a
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
import { type SecretMeta, signInSecretMeta } from "./sign-ins-secrets.js";
import { type Claim, sealColumn, sealedAt, SignInHandedTo, SignInMissing, type SignInRow, type Store, unsealColumn } from "./store/index.js";

/** The one saved sign-in an agent keeps per provider is named this; the owner's label, never the model's. */
export const SIGN_IN_NAME = "default";

/** The SHA-256 of a sign-in pointer: what a run's launch keeps (sign_in_handed), and what forget asks after. Never the
 *  pointer. */
export const pointerHash = (pointer: string): string => createHash("sha256").update(pointer, "utf8").digest("hex");

/** A saved sign-in as the owner sees it: its name and when it was saved, and its state. `ready`: its pointer opens under
 *  this server's seal key. `unreadable`: it does not (another key, or a damaged row); the owner may
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

/** Opens a sealed pointer under this server's seal key and binding; undefined when it does not open (another key, or
 *  damaged). */
function open(sealKey: Buffer, agentId: string, provider: string, pointerSealed: Uint8Array): string | undefined {
  try {
    return unsealColumn(sealKey, sealedAt.signIn(agentId, provider), pointerSealed).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Saves the one live sign-in for the agent and provider: its pointer sealed, its name (default SIGN_IN_NAME), inserted or
 *  replaced in place, sealed under the server's seal key: a pointer is never kept in the clear. */
/** Saves the agent's first sign-in for the provider only when it has none, in the store's one atomic step (saveIfAbsent):
 *  `saved` true with the row it inserted, or false with the live row another save left, never the one asked for. */
export async function saveSignInIfAbsent(
  store: SignInsStore,
  sealKey: Buffer,
  signIn: { agentId: string; provider: string; pointer: string; name?: string },
): Promise<{ saved: boolean; row: SignInRow }> {
  checkParts(signIn.agentId, signIn.provider);
  const pointerSealed = sealColumn(sealKey, sealedAt.signIn(signIn.agentId, signIn.provider), signIn.pointer);
  return store.signIns.saveIfAbsent({ agentId: signIn.agentId, provider: signIn.provider, name: signIn.name ?? SIGN_IN_NAME, pointerSealed });
}

export async function saveSignIn(
  store: SignInsStore,
  sealKey: Buffer,
  signIn: { agentId: string; provider: string; pointer: string; name?: string },
): Promise<SavedSignIn> {
  checkParts(signIn.agentId, signIn.provider);
  const pointerSealed = sealColumn(sealKey, sealedAt.signIn(signIn.agentId, signIn.provider), signIn.pointer);
  const row = await store.signIns.save({ agentId: signIn.agentId, provider: signIn.provider, name: signIn.name ?? SIGN_IN_NAME, pointerSealed });
  return { name: row.name, provider: row.provider, saved_at: row.savedAt, state: "ready" };
}

/** The agent's saved sign-ins, as the owner sees them (never a pointer): each with its name, when it was saved, and whether
 *  it opens under this server's seal key (ready) or not (unreadable). */
export async function savedSignIns(store: SignInsStore, sealKey: Buffer, agentId: string): Promise<SavedSignIn[]> {
  const rows = await store.signIns.list(agentId);
  return rows.map((row) => ({
    name: row.name,
    provider: row.provider,
    saved_at: row.savedAt,
    state: open(sealKey, agentId, row.provider, row.pointerSealed) === undefined ? "unreadable" : "ready",
  }));
}

/** The pointer of the agent's sign-in for the provider, read only: for a run's launch to hand it (E2). `unreadable` when
 *  the agent keeps one that does not open under this server's seal key (another key, or damaged); undefined when it
 *  has none. No lease is taken, nothing is written. */
export async function openSavedPointer(store: SignInsStore, sealKey: Buffer, agentId: string, provider: string): Promise<{ pointer: string } | "unreadable" | undefined> {
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
 * is handed none. It saves to it as the store answers that same write (the save lease, in its transaction: never two
 * runs of one sign-in at once, a Browserbase one held for its settle window past a run that left running). None, too, for a pointer that does not open, a browser that keeps none, or
 * an agent that saved none for the vendor. Never throws, and never names the pointer.
 */
export async function runSignIn(store: Pick<Store, "runs" | "signIns">, sealKey: Buffer, claim: Claim, resolution: string, options: RunSignInOptions = {}): Promise<RunSignIn | undefined> {
  const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
  if (!vendor) return undefined;
  try {
    const run = await store.runs.get(claim.runId);
    if (!run) return undefined;
    let opened = await openSavedPointer(store, sealKey, run.agentId, vendor);
    // None saved for the vendor: the agent's first one is made now, at the run's launch, as main's forRun makes it.
    if (opened === undefined && options.vendors) opened = await firstSignIn(store, sealKey, run.agentId, vendor, options.vendors, options.log);
    if (opened === undefined || opened === "unreadable") return undefined;
    const hash = pointerHash(opened.pointer);
    const before = run.signInHanded ?? [];
    // Always written, even when the hash is there already: the write is the claim's fence. Whether this run saves to the
    // sign-in is the store's answer to this same write (its save lease, in the write's transaction), so two binds of one
    // sign-in never both save; Browserbase's lease outlives a run that left running by its settle window.
    const { save } = await store.runs.update(claim, { signInHanded: before.includes(hash) ? [...before] : [...before, hash] }, { signInSettleMs: settleFor(vendor) });
    const now = await openSavedPointer(store, sealKey, run.agentId, vendor);
    if (now === undefined || now === "unreadable" || now.pointer !== opened.pointer) return undefined;
    return { provider: vendor, ref: opened.pointer, save: save === true };
  } catch {
    return undefined;
  }
}

/** Where a run's first sign-in is made (the vendors' REST APIs, over the run's own claim keys: sign-ins.ts vendorsOver)
 *  and where a create that fails is said (the run's log). Absent, none is made. */
export type RunSignInOptions = { vendors?: { create(vendor: Vendor): Promise<string>; remove(vendor: Vendor, ref: string): Promise<void> }; log?: (line: string) => void };

/** A vendor call's failure in words that name no pointer and no URL: vendorsOver's own ("<vendor> answered <status>",
 *  "<vendor> unreachable (<error name>)", "this server has no <vendor> to call"), else the vendor and the error's name. */
function vendorWords(vendor: Vendor, error: unknown): string {
  const message = (error as Error)?.message ?? "";
  const known = new RegExp(`^(${vendor} answered \\d{3}|${vendor} unreachable \\([A-Za-z]+\\)|this server has no ${vendor} to call)$`);
  return known.test(message) ? message : `${vendor} failed (${(error as Error)?.name ?? "Error"})`;
}

/** The agent's first sign-in for `vendor`, made at the vendor now (a Browserbase context, a Kernel profile) and saved at
 *  once, sealed, as main's forRun makes it: the saved pointer, opened. One another run saved meanwhile is the agent's: the
 *  object this made goes at the vendor, never left holding nothing, and the saved one is answered. A create or a save
 *  that fails starts the run signed out (undefined), said in the run's log in words that name no pointer. */
async function firstSignIn(store: Pick<Store, "signIns">, sealKey: Buffer, agentId: string, vendor: Vendor, vendors: NonNullable<RunSignInOptions["vendors"]>, log: RunSignInOptions["log"]): Promise<{ pointer: string } | "unreadable" | undefined> {
  let made: string;
  try {
    made = await vendors.create(vendor);
  } catch (error) {
    // vendorsOver's words name the vendor and its answer, never a pointer.
    log?.(`its browser starts signed out: ${vendorWords(vendor, error)}`);
    return undefined;
  }
  // As far as it answers: the run goes on either way, and a delete that fails is said in the run's log, in the vendor's
  // name and its answer alone (vendorsOver's words; any other's, the error's name), never a pointer or a URL.
  const gone = () => vendors.remove(vendor, made).catch((error: unknown) => log?.(`its browser's extra sign-in could not be removed: ${vendorWords(vendor, error)}`));
  let won: { saved: boolean; row: { pointerSealed: Uint8Array } };
  try {
    won = await saveSignInIfAbsent(store, sealKey, { agentId, provider: vendor, pointer: made });
  } catch {
    // Never kept, so never forgotten: the object just made goes at the vendor now, as far as it answers.
    await gone();
    log?.("its browser starts signed out: its first sign-in could not be saved");
    return undefined;
  }
  // Another run's first one won (the store's one atomic step): ours goes at the vendor, and the winner's is the agent's,
  // the one this run is handed. Exactly one object is left, saved.
  if (!won.saved) await gone();
  const pointer = open(sealKey, agentId, vendor, won.row.pointerSealed);
  if (pointer === undefined) {
    // The winner's sign-in won't open under this server's seal key: the run starts signed out, said as every other path.
    log?.("its browser starts signed out: the saved sign-in can't be opened here");
    return "unreadable";
  }
  return { pointer };
}

/** Whether every sign-in run `run` was handed (its sign_in_handed hashes) reads back here: a live sign-in of its agent, or
 *  a kept tombstone of one, that opens under `sealKey` to a pointer of that hash. One that does not (its seal does not open
 *  here, or nothing of it is kept) means the run's text could hold a pointer nothing can cut, so the run must not go on:
 *  main's UNREADABLE_SIGN_IN (runs.ts). A run handed none reads back. */
export async function handedSignInReadsBack(store: Pick<Store, "signIns">, sealKey: Buffer, run: { readonly agentId: string; readonly signInHanded: readonly string[] | null }): Promise<boolean> {
  const handed = run.signInHanded ?? [];
  if (handed.length === 0) return true;
  const known = new Set<string>();
  for (const row of await store.signIns.list(run.agentId)) {
    const pointer = open(sealKey, run.agentId, row.provider, row.pointerSealed);
    if (pointer !== undefined) known.add(pointerHash(pointer));
  }
  for (const provider of ["browserbase", "kernel"] as const) {
    for (const tomb of await store.signIns.tombstones(run.agentId, provider)) {
      const pointer = open(sealKey, run.agentId, provider, tomb.pointerSealed);
      if (pointer !== undefined) known.add(pointerHash(pointer));
    }
  }
  return handed.every((hash) => known.has(hash));
}

/**
 * A run on the runner saved its sign-in at `at` (a session that saved to it ended): the sign-in's verified_at, as main's
 * lease end fills it from the run's saved mark. Only under the run's own claim, for what it was handed to save: the
 * agent is the run's own (never the caller's word), its saved pointer is still the one handed, its hash is in the run's
 * sign_in_handed, and the claim still holds the run (a fenced write first: a stale or lost claim verifies nothing). The
 * stamp is conditioned on the save read with the pointer (its number, ifSave), so a sign-in saved afresh meanwhile is never
 * marked by this save. True when the store stamped. Never throws, and never names the pointer.
 */
export async function verifyRunSignIn(store: Pick<Store, "runs" | "signIns">, sealKey: Buffer, claim: Claim, signIn: RunSignIn, at: number): Promise<boolean> {
  if (!signIn.save || !Number.isFinite(at)) return false;
  try {
    const run = await store.runs.get(claim.runId);
    if (!run || !run.signInHanded?.includes(pointerHash(signIn.ref))) return false;
    // The saved sign-in, read once: its pointer is the one handed, and its save number is what the stamp is conditioned on,
    // so an owner's fresh save between this read and the stamp is never marked verified by this run's save.
    const row = await store.signIns.get(run.agentId, signIn.provider);
    if (!row || open(sealKey, run.agentId, signIn.provider, row.pointerSealed) !== signIn.ref) return false;
    await store.runs.update(claim, { signInHanded: [...run.signInHanded] });
    return await store.signIns.verify(run.agentId, signIn.provider, at, { ifSave: row.save });
  } catch {
    return false;
  }
}

/** The pointers of the agent's forgotten sign-ins for the provider that open under this server's seal key, and whether any
 *  does not: for cutting a handed pointer from what a run still going shows, after its sign-in was forgotten (E3/the
 *  runner). Never a live sign-in. */
export async function forgottenPointers(store: SignInsStore, sealKey: Buffer, agentId: string, provider: string): Promise<{ pointers: string[]; unreadable: boolean }> {
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
  sealKey: Buffer,
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
// The v2 API's view of the sign-ins: a sign-in is "held" when a live run (running, not final) was handed its pointer's
// hash (store.signIns.handedHolder), and verified_at is the time a run last verified it (store column, written by the
// run path through store.signIns.verify).

/** Browserbase writes a saved context back after its session ends (pi-browser waits for it), so the saver's save lease must
 *  outlast its run leaving 'running' by this long, or the next run saves over a write-back in flight. A bound this server
 *  chose (Browserbase publishes none); the serve layer's policy, passed to the store as signInSettleMs. Kernel and others keep none. */
export const BROWSERBASE_SETTLE_MS = 10_000;

/** The settle window a provider's save lease outlives its run leaving 'running' by: Browserbase's, and none for the rest. */
const settleFor = (provider: string): number => (provider === "browserbase" ? BROWSERBASE_SETTLE_MS : 0);

/** A browser the server keeps a sign-in for; a local Chrome keeps none. */
export type Vendor = "browserbase" | "kernel";
/** A saved sign-in as GET /agents/{id} shows it (the v2 SignIn), never its pointer: its key, provider, state, holder and
 *  verified_at, and its one secret's metadata under `secret` (sign-ins-secrets.ts signInSecretMeta). */
export type SignInView = { key: string; provider: Vendor; state: "ready" | "held" | "unreadable"; held_by: string | null; verified_at: string | null; secret: SecretMeta };

/** The vendor a run's browser resolves to keeps a sign-in for: Browserbase's and Kernel's; a local Chrome is refused by
 *  name; an unavailable browser has none. */
export function vendorOf(resolution: string): Vendor | undefined {
  if (resolution === "browserbase" || resolution === "kernel") return resolution;
  if (resolution === "chrome" || resolution === "cdp") throw new Error("a local Chrome keeps no saved sign-in: its cookies would sit on this server's disk");
  return undefined;
}

const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The agent's sign-ins as the v2 API shows them, never a pointer. Per sign-in: `held`/`held_by`
 *  when a live run holds its pointer's hash (store.signIns.handedHolder), a Browserbase one for its settle window past the
 *  run's end too (settleFor, so the view matches the save lease); `unreadable` when its pointer does not open under this
 *  server's seal key (then held_by is null — no hash to match a run by); `verified_at` from the store; and `secret`, its
 *  secret's metadata, changed_at being its saved_at. */
export async function signInViews(store: SignInsStore, sealKey: Buffer, agentId: string): Promise<SignInView[]> {
  const rows = await store.signIns.list(agentId);
  return Promise.all(rows.map(async (row): Promise<SignInView> => {
    const pointer = open(sealKey, agentId, row.provider, row.pointerSealed);
    const heldBy = pointer === undefined ? null : (await store.signIns.handedHolder(pointerHash(pointer), { settleMs: settleFor(row.provider) })) ?? null;
    const base = { key: row.name, provider: row.provider as Vendor, held_by: heldBy, verified_at: isoOf(row.verifiedAt) };
    const secret = signInSecretMeta(row);
    if (pointer === undefined) return { ...base, state: "unreadable", secret };
    return { ...base, state: heldBy ? "held" : "ready", secret };
  }));
}

/** The pointer of the agent's sign-in for `resolution`'s vendor `{ ref }`, `unreadable` when it
 *  does not open, or undefined when there is none or the browser keeps none. */
export async function peekSignIn(store: SignInsStore, sealKey: Buffer, agentId: string, resolution: string): Promise<{ ref: string } | "unreadable" | undefined> {
  const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
  if (!vendor) return undefined;
  const opened = await openSavedPointer(store, sealKey, agentId, vendor);
  return opened === undefined ? undefined : opened === "unreadable" ? "unreadable" : { ref: opened.pointer };
}

/** The agent's forgotten pointers for `resolution`'s vendor that open here, and whether any does not:
 *  `{ refs, unreadable }`, or `{ refs: [], unreadable: false }` for a browser that keeps none. */
export async function forgottenSignIns(store: SignInsStore, sealKey: Buffer, agentId: string, resolution: string): Promise<{ refs: string[]; unreadable: boolean }> {
  const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
  if (!vendor) return { refs: [], unreadable: false };
  const { pointers, unreadable } = await forgottenPointers(store, sealKey, agentId, vendor);
  return { refs: pointers, unreadable };
}

/** Forgets the agent's sign-in named `key`, across every provider that keeps it: each held check
 *  runs first, so one held refuses the whole forget (409 sign_in_held) and removes none; then each is moved to a tombstone
 *  and deleted at its vendor best effort. 404 when the agent has no sign-in named `key`. */
export async function forgetSignInView(
  store: SignInsStore,
  sealKey: Buffer,
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

/** The reads that find what a run was handed (handed-values.ts handedValuesOf): an agent's live pointer and its
 *  forgotten ones, opened under `sealKey`. Read-only: what the runner's learning end holds to refuse a run's pointer. */
export function signInReads(store: SignInsStore, sealKey: Buffer) {
  return {
    peek: (agentId: string, resolution: string) => peekSignIn(store, sealKey, agentId, resolution),
    forgotten: (agentId: string, resolution: string) => forgottenSignIns(store, sealKey, agentId, resolution),
  };
}

/** The sign-ins' read and forget surface over the store (view, peek, forgotten, forget), as the server's routes and a run's
 *  view use it. */
export function signInsOverStore(store: SignInsStore, sealKey: Buffer, vendors: SignInVendors) {
  return {
    view: (agentId: string) => signInViews(store, sealKey, agentId),
    ...signInReads(store, sealKey),
    forget: (agentId: string, key: string) => forgetSignInView(store, sealKey, vendors, agentId, key),
  };
}
