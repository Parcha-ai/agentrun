// Fakes for the runs app's tests: pi-shaped entries, a fake door (a local HTTP server that answers like a run's
// `serveRun`: SSE events, status, submit, abort), and runs of a real agent home with run.json, a tiny store and work files.
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startRun } from "@parcha/pi-durable-agent";

const cost = (total) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total } });
export const user = (id, text) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });
export const assistant = (id, content, stopReason = content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", extra = {}) => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [{ role: "assistant", content, stopReason, usage: cost(0.01), timestamp: id, ...extra }],
});
export const result = (id, callId, tool, text, isError = false, details = undefined) => ({
  id,
  conversationId: 1,
  kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId: callId, toolName: tool, isError, content: [{ type: "text", text }], ...(details === undefined ? {} : { details }), timestamp: id }],
});
export const text = (value) => ({ type: "text", text: value });
export const thinking = (value) => ({ type: "thinking", thinking: value });
export const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

/**
 * A run that opens a site, finds a sign-in form and asks the person (request_sign_in ends the run: entries 1 to 8), then,
 * after "done", saves a note and answers (entries 9 to 12).
 */
export const transcript = [
  user(1, "Log in to https://the-internet.herokuapp.com/login and write what the secure page says to notes.md"),
  assistant(2, [thinking("Open the secure page first."), text("Opening the page."), call("c1", "run", { code: 'await page.goto("https://the-internet.herokuapp.com/secure")' })]),
  result(3, "c1", "run", "Navigated to https://the-internet.herokuapp.com/login"),
  assistant(4, [thinking("It sent me to a sign-in form."), call("c2", "snapshot", {}), call("c3", "screenshot", {})]),
  result(5, "c2", "snapshot", "[1-4] textbox username"),
  result(6, "c3", "screenshot", "[image]"),
  assistant(7, [text("The site needs a sign-in."), call("c4", "request_sign_in", { site: "the-internet.herokuapp.com", reason: "Sign in to the practice site to read its secure area" })]),
  result(8, "c4", "request_sign_in", "Asked the person to sign in to the-internet.herokuapp.com in the live view; waiting for them to reply done."),
  user(9, "done"),
  assistant(10, [thinking("Signed in. Save the page text."), call("c5", "write", { path: "notes.md", content: "# Notes\n\nSigned in." })]),
  result(11, "c5", "write", "Wrote notes.md"),
  assistant(12, [text("I saved **notes.md**.")]),
];

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * A fake door. `/events` sends a snapshot of `snapshot` entries, then each of `batches` (arrays of agent events) `gapMs`
 * apart, then an `end` unless `hold` keeps it open. `busy` is what `/status` reports; `answer` is added to each `/submit`
 * reply, as the real door does once a submission is done.
 */
export async function fakeDoor({ snapshot = [], batches = [], gapMs = 20, hold = false, busy = false, run = false, answer } = {}) {
  const door = { submits: [], aborts: [], busy, paths: [] };
  const server = createServer((req, res) => {
    door.paths.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url.startsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("snapshot", { type: "snapshot", entries: snapshot, tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...(run ? { run: { inputs: [1] } } : {}) }));
      let i = 0;
      const timer = setInterval(() => {
        if (i < batches.length) return void res.write(sse("events", batches[i++]));
        clearInterval(timer);
        if (!hold) {
          res.write(sse("end", { reason: "closed" }));
          res.end();
        }
      }, gapMs);
      res.once("close", () => clearInterval(timer));
    } else if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ run: "r", generation: 1, status: "running", busy: { kind: door.busy ? "busy" : "idle" } }));
    } else if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => {
        (req.url === "/submit" ? door.submits : door.aborts).push(JSON.parse(body || "{}"));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ run: "r", generation: 1, submission: { id: 1, status: "queued" }, ...(answer === undefined ? {} : { answer }) }));
      });
    } else res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(door, {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())),
  });
}

/**
 * Start run `id` of the agent home (`startRun`: the runs index, the run directory, its store and work/), then write its
 * run.json, optionally a tiny store of `entries` in place of pi's, files under work/, and web.json/live.json.
 */
export async function makeRun(home, id, { status = "done", door, entries, files = {}, meta, live, generation = 1, updatedAt = new Date().toISOString(), wakeAt = null } = {}) {
  const { dir } = await startRun(home, { runId: id, host: "test", ...(meta?.createdAt ? { now: Date.parse(meta.createdAt) } : {}) });
  const now = new Date().toISOString();
  const record = {
    run: id,
    status,
    generation,
    sealedSeq: status === "running" ? null : 1,
    wakeAt,
    holder: status === "running" ? { driver: "local", host: "box", bootId: null, pid: process.pid, since: now, ...(door ? { serve: door } : {}) } : null,
    heartbeatAt: status === "running" ? now : null,
    updatedAt,
    detail: null,
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(record));
  if (entries) {
    rmSync(join(dir, "store"), { recursive: true });
    mkdirSync(join(dir, "store"));
    const db = new DatabaseSync(join(dir, "store", "run.sqlite"));
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record))) STRICT");
    const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, ?, ?)");
    for (const entry of entries) insert.run(entry.id, entry.conversationId, entry.id, JSON.stringify(entry));
    db.close();
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "work", path)), { recursive: true });
    writeFileSync(join(dir, "work", path), content);
  }
  if (meta) writeFileSync(join(dir, "web.json"), JSON.stringify(meta));
  if (live) {
    writeFileSync(join(dir, "live.json"), JSON.stringify({ liveViewUrl: live, sessionId: "s1", updatedAt: now }));
    chmodSync(join(dir, "live.json"), 0o600);
  }
  return dir;
}

/** Refresh a running run's heartbeat, as the instance does every few seconds. */
export function beat(dir) {
  const path = join(dir, "run.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, heartbeatAt: new Date().toISOString() }));
}

export const link = (target, path) => symlinkSync(target, path);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".png": "image/png" };

/**
 * A static host for a directory, as a replay's host would be: the files under `dir` at `<prefix>`, and nothing else, with
 * no headers of its own (no CSP, no sandbox). `requests` lists the paths asked for.
 */
export async function serveStatic(dir, prefix = "/") {
  const requests = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://static").pathname);
    requests.push(path);
    const rel = path.startsWith(prefix) ? path.slice(prefix.length) || "index.html" : null;
    const file = rel === null || rel.split("/").includes("..") ? null : join(dir, rel.endsWith("/") ? `${rel}index.html` : rel);
    let body;
    try {
      body = file && readFileSync(file);
    } catch {}
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, requests, close: () => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())) };
}
