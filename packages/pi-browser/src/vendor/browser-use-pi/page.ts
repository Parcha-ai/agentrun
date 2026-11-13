// Adapted from Browser Use Pi (https://github.com/browser-use/browser-use-pi) at commit
// e7007f219b10fa2c2baae1bf3e2f902a5a2706fd, src/page.ts. MIT License, Copyright (c) 2026 Browser Use contributors; the
// license's full text is in this package's NOTICE, and UPSTREAM.json beside this file records the source.
// Changes: the Page class only (no Tabs, no snapshot of its own: ax.ts's is the driver's); goto refuses a scheme other
// than http, https and about:blank; screenshot takes the driver's options (format, quality, clip, full page and scale),
// sent as core/images.ts captureParams makes them; untyped CDP params and results.
import { setTimeout as delay } from "node:timers/promises";
import { captureParams, type Layout, type ScreenshotOptions } from "../../core/images.js";
import type { CDP } from "./cdp.js";

const contextLost = /Execution context was destroyed|Cannot find context|Cannot find default execution context/;

/** The schemes a page is sent to: the web and the blank page, never a file of this machine or the browser's own pages. */
export const NAVIGABLE = /^(https?:\/\/|about:blank$)/i;

/** A tab with explicit CDP, page evaluation and observation. No selector/action layer. */
export class Page {
  private constructor(
    readonly connection: CDP,
    public targetId: string,
    public sessionId: string,
  ) {}

  static async attach(connection: CDP, targetId: string) {
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(connection, targetId, sessionId);
    try {
      await page.cdp("Page.enable");
      await page.cdp("Runtime.enable");
      return page;
    } catch (error) {
      // The caller never receives this page, so it cannot release the failed attachment.
      await connection.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      throw error;
    }
  }

  cdp<T = any>(method: string, params?: object): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  async goto(url: string) {
    if (!NAVIGABLE.test(url)) throw new Error(`goto takes an http or https URL (or about:blank), not ${JSON.stringify(url.slice(0, 100))}`);
    const result = await this.cdp<{ errorText?: string }>("Page.navigate", { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await this.waitFor(() => document.readyState !== "loading");
    return this.info();
  }

  async info(): Promise<{ url: string; title: string }> {
    return this.evaluate(() => ({ url: location.href, title: document.title }));
  }

  async evaluate<T, A = undefined>(fn: ((argument: A) => T) | string, argument?: A): Promise<Awaited<T>> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})`;
    const response = await this.cdp("Runtime.evaluate", {
      expression,
      // Bound synchronous execution in Chrome too; rejecting a CDP promise does not stop it.
      timeout: this.connection.timeoutMs,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value as Awaited<T>;
  }

  async waitFor<A = undefined>(fn: (arg: A) => unknown, argument?: A, options: { timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? this.connection.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(fn, argument)) return;
      } catch (error) {
        if (!(error instanceof Error) || !contextLost.test(error.message)) throw error;
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Page condition exceeded ${timeoutMs} ms.`);
  }

  async clickAt(x: number, y: number) {
    if (![x, y].every(Number.isFinite)) throw new Error("Coordinates must be finite.");
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async moveTo(x: number, y: number) {
    if (![x, y].every(Number.isFinite)) throw new Error("Coordinates must be finite.");
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  /** The driver's options as core/images.ts captureParams makes them CDP's, on the page's layout as it is now. */
  async screenshot(options: ScreenshotOptions = {}) {
    const layout = await this.cdp<Layout>("Page.getLayoutMetrics");
    const { data } = await this.cdp<{ data: string }>("Page.captureScreenshot", captureParams(options, layout));
    return data;
  }
}
