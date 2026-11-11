// The agent's browser computer as the run's browser tool drives it: pi-browser's provider over the claim's browser
// (ClaimBrowser). Custody opens each session through it at its call, under its tag, and releases it when it lets the
// session go, so a session lives, and is booked on the run's spend, only while the tool holds it. Every attach asks
// the computer's provider for its CDP URL again (Browserbase's or Kernel's signed URL, the local Chrome's loopback one),
// held in memory for the driver and the live view alone, as pi-browser's own providers hold theirs. Nothing here names
// a vendor.
import type { BrowserProvider, ResourceStatus } from "@parcha/pi-browser";
import type { ClaimBrowser } from "./workspace/resolve-computer.js";

/** What a session of the claim's browser is opened with: none of a run's session settings (no proxy, Verified browser,
 *  place, region or context by id) and no saved profile, which the computer protocol does not carry. */
const SETTINGS = { proxies: false, verified: false, geolocation: false, region: false, context: false } as const;

/** pi-browser's provider over the claim's browser `computer`. A session its provider says is gone (or not found) is gone;
 *  any other failure to read it is thrown in its words. */
export function claimBrowserProvider(computer: ClaimBrowser): BrowserProvider {
  return {
    name: computer.provider,
    caps: { timeoutModel: "wall-clock", maxLifetimeS: computer.maxLifetimeS, survivesDisconnect: true, releaseIsAsync: false, profiles: false, extension: "preinstalled", settings: SETTINGS },
    create: async (spec, signal) => ({ id: await computer.open(spec.tag, spec.maxLifetimeS, signal), tag: spec.tag }),
    findByTag: async (tag, signal) => (await computer.find(tag, signal)).map((id) => ({ id, tag })),
    status: (ref): Promise<ResourceStatus> =>
      computer.url(ref.id).then(
        () => "running",
        (error: unknown) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === "gone" || code === "not_found") return "gone";
          throw error;
        },
      ),
    attach: async (ref) => ({ sdkCdpUrl: await computer.url(ref.id) }),
    release: (ref) => computer.close(ref.id),
  };
}
