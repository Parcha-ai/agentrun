// A key saved through /v2/settings/tool-keys is checked against its provider before it is kept, with one call that costs
// nothing: a key the provider refuses (401) is not kept, and the PUT says so in the provider's words, never the key's;
// one it accepts is kept, and GET says when it was checked; one that could not be checked (a 403, which a key scoped
// away from the check's call gets, no answer, no free call, no fake for it under faux) is kept, and GET says why. A 401
// refuses whatever its body does, and a save still waiting on its provider when the server closes stores nothing. On
// faux monid, recording fetches and a provider on loopback: no network, no real key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { startServe } from "../dist/index.js";
import { ToolKeys } from "../dist/tool-keys.js";
import { calls as monidCalls, KEY as MONID_KEY, release as releaseMonid, stalled as monidStalled } from "./fixtures/faux-monid.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const KEYS = ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "TYPESAFE_API_KEY", "AGENTRUN_SEAL_KEY", "AGENTRUN_TEST_FAUX_MONID_CALLS", "AGENTRUN_TEST_FAUX_MONID_KEY", "AGENTRUN_TEST_FAUX_MONID_DOWN", "AGENTRUN_TEST_FAUX_MONID_STATUS", "AGENTRUN_TEST_FAUX_MONID_STALL"];
const sealKey = () => randomBytes(32).toString("base64");
/** A throwaway value shaped like the one a QA pass saved: built here, never a real key. */
const fake = () => ["mk", "qa7", "fake", randomBytes(8).toString("hex")].join("_");
/** Each form a value could leak in: as text, base64, base64url and hex, and its random tail. */
const formsOf = (value) => [value, ...["base64", "base64url", "hex"].map((code) => Buffer.from(value).toString(code)), value.slice(-12)];
const holdsNone = (text, value, where) => { for (const form of formsOf(value)) assert.ok(!String(text).includes(form), `${where} holds the key (${form.length} long)`); };
const rowOf = (view, id) => view.keys.find((key) => key.id === id);
const filed = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
async function meetsDocument(api, view) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/settings/tool-keys"].get.responses["200"].content["application/json"].schema, view), [], JSON.stringify(view));
}

