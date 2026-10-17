// The live view's screencast and input: one session's active page, shown and driven over its browser's DevTools socket (`protocol.ts` has the seams).
//
// Frames: Page.startScreencast (JPEG). The browser sends the next frame only after the last one is acknowledged, so there is never more than one frame in flight, and
// the acknowledgement is the viewer's to give: the server calls `ack` after the frame was sent, or at once to drop it. This module keeps no frame after the handler returns,
// and it writes nothing anywhere: it imports no module, only the platform's WebSocket, Buffer and URL, so there is no file, no recorder sink and no log for a frame to reach.
//
// The page followed is the one in use: the browser lists its pages in no order that says which the agent is on, so the page most recently opened or moved to an address is
// the one shown (a blank one only when no other exists), and the stream moves with it.
import type { DialogAnswer, InputMessage, NavMessage, Stream, StreamFactory, StreamHandlers } from "./protocol.js";

const QUALITY = 60;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 800;
const COMMAND_MS = 5_000;
/** A page that has sent no screencast frame this long after it was followed gets one screenshot as its first frame. The stream never activates a tab or touches any page but the one it follows: switching tabs would hide the page the model may be driving. */
const FIRST_FRAME_MS = 400;
/** A stand-in that failed (the screenshot errored, timed out or the page had no size yet) is tried again this often, up to STAND_IN_TRIES times in all. */
const STAND_IN_RETRY_MS = 1_000;
const STAND_IN_TRIES = 6;
/** Chrome sends a page's address when it moves but not its title when the document sets it, so the title is asked for at the end of a load and now and then. */
const TITLE_POLL_MS = 1_500;
/** A text message is one paste or one typed run: bound it so a viewer cannot make the browser take an unbounded insert. */
const MAX_TEXT = 100_000;
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;
const DIALOG_KINDS = new Set(["alert", "confirm", "prompt", "beforeunload"]);

/** Why one input or nav message was not delivered: the server tells the viewer (`held`). */
export class StreamRefusal extends Error {
  constructor(readonly reason: "no_page" | "bad_message") { super(reason); this.name = "StreamRefusal"; }
}

const finite = (value: unknown, limit = 1e6): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const modifiers = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15 ? value : 0);
const bad = (): never => { throw new StreamRefusal("bad_message"); };

