// Stagehand is created sealed: no inference leaves through it (act, extract and observe are refused), nothing is cached
// server side, and the driver never ends the browser: custody releases it through the provider.
import { BrowserFailureError, type DriverFactory } from "../core/custody.js";
import { browserFailure } from "../core/failures.js";
import type { PageDriver } from "../core/tools.js";
import { installedExtension } from "./extension-worker.js";
import { pageDriver } from "./page-driver.js";

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
export const STAGEHAND_INIT_IN_PROGRESS = "Stagehand initialization is already in progress";
/** Stagehand's own init deadline: an init the extension is still running has ended by then. */
const IN_FLIGHT_INIT_MS = 60_000;
const initInProgress = (error: unknown): boolean => {
  const cause = (error as { cause?: unknown } | null)?.cause as { code?: unknown; message?: unknown } | undefined;
  return !!cause && typeof cause === "object" && typeof cause.code === "number" && cause.message === STAGEHAND_INIT_IN_PROGRESS;
};

/** The batch deadline comes from `DriverOptions`; a caller that passes none gets the facade's 60 s. */
export function stagehandDriver(): DriverFactory<PageDriver> {
  return async (target, signal, options) => {
    const { localBrowser, Stagehand }: any = await import("@browserbasehq/stagehand");
    // An id the provider supplies names a held extension too, so its worker is reset as well.
    // A failed open names where it went: Stagehand reports it as "[object Object]" and the socket's error has no
    // address.
    const host = new URL(target.dial?.url ?? target.sdkCdpUrl).host;
    const named = <T>(step: Promise<T>) => step.catch((error) => { throw new Error(`attaching to the browser at ${host} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
    const extensionId = await named(installedExtension(target.sdkCdpUrl, signal, target.extensionId));
    const browser = await named(localBrowser.connect({ cdpUrl: target.sdkCdpUrl, ...(extensionId ? { extensionId } : {}) }));
    let stagehand: any;
    try {
      stagehand = await Stagehand.create({ browser, ...SEALED_STAGEHAND });
    } catch (error) {
      if (!initInProgress(error)) throw error;
      // A cancelled call never starts an init of its own, however the wait ended.
      const stopIfCancelled = () => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("the attach was cancelled"), { name: "AbortError" });
      };
      stopIfCancelled();
      // An attach that gave up (a dropped connection, a deadline) left its init running in the extension. A close
      // queues behind that init, so its reply means the init has ended; this attach then inits once more.
      await named(installedExtension(target.sdkCdpUrl, signal, extensionId ?? undefined, IN_FLIGHT_INIT_MS));
      stopIfCancelled();
      try {
        stagehand = await Stagehand.create({ browser, ...SEALED_STAGEHAND });
      } catch (again) {
        if (!initInProgress(again)) throw again;
        throw new BrowserFailureError(browserFailure("browser_unavailable", `The browser at ${host} is still finishing an earlier connection after ${IN_FLIGHT_INIT_MS / 1_000} s. Call again in a moment, or call browser_relaunch for a fresh session.`, { retryable: true }));
      }
    }
    return pageDriver(stagehand, { batchMs: options?.batchTimeoutMs ?? 60_000 });
  };
}
