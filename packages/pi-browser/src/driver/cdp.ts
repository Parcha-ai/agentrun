// The driver of the local browser (AgentRun's `local` computer provider, this machine's Chrome): raw CDP, with no
// Stagehand and nothing loaded into the browser. snapshot is Chrome's accessibility tree with "frame-node" ids, and run
// takes actions alone (an op, a snapshot id, a value), each carried out with CDP input events and answered with one line
// of what changed; run code is refused in words, since the model's code would run beside a browser on this machine. The
// snapshot and the actions are Browser Use Pi's (vendor/browser-use-pi, MIT).
//
// The commands it sends: Target (to find or open its tab), Page (enable, navigate, frame tree, screenshot, layout,
// dialogs), Runtime (enable, evaluate and callFunctionOn of this file's and ax.ts's own functions, releaseObject),
// Accessibility (the trees), DOM (resolveNode, scrollIntoViewIfNeeded, focus, getNodeForLocation, getBoxModel), Input
// (mouse and key events, insertText) and Network.enable (to wait for a page to settle). A host that fences the DevTools
// socket allows these.
import type { DriverFactory } from "../core/custody.js";
import { refusedError } from "../core/custody.js";
import { openDial } from "../core/dial.js";
import type { Located, Target } from "../core/clip.js";
import type { ScreenshotOptions } from "../core/images.js";
import type { PageDriver, RunAction } from "../core/tools.js";
import { AxHelpers, UnknownIdError } from "../vendor/browser-use-pi/ax.js";
import { CDP } from "../vendor/browser-use-pi/cdp.js";
import { Page } from "../vendor/browser-use-pi/page.js";
import { NAVIGATED_SNAPSHOT_ERROR, NO_HYDRATED_SNAPSHOT_ERROR, STALE_SNAPSHOT_ID_ERROR } from "../core/failures.js";

/** The package's stale-snapshot words, as the Stagehand driver says them: plain errors, so a failure reads them as a stale snapshot. */
const stale = (message: string) => new Error(message);
const staleSnapshotIdError = (id: string) => STALE_SNAPSHOT_ID_ERROR.replace("${id}", id);

/** What `run` with code is told on this browser. */
export const LOCAL_CODE_REFUSED =
  'run code is not available on the local browser (this machine\'s Chrome): send actions instead, each an op with a snapshot id and a value, for example {"actions":[{"op":"click","id":"0-42"}]}, and navigate with {"actions":[{"op":"goto","url":"https://example.com"}]}. Read the page with browser_read.';

/** How long one CDP command may take before the action is said to be unanswered. */
const COMMAND_MS = 30_000;

/** One element's box once it is scrolled into view, in CSS pixels from the viewport's corner, or how many a selector matches. */
const LOCATE_JS = `function(selector){
  const viewport = { width: innerWidth, height: innerHeight };
  const found = selector === null ? null : selector === undefined ? this : document.querySelectorAll(selector);
  if (found === null) return { viewport };
  const list = found instanceof NodeList ? [...found] : [found.nodeType === 1 ? found : found.parentElement];
  if (list.length !== 1 || !list[0]) return { viewport, matches: list.filter(Boolean).length };
  list[0].scrollIntoView({ block: 'center', inline: 'center' });
  const r = list[0].getBoundingClientRect();
  return { viewport, matches: 1, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
}`;

/** The browser's first page, or a blank one opened for the driver when it has none. */
async function firstPage(cdp: CDP): Promise<Page> {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; targetId: string; url: string }> }>("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  const targetId = page?.targetId ?? (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
  return Page.attach(cdp, targetId);
}

