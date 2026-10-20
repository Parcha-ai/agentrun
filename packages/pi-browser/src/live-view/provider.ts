import type { BrowserProvider } from "../core/host.js";
import type { LiveViewHost } from "./server.js";

/** The provider with a live view: `liveView(ref)` reports the viewer's URL (to the host's `onSession`, the one place it goes), and a release kills the
 *  token before the provider's own release runs, so a session that is going away cannot be driven. Wrap the cdp provider with it, as the frame recorder
 *  wraps a provider with `watch`; the provider's own methods are untouched. */
export function liveViewProvider(provider: BrowserProvider, host: LiveViewHost): BrowserProvider {
  const wrapped = Object.create(provider) as BrowserProvider;
  wrapped.liveView = async (ref) => {
    const known = host.known(ref.tag);
    if (known) return known;
    // A browser that cannot be reached has no view to give; the session's row still reaches the host without one.
    try { return await host.open(ref.tag, (await provider.attach(ref)).sdkCdpUrl); } catch { return null; }
  };
  wrapped.release = async (ref, signal) => {
    await host.release(ref.tag);
    await provider.release(ref, signal);
  };
  return wrapped;
}
