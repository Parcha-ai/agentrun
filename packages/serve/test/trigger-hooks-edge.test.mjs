// The token-less route's edges, through the API on raw requests (no client folds a path here): nothing but
// POST /v2/hooks/{id} is answered without the token; malformed webhook headers are the same 401, never a 500; the
// signature covers the raw bytes, whatever their type; the 401's log line carries none of the request; and a message a
// run already took is not sent again after a restart, nor does it open the run.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { ROUTES } from "../dist/server.js";
import { call, follow, scratch, serve, withEnv } from "./support.mjs";
import { firings, made } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const HOOK_401 = { code: "unauthenticated", message: "this route needs a request signed by the webhook trigger's secret", retryable: false };
const hooked = (agentId) => ({ name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this event." }, max_cost_usd: 0.5 } });

/** Standard Webhooks headers for `body`, signed by `secret`, as the spec's library makes them. */
function signed(secret, body, id = `msg_${randomBytes(8).toString("hex")}`, at = Math.floor(Date.now() / 1000)) {
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": new Webhook(secret).sign(id, new Date(at * 1000), body) };
}
const port = (baseUrl) => Number(new URL(baseUrl).port);
/** A raw request, its failure named by the request. */
const raw = (at, request) => call(at, request).catch((error) => assert.fail(`${request.method} ${request.path}: ${error.message}`));
const errorOf = (answer) => {
  const { request_id: _, ...error } = answer.json?.error ?? {};
  return error;
};

test("no route but POST /v2/hooks/{id} (and capabilities, the document and health) answers without the token: every other operation is 401, and a path that only looks like a hook is never served", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const { id, secret } = (await api("POST", "/triggers", hooked("triage"))).body;
  const at = port(baseUrl);
  const open = new Set(["getCapabilities", "getOpenapi", "getHealth", "receiveHook"]);
  for (const route of ROUTES) {
    const path = `/v2${route.pattern.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/").replace(/\\\./g, ".").replace(/\(\[\^\/\]\+\)|\(\.\+\)/g, "x-id")}`;
    const answer = await raw(at, { method: route.method, path, headers: { "content-type": "application/json" }, body: ["POST", "PUT", "PATCH"].includes(route.method) ? "{}" : undefined });
    if (open.has(route.name)) assert.notEqual(answer.status, 500, `${route.name} ${path}`);
    else assert.equal(answer.status, 401, `${route.method} ${path} (${route.name}) needs the token: ${answer.text.slice(0, 200)}`);
  }
  const body = "{}";
  const cases = [
    ["POST", `/v2/hooks/${id}/../../agents`],
    ["GET", `/v2/hooks/${id}/../../agents`],
    ["POST", "/v2/hooks"],
    ["POST", "/v2/hooks/"],
    ["POST", "/v2/hooksx/../agents"],
    ["GET", "/v2/hooksx/../agents"],
    ["POST", `/v2/hooks/${id}%2F..%2F..%2Fagents`],
    ["POST", "/v2/hooks/%2e%2e%2fagents"],
    ["POST", "/v2/hooks/%2E%2E"],
    ["POST", `/v2/hooks/${id}/`],
    ["POST", `/v2//hooks/${id}`],
    ["POST", `//v2/hooks/${id}`],
    ["POST", `/v2/hooks//${id}`],
    ["GET", `/v2/hooks/${id}`],
    ["PUT", `/v2/hooks/${id}`],
    ["PATCH", `/v2/hooks/${id}`],
    ["DELETE", `/v2/hooks/${id}`],
    ["HEAD", `/v2/hooks/${id}`],
  ];
  for (const [method, path] of cases) {
    const answer = await raw(at, { method, path, headers: { "content-type": "application/json", ...signed(secret, body) }, body: ["POST", "PUT", "PATCH"].includes(method) ? body : undefined });
    assert.ok([401, 404, 405].includes(answer.status), `${method} ${path}: ${answer.status} ${answer.text.slice(0, 200)}`);
    assert.ok(!/"agents"|"triggers"|"runs"/.test(answer.text), `${method} ${path} serves nothing: ${answer.text.slice(0, 200)}`);
  }
  // A query string is not the path: the hook is still the hook, and its signature still decides.
  const queried = await raw(at, { method: "POST", path: `/v2/hooks/${id}?then=/v2/agents`, headers: signed(secret, body), body });
  assert.equal(queried.status, 202, queried.text);
  assert.deepEqual(errorOf(await raw(at, { method: "POST", path: `/v2/hooks/${id}?x=1`, headers: signed(`whsec_${randomBytes(32).toString("base64")}`, body), body })), HOOK_401);
});

test("malformed, duplicated or oversized webhook headers, a webhook-id past 255 characters or holding control characters, a timestamp that is no integer and a signature list past its bound are the same 401, never a 500", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const { id, secret } = (await api("POST", "/triggers", hooked("triage"))).body;
  const at = port(baseUrl);
  const body = "{}";
  const good = signed(secret, body);
  const now = Math.floor(Date.now() / 1000);
  const longId = `msg_${"a".repeat(300)}`;
  const tabbed = "msg_\tone";
  const cases = {
    "no webhook-id": { ...good, "webhook-id": undefined },
    "no timestamp": { ...good, "webhook-timestamp": undefined },
    "no signature": { ...good, "webhook-signature": undefined },
    "a webhook-id past 255 characters, signed": signed(secret, body, longId),
    "a webhook-id with a tab, signed": signed(secret, body, tabbed),
    "a timestamp that is no integer": { ...good, "webhook-timestamp": `${now}.5` },
    "a timestamp in exponent form": { ...good, "webhook-timestamp": "1.7e9" },
    "an empty signature": { ...good, "webhook-signature": "" },
    "a signature of another version": { ...good, "webhook-signature": good["webhook-signature"].replace(/^v1,/, "v2,") },
    "a signature list past its bound, the good one last": { ...good, "webhook-signature": `${"v1,AAAA ".repeat(400)}${good["webhook-signature"]}` },
    "two webhook-ids": { ...good, "webhook-id": [good["webhook-id"], "msg_other"] },
    "a very long webhook-id": { ...good, "webhook-id": "x".repeat(8_000) },
  };
  for (const [name, headers] of Object.entries(cases)) {
    const answer = await raw(at, { method: "POST", path: `/v2/hooks/${id}`, headers, body });
    assert.equal(answer.status, 401, `${name}: ${answer.text.slice(0, 200)}`);
    assert.deepEqual(errorOf(answer), HOOK_401, name);
  }
  const huge = await raw(at, { method: "POST", path: `/v2/hooks/${id}`, headers: { ...good, "webhook-signature": "v1,".padEnd(40_000, "A") }, body });
  assert.ok(huge.status === 431 || huge.status === 401, `headers past Node's own bound: ${huge.status}`);
  assert.deepEqual((await api("GET", `/triggers/${id}/firings`)).body.firings, [], "none fired");
});