/** The raw-CDP page driver: snapshot ids and actions only. */
export function cdpDriver(): DriverFactory<PageDriver> {
  return async (target, signal) => {
    signal?.throwIfAborted();
    const cdp = await CDP.open(openDial(target), COMMAND_MS);
    let page: Page;
    try {
      page = await firstPage(cdp);
    } catch (error) {
      cdp.close();
      throw error;
    }
    const ax = new AxHelpers(() => page, () => cdp);

    /** The latest snapshot's ids hold: there is one, the page still shows its document, and every id is in it. */
    const check = async (actions: RunAction[], checked = false) => {
      if (actions.every((a) => a.op === "goto")) return;
      if (!ax.hydrated || !ax.taken) throw stale(NO_HYDRATED_SNAPSHOT_ERROR);
      if (!checked) {
        const now = await ax.probe().catch(() => undefined);
        if (!now || now.doc !== ax.taken.doc) throw stale(NAVIGATED_SNAPSHOT_ERROR);
      }
      for (const action of actions) {
        if (action.op === "goto") break; // what follows a goto is on the next page: its ids are checked when it runs
        try {
          ax.nodeOf(action.id);
        } catch {
          throw stale(staleSnapshotIdError(action.id));
        }
      }
    };

    const runOne = async (action: RunAction): Promise<string> => {
      switch (action.op) {
        case "goto": {
          const before = await ax.probe().catch(() => undefined);
          await page.goto(action.url);
          // The page's ids were the old document's: the next action by id fails as a stale snapshot.
          ax.forget();
          const settled = await ax.settle({ capMs: 3000 });
          return `[ok] goto ${action.url} -> ${await ax.change(before, settled.probe)}`;
        }
        case "click":
          return ax.click(action.id);
        case "hover":
          return ax.hover(action.id);
        case "fill":
          return ax.fill(action.id, action.value);
        case "type":
          return ax.type(action.id, action.text);
        case "press":
          return ax.press(action.id, action.key);
        case "select":
          return ax.select(action.id, action.values);
        default:
          throw refusedError(`run takes the ops goto, click, hover, fill, type, press and select, not ${JSON.stringify((action as { op?: unknown }).op)}`);
      }
    };

    return {
      snapshot: (options = {}) => ax.snapshot(options.includeIframes === undefined ? {} : { includeIframes: options.includeIframes }),

      run: async ({ code, actions, checked }) => {
        if (code !== undefined) throw refusedError(LOCAL_CODE_REFUSED);
        if (!actions?.length) throw refusedError("run requires exactly one of code or actions");
        await check(actions, checked === true);
        const lines: string[] = [];
        for (const action of actions) {
          try {
            lines.push(await runOne(action));
          } catch (error) {
            // An id after a goto in the same run names nothing of the new page: a stale snapshot.
            if (error instanceof UnknownIdError) throw stale(staleSnapshotIdError(error.id));
            if (!lines.length) throw error;
            // What ran is said with what failed: the actions before it took effect.
            throw new Error(`${lines.join("\n")}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
        return lines.join("\n");
      },

      checkActions: (actions) => check(actions),

      url: async () => {
        const { targetInfo } = await cdp.send<{ targetInfo: { url: string } }>("Target.getTargetInfo", { targetId: page.targetId });
        return targetInfo.url;
      },

      forgetSnapshots: () => ax.forget(),

      locate: async (place?: Target): Promise<Located> => {
        if (place?.id !== undefined) {
          let node: number;
          try {
            node = ax.nodeOf(place.id);
          } catch {
            throw stale(ax.hydrated ? staleSnapshotIdError(place.id) : NO_HYDRATED_SNAPSHOT_ERROR);
          }
          const { object } = await page.cdp<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: node });
          if (!object.objectId) return { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), matches: 0 };
          try {
            const answer = await page.cdp("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: LOCATE_JS, arguments: [{ value: undefined }], returnByValue: true });
            return answer.result.value as Located;
          } finally {
            await page.cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
          }
        }
        const selector = place?.selector ?? null;
        return page.evaluate(`(${LOCATE_JS}).call(document, ${JSON.stringify(selector)})`) as Promise<Located>;
      },

      screenshot: async ({ type = "png", quality, fullPage, clip }: ScreenshotOptions) => {
        const data = await page.screenshot({ type, ...(quality === undefined ? {} : { quality }), ...(fullPage === undefined ? {} : { fullPage }), ...(clip ? { clip } : {}) });
        return { data, mimeType: type === "jpeg" ? "image/jpeg" : "image/png" };
      },

      // One evaluate reads all four, so they are one document's.
      page: () =>
        page.evaluate(() => ({
          url: location.href,
          title: document.title,
          text: document.body ? document.body.innerText : "",
          html: document.documentElement ? document.documentElement.outerHTML : "",
        })),

      // The browser keeps running: custody releases it through the provider.
      close: async () => {
        await cdp.send("Target.detachFromTarget", { sessionId: page.sessionId }).catch(() => undefined);
        cdp.close();
      },
    };
  };
}
