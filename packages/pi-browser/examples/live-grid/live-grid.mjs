import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBrowserExtension } from "@parcha/pi-browser/coding-agent";
import { openBrowsersTool } from "./fanout.mjs";
import { screencast, watchedProvider } from "./tiles.mjs";

const PAGE = fs.readFileSync(new URL("./page.html", import.meta.url), "utf8");
const same = (a, b) => {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** One pi agent session, started the way pi's own runtime starts one: `dispose()` ends it, and the browser extension
 *  releases its browser on that shutdown. */
async function startSession({ modelRuntime, model, thinkingLevel, cwd, customTools = [], extensionFactories = [] }) {
  fs.mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(cwd, ".agent");
  const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: runtimeCwd, agentDir, modelRuntime, resourceLoaderOptions: { extensionFactories, noExtensions: true } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel, noTools: "builtin", customTools })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  await runtime.session.bindExtensions({});
  return runtime;
}

const childPrompt = (index, count, { site, task }) => [
  `You are browser ${index + 1} of ${count}, working on one website in your own browser.`,
  `Site: ${site}`,
  `Task: ${task}`,
  "Open the site first, then use the browser tools to do the task. Do not ask questions.",
  "Finish with your answer in at most three short lines.",
].join("\n");

const textOf = (message) => (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("").trim();
const shortStatus = (toolName, args) => {
  const goto = typeof args?.code === "string" ? /page\.goto\(\s*["'`]([^"'`]+)/.exec(args.code)?.[1] : null;
  if (goto) { try { return `opening ${new URL(goto).host}${new URL(goto).pathname === "/" ? "" : new URL(goto).pathname}`; } catch { return "opening a page"; } }
  return { snapshot: "reading the page", screenshot: "looking at the page", browser_read: "reading the page", run: "working on the page", web_fetch: "fetching a page" }[toolName] ?? toolName;
};

/**
 * Starts the demo: a page on `host:port` with the parent agent's chat and a tile per child browser.
 * `makeProvider(index)` builds child `index`'s browser provider; `models` is `{ modelRuntime, parent, child }`.
 */
export async function startLiveGrid({ makeProvider, models, maxChildren = 10, host = "127.0.0.1", port = 0, root = null, thinkingLevel = "low", env = process.env }) {
  const work = root ?? await mkdtemp(path.join(os.tmpdir(), "live-grid-"));
  const clients = new Set();
  // The page gets this token; only it can stream the grid (which carries live-view URLs) or start a task.
  const token = randomBytes(16).toString("hex");
  const chat = [];
  let seq = 0;
  const tiles = new Map();
  const sessions = new Map();
  let busy = false;
  let closed = false;

  const emit = (event) => {
    let line = `data: ${JSON.stringify(event)}\n\n`;
    if (event.type === "chat") { const id = ++seq; chat.push({ id, event }); line = `id: ${id}\n${line}`; }
    for (const res of clients) res.write(line);
  };
  const setTile = (index, change) => {
    const tile = Object.assign(tiles.get(index) ?? { index }, change);
    tiles.set(index, tile);
    emit({ type: "tile", index, site: tile.site, state: tile.state, status: tile.status, released: tile.released === true });
    return tile;
  };

  async function runChild(index, count, { site, task }, signal) {
    let cast = null;
    const refs = { created: [], released: [] };
    setTile(index, { site, task, state: "starting", status: "starting a browser", refs, frames: 0, live: false, liveUrl: null, released: false });
    const base = await makeProvider(index);
    const provider = watchedProvider(base, {
      launched: (ref) => { refs.created.push(ref); setTile(index, { state: "running", status: "browser open" }); },
      live: (url) => { setTile(index, { live: true, liveUrl: url }); emit({ type: "live", index, url }); },
      screencast: (browserUrl) => { cast?.close(); cast = screencast(browserUrl, (data) => { tiles.get(index).frames += 1; emit({ type: "frame", index, data }); }); },
      stopScreencast: () => { cast?.close(); cast = null; },
      released: (ref) => {
        refs.released.push(ref);
        if (tiles.get(index).liveUrl) { setTile(index, { liveUrl: null }); emit({ type: "live", index, url: null }); }
      },
    });
    const runtime = await startSession({
      modelRuntime: models.modelRuntime, model: models.child, thinkingLevel, cwd: path.join(work, `child-${index + 1}`),
      extensionFactories: [createBrowserExtension({ env, provider })],
    });
    sessions.set(`child-${index}`, runtime);
    let answer = "";
    const stop = runtime.session.subscribe((event) => {
      if (event.type === "tool_execution_start") setTile(index, { status: shortStatus(event.toolName, event.args) });
      else if (event.type === "message_end" && event.message?.role === "assistant" && textOf(event.message)) answer = textOf(event.message);
    });
    const abort = () => runtime.session.abort().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await runtime.session.prompt(childPrompt(index, count, { site, task }));
      setTile(index, { state: "done", status: answer.split("\n")[0] || "done" });
      return answer || "(no answer)";
    } catch (error) {
      setTile(index, { state: "failed", status: "failed" });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      stop();
      cast?.close();
      await runtime.dispose().catch(() => undefined);
      sessions.delete(`child-${index}`);
      for (const ref of refs.created) if (!refs.released.includes(ref)) await base.release(ref).then(() => refs.released.push(ref), () => undefined);
      setTile(index, { status: tiles.get(index).status, released: refs.created.length === refs.released.length });
    }
  }

  const tool = openBrowsersTool({ max: maxChildren, runChild });
  const parent = await startSession({ modelRuntime: models.modelRuntime, model: models.parent, thinkingLevel, cwd: path.join(work, "parent"), customTools: [tool] });
  sessions.set("parent", parent);
  parent.session.subscribe((event) => {
    if (event.type === "message_start" && event.message?.role === "assistant") emit({ type: "chat", kind: "assistant" });
    else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") emit({ type: "chat", kind: "delta", text: event.assistantMessageEvent.delta });
    else if (event.type === "tool_execution_start") emit({ type: "chat", kind: "tool", name: event.toolName, sites: (event.args?.tasks ?? []).map((task) => task.site) });
    else if (event.type === "tool_execution_end") emit({ type: "chat", kind: "tool_end", name: event.toolName, isError: event.isError === true });
  });

  async function prompt(text) {
    if (busy) throw Object.assign(new Error("the agent is still working on the last task"), { status: 409 });
    tiles.clear();
    emit({ type: "reset" });
    emit({ type: "chat", kind: "user", text });
    busy = true;
    try { await parent.session.prompt(text); } catch (error) { emit({ type: "chat", kind: "error", text: String(error?.message ?? error).slice(0, 300) }); } finally { busy = false; emit({ type: "chat", kind: "done" }); }
  }

  let hosts = new Set();
  const refuse = (res, status, text) => { res.writeHead(status, { "content-type": "text/plain" }); res.end(text); };
  const server = http.createServer((req, res) => {
    // A name other than the loopback address it listens on is DNS rebinding: a foreign site posing as this origin.
    if (!hosts.has(req.headers.host)) return refuse(res, 403, "unknown host");
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(PAGE.replace('<meta name="live-grid-token" content="">', `<meta name="live-grid-token" content="${token}">`)); }
    if (req.method === "GET" && url.pathname === "/events") {
      if (!same(url.searchParams.get("token"), token)) return refuse(res, 403, "no token");
      const after = Number(req.headers["last-event-id"]) || 0;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", maxChildren, busy })}\n\n`);
      for (const { id, event } of chat) if (id > after) res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const tile of tiles.values()) {
        res.write(`data: ${JSON.stringify({ type: "tile", index: tile.index, site: tile.site, state: tile.state, status: tile.status, released: tile.released === true })}\n\n`);
        if (tile.liveUrl) res.write(`data: ${JSON.stringify({ type: "live", index: tile.index, url: tile.liveUrl })}\n\n`);
      }
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) return refuse(res, 403, "another origin");
      if (!same(req.headers["x-live-grid-token"], token)) return refuse(res, 403, "no token");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "send JSON");
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 20_000) req.destroy(); });
      req.on("end", () => {
        let text = "";
        try { text = String(JSON.parse(body).text ?? "").trim(); } catch {}
        if (!text) { res.writeHead(400); return res.end("say what to do"); }
        if (busy) { res.writeHead(409); return res.end("the agent is still working on the last task"); }
        res.writeHead(202); res.end();
        prompt(text);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); });
  } catch (error) {
    await parent.dispose().catch(() => undefined);
    if (!root) await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const keepAlive = setInterval(() => { for (const res of clients) res.write(": keep-alive\n\n"); }, 15_000);
  const address = server.address();
  hosts = new Set([`${address.address}:${address.port}`, `localhost:${address.port}`]);

  return {
    url: `http://${address.address}:${address.port}/`,
    prompt,
    tiles: () => [...tiles.values()].map(({ index, site, state, status, refs, frames, live }) => ({ index, site, state, status, created: refs.created.length, released: refs.released.length, refs: refs.created, frames, live })),
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      for (const res of clients) res.end();
      server.close();
      for (const runtime of sessions.values()) await runtime.session.abort().catch(() => undefined);
      for (const runtime of [...sessions.values()]) await runtime.dispose().catch(() => undefined);
      if (!root) await rm(work, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