test("a key monid refuses is not kept: the PUT is 422 in monid's own words, never the key's, nothing is stored, and a key kept before stays as it was", async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), AGENTRUN_TEST_FAUX_MONID_CALLS: log }, KEYS);
  const { api, data } = await serve(t, { fauxMonid: FAUX_MONID });
  const wrong = fake();
  const refused = await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: wrong } });
  assert.equal(refused.status, 422, `a key monid refuses is not saved: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error.code, "input_invalid");
  assert.equal(refused.body.error.message, "Monid refused this key (401: Missing or invalid API key)");
  assert.deepEqual(refused.body.error.fields.map(({ field, reason }) => [field, reason]), [["values.MONID_API_KEY", "refused_by_provider"]]);
  holdsNone(JSON.stringify(refused.body), wrong, "the refusal");
  assert.equal(existsSync(join(data, "tool-keys.json")), false, "nothing stored");
  const unset = rowOf((await api("GET", "/settings/tool-keys")).body, "monid");
  assert.deepEqual([unset.fields, unset.check], [[{ name: "MONID_API_KEY", set: false, source: null }], null], "GET shows it unset, with no check");
  assert.deepEqual(filed(log).map((call) => [call.method, call.path, call.authorized, call.pid === process.pid]), [["POST", "/v1/discover", false, true]], "one discover, from the server, on the key sent");

  // A key monid accepts, then a wrong one: the wrong one is refused, and the kept key and its check are as they were.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: MONID_KEY } })).status, 204);
  const kept = rowOf((await api("GET", "/settings/tool-keys")).body, "monid");
  assert.equal(kept.check?.state, "accepted");
  const again = await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: fake() } });
  assert.equal(again.status, 422);
  assert.deepEqual(rowOf((await api("GET", "/settings/tool-keys")).body, "monid"), kept, "the kept key, its source and its check, unchanged");
  assert.equal(new ToolKeys(data, { AGENTRUN_SEAL_KEY: process.env.AGENTRUN_SEAL_KEY }, () => undefined).value("MONID_API_KEY"), MONID_KEY, "the stored value is the accepted one");
});

test("a key monid accepts is kept, and GET says it was checked and when; DELETE forgets the check with the key", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, KEYS);
  const { api, data } = await serve(t, { fauxMonid: FAUX_MONID });
  const from = monidCalls.length;
  const before = Date.now();
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: MONID_KEY } })).status, 204);
  const view = (await api("GET", "/settings/tool-keys")).body;
  const row = rowOf(view, "monid");
  assert.deepEqual(row.fields, [{ name: "MONID_API_KEY", set: true, source: "stored" }]);
  assert.deepEqual(Object.keys(row.check ?? {}).sort(), ["at", "state"], JSON.stringify(row.check));
  assert.equal(row.check.state, "accepted");
  assert.match(row.check.at, ISO);
  assert.ok(Date.parse(row.check.at) >= before - 1000 && Date.parse(row.check.at) <= Date.now(), "when it was saved");
  assert.deepEqual(monidCalls.slice(from).map(({ method, path, body, authorized }) => [method, path, body?.limit, authorized]), [["POST", "/v1/discover", 1, true]], "one discover of one result, on the key");
  for (const other of ["parallel", "browserbase", "typesafe"]) assert.equal(rowOf(view, other).check, null, `${other}: nothing saved, nothing checked`);
  await meetsDocument(api, view);
  assert.ok(!readFileSync(join(data, "tool-keys.json"), "utf8").includes(MONID_KEY), "the file holds no value");

  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  assert.equal(rowOf((await api("GET", "/settings/tool-keys")).body, "monid").check, null);
  assert.equal(readFileSync(join(data, "tool-keys.json"), "utf8").includes("accepted"), false, "the check goes with the key");
});

test("a key whose provider can't be reached, or has no fake under faux, is kept as not checked, saying why; a key the server is started with has no check; one saved before checks reads not checked", async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  const own = fake();
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), AGENTRUN_TEST_FAUX_MONID_CALLS: log, AGENTRUN_TEST_FAUX_MONID_DOWN: "1", TYPESAFE_API_KEY: own }, KEYS);
  const { api, data } = await serve(t, { fauxMonid: FAUX_MONID });
  const values = { monid: fake(), browserbase: fake() };

  // monid can't be reached: kept, not checked, and why.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: values.monid } })).status, 204, "a key that could not be checked is still saved");
  assert.equal(filed(log).length, 1, "monid was tried once");
  // Browserbase, with no fake for it on this faux server: kept, not checked, never the network.
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_API_KEY: values.browserbase, BROWSERBASE_PROJECT_ID: "proj-1" } })).status, 204);
  const view = (await api("GET", "/settings/tool-keys")).body;
  const monid = rowOf(view, "monid").check;
  assert.deepEqual([monid?.state, monid?.reason], ["not_checked", "Monid could not be reached (ENOTFOUND)"], JSON.stringify(monid));
  assert.match(monid.at, ISO);
  const browserbase = rowOf(view, "browserbase").check;
  assert.deepEqual([browserbase?.state, browserbase?.reason], ["not_checked", "This server runs on faux providers and has no fake Browserbase to check the key with"], JSON.stringify(browserbase));
  assert.equal(rowOf(view, "typesafe").check, null, "the server's own key is not saved here, so not checked here");
  for (const value of [...Object.values(values), own]) holdsNone(JSON.stringify(view), value, "GET's answer");
  await meetsDocument(api, view);

  // A save of Browserbase's project id alone sends no key: its check stays as it was.
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_PROJECT_ID: "proj-2" } })).status, 204);
  assert.deepEqual(rowOf((await api("GET", "/settings/tool-keys")).body, "browserbase").check, browserbase);

  // Kept by a server from before checks (ToolKeys.save with no check): set, and not checked, saying so.
  new ToolKeys(data, { AGENTRUN_SEAL_KEY: process.env.AGENTRUN_SEAL_KEY }, () => undefined).save("parallel", { values: { PARALLEL_API_KEY: fake() } });
  const before = (await api("GET", "/settings/tool-keys")).body;
  assert.deepEqual(rowOf(before, "parallel").check, { state: "not_checked", reason: "Saved before this server checked keys; save it again to check it" });
  await meetsDocument(api, before);
});

test("a key monid answers 403 for is kept as not checked: a key scoped away from the check's call may still work for its tools, so it is never refused", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), AGENTRUN_TEST_FAUX_MONID_STATUS: "403" }, KEYS);
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  const scoped = fake();
  const saved = await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: scoped } });
  assert.equal(saved.status, 204, `a 403 is no refusal: ${JSON.stringify(saved.body)}`);
  const view = (await api("GET", "/settings/tool-keys")).body;
  const row = rowOf(view, "monid");
  assert.deepEqual(row.fields, [{ name: "MONID_API_KEY", set: true, source: "stored" }]);
  assert.deepEqual([row.check?.state, row.check?.reason], ["not_checked", "Monid would not answer the check (403: This key may not use this endpoint); the key may still work for its tools"], JSON.stringify(row.check));
  assert.match(row.check.at, ISO);
  holdsNone(JSON.stringify(view), scoped, "GET's answer");
  await meetsDocument(api, view);
});

test("a save still waiting on its provider when the server closes stores nothing, and close cuts the wait: by then the directory may be another server's", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), AGENTRUN_TEST_FAUX_MONID_STALL: "1" }, KEYS);
  t.after(releaseMonid);
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, fauxMonid: FAUX_MONID, drainTimeout: "5s" });
  const put = client(server.baseUrl, server.token)("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: MONID_KEY } }).catch((error) => ({ error }));
  const signal = await monidStalled();
  await server.close();
  // The fake answers only now, its signal ignored, and accepts the key: what the save does next runs on the promises
  // that answer resolves, all done before the next turn of the event loop.
  releaseMonid();
  await put;
  for (let i = 0; i < 3; i++) await turn();
  assert.equal(existsSync(join(data, "tool-keys.json")), false, "a save the server closed under wrote nothing");
  assert.equal(signal.aborted, true, "close cut the check's wait");
});

/** A fetch that files each request and answers with `answer(request, init)`: a Response, or a throw. */
function recorder(answer) {
  const sent = [];
  const fetcher = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), body: typeof init.body === "string" ? JSON.parse(init.body) : init.body, redirect: init.redirect });
    return answer(init);
  };
  return Object.assign(fetcher, { sent });
}
const json = (status, body) => () => new Response(body === null || typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": typeof body === "object" ? "application/json" : "text/plain" } });
/** A provider on loopback answering each request with `answer(res)` once it has read the request: the fetch a check makes,
 *  sent there whatever the provider's address, over a real socket. */
async function onLoopback(t, answer) {
  const server = createServer((req, res) => req.resume().on("end", () => answer(res)));
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => new Promise((closed) => (server.closeAllConnections(), server.close(closed))));
  const at = `http://127.0.0.1:${server.address().port}/`;
  return (_url, init) => fetch(at, init);
}

