// Stagehand is created sealed: no inference leaves through it (act, extract and observe are refused), nothing is cached
// server side, and the driver never ends the browser: custody releases it through the provider.
import { type DriverFactory } from "../core/custody.js";
import { INERT_TRACE_ENDPOINT } from "../core/effects.js";
import type { PageDriver } from "../core/tools.js";
import { pageDriver } from "./page-driver.js";
import { attachStep, throwIfCancelled, untilCancelled } from "./sealed.js";

/** A closed loopback port, so no span leaves the host: Stagehand 4.1.0 cannot turn its trace exporter off. */
export const STAGEHAND_TELEMETRY = { traces: { endpoint: INERT_TRACE_ENDPOINT } } as const;
export const STAGEHAND_INFERENCE_REFUSED = "Stagehand inference is off in this harness: act, extract and observe are unavailable. Drive the page with run code or snapshot IDs.";
export const SEALED_STAGEHAND = {
  logging: { level: "off" },
  cache: false,
  model: { generate: async (): Promise<never> => { throw new Error(STAGEHAND_INFERENCE_REFUSED); } },
  telemetry: STAGEHAND_TELEMETRY,
} as const;

/** The batch deadline comes from `DriverOptions`; a caller that passes none gets the facade's 60 s. Stagehand allows one
 *  client per browser: an attach that fails or is cancelled after it connected disconnects again, so it never refuses the
 *  next. */
export function stagehandDriver(): DriverFactory<PageDriver> {
  return async (target, signal, options) => {
    const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
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
