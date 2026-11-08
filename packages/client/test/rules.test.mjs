// The rules every client of the server keeps, against loopback listeners that play a hostile server: the key goes only to
// its own origin, never into a message; a key or an argument that would be wrong on the wire is refused before any
// request; a secret body's values are cut from the answer as JSON values; only what may be tried again is; a wait ends
// by its timeout; a dropped stream resumes where it left off; a download comes back byte for byte.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";
import { inspect } from "node:util";
import { AgentRun, AgentRunAuthError, AgentRunError, AgentRunRefused, AgentRunTimeout, AgentRunUnreachable, AgentRunUnsupported, AgentRunUsage } from "../dist/index.js";
import { JSON_HEADERS, listener } from "./helpers.mjs";
import { scrubberOf, secretsOf } from "../dist/scrub.js";

const KEY = `test-key-${randomBytes(12).toString("hex")}`;
const json = (status, value, headers = {}) => [status, { ...JSON_HEADERS, ...headers }, JSON.stringify(value)];
/** Everything a caller could print of an error. */
const printed = (error) => [error.message, String(error), inspect(error, { depth: 8 }), JSON.stringify(error)].join("\n");
const thrown = (promise) => promise.then(() => assert.fail("it resolved"), (error) => error);
const thrownSync = (fn) => { try { fn(); } catch (error) { return error; } assert.fail("it did not throw"); };

test("a redirect to another origin is not followed, so the key stays home; a GET redirect within the origin is followed with it", async (t) => {
  const elsewhere = await listener(t);
  const home = await listener(t, (req) => {
    if (req.url === "/v2/agents") return [302, { location: `${elsewhere.base}/agents` }, ""];
    if (req.url === "/v2/runs") return [307, { location: `${home.prefix}/v2/runs-moved` }, ""];
    if (req.url === "/v2/runs-moved") return json(200, { runs: [], next_cursor: null });
    if (req.url === "/v2/runs/r1/messages") return [307, { location: `${home.prefix}/v2/runs/r2/messages` }, ""];
    return json(404, { error: { code: "not_found" } });
  });
  const client = new AgentRun({ baseUrl: home.base, apiKey: KEY });
  const away = await thrown(client.agents.list());
  assert.ok(away instanceof AgentRunRefused);
  assert.deepEqual([away.status, away.code], [302, "redirect"]);
  assert.match(away.message, /another origin/);
  assert.equal(elsewhere.requests.length, 0, "nothing went to the other origin");

  assert.deepEqual(await client.runs.list(), { runs: [], next_cursor: null });
  assert.deepEqual(home.requests.slice(1).map((r) => [r.url, r.headers.authorization]), [["/v2/runs", `Bearer ${KEY}`], ["/v2/runs-moved", `Bearer ${KEY}`]]);
  const posted = await thrown(client.runs.message("r1", { content: "hi" }));
  assert.deepEqual([posted.status, posted.code], [307, "redirect"], "a POST is never redirected, even home");
  assert.equal(home.requests.at(-1).url, "/v2/runs/r1/messages");
  for (const error of [away, posted]) assert.ok(!printed(error).includes(KEY));
});

test("an error body that echoes the key never reaches a message, and the error object keeps its shape with the key cut", async (t) => {
  const server = await listener(t, (req) => {
    if (req.url === "/v2/agents") return json(400, { error: { code: "bad_request", message: `Bad key ${KEY}`, retryable: false, details: { [KEY]: [KEY, encodeURIComponent(KEY)] } } });
    if (req.url === "/v2/agents/a") return [401, { "content-type": "text/plain" }, `no such key: ${KEY}`];
    if (req.url === "/v2/runs") return [500, { "content-type": "text/html" }, `<p>${KEY}</p>`];
    return json(403, { error: { code: "forbidden", message: KEY } });
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY, maxRetries: 0 });
  const bad = await thrown(client.agents.list());
  assert.ok(bad instanceof AgentRunRefused && bad instanceof AgentRunError);
  assert.deepEqual([bad.kind, bad.status, bad.code], ["refused", 400, "bad_request"]);
  assert.deepEqual(bad.error, { code: "bad_request", message: "Bad key [hidden]", retryable: false, details: { "[hidden]": ["[hidden]", "[hidden]"] } });
  const unauthenticated = await thrown(client.agents.get("a"));
  assert.ok(unauthenticated instanceof AgentRunAuthError);
  assert.deepEqual([unauthenticated.reason, unauthenticated.status, unauthenticated.error], ["refused", 401, undefined], "a text body is never read into the error");
  const failed = await thrown(client.runs.list());
  assert.deepEqual([failed.status, failed.code, failed.error], [500, undefined, undefined]);
  const forbidden = await thrown(client.agents.archive("a"));
  assert.deepEqual([forbidden.kind, forbidden.reason, forbidden.code], ["auth", "refused", "forbidden"]);
  for (const error of [bad, unauthenticated, failed, forbidden]) assert.ok(!printed(error).includes(KEY), printed(error));
  assert.ok(!inspect(client, { depth: 8 }).includes(KEY) && !JSON.stringify(client).includes(KEY), "nor does the printed client");
});

