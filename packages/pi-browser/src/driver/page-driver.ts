// The page tools over a created Stagehand: everything the driver asks of the browser once it is attached.
import type { Locate, Target } from "../core/clip.js";
import type { ScreenshotOptions } from "../core/images.js";
import type { PageDriver } from "../core/tools.js";
import { withinDeadline } from "../core/unanswered.js";
import { StagehandFacadeTools } from "../vendor/stagehand-facade/tools.js";
import { documentReads } from "./new-document.js";
import { NAVIGATED_SNAPSHOT_ERROR, NO_HYDRATED_SNAPSHOT_ERROR, staleSnapshotIdError } from "../vendor/stagehand-facade/contract.js";

const URL_READ_MS = 2_000;
/** Stagehand 4.1.0 sends a page's snapshot and screenshot with no response deadline (its url, title and active-page
 *  reads get 10 s) and cannot cancel one: a call the browser never answered held its tool call, and every facade call
 *  queued behind it, for 11 minutes in a smoke run. Set from the 2026-10-15/16 smoke arms' successful calls as
 *  max(30 s, 3x p99), at most 60 s: snapshot p99 1.4 s, screenshot p99 114 s. */
const SNAPSHOT_MS = 30_000;
const SCREENSHOT_MS = 60_000;
/** How long a read that landed in a document a navigation replaced waits for the new one's DOMContentLoaded. */
const NEW_DOCUMENT_MS = 15_000;

/** Where an element is, in CSS pixels from the viewport's corner, once it is scrolled into view: how many the selector matches, and
 *  the box of the one that does. */
const locateCode = (selector: string | null): string => `const viewport = await page.evaluate("({ width: innerWidth, height: innerHeight })");
${selector === null ? "return { viewport };" : `const element = page.locator(${JSON.stringify(selector)});
const matches = await element.count();
if (matches !== 1) return { viewport, matches };
await element.scrollIntoViewIfNeeded();
return { viewport, matches, box: await element.boundingBox() };`}`;

/** In a batch of its own, which the browser runs after any batch still running, so the read never lands inside a
 *  pending navigation (a page call issued then never returns). Past URL_READ_MS, Stagehand's page.url(). */
async function documentUrl(stagehand: any, page: any): Promise<string> {
  try {
    const href = await stagehand.experimentalBatch(async (batch: any) => await batch.page.evaluate("location.href"), {}, { page, timeout: URL_READ_MS });
    if (typeof href === "string" && href) return href;
  } catch {}
  return await page.url();
}

