// A server on a fresh data directory with the faux model, and a client for its /v2 routes. No key, no network.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeAgentExecutable } from "@parcha/agentrun-harness-claude";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";

export const FAUX = new URL("./fixtures/faux-model.mjs", import.meta.url).pathname;

// No test reaches a box provider: the boxes the environment running the suite lists are not the tests'. A server here,
// or one a test starts in a process of its own, probes none, Docker included (on by default when AGENTRUN_BOXES is not
// set, boxes.ts): a test that wants a box lists it itself, with its endpoint on loopback (boxes.test.mjs), or unsets the
// setting over a fake docker (docker-by-default.test.mjs).
process.env.AGENTRUN_BOXES = "none";

/** The records of a log another process appends to (a line of JSON each, as the fake docker's): only its whole lines,
 *  each ended by its newline. A file just made and still empty, or a last line still being written, is read as the
 *  records before it, never parsed half. None when there is no file. */
export function jsonLines(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  // Retried: a server that is still closing can write into it during the rm (ENOTEMPTY).
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** Resolves once `child`, a server in a process of its own, has printed a whole line on stdout that `ready` matches (the
 *  line it prints once it listens); rejects as soon as it exits or cannot be spawned, with what it printed. A slow start
 *  on a loaded machine is still a start: the backstop is only for a child that neither prints the line nor exits. */
export function printed(child, ready, { backstopMs = 120_000 } = {}) {
  let out = "";
  let err = "";
  return new Promise((resolve, reject) => {
    const settle = (error) => {
      clearTimeout(backstop);
      child.stdout.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("close", onClose);
      child.off("error", settle);
      if (error) reject(error);
      else resolve(out);
    };
    const onOut = (chunk) => {
      out += chunk;
      if (ready.test(out.slice(0, out.lastIndexOf("\n") + 1))) settle();
    };
    const onErr = (chunk) => (err = (err + chunk).slice(-8_000));
    // "close", not "exit": by then its stdout and stderr are read to their end, so its last words are in the message.
    const onClose = (code, signal) => settle(new Error(`the server exited (${signal ?? code}) before it printed ${ready}: ${out}${err}`));
    const backstop = setTimeout(() => settle(new Error(`the server printed no ${ready} in ${backstopMs / 1000} s and has not exited: ${out}${err}`)), backstopMs);
    backstop.unref();
    child.stdout.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.once("close", onClose);
    child.once("error", settle);
  });
}

/** The index.html of a built console, as Vite writes it: one module script and one stylesheet, both relative. */
export const CONSOLE_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>AgentRun</title>
<script type="module" crossorigin src="./assets/index-Ab12Cd34.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-Ef56Gh78.css"></head>
<body><div id="root"></div></body></html>
`;

/** A built console for test `t` (`startServe({ console })`): CONSOLE_INDEX and its assets, in `<scratch>/console`. */
export async function builtConsole(t) {
  const dir = await scratch(t);
  const root = join(dir, "console");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), CONSOLE_INDEX);
  await writeFile(join(root, "assets", "index-Ab12Cd34.js"), "document.getElementById('root').textContent = 'console';\n");
  await writeFile(join(root, "assets", "index-Ef56Gh78.css"), "body { margin: 0; }\n");
  await writeFile(join(root, "assets", "mono-latin-400-normal-Ij90Kl12.woff2"), Buffer.from("wOF2"));
  return root;
}

/** The packages a first use installs into `<data>/harnesses` (claude-sdk.ts), linked there from this repository's own
 *  (the Claude Agent SDK, a dev dependency, its CLI's platform package and the MCP library), so a server on `data` runs
 *  claude-agent as one whose Claude Code is installed, with no npm. `cli`: the file its platform package holds as the
 *  CLI instead (one off its pins, or a path where nothing is). Nothing when the pinned CLI is not here. */
export async function linkClaudeSdk(data, { cli } = {}) {
  const pinned = claudeAgentExecutable();
  if (!pinned) return;
  const from = fileURLToPath(new URL("../../../node_modules/", import.meta.url));
  const to = join(data, "harnesses", "node_modules");
  const platform = `@anthropic-ai/${basename(dirname(pinned))}`;
  const link = (target, path) => symlink(target, path).catch((error) => (error.code === "EEXIST" ? undefined : Promise.reject(error)));
  for (const name of ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk", ...(cli ? [] : [platform])]) {
    await mkdir(dirname(join(to, name)), { recursive: true });
    await link(join(from, name), join(to, name));
  }
  if (cli) {
    await mkdir(join(to, platform), { recursive: true });
    await writeFile(join(to, platform, "package.json"), readFileSync(join(from, platform, "package.json")));
    await link(cli, join(to, platform, basename(pinned)));
  }
}

/** A data directory for test `t` holding Claude Code as a first use installs it (linkClaudeSdk), for a test that makes
 *  claude-agent's adapter itself (adapters.ts claudeOf, which loads the SDK from the data its env names). */
export async function claudeData(t) {
  const data = await scratch(t);
  await linkClaudeSdk(data);
  return data;
}

/** A server for test `t`, stopped after it, before its scratch directory goes. On the real models (`faux: undefined`) its
 *  data holds Claude Code as a first use installs it (linkClaudeSdk; `claudeSdk: { cli }` with that CLI); `claudeSdk`
 *  says so for any server, `false` for none. */
export async function serve(t, { claudeSdk: asked, ...options } = {}) {
  const claudeSdk = asked ?? (Object.hasOwn(options, "faux") && options.faux === undefined);
  const dir = options.data ? undefined : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  const data = options.data ?? join(dir, "agents");
  if (claudeSdk) await linkClaudeSdk(data, claudeSdk === true ? {} : claudeSdk);
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", ...options });
  t.after(async () => {
    await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  return { ...server, data, api: client(server.baseUrl, server.token) };
}

export function client(baseUrl, token) {
  /** A request on a connection of its own, which nothing reuses: a pooled socket the server closes is not its failure. */
  const fresh = (method, path) =>
    new Promise((resolve, reject) => {
      const req = request(`${baseUrl}${path}`, { method, agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk) => (text += chunk)).on("end", () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([name, value]) => [name, String(value)])), body: json ?? text });
        });
      });
      req.once("error", reject).end();
    });
  return Object.assign(api, { fresh });
  async function api(method, path, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: json ?? text };
  };
}

export const agent = (id, extra = {}) => ({ definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], tools: [], ...extra } });

/** A workflow of one model node: `answer` extracts `{answer: number}` from the input's `question`. */
export const answerFlow = (instructions = "Answer the question.") => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions, out: "Answer", as: "answer" }] },
});

/** A workflow agent `id`: its definition carries `workflow` in place of instructions. */
export const flowAgent = (id, workflow = answerFlow(), extra = {}) => ({ definition: { id, name: id, workflow, ...extra } });

/** The store's row for run `runId`, read from the data directory. */
export function storeRun(data, runId) {
  const reader = openStoreReader(data);
  try {
    return reader.readRun(runId);
  } finally {
    reader.close();
  }
}

/** Create agent `id` and start one run of it with `content`. */
export async function startRun(api, id, content, extra = {}, skills) {
  assert.equal((await api("POST", "/agents", { ...agent(id, extra), ...(skills ? { skills } : {}) })).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
}

/** Apply timeline pages from `after` the way a client must (drop, then upsert), until the run's status is in `until`: an end
 *  once its page is final, any other status on the first page that leaves no change behind it. */
export async function follow(api, runId, until, { after = 0, deadlineMs = 30_000 } = {}) {
  const view = new Map();
  const pages = [];
  const end = Date.now() + deadlineMs;
  for (;;) {
    // Each long poll on a connection of its own: a loaded machine's pooled socket closing under it is not the run's state.
    const { status, body: page } = await (api.fresh ?? api)("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "2000" })}`);
    assert.equal(status, 200, JSON.stringify(page));
    pages.push(page);
    if (page.reset) view.clear();
    for (const id of page.drop) view.delete(id);
    for (const row of page.rows) view.set(row.id, row);
    after = page.next_after;
    // A page's status and its rows are read together, so a page with no more to come has every row up to that status. A
    // second, empty page to confirm it would only return when its long poll runs out.
    const settled = ["completed", "failed", "cancelled"].includes(page.status) ? page.final : !page.has_more;
    if (until.includes(page.status) && settled) break;
    assert.ok(Date.now() < end, `the run did not reach ${until.join("|")}: last ${page.status}/${page.state}`);
  }
  const rows = [...view.values()].sort((a, b) => a.seq - b.seq);
  return { rows, pages, after, last: pages.at(-1) };
}

