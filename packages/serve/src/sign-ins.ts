// An agent's saved sign-ins: the browser it signed in with stays signed in for its later runs. The cookies stay at the
// browser's vendor (a Browserbase context, a Kernel profile); this server keeps only a pointer to that object per agent,
// in DATA/homes/<home key>/sign-ins/sign-ins.json (a host-owned folder: the home API neither reads nor writes it, and no
// run's tools see it), each pointer sealed under the seal key tool keys are kept under (AGENTRUN_SEAL_KEY), bound to its
// agent, key and vendor. One saved profile per agent per vendor, keyed `default`; the host picks it, never the model.
// The server resolves the pointer before a run's launch and hands the run the pointer over its secrets' pipe, never its
// environment: the run's process never gets the seal key. Local Chrome keeps none (its cookies would sit on this disk).
//
// Saving is leased across runs: each run is its own process, so pi-browser's one-saver rule (per process) cannot see
// two runs of one agent. The first run of the agent to start with the browser holds the lease and its sessions save;
// a run started while another holds it starts from the same sign-in and saves nothing. The lease ends when its run
// ends, or lets go cleanly to wait for its person (runs.ts); a relaunch or a restart keeps it, since a session the run
// opened before its process went may still write back. One whose run has ended since (a server down first) is stale.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { seal, unseal } from "@parcha/pi-durable-agent";
import { ApiError } from "./errors.js";
import { homeOf, serialBy, writeDurable } from "./files.js";

export const SIGN_INS_DIR = "sign-ins";
const FILE = "sign-ins.json";
const FORMAT = "sign-ins/1";
/** The one saved profile an agent keeps per vendor. */
export const SIGN_IN_KEY = "default";
/** The file a run's process writes in its run directory when a session that saved to its sign-in let go: when the
 *  lease ends, its time is the sign-in's `verified_at`. A time, never a pointer. */
export const SIGN_IN_SAVED = "sign-in-saved";

export type Vendor = "browserbase" | "kernel";
/** What a run's process is handed: the vendor, the pointer it opens (a context id, a profile name), and whether it saves. */
export type HandedSignIn = { provider: Vendor; ref: string; save: boolean };
/** A sign-in as GET /agents/{id} shows it (the contract's SignIn): never its ref. `unreadable` (this server's own state):
 *  its pointer does not open under this server's seal key (none now, or another), so no run starts from it and none is
 *  made in its place until it is forgotten (DELETE); `held_by` names a run that still holds its lease. */
export type SignInView = { key: string; provider: Vendor; state: "ready" | "held" | "unreadable"; held_by: string | null; verified_at: string | null };
/** The vendor's side: make an agent's object (its pointer), and delete one. */
export type Vendors = { create(vendor: Vendor): Promise<string>; remove(vendor: Vendor, ref: string): Promise<void> };

/** `gone_at`: when the holder's process was last found gone, while it holds the lease (markGone). */
/** `held_until`: a Browserbase saver that ended still holds the lease until then (BROWSERBASE_SETTLE_MS). */
type Entry = { key: string; provider: Vendor; ref: string; verified_at: string | null; held_by: string | null; gone_at?: string | null; held_until?: string | null };

/** Browserbase writes a saved context back after its session ends (pi-browser waits profileSettleMs, 5 s, for it), so
 *  its saver's lease outlasts the run's end by twice that: a run started meanwhile neither saves over it. A bound this
 *  server chose; Browserbase publishes none. */
export const BROWSERBASE_SETTLE_MS = 10_000;

/** How long a lease outlives its holder's process: pi-browser's default session timeout (DEFAULT_BROWSER_POLICY's
 *  sessionTimeoutS, 1800 s), which every session a run opens is created under, so none it opened before its process
 *  went can still write back after it. A holder that comes back (its relaunch) holds the lease again from then on. */
export const GONE_LEASE_MS = 1_800_000;
/** A forgotten sign-in's pointer (forget), kept sealed as it was, under the same binding (agent, key, vendor): never
 *  served, never handed to a run, never counted as a sign-in. It is kept only so a server started later can still cut
 *  it from what a run handed it says (runs.ts peekSignIn), though the run ended or the sign-in was replaced since. */
