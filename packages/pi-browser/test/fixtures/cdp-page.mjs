// A page driver in forty lines: enough for the live checks to open a URL, set a cookie and read it back over a provider's
// own CDP URL. It prints nothing of the URL it is given.
export async function withPage(browserWsUrl, url, work, { timeoutMs = 30_000 } = {}) {
  const ws = new WebSocket(browserWsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("could not open the browser socket")); });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (event) => { const message = JSON.parse(event.data); waiting.get(message.id)?.(message); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    waiting.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(`the page threw: ${result.exceptionDetails.text}`);
      return result.result.value;
    };
    for (const end = Date.now() + timeoutMs; !(await evaluate(`location.href.startsWith(${JSON.stringify(url)}) && document.readyState === "complete"`).catch(() => false)); ) {
      if (Date.now() > end) throw new Error("the page did not finish loading");
      await new Promise((r) => setTimeout(r, 250));
    }
    return await work(evaluate);
  } finally { ws.close(); }
}
