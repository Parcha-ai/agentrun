// The routes that start no run: capabilities, the credential, Host, agents, idempotency, the error envelope.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { capabilities, ERROR_STATUS, startServe } from "../dist/index.js";
import { EFFORT_ENV, thinkingOf } from "../dist/model.js";
import { agent, answerFlow, client, flowAgent, follow, scratch, serve, storeRun, withEnv } from "./support.mjs";

test("capabilities answer without a credential and say what this server offers: local, no quotes, no home moves, no upload limit", async (t) => {
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  const { baseUrl } = await serve(t);
  const { status, body } = await client(baseUrl)("GET", "/capabilities");
  assert.equal(status, 200);
  assert.equal(body.backend, "local");
  assert.equal(body.contract, "agentrun.v2/0");
  assert.equal(body.limits.max_upload_bytes, null);
  assert.deepEqual(body.models, { source: "faux", fast: "faux/faux-1", default: "faux/faux-1", strong: "faux/faux-1" });
  assert.equal(body.features.quotes, false);
  assert.deepEqual(body.features.home, { export: false, import: false, check: false });
  assert.deepEqual(body.features.runs, { stop: true, cancel: true, kill: false, list: true, kinds: ["agentic", "workflow"] });
  assert.deepEqual(body.features.agents, { create: true, list: true, update: true, revisions: true });
  assert.equal(body.features.messages.steer_workflow_runs, false);
  assert.equal(body.features.timeline.live_workflow_rows, false);
  const keyed = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"].filter((name) => !process.env[name]);
  assert.deepEqual(body.tools.map((t) => [t.name, t.available, t.nodes, t.calls]), [["read", true, true, false], ["write", true, true, false], ["edit", true, true, false], ["ask_person", true, false, false], ["fetch_page", true, true, true], ["browser", keyed.length === 0, true, false]], "the table, in order: what a revision may name, what a workflow's model node may, and what its call node may run");
  assert.ok(body.tools.every((t) => typeof t.summary === "string" && t.summary));
  assert.deepEqual(body.tools.find((t) => t.name === "browser").missing, keyed.length ? keyed : undefined, "what browser lacks here, by name");
  assert.deepEqual(body.workflows.node_tools, ["read", "write", "edit", "fetch_page", "browser"]);
  // This server's environment sets no Jev key (the test clears both): typed questions do not run, and say why.
  assert.deepEqual({ ...body.workflows, decisions: undefined }, { nodes: ["agent", "decide", "extract", "report"], node_tools: ["read", "write", "edit", "fetch_page", "browser"], adapters: ["runNode", "runEffect"], decisions: undefined });
  assert.deepEqual(body.workflows.decisions.providers.map((p) => [p.id, p.available]), [["jev", false]]);
  // And with TYPESAFE_API_KEY set, they do: runJudge is an adapter, and jev is available.
  process.env.TYPESAFE_API_KEY = "ts-test-not-a-key";
  const withJev = (await client((await serve(t)).baseUrl)("GET", "/capabilities")).body.workflows;
  assert.deepEqual([withJev.adapters, withJev.decisions.providers], [["runNode", "runEffect", "runJudge"], [{ id: "jev", available: true }]]);
  assert.deepEqual(body.features.thinking, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(body.features.files.upload, false);
  assert.deepEqual(body.regions, [{ id: "local", jurisdiction: null, state: "live" }]);
});

test("without a default model a revision that names none is refused before it starts, and so is one whose model has no key here (409)", async (t) => {
  const saved = { url: process.env.AGENT_MODEL_BASE_URL, model: process.env.AGENT_MODEL, key: process.env.OPENAI_API_KEY };
  delete process.env.AGENT_MODEL_BASE_URL;
  delete process.env.AGENT_MODEL;
  delete process.env.OPENAI_API_KEY;
  t.after(() => Object.assign(process.env, saved.url ? { AGENT_MODEL_BASE_URL: saved.url } : {}, saved.model ? { AGENT_MODEL: saved.model } : {}, saved.key ? { OPENAI_API_KEY: saved.key } : {}));
  assert.deepEqual(capabilities({}).models, { source: "providers", fast: null, default: null, strong: null });
  assert.deepEqual(capabilities({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "m-1", AGENT_MODEL_FAST: "m-fast" }).models, { source: "gateway", fast: "agent-model/m-fast", default: "agent-model/m-1", strong: "agent-model/m-1" }, "a tier with no model of its own takes the default");
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const refused = await api("POST", "/agents/plain/runs", { input: { content: "hi" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /names no model, and this host has no default/);
  assert.equal((await api("POST", "/agents", agent("keyless", { model: "openai/gpt-5" }))).status, 201);
  const keyless = await api("POST", "/agents/keyless/runs", { input: { content: "hi" } });
  assert.equal(keyless.body.error.code, "agent_not_runnable");
  assert.match(keyless.body.error.message, /no key for openai/);
  const unknown = await api("POST", "/agents", agent("unknown", { model: "openai/no-such-model" }));
  assert.equal(unknown.status, 422, "a model pi-ai does not know never runs here: refused at save (runnable.test.mjs)");
  assert.match(unknown.body.error.fields[0].message, /knows no model no-such-model of openai/);
  assert.deepEqual((await api("GET", "/runs")).body, { runs: [], next_cursor: null }, "nothing started");
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

test("on an address that is not loopback every Host name is served, and every route but capabilities still needs the token", async (t) => {
  const { port, token, url } = await serve(t, { host: "0.0.0.0" });
  assert.equal(url, `http://127.0.0.1:${port}`, "an address of every interface is shown as loopback");
  const { request } = await import("node:http");
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: "agents.example.com", ...headers } }, (res) => (res.resume(), resolve(res.statusCode)));
      req.once("error", reject).end();
    });
  assert.equal(await get("/v2/capabilities"), 200);
  assert.equal(await get("/v2/agents"), 401);
  assert.equal(await get("/v2/agents", { authorization: `Bearer ${token}` }), 200);
});

