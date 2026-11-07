// `goto` returns when that navigation's own document has loaded (by its loader id), never on another document's late
// load event.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cdpDriver(base) {
  return async (target) => {
    const ws = new WebSocket(target.sdkCdpUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("the test driver could not reach the browser")); });
    let next = 1;
    const pending = new Map();
    const waiters = [];
    const loaded = new Set();
    // Fetches, XHRs and their CORS preflights the browser or the network dropped (net::ERR_ABORTED, a preflight with no
    // answer, ...), not documents: re-running a case over a navigation still in flight races it. A request the observer
    // refused (net::ERR_BLOCKED_BY_CLIENT) is the effect under test, never a drop.
    let aborted = 0;
    // The page's own requests (not documents) the browser has announced and not yet ended, by request id.
    const inFlight = new Set();
    const settledWaiters = [];
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.id !== undefined) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result); return; }
      if (m.method === "Page.lifecycleEvent" && m.params.name === "load") loaded.add(m.params.loaderId);
      if (m.method === "Network.requestWillBeSent" && m.params.type !== "Document") inFlight.add(m.params.requestId);
      if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
        inFlight.delete(m.params.requestId);
        if (inFlight.size === 0) for (const wake of settledWaiters.splice(0)) wake();
      }
      if (m.method === "Network.loadingFailed" && ["Fetch", "XHR", "Preflight"].includes(m.params.type) && !m.params.errorText.startsWith("net::ERR_BLOCKED_BY_CLIENT")) aborted += 1;
      for (const w of waiters.splice(0)) if (w.test(m)) w.resolve(); else waiters.push(w);
    };
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error("the test driver's socket closed")); pending.clear(); };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const waitFor = (test) => new Promise((resolve) => { if (test(null)) resolve(); else waiters.push({ test, resolve }); });
    const event = (method, sessionId) => waitFor((m) => m !== null && m.method === method && m.sessionId === sessionId);

    const { targetInfos } = await send("Target.getTargets");
    const first = targetInfos.find((t) => t.type === "page") ?? { targetId: (await send("Target.createTarget", { url: "about:blank" })).targetId };
    const { sessionId } = await send("Target.attachToTarget", { targetId: first.targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    await send("Network.enable", {}, sessionId);
    /** The pid of Chrome's network service, its own process; null when Chrome names none. */
    const networkService = async () => (await send("SystemInfo.getProcessInfo")).processInfo.find((p) => p.type.includes("NetworkService"))?.id ?? null;
    // When the network service dies (Chrome for Testing 155 sometimes crashes it just after a CORS preflight while Fetch
    // interception is on, more often under load, sandbox or not), Chrome starts another, and here never ends the requests
    // the dead one carried: no loadingFailed, no pause, nothing at the server. Its restart is a drop: it is counted, and what
    // was in flight is forgotten, since nothing will end it.
    // Checks run one at a time, so one restart is counted once.
    let service = await networkService().catch(() => null);
    let restarts = 0;
    let checking = Promise.resolve();
    const checkService = () => (checking = checking.then(async () => {
      const now = await networkService().catch(() => null);
      if (now === null || now === service) return;
      if (service !== null) { restarts += 1; inFlight.clear(); for (const wake of settledWaiters.splice(0)) wake(); }
      service = now;
    }));
    // `userGesture`: a click carries user activation, as a real one does, so popups open.
    const evaluate = async (expression) => {
      const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
      if (answer.exceptionDetails) throw new Error(`the page threw: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
      return answer.result.value;
    };

    return {
      async run({ code }) {
        for (const step of JSON.parse(code)) {
          if (step.goto) {
            const nav = await send("Page.navigate", { url: new URL(step.goto, base).href }, sessionId);
            if (nav.loaderId && !nav.errorText) await waitFor(() => loaded.has(nav.loaderId));
          }
          else if (step.click) {
            // The element is waited for: a document that has fired load can still be settling under load.
            const selector = JSON.stringify(step.click);
            for (let deadline = Date.now() + 10_000; !(await evaluate(`!!document.querySelector(${selector})`)); await sleep(50)) {
              if (Date.now() > deadline) throw new Error(`no ${step.click} on ${await evaluate("location.href")} (${await evaluate("document.readyState")}) after 10 s`);
            }
            await evaluate(`document.querySelector(${selector}).click()`);
          }
          else if (step.wait) await sleep(step.wait);
          else if (step.waitLoad) await event("Page.loadEventFired", sessionId);
        }
        return { url: await evaluate("location.href") };
      },
      /** Returns the moment the browser answers: the request the page starts in it exists, and nothing else has
       *  happened since. */
      fire: (expression) => evaluate(expression),
      /** How many drops so far: requests the browser or the network dropped (see above), and restarts of the network service. */
      drops: async () => { await checkService(); return aborted + restarts; },
      /** How many times the network service restarted so far. */
      restarts: async () => { await checkService(); return restarts; },
      /** Resolves once every request the page started (but documents) has ended, or the network service has restarted (which
       *  ends none of them), or after `ms`. */
      settled: (ms) => new Promise((resolve) => {
        if (inFlight.size === 0) return resolve();
        const wake = () => { clearTimeout(timer); clearInterval(poll); const at = settledWaiters.indexOf(wake); if (at !== -1) settledWaiters.splice(at, 1); resolve(); };
        const timer = setTimeout(wake, ms);
        const poll = setInterval(() => void checkService(), 500);
        settledWaiters.push(wake);
      }),
      networkService,
      url: () => evaluate("location.href"),
      snapshot: () => evaluate("document.body ? document.body.innerText : ''"),
      page: async () => ({ url: await evaluate("location.href"), title: await evaluate("document.title"), text: await evaluate("document.body ? document.body.innerText : ''"), html: await evaluate("document.documentElement.outerHTML") }),
      screenshot: async () => ({ data: (await send("Page.captureScreenshot", { format: "png" }, sessionId)).data, mimeType: "image/png" }),
      async closeOthers() {
        for (const t of (await send("Target.getTargets")).targetInfos) if (t.type === "page" && t.targetId !== first.targetId) await send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
      },
      close: async () => ws.close(),
    };
  };
}