test("a key that is not a valid header value, a missing key and a base URL that would carry it elsewhere are refused before any request", async (t) => {
  const server = await listener(t);
  for (const apiKey of [`${KEY}\nX-Other: 1`, `${KEY} `, "a\tb", "ключ", "a\x7f"]) {
    const error = thrownSync(() => new AgentRun({ baseUrl: server.base, apiKey }));
    assert.ok(error instanceof AgentRunAuthError, apiKey);
    assert.equal(error.reason, "bad_header");
    assert.ok(!printed(error).includes(apiKey));
  }
  const saved = { base: process.env.AGENTRUN_BASE_URL, key: process.env.AGENTRUN_API_KEY };
  t.after(() => {
    for (const [name, value] of [["AGENTRUN_BASE_URL", saved.base], ["AGENTRUN_API_KEY", saved.key]]) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  delete process.env.AGENTRUN_API_KEY;
  process.env.AGENTRUN_BASE_URL = server.base;
  assert.equal(thrownSync(() => new AgentRun()).reason, "no_token");
  assert.equal(thrownSync(() => new AgentRun({ apiKey: "" })).reason, "no_token");
  process.env.AGENTRUN_API_KEY = KEY;
  const fromEnv = new AgentRun();
  assert.equal(fromEnv.baseUrl, server.base, "the environment's server and key");
  for (const baseUrl of [`${server.base}?x=1`, `${server.base}#x`, Object.assign(new URL(server.base), { username: "user", password: KEY }).href, "ftp://example.com/v2", "not a url"]) {
    const error = thrownSync(() => new AgentRun({ baseUrl, apiKey: KEY }));
    assert.ok(error instanceof AgentRunUsage, baseUrl);
    assert.ok(!error.message.includes(baseUrl) && !printed(error).includes(KEY));
  }
  delete process.env.AGENTRUN_BASE_URL;
  assert.ok(thrownSync(() => new AgentRun({ apiKey: KEY })) instanceof AgentRunUsage, "no server");
  assert.equal(server.requests.length, 0, "nothing was sent");
  await fromEnv.agents.list();
  assert.equal(server.requests[0].headers.authorization, `Bearer ${KEY}`);
});

test("a path argument is encoded whole, a file path keeps its slashes, and one that would read as another route is refused before any request", async (t) => {
  const server = await listener(t, (req) => (/\/files\//.test(req.url) && !req.url.includes("learning") ? [200, { "content-type": "application/octet-stream" }, "x"] : json(200, {})));
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const refused = [
    () => client.runs.get(".."), () => client.runs.get("."), () => client.runs.get(""), () => client.runs.get("%2e%2E"), () => client.runs.get("a/../b"),
    () => client.learning.read("a", ".."), () => client.learning.read("a", "x/./y"),
    ...["a/%2e%2e/b", "%2e", "a%2Fb", "a/../b", "./b", "a//b", "a/", "/a"].flatMap((path) => [() => client.runs.readFile("r1", path), () => client.home.read("a", path)]),
    () => client.runs.start("a", { input: {} }, { "Idempotency-Key": "a\r\nX-Other: 1" }),
  ];
  for (const call of refused) {
    const error = await thrown(call());
    assert.ok(error instanceof AgentRunUsage, `${call}: ${error}`);
  }
  assert.equal(server.requests.length, 0, "nothing was sent");
  await client.learning.read("a", "skills/find-policies/SKILL.md");
  await client.home.read("a", "notes/a b.md");
  await client.runs.get("a b/c?d#e");
  assert.deepEqual(server.requests.map((r) => r.url), ["/v2/agents/a/learning/files/skills%2Ffind-policies%2FSKILL.md", ["", "v2", "agents", "a", "home", "files", "notes", "a%20b.md"].join("/"), "/v2/runs/a%20b%2Fc%3Fd%23e"]);
});

test("a secret body's values are cut from the answer as JSON values, its structure and public fields kept, and a refusal keeps only its code", async (t) => {
  const secret = `s3cr"et/${randomBytes(8).toString("hex")} x`;
  const header = `h-${randomBytes(8).toString("hex")}`;
  const server = await listener(t, (req) => {
    const body = JSON.parse(req.body.toString("utf8"));
    if (req.url === "/v2/settings/mcp-servers/refused") return json(422, { error: { code: "input_invalid", message: `bad token ${secret}`, fields: [{ field: "auth.token", value: secret }] } });
    return json(200, { name: "docs", url: body.url, auth: body.auth, echo: `token ${JSON.stringify(secret).slice(1, -1)} and ${encodeURIComponent(secret)}`, [secret]: { [header]: header }, list: [secret, 1, null, true], tools: [] });
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const saved = await client.mcpServers.save("docs", { url: "https://mcp.example.com/mcp", auth: { type: "headers", headers: { "X-Secret-Header": header } } });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
    name: "docs", url: "https://mcp.example.com/mcp", auth: { type: "headers", headers: { "X-Secret-Header": "[hidden]" } },
    echo: `token ${JSON.stringify(secret).slice(1, -1)} and ${encodeURIComponent(secret)}`, [secret]: { "[hidden]": "[hidden]" }, list: [secret, 1, null, true], tools: [],
  }, "only the body's own secret values are cut: here the header");
  const previewed = await client.mcpServers.preview({ url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: secret } });
  const text = JSON.stringify(previewed);
  for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert.ok(!text.includes(form), `no copy, as ${form}`);
  assert.deepEqual(previewed.list, ["[hidden]", 1, null, true], "still JSON, every other value as it was");
  assert.deepEqual([previewed.url, previewed.auth.type, previewed.auth.token, previewed.echo], ["https://mcp.example.com/mcp", "bearer", "[hidden]", "token [hidden] and [hidden]"]);
  assert.deepEqual(Object.keys(previewed).sort(), ["[hidden]", "auth", "echo", "list", "name", "tools", "url"].sort());
  assert.ok(server.requests[1].body.toString("utf8").includes(JSON.stringify(secret)), "the secret itself went to the server");
  const refusal = await thrown(client.mcpServers.save("refused", { url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: secret } }));
  assert.deepEqual([refusal.status, refusal.code, refusal.error], [422, "input_invalid", { code: "input_invalid" }]);
  assert.ok(!printed(refusal).includes(secret));
});

test("a GET is tried again after a 503, never under its Retry-After; a POST is not, unless it carries an Idempotency-Key; a Retry-After past a minute is no retry", async (t) => {
  let tries = 0;
  const server = await listener(t, (req) => {
    tries++;
    if (req.url === "/v2/agents") return tries === 1 ? json(503, { error: { code: "unavailable" } }, { "retry-after": "1" }) : json(200, { agents: [], next_cursor: null });
    if (req.url === "/v2/runs") return json(429, { error: { code: "rate_limited" } }, { "retry-after": "120" });
    if (req.headers["idempotency-key"] && server.requests.filter((r) => r.headers["idempotency-key"]).length === 1) return json(502, { error: { code: "bad_gateway" } });
    return req.headers["idempotency-key"] ? json(202, { run_id: "r1", status: "queued" }) : json(503, { error: { code: "unavailable" } });
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const began = Date.now();
  assert.deepEqual(await client.agents.list(), { agents: [], next_cursor: null });
  assert.ok(Date.now() - began >= 1000, "it waited the server's second");
  assert.equal(server.requests.length, 2);
  const start = await thrown(client.runs.start("a", { input: {} }));
  assert.deepEqual([start.status, start.code], [503, "unavailable"]);
  assert.equal(server.requests.length, 3, "a start with no key is sent once");
  assert.deepEqual(await client.runs.start("a", { input: {} }, { "Idempotency-Key": "k1" }), { run_id: "r1", status: "queued" });
  assert.equal(server.requests.length, 5, "with a key it is tried again");
  const limited = await thrown(client.runs.list());
  assert.deepEqual([limited.status, server.requests.length], [429, 6]);
});

test("a server that cannot be reached is named by its failure's code, after one try; a 501 is unsupported with its capability", async (t) => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const gone = await thrown(new AgentRun({ baseUrl: `http://127.0.0.1:${port}/v2`, apiKey: KEY }).agents.list());
  assert.ok(gone instanceof AgentRunUnreachable);
  assert.deepEqual([gone.kind, gone.cause], ["unreachable", "ECONNREFUSED"]);
  assert.ok(!printed(gone).includes(KEY));
  const server = await listener(t, () => json(501, { error: { code: "unsupported_here", message: "Not here.", retryable: false, capability: "quotes" } }));
  const off = await thrown(new AgentRun({ baseUrl: server.base, apiKey: KEY }).stats());
  assert.ok(off instanceof AgentRunUnsupported);
  assert.deepEqual([off.kind, off.by, off.capability, off.status, server.requests.length], ["unsupported", "server", "quotes", 501, 1]);
});

const page = (fields) => ({ run_id: "r1", status: "working", state: "working", reset: false, rows: [], drop: [], next_after: 1, unchanged: true, has_more: false, final: false, cost: { usd: 0 }, poll_after_ms: 50, ...fields });

test("runs.wait long-polls the timeline, tries a gateway's 502 again, returns a run waiting on a person, and past its timeout throws with the run as it is", async (t) => {
  let asked = 0;
  const server = await listener(t, (req) => {
    if (req.url.startsWith("/v2/runs/r1/timeline")) return ++asked === 1 ? json(502, {}) : json(200, page({}));
    if (req.url === "/v2/runs/r1") return json(200, { run_id: "r1", status: "working" });
    if (req.url.startsWith("/v2/runs/r2/timeline")) return json(200, page({ run_id: "r2", status: "input_required", unchanged: false }));
    if (req.url === "/v2/runs/r2") return json(200, { run_id: "r2", status: "input_required", pending: { kind: "question" } });
    return json(404, { error: { code: "not_found" } });
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const late = await thrown(client.runs.wait("r1", { timeoutMs: 700.5 }));
  assert.ok(late instanceof AgentRunTimeout);
  assert.deepEqual([late.kind, late.runId, late.run], ["late", "r1", { run_id: "r1", status: "working" }]);
  const polls = server.requests.filter((r) => r.url.startsWith("/v2/runs/r1/timeline")).map((r) => new URL(r.url, "http://x").searchParams);
  assert.ok(polls.length >= 3, "a 502, then polls");
  assert.equal(polls[0].get("wait_ms"), "0");
  for (const p of polls.slice(2)) assert.ok(/^\d+$/.test(p.get("wait_ms")) && Number(p.get("wait_ms")) <= 25_000, "whole milliseconds, at most the route's maximum");
  assert.deepEqual(await client.runs.wait("r2"), { run_id: "r2", status: "input_required", pending: { kind: "question" } });
  assert.ok((await thrown(client.runs.wait("r1", { timeoutMs: 0 }))) instanceof AgentRunUsage);
});

test("runs.follow resumes a dropped stream with Last-Event-ID, each page once, waiting at least the server's retry, and ends at the end event", async (t) => {
  const first = page({ next_after: 1, rows: [{ id: "a" }] });
  const second = page({ next_after: 2, rows: [{ id: "b" }], status: "completed", final: true });
  const at = [];
  const server = await listener(t, (req, res) => {
    at.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!req.headers["last-event-id"]) {
      res.write(`retry: 1200\n\nid: 1\nevent: rows\ndata: ${JSON.stringify(first)}\n\n: keepalive\n\nid: 2\nevent: rows\ndata: {"cut`);
      return void setTimeout(() => res.destroy(), 20);
    }
    if (req.url.startsWith("/v2/runs/bad/")) return void res.end("event: rows\ndata: not json\n\n");
    res.end(`id: 2\nevent: rows\ndata: ${JSON.stringify(second)}\n\nevent: end\ndata: {"reason":"terminal"}\n\n`);
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const pages = [];
  for await (const p of client.runs.follow("r1")) pages.push(p);
  assert.deepEqual(pages, [first, second]);
  assert.deepEqual(server.requests.map((r) => [r.url, r.headers.accept, r.headers["last-event-id"]]), [["/v2/runs/r1/timeline", "text/event-stream", undefined], ["/v2/runs/r1/timeline", "text/event-stream", "1"]]);
  assert.ok(at[1] - at[0] >= 1200, "the reconnect waited the server's retry");
  const bad = await thrown((async () => { for await (const p of client.runs.follow("bad", { lastEventId: "4" })) void p; })());
  assert.deepEqual([bad.kind, bad.code], ["refused", "bad_answer"]);
  assert.ok((await thrown(client.runs.follow("r1", { lastEventId: "1\nx" }).next())) instanceof AgentRunUsage);
});

test("a download comes back byte for byte, as bytes or as the Response", async (t) => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const server = await listener(t, () => [200, { "content-type": "application/octet-stream" }, bytes]);
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const got = await client.runs.readFile("r1", "data/all.bin");
  assert.ok(got instanceof Uint8Array);
  assert.deepEqual(Buffer.from(got), bytes);
  const response = await client.home.read("a", "all.bin", undefined, { stream: true });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("a body cut after a 2xx is tried again for a GET and a download, and a POST's is unreachable with a code", async (t) => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const cut = (res, type, whole) => {
    res.writeHead(200, { "content-type": type, "content-length": String(whole.length) });
    res.write(whole.subarray(0, Math.floor(whole.length / 2)));
    setTimeout(() => res.destroy(), 20);
  };
  const tries = {};
  const server = await listener(t, (req, res) => {
    const n = (tries[req.url] = (tries[req.url] ?? 0) + 1);
    if (req.url === "/v2/agents") return n === 1 ? void cut(res, "application/json", Buffer.from(JSON.stringify({ agents: [], next_cursor: null }))) : json(200, { agents: [], next_cursor: null });
    if (req.url === "/v2/runs/r1/files/all.bin") return n === 1 ? void cut(res, "application/octet-stream", bytes) : [200, { "content-type": "application/octet-stream" }, bytes];
    return void cut(res, "application/json", Buffer.from(JSON.stringify({ run_id: "r1", status: "queued" })));
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  assert.deepEqual(await client.agents.list(), { agents: [], next_cursor: null });
  assert.equal(tries["/v2/agents"], 2, "the cut list was tried again");
  assert.deepEqual(Buffer.from(await client.runs.readFile("r1", "all.bin")), bytes);
  assert.equal(tries["/v2/runs/r1/files/all.bin"], 2, "and the cut download");
  const started = await thrown(client.runs.start("a", { input: {} }));
  assert.ok(started instanceof AgentRunUnreachable, String(started));
  assert.match(started.cause, /^[A-Za-z0-9_]+$/);
  assert.equal(tries["/v2/agents/a/runs"], 1, "a start with no key is sent once");
  assert.ok(!printed(started).includes(KEY));
});

test("an MCP sign-in has no method: it starts in the owner's browser, whose callback needs the cookie its start sets", () => {
  const client = new AgentRun({ baseUrl: "https://agentrun.example.com/v2", apiKey: KEY });
  assert.equal(client.mcpServers.oauthStart, undefined);
  assert.equal(typeof client.mcpServers.oauthClient, "function", "its public client document stays");
});

test("a secret body's list items are public by `[]`, as the CLI reads them: each item kept, every other string cut", () => {
  const body = JSON.stringify({ url: "https://mcp.example.com/mcp", scopes: ["read", "write"], client_id: "abc", client_secret: "cs-1" });
  assert.deepEqual(secretsOf(body, ["url", "scopes.[]", "client_id"]), ["cs-1"]);
  assert.deepEqual(secretsOf(body, ["url", "client_id"]), ["read", "write", "cs-1"], "without the list path, each item is a secret");
  const answer = scrubberOf(secretsOf(body, ["url", "scopes.[]", "client_id"]))({ page: "https://auth.example.com/authorize?scope=read%20write", echo: "cs-1" });
  assert.deepEqual(answer, { page: "https://auth.example.com/authorize?scope=read%20write", echo: "[hidden]" });
});

test("runs.follow does not restart a healthy stream while its reader is busy with a page", async (t) => {
  const first = page({ next_after: 1, rows: [{ id: "a" }] });
  const second = page({ next_after: 2, rows: [{ id: "b" }], status: "completed", final: true });
  const server = await listener(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`id: 1\nevent: rows\ndata: ${JSON.stringify(first)}\n\n`);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 100);
    setTimeout(() => (clearInterval(keepalive), res.end(`id: 2\nevent: rows\ndata: ${JSON.stringify(second)}\n\nevent: end\ndata: {"reason":"terminal"}\n\n`)), 1500);
    res.on("close", () => clearInterval(keepalive));
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const pages = [];
  for await (const p of client.runs.follow("r1", { idleMs: 400 })) {
    pages.push(p);
    if (pages.length === 1) await new Promise((resolve) => setTimeout(resolve, 900));
  }
  assert.deepEqual(pages, [first, second]);
  assert.equal(server.requests.length, 1, "one connection: the reader's own pause is no silence of the server's");
});

test("runs.follow waits out a gateway's Retry-After before it reconnects", async (t) => {
  const done = page({ status: "completed", final: true });
  const at = [];
  const server = await listener(t, (req, res) => {
    at.push(Date.now());
    if (at.length === 1) return json(503, { error: { code: "unavailable" } }, { "retry-after": "1" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`id: 1\nevent: rows\ndata: ${JSON.stringify(done)}\n\nevent: end\ndata: {"reason":"terminal"}\n\n`);
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const pages = [];
  for await (const p of client.runs.follow("r1")) pages.push(p);
  assert.deepEqual(pages, [done]);
  assert.ok(at[1] - at[0] >= 1000, `it waited the gateway's second: ${at[1] - at[0]} ms`);
});

test("a caller's abort while a refusal's body is still coming is the caller's abort, never a refusal or a bad key", async (t) => {
  let headed;
  const server = await listener(t, (req, res) => {
    const status = req.url === "/v2/agents" ? 400 : 401;
    const body = Buffer.from(JSON.stringify({ error: { code: status === 400 ? "bad_request" : "unauthorized", message: "no" } }));
    res.writeHead(status, { ...JSON_HEADERS, "content-length": String(body.length) });
    res.write(body.subarray(0, 8));
    headed();
  });
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY, maxRetries: 0 });
  for (const call of [(signal) => client.agents.list(undefined, { signal }), (signal) => client.agents.get("a", { signal })]) {
    const controller = new AbortController();
    const reason = new Error("the caller let go");
    const head = new Promise((resolve) => (headed = resolve));
    const pending = thrown(call(controller.signal));
    await head;
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(reason);
    const error = await pending;
    assert.equal(error, reason, `the abort's own reason, not ${error?.name}: ${error?.message}`);
  }
});

test("a fresh client's first GET is tried again when the server takes the connection and drops it before answering", async (t) => {
  let tries = 0;
  const server = await listener(t, (req, res) => (++tries === 1 ? void res.socket.destroy() : json(200, { agents: [], next_cursor: null })));
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  assert.deepEqual(await client.agents.list(), { agents: [], next_cursor: null });
  assert.equal(tries, 2, "the dropped first request was tried once more");
});

test("a certificate the client refuses is unreachable after one try, and a refused connection on a fresh client too", async () => {
  for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "ECONNREFUSED"]) {
    let calls = 0;
    const fetch = async () => { calls++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("no"), { code }) }); };
    const error = await thrown(new AgentRun({ baseUrl: "https://agentrun.example/v2", apiKey: KEY, fetch }).agents.list());
    assert.ok(error instanceof AgentRunUnreachable, code);
    assert.deepEqual([error.cause, calls], [code, 1], code);
  }
});

test("a refusal whose code echoes a secret body's value keeps no code, in the error or its message", async (t) => {
  const secret = `secret_${randomBytes(8).toString("hex")}`;
  const server = await listener(t, (req) => (req.url.endsWith("/auth") ? json(401, { error: { code: secret, message: "no" } }) : json(422, { error: { code: secret, message: "no" } })));
  const client = new AgentRun({ baseUrl: server.base, apiKey: KEY });
  const refused = await thrown(client.mcpServers.save("docs", { url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: secret } }));
  assert.ok(refused instanceof AgentRunRefused);
  assert.deepEqual([refused.status, refused.code, refused.error], [422, undefined, undefined]);
  assert.ok(!printed(refused).includes(secret), printed(refused));
  const auth = await thrown(client.mcpServers.save("auth", { url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: secret } }));
  assert.ok(auth instanceof AgentRunAuthError);
  assert.equal(auth.code, undefined);
  assert.ok(!printed(auth).includes(secret), printed(auth));
});