type Forgotten = { key: string; provider: Vendor; ref: string; forgotten_at: string };
/** How many forgotten pointers an agent keeps, the oldest dropped first. A run handed one dropped since is withheld, as
 *  one whose sign-in does not open is (runs.ts): its pointer could no longer be cut. */
export const MAX_FORGOTTEN = 32;
/** `forgotten_dropped`: set once a forgotten pointer was dropped past MAX_FORGOTTEN, so a run handed several pointers (its
 *  mark `true`, none named) may hold one no longer kept: such a run is withheld from then on (runs.ts handedPointers). */
type Stored = { format: typeof FORMAT; sign_ins: Entry[]; forgotten?: Forgotten[]; forgotten_dropped?: true };

/** What a run's serve.json keeps of the sign-in pointer it was handed (runs.ts `sign_in_handed`), and what forget asks
 *  after: its SHA-256, never the pointer. */
export const pointerHash = (ref: string): string => createHash("sha256").update(ref, "utf8").digest("hex");

/** Which run still going was handed the sign-in whose pointer hashes to `hash` (runs.ts handedTo), if one was; `hash`
 *  undefined for a pointer that does not open here, which any run handed a sign-in may hold. */
export type HandedTo = (agentId: string, hash: string | undefined) => Promise<string | undefined>;

/** The vendor a run's browser resolves to (its plane's `browser`) keeps a sign-in for: Browserbase's and Kernel's; local
 *  Chrome is refused by name; an unavailable browser has none. */
export function vendorOf(resolution: string): Vendor | undefined {
  if (resolution === "browserbase" || resolution === "kernel") return resolution;
  if (resolution === "chrome" || resolution === "cdp") throw new Error("a local Chrome keeps no saved sign-in: its cookies would sit on this server's disk");
  return undefined;
}

const aad = (agentId: string, entry: Pick<Entry, "key" | "provider">) => `${FORMAT}|${agentId}|${entry.key}|${entry.provider}`;

export class SignIns {
  /** One read-modify-write at a time per agent; an agent's queue goes once it is empty. In this process alone: it, and
   *  forget's ordering against a launch handing a pointer (forRun's keep), assume one server per data directory, which
   *  the data directory's lock holds (server-lock.ts). */
  private readonly chains = new Map<string, Promise<unknown>>();

  private readonly now: () => number;
  private readonly writeFile: (path: string, text: string) => Promise<unknown>;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly handedTo: HandedTo | undefined;

  /** `holds(run)`: whether that run has not ended, so a lease it names still holds; `handedTo`, which run still going
   *  was handed a pointer (runs.ts), so forget waits for it; `now` and `sleep`, the clock, and `write`, the durable
   *  write (writeDurable), the tests'. */
  constructor(private readonly data: string, private readonly key: Buffer | undefined, private readonly vendors: Vendors, private readonly holds: (runId: string) => Promise<boolean>, options: { handedTo?: HandedTo; now?: () => number; sleep?: (ms: number) => Promise<void>; write?: (path: string, text: string) => Promise<unknown> } = {}) {
    this.handedTo = options.handedTo;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.writeFile = options.write ?? writeDurable;
  }

  /** Whether sign-ins are kept here: never without a seal key, never in the clear. */
  get available(): boolean {
    return this.key !== undefined;
  }

  private file(agentId: string): string {
    return join(homeOf(this.data, agentId), SIGN_INS_DIR, FILE);
  }

