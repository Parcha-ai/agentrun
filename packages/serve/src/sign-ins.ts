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
import { randomBytes } from "node:crypto";
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
 *  made in its place until it is forgotten (DELETE). */
export type SignInView = { key: string; provider: Vendor; state: "ready" | "held" | "unreadable"; held_by: string | null; verified_at: string | null };
/** The vendor's side: make an agent's object (its pointer), and delete one. */
export type Vendors = { create(vendor: Vendor): Promise<string>; remove(vendor: Vendor, ref: string): Promise<void> };

/** `gone_at`: when the holder's process was last found gone, while it holds the lease (markGone). */
type Entry = { key: string; provider: Vendor; ref: string; verified_at: string | null; held_by: string | null; gone_at?: string | null };

/** How long a lease outlives its holder's process: pi-browser's default session timeout (DEFAULT_BROWSER_POLICY's
 *  sessionTimeoutS, 1800 s), which every session a run opens is created under, so none it opened before its process
 *  went can still write back after it. A holder that comes back (its relaunch) holds the lease again from then on. */
export const GONE_LEASE_MS = 1_800_000;
type Stored = { format: typeof FORMAT; sign_ins: Entry[] };

/** The vendor a run's browser resolves to (its plane's `browser`) keeps a sign-in for: Browserbase's and Kernel's; local
 *  Chrome is refused by name; an unavailable browser has none. */
export function vendorOf(resolution: string): Vendor | undefined {
  if (resolution === "browserbase" || resolution === "kernel") return resolution;
  if (resolution === "chrome" || resolution === "cdp") throw new Error("a local Chrome keeps no saved sign-in: its cookies would sit on this server's disk");
  return undefined;
}

const aad = (agentId: string, entry: Pick<Entry, "key" | "provider">) => `${FORMAT}|${agentId}|${entry.key}|${entry.provider}`;

export class SignIns {
  /** One read-modify-write at a time per agent; an agent's queue goes once it is empty. */
  private readonly chains = new Map<string, Promise<unknown>>();

  private readonly now: () => number;

