// The driver of every browser computer (AgentRun's browser kind: Browserbase's, Kernel's, or the `local` provider's
// Chrome on this machine), over its CDP URL: raw CDP, with no Stagehand and nothing loaded into the browser. snapshot is
// Chrome's accessibility tree with "frame-node" ids, and run takes actions alone (an op, a snapshot id, a value), each
// carried out with CDP input events and answered with one line of what changed; run code is refused in words, since the
// model's code would run in the host's process. The snapshot and the actions are Browser Use Pi's (vendor/browser-use-pi,
// MIT).
//
// The commands it sends: Target (to find, open or follow its tab), Page (enable, navigate, frame tree, screenshot, layout,
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
export const CDP_CODE_REFUSED =
  'run code is not available on this browser (the agent\'s browser computer): send actions instead, each an op with a snapshot id and a value, for example {"actions":[{"op":"click","id":"0-42"}]}, and navigate with {"actions":[{"op":"goto","url":"https://example.com"}]}. Read the page with browser_read.';

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

type Tab = { targetId: string; url: string; openerId?: string };

/** The browser's tabs, in the browser's order (DevTools' own pages left out). */
async function tabsOf(cdp: CDP): Promise<Tab[]> {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<Tab & { type: string }> }>("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
}

/** A blank tab opened for the driver, when the browser has none. */
async function blankTab(cdp: CDP): Promise<string> {
  return (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
}

/** The raw-CDP page driver: snapshot ids and actions only. */
export function cdpDriver(): DriverFactory<PageDriver> {
  return async (target, signal) => {
    signal?.throwIfAborted();
    const cdp = await CDP.open(openDial(target), COMMAND_MS);
    let page: Page;
    /** Every tab the driver has seen, so one that appears later is known as new. */
    const seen = new Set<string>();
    /** The tab that opened each tab the driver followed, to go back to when that one closes. */
    const openers = new Map<string, string>();
    try {
      const tabs = await tabsOf(cdp);
      for (const t of tabs) seen.add(t.targetId);
      // The browser's first tab, or a blank one opened for the driver when it has none.
      page = await Page.attach(cdp, tabs[0]?.targetId ?? (await blankTab(cdp)));
      seen.add(page.targetId);
    } catch (error) {
      cdp.close();
      throw error;
    }
    const ax = new AxHelpers(() => page, () => cdp);

    /**
     * Drives the tab the driven tab opened (a popup, or a link that opens a new tab), or, when the driven tab has closed,
     * the tab that opened it (else the browser's last, else a blank one). The old tab's snapshot ids are dropped, so an
     * action by id fails as a stale snapshot until the next snapshot. Answers the line that says so, or nothing when
     * the driven tab stays.
     */
    const follow = async (): Promise<string | undefined> => {
      const tabs = await tabsOf(cdp);
      const opened = tabs.filter((t) => !seen.has(t.targetId) && t.openerId === page.targetId).at(-1);
      for (const t of tabs) seen.add(t.targetId);
      let next = opened?.targetId;
      if (!next && !tabs.some((t) => t.targetId === page.targetId)) {
        const back = openers.get(page.targetId);
        next = tabs.find((t) => t.targetId === back)?.targetId ?? tabs.at(-1)?.targetId ?? (await blankTab(cdp));
        seen.add(next);
      }
      if (!next) return undefined;
      const old = page;
      page = await Page.attach(cdp, next);
      if (opened) openers.set(next, old.targetId);
      ax.forget();
      await cdp.send("Target.detachFromTarget", { sessionId: old.sessionId }).catch(() => undefined);
      await ax.settle({ capMs: 3000 }).catch(() => undefined);
      const { targetInfo } = await cdp.send<{ targetInfo: { url: string } }>("Target.getTargetInfo", { targetId: next });
      const now = opened ? "the page opened a new tab; now driving it" : "the tab closed; now driving another";
      return `[tab] ${now}: ${targetInfo.url}.`;
    };

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
          return ax.type(action.id, action.text, action.delay);
        case "press":
          return ax.press(action.id, action.key);
        case "select":
          return ax.select(action.id, action.values);
        default:
          throw refusedError(`run takes the ops goto, click, hover, fill, type, press and select, not ${JSON.stringify((action as { op?: unknown }).op)}`);
      }
    };

    return {
      // A snapshot is of the tab the agent is on now: a tab the page opened since, or the one left when it closed.
      snapshot: async (options = {}) => {
        const moved = await follow();
        const shot = await ax.snapshot(options.includeIframes === undefined ? {} : { includeIframes: options.includeIframes });
        return moved ? `${moved}\n${shot}` : shot;
      },

      run: async ({ code, actions, checked }) => {
        if (code !== undefined) throw refusedError(CDP_CODE_REFUSED);
        if (!actions?.length) throw refusedError("run requires exactly one of code or actions");
        await check(actions, checked === true);
        const lines: string[] = [];
        for (const [i, action] of actions.entries()) {
          try {
            lines.push(await runOne(action));
          } catch (error) {
            // An id after a goto in the same run names nothing of the new page: a stale snapshot.
            if (error instanceof UnknownIdError) throw stale(staleSnapshotIdError(error.id));
            if (!lines.length) throw error;
            // What ran is said with what failed: the actions before it took effect.
            throw new Error(`${lines.join("\n")}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
          // An action that opened a tab (or closed this one) moves the driver there; the rest name the old tab's ids.
          // The action already took effect, so a failure to look is not its failure.
          const moved = await follow().catch(() => undefined);
          if (moved) {
            lines.push(`${moved} Take a snapshot before acting by id.`);
            const rest = actions.length - i - 1;
            if (rest) lines.push(`[stopped] ${rest} more action${rest === 1 ? "" : "s"} not run: they name the old tab's snapshot ids.`);
            break;
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
