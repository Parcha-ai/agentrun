// The Stagehand driver: Stagehand v4 over upstream's facade, vendored unedited (src/vendor/stagehand-facade) at the
// commit that pairs with the Stagehand the package pins. Stagehand is created sealed: no inference leaves through it
// (act, extract and observe, which `run` code reaches through `batchStagehand`, get a refusal instead of Browserbase's
// model gateway), nothing is cached server side, and its trace exporter points at a closed loopback port (4.1.0
// cannot turn it off). The driver never ends the browser: custody releases it through the provider.
import type { DriverFactory } from "../core/custody.js";
import type { ScreenshotOptions } from "../core/images.js";
import type { PageDriver } from "../core/tools.js";
import { StagehandFacadeTools } from "../vendor/stagehand-facade/tools.js";
import type { RefAction } from "../vendor/stagehand-facade/contract.js";

/** Where Stagehand's trace exporter posts: a closed loopback port, so no span leaves the host (4.1.0 has no off). */
export const STAGEHAND_TELEMETRY = { traces: { endpoint: "http://127.0.0.1:9/v1/traces" } } as const;
export const STAGEHAND_INFERENCE_REFUSED = "Stagehand inference is off in this harness: act, extract and observe are unavailable. Drive the page with run code or snapshot IDs.";
export const SEALED_STAGEHAND = {
  logging: { level: "off" },
  cache: false,
  model: { generate: async (): Promise<never> => { throw new Error(STAGEHAND_INFERENCE_REFUSED); } },
  telemetry: STAGEHAND_TELEMETRY,
} as const;

const STAGEHAND_EXTENSION = "Stagehand Runtime";
const DISCOVERY_MS = 10_000;
// A page's address is its document's (location.href). Stagehand's page.url() names a goto's target once Chrome starts
// it, and a navigation that never commits (a 204, a download) leaves the old page shown: a receipt under that address
// would cite a page it does not hold. A read takes the address, title, text and html in one evaluate, so all four are
// one document's.
const PAGE_CODE = `return await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: document.body ? document.body.innerText : "",
  html: document.documentElement ? document.documentElement.outerHTML : "",
}));`;
const URL_READ_MS = 2_000;

/** The active page's document address, read in a batch of its own: the browser runs a batch after any batch still
 *  running there, so the read never lands inside a navigation an earlier goto left pending (a page call issued then
 *  never returns, and Stagehand's close waits on it). Past URL_READ_MS (a busy page, a goto still pending), Stagehand's
 *  page.url(). */
async function documentUrl(stagehand: any, page: any): Promise<string> {
  try {
    const href = await stagehand.experimentalBatch(async (batch: any) => await batch.page.evaluate("location.href"), {}, { page, timeout: URL_READ_MS });
    if (typeof href === "string" && href) return href;
  } catch { /* the cached address below */ }
  return await page.url();
}

/** The enabled Stagehand extension a browser already holds (a provider preloaded it, or an earlier process loaded it),
 *  found as Stagehand finds a preloaded one; null when there is none, so Stagehand loads it unpacked. A held runtime is
 *  restarted first: it keeps its one Stagehand instance in memory until that instance's `stagehand.close`, which a
 *  process that died never sent, so a new attach would be refused. Closing the extension's service worker target (no
 *  page target is touched) resets it, and Stagehand wakes the worker when it attaches. */
async function installedExtension(cdpUrl: string, signal?: AbortSignal, known?: string): Promise<string | null> {
  const socket = new WebSocket(cdpUrl);
  const timer = setTimeout(() => socket.close(), DISCOVERY_MS);
  const stop = () => socket.close();
  signal?.addEventListener("abort", stop, { once: true });
  // A call the browser never answers settles empty when the socket closes (the deadline, an abort, the browser).
  const pending = new Map<number, (result: any) => void>();
  let next = 0;
  const call = (method: string, params: object = {}) => new Promise<any>((resolve) => { pending.set(++next, resolve); socket.send(JSON.stringify({ id: next, method, params })); });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      // A refused connection raises `error` and, on Node 22, never `close`: waiting for `close` alone would hang the attach.
      socket.onerror = () => reject(new Error("Failed to open CDP WebSocket"));
      socket.onclose = () => { for (const settle of pending.values()) settle(undefined); reject(new Error("the CDP socket closed")); };
      socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); pending.get(message.id)?.(message.result); };
    });
    let id = known ?? null;
    if (!id) {
      const extensions: Array<{ id: string; name: string; enabled: boolean }> = (await call("Extensions.getExtensions"))?.extensions ?? [];
      const enabled = extensions.filter((extension) => extension.name === STAGEHAND_EXTENSION && extension.enabled);
      if (enabled.length !== 1) return null;
      id = enabled[0]!.id;
    }
    const workers = async () => ((await call("Target.getTargets"))?.targetInfos ?? [] as Array<{ targetId: string; type: string; url: string }>)
      .filter((target: { type: string; url: string }) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`))
      .map((target: { targetId: string }) => target.targetId);
    const closing = await workers();
    for (const targetId of closing) await call("Target.closeTarget", { targetId });
    // A closed worker stays listed for a moment, and Stagehand would attach to it; wait until it is gone. The reset is
    // best effort: a worker the browser will not close leaves the attach to Stagehand, whose own refusal then fails it.
    for (let tries = 0; tries < 40 && (await workers()).some((targetId: string) => closing.includes(targetId)); tries += 1) await new Promise((r) => setTimeout(r, 50));
    return id;
  } catch { return known ?? null; } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); socket.close(); }
}

/** A Stagehand whose batches run under `timeoutMs` instead of the facade's fixed 60 s; every other member is its own.
 *  A batch that fails at or past that deadline fails as a `TimeoutError` (Stagehand's own is a plain Error), the
 *  driver's clock being the fact. */
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

/** The run batch's deadline is the conversation's (`DriverOptions`, from its policy), over the facade's fixed 60 s;
 *  a direct caller that passes none gets that 60 s. */
export function stagehandDriver(): DriverFactory<PageDriver> {
  return async (target, signal, options) => {
    const { localBrowser, Stagehand }: any = await import("@browserbasehq/stagehand");
    // An id the provider supplies names a held extension too, so its worker is reset as well.
    // A failed open names where it went: Stagehand reports it as "[object Object]" and the socket's own error has no address.
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
    return {
      snapshot: (snapshotOptions) => facade.snapshot(snapshotOptions),
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
      page: async () => await facade.run(PAGE_CODE) as { url: string; title: string; text: string; html: string },
      // Stagehand's own close keeps the browser for another attach; the browser's close would end it.
      close: () => stagehand.close(),
    };
  };
}
