// Stagehand is created sealed: no inference leaves through it (act, extract and observe are refused), nothing is cached
// server side, and the driver never ends the browser: custody releases it through the provider.
import { type DriverFactory } from "../core/custody.js";
import type { PageDriver } from "../core/tools.js";
import { installedExtension } from "./extension-worker.js";
import { pageDriver } from "./page-driver.js";
import { attachStep, createSealed, IN_FLIGHT_INIT_MS, INIT_IN_PROGRESS } from "./sealed.js";

/** A closed loopback port, so no span leaves the host: Stagehand 4.1.0 cannot turn its trace exporter off. */
export const STAGEHAND_TELEMETRY = { traces: { endpoint: "http://127.0.0.1:9/v1/traces" } } as const;
export const STAGEHAND_INFERENCE_REFUSED = "Stagehand inference is off in this harness: act, extract and observe are unavailable. Drive the page with run code or snapshot IDs.";
export const SEALED_STAGEHAND = {
  logging: { level: "off" },
  cache: false,
  model: { generate: async (): Promise<never> => { throw new Error(STAGEHAND_INFERENCE_REFUSED); } },
  telemetry: STAGEHAND_TELEMETRY,
} as const;

/** What Stagehand's extension answers an init while another is still running in it. */
export const STAGEHAND_INIT_IN_PROGRESS = INIT_IN_PROGRESS;

/** The batch deadline comes from `DriverOptions`; a caller that passes none gets the facade's 60 s. */
export function stagehandDriver(): DriverFactory<PageDriver> {
  return async (target, signal, options) => {
    const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
    const host = new URL(target.dial?.url ?? target.sdkCdpUrl).host;
    const step = attachStep(host);
    // An id the provider supplies names a held extension too, so its worker is reset as well.
    const extensionId = await step(installedExtension(target.sdkCdpUrl, signal, target.extensionId));
    const browser = await step(localBrowser.connect({ cdpUrl: target.sdkCdpUrl, ...(extensionId ? { extensionId } : {}) }));
    const stagehand = await createSealed(() => Stagehand.create({ browser, ...SEALED_STAGEHAND }),
      () => step(installedExtension(target.sdkCdpUrl, signal, extensionId ?? undefined, IN_FLIGHT_INIT_MS)), host, signal);
    return pageDriver(stagehand, { batchMs: options?.batchTimeoutMs ?? 60_000 });
  };
}