test("a 401 refuses the key whatever its body does: a provider that sends its headers and then drops the connection, or stalls past the deadline, refuses with no quote", async (t) => {
  const { checkKey } = await import("../dist/key-check.js");
  const row = { id: "monid", label: "Monid" };
  // The headers and the first of the body, then (`then`, once that is written) nothing more.
  const headers = (res, then) => (res.writeHead(401, { "content-type": "application/json", "content-length": "200" }), res.write('{"code": 401, "message": "Invalid API', then));
  const dropped = await onLoopback(t, (res) => headers(res, () => res.socket.destroy()));
  assert.deepEqual(await checkKey(row, fake(), {}, dropped), { state: "refused", message: "Monid refused this key (401)" }, "the connection dropped in the body");
  const stalled = await onLoopback(t, (res) => headers(res));
  assert.deepEqual(await checkKey(row, fake(), {}, stalled, 200), { state: "refused", message: "Monid refused this key (401)" }, "the body stalled past the deadline");
});

test("a check never follows a redirect: a provider that answers 302 to another origin reads not checked, and nothing, the key's header least of all, reaches where it points", async (t) => {
  const { checkKey } = await import("../dist/key-check.js");
  // Where the redirect points: it files the headers of each request it gets.
  const landed = [];
  const elsewhere = createServer((req, res) => (landed.push(req.headers), res.writeHead(200, { "content-type": "application/json" }).end("{}")));
  await new Promise((listening) => elsewhere.listen(0, "127.0.0.1", listening));
  t.after(() => new Promise((closed) => (elsewhere.closeAllConnections(), elsewhere.close(closed))));
  const redirecting = await onLoopback(t, (res) => res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.address().port}/` }).end());
  for (const [id, label, header] of [["parallel", "Parallel", "x-api-key"], ["browserbase", "Browserbase", "x-bb-api-key"], ["monid", "Monid", "authorization"]]) {
    const { at, ...outcome } = await checkKey({ id, label }, fake(), {}, redirecting);
    assert.deepEqual(landed.map((headers) => Object.hasOwn(headers, header)), [], `${label}: no request reached the redirect's target (true: one did, with the key's ${header} header)`);
    assert.deepEqual(outcome, { state: "not_checked", reason: `${label} answered 302 (a redirect, not followed)` });
    assert.match(at, ISO);
    landed.length = 0;
  }
});

const ROWS = { monid: "Monid", parallel: "Parallel", browserbase: "Browserbase", typesafe: "TypeSafe (Jev)", anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };

test("each provider's check is one documented call that costs nothing, on the key, at the base this server sends that provider's calls to", async () => {
  const { KEY_CHECKS, checkKey } = await import("../dist/key-check.js");
  const key = fake();
  // Each a read or a search that the provider does not bill (key-check.ts cites the page for each): never a paid path.
  const expected = {
    monid: ["POST", "https://api.monid.ai/v1/discover", { authorization: `Bearer ${key}` }],
    parallel: ["GET", "https://api.parallel.ai/v1/monitors?limit=1", { "x-api-key": key }],
    browserbase: ["GET", "https://api.browserbase.com/v1/projects", { "x-bb-api-key": key }],
    typesafe: ["GET", "https://api.typesafe.ai/v1/models", { authorization: `Bearer ${key}` }],
    anthropic: ["GET", "https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }],
    openrouter: ["GET", "https://openrouter.ai/api/v1/key", { authorization: `Bearer ${key}` }],
  };
  assert.deepEqual(Object.keys(KEY_CHECKS).sort(), Object.keys(expected).sort(), "every check is here, and no other");
  for (const [id, [method, url, auth]] of Object.entries(expected)) {
    const fetcher = recorder(json(200, {}));
    const { state, at } = await checkKey({ id, label: ROWS[id] }, key, {}, fetcher);
    assert.deepEqual([state, ISO.test(at)], ["accepted", true], id);
    assert.equal(fetcher.sent.length, 1, `${id}: one call`);
    const [sent] = fetcher.sent;
    assert.deepEqual([sent.method, sent.url], [method, url], id);
    for (const [name, value] of Object.entries(auth)) assert.equal(sent.headers[name], value, `${id}: ${name}`);
    assert.equal(sent.redirect, "manual", `${id}: a redirect is never followed, so the key goes nowhere but the provider`);
    if (id === "monid") assert.deepEqual(sent.body, { query: "company data", limit: 1 }, "a discover of one result");
    else assert.equal(sent.body, undefined, `${id}: a GET with no body`);
  }
  // OpenAI's key is not checked: OpenAI answers 401 to a restricted key that works but may not list models.
  const none = recorder(json(200, {}));
  const { at: _, ...openai } = await checkKey({ id: "openai", label: ROWS.openai }, key, {}, none);
  assert.deepEqual([openai, none.sent.length], [{ state: "not_checked", reason: "OpenAI keys aren't checked here: a restricted key can work without listing models" }, 0], "no call, and why");
  // A base URL the server sends a provider's calls to (a gateway, a proxy) is where its key is checked.
  const env = { BROWSERBASE_BASE_URL: "https://bb.proxy.example/", TYPESAFE_BASE_URL: "https://ts.gateway.example", ANTHROPIC_BASE_URL: "https://claude.gateway.example/" };
  for (const [id, url] of [["browserbase", "https://bb.proxy.example/v1/projects"], ["typesafe", "https://ts.gateway.example/v1/models"], ["anthropic", "https://claude.gateway.example/v1/models?limit=1"]]) {
    const fetcher = recorder(json(200, {}));
    await checkKey({ id, label: ROWS[id] }, key, env, fetcher);
    assert.equal(fetcher.sent[0].url, url, id);
  }
});

test("a check reads the provider's answer: 2xx accepted, 401 refused in its first sentence, a 403, any other answer or none not checked, and no message ever holds the key", async () => {
  const { checkKey } = await import("../dist/key-check.js");
  const key = fake();
  const row = { id: "monid", label: "Monid" };
  const outcome = async (answer, options = {}) => {
    const result = await checkKey(options.row ?? row, options.key ?? key, {}, options.fetcher === undefined ? recorder(answer) : options.fetcher, options.ms);
    for (const form of formsOf(options.key ?? key)) assert.ok(!JSON.stringify(result).includes(form), `the outcome holds the key: ${JSON.stringify(result)}`);
    const { at, ...rest } = result;
    if (result.state !== "refused") assert.match(at ?? "", ISO, JSON.stringify(result));
    return rest;
  };
  assert.deepEqual(await outcome(json(200, { results: [] })), { state: "accepted" });
  assert.deepEqual(await outcome(json(204, null)), { state: "accepted" });
  assert.deepEqual(await outcome(json(401, { code: 401, message: "Invalid API key format. Keys start with monid_live_." })), { state: "refused", message: "Monid refused this key (401: Invalid API key format)" });
  // A 403 is the provider knowing the key and not answering this call: a key scoped away from it may still work.
  assert.deepEqual(await outcome(json(403, { error: { type: "permission_error", message: "This key may not do that." } })), { state: "not_checked", reason: "Monid would not answer the check (403: This key may not do that); the key may still work for its tools" });
  assert.deepEqual(await outcome(json(401, { detail: "invalid key" })), { state: "refused", message: "Monid refused this key (401: invalid key)" });
  assert.deepEqual(await outcome(json(403, "Forbidden")), { state: "not_checked", reason: "Monid would not answer the check (403: Forbidden); the key may still work for its tools" });
  assert.deepEqual(await outcome(json(401, "Unauthorized")), { state: "refused", message: "Monid refused this key (401: Unauthorized)" });
  assert.deepEqual(await outcome(json(401, "<html><body>401</body></html>")), { state: "refused", message: "Monid refused this key (401)" }, "a page is not words");
  assert.deepEqual(await outcome(json(401, { message: `x`.repeat(400) })), { state: "refused", message: `Monid refused this key (401: ${"x".repeat(200)})` }, "at most 200 characters");
  // A provider that echoes the key, or a piece of it, is never quoted.
  const masked = `Incorrect API key provided: ${key.slice(0, 8)}${"*".repeat(20)}${key.slice(-4)}. You can find your API key in your account.`;
  assert.deepEqual(await outcome(json(401, { error: { message: masked } }), { row: { id: "anthropic", label: "Anthropic" } }), { state: "refused", message: "Anthropic refused this key (401)" });
  assert.deepEqual(await outcome(json(401, { message: `The key ${key} is not valid.` })), { state: "refused", message: "Monid refused this key (401)" });
  assert.deepEqual(await outcome(json(500, { message: `Upstream failed for ${key.slice(3, 11)}.` })), { state: "not_checked", reason: "Monid answered 500" });
  // Any other answer, or none, does not say whether the key works.
  assert.deepEqual(await outcome(json(503, { message: "Service unavailable. Try later." })), { state: "not_checked", reason: "Monid answered 503 (Service unavailable)" });
  assert.deepEqual(await outcome(json(429, { message: "Too many requests" })), { state: "not_checked", reason: "Monid answered 429 (Too many requests)" });
  assert.deepEqual(await outcome(json(404, {})), { state: "not_checked", reason: "Monid answered 404" });
  const down = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };
  assert.deepEqual(await outcome(down), { state: "not_checked", reason: "Monid could not be reached (ECONNREFUSED)" });
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  // A server keeps its process alive while it waits; AbortSignal.timeout's timer alone does not, so this test does.
  const alive = setTimeout(() => undefined, 5_000);
  const started = Date.now();
  assert.deepEqual(await outcome(hang, { ms: 50 }), { state: "not_checked", reason: "Monid did not answer in 0.05 s" });
  assert.ok(Date.now() - started < 5_000, "the deadline holds");
  clearTimeout(alive);
  // No call that costs nothing for a provider, or no fetch (a faux server with no fake for it): never the network.
  assert.deepEqual(await outcome(undefined, { row: { id: "elsewhere", label: "Elsewhere" } }), { state: "not_checked", reason: "Elsewhere has no call that costs nothing to check a key with" });
  assert.deepEqual(await outcome(undefined, { fetcher: null }), { state: "not_checked", reason: "This server runs on faux providers and has no fake Monid to check the key with" });
});
