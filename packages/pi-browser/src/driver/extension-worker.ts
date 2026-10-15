export const STAGEHAND_EXTENSION = "Stagehand Runtime";
const DISCOVERY_MS = 10_000;
const WAKE_TRIES = 60;
const CLOSE_REPLY_MS = 3_000;
const SEND_TO_HOST = "__stagehandSendToHost";
const RESET_ID = 2_147_000_000;

/** A held extension runtime keeps one Stagehand instance until that instance's close, which a dead process never sent,
 *  so a new attach would be refused. The close is sent here through the worker's own RPC, and the worker keeps running:
 *  a worker closed under load is sometimes never restarted, and its attach waits out Stagehand's 60 s init deadline.
 *  With no worker running nothing is held, and the worker is woken until it is listed. */
export async function installedExtension(cdpUrl: string, signal?: AbortSignal, known?: string): Promise<string | null> {
  const socket = new WebSocket(cdpUrl);
  const timer = setTimeout(() => socket.close(), DISCOVERY_MS);
  const stop = () => socket.close();
  signal?.addEventListener("abort", stop, { once: true });
  // A call the browser never answers settles empty when the socket closes (the deadline, an abort, the browser).
  const pending = new Map<number, (result: any) => void>();
  const listeners = new Set<(event: { method: string; params?: any; sessionId?: string }) => void>();
  let next = 0;
  let closed = false;
  // A send on a closed socket neither throws nor is ever answered (Node 24): once closed, every call settles empty.
  const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return resolve(undefined);
    pending.set(++next, resolve);
    socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      // A refused connection raises `error` and, on Node 22, never `close`: waiting for `close` alone would hang the
      // attach.
      socket.onerror = () => reject(new Error("Failed to open CDP WebSocket"));
      socket.onclose = () => {
        closed = true;
        for (const settle of pending.values()) settle(undefined);
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
    const workers = async (): Promise<string[]> => ((await call("Target.getTargets"))?.targetInfos ?? [])
      .filter((target: { type: string; url: string }) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${id}/`))
      .map((target: { targetId: string }) => target.targetId);
    const running = await workers();
    if (running.length === 0) {
      let wake: string | null = null;
      for (let tries = 0; !closed && tries < WAKE_TRIES && (await workers()).length === 0; tries += 1) {
        if (tries % 10 === 0) {
          if (wake) await call("Target.closeTarget", { targetId: wake });
          wake = (await call("Target.createTarget", { url: `chrome-extension://${id}/wake-service-worker.html` }))?.targetId ?? null;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (wake) await call("Target.closeTarget", { targetId: wake });
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
  } catch { return known ?? null; } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); socket.close(); }
}
