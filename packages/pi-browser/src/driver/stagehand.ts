// Stagehand is created sealed: no inference leaves through it (act, extract and observe are refused), nothing is cached
// server side, and the driver never ends the browser: custody releases it through the provider.
import { type DriverFactory } from "../core/custody.js";
import type { PageDriver } from "../core/tools.js";
import { pageDriver } from "./page-driver.js";
import { attachStep, throwIfCancelled, untilCancelled } from "./sealed.js";

export const STAGEHAND_INFERENCE_REFUSED = "Stagehand inference is off in this harness: act, extract and observe are unavailable. Drive the page with run code or snapshot IDs.";
/** No telemetry is given, and Stagehand 4.4 starts its trace exporter only for an endpoint it is given: no span is sent. */
export const SEALED_STAGEHAND = {
  logging: { level: "off" },
  cache: false,
  model: { generate: async (): Promise<never> => { throw new Error(STAGEHAND_INFERENCE_REFUSED); } },
} as const;

type StagehandModule = Pick<typeof import("@browserbasehq/stagehand"), "localBrowser" | "Stagehand">;

/** The batch deadline comes from `DriverOptions`; a caller that passes none gets the facade's 60 s. Stagehand allows one
 *  client per browser: an attach that fails or is cancelled after it connected disconnects again, and only then fails, so
 *  the next attach never meets its slot still taken (Stagehand bounds the disconnect: 10 s for the detach). `internals` is
 *  for tests: the Stagehand module the driver uses. */
export function stagehandDriver(internals: { stagehand?: () => Promise<StagehandModule> } = {}): DriverFactory<PageDriver> {
  return async (target, signal, options) => {
    const { localBrowser, Stagehand } = await (internals.stagehand ?? (() => import("@browserbasehq/stagehand")))();
    const host = new URL(target.dial?.url ?? target.sdkCdpUrl).host;
    throwIfCancelled(signal);
    const connecting = localBrowser.connect({ cdpUrl: target.sdkCdpUrl, ...(target.extensionCdpUrl ? { extensionCdpUrl: target.extensionCdpUrl } : {}) });
    const browser = await untilCancelled(attachStep(host)(connecting), signal, (late) => late.disconnect());
    try {
      const stagehand = await untilCancelled(Stagehand.create({ browser, ...SEALED_STAGEHAND }), signal, () => undefined);
      return pageDriver(stagehand, { batchMs: options?.batchTimeoutMs ?? 60_000 });
    } catch (error) {
      await browser.disconnect().catch(() => undefined);
      throw error;
    }
  };
}
