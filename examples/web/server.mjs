// The runs app: a small web server over a directory of durable runs (`<runs>/<id>/{run.json, store/run.sqlite, work/}`).
// It lists the runs, serves one run's page (timeline proxied from the run's own door, chat, files, live browser), and
// starts runs with a command you give it. A live run is only ever read through its door; a released run's transcript is
// read from its store, read-only. Node's http and nothing else. Binds to loopback unless you pass --host.
// Routes follow Grep's: GET /runs, GET /runs/{id}, GET /runs/{id}/timeline (SSE while live, JSON when released),
// GET /runs/{id}/files[/{path}], POST /runs, POST /runs/{id}/messages, POST /runs/{id}/stop, GET /search?q=.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { timelineOf, timelineReducer } from "./timeline/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LEASE_MS = 90_000;
const RELEASED = new Set(["sleeping", "paused", "done", "failed"]);
const RETRY_CODES = ["OPENING", "PARKING", "RELEASED"];
const TEXT_CAP = 512 * 1024;
const SEARCH_FILE_CAP = 1024 * 1024;
const TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yml", "yaml", "xml", "js", "mjs", "ts", "py", "sh", "toml", "ini", "css", "sql"]);
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const PAGE = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/app.css": ["app.css", "text/css; charset=utf-8"] };
const MODULE = /^\/timeline\/[a-z-]+\.js$/;
const APP_CSP = "default-src 'self'; frame-src https: 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; form-action 'none'";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const readJson = (path) => readFile(path, "utf8").then(JSON.parse).catch(() => null);
const isLoopback = (host) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

const QUIET = /:run:(start|end)$/;
/** working while a run is in flight; waiting when the newest row (not counting cost and run start/end) is a wait for the person; idle otherwise. */
const stateOf = (rows, working) => (working ? "working" : rows.findLast((r) => r.kind !== "usage" && !QUIET.test(r.id))?.kind === "waiting" ? "waiting" : "idle");
const costOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage?.usd ?? null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(text);
}

async function bodyOf(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1 << 20) throw new HttpError(413, "body over 1 MiB");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, "the body is not a JSON object");
}

/** Server-sent events as `{event, data}`, from a response body. */
async function* frames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf("\n\n")) >= 0; ) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      try {
        yield { event, data: JSON.parse(data.join("\n")) };
      } catch {}
    }
  }
}

const fresh = (record) => Date.now() - Date.parse(record.heartbeatAt) < LEASE_MS;
/** No record, a released run, or a running one whose lease lapsed: nobody holds it, so starting it is safe. */
const startable = (record) => !record || record.status !== "running" || !fresh(record);

/** The door a live run serves, from its run.json: running, a fresh heartbeat, and a loopback address. */
function doorOf(record) {
  if (record?.status !== "running" || typeof record.holder?.serve !== "string") return undefined;
  if (!fresh(record)) return undefined;
  const url = URL.parse(record.holder.serve);
  return url?.protocol === "http:" && isLoopback(url.hostname) ? url.origin : undefined;
}

