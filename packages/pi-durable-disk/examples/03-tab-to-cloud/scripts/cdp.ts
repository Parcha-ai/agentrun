// A small Chrome DevTools Protocol client for driving the demo's pages headlessly: one browser context per "device"
// (its own storage and cache), pages in it, evaluate, screenshots, screencast frames. Only the demo's own pages.
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class Cdp {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, ((params: Record<string, unknown>, sessionId?: string) => void)[]>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) for (const l of this.#listeners.get(msg.method) ?? []) l(msg.params ?? {}, msg.sessionId);
    });
  }

  static async connect(endpoint = "http://127.0.0.1:9222"): Promise<Cdp> {
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new Cdp(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): void {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener]);
  }

  /** A fresh browser context: a separate device as far as the page can tell (no shared storage, cache or cookies). */
  async device(): Promise<Device> {
    const { browserContextId } = await this.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false });
    return new Device(this, browserContextId);
  }

  close(): void {
    this.#ws.close();
  }
}

export class Device {
  readonly cdp: Cdp;
  readonly contextId: string;
  readonly pages: Page[] = [];
  constructor(cdp: Cdp, contextId: string) {
    this.cdp = cdp;
    this.contextId = contextId;
  }

  async open(url: string, size = { width: 1280, height: 800 }): Promise<Page> {
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: this.contextId, ...size });
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this.cdp, targetId, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url });
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    for (const page of this.pages) await page.close().catch(() => undefined);
    await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }).catch(() => undefined);
  }
}

export class Page {
  readonly cdp: Cdp;
  readonly targetId: string;
  readonly sessionId: string;
  readonly console: string[] = [];
  closed = false;
  constructor(cdp: Cdp, targetId: string, sessionId: string) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    cdp.on("Runtime.consoleAPICalled", (params, session) => {
      if (session !== sessionId) return;
      const args = (params.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? ""));
      this.console.push(`${params.type}: ${args.join(" ")}`);
    });
    cdp.on("Runtime.exceptionThrown", (params, session) => {
      if (session !== sessionId) return;
      const d = params.exceptionDetails as { text?: string; exception?: { description?: string } };
      this.console.push(`exception: ${d.exception?.description ?? d.text}`);
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** Poll `expression` until it is truthy. */
  async until<T>(expression: string, timeoutMs = 60_000, pollMs = 200): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = await this.evaluate<T>(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${expression}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
  }
}
