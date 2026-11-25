// An agent's saved sign-ins: the browser it signed in with stays signed in for its later runs. The cookies stay at the
// browser's vendor (its provider's profile: a Browserbase context, a Kernel profile); this server keeps only a sealed
// pointer to that object per agent and vendor, in the one store (sign-ins-store.ts), and a run on the runner reads it
// under its own claim. Here: the names a run and an agent's home use for it, and the vendor calls, which are the
// provider's own (its profiles), so nothing here names a vendor.
import { BrowserVendorError, causeOf, isBrowserProvider, type Result } from "@parcha/agentrun-computer";
import { providerFromEnv } from "./computer-keys.js";

/** The folder a sign-in was kept in under an agent's home: never served or written by the home API. */
export const SIGN_INS_DIR = "sign-ins";
/** The one saved profile an agent keeps per vendor. */
export const SIGN_IN_KEY = "default";

/** The vendor's side: make an agent's object (its pointer), and delete one. */
export type Vendors = { create(vendor: string): Promise<string>; remove(vendor: string, ref: string): Promise<void> };

/** How long one vendor call may take before it is given up as unreachable. */
const CALL_MS = 20_000;

/** A provider's failed profile call in words that name no pointer, URL or key: "<vendor> answered <status>" for a
 *  vendor's refusal, "<vendor> unreachable (<error's kind>)" for no answer (fetch's own words name the URL, which holds
 *  the pointer on a delete), else the provider's own words, which never carry either. */
function failure(vendor: string, result: Result<unknown>): Error {
  const cause = causeOf(result);
  if (cause instanceof BrowserVendorError) {
    const { status } = cause;
    if (status === undefined) return new Error(`${vendor} unreachable (${(cause.cause as Error | undefined)?.name ?? "Error"})`);
    if (status >= 400) return new Error(`${vendor} answered ${status}`);
  }
  return new Error(result.ok ? `${vendor} failed` : result.error.message);
}

/** The vendors' profiles, each through its provider (profiles.create and profiles.remove: what makes the object, with
 *  what, and that a 404 on delete is gone already, are the provider's), made at each call from the server's keys and
 *  gateway (`env`, read then: computer-keys.ts providerFromEnv) over `fetchFor`'s fetch (the tests' fakes under faux). A
 *  provider whose browser keeps no profile is refused by name. */
export function vendorsOver(env: () => NodeJS.ProcessEnv, fetchFor: (vendor: string) => Promise<typeof fetch | undefined>): Vendors {
  const profilesOf = async (vendor: string) => {
    const fetcher = await fetchFor(vendor);
    if (!fetcher) throw new Error(`this server has no ${vendor} to call`);
    const made = await providerFromEnv(vendor, env(), { fetch: fetcher });
    if (!made.ok) throw new Error(made.error.message);
    if (!isBrowserProvider(made.value) || !made.value.profiles) throw new Error(`${vendor} keeps no saved sign-in`);
    return made.value.profiles;
  };
  return {
    async create(vendor) {
      const made = await (await profilesOf(vendor)).create({ signal: AbortSignal.timeout(CALL_MS) });
      if (!made.ok) throw failure(vendor, made);
      return made.value;
    },
    async remove(vendor, ref) {
      const gone = await (await profilesOf(vendor)).remove(ref, { signal: AbortSignal.timeout(CALL_MS) });
      if (!gone.ok) throw failure(vendor, gone);
    },
  };
}
