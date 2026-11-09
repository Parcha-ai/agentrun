// The page tools over a created Stagehand: everything the driver asks of the browser once it is attached.
import type { ExperimentalBatchCallback, Page, Stagehand } from "@browserbasehq/stagehand";
import type { Locate, Target } from "../core/clip.js";
import type { ScreenshotOptions } from "../core/images.js";
import type { PageDriver, RunAction } from "../core/tools.js";
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
/** Setting a file input has no deadline in Stagehand either; it is bounded at the screenshot's 60 s. */
const UPLOAD_MS = 60_000;
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
async function documentUrl(stagehand: Stagehand, page: Page): Promise<string> {
  try {
    const href = await stagehand.experimentalBatch(async (batch) => await batch.page.evaluate("location.href"), {}, { page, timeout: URL_READ_MS });
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
function bounded(stagehand: Stagehand, deadlines: Deadlines): Stagehand {
  const page = (target: Page) => overriding(target, {
    snapshot: (options?: Parameters<Page["snapshot"]>[0]) => withinDeadline(target.snapshot(options), deadlines.snapshotMs, "page.snapshot"),
    screenshot: (options?: Parameters<Page["screenshot"]>[0]) => withinDeadline(target.screenshot(options), deadlines.screenshotMs, "page.screenshot"),
  });
  const context = stagehand.browser.context;
  return overriding(stagehand, {
    experimentalBatch: async (callback: ExperimentalBatchCallback<unknown, unknown>, input: unknown, options: Record<string, unknown> = {}) => {
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

/** How long a page has to say which document it shows before it is taken not to know. */
const DOCUMENT_MS = 5_000;

/** `batchMs` bounds every run batch; the page calls' own deadlines are fixed but for tests. */
export function pageDriver(stagehand: Stagehand, deadlines: { batchMs: number; snapshotMs?: number; screenshotMs?: number; uploadMs?: number }): PageDriver {
  const host = bounded(stagehand, { snapshotMs: SNAPSHOT_MS, screenshotMs: SCREENSHOT_MS, ...deadlines });
  const uploadMs = deadlines.uploadMs ?? UPLOAD_MS;
  const facade = new StagehandFacadeTools(host);
  const active = async () => {
    const page = await host.browser.context.activePage();
    if (!page) throw new Error("Stagehand has no active page.");
    return page;
  };
  // In a batch of its own, which the browser runs once the new document is its page's.
  const newDocument = async () => stagehand.experimentalBatch(async (batch, input: { ms: number }) => { await batch.page.waitForLoadState("domcontentloaded", input.ms); }, { ms: NEW_DOCUMENT_MS }, { page: await active(), timeout: NEW_DOCUMENT_MS + 1_000 });
  const reads = documentReads(facade, newDocument);
  type Kept = { url: string; xpathById: Record<string, string> };
  const kept = () => (facade as unknown as { snapshotsByPage: Map<string, Kept> }).snapshotsByPage;
  /** The document a page shows, by its own performance.timeOrigin: new on every navigation to a new document and on a
   *  reload, the same across a #hash change or history.pushState/replaceState (Chrome's per-document loaderId, which
   *  neither Stagehand's page nor a batch's page can be asked for). Null when the page does not say. */
  const documentOf = async (page: Page): Promise<number | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DOCUMENT_MS); });
      const origin = await Promise.race([Promise.resolve(page.evaluate("performance.timeOrigin")).catch(() => null), late]);
      return typeof origin === "number" ? origin : null;
    } catch {
      return null;
    } finally { clearTimeout(timer); }
  };
  /** By page, the document each snapshot was taken on (read once the snapshot is), and that snapshot's ids, to know it is
   *  still the facade's. Read beside the snapshot, never holding it up: a batch awaits it. */
  const snapshotDocuments = new Map<string, { xpathById: Record<string, string>; document: Promise<number | null> }>();
  /** An action after the first of a batch checked as one (driving-guard): run by the facade with the snapshot taken as at
   *  the page's address now, for this action only, so an address the batch's own earlier actions moved is not a stale
   *  snapshot; then the snapshot's own address again, so a later call on the moved page is told to snapshot again. */
  const afterChecked = async (actions: RunAction[]) => {
    const page = await active();
    const snapshot = kept().get(page.pageId);
    // Only on the snapshot's own document: an earlier action that loaded a new one (a link to another page, a reload)
    // leaves the snapshot's ids pointing at nothing of this page's, so the batch stops before this action, as stale.
    if (snapshot) {
      const taken = snapshotDocuments.get(page.pageId);
      const was = taken && taken.xpathById === snapshot.xpathById ? await taken.document : null;
      const document = was === null ? null : await documentOf(page);
      if (was === null || document !== was) throw new Error(NAVIGATED_SNAPSHOT_ERROR);
    }
    const now = snapshot ? await page.url() : undefined;
    if (!snapshot || now === snapshot.url) return facade.runActions(actions);
    kept().set(page.pageId, { ...snapshot, url: now! });
    try { return await facade.runActions(actions); }
    finally {
      const current = kept().get(page.pageId);
      if (current && current.xpathById === snapshot.xpathById) kept().set(page.pageId, { ...current, url: snapshot.url });
    }
  };
  return {
    snapshot: async (snapshotOptions) => {
      const tree = await reads.snapshot(snapshotOptions);
      const page = await active().catch(() => null);
      const taken = page ? kept().get(page.pageId) : undefined;
      if (page && taken) snapshotDocuments.set(page.pageId, { xpathById: taken.xpathById, document: documentOf(page) });
      return tree;
    },
    run: (input) => input.actions !== undefined ? (input.checked ? afterChecked(input.actions) : facade.runActions(input.actions)) : facade.run(input.code ?? ""),
    // As the facade's own batch checks a run's actions before it sends any (runActionsNow): the active page's snapshot,
    // the page still at its address, and every id in it. Read from the facade's snapshots, as forgetSnapshots does.
    checkActions: async (actions) => {
      const page = await active();
      const snapshot = (facade as unknown as { snapshotsByPage: Map<string, { url: string; xpathById: Record<string, string> }> }).snapshotsByPage.get(page.pageId);
      if (!snapshot) throw new Error(NO_HYDRATED_SNAPSHOT_ERROR);
      if ((await page.url()) !== snapshot.url) throw new Error(NAVIGATED_SNAPSHOT_ERROR);
      for (const action of actions) if (!snapshot.xpathById[action.id]) throw new Error(staleSnapshotIdError(action.id));
    },
    url: async () => documentUrl(stagehand, await active()),
    // The facade keeps each page's last snapshot's ids for its own actions; with none, an action by id fails NO_HYDRATED (a stale snapshot).
    forgetSnapshots: () => { (facade as unknown as { snapshotsByPage: Map<string, unknown> }).snapshotsByPage.clear(); },
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
    // An upload is effectful: past its deadline it fails as unanswered, and the page tools tell it as possibly applied.
    setInputFiles: async (selector, file) => { await withinDeadline((await active()).locator(selector).setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer }), uploadMs, "locator.setInputFiles"); },
    // Stagehand 4.4 lets one client attach to a browser at a time, and its close leaves this client attached: disconnect closes
    // the instance (waiting 10 s at most), detaches the client and closes the socket, so the next attach is allowed. The
    // browser keeps running; the browser's own close would end it.
    close: () => stagehand.browser.disconnect(),
  };
}
