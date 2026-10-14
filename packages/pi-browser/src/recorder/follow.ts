// A read-only screencast of the page an agent is using, over a browser's DevTools socket. It attaches beside whatever else is
// connected (the driver, the effect observer); every frame is acknowledged at once, whatever is done with it.

export type FollowHandlers = {
  /** One screencast frame of the followed page: JPEG bytes and the page's own width and height as the browser reports them. */
  frame(bytes: Buffer, page: { deviceWidth: number; deviceHeight: number; epoch: number }): void;
  /** The followed page's main frame navigated. */
  navigated(): void;
  /** The socket ended and was not asked to. */
  closed(): void;
};

export type Follower = {
  /** Runs an expression in the followed page and gives its value; rejects when there is no page, the page errors or nothing answers in `ms`. */
  evaluate(expression: string, ms?: number): Promise<unknown>;
  /** Which page, at which moment of its life, the capture is on: it changes when the capture moves to another page and at every main-frame
   *  navigation, so a frame held across a change can be told from one of the page now shown. */
  epoch(): number;
  close(): void;
};

export type FollowOptions = { maxWidth: number; maxHeight: number; quality: number };

export function followPage(url: string, handlers: FollowHandlers, options: FollowOptions): Follower {
  const socket = new WebSocket(url);
  let seq = 0;
  let closing = false;
  let current: { targetId: string; sessionId: string | null; url: string } | null = null;
  let epoch = 0;
  /** Every page the browser has: its address, and when it was last opened or moved (an arrival counter, not a clock). */
  const pages = new Map<string, { url: string; moved: number }>();
  let moves = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  const send = (method: string, params: object = {}, sessionId?: string | null): number => {
    const id = ++seq;
    if (socket.readyState === 1) socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return id;
  };
  const follow = (targetId: string, url: string): void => {
    if (current?.targetId === targetId) return;
    epoch += 1;
    if (current?.sessionId) send("Target.detachFromTarget", { sessionId: current.sessionId });
    current = { targetId, sessionId: null, url };
    send("Target.attachToTarget", { targetId, flatten: true });
  };
  /** The page in use: the one most recently opened or moved to an address, a blank one only when no other exists. The browser lists its
   *  pages in no order that says which the agent is on, so arrival is what is read. */
  const choose = (): void => {
    let best: { id: string; url: string; moved: number } | null = null;
    for (const [id, page] of pages) {
      const blank = page.url === "about:blank" || page.url === "";
      const bestBlank = best !== null && (best.url === "about:blank" || best.url === "");
      if (best === null || (bestBlank && !blank) || (bestBlank === blank && page.moved > best.moved)) best = { id, url: page.url, moved: page.moved };
    }
    if (best) follow(best.id, best.url);
  };

  socket.onopen = () => { send("Target.setDiscoverTargets", { discover: true }); };
  socket.onmessage = (event) => {
    let message: { id?: number; method?: string; params?: any; sessionId?: string; result?: any; error?: { message?: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined && waiting.has(message.id)) {
      const entry = waiting.get(message.id)!;
      waiting.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? "the browser refused"));
      else if (message.result?.exceptionDetails) entry.reject(new Error("the page threw"));
      else entry.resolve(message.result?.result?.value);
      return;
    }
    const { method, params, sessionId } = message;
    if (method === "Target.targetCreated" && params.targetInfo.type === "page") { pages.set(params.targetInfo.targetId, { url: params.targetInfo.url, moved: (moves += 1) }); choose(); }
    else if (method === "Target.targetInfoChanged" && params.targetInfo.type === "page") {
      const known = pages.get(params.targetInfo.targetId);
      // A page that moved to a new address is the one in use; a new title on the same address is not a move.
      if (!known) pages.set(params.targetInfo.targetId, { url: params.targetInfo.url, moved: (moves += 1) });
      else if (known.url !== params.targetInfo.url) { known.url = params.targetInfo.url; known.moved = (moves += 1); }
      choose();
    } else if (method === "Target.attachedToTarget") {
      const page = current;
      if (!page || params.targetInfo.targetId !== page.targetId) { send("Target.detachFromTarget", { sessionId: params.sessionId }); return; }
      page.sessionId = params.sessionId;
      send("Page.enable", {}, params.sessionId);
      send("Page.startScreencast", { format: "jpeg", quality: options.quality, maxWidth: options.maxWidth, maxHeight: options.maxHeight }, params.sessionId);
    } else if (method === "Page.screencastFrame") {
      send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId);
      if (sessionId !== current?.sessionId) return;
      handlers.frame(Buffer.from(String(params.data), "base64"), { deviceWidth: Number(params.metadata?.deviceWidth) || 0, deviceHeight: Number(params.metadata?.deviceHeight) || 0, epoch });
    } else if (method === "Page.frameNavigated" && sessionId === current?.sessionId && !params.frame?.parentId) { epoch += 1; handlers.navigated(); }
    else if (method === "Target.targetDestroyed") { pages.delete(params.targetId); if (params.targetId === current?.targetId) { current = null; epoch += 1; } choose(); }
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error("the browser's socket closed")); }
    waiting.clear();
    if (!closing) handlers.closed();
  };

  return {
    evaluate(expression, ms = 1_500) {
      const sessionId = current?.sessionId;
      if (!sessionId || socket.readyState !== 1) return Promise.reject(new Error("no page to ask"));
      return new Promise((resolve, reject) => {
        const id = send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("the page did not answer")); }, ms);
        timer.unref?.();
        waiting.set(id, { resolve, reject, timer });
      });
    },
    epoch: () => epoch,
    close() { closing = true; for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error("closed")); } waiting.clear(); try { socket.close(); } catch { /* already closed */ } },
  };
}
