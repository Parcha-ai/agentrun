export const STAGEHAND_EXTENSION = "Stagehand Runtime";
const DISCOVERY_MS = 10_000;
/** Kept past the deadline so the last wake page is closed on the same socket. */
const CLEANUP_MS = 1_000;
const WAKE_TRIES = 60;
const CLOSE_REPLY_MS = 3_000;
const SEND_TO_HOST = "__stagehandSendToHost";
const RESET_ID = 2_147_000_000;

/** The browser did not list its targets by the deadline, so a runtime it may hold could not be freed. */
class TargetsUnlistedError extends Error {
  constructor() { super(`the browser did not list its targets within ${DISCOVERY_MS} ms, so a Stagehand runtime it may hold could not be freed`); }
}

/** A CDP event as a listener gets it, or `closed` once the socket has closed. */
type CdpEvent = { method: string; params?: { name?: string; payload?: string }; sessionId?: string };

/** One attach's CDP socket, open for `lifeMs` at most and closed at once on an abort. A call settles empty when the
 *  browser does not answer within `ms` (the deadline, unless shorter), and every call settles empty once the socket
 *  closes (an abort, the browser, the end of its life). */
class Cdp {
  /** Settles when the socket opens; rejects when it fails to open or closes first. */
  readonly opened: Promise<void>;
  private readonly socket: WebSocket;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly stop = () => this.socket.close();
  private readonly pending = new Map<number, (result: unknown) => void>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private next = 0;
  private isClosed = false;

  constructor(cdpUrl: string, private readonly deadline: number, lifeMs: number, private readonly signal?: AbortSignal) {
    this.socket = new WebSocket(cdpUrl);
    this.timer = setTimeout(() => this.socket.close(), lifeMs);
    signal?.addEventListener("abort", this.stop, { once: true });
    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      // A refused connection raises `error` and, on Node 22, never `close`: waiting for `close` alone would hang the attach.
      this.socket.onerror = () => reject(new Error("Failed to open CDP WebSocket"));
      this.socket.onclose = () => { this.onClose(); reject(new Error("the CDP socket closed")); };
      this.socket.onmessage = (event) => this.onMessage(event.data);
    });
  }

  /** A send on a closed socket neither throws nor is ever answered (Node 24): once closed, every call settles empty. */
  call<T>(method: string, params: object = {}, sessionId?: string, ms = this.deadline - Date.now()): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      if (this.isClosed || this.socket.readyState !== WebSocket.OPEN || ms <= 0) return resolve(undefined);
      const id = ++this.next;
      const settle = (result: unknown) => { clearTimeout(wait); this.pending.delete(id); resolve(result as T | undefined); };
      const wait = setTimeout(() => settle(undefined), ms);
      this.pending.set(id, settle);
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  listen(listener: (event: CdpEvent) => void): void { this.listeners.add(listener); }
  closed(): boolean { return this.isClosed; }
  end(): void { clearTimeout(this.timer); this.signal?.removeEventListener("abort", this.stop); this.socket.close(); }

  private onClose(): void {
    this.isClosed = true;
    for (const settle of [...this.pending.values()]) settle(undefined);
    for (const listener of this.listeners) listener({ method: "closed" });
  }

  /** A throw in a socket listener ends the process: a frame that is not JSON is dropped. */
  private onMessage(data: unknown): void {
    try {
      const message = JSON.parse(String(data)) as (CdpEvent & { id?: number; result?: unknown }) | null;
      if (message?.id !== undefined) this.pending.get(message.id)?.(message.result);
      else if (message) for (const listener of this.listeners) listener(message);
    } catch {}
  }
}

/** The one enabled Stagehand extension's id; null when there is none, or more than one. */
async function stagehandExtensionId(cdp: Cdp): Promise<string | null> {
  const extensions = (await cdp.call<{ extensions: Array<{ id: string; name: string; enabled: boolean }> }>("Extensions.getExtensions"))?.extensions ?? [];
  const enabled = extensions.filter((extension) => extension.name === STAGEHAND_EXTENSION && extension.enabled);
  return enabled.length === 1 ? enabled[0]!.id : null;
}

