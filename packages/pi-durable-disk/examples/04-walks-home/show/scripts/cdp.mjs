// A minimal Chrome DevTools Protocol client for our own localhost pages: open a fresh tab on the shared Chrome
// (127.0.0.1:9222), run steps, close the tab. It never touches a tab it did not open, and refuses non-local URLs.
import WebSocket from "ws";

const DEBUG = process.env.CDP_URL ?? "http://127.0.0.1:9222";

export async function openTab(url, { width = 1600, height = 900 } = {}) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error(`refusing non-local url ${url}`);
  const res = await fetch(`${DEBUG}/json/new?about:blank`, { method: "PUT" });
  if (!res.ok) throw new Error(`json/new: HTTP ${res.status}`);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const logs = [];
  listeners.push((m) => {
    if (m.method === "Runtime.consoleAPICalled") logs.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    if (m.method === "Runtime.exceptionThrown") logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === "Log.entryAdded" && m.params.entry.level !== "info") logs.push(`log.${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  return {
    logs,
    send,
    listen: (fn) => listeners.push(fn),
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      (await import("node:fs")).writeFileSync(path, Buffer.from(data, "base64"));
    },
    async close() {
      ws.close();
      await fetch(`${DEBUG}/json/close/${target.id}`).catch(() => {});
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A port nothing is listening on. The box is shared with other lanes' servers, so a check never claims a fixed port: a fixed
 * one that is taken makes a server fail to start silently and the check then talks to somebody else's.
 */
export async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
