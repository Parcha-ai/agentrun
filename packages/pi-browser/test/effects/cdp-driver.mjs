// A small CDP page driver for the effects tests, until the Stagehand driver lands: one raw CDP connection to the
// browser endpoint the provider attaches, driving its first page. A `run`'s code is a JSON list of steps: {goto: path}
// (resolved against the fixture server), {click: selector}, {wait: ms}, {waitLoad: true}.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cdpDriver(base) {
  return async (target) => {
    const ws = new WebSocket(target.sdkCdpUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("the test driver could not reach the browser")); });
    let next = 1;
    const pending = new Map();
    const waiters = [];
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result); return; }
      for (const w of waiters.splice(0)) if (w.method === m.method && w.sessionId === m.sessionId) w.resolve(); else waiters.push(w);
    };
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error("the test driver's socket closed")); pending.clear(); };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const event = (method, sessionId) => new Promise((resolve) => waiters.push({ method, sessionId, resolve }));

    const { targetInfos } = await send("Target.getTargets");
    const first = targetInfos.find((t) => t.type === "page") ?? { targetId: (await send("Target.createTarget", { url: "about:blank" })).targetId };
    const { sessionId } = await send("Target.attachToTarget", { targetId: first.targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    // `userGesture`: a click carries user activation, as a real one does, so popups open.
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId)).result.value;

    return {
      async run({ code }) {
        for (const step of JSON.parse(code)) {
          if (step.goto) { const loaded = event("Page.loadEventFired", sessionId); await send("Page.navigate", { url: new URL(step.goto, base).href }, sessionId); await loaded; }
          else if (step.click) await evaluate(`document.querySelector(${JSON.stringify(step.click)}).click()`);
          else if (step.wait) await sleep(step.wait);
          else if (step.waitLoad) await event("Page.loadEventFired", sessionId);
        }
        return { url: await evaluate("location.href") };
      },
      url: () => evaluate("location.href"),
      snapshot: () => evaluate("document.body ? document.body.innerText : ''"),
      page: async () => ({ url: await evaluate("location.href"), title: await evaluate("document.title"), text: await evaluate("document.body ? document.body.innerText : ''"), html: await evaluate("document.documentElement.outerHTML") }),
      screenshot: async () => ({ data: (await send("Page.captureScreenshot", { format: "png" }, sessionId)).data, mimeType: "image/png" }),
      /** Close every page but the one this driver drives (popups a case opened). */
      async closeOthers() {
        for (const t of (await send("Target.getTargets")).targetInfos) if (t.type === "page" && t.targetId !== first.targetId) await send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
      },
      close: async () => ws.close(),
    };
  };
}