/** The extension's workers; null when the browser gave no list, which is not a list without one. */
async function extensionWorkers(cdp: Cdp, id: string): Promise<string[] | null> {
  const infos = (await cdp.call<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets"))?.targetInfos;
  return infos?.filter((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`)).map((target) => target.targetId) ?? null;
}

/** With no worker running nothing is held, and the worker is woken until it is listed. Every wake page opened stays
 *  listed here until a close of it is answered. None is opened within CLEANUP_MS of the deadline, an opening's reply is
 *  awaited into the first half of that second, and the socket outlives the deadline by CLEANUP_MS, so the last pages are
 *  closed on it. */
async function wakeWorker(cdp: Cdp, id: string, deadline: number): Promise<void> {
  const wakes = new Set<string>();
  const closeWakes = async (ms?: number) => { for (const page of [...wakes]) if ((await cdp.call("Target.closeTarget", { targetId: page }, undefined, ms)) !== undefined) wakes.delete(page); };
  for (let tries = 0; !cdp.closed() && Date.now() < deadline && tries < WAKE_TRIES && ((await extensionWorkers(cdp, id))?.length ?? 0) === 0; tries += 1) {
    if (tries % 10 === 0 && deadline - Date.now() > CLEANUP_MS) {
      await closeWakes();
      const page = (await cdp.call<{ targetId: string }>("Target.createTarget", { url: `chrome-extension://${id}/wake-service-worker.html` }, undefined, deadline + CLEANUP_MS / 2 - Date.now()))?.targetId;
      if (page) wakes.add(page);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await closeWakes(deadline + CLEANUP_MS - Date.now());
}

/** A binding call on `sessionId` that carries the reply to the close (its id is RESET_ID). */
function isResetReply(event: CdpEvent, sessionId: string): boolean {
  if (event.method !== "Runtime.bindingCalled" || event.sessionId !== sessionId || event.params?.name !== SEND_TO_HOST) return false;
  try { return (JSON.parse(event.params.payload ?? "") as { id?: unknown } | null)?.id === RESET_ID; } catch { return false; }
}

/** Settles on the runtime's reply to the close, at once when the socket closes, and after `replyMs` at most. */
function resetReplied(cdp: Cdp, sessionId: string, replyMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const wait = setTimeout(resolve, replyMs);
    cdp.listen((event) => {
      if (event.method === "closed" || isResetReply(event, sessionId)) { clearTimeout(wait); resolve(); }
    });
  });
}

/** The held runtime's close, sent through the worker's own RPC, and its reply awaited for up to `replyMs`; the worker
 *  keeps running. */
async function closeHeldRuntime(cdp: Cdp, worker: string, replyMs: number): Promise<void> {
  const sessionId = (await cdp.call<{ sessionId: string }>("Target.attachToTarget", { targetId: worker, flatten: true }))?.sessionId;
  if (!sessionId) return;
  try {
    await cdp.call("Runtime.enable", {}, sessionId);
    await cdp.call("Runtime.addBinding", { name: SEND_TO_HOST }, sessionId);
    const replied = resetReplied(cdp, sessionId, replyMs);
    const close = JSON.stringify({ jsonrpc: "2.0", id: RESET_ID, method: "stagehand.close", params: {} });
    const sent = await cdp.call<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: `void globalThis.__stagehandReceiveFromHost(${JSON.stringify(close)}); true`, returnByValue: true }, sessionId);
    if (sent && !sent.exceptionDetails) await replied;
  } finally {
    await cdp.call("Target.detachFromTarget", { sessionId });
  }
}

/** A held extension runtime keeps one Stagehand instance until that instance's close, which a dead process never sent,
 *  so a new attach would be refused. The close is sent here through the worker's own RPC, and the worker keeps running:
 *  a worker closed under load is sometimes never restarted, and its attach waits out Stagehand's 60 s init deadline.
 *  With no worker running nothing is held, and the worker is woken until it is listed. A target list the browser does
 *  not give by DISCOVERY_MS is not a list without a worker: the attach fails. `replyMs`: how long the close waits for the
 *  runtime's reply. An init still running in the extension answers it only once that init ends, since the runtime runs
 *  both one after the other; the socket outlives the deadline by that much more. */
export async function installedExtension(cdpUrl: string, signal?: AbortSignal, known?: string, replyMs = CLOSE_REPLY_MS): Promise<string | null> {
  const deadline = Date.now() + DISCOVERY_MS;
  const cdp = new Cdp(cdpUrl, deadline, DISCOVERY_MS + CLEANUP_MS - CLOSE_REPLY_MS + replyMs, signal);
  try {
    await cdp.opened;
    const id = known || (await stagehandExtensionId(cdp));
    if (!id) return null;
    const running = await extensionWorkers(cdp, id);
    if (running === null) {
      if (signal?.aborted || cdp.closed()) return id;
      throw new TargetsUnlistedError();
    }
    if (running.length === 0) await wakeWorker(cdp, id, deadline);
    else await closeHeldRuntime(cdp, running[0]!, replyMs);
    return id;
  } catch (error) {
    if (error instanceof TargetsUnlistedError) throw error;
    return known ?? null;
  } finally { cdp.end(); }
}
