// A server on a fresh data directory with the faux model, and a client for its /v2 routes. No key, no network.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";

export const FAUX = new URL("./fixtures/faux-model.mjs", import.meta.url).pathname;

export async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
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

/** A server for test `t`, stopped after it, before its scratch directory goes. */
export async function serve(t, options = {}) {
  const dir = options.data ? undefined : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-"));
  const data = options.data ?? join(dir, "agents");
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

/** Apply timeline pages from `after` the way a client must (drop, then upsert), until the run's status is in `until` and settled. */
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
    const settled = ["completed", "failed", "cancelled"].includes(page.status) ? page.final : !page.has_more && (page.unchanged || page.rows.length === 0);
    if (until.includes(page.status) && settled) break;
    assert.ok(Date.now() < end, `the run did not reach ${until.join("|")}: last ${page.status}/${page.state}`);
  }
  const rows = [...view.values()].sort((a, b) => a.seq - b.seq);
  return { rows, pages, after, last: pages.at(-1) };
}

/** An OpenAI Responses endpoint on loopback: every turn answers `text` and reports `tokens` input and output tokens.
 *  `asked` lists every request's method and path, `bodies` each POST's JSON body, `models` the model each asked for. */
export async function responsesEndpoint(t, text, tokens) {
  const asked = [];
  const bodies = [];
  const models = [];
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      if (req.method === "POST") models.push(bodies.at(-1)?.model);
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: tokens, output_tokens: tokens, total_tokens: 2 * tokens } } },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, bodies, models };
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