export const openStream: StreamFactory = (cdpUrl: string, handlers: StreamHandlers): Stream => {
  const socket = new WebSocket(cdpUrl);
  let seq = 0;
  let closing = false;
  let current: { targetId: string; sessionId: string | null } | null = null;
  /** Every page the browser has: its address and title, and when it was last opened or moved (an arrival counter, not a clock). */
  const pages = new Map<string, { url: string; title: string; moved: number }>();
  let moves = 0;
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let announced = "";
  /** The frames each session has sent (screencast frames and stand-ins): Chrome sends a screencast frame only when the page changes, so a still page followed later, or a document navigated to, may stay silent. */
  const framesFrom = new Map<string, number>();
  const seenFrom = (sessionId: string): number => framesFrom.get(sessionId) ?? 0;

  const post = (method: string, params: object = {}, sessionId?: string | null): number => {
    const id = ++seq;
    if (socket.readyState === 1) socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return id;
  };
  /** The ids of input commands the browser has not answered: a click that opens an alert is not answered until the alert is, so they end when a dialog opens (see below). */
  const inputs = new Set<number>();
  const request = (method: string, params: object = {}, sessionId?: string | null): Promise<any> => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) return reject(new Error("the browser's socket is closed"));
    const id = post(method, params, sessionId);
    const isInput = method.startsWith("Input.");
    const timer = setTimeout(() => { waiting.delete(id); inputs.delete(id); reject(new Error(`the browser did not answer ${method}`)); }, COMMAND_MS);
    timer.unref?.();
    waiting.set(id, { resolve: (value) => { inputs.delete(id); resolve(value); }, reject: (error) => { inputs.delete(id); reject(error); }, timer });
    if (isInput) inputs.add(id);
  });
  /** Chrome holds the answer to an input command that opened a JS dialog until the dialog is answered, and the dialog's answer comes from the same viewer: the command ends when the dialog opens, or the viewer's next message would wait behind it. */
  const releaseInputs = (): void => {
    for (const id of [...inputs]) { const entry = waiting.get(id); if (!entry) continue; waiting.delete(id); clearTimeout(entry.timer); entry.resolve(undefined); }
    inputs.clear();
  };
  const page = (): string => {
    const sessionId = current?.sessionId;
    if (!sessionId) throw new StreamRefusal("no_page");
    return sessionId;
  };
  /** The viewer is told of the page shown when its address or title changes, and at every change of page. */
  const announce = (): void => {
    const shown = current ? pages.get(current.targetId) : undefined;
    if (!shown) return;
    const key = JSON.stringify([current!.targetId, shown.url, shown.title]);
    if (key === announced) return;
    announced = key;
    handlers.page({ url: shown.url, title: shown.title });
  };
  /** One screenshot of the page stands in for a frame the screencast has not sent. It is delivered only for a page that has a size (a page not laid out yet answers 0x0) and only while no frame has come from the session since
   *  `base`; it answers true when nothing more is to be done (delivered, or a real frame came meanwhile) and false when it should be tried again. */
  const firstFrame = async (sessionId: string, base: number): Promise<boolean> => {
    try {
      const metrics = await request("Page.getLayoutMetrics", {}, sessionId);
      const w = Math.round(Number(metrics?.cssVisualViewport?.clientWidth)) || 0;
      const h = Math.round(Number(metrics?.cssVisualViewport?.clientHeight)) || 0;
      if (!(w > 0 && h > 0)) return false;
      const shot = await request("Page.captureScreenshot", { format: "jpeg", quality: QUALITY }, sessionId);
      if (closing || current?.sessionId !== sessionId || seenFrom(sessionId) !== base) return true;
      if (typeof shot?.data !== "string" || shot.data.length === 0) return false;
      framesFrom.set(sessionId, base + 1);
      handlers.frame(Buffer.from(shot.data, "base64"), { w, h }, () => {});
      return true;
    } catch { return false; /* the page could not be captured this time */ }
  };
  /** Arms the stand-in for a session: when it has sent no frame FIRST_FRAME_MS from now, one screenshot is delivered, and a failed one is tried again. It is armed when a page is followed and at every main-frame navigation of
   *  it, since a new document may be as still as the old. The stream never activates a tab or touches any page but the one it follows. */
  const standIn = (sessionId: string, tries = 0): void => {
    const base = seenFrom(sessionId);
    const timer = setTimeout(() => {
      if (closing || current?.sessionId !== sessionId || seenFrom(sessionId) !== base) return;
      void firstFrame(sessionId, base).then((done) => { if (!done && tries + 1 < STAND_IN_TRIES) standIn(sessionId, tries + 1); });
    }, tries === 0 ? FIRST_FRAME_MS : STAND_IN_RETRY_MS);
    timer.unref?.();
  };
  const follow = (targetId: string): void => {
    if (current?.targetId === targetId) return;
    if (current?.sessionId) { post("Page.stopScreencast", {}, current.sessionId); post("Target.detachFromTarget", { sessionId: current.sessionId }); }
    // A dialog of the page left is not the new page's.
    if (current) handlers.dialog(null);
    current = { targetId, sessionId: null };
    post("Target.attachToTarget", { targetId, flatten: true });
    announce();
  };
  /** The page's title as the browser holds it now (`Target.getTargetInfo`: no script runs in the page). */
  let asking = false;
  const refreshTitle = (): void => {
    const shown = current;
    if (!shown || asking || socket.readyState !== 1) return;
    asking = true;
    request("Target.getTargetInfo", { targetId: shown.targetId }).then((result) => {
      const info = result?.targetInfo;
      const known = pages.get(shown.targetId);
      if (!info || !known || current?.targetId !== shown.targetId) return;
      if (typeof info.title === "string") known.title = info.title;
      announce();
    }).catch(() => {}).finally(() => { asking = false; });
  };
  const poll = setInterval(refreshTitle, TITLE_POLL_MS);
  poll.unref?.();
  const choose = (): void => {
    let best: { id: string; moved: number; blank: boolean } | null = null;
    for (const [id, shown] of pages) {
      const blank = shown.url === "about:blank" || shown.url === "";
      if (best === null || (best.blank && !blank) || (best.blank === blank && shown.moved > best.moved)) best = { id, moved: shown.moved, blank };
    }
    if (best) follow(best.id);
  };

  socket.onopen = () => { post("Target.setDiscoverTargets", { discover: true }); };
  socket.onmessage = (event) => {
    let message: { id?: number; method?: string; params?: any; sessionId?: string; result?: any; error?: { message?: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined && waiting.has(message.id)) {
      const entry = waiting.get(message.id)!;
      waiting.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? "the browser refused"));
      else entry.resolve(message.result);
      return;
    }
    const { method, params, sessionId } = message;
    if (!method) return;
    try {
      if (method === "Target.targetCreated" && params.targetInfo?.type === "page") {
        pages.set(params.targetInfo.targetId, { url: String(params.targetInfo.url ?? ""), title: String(params.targetInfo.title ?? ""), moved: (moves += 1) });
        choose();
      } else if (method === "Target.targetInfoChanged" && params.targetInfo?.type === "page") {
        const info = params.targetInfo;
        const known = pages.get(info.targetId);
        // A page that moved to a new address is the one in use; a new title on the same address is not a move.
        if (!known) pages.set(info.targetId, { url: String(info.url ?? ""), title: String(info.title ?? ""), moved: (moves += 1) });
        else { if (known.url !== info.url) known.moved = (moves += 1); known.url = String(info.url ?? ""); known.title = String(info.title ?? ""); }
        choose();
        announce();
      } else if (method === "Target.attachedToTarget") {
        const shown = current;
        if (!shown || params.targetInfo?.targetId !== shown.targetId) { post("Target.detachFromTarget", { sessionId: params.sessionId }); return; }
        shown.sessionId = params.sessionId;
        post("Page.enable", {}, params.sessionId);
        post("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, everyNthFrame: 1 }, params.sessionId);
        const attached = String(params.sessionId);
        standIn(attached);
      } else if (method === "Page.screencastFrame") {
        const ackId = params.sessionId;
        const frameSession = sessionId;
        if (frameSession) framesFrom.set(frameSession, seenFrom(frameSession) + 1);
        let acked = false;
        // Called once, by the server after the frame went out or at once to drop it; the browser then sends the next.
        const ack = (): void => { if (acked) return; acked = true; if (frameSession) post("Page.screencastFrameAck", { sessionId: ackId }, frameSession); };
        if (!current || frameSession !== current.sessionId || closing) { ack(); return; }
        const w = Math.round(Number(params.metadata?.deviceWidth)) || 0;
        const h = Math.round(Number(params.metadata?.deviceHeight)) || 0;
        handlers.frame(Buffer.from(String(params.data), "base64"), { w, h }, ack);
      } else if ((method === "Page.loadEventFired" || method === "Page.domContentEventFired") && sessionId === current?.sessionId) {
        refreshTitle();
      } else if (method === "Page.frameNavigated" && sessionId === current?.sessionId && !params.frame?.parentId) {
        standIn(sessionId!);
      } else if (method === "Page.javascriptDialogOpening" && sessionId === current?.sessionId) {
        const kind = String(params.type);
        releaseInputs();
        handlers.dialog({ kind: (DIALOG_KINDS.has(kind) ? kind : "alert") as "alert", message: String(params.message ?? ""), ...(typeof params.defaultPrompt === "string" && params.defaultPrompt ? { defaultPrompt: params.defaultPrompt } : {}) });
      } else if (method === "Page.javascriptDialogClosed" && sessionId === current?.sessionId) {
        handlers.dialog(null);
      } else if (method === "Target.targetDestroyed") {
        pages.delete(params.targetId);
        if (params.targetId === current?.targetId) { current = null; handlers.dialog(null); }
        choose();
      }
    } catch { /* a handler that throws must not end the browser's socket */ }
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    clearInterval(poll);
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error("the browser's socket closed")); }
    waiting.clear();
    if (!closing) handlers.closed();
  };

  const stream: Stream = {
    async input(message: InputMessage): Promise<void> {
      const sessionId = page();
      if (message === null || typeof message !== "object") return bad();
      if (message.type === "mouse") {
        if (!finite(message.x) || !finite(message.y)) return bad();
        const button = message.button ?? "left";
        if (!(button in BUTTON_BITS)) return bad();
        const type = message.action === "down" ? "mousePressed" : message.action === "up" ? "mouseReleased" : message.action === "move" ? "mouseMoved" : bad();
        const clickCount = type === "mouseMoved" ? 0 : Number.isInteger(message.clickCount) && message.clickCount! >= 1 && message.clickCount! <= 3 ? message.clickCount! : 1;
        // The buttons held are the viewer's to say (MouseEvent.buttons, the same bitmask CDP takes): a hover holds none, a drag holds the buttons of the drag. A viewer that does not say gets the old reading
        // for a press (its own button) and none for a move and a release; never "the left button" for a hover.
        if (message.buttons !== undefined && !(Number.isInteger(message.buttons) && message.buttons >= 0 && message.buttons <= 31)) return bad();
        const held = message.buttons ?? (type === "mousePressed" ? BUTTON_BITS[button as keyof typeof BUTTON_BITS] : 0);
        const moveButton = held & BUTTON_BITS.left ? "left" : held & BUTTON_BITS.right ? "right" : held & BUTTON_BITS.middle ? "middle" : "none";
        await request("Input.dispatchMouseEvent", { type, x: message.x, y: message.y, button: type === "mouseMoved" ? moveButton : button, buttons: held, clickCount, modifiers: modifiers(message.modifiers) }, sessionId);
      } else if (message.type === "wheel") {
        if (!finite(message.x) || !finite(message.y) || !finite(message.deltaX, 1e5) || !finite(message.deltaY, 1e5)) return bad();
        await request("Input.dispatchMouseEvent", { type: "mouseWheel", x: message.x, y: message.y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: modifiers(message.modifiers) }, sessionId);
      } else if (message.type === "key") {
        if (typeof message.key !== "string" || message.key.length === 0 || message.key.length > 32 || typeof message.code !== "string" || message.code.length > 32) return bad();
        if (message.action !== "down" && message.action !== "up") return bad();
        const text = typeof message.text === "string" && message.text.length > 0 && message.text.length <= 8 ? message.text : undefined;
        // A key that makes text is a "keyDown" with that text; one that does not (an arrow, Enter without text, a shortcut) is a "rawKeyDown".
        const type = message.action === "up" ? "keyUp" : text !== undefined ? "keyDown" : "rawKeyDown";
        await request("Input.dispatchKeyEvent", {
          type, key: message.key, code: message.code, modifiers: modifiers(message.modifiers),
          ...(Number.isInteger(message.windowsVirtualKeyCode) && message.windowsVirtualKeyCode! >= 0 && message.windowsVirtualKeyCode! <= 255 ? { windowsVirtualKeyCode: message.windowsVirtualKeyCode, nativeVirtualKeyCode: message.windowsVirtualKeyCode } : {}),
          ...(type === "keyDown" ? { text, unmodifiedText: text } : {}),
        }, sessionId);
      } else if (message.type === "text") {
        if (typeof message.text !== "string" || message.text.length === 0 || message.text.length > MAX_TEXT) return bad();
        await request("Input.insertText", { text: message.text }, sessionId);
      } else return bad();
    },

    async nav(message: NavMessage): Promise<void> {
      const sessionId = page();
      if (message === null || typeof message !== "object" || message.type !== "nav") return bad();
      if (message.action === "reload") { await request("Page.reload", {}, sessionId); return; }
      if (message.action === "back") {
        const history = await request("Page.getNavigationHistory", {}, sessionId);
        const entry = history?.entries?.[Number(history?.currentIndex) - 1];
        if (!entry || !Number.isInteger(entry.id)) return;
        await request("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
        return;
      }
      if (message.action === "url") {
        // The address bar and the host's parser both take about:blank, exactly: the one non-http address a person has a use for, and it runs no script.
        if (message.url === "about:blank") { await request("Page.navigate", { url: "about:blank" }, sessionId); return; }
        // A person types an address: http and https only. A javascript: or data: address runs script in the page while looking like a navigation.
        let url: URL;
        try { url = new URL(String(message.url)); } catch { return bad(); }
        if (url.protocol !== "http:" && url.protocol !== "https:") return bad();
        await request("Page.navigate", { url: url.href }, sessionId);
        return;
      }
      return bad();
    },

    async dialog(answer: DialogAnswer): Promise<void> {
      const sessionId = page();
      if (answer === null || typeof answer !== "object" || answer.type !== "dialog" || typeof answer.accept !== "boolean") return bad();
      if (answer.promptText !== undefined && (typeof answer.promptText !== "string" || answer.promptText.length > MAX_TEXT)) return bad();
      await request("Page.handleJavaScriptDialog", { accept: answer.accept, ...(answer.promptText !== undefined ? { promptText: answer.promptText } : {}) }, sessionId);
    },

    close(): void {
      if (closing) return;
      closing = true;
      clearInterval(poll);
      if (current?.sessionId) { post("Page.stopScreencast", {}, current.sessionId); post("Target.detachFromTarget", { sessionId: current.sessionId }); }
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error("closed")); }
      waiting.clear();
      try { socket.close(); } catch { /* already closed */ }
    },
  };
  return stream;
};
