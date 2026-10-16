// The routes that start no run: capabilities, the credential, Host, agents, idempotency, the error envelope.
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { capabilities, ERROR_STATUS, startServe } from "../dist/index.js";
import { agent, client, scratch, serve } from "./support.mjs";

test("capabilities answer without a credential and say what this server offers: local, no quotes, no home moves, no upload limit", async (t) => {
  const { baseUrl } = await serve(t);
  const { status, body } = await client(baseUrl)("GET", "/capabilities");
  assert.equal(status, 200);
  assert.equal(body.backend, "local");
  assert.equal(body.contract, "agentrun.v2/0");
  assert.equal(body.limits.max_upload_bytes, null);
  assert.deepEqual(body.models, { source: "faux", default: "faux/faux-1" });
  assert.equal(body.features.quotes, false);
  assert.deepEqual(body.features.home, { export: false, import: false, check: false });
  assert.deepEqual(body.features.runs, { stop: true, cancel: true, kill: false });
  assert.equal(body.features.agents.update, false);
  assert.equal(body.features.files.upload, false);
  assert.deepEqual(body.regions, [{ id: "local", jurisdiction: null, state: "live" }]);
});

test("without a model the capabilities name none, and a run is refused before it starts (409 agent_not_runnable)", async (t) => {
  const saved = { url: process.env.AGENT_MODEL_BASE_URL, model: process.env.AGENT_MODEL };
  delete process.env.AGENT_MODEL_BASE_URL;
  delete process.env.AGENT_MODEL;
  t.after(() => Object.assign(process.env, saved.url ? { AGENT_MODEL_BASE_URL: saved.url } : {}, saved.model ? { AGENT_MODEL: saved.model } : {}));
  assert.equal(capabilities({}).models, undefined);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const refused = await api("POST", "/agents/plain/runs", { input: { content: "hi" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /No model is bound/);
});

test("every other route needs the bearer token, which the data directory keeps at mode 0600 and the server keeps across restarts", async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data });
  const anonymous = await client(first.baseUrl)("GET", "/agents");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, "unauthenticated");
  assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
  assert.equal((await client(first.baseUrl, "wrong")("GET", "/agents")).status, 401);
  assert.equal((await first.api("GET", "/agents")).status, 200);
  assert.equal((await stat(first.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(data)).mode & 0o777, 0o700);
  assert.match(first.token, /^ar_local_/);
  await first.close();
  const second = await startServe({ data, port: 0 });
  t.after(() => second.close());
  assert.equal(second.token, first.token);
});

