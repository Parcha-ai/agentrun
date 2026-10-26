// A server on a fresh data directory with the faux model, and a client for its /v2 routes. No key, no network.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  return async function api(method, path, body, headers = {}) {
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

/** One request with every header the caller names, Host, Origin and Cookie included (fetch sets or drops those itself); a
 *  header given as undefined is not sent, and `from` is the local address it leaves from. */
export function call(port, { method = "GET", path = "/", headers = {}, body, from } = {}) {
  const sent = Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, ...headers }).filter(([, value]) => value !== undefined));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: sent, ...(from ? { localAddress: from } : {}) }, (res) => {
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

/** The keys of the contract's answers and of the revision list as they were before accounts: accounts add none. */
export const SHAPES = {
  agentList: ["agents", "next_cursor"],
  agent: ["agent_id", "definition", "kind", "revision", "revisions", "source", "skills", "sign_ins", "runs", "region", "home_etag", "archived_at", "created_at", "updated_at"],
  runList: ["runs", "next_cursor"],
  runSummary: ["run_id", "agent_id", "agent_version", "revision", "kind", "sha", "status", "state", "title", "created_at", "ended_at", "error", "cost", "archived_at"],
  run: ["run_id", "agent_id", "agent_version", "revision", "kind", "sha", "status", "state", "title", "created_at", "updated_at", "ended_at", "result", "error", "cost", "archived_at", "poll_after_ms"],
  revision: ["revision", "version", "parent", "kind", "current", "note", "created_at", "definition"],
  features: ["agents", "archive", "home", "runs", "messages", "timeline", "files", "quotes", "usage", "efforts", "thinking", "browser", "sign_ins", "vault", "query"],
};

/** The same keys read from a server through `api`, over agent `agentId` and its run `runId`. */
export async function shapesOf(api, agentId, runId) {
  const agents = (await api("GET", "/agents")).body;
  const runs = (await api("GET", "/runs")).body;
  return {
    agentList: Object.keys(agents),
    agent: Object.keys((await api("GET", `/agents/${agentId}`)).body),
    runList: Object.keys(runs),
    runSummary: Object.keys(runs.runs[0]),
    run: Object.keys((await api("GET", `/runs/${runId}`)).body),
    revision: Object.keys((await api("GET", `/agents/${agentId}/revisions`)).body.revisions[0]),
    features: Object.keys((await api("GET", "/capabilities")).body.features),
  };
}

/** The owner every accounts test sets up. */
export const OWNER = { name: "Ana", email: "ana@example.com", password: "correct horse battery" };

/** The `name=value` pairs a response's Set-Cookie lines set, as one Cookie header. */
export const cookieOf = (res) => (res.headers["set-cookie"] ?? []).map((line) => line.split(";")[0]).join("; ");

/** A server with accounts on (loopback, so its address is http://127.0.0.1:<port>) whose owner was set up with the
 *  printed code: the owner, their session cookie, and the origin a write must come from. */
export async function withOwner(t, options = {}) {
  const server = await serve(t, { accounts: true, ...options });
  const origin = `http://127.0.0.1:${server.port}`;
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { code, ...OWNER } });
  assert.equal(made.status, 201, made.text);
  return { ...server, origin, owner: made.json, cookie: cookieOf(made) };
}

/** Signs `email` in through the library's endpoint from the server's own origin: the answer and its session cookie. */
export async function signIn(server, email, password, extra = {}) {
  const res = await call(server.port, { method: "POST", path: "/v2/auth/sign-in/email", headers: { "content-type": "application/json", origin: server.origin }, body: { email, password, ...extra } });
  return { res, cookie: cookieOf(res) };
}

/** `method path` as the person whose session `cookie` is, from the server's own origin, with a JSON body. */
export const asPerson = (server, cookie) => (method, path, body) =>
  call(server.port, { method, path: `/v2${path}`, headers: { cookie, ...(method === "GET" || method === "HEAD" ? {} : { origin: server.origin, "content-type": "application/json" }) }, body: method === "GET" || method === "HEAD" ? undefined : (body ?? {}) });

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
    const { status, body: page } = await api("GET", `/runs/${runId}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "2000" })}`);
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