test("the signature covers the exact bytes: a body serialised again differently fails; the content type is not trusted; a signed body that is no JSON fires with its raw text as the payload; the 401's log line holds no signature, secret or body", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const lines = [];
  const { api, baseUrl, data } = await serve(t, { log: (line) => lines.push(line) });
  await made(api, "triage");
  const { id, secret } = (await api("POST", "/triggers", hooked("triage"))).body;
  const at = port(baseUrl);
  const sent = '{"a":1,"marker":"BODY-MARKER-1"}';
  const headers = signed(secret, sent);
  const respaced = await raw(at, { method: "POST", path: `/v2/hooks/${id}`, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(JSON.parse(sent), null, 1) });
  assert.equal(respaced.status, 401, "the same JSON, other bytes");
  const logged = lines.join("\n");
  for (const held of [headers["webhook-signature"].slice(3), secret, secret.slice("whsec_".length), "BODY-MARKER-1"]) assert.ok(!logged.includes(held), `the log holds no ${held.slice(0, 12)}...`);
  assert.ok(lines.some((line) => /event=auth_failed/.test(line) && /reason=bad_signature/.test(line)), "the refusal is logged, with why");

  // Each fires once the last run has ended: a firing while it works is skipped.
  const text = "plain <b>words</b>, not JSON";
  for (const [n, type] of ["text/plain", undefined, "application/json"].entries()) {
    const answer = await raw(at, { method: "POST", path: `/v2/hooks/${id}`, headers: { ...(type ? { "content-type": type } : {}), ...signed(secret, text) }, body: text });
    assert.equal(answer.status, 202, `${type}: ${answer.text}`);
    const [firing] = await firings(api, id, n + 1);
    assert.equal(firing.status, "started", `${type}: ${JSON.stringify(firing)}`);
    const { content } = JSON.parse(await readFile(join(data, "runs", firing.run_id, "serve.json"), "utf8")).input;
    assert.ok(content.includes(`<trigger-payload source="webhook" untrusted>\n${text}\n</trigger-payload>`), content);
    await follow(api, firing.run_id, ["completed"]);
  }
});

test("a message a run already took, its firing left due by a restart, settles sent without sending it again or opening the completed run", { timeout: 180_000 }, async (t) => {
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data });
  await made(first.api, "chat");
  const run = (await first.api("POST", "/agents/chat/runs", { input: { content: "Say hello." } })).body;
  await follow(first.api, run.run_id, ["completed"]);
  const { id, secret } = (await first.api("POST", "/triggers", { name: "inbox", source: { kind: "webhook" }, target: { kind: "message_run", run_id: run.run_id, input: { content: "A new event came in." } } })).body;
  const body = '{"ticket":7}';
  assert.equal((await call(port(first.baseUrl), { method: "POST", path: `/v2/hooks/${id}`, headers: signed(secret, body), body })).status, 202);
  const [sent] = await firings(first.api, id, 1);
  assert.equal(sent.status, "sent");
  await follow(first.api, run.run_id, ["completed"]);
  await first.close();
  // The server went down after the run took the message and before the firing's write: it reads due.
  const file = join(data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  Object.assign(kept.triggers[0].firings[0], { status: "due", payload: body });
  delete kept.triggers[0].firings[0].run_id;
  await writeFile(file, JSON.stringify(kept));
  const second = await serve(t, { data });
  const [again] = await firings(second.api, id, 1);
  assert.deepEqual([again.status, again.run_id], ["sent", run.run_id]);
  const read = (await second.api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(read.status, "completed", "not opened again");
  const { rows } = await follow(second.api, run.run_id, ["completed"]);
  assert.equal(rows.filter((row) => row.kind === "user_message").length, 2, "the message once");
});