  private async stored(agentId: string): Promise<{ sign_ins: Entry[]; forgotten: Forgotten[]; dropped: boolean }> {
    const text = await readFile(this.file(agentId), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (text === null) return { sign_ins: [], forgotten: [], dropped: false };
    const stored = JSON.parse(text) as Stored;
    if (stored?.format !== FORMAT || !Array.isArray(stored.sign_ins) || (stored.forgotten !== undefined && !Array.isArray(stored.forgotten))) throw new Error(`${FILE} is not a ${FORMAT} file, so it was left as it is`);
    return { sign_ins: stored.sign_ins, forgotten: stored.forgotten ?? [], dropped: stored.forgotten_dropped === true };
  }

  private async read(agentId: string): Promise<Entry[]> {
    return (await this.stored(agentId)).sign_ins;
  }

  /** `forgotten`: the agent's forgotten pointers as they are to be kept; absent, those the file keeps now (every write is
   *  under the agent's lock, so none comes between). */
  private async write(agentId: string, entries: Entry[], forgotten?: { kept: Forgotten[]; dropped: boolean }): Promise<void> {
    const dir = join(homeOf(this.data, agentId), SIGN_INS_DIR);
    const { forgotten: kept, dropped } = forgotten ? { forgotten: forgotten.kept, dropped: forgotten.dropped } : await this.stored(agentId);
    if (!entries.length && !kept.length && !dropped) return void (await rm(this.file(agentId), { force: true }));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error(`${SIGN_INS_DIR}/ is a link, which this server never follows`);
    // Synced before it answers: a pointer to a vendor object just made survives a crash of the machine.
    await this.writeFile(this.file(agentId), `${JSON.stringify({ format: FORMAT, sign_ins: entries, ...(kept.length ? { forgotten: kept } : {}), ...(dropped ? { forgotten_dropped: true as const } : {}) } satisfies Stored)}\n`);
  }

  private locked<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    return serialBy(this.chains, agentId, work);
  }

  /** Whether `entry`'s lease still holds: it names a run that has not ended; or, once its process was found gone, that
   *  went less than GONE_LEASE_MS ago, ended or not (a run waiting on its person with no process, or one that crashed and
   *  ended, is never let go otherwise, or let go too soon). */
  private async held(entry: Entry): Promise<boolean> {
    if (entry.held_by === null) return false;
    if (entry.held_until) return this.now() < Date.parse(entry.held_until);
    // A Browserbase session that lived out the timeout still writes its context back after it ends; Kernel's browser
    // ends at its idle timeout and saves as it ends, so it needs no margin.
    // Once its process is found gone, that alone decides, whether its run has ended since or not: a session it left
    // live may still write back until then.
    if (entry.gone_at) return this.now() - Date.parse(entry.gone_at) < GONE_LEASE_MS + (entry.provider === "browserbase" ? BROWSERBASE_SETTLE_MS : 0);
    return this.holds(entry.held_by).catch(() => true);
  }