  /** `holds(run)`: whether that run has not ended, so a lease it names still holds; `now`, the clock (tests'). */
  constructor(private readonly data: string, private readonly key: Buffer | undefined, private readonly vendors: Vendors, private readonly holds: (runId: string) => Promise<boolean>, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Whether sign-ins are kept here: never without a seal key, never in the clear. */
  get available(): boolean {
    return this.key !== undefined;
  }

  private file(agentId: string): string {
    return join(homeOf(this.data, agentId), SIGN_INS_DIR, FILE);
  }

  private async read(agentId: string): Promise<Entry[]> {
    const text = await readFile(this.file(agentId), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (text === null) return [];
    const stored = JSON.parse(text) as Stored;
    if (stored?.format !== FORMAT || !Array.isArray(stored.sign_ins)) throw new Error(`${FILE} is not a ${FORMAT} file, so it was left as it is`);
    return stored.sign_ins;
  }

  private async write(agentId: string, entries: Entry[]): Promise<void> {
    const dir = join(homeOf(this.data, agentId), SIGN_INS_DIR);
    if (!entries.length) return void (await rm(this.file(agentId), { force: true }));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error(`${SIGN_INS_DIR}/ is a link, which this server never follows`);
    // Synced before it answers: a pointer to a vendor object just made survives a crash of the machine.
    await writeDurable(this.file(agentId), `${JSON.stringify({ format: FORMAT, sign_ins: entries } satisfies Stored)}\n`);
  }

  private locked<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    return serialBy(this.chains, agentId, work);
  }

  /** Whether `entry`'s lease still holds: it names a run that has not ended, and whose process, if found gone, went
   *  less than GONE_LEASE_MS ago (a run that waits on its person with no process is never let go otherwise). */
  private async held(entry: Entry): Promise<boolean> {
    if (entry.held_by === null) return false;
    if (entry.gone_at && this.now() - Date.parse(entry.gone_at) >= GONE_LEASE_MS) return false;
    return this.holds(entry.held_by).catch(() => true);
  }

  /** `entry`'s pointer, opened under this server's seal key; undefined when it does not open (none now, or another). */
  private open(agentId: string, entry: Entry): string | undefined {
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
      if (this.open(agentId, entry) === undefined) return { key: entry.key, provider: entry.provider, state: "unreadable" as const, held_by: null, verified_at: entry.verified_at };
      const held = await this.held(entry);
      return { key: entry.key, provider: entry.provider, state: held ? "held" : "ready", held_by: held ? entry.held_by : null, verified_at: entry.verified_at };
    }));
  }

  /** The sign-in run `runId` of `agentId` starts from on `resolution` (its plane's browser): made at the vendor when the
   *  agent has none, then leased to this run to save, unless another run of the agent holds the lease. None for a
   *  browser that keeps none, or with no seal key. */
  async forRun(agentId: string, runId: string, resolution: string): Promise<HandedSignIn | undefined> {
    const vendor = vendorOf(resolution);
    if (!vendor || !this.key) return undefined;
    const key = this.key;
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
      if (save) Object.assign(entry, { held_by: runId, gone_at: null });
      try {
        await this.write(agentId, entries);
      } catch (error) {
        // Never kept, so never forgotten: the object just made goes at the vendor now, as far as it answers.
        if (made) await this.vendors.remove(vendor, ref).catch(() => undefined);
        throw error;
      }
      return { provider: vendor, ref, save };
    });
  }

  /** Run `runId`'s process was found gone: a lease it holds counts from now, while it does not come back (held). */
  markGone(agentId: string, runId: string): Promise<void> {
    return this.locked(agentId, async () => {
      const entries = await this.read(agentId);
      const mine = entries.filter((entry) => entry.held_by === runId && !entry.gone_at);
      if (!mine.length) return;
      for (const entry of mine) entry.gone_at = new Date(this.now()).toISOString();
      await this.write(agentId, entries);
    });
  }

  /** Ends the lease run `runId` holds, if it holds one: it ended, or let go to wait for its person. A session of it that saved (its
   *  run directory's SIGN_IN_SAVED) makes that the sign-in's `verified_at`. */
  release(agentId: string, runId: string, runDir: string): Promise<void> {
    return this.locked(agentId, async () => {
      const marker = join(runDir, SIGN_IN_SAVED);
      const saved = await readFile(marker, "utf8").then((text) => text.trim(), () => undefined);
      const entries = await this.read(agentId);
      const mine = entries.filter((entry) => entry.held_by === runId);
      if (mine.length) {
        for (const entry of mine) Object.assign(entry, { held_by: null, gone_at: null }, saved && !Number.isNaN(Date.parse(saved)) ? { verified_at: new Date(saved).toISOString() } : {});
        await this.write(agentId, entries);
      }
      await rm(marker, { force: true });
    });
  }

  /** DELETE /agents/{id}/sign-ins/{key}: each vendor's object deleted (best effort: what failed is said), then the
   *  pointer. 404 for a key the agent has none of; 409 while a run holds it. */
  forget(agentId: string, signInKey: string): Promise<{ key: string; removed: Array<{ provider: Vendor; at_vendor: "deleted" | "not_deleted"; message?: string }> }> {
    return this.locked(agentId, async () => {
      const entries = await this.read(agentId);
      const named = entries.filter((entry) => entry.key === signInKey);
      if (!named.length) throw new ApiError("not_found", `The agent ${agentId} has no sign-in ${signInKey}.`);
      for (const entry of named) if (await this.held(entry)) throw new ApiError("sign_in_held", `The sign-in ${signInKey} is held by the run ${entry.held_by}, which may still save to it: forget it once that run ends.`, { details: { held_by: entry.held_by } });
      const removed = [];
      for (const entry of named) {
        const ref = this.open(agentId, entry);
        const gone = ref === undefined ? new Error("its pointer does not open under this server's seal key") : await this.vendors.remove(entry.provider, ref).then(() => undefined, (error: Error) => error);
        removed.push({ provider: entry.provider, at_vendor: gone ? "not_deleted" as const : "deleted" as const, ...(gone ? { message: `Not deleted at ${entry.provider}: ${gone.message}. This server no longer points to it.` } : {}) });
      }
      await this.write(agentId, entries.filter((entry) => entry.key !== signInKey));
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
