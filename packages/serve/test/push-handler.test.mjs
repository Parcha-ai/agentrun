// One push handler serves every pushed trigger source (push-handler.ts): its route, its pre-auth check and its order
// come from the registry, so a source that pushes is one adapter and nothing in server.ts. Every refusal is the one 401;
// a request that is verified but does not parse is answered 200 and said, never swallowed; a path that does not decode
// is said as such.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { SealedSettings } from "../dist/sealed-settings.js";
import { headersRefusal, MIN_KEY_BYTES, verify } from "../dist/standard-webhooks.js";
import { TRIGGER_ADAPTERS } from "../dist/trigger-adapters.js";
import { agent, client, FAUX, scratch, withEnv } from "./support.mjs";
import { firings } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const sealKey = randomBytes(32);
const SEAL = { AGENTRUN_SEAL_KEY: sealKey.toString("base64") };

/** A pushed source no other code knows of: one server-wide signing secret (its settings); its triggers each listen on a
 *  channel (its scope), and a body is a list of events, each with its id, its channel and its text. */
const ping = {
  id: "ping", label: "ping trigger", delivery: "push", owner: false,
  describe: '{kind: "ping"}', fires: "a ping", schemas: [],
  settings: { scope: "server", fields: { signing: { minBytes: MIN_KEY_BYTES } } },
  push: {
    maxBodyBytes: 4096,
    key: "signing",
    headers: headersRefusal,
    verify,
    // A sender's URL check: a challenge is echoed, after the request's check, never before it.
    handshake(_headers, body) {
      try {
        const doc = JSON.parse(body.toString("utf8"));
        return typeof doc.challenge === "string" ? { status: 200, body: { challenge: doc.challenge } } : undefined;
      } catch {
        return undefined;
      }
    },
    parse(_headers, body) {
      try {
        const doc = JSON.parse(body.toString("utf8"));
        return Array.isArray(doc.events) ? doc.events.filter((e) => typeof e.id === "string" && typeof e.channel === "string" && typeof e.text === "string").map((e) => ({ key: e.id, text: e.text, scope: e.channel })) : [];
      } catch {
        return [];
      }
    },
  },
  scopeOf: (source) => source.channel,
  parse: (value, _now, bad, issues) => {
    issues.push(...Object.keys(value).filter((k) => k !== "kind" && k !== "channel").map((k) => ({ field: `source.${k}`, reason: "not_allowed", message: k })));
    if (typeof value.channel !== "string") return bad("channel", "missing", "channel is a string"), undefined;
    return { kind: "ping", channel: value.channel };
  },
  wellFormed: (source) => typeof source.channel === "string",
};

/** A request to `path` with `body`, signed by `secret` (or carrying `headers` as given). */
async function post(baseUrl, path, body, { secret, headers } = {}) {
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const at = Math.floor(Date.now() / 1000);
  const signed = headers ?? { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": new Webhook(secret).sign(id, new Date(at * 1000), body) };
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...signed }, body });
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.json().catch(() => null) };
}

async function pingServer(t) {
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  new SealedSettings(data, "ping", ping.settings, sealKey, () => {}).set("server", "signing", secret);
  const lines = [];
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", triggerAdapters: [...TRIGGER_ADAPTERS, ping], log: (line) => lines.push(line) });
  t.after(() => server.close());
  return { server, api: client(server.baseUrl, server.token), secret, lines };
}

