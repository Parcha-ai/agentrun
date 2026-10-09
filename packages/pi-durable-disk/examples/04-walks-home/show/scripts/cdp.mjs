// A minimal Chrome DevTools Protocol client for our own localhost pages: open a fresh tab on the shared Chrome
// (127.0.0.1:9222), run steps, close the tab. It never touches a tab it did not open, and refuses non-local URLs.
import WebSocket from "ws";

/** The stage's default page is the v2 take (creature, badge, chat, caption). The checks and recordings of the v1 stage read its panels, which `?debug=1` brings back. */
export const withDebug = (url) => (/[?&]debug=/.test(url) ? url : `${url}${url.includes("?") ? "&" : "?"}debug=1`);

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

/**
 * Refuse unless `origin` answers like a stage: a JSON state with a run and an environments list. A check must never test
 * whatever happens to be on a port; on this shared box that is often another lane's server.
 */
export async function assertStage(origin) {
  let res;
  try {
    res = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(4000) });
  } catch (error) {
    throw new Error(`${origin} is not a stage: nothing answered (${error.message})`);
  }
  if (!res.ok) throw new Error(`${origin} is not a stage: /api/state answered ${res.status}`);
  const state = await res.json().catch(() => undefined);
  if (!state || typeof state !== "object" || typeof state.run !== "string" || !Array.isArray(state.environments)) throw new Error(`${origin} is not a stage: /api/state is not a stage's state`);
  return state;
}

/**
 * Wait for the stage a script just started on `port`, and stop at once if its own child exits first. Without the second part, a
 * child that failed to start leaves the port to whatever else answers there, and the check goes on to test that.
 */
export async function waitForStage(port, child, ms = 20_000) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`the server this check started on port ${port} exited with code ${child.exitCode} before it came up`);
    try {
      return await assertStage(`http://127.0.0.1:${port}`);
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`the server this check started on port ${port} did not come up in ${ms} ms (${last})`);
}

/** Wait for a file the child writes when it is ready, stopping at once if the child exits first. */
export async function waitForFile(file, child, ms = 30_000) {
  const { existsSync } = await import("node:fs");
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(file)) return;
    if (child.exitCode !== null) throw new Error(`the process this check started exited with code ${child.exitCode} before it wrote ${file}`);
    await sleep(200);
  }
  throw new Error(`${file} did not appear in ${ms} ms`);
}
