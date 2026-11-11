// An agent's saved sign-ins: the browser it signed in with stays signed in for its later runs. The cookies stay at the
// browser's vendor (a Browserbase context, a Kernel profile); this server keeps only a sealed pointer to that object per
// agent and vendor, in the one store (sign-ins-store.ts), and a run on the runner reads it under its own claim. Here: the
// names a run and an agent's home use for it, and the vendors' own calls.
import { randomBytes } from "node:crypto";
import type { Vendor } from "./sign-ins-store.js";

/** The folder a sign-in was kept in under an agent's home: never served or written by the home API. */
export const SIGN_INS_DIR = "sign-ins";
/** The one saved profile an agent keeps per vendor. */
export const SIGN_IN_KEY = "default";
/** The file a run's process writes in its run directory when a session that saved to its sign-in let go: when the
 *  lease ends, its time is the sign-in's `verified_at`. A time, never a pointer. */
export const SIGN_IN_SAVED = "sign-in-saved";

/** The vendor's side: make an agent's object (its pointer), and delete one. */
export type Vendors = { create(vendor: Vendor): Promise<string>; remove(vendor: Vendor, ref: string): Promise<void> };

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
