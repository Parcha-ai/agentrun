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

/** A held extension runtime keeps one Stagehand instance until that instance's close, which a dead process never sent,
 *  so a new attach would be refused. The close is sent here through the worker's own RPC, and the worker keeps running:
 *  a worker closed under load is sometimes never restarted, and its attach waits out Stagehand's 60 s init deadline.
 *  With no worker running nothing is held, and the worker is woken until it is listed. A target list the browser does
 *  not give by DISCOVERY_MS is not a list without a worker: the attach fails. */
export async function installedExtension(cdpUrl: string, signal?: AbortSignal, known?: string): Promise<string | null> {
  const socket = new WebSocket(cdpUrl);
  const deadline = Date.now() + DISCOVERY_MS;
  const timer = setTimeout(() => socket.close(), DISCOVERY_MS + CLEANUP_MS);
  const stop = () => socket.close();
  signal?.addEventListener("abort", stop, { once: true });
  // A call the browser does not answer within `ms` (the deadline, unless shorter) settles empty, as does every call once
  // the socket closes (an abort, the browser).
  const pending = new Map<number, (result: any) => void>();
  const listeners = new Set<(event: { method: string; params?: any; sessionId?: string }) => void>();
  let next = 0;
  let closed = false;
  // A send on a closed socket neither throws nor is ever answered (Node 24): once closed, every call settles empty.
  const call = (method: string, params: object = {}, sessionId?: string, ms = deadline - Date.now()) => new Promise<any>((resolve) => {
    if (closed || socket.readyState !== WebSocket.OPEN || ms <= 0) return resolve(undefined);
    const id = ++next;
    const settle = (result: any) => { clearTimeout(wait); pending.delete(id); resolve(result); };
    const wait = setTimeout(() => settle(undefined), ms);
    pending.set(id, settle);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      // A refused connection raises `error` and, on Node 22, never `close`: waiting for `close` alone would hang the
      // attach.
      socket.onerror = () => reject(new Error("Failed to open CDP WebSocket"));
      socket.onclose = () => {
        closed = true;
        for (const settle of [...pending.values()]) settle(undefined);
        for (const listener of listeners) listener({ method: "closed" });
        reject(new Error("the CDP socket closed"));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== undefined) pending.get(message.id)?.(message.result);
        else for (const listener of listeners) listener(message);
      };
    });
    let id = known ?? null;
    if (!id) {
      const extensions: Array<{ id: string; name: string; enabled: boolean }> = (await call("Extensions.getExtensions"))?.extensions ?? [];
      const enabled = extensions.filter((extension) => extension.name === STAGEHAND_EXTENSION && extension.enabled);
      if (enabled.length !== 1) return null;
      id = enabled[0]!.id;
    }
    /** The extension's workers; null when the browser gave no list, which is not a list without one. */
    const workers = async (): Promise<string[] | null> => {
      const infos: Array<{ targetId: string; type: string; url: string }> | undefined = (await call("Target.getTargets"))?.targetInfos;
      return infos?.filter((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`)).map((target) => target.targetId) ?? null;
    };
    const running = await workers();
    if (running === null) {
      if (signal?.aborted || closed) return id;
      throw new TargetsUnlistedError();
    }
    if (running.length === 0) {
      // Every wake page opened stays listed here until a close of it is answered. None is opened within CLEANUP_MS of the
      // deadline, an opening's reply is awaited into the first half of that second, and the socket outlives the deadline
      // by CLEANUP_MS, so the last pages are closed on it.
      const wakes = new Set<string>();
      const closeWakes = async (ms?: number) => { for (const page of [...wakes]) if ((await call("Target.closeTarget", { targetId: page }, undefined, ms)) !== undefined) wakes.delete(page); };
      for (let tries = 0; !closed && Date.now() < deadline && tries < WAKE_TRIES && ((await workers())?.length ?? 0) === 0; tries += 1) {
        if (tries % 10 === 0 && deadline - Date.now() > CLEANUP_MS) {
          await closeWakes();
          const page: string | undefined = (await call("Target.createTarget", { url: `chrome-extension://${id}/wake-service-worker.html` }, undefined, deadline + CLEANUP_MS / 2 - Date.now()))?.targetId;
          if (page) wakes.add(page);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      await closeWakes(deadline + CLEANUP_MS - Date.now());
      return id;
    }
    const sessionId: string | undefined = (await call("Target.attachToTarget", { targetId: running[0], flatten: true }))?.sessionId;
    if (!sessionId) return id;
    try {
      await call("Runtime.enable", {}, sessionId);
      await call("Runtime.addBinding", { name: SEND_TO_HOST }, sessionId);
      const replied = new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, CLOSE_REPLY_MS);
        listeners.add((event) => {
          if (event.method === "closed") { clearTimeout(wait); return resolve(); }
          if (event.method !== "Runtime.bindingCalled" || event.sessionId !== sessionId || event.params?.name !== SEND_TO_HOST) return;
          let reply: { id?: unknown } | null = null;
          try { reply = JSON.parse(event.params.payload); } catch {}
          if (reply?.id === RESET_ID) { clearTimeout(wait); resolve(); }
        });
      });
      const close = JSON.stringify({ jsonrpc: "2.0", id: RESET_ID, method: "stagehand.close", params: {} });
      const sent = await call("Runtime.evaluate", { expression: `void globalThis.__stagehandReceiveFromHost(${JSON.stringify(close)}); true`, returnByValue: true }, sessionId);
      if (sent && !sent.exceptionDetails) await replied;
    } finally {
      await call("Target.detachFromTarget", { sessionId });
    }
    return id;
  } catch (error) {
    if (error instanceof TargetsUnlistedError) throw error;
    return known ?? null;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); socket.close(); }
}