test("a token given in place of the data directory's is the one required, and no .token is written; a short one is refused", async (t) => {
  const data = join(await scratch(t), "agents");
  const token = `given_${createHash("sha256").update("a token").digest("hex")}`;
  const given = await serve(t, { data, token });
  assert.equal(given.token, token);
  assert.equal(given.tokenFile, null);
  assert.equal((await given.api("GET", "/agents")).status, 200);
  assert.equal((await client(given.baseUrl, "wrong")("GET", "/agents")).status, 401);
  await assert.rejects(stat(join(data, ".token")), { code: "ENOENT" });
  await assert.rejects(startServe({ data: join(data, "other"), port: 0, token: "too short" }), /32 characters or more/);
  await assert.rejects(startServe({ data: join(data, "other"), port: 0, token: `${token} spaced` }), /no whitespace/);
});

test("an agent is created from a definition and skills, read back with its ETag, and listed newest first, page by page", async (t) => {
  const { api, data } = await serve(t);
  const created = await api("POST", "/agents", { ...agent("reporter", { description: "Writes reports.", skills: ["cite"], model: "faux/faux-1", thinking: "high" }), skills: { "cite/SKILL.md": "# Cite\n" } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/v2/agents/reporter");
  assert.equal(created.body.agent_id, "reporter");
  assert.deepEqual(created.body.runs, { count: 0, live: 0 });
  assert.deepEqual(created.body.skills, [{ path: "cite/SKILL.md", sha256: createHash("sha256").update("# Cite\n").digest("hex"), size_bytes: 7 }]);
  assert.equal(created.body.kind, "agentic");
  assert.match(created.body.revision, /^[0-9a-f]{64}$/);
  assert.equal(created.body.revisions, 1);
  assert.equal(created.body.home_etag, `"${created.body.revision}"`, "the ETag is the current revision");
  assert.deepEqual(created.body.definition, { id: "reporter", version: 1, name: "reporter", description: "Writes reports.", instructions: "Answer.", model: "faux/faux-1", thinking: "high", harness: "pi", skills: ["cite"], tools: [] });
  const read = await api("GET", "/agents/reporter");
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("etag"), read.body.home_etag);
  assert.equal(read.body.definition.description, "Writes reports.");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT id, name, current_revision FROM agents").all().map((r) => ({ ...r })), [{ id: "reporter", name: "reporter", current_revision: created.body.revision }], "one store, one row per agent");
  const minted = await api("POST", "/agents", { definition: { version: 1, name: "minted", instructions: "x", skills: [], tools: [] } });
  assert.match(minted.body.agent_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUIDv7 when the definition has no id");
  const page1 = await api("GET", "/agents?limit=1");
  assert.deepEqual(page1.body.agents.map((a) => a.agent_id), [minted.body.agent_id]);
  const page2 = await api("GET", `/agents?limit=1&cursor=${page1.body.next_cursor}`);
  assert.deepEqual(page2.body.agents.map((a) => a.agent_id), ["reporter"]);
  assert.equal(page2.body.next_cursor, null);
  assert.equal((await api("GET", "/agents/nobody")).status, 404);
});

test("a definition field the store does not keep is refused by name, and an id already here is agent_exists", async (t) => {
  const { api } = await serve(t);
  const kept = await api("POST", "/agents", agent("m", { input_schema: {}, output_schema: {}, max_cost_usd: 1 }));
  assert.equal(kept.status, 422);
  assert.equal(kept.body.error.code, "input_invalid");
  assert.deepEqual(kept.body.error.fields.map((f) => [f.field, f.reason]), [["definition.input_schema", "not_allowed"], ["definition.output_schema", "not_allowed"], ["definition.max_cost_usd", "not_allowed"]]);
  assert.deepEqual((await api("POST", "/agents", agent("m", { thinking: "off" }))).body.error.fields.map((f) => [f.field, f.reason]), [["definition.thinking", "not_an_option"]], "thinking is never off");
  assert.deepEqual((await api("POST", "/agents", flowAgent("fm", answerFlow(), { thinking: "high" }))).body.error.fields.map((f) => [f.field, f.reason]), [["definition.thinking", "not_allowed"]]);
  assert.deepEqual((await api("POST", "/agents", agent("m", { model: "gpt" }))).body.error.fields.map((f) => [f.field, f.reason]), [["definition.model", "bad_format"]]);
  const missing = await api("POST", "/agents", { definition: { version: 0, name: "", skills: ["a", "a"] } });
  assert.deepEqual(new Set(missing.body.error.fields.map((f) => f.field)), new Set(["definition.instructions", "definition.version", "definition.name", "definition.skills"]));
  const both = await api("POST", "/agents", agent("both", { workflow: answerFlow() }));
  assert.deepEqual(both.body.error.fields.map((f) => [f.field, f.reason]), [["definition.workflow", "not_allowed"]]);
  const flowModel = await api("POST", "/agents", flowAgent("fm", answerFlow(), { model: "faux/faux-1" }));
  assert.deepEqual(flowModel.body.error.fields.map((f) => [f.field, f.reason]), [["definition.model", "not_allowed"]]);
  const unnamed = await api("POST", "/agents", { ...agent("sk", { skills: ["cite"] }), skills: { "other/SKILL.md": "x" } });
  assert.deepEqual(unnamed.body.error.fields.map((f) => [f.field, f.reason]), [["skills.cite/SKILL.md", "missing"], ["skills.other/SKILL.md", "not_allowed"]]);
  assert.deepEqual((await api("POST", "/agents", agent("v", { version: 2 }))).body.error.fields.map((f) => [f.field, f.reason]), [["definition.version", "not_an_option"]]);
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

test("a run's input is checked against the default schema {content: string} before anything starts, and an agent's tools against what is bound when it is saved", async (t) => {
  const { api } = await serve(t);
  await api("POST", "/agents", agent("plain"));
  const noContent = await api("POST", "/agents/plain/runs", { input: { question: "no content" } });
  assert.equal(noContent.status, 422);
  assert.deepEqual(noContent.body.error.fields.map((f) => [f.field, f.reason]), [["input.content", "missing"]]);
  const quote = await api("POST", "/agents/plain/runs", { input: { content: "x" }, quote_id: "q" });
  assert.deepEqual([quote.status, quote.body.error.capability], [501, "quotes"]);
  const unbound = await api("POST", "/agents", agent("shell", { tools: ["read", "bash"] }));
  assert.deepEqual([unbound.status, unbound.body.error.fields.map((f) => f.field)], [422, ["definition.tools[1]"]]);
  assert.deepEqual((await api("GET", "/agents/plain/runs")).body, { runs: [], next_cursor: null });
});

test("a run thinks at its effort, else its revision's thinking level, else the host's AGENT_THINKING, else medium; never off", () => {
  assert.equal(thinkingOf({ [EFFORT_ENV]: "low", AGENT_THINKING: "max" }, "high"), "low");
  assert.equal(thinkingOf({ AGENT_THINKING: "max" }, "high"), "high");
  assert.equal(thinkingOf({ AGENT_THINKING: "max" }, undefined), "max");
  assert.equal(thinkingOf({}, undefined), "medium");
  assert.equal(thinkingOf({ AGENT_THINKING: "off" }, "off"), "medium");
});

test("the tool table is closed: a name outside it is refused by name, and a tool's missing variables are named, never their values", async () => {
  const { toolRefusal, toolsView, TOOLS } = await import("../dist/tools.js");
  assert.ok(Object.isFrozen(TOOLS));
  assert.equal(toolRefusal(["read", "ask_person"], {}), undefined);
  assert.deepEqual(toolRefusal(["read", "bash", "constructor"], {}).unbound, ["bash", "constructor"], "nothing outside the table, not even a name every object has");
  assert.deepEqual(toolRefusal(["ask_person"], {}, "nodes").unbound, ["ask_person"], "a workflow's model node cannot ask the person");
  assert.deepEqual(toolsView({}).map((t) => [t.name, t.missing]), [["read", undefined], ["write", undefined], ["edit", undefined], ["ask_person", undefined], ["fetch_page", undefined], ["browser", ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]]]);
  assert.deepEqual(toolRefusal(["fetch_page", "read"], {}, "calls").unbound, ["read"], "a call node runs only a tool the table gives an effect");
  assert.deepEqual(toolRefusal(["browser"], { BROWSERBASE_API_KEY: "fake-test-key" }).missing, { browser: ["BROWSERBASE_PROJECT_ID"] });
});