export async function startServer({ runs, host = "127.0.0.1", port = 0, start = [], allowHosts = [], agentName = "" }) {
  const root = runs;
  const children = new Map();
  const exits = new Map();
  const startErrors = new Map();
  const stores = new Map();

  // ---- runs --------------------------------------------------------------------------------------------------------
  async function loadRun(id) {
    if (!ID.test(id)) return null;
    const dir = join(root, id);
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) return null;
    const record = await readJson(join(dir, "run.json"));
    return { id, dir, work: join(dir, "work"), record: typeof record?.status === "string" ? record : null, meta: (await readJson(join(dir, "web.json"))) ?? {} };
  }

  const statusOf = (run) => (run.record ? (run.record.status === "running" && !doorOf(run.record) ? "lost" : run.record.status) : children.has(run.id) ? "starting" : "unknown");

  /** The run's transcript from its store, opened read-only; only for a run whose claim is released. */
  async function readStore(run) {
    if (!RELEASED.has(run.record?.status)) throw new HttpError(409, "the run is live: read it through its door");
    const file = join(run.dir, "store", "run.sqlite");
    const st = await stat(file).catch(() => null);
    if (!st) return { rows: [], state: "idle", costUsd: null, title: "" };
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = stores.get(run.id);
    if (hit?.sig === sig) return hit;
    const { DatabaseSync } = await import("node:sqlite");
    const entries = [];
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const conversation = db.prepare("SELECT MIN(conversation_id) AS id FROM entries").get()?.id;
        if (conversation != null) for (const row of db.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id").iterate(conversation)) entries.push(JSON.parse(row.record));
      } finally {
        db.close();
      }
    } catch (cause) {
      throw new HttpError(500, `the store cannot be read: ${cause.message}`);
    }
    const rows = timelineOf(entries, { settled: true });
    const title = rows.find((r) => r.kind === "user_message")?.text ?? "";
    const value = { sig, rows, state: stateOf(rows, false), costUsd: costOf(rows), title: clip(title, 80) };
    stores.set(run.id, value);
    if (stores.size > 64) stores.delete(stores.keys().next().value);
    return value;
  }

  async function liveView(run) {
    if (["done", "failed"].includes(run.record?.status)) return null;
    const live = await readJson(join(run.dir, "live.json"));
    const url = typeof live?.liveViewUrl === "string" ? URL.parse(live.liveViewUrl) : null;
    // `key` changes only when the address does: the page reloads its frame on that, never on a rewrite of the file.
    return url && ["https:", "http:"].includes(url.protocol) ? { url: url.href, key: createHash("sha256").update(url.href).digest("hex").slice(0, 12) } : null;
  }

  async function summary(run) {
    const status = statusOf(run);
    const store = RELEASED.has(run.record?.status) ? await readStore(run).catch(() => null) : null;
    const dir = await stat(run.dir);
    const view = await liveView(run);
    const door = doorOf(run.record);
    const busy = door ? await fetch(new URL("/status", door), { signal: AbortSignal.timeout(800) }).then((r) => r.json()).then((s) => s.busy?.kind ?? null, () => null) : null;
    return {
      id: run.id,
      title: run.meta.title || store?.title || run.id,
      agent: run.meta.agent ?? null,
      status,
      state: store?.state ?? null,
      live: door !== undefined,
      busy,
      generation: run.record?.generation ?? 0,
      startedAt: run.meta.createdAt ?? new Date(dir.birthtimeMs || dir.mtimeMs).toISOString(),
      endedAt: RELEASED.has(run.record?.status) ? run.record.updatedAt : null,
      costUsd: store ? store.costUsd : null,
      wakeAt: run.record?.wakeAt ?? null,
      liveView: view ? { key: view.key } : null,
      error: startErrors.get(run.id) ?? null,
    };
  }

  async function listRuns() {
    const names = await readdir(root).catch(() => []);
    const all = await Promise.all(
      names.map(async (id) => {
        const run = await loadRun(id).catch(() => null);
        return run ? summary(run).catch(() => null) : null;
      }),
    );
    return all.filter(Boolean).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  // ---- starting, waking and talking to a run -----------------------------------------------------------------------
  function launch(id) {
    if (children.has(id)) return;
    const [command, ...args] = start;
    const child = spawn(command, [...args, join(root, id)], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    children.set(id, child);
    exits.delete(id);
    const ended = (code) => {
      if (children.get(id) === child) children.delete(id);
      exits.set(id, code ?? "signal");
    };
    child.once("exit", ended);
    child.once("error", () => ended("error"));
  }

  /** The door of run `id`, starting or waking the run (the start command, on its directory) when it is not live. */
  async function ensureLive(id, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    for (let launched = false; ; await sleep(250)) {
      const run = await loadRun(id);
      if (!run) throw new HttpError(404, "no such run");
      const door = doorOf(run.record);
      if (door) return door;
      if (["done", "failed"].includes(run.record?.status)) throw new HttpError(409, `the run is ${run.record.status}`);
      if (!children.has(id) && startable(run.record)) {
        if (launched && exits.has(id)) throw new HttpError(502, `the start command exited (${exits.get(id)})`);
        if (!start.length) throw new HttpError(501, "this server has no --start command, so it cannot wake a run");
        launch(id);
        launched = true;
      }
      if (Date.now() > deadline) throw new HttpError(504, "the run did not come up");
    }
  }

  async function toDoor(id, path, body) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const door = await ensureLive(id);
      const res = await fetch(new URL(path, door), {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const data = res ? await res.json().catch(() => null) : null;
      if (res && !(res.status === 503 && RETRY_CODES.includes(data?.error))) return { status: res.status, body: data };
      if (Date.now() > deadline) return { status: 502, body: { error: "NOT_SERVED", message: "the run's door did not answer" } };
      await sleep(300);
    }
  }

  async function submit(id, content) {
    if (typeof content !== "string" || !content.trim()) throw new HttpError(400, "content must be a non-empty string");
    const status = await toDoor(id, "/status");
    const whenBusy = status.body?.busy?.kind === "busy" ? "steer" : "followUp";
    return toDoor(id, "/submit", { requestId: randomUUID(), content, whenBusy });
  }

  async function createRun(content) {
    if (typeof content !== "string" || !content.trim()) throw new HttpError(400, "content must be a non-empty string");
    if (!start.length) throw new HttpError(501, "this server has no --start command, so it cannot start a run");
    const id = `r${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    await mkdir(join(root, id), { recursive: true, mode: 0o700 });
    await writeFile(join(root, id, "web.json"), JSON.stringify({ title: clip(content.trim().replace(/\s+/g, " "), 80), createdAt: new Date().toISOString(), ...(agentName ? { agent: agentName } : {}) }));
    launch(id);
    submit(id, content).then(
      (r) => r.status >= 400 && startErrors.set(id, r.body?.message ?? r.body?.error ?? "the first message was refused"),
      (e) => startErrors.set(id, e.message),
    );
    return id;
  }

  // ---- the live timeline -------------------------------------------------------------------------------------------
  async function liveTimeline(res, run) {
    const door = doorOf(run.record);
    if (!door) throw new HttpError(409, "the run is not live");
    const reducer = timelineReducer();
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-content-type-options": "nosniff" });
    const beat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    let working = false;
    let first = true;
    let shown = "";
    const push = (changed) => {
      const all = reducer.rows();
      const state = stateOf(all, working);
      const costUsd = costOf(all);
      if (first) write("rows", { reset: true, rows: all, state, costUsd });
      else if (changed.rows.length || changed.drop.length || state !== shown) write("rows", { set: changed.rows, drop: changed.drop, state, costUsd });
      first = false;
      shown = state;
    };
    try {
      const up = await fetch(new URL("/events", door), { signal: abort.signal, headers: { accept: "text/event-stream" } });
      if (!up.ok) throw new Error(`door answered ${up.status}`);
      for await (const { event, data } of frames(up.body)) {
        let events = [];
        if (event === "snapshot") {
          working = Boolean(data.run);
          events = [data];
        } else if (event === "events") {
          events = data;
          for (const ev of events) if (ev.type === "run_start" || ev.type === "run_end") working = ev.type === "run_start";
        } else if (event === "end") break;
        push(reducer.apply(events));
      }
      write("end", { reason: "ended" });
    } catch {
      if (!abort.signal.aborted) write("end", { reason: "door" });
    } finally {
      clearInterval(beat);
      res.end();
    }
  }

  // ---- files -------------------------------------------------------------------------------------------------------
  async function walk(base, dir = "", depth = 0, out = []) {
    for (const d of await readdir(join(base, dir), { withFileTypes: true }).catch(() => [])) {
      if (d.name.startsWith(".") || d.isSymbolicLink() || out.length >= 2000) continue;
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) depth < 8 && (await walk(base, rel, depth + 1, out));
      else if (d.isFile()) {
        const st = await stat(join(base, rel));
        out.push({ path: rel, size: st.size, mtime: st.mtimeMs });
      }
    }
    return out;
  }

  /** The file at `rel` under `work/`: no dot segments, no `..`, no symlink on the way, a regular file; else undefined. */
  async function resolveFile(run, rel) {
    const parts = rel.split("/");
    if (!rel || rel.includes("\0") || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) return undefined;
    let path = run.work;
    if (!(await lstat(path).catch(() => null))?.isDirectory()) return undefined;
    for (const part of parts) {
      path = join(path, part);
      const st = await lstat(path).catch(() => null);
      if (!st || st.isSymbolicLink()) return undefined;
    }
    const st = await lstat(path);
    return st.isFile() ? { path, size: st.size } : undefined;
  }

  async function serveFile(res, run, rel, download) {
    const file = await resolveFile(run, rel);
    if (!file) throw new HttpError(404, "no such file");
    const ext = extname(rel).slice(1).toLowerCase();
    const headers = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
    let end = file.size - 1;
    if (!download && (ext === "html" || ext === "htm")) Object.assign(headers, { "content-type": "text/html; charset=utf-8", "content-security-policy": FILE_CSP });
    else if (!download && TEXT_TYPES.has(ext)) {
      Object.assign(headers, { "content-type": "text/plain; charset=utf-8" });
      if (file.size > TEXT_CAP) Object.assign(headers, { "x-truncated": "1" }), (end = TEXT_CAP - 1);
    } else {
      const name = rel.split("/").at(-1).replace(/[^\w.-]/g, "_");
      Object.assign(headers, { "content-type": IMAGE_TYPES[ext] ?? "application/octet-stream", "content-disposition": `attachment; filename="${name}"` });
    }
    res.writeHead(200, { ...headers, "content-length": end + 1 });
    if (end < 0) return res.end();
    await pipeline(createReadStream(file.path, { start: 0, end }), res).catch(() => {});
  }

  // ---- search ------------------------------------------------------------------------------------------------------
  const snippet = (text, at, length) => `${at > 50 ? "…" : ""}${text.slice(Math.max(0, at - 50), at + length + 80).replace(/\s+/g, " ")}`;

  async function search(query) {
    const needle = query.toLowerCase();
    const found = [];
    const deadline = Date.now() + 2_500;
    for (const s of await listRuns()) {
      const run = await loadRun(s.id);
      if (!run || found.length >= 50 || Date.now() > deadline) break;
      if (s.title.toLowerCase().includes(needle)) found.push({ runId: s.id, title: s.title, kind: "run", snippet: s.title });
      let hits = 0;
      for (const f of await walk(run.work)) {
        if (hits >= 5 || Date.now() > deadline) break;
        if (f.path.toLowerCase().includes(needle)) found.push({ runId: s.id, title: s.title, kind: "file", path: f.path, snippet: f.path }), hits++;
        else if (TEXT_TYPES.has(extname(f.path).slice(1).toLowerCase()) && f.size <= SEARCH_FILE_CAP) {
          const text = await readFile(join(run.work, f.path), "utf8").catch(() => "");
          const at = text.toLowerCase().indexOf(needle);
          if (at >= 0) found.push({ runId: s.id, title: s.title, kind: "file", path: f.path, snippet: snippet(text, at, needle.length) }), hits++;
        }
      }
      if (RELEASED.has(run.record?.status)) {
        const store = await readStore(run).catch(() => null);
        for (const row of (store?.rows ?? []).filter((r) => ["user_message", "text_block", "final_answer"].includes(r.kind) && r.text).slice(0, 400)) {
          const at = row.text.toLowerCase().indexOf(needle);
          if (at >= 0 && hits < 8) found.push({ runId: s.id, title: s.title, kind: "transcript", snippet: snippet(row.text, at, needle.length) }), hits++;
        }
      }
    }
    return found.slice(0, 50);
  }

  // ---- routes ------------------------------------------------------------------------------------------------------
  async function route(req, res, url) {
    const path = url.pathname;
    if (req.method === "GET" && PAGE[path]) {
      const [file, type] = PAGE[path];
      return send(res, 200, await readFile(join(HERE, "page", file), "utf8"), { "content-type": type, ...(path === "/" ? { "content-security-policy": APP_CSP } : {}) });
    }
    if (req.method === "GET" && MODULE.test(path)) return send(res, 200, await readFile(join(HERE, path), "utf8"), { "content-type": "text/javascript; charset=utf-8" });
    if (req.method === "GET" && path === "/runs") return send(res, 200, { runs: await listRuns(), canStart: start.length > 0 });
    if (req.method === "POST" && path === "/runs") return send(res, 202, { id: await createRun((await bodyOf(req)).content) });
    if (req.method === "GET" && path === "/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      return send(res, 200, { results: q.length >= 2 && q.length <= 200 ? await search(q) : [] });
    }
    const m = /^\/runs\/([^/]+)(?:\/([a-z]+)(?:\/(.+))?)?$/.exec(path);
    if (!m) throw new HttpError(404, "no such route");
    const run = await loadRun(m[1]);
    if (!run) throw new HttpError(404, "no such run");
    const part = m[2] ?? "";
    if (req.method === "GET") {
      switch (part) {
        case "":
          return send(res, 200, await summary(run));
        case "timeline": {
          if (String(req.headers.accept).includes("text/event-stream")) return liveTimeline(res, run);
          const { rows, state, costUsd } = await readStore(run);
          return send(res, 200, { rows, state, costUsd });
        }
        case "files": {
          if (m[3] === undefined) return send(res, 200, { files: (await walk(run.work)).sort((a, b) => a.path.localeCompare(b.path)) });
          let rel;
          try {
            rel = m[3].split("/").map(decodeURIComponent).join("/");
          } catch {
            throw new HttpError(404, "no such file");
          }
          return serveFile(res, run, rel, url.searchParams.get("download") === "1");
        }
        case "live": {
          const view = await liveView(run);
          if (!view) throw new HttpError(404, "no live view");
          return send(res, 302, "", { location: view.url, "referrer-policy": "no-referrer" });
        }
      }
    } else if (req.method === "POST") {
      if (part === "messages") {
        const result = await submit(run.id, (await bodyOf(req)).content);
        return send(res, result.status, result.body ?? {});
      }
      if (part === "stop") {
        if (!doorOf(run.record)) return send(res, 200, { result: "not running" });
        const result = await toDoor(run.id, "/abort", {});
        return send(res, result.status, result.body ?? {});
      }
    }
    throw new HttpError(404, "no such route");
  }

  let names;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://app");
    if (names && !names.has((req.headers.host ?? "").toLowerCase())) return send(res, 403, { error: "FORBIDDEN", message: "unexpected Host header" });
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}`) || !String(req.headers["content-type"]).startsWith("application/json")) return send(res, 403, { error: "FORBIDDEN", message: "cross-origin or non-JSON request" });
    }
    route(req, res, url).catch((error) => {
      if (res.headersSent) return void res.end();
      const status = error instanceof HttpError ? error.status : 500;
      send(res, status, { error: status === 500 ? "FAILED" : "REFUSED", message: error.message });
    });
  });
  await new Promise((resolve, reject) => (server.once("error", reject), server.listen(port, host, resolve)));
  const address = server.address();
  if (isLoopback(host)) names = new Set(["localhost", "127.0.0.1", "[::1]", host, ...allowHosts].map((h) => `${h.toLowerCase()}:${address.port}`));

  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    port: address.port,
    children,
    async close() {
      const live = [...children.values()];
      for (const child of live) {
        child.kill("SIGTERM");
        // A run mid-turn drains and releases its paid browser first; SIGKILL only if that takes far longer.
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 45_000).unref();
      }
      await Promise.all(live.map((child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)))));
      await new Promise((resolve) => (server.close(resolve), server.closeAllConnections()));
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: join(HERE, ".data", "runs") },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      start: { type: "string", default: process.env.AGENT_RUN_LAUNCHER ?? "" },
      "allow-host": { type: "string", multiple: true, default: [] },
    },
  });
  const runs = resolve(values.runs);
  await mkdir(runs, { recursive: true });
  const launcher = join(HERE, "agent", "start-run.mjs");
  const start = values.start.trim() ? values.start.split(/\s+/).filter(Boolean) : existsSync(launcher) ? [process.execPath, launcher] : [];
  const agentName = process.env.AGENT_NAME ?? (await readJson(join(HERE, "agent", "agent.json")))?.name ?? "";
  const server = await startServer({ runs, host: values.host, port: Number(values.port), start, allowHosts: values["allow-host"], agentName });
  if (!isLoopback(values.host)) console.error(`warning: ${values.host} is not loopback. This server has no sign-in: anyone who can reach it can read the runs' files and start agents.`);
  console.log(`runs app on ${server.url}/ (runs in ${runs})`);
  const stop = () => server.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