  /** `entry`'s pointer, opened under this server's seal key; undefined when it does not open (none now, or another). A
   *  forgotten one opens under the same binding, read only by `forgotten`, never as a sign-in. */
  private open(agentId: string, entry: Pick<Entry, "key" | "provider" | "ref">): string | undefined {
    if (!this.key) return undefined;
    try {
      return unseal(this.key, Buffer.from(entry.ref, "base64"), aad(agentId, entry)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** The agent's sign-ins, as the contract shows them: never a ref. */
  async view(agentId: string): Promise<SignInView[]> {
    const entries = await this.read(agentId).catch(() => []);
    return Promise.all(entries.map(async (entry) => {
      const held = await this.held(entry);
      // Unreadable or not, a run that holds its lease is named: forget is refused until it ends.
      if (this.open(agentId, entry) === undefined) return { key: entry.key, provider: entry.provider, state: "unreadable" as const, held_by: held ? entry.held_by : null, verified_at: entry.verified_at };
      return { key: entry.key, provider: entry.provider, state: held ? "held" : "ready", held_by: held ? entry.held_by : null, verified_at: entry.verified_at };
    }));
  }

  /** The pointer of `agentId`'s sign-in for `resolution`, read only: no lease taken, nothing made or written. For a run
   *  this server loads (after a restart), whose rows, errors and answers must never show it: `{ ref }`; `unreadable`
   *  when the agent keeps one that does not open under this server's seal key (none now, or another), or its sign-ins
   *  file cannot be read or parsed, told apart from none at all (undefined: no file, or no entry for the vendor). */
  async peek(agentId: string, resolution: string): Promise<{ ref: string } | "unreadable" | undefined> {
    const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
    if (!vendor) return undefined;
    // Only a file that is not there means none: one this server may not read, or that does not parse, is unreadable.
    const entries = await this.read(agentId).catch(() => null);
    if (entries === null) return "unreadable";
    const entry = entries.find((e) => e.key === SIGN_IN_KEY && e.provider === vendor);
    if (!entry) return undefined;
    const ref = this.open(agentId, entry);
    return ref === undefined ? "unreadable" : { ref };
  }

  /** The pointers of `agentId`'s forgotten sign-ins for `resolution`'s vendor, read only, for a run this server loads that
   *  may have been handed one (runs.ts peekSignIn): never a sign-in. `refs`, each that opens under this server's seal
   *  key; `unreadable`, whether one does not (none now, or another); `dropped`, whether one was ever dropped past
   *  MAX_FORGOTTEN. `unreadable` alone when the sign-ins file can't be read or parsed. */
  async forgotten(agentId: string, resolution: string): Promise<{ refs: string[]; unreadable: boolean; dropped: boolean } | "unreadable"> {
    const vendor = (() => { try { return vendorOf(resolution); } catch { return undefined; } })();
    if (!vendor) return { refs: [], unreadable: false, dropped: false };
    const stored = await this.stored(agentId).catch(() => null);
    if (stored === null) return "unreadable";
    const opened = stored.forgotten.filter((gone) => gone.provider === vendor).map((gone) => this.open(agentId, gone));
    return { refs: opened.filter((ref): ref is string => ref !== undefined), unreadable: opened.some((ref) => ref === undefined), dropped: stored.dropped };
  }

  /** The sign-in run `runId` of `agentId` starts from on `resolution` (its plane's browser): made at the vendor when the
   *  agent has none, then leased to this run to save, unless another run of the agent holds the lease. None for a
   *  browser that keeps none, or with no seal key. `keep`: the run keeps that it was handed it (its serve.json), before
   *  any forget of the agent's can look (forget's handedTo, under the same lock); one it could not keep is handed none. */
  async forRun(agentId: string, runId: string, resolution: string, keep?: (handed: HandedSignIn) => Promise<boolean>): Promise<HandedSignIn | undefined> {
    const vendor = vendorOf(resolution);
    if (!vendor || !this.key) return undefined;
    const key = this.key;
    // The Browserbase saver itself, resumed while its last save is still being written back (held_until): it waits that
    // out, at most BROWSERBASE_SETTLE_MS, before it is handed save again, so no session of it opens on a context in flux.
    const mine = (await this.read(agentId).catch(() => [])).find((e) => e.key === SIGN_IN_KEY && e.provider === vendor && e.held_by === runId && e.held_until);
    const rest = mine ? Date.parse(mine.held_until!) - this.now() : 0;
    if (rest > 0) await this.sleep(Math.min(rest, BROWSERBASE_SETTLE_MS));
    return this.locked(agentId, async () => {
      const entries = await this.read(agentId);
      let entry = entries.find((e) => e.key === SIGN_IN_KEY && e.provider === vendor);
      let ref: string | undefined;
      let made = false;
      if (entry) {
        // Never replaced by itself: the vendor's object it points to would be left behind, holding the agent's cookies.
        ref = this.open(agentId, entry);
        if (ref === undefined) throw new Error(`its saved sign-in does not open under this server's seal key: forget it (DELETE /v2/agents/${agentId}/sign-ins/${SIGN_IN_KEY}) and its next run signs in afresh`);
      } else {
        ref = await this.vendors.create(vendor);
        made = true;
        entry = { key: SIGN_IN_KEY, provider: vendor, ref: "", verified_at: null, held_by: null };
        entry.ref = seal(key, Buffer.from(ref, "utf8"), aad(agentId, entry)).toString("base64");
        entries.push(entry);
      }
      const save = entry.held_by === runId || !(await this.held(entry));
      if (save) Object.assign(entry, { held_by: runId, gone_at: null, held_until: null });
      try {
        await this.write(agentId, entries);
      } catch (error) {
        // Never kept, so never forgotten: the object just made goes at the vendor now, as far as it answers. Unless the
        // write landed and only what follows it failed (the folder's sync): then the pointer is kept, and so is its object.
        const sealed = entry.ref;
        const kept = await this.read(agentId).then((now) => now.some((e) => e.ref === sealed), () => false);
        if (made && !kept) await this.vendors.remove(vendor, ref).catch(() => undefined);
        throw error;
      }
      const handed = { provider: vendor, ref, save };
      return !keep || (await keep(handed)) ? handed : undefined;
    });
  }

  /** Run `runId`'s process was found gone: a lease it holds counts from now, while it does not come back (held). */
  markGone(agentId: string, runId: string): Promise<void> {
    return this.locked(agentId, async () => {
      const entries = await this.read(agentId);
      const mine = entries.filter((entry) => entry.held_by === runId && !entry.gone_at && !entry.held_until);
      if (!mine.length) return;
      for (const entry of mine) entry.gone_at = new Date(this.now()).toISOString();
      await this.write(agentId, entries);
    });
  }

  /** Ends the lease run `runId` holds, if it holds one: it ended, or let go to wait for its person; one whose process did
   *  not let its sessions go (`clean` false) keeps it until the gone rule ends it. A session of it that saved (its
   *  run directory's SIGN_IN_SAVED) makes that the sign-in's `verified_at`. */
  release(agentId: string, runId: string, runDir: string, clean = true): Promise<void> {
    return this.locked(agentId, async () => {
      const marker = join(runDir, SIGN_IN_SAVED);
      const saved = await readFile(marker, "utf8").then((text) => text.trim(), () => undefined);
      const entries = await this.read(agentId);
      const mine = entries.filter((entry) => entry.held_by === runId && !entry.held_until);
      if (mine.length) {
        const when = saved && !Number.isNaN(Date.parse(saved)) ? new Date(saved).toISOString() : undefined;
        const now = new Date(this.now()).toISOString();
        // `clean`: its process let its sessions go. One that crashed may have left a session live at the vendor, which
        // writes back when it ends: the lease stays named for it, and the gone rule (held) ends it.
        // A Browserbase session that saved is still being written back: the lease waits that out, named for this run.
        for (const entry of mine) Object.assign(entry, !clean ? { gone_at: entry.gone_at ?? now } : { gone_at: null, ...(when && entry.provider === "browserbase" ? { held_until: new Date(this.now() + BROWSERBASE_SETTLE_MS).toISOString() } : { held_by: null, held_until: null }) }, when ? { verified_at: when } : {});
        await this.write(agentId, entries);
      }
      await rm(marker, { force: true });
    });
  }

  /** DELETE /agents/{id}/sign-ins/{key}: each vendor's object deleted (best effort: what failed is said), then the
   *  pointer. 404 for a key the agent has none of; 409 while a run holds its lease, or while a run it was handed is still
   *  going (handedTo), its lease let go or not: what that run says could repeat the pointer, and a server started after
   *  the pointer is gone could no longer read it back to cut it (runs.ts peekSignIn). */
  forget(agentId: string, signInKey: string): Promise<{ key: string; removed: Array<{ provider: Vendor; at_vendor: "deleted" | "not_deleted"; message?: string }> }> {
    return this.locked(agentId, async () => {
      const entries = await this.read(agentId);
      const named = entries.filter((entry) => entry.key === signInKey);
      if (!named.length) throw new ApiError("not_found", `The agent ${agentId} has no sign-in ${signInKey}.`);
      for (const entry of named) if (await this.held(entry)) throw new ApiError("sign_in_held", `The sign-in ${signInKey} is held by the run ${entry.held_by}, which may still save to it: forget it once that run ends.`, { details: { held_by: entry.held_by } });
      // Asked under the lock a launch hands a pointer under (forRun's keep): a run handed it now is one this sees.
      for (const entry of named) {
        const ref = this.open(agentId, entry);
        const runId = await this.handedTo?.(agentId, ref === undefined ? undefined : pointerHash(ref));
        if (runId) throw new ApiError("sign_in_held", `The sign-in ${signInKey} was handed to the run ${runId}, which is still going: what it says could repeat it, and once it is forgotten a restarted server could no longer cut it from what that run shows. Forget it once that run ends.`, { details: { handed_to: runId } });
      }
      const removed = [];
      for (const entry of named) {
        const ref = this.open(agentId, entry);
        const gone = ref === undefined ? new Error("its pointer does not open under this server's seal key") : await this.vendors.remove(entry.provider, ref).then(() => undefined, (error: Error) => error);
        removed.push({ provider: entry.provider, at_vendor: gone ? "not_deleted" as const : "deleted" as const, ...(gone ? { message: `Not deleted at ${entry.provider}: ${gone.message}. This server no longer points to it.` } : {}) });
      }
      // Each forgotten pointer is kept sealed as it was, for cutting alone (Forgotten), the newest MAX_FORGOTTEN of them.
      const { forgotten, dropped } = await this.stored(agentId);
      const at = new Date(this.now()).toISOString();
      const all = [...forgotten, ...named.map((entry) => ({ key: entry.key, provider: entry.provider, ref: entry.ref, forgotten_at: at }))];
      await this.write(agentId, entries.filter((entry) => entry.key !== signInKey), { kept: all.slice(-MAX_FORGOTTEN), dropped: dropped || all.length > MAX_FORGOTTEN });
      return { key: signInKey, removed };
    });
  }
}

const base = (set: string | undefined, fallback: string) => (set?.trim() || fallback).replace(/\/+$/, "");

/** The vendors over their REST APIs, with the server's keys (`env`, read at each call) through `fetchFor` (the tests'
 *  fakes under faux). Browserbase: a context made for the agent (POST /v1/contexts, which opens no session; Browserbase
 *  bills a session's browser time and proxy data), deleted with DELETE /v1/contexts/{id}. Kernel: a profile made under a
 *  random name (POST /profiles, which starts no browser; Kernel bills a browser's running time), since a profile name
 *  is the account's, so one derived from the agent would be any server's on that account; deleted with DELETE
 *  /profiles/{name}. The name is the pointer, sealed as a context id is, and well inside pi-browser's 64 characters. A
 *  404 on delete is gone already. */
export function vendorsOver(env: () => NodeJS.ProcessEnv, fetchFor: (vendor: Vendor) => Promise<typeof fetch | undefined>): Vendors {
  const call = async (vendor: Vendor, method: "POST" | "DELETE", url: string, headers: Record<string, string>, body?: unknown): Promise<Response> => {
    const fetcher = await fetchFor(vendor);
    if (!fetcher) throw new Error(`this server has no ${vendor} to call`);
    // Fetch's own words name the URL, which holds the pointer on a delete (a base URL with no scheme fails to parse with
    // it): only the error's kind is said, never its message.
    const res = await fetcher(url, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch((error: unknown) => {
      throw new Error(`${vendor} unreachable (${error instanceof Error ? error.name : "Error"})`);
    });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`${vendor} answered ${res.status}`);
    return res;
  };
  const bb = (e: NodeJS.ProcessEnv) => ({ url: base(e.BROWSERBASE_BASE_URL, "https://api.browserbase.com"), headers: { "x-bb-api-key": e.BROWSERBASE_API_KEY ?? "" } });
  const kernel = (e: NodeJS.ProcessEnv) => ({ url: base(e.KERNEL_BASE_URL, "https://api.onkernel.com"), headers: { authorization: `Bearer ${e.KERNEL_API_KEY ?? ""}` } });
  return {
    async create(vendor) {
      if (vendor === "kernel") {
        const { url, headers } = kernel(env());
        const name = `agentrun-${randomBytes(12).toString("hex")}`;
        const made = ((await (await call(vendor, "POST", `${url}/profiles`, headers, { name })).json()) as { name?: unknown }).name;
        if (made !== name) throw new Error("kernel answered another profile than the one asked for");
        return name;
      }
      const e = env();
      const { url, headers } = bb(e);
      // Behind a proxy (a base URL set) the project is the key's, as pi-browser's provider has it; a direct key names it.
      const project = e.BROWSERBASE_BASE_URL || e.BROWSERBASE_CONNECT_BASE_URL ? {} : { projectId: e.BROWSERBASE_PROJECT_ID };
      const id = ((await (await call(vendor, "POST", `${url}/v1/contexts`, headers, project)).json()) as { id?: unknown }).id;
      if (typeof id !== "string" || !id) throw new Error("browserbase answered no context id");
      return id;
    },
    async remove(vendor, ref) {
      const { url, headers } = vendor === "kernel" ? kernel(env()) : bb(env());
      await call(vendor, "DELETE", `${url}/${vendor === "kernel" ? "profiles" : "v1/contexts"}/${encodeURIComponent(ref)}`, headers);
    },
  };
}