test("a Host that is not a loopback name is refused, and no answer carries a CORS header", async (t) => {
  const { baseUrl, port, api } = await serve(t);
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/v2/capabilities", headers: { host: `evil.example:${port}` } }, (res) => (res.resume(), resolve(res.statusCode)));
    req.once("error", reject).end();
  });
  assert.equal(status, 403);
  const res = await fetch(`${baseUrl}/capabilities`, { headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  const preflight = await api("OPTIONS", "/agents", undefined, { origin: "https://evil.example", "access-control-request-method": "POST" });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("an agent is created from a definition and skills, read back with its ETag, and listed newest first, page by page", async (t) => {
  const { api } = await serve(t);
  const created = await api("POST", "/agents", { ...agent("reporter", { description: "Writes reports.", skills: ["cite"] }), skills: { "cite/SKILL.md": "# Cite\n" } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/v2/agents/reporter");
  assert.equal(created.body.agent_id, "reporter");
  assert.deepEqual(created.body.runs, { count: 0, live: 0 });
  assert.equal(created.body.skills[0].path, "cite/SKILL.md");
  const read = await api("GET", "/agents/reporter");
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("etag"), read.body.home_etag);
  assert.equal(read.body.definition.description, "Writes reports.");
  const minted = await api("POST", "/agents", { definition: { version: 1, name: "minted", instructions: "x", skills: [], tools: [] } });
  assert.match(minted.body.agent_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUIDv7 when the definition has no id");
  const page1 = await api("GET", "/agents?limit=1");
  assert.deepEqual(page1.body.agents.map((a) => a.agent_id), [minted.body.agent_id]);
  const page2 = await api("GET", `/agents?limit=1&cursor=${page1.body.next_cursor}`);
  assert.deepEqual(page2.body.agents.map((a) => a.agent_id), ["reporter"]);
  assert.equal(page2.body.next_cursor, null);
  assert.equal((await api("GET", "/agents/nobody")).status, 404);
});

test("a definition field the home does not keep is refused by name, and an id already here is agent_exists", async (t) => {
  const { api } = await serve(t);
  const model = await api("POST", "/agents", agent("m", { model: "gpt" }));
  assert.equal(model.status, 422);
  assert.equal(model.body.error.code, "input_invalid");
  assert.deepEqual(model.body.error.fields.map((f) => [f.field, f.reason]), [["definition.model", "not_allowed"]]);
  const missing = await api("POST", "/agents", { definition: { version: 0, name: "", skills: ["a", "a"] } });
  assert.deepEqual(new Set(missing.body.error.fields.map((f) => f.field)), new Set(["definition.instructions", "definition.tools", "definition.version", "definition.name", "definition.skills"]));
  assert.equal((await api("POST", "/agents", agent("same"))).status, 201);
  const again = await api("POST", "/agents", agent("same"));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "agent_exists");
  assert.equal((await api("POST", "/agents", agent("../up"))).body.error.fields[0].field, "definition.id");
});

test("Idempotency-Key: the same body replays the first answer, marked; another body is idempotency_mismatch", async (t) => {
  const { api } = await serve(t);
  const key = { "idempotency-key": "k-1" };
  const first = await api("POST", "/agents", agent("idem"), key);
  const replay = await api("POST", "/agents", agent("idem"), key);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(first.headers.get("idempotent-replayed"), null);
  const other = await api("POST", "/agents", agent("idem-2"), key);
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, "idempotency_mismatch");
});

test("the error envelope: each code with its one status, 405 with Allow, 404 outside the contract, 400, 415 and 413 on bodies", async (t) => {
  const { api, baseUrl, token } = await serve(t);
  const check = (res, code) => {
    assert.equal(res.body.error.code, code);
    assert.equal(res.status, ERROR_STATUS[code]);
    assert.equal(typeof res.body.error.message, "string");
    assert.equal(typeof res.body.error.retryable, "boolean");
  };
  const wrongMethod = await api("DELETE", "/agents");
  check(wrongMethod, "method_not_allowed");
  assert.equal(wrongMethod.headers.get("allow"), "POST, GET");
  check(await api("GET", "/nothing"), "not_found");
  check(await api("GET", "/runs/missing"), "not_found");
  const notJson = await fetch(`${baseUrl}/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" });
  check({ status: notJson.status, body: await notJson.json() }, "bad_request");
  const text = await fetch(`${baseUrl}/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "{}" });
  check({ status: text.status, body: await text.json() }, "unsupported_media_type");
  const big = await fetch(`${baseUrl}/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ definition: { instructions: "x".repeat(1 << 20) } }) });
  check({ status: big.status, body: await big.json() }, "payload_too_large");
  check(await api("GET", "/agents?limit=0"), "bad_request");
});

test("every feature declared off answers 501 unsupported_here naming it, before any lookup", async (t) => {
  const { api, baseUrl } = await serve(t);
  const caps = (await client(baseUrl)("GET", "/capabilities")).body;
  const probes = [
    ["quotes", "POST", "/quotes", { agent_id: "x" }],
    ["runs.kill", "POST", "/runs/x/kill", {}],
    ["agents.update", "PUT", "/agents/x/definition", { version: 2, name: "x", instructions: "", skills: [], tools: [] }, { "if-match": '"x"' }],
    ["home.export", "GET", "/agents/x/home", undefined, { accept: "application/json" }],
    ["home.import", "PUT", "/agents/x/home", {}],
    ["files.upload", "POST", "/files", { path: "a.txt", size_bytes: 1 }],
    ["files.upload", "PUT", "/files/x", {}],
  ];
  for (const [capability, method, path, body, headers] of probes) {
    const [group, name] = capability.split(".");
    assert.equal(name ? caps.features[group][name] : caps.features[group], false, `${capability} is declared off`);
    const res = await api(method, path, body, headers);
    assert.equal(res.status, 501, `${method} ${path}`);
    assert.deepEqual([res.body.error.code, res.body.error.capability], ["unsupported_here", capability]);
  }
});

test("a run's input is checked against the default schema {content: string}, and the agent's tools against what is bound, before anything starts", async (t) => {
  const { api } = await serve(t);
  await api("POST", "/agents", agent("plain"));
  const noContent = await api("POST", "/agents/plain/runs", { input: { question: "no content" } });
  assert.equal(noContent.status, 422);
  assert.deepEqual(noContent.body.error.fields.map((f) => [f.field, f.reason]), [["input.content", "missing"]]);
  const quote = await api("POST", "/agents/plain/runs", { input: { content: "x" }, quote_id: "q" });
  assert.deepEqual([quote.status, quote.body.error.capability], [501, "quotes"]);
  await api("POST", "/agents", agent("shell", { tools: ["read", "bash"] }));
  const unbound = await api("POST", "/agents/shell/runs", { input: { content: "x" } });
  assert.equal(unbound.status, 409);
  assert.equal(unbound.body.error.code, "agent_not_runnable");
  assert.deepEqual(unbound.body.error.details.unbound, ["bash"]);
  await api("POST", "/agents", agent("flow", { workflow: { nodes: [] } }));
  assert.equal((await api("POST", "/agents/flow/runs", { input: { content: "x" } })).body.error.code, "agent_not_runnable");
  await api("POST", "/agents", agent("typed", { input_schema: { type: "object", required: ["task"], properties: { task: { type: "string" } } } }));
  const typed = await api("POST", "/agents/typed/runs", { input: { task: 7 } });
  assert.deepEqual(typed.body.error.fields.map((f) => [f.field, f.reason]), [["input.task", "wrong_type"]]);
  assert.deepEqual((await api("GET", "/agents/plain/runs")).body, { runs: [], next_cursor: null });
});