test("a pushed source is one adapter: served at /v2/hooks/<its id> with no token and no edit of the server, verified with its own settings, and its event fires its trigger once", { timeout: 120_000 }, async (t) => {
  const { server, api, secret } = await pingServer(t);
  assert.equal((await api("POST", "/agents", agent("pinged"))).status, 201);
  const made = await api("POST", "/triggers", { name: "pings", source: { kind: "ping", channel: "c1" }, target: { kind: "start_run", agent_id: "pinged", input: { content: "A ping." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const body = JSON.stringify({ events: [{ id: "evt-1", channel: "c1", text: "hello" }] });
  const first = await post(server.baseUrl, "/hooks/ping", body, { secret });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual(first.body.firings.map((f) => [f.by, f.status]), [["ping", "due"]]);
  assert.equal((await post(server.baseUrl, "/hooks/ping", body, { secret })).status, 200, "the same event again is its firing");
  const [fired] = await firings(api, made.body.id, 1);
  assert.equal(fired.status, "started", JSON.stringify(fired));
  const wrong = await post(server.baseUrl, "/hooks/ping", body, { secret: `whsec_${randomBytes(32).toString("base64")}` });
  assert.deepEqual([wrong.status, wrong.body?.error?.code], [401, "unauthenticated"], "another secret is the one 401");
});

test("a verified request whose body does not parse is answered 200 and said, never swallowed; one that names no trigger of its source too", { timeout: 120_000 }, async (t) => {
  const { server, secret, lines } = await pingServer(t);
  const unparsed = await post(server.baseUrl, "/hooks/ping", "not json", { secret });
  assert.equal(unparsed.status, 200, JSON.stringify(unparsed.body));
  assert.ok(lines.some((line) => line.includes("condition=hook_unparsed") && line.includes("ping")), `said: ${JSON.stringify(lines)}`);
  const nobody = await post(server.baseUrl, "/hooks/ping", JSON.stringify({ events: [{ id: "evt-2", channel: "nobody-listens", text: "hi" }] }), { secret });
  assert.equal(nobody.status, 200, JSON.stringify(nobody.body));
  assert.ok(lines.some((line) => line.includes("condition=hook_no_trigger")), `said: ${JSON.stringify(lines)}`);
});

test("a hook path that does not decode is the one 401, said as a malformed path, never as no webhook trigger", { timeout: 60_000 }, async (t) => {
  const { server, lines } = await pingServer(t);
  const res = await post(server.baseUrl, "/hooks/%E0%A4%A", "{}", { secret: `whsec_${randomBytes(32).toString("base64")}` });
  assert.deepEqual([res.status, res.body?.error?.code], [401, "unauthenticated"]);
  const said = lines.filter((line) => line.includes("auth_failed"));
  assert.ok(said.some((line) => line.includes("reason=malformed_path")), `said: ${JSON.stringify(said)}`);
  assert.ok(!said.some((line) => line.includes("reason=no_webhook_trigger")), `not as no webhook trigger: ${JSON.stringify(said)}`);
});

test("an unknown trigger, or one that is off, on a trigger's own hook path is the one 401, the same as a bad signature: no trigger id is found by asking; only a server-wide source says, after its check, that no trigger takes an event", { timeout: 120_000 }, async (t) => {
  const { server, api, secret: pingSecret, lines } = await pingServer(t);
  assert.equal((await api("POST", "/agents", agent("hooked"))).status, 201);
  const made = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hooked", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const bad = await post(server.baseUrl, `/hooks/${made.body.id}`, "{}", { secret: `whsec_${randomBytes(32).toString("base64")}` });
  const unknown = await post(server.baseUrl, "/hooks/trg_000000000000000000000000", "{}", { secret: made.body.secret });
  assert.equal((await api("PATCH", `/triggers/${made.body.id}`, { enabled: false })).status, 200);
  const off = await post(server.baseUrl, `/hooks/${made.body.id}`, "{}", { secret: made.body.secret });
  // All of the answer but what differs by request: its time and its request id.
  const strip = (answer) => ({ status: answer.status, headers: { ...answer.headers, date: undefined, "x-request-id": undefined }, error: { ...answer.body.error, request_id: undefined } });
  assert.deepEqual([strip(unknown), strip(off)], [strip(bad), strip(bad)], "the same 401, body and all");
  assert.equal(bad.status, 401);
  const nobody = await post(server.baseUrl, "/hooks/ping", JSON.stringify({ events: [{ id: "evt-3", channel: "nobody-listens", text: "hi" }] }), { secret: pingSecret });
  assert.equal(nobody.status, 200, "a server-wide source, checked: it says no trigger takes it");
  assert.ok(lines.some((line) => line.includes("condition=hook_no_trigger")));
});

test("a scope belongs to one trigger: a second trigger of a server-wide source on a scope another enabled one listens on is 409 scope_taken, naming it; off, it may share, and turned on it is refused the same", { timeout: 120_000 }, async (t) => {
  const { api } = await pingServer(t);
  assert.equal((await api("POST", "/agents", agent("pinged"))).status, 201);
  const body = (channel, extra = {}) => ({ name: "pings", source: { kind: "ping", channel }, target: { kind: "start_run", agent_id: "pinged", input: { content: "A ping." }, max_cost_usd: 0.5 }, ...extra });
  const first = await api("POST", "/triggers", body("c1"));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await api("POST", "/triggers", body("c1"));
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error.code, "scope_taken");
  assert.deepEqual(second.body.error.details, { source: "ping", scope: "c1", trigger_id: first.body.id });
  assert.match(second.body.error.message, new RegExp(first.body.id));
  const off = await api("POST", "/triggers", body("c1", { enabled: false }));
  assert.equal(off.status, 201, "off, it listens on nothing");
  const on = await api("PATCH", `/triggers/${off.body.id}`, { enabled: true });
  assert.deepEqual([on.status, on.body.error?.code], [409, "scope_taken"]);
  const elsewhere = await api("POST", "/triggers", body("c2"));
  assert.equal(elsewhere.status, 201);
  const moved = await api("PATCH", `/triggers/${elsewhere.body.id}`, { source: { kind: "ping", channel: "c1" } });
  assert.deepEqual([moved.status, moved.body.error?.code], [409, "scope_taken"], "moved onto a taken scope, refused");
});

test("an event whose scope more than one trigger listens on (a file edited by hand) fires none: 200, said with their ids", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  new SealedSettings(data, "ping", ping.settings, sealKey, () => {}).set("server", "signing", secret);
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", triggerAdapters: [...TRIGGER_ADAPTERS, ping] });
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("pinged"))).status, 201);
  const body = (channel) => ({ name: "pings", source: { kind: "ping", channel }, target: { kind: "start_run", agent_id: "pinged", input: { content: "A ping." }, max_cost_usd: 0.5 } });
  const a = (await api("POST", "/triggers", body("c1"))).body;
  const b = (await api("POST", "/triggers", body("c2"))).body;
  await first.close();
  const file = join(data, "triggers.json");
  const doc = JSON.parse(await readFile(file, "utf8"));
  doc.triggers.find((x) => x.id === b.id).source.channel = "c1";
  await writeFile(file, `${JSON.stringify(doc)}\n`);
  const lines = [];
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", triggerAdapters: [...TRIGGER_ADAPTERS, ping], log: (line) => lines.push(line) });
  t.after(() => next.close());
  const res = await post(next.baseUrl, "/hooks/ping", JSON.stringify({ events: [{ id: "evt-9", channel: "c1", text: "hi" }] }), { secret });
  assert.deepEqual([res.status, res.body.firings], [200, []], JSON.stringify(res.body));
  const said = lines.filter((line) => line.includes("condition=hook_scope_ambiguous"));
  assert.equal(said.length, 1, JSON.stringify(lines));
  assert.ok(said[0].includes(a.id) && said[0].includes(b.id), said[0]);
  const nextApi = client(next.baseUrl, next.token);
  for (const id of [a.id, b.id]) assert.deepEqual((await nextApi("GET", `/triggers/${id}/firings`)).body.firings, [], "fired none");
});

