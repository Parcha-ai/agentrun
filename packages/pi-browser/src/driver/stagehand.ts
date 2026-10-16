// Stagehand is created sealed: no inference leaves through it (act, extract and observe are refused), nothing is cached
// server side, and the driver never ends the browser: custody releases it through the provider.
import type { DriverFactory } from "../core/custody.js";
import type { ScreenshotOptions } from "../core/images.js";
import type { PageDriver } from "../core/tools.js";
import { StagehandFacadeTools } from "../vendor/stagehand-facade/tools.js";
import { installedExtension } from "./extension-worker.js";
import { documentReads } from "./new-document.js";
import type { RefAction } from "../vendor/stagehand-facade/contract.js";

/** A closed loopback port, so no span leaves the host: Stagehand 4.1.0 cannot turn its trace exporter off. */
export const STAGEHAND_TELEMETRY = { traces: { endpoint: "http://127.0.0.1:9/v1/traces" } } as const;
export const STAGEHAND_INFERENCE_REFUSED = "Stagehand inference is off in this harness: act, extract and observe are unavailable. Drive the page with run code or snapshot IDs.";
export const SEALED_STAGEHAND = {
  logging: { level: "off" },
  cache: false,
  model: { generate: async (): Promise<never> => { throw new Error(STAGEHAND_INFERENCE_REFUSED); } },
  telemetry: STAGEHAND_TELEMETRY,
} as const;

const URL_READ_MS = 2_000;
/** How long a read that landed in a document a navigation replaced waits for the new one's DOMContentLoaded. */
const NEW_DOCUMENT_MS = 15_000;

/** In a batch of its own, which the browser runs after any batch still running, so the read never lands inside a
 *  pending navigation (a page call issued then never returns). Past URL_READ_MS, Stagehand's page.url(). */
async function documentUrl(stagehand: any, page: any): Promise<string> {
  try {
    const href = await stagehand.experimentalBatch(async (batch: any) => await batch.page.evaluate("location.href"), {}, { page, timeout: URL_READ_MS });
    if (typeof href === "string" && href) return href;
  } catch {}
  return await page.url();
}


/** Batches run under `timeoutMs`, not the facade's fixed 60 s; one failing at or past it is a `TimeoutError`, since
 *  Stagehand's own is a plain Error. */
function withBatchTimeout<T extends object>(stagehand: T, timeoutMs: number): T {
  return new Proxy(stagehand, {
    get(target, property) {
      if (property === "experimentalBatch") {
        return async (callback: unknown, input: unknown, options: Record<string, unknown> = {}) => {
          const started = Date.now();
          try { return await (target as any).experimentalBatch(callback, input, { ...options, timeout: timeoutMs }); }
          catch (error) {
            if (Date.now() - started < timeoutMs) throw error;
            throw Object.assign(new Error(`the run batch passed its ${timeoutMs} ms deadline`, { cause: error }), { name: "TimeoutError" });
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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
    const stagehand = await Stagehand.create({ browser, ...SEALED_STAGEHAND });
    const facade = new StagehandFacadeTools(withBatchTimeout(stagehand, options?.batchTimeoutMs ?? 60_000));
    const active = async () => {
      const page = await stagehand.browser.context.activePage();
      if (!page) throw new Error("Stagehand has no active page.");
      return page;
    };
    // In a batch of its own, which the browser runs once the new document is its page's.
    const newDocument = async () => stagehand.experimentalBatch(async (batch: any, input: { ms: number }) => { await batch.page.waitForLoadState("domcontentloaded", input.ms); }, { ms: NEW_DOCUMENT_MS }, { page: await active(), timeout: NEW_DOCUMENT_MS + 1_000 });
    const reads = documentReads(facade, newDocument);
    return {
      snapshot: (snapshotOptions) => reads.snapshot(snapshotOptions),
      run: (input) => input.actions !== undefined ? facade.runActions(input.actions as RefAction[]) : facade.run(input.code ?? ""),
      url: async () => documentUrl(stagehand, await active()),
      screenshot: async ({ type = "png", quality, fullPage, scale }: ScreenshotOptions) => {
        const bytes: Uint8Array = await (await active()).screenshot({
          type, ...(fullPage === undefined ? {} : { fullPage }), ...(scale === undefined ? {} : { scale }),
          // CDP takes a quality for jpeg only, and only as an integer.
          ...(type === "jpeg" && quality !== undefined ? { quality: Math.round(quality) } : {}),
        });
        return { data: Buffer.from(bytes).toString("base64"), mimeType: type === "jpeg" ? "image/jpeg" : "image/png" };
      },
      page: () => reads.page(),
      // Stagehand's own close keeps the browser for another attach; the browser's close would end it.
      close: () => stagehand.close(),
    };
  };
}