/** An OpenAI Responses endpoint on loopback: every turn answers `text` and reports `tokens` input and output tokens.
 *  `asked` lists every request's method and path, `bodies` each POST's JSON body, `models` the model each asked for,
 *  `authorizations` each POST's authorization header.
 *  `incomplete`: each answer stops at its length instead (response.incomplete, max_output_tokens: pi's stopReason "length"). */
export async function responsesEndpoint(t, text, tokens, { incomplete = false } = {}) {
  const asked = [];
  const bodies = [];
  const models = [];
  const authorizations = [];
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (req.method === "POST") authorizations.push(req.headers.authorization ?? null);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      if (req.method === "POST") models.push(bodies.at(-1)?.model);
      const item = { type: "message", id: "msg_1", role: "assistant", status: incomplete ? "incomplete" : "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const usage = { input_tokens: tokens, output_tokens: tokens, total_tokens: 2 * tokens };
      const end = incomplete
        ? { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [item], usage } }
        : { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        end,
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, bodies, models, authorizations };
}

/** Sets `vars` in this process's environment, which a server's runs inherit, for test `t`; the rest of `names` unset. */
export function withEnv(t, vars, names = Object.keys(vars)) {
  const all = [...new Set([...names, ...Object.keys(vars)])];
  const saved = Object.fromEntries(all.map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  for (const name of all) delete process.env[name];
  Object.assign(process.env, vars);
}

/** One raw request to the server on `port` (Host 127.0.0.1:port unless given): status, headers, text and parsed JSON. */
export function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  const sent = Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, ...headers }).filter(([, value]) => value !== undefined));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: sent }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** The Cookie header for the cookies an answer set. */
export const cookieOf = (res) => (res.headers["set-cookie"] ?? []).map((line) => line.split(";")[0]).join("; ");

/** Once the process that held run `runId` (its run.json's holder) has exited: only then is the run's store free to read.
 *  A paused run's process marks the run released itself (sleeping) before it closes its store and exits, so run.json's
 *  status is not that signal; the process gone is, as it is for the server (runs.ts, a run no longer live). */
export async function letGo(data, runId, { deadlineMs = 20_000 } = {}) {
  const file = join(data, "runs", runId, "run.json");
  for (const end = Date.now() + deadlineMs; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
    let record = null;
    try {
      record = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    } catch {
      // Read while it was rewritten: read again.
    }
    const pid = record?.holder?.pid;
    if (Number.isInteger(pid) && !processAlive(pid)) return;
    assert.ok(Date.now() < end, `the run's process did not exit: ${JSON.stringify(record)}`);
  }
}