test("a hook body over its source's cap is 413 at once, its socket closed, never read to its end: declared up front, or counted as it streams", { timeout: 60_000 }, async (t) => {
  const { server } = await pingServer(t);
  const { port } = new URL(server.baseUrl);
  const host = new URL(server.baseUrl).hostname;
  const ask = (headers, first) => new Promise((resolve, reject) => {
    const socket = connect(Number(port), host);
    let answer = "";
    socket.on("data", (chunk) => (answer += chunk));
    socket.on("close", () => resolve(answer));
    socket.on("error", reject);
    // Declared 10 MiB; only a first piece is ever sent, the rest held back: an answer and a close mean the body was not read.
    socket.write(`POST /v2/hooks/ping HTTP/1.1\r\nHost: ${host}\r\nwebhook-id: msg_big\r\nwebhook-timestamp: ${Math.floor(Date.now() / 1000)}\r\nwebhook-signature: v1,AAAA\r\ncontent-type: application/json\r\n${headers}\r\n`);
    socket.write(first);
    setTimeout(() => reject(new Error(`no answer and close within 5 s: ${answer}`)), 5_000).unref();
  });
  const declared = await ask(`content-length: ${10 << 20}\r\n`, "x".repeat(1024));
  assert.match(declared, /^HTTP\/1\.1 413 /, declared);
  const streamed = await ask("transfer-encoding: chunked\r\n", `${(8192).toString(16)}\r\n${"x".repeat(8192)}\r\n`);
  assert.match(streamed, /^HTTP\/1\.1 413 /, streamed);
});

test("a source's handshake answers only a request that passed its check: an unsigned challenge is the one 401, a signed one is echoed", { timeout: 60_000 }, async (t) => {
  const { server, secret } = await pingServer(t);
  const challenge = JSON.stringify({ challenge: "c-123" });
  const unsigned = await post(server.baseUrl, "/hooks/ping", challenge, { headers: { "webhook-id": "msg_c", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" } });
  assert.deepEqual([unsigned.status, unsigned.body?.error?.code], [401, "unauthenticated"], "never answered before the check");
  const signed = await post(server.baseUrl, "/hooks/ping", challenge, { secret });
  assert.deepEqual([signed.status, signed.body], [200, { challenge: "c-123" }]);
});