/** `target` with `own`'s members in place of its own; every other member is the target's. */
function overriding<T extends object>(target: T, own: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, property) {
      if (typeof property === "string" && Object.hasOwn(own, property)) return own[property];
      const value = Reflect.get(t, property, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

type Deadlines = { batchMs: number; snapshotMs: number; screenshotMs: number };

/** Batches run under `batchMs`, not the facade's fixed 60 s; one failing at or past it is a `TimeoutError`, since
 *  Stagehand's own is a plain Error. Each active page's snapshot and screenshot are bounded on the page itself, under
 *  the facade's queue: one past its deadline fails the facade call, so the calls queued behind it run and its late
 *  answer is never the facade's. */
function bounded(stagehand: any, deadlines: Deadlines): any {
  const page = (target: any) => overriding(target, {
    snapshot: (options: unknown) => withinDeadline(target.snapshot(options), deadlines.snapshotMs, "page.snapshot"),
    screenshot: (options: unknown) => withinDeadline(target.screenshot(options), deadlines.screenshotMs, "page.screenshot"),
  });
  const context = stagehand.browser.context;
  return overriding(stagehand, {
    experimentalBatch: async (callback: unknown, input: unknown, options: Record<string, unknown> = {}) => {
      const started = Date.now();
      try { return await stagehand.experimentalBatch(callback, input, { ...options, timeout: deadlines.batchMs }); }
      catch (error) {
        if (Date.now() - started < deadlines.batchMs) throw error;
        throw Object.assign(new Error(`the run batch passed its ${deadlines.batchMs} ms deadline`, { cause: error }), { name: "TimeoutError" });
      }
    },
    browser: overriding(stagehand.browser, { context: overriding(context, { activePage: async () => { const active = await context.activePage(); return active ? page(active) : active; } }) }),
  });
}

/** `batchMs` bounds every run batch; the page calls' own deadlines are fixed but for tests. */
export function pageDriver(stagehand: any, deadlines: { batchMs: number; snapshotMs?: number; screenshotMs?: number }): PageDriver {
  const host = bounded(stagehand, { snapshotMs: SNAPSHOT_MS, screenshotMs: SCREENSHOT_MS, ...deadlines });
  const facade = new StagehandFacadeTools(host);
  const active = async () => {
    const page = await host.browser.context.activePage();
    if (!page) throw new Error("Stagehand has no active page.");
    return page;
  };
  // In a batch of its own, which the browser runs once the new document is its page's.
  const newDocument = async () => stagehand.experimentalBatch(async (batch: any, input: { ms: number }) => { await batch.page.waitForLoadState("domcontentloaded", input.ms); }, { ms: NEW_DOCUMENT_MS }, { page: await active(), timeout: NEW_DOCUMENT_MS + 1_000 });
  const reads = documentReads(facade, newDocument);
  return {
    snapshot: (snapshotOptions) => reads.snapshot(snapshotOptions),
    run: (input) => input.actions !== undefined ? facade.runActions(input.actions) : facade.run(input.code ?? ""),
    url: async () => documentUrl(stagehand, await active()),
    locate: (async (target?: Target) => {
      let selector: string | null = null;
      if (target?.id !== undefined) {
        // The facade keeps each snapshot's IDs (as xpaths) for its own actions and offers them to no one else; a vendored file is not edited for it.
        const ids = (facade as unknown as { snapshotsByPage: Map<string, { url: string; xpathById: Record<string, string> }> }).snapshotsByPage;
        const page = await active();
        const snapshot = ids.get(page.pageId);
        if (!snapshot) throw new Error(NO_HYDRATED_SNAPSHOT_ERROR);
        if ((await page.url()) !== snapshot.url) throw new Error(NAVIGATED_SNAPSHOT_ERROR);
        const xpath = snapshot.xpathById[target.id]?.replace(/\/text\(\)(\[\d+\])?$/iu, "");
        if (!xpath) throw new Error(staleSnapshotIdError(target.id));
        selector = `xpath=${xpath}`;
      } else if (target?.selector !== undefined) selector = target.selector;
      return await facade.run(locateCode(selector)) as Awaited<ReturnType<Locate>>;
    }) as Locate,
    screenshot: async ({ type = "png", quality, fullPage, scale, clip }: ScreenshotOptions) => {
      // A clip is read from the viewport's corner, and the browser's own is from the document's: the scroll offset is added.
      const origin = clip ? await facade.run(`return await page.evaluate("({ x: scrollX, y: scrollY })");`) as { x: number; y: number } : null;
      const bytes: Uint8Array = await (await active()).screenshot({
        type, ...(fullPage === undefined ? {} : { fullPage }), ...(scale === undefined ? {} : { scale }),
        ...(clip && origin ? { clip: { ...clip, x: clip.x + origin.x, y: clip.y + origin.y } } : {}),
        // CDP takes a quality for jpeg only, and only as an integer.
        ...(type === "jpeg" && quality !== undefined ? { quality: Math.round(quality) } : {}),
      });
      return { data: Buffer.from(bytes).toString("base64"), mimeType: type === "jpeg" ? "image/jpeg" : "image/png" };
    },
    page: () => reads.page(),
    setInputFiles: async (selector, file) => { await (await active()).locator(selector).setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer }); },
    // Stagehand's own close keeps the browser for another attach; the browser's close would end it.
    close: () => stagehand.close(),
  };
}
