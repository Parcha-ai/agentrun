// The agent's browser computer as the run's browser tool drives it: pi-browser's provider over the one session the claim
// started (assignedSessionProvider), so the tool's custody never creates or ends a browser itself (the claim releases
// it). Every attach asks the computer's provider for its CDP URL again (Browserbase's or Kernel's signed URL, the local
// Chrome's loopback one), which goes to the driver's dial alone; the target's own URL carries no query or credentials.
// Nothing here names a vendor.
import type { AttachTarget, BrowserProvider, ResourceStatus } from "@parcha/pi-browser";
import type { ClaimBrowser } from "./workspace/resolve-computer.js";

/** `url` with no query, fragment or credentials: what the target may show of it. */
function shown(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "";
  }
}

/** The CDP target the claim's browser `computer` is dialed at now. */
export async function claimBrowserTarget(computer: ClaimBrowser): Promise<AttachTarget> {
  const url = await computer.url();
  return { sdkCdpUrl: shown(url), dial: { url } };
}

/** pi-browser's provider over the claim's browser `computer`. A session its provider says is gone (or not found) is gone;
 *  any other failure to read it is thrown in its words. */
export async function claimBrowserProvider(computer: ClaimBrowser): Promise<BrowserProvider> {
  const { assignedSessionProvider } = await import("@parcha/pi-browser/providers/assigned");
  return assignedSessionProvider({
    name: computer.provider,
    session: {
      id: computer.id,
      attach: () => claimBrowserTarget(computer),
      status: (): Promise<ResourceStatus> =>
        computer.url().then(
          () => "running",
          (error: unknown) => {
            const code = (error as { code?: unknown } | null)?.code;
            if (code === "gone" || code === "not_found") return "gone";
            throw error;
          },
        ),
    },
  });
}
