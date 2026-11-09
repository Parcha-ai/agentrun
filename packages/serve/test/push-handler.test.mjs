// One push handler serves every pushed trigger source (push-handler.ts): its route, its pre-auth check and its order
// come from the registry, so a source that pushes is one adapter and nothing in server.ts. Every refusal is the one 401;
// a request that is verified but does not parse is answered 200 and said, never swallowed; a path that does not decode
// is said as such.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { SealedSettings } from "../dist/sealed-settings.js";
import { headersRefusal, MIN_KEY_BYTES, verify } from "../dist/standard-webhooks.js";
import { openapiDocument } from "../dist/openapi.js";
import { TRIGGER_ADAPTERS } from "../dist/trigger-adapters.js";
import { schemaProblems } from "./schema-support.mjs";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { agent, client, FAUX, scratch, withEnv } from "./support.mjs";
import { firings, RUN_EXEC } from "./trigger-support.mjs";

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
        // A body its source's own filter does not take.
        if (doc.ignore === true) return { ignored: "filtered" };
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

/** A server whose triggers live in a store of their own (createServer's store), with an api whose POST /agents also puts
 *  the agent in that store, where a trigger's row names it. Until the server opens its own store, a firing that starts a
 *  run needs the run port's insert into it: those cases wait on running the fired run on a runner. */
async function storedServe(t, options) {
  const store = await openSqliteStore({ file: join(await scratch(t), "store.sqlite"), role: "server" });
  const server = await startServe({ port: 0, faux: FAUX, drainTimeout: "5s", ...options, store });
  // The server first, then its store: after-hooks run in the order they were added.
  t.after(async () => {
    await server.close();
    await store.close();
  });
  const raw = client(server.baseUrl, server.token);
  const api = async (method, path, body, ...rest) => {
    const res = await raw(method, path, body, ...rest);
    // The agent's id is its definition's (support.mjs agent()), whatever the answer's shape.
    const id = body?.definition?.id;
    if (method === "POST" && path === "/agents" && res.status === 201) await store.agents.create({ id, name: id }, { id: `rev-${id}`, kind: "agentic", body: {} });
    return res;
  };
  return { server, api, store };
}

async function pingServer(t) {
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  new SealedSettings(data, "ping", ping.settings, sealKey, () => {}).set("server", "signing", secret);
  const lines = [];
  const { server, api, store } = await storedServe(t, { data, triggerAdapters: [...TRIGGER_ADAPTERS, ping], log: (line) => lines.push(line) });
  return { server, api, store, secret, lines };
}

// Its event starts a run: the store's firing row names that run, which the server's start inserts into the store (run_id's foreign
// key). Until then this case is todo, never skipped: it still runs.
test("a pushed source is one adapter: served at /v2/hooks/<its id> with no token and no edit of the server, verified with its own settings, and its event fires its trigger once", { timeout: 120_000, skip: RUN_EXEC }, async (t) => {
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
  // A trigger's name is once per agent (409 name_taken): each a name of its own, so only the scope is in question.
  let named = 0;
  const body = (channel, extra = {}) => ({ name: `pings ${++named}`, source: { kind: "ping", channel }, target: { kind: "start_run", agent_id: "pinged", input: { content: "A ping." }, max_cost_usd: 0.5 }, ...extra });
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

test("a scope is never held by two enabled triggers, even by a hand in the store: its scope rows are keyed (kind, scope), so an event's scope never names two", { timeout: 120_000 }, async (t) => {
  // Was "an event whose scope more than one trigger listens on (a file edited by hand) fires none". The triggers live in
  // the store now, where the scope rows' key refuses a second trigger on a scope another holds.
  const { api, store } = await pingServer(t);
  assert.equal((await api("POST", "/agents", agent("pinged"))).status, 201);
  const body = (name, channel) => ({ name, source: { kind: "ping", channel }, target: { kind: "start_run", agent_id: "pinged", input: { content: "A ping." }, max_cost_usd: 0.5 } });
  const a = (await api("POST", "/triggers", body("pings a", "c1"))).body;
  const b = (await api("POST", "/triggers", body("pings b", "c2"))).body;
  assert.deepEqual(await store.triggers.scoped("ping", "c1"), [a.id]);
  await assert.rejects(store.triggers.update(b.id, { source: { kind: "ping", channel: "c1" } }, [{ kind: "ping", scope: "c1" }]), /UNIQUE constraint failed: trigger_scopes\.kind, trigger_scopes\.scope/);
  assert.deepEqual(await store.triggers.scoped("ping", "c1"), [a.id], "still the one trigger's");
  assert.deepEqual(await store.triggers.scoped("ping", "c2"), [b.id], "and the other kept its own");
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

test("a signature is checked against the clock when the body has arrived, not when its headers did: a timestamp at 299 s whose body takes 2 s more is the one 401", { timeout: 60_000 }, async (t) => {
  const { server, api } = await pingServer(t);
  assert.equal((await api("POST", "/agents", agent("hooked"))).status, 201);
  const made = await api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hooked", input: { content: "Hi." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { port, hostname: host } = new URL(server.baseUrl);
  const body = "{}";
  const at = Math.floor(Date.now() / 1000) - 299;
  const signature = new Webhook(made.body.secret).sign("msg_slow", new Date(at * 1000), body);
  const answer = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), host);
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
    socket.write(`POST /v2/hooks/${made.body.id} HTTP/1.1\r\nHost: ${host}\r\nwebhook-id: msg_slow\r\nwebhook-timestamp: ${at}\r\nwebhook-signature: ${signature}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`);
    // The body held back past the tolerance's edge.
    setTimeout(() => socket.write(body), 2_500).unref();
    setTimeout(() => reject(new Error(`no answer within 15 s: ${text}`)), 15_000).unref();
  });
  assert.match(answer, /^HTTP\/1\.1 401 /, answer);
});

// Its events start runs on a runner (dispatch and command delivery): the case waits on that, as the one above.
test("a trigger's own hook path takes every event its source parses from one request: each is its own firing, and the answer lists them", { timeout: 120_000, skip: RUN_EXEC }, async (t) => {
  // A source whose settings are a trigger's and whose request holds a list of events, each with its id.
  const pair = {
    id: "pair", label: "pair trigger", delivery: "push", owner: false, describe: '{kind: "pair"}', fires: "a pair", schemas: [],
    settings: { scope: "trigger", fields: { secret: { mint: true, minBytes: MIN_KEY_BYTES } } },
    push: {
      maxBodyBytes: 4096, key: "secret", headers: headersRefusal, verify,
      parse(_headers, body) {
        try {
          return JSON.parse(body.toString("utf8")).events.map((e) => ({ key: e.id, text: e.text }));
        } catch {
          return [];
        }
      },
    },
    parse: (value, _now, _bad, issues) => (issues.push(...Object.keys(value).filter((k) => k !== "kind").map((k) => ({ field: `source.${k}`, reason: "not_allowed", message: k }))), { kind: "pair" }),
    wellFormed: () => true,
  };
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  const { server, api } = await storedServe(t, { data, triggerAdapters: [TRIGGER_ADAPTERS.find((a) => a.id === "schedule"), pair] });
  assert.equal((await api("POST", "/agents", agent("paired"))).status, 201);
  const made = await api("POST", "/triggers", { name: "pairs", source: { kind: "pair" }, target: { kind: "start_run", agent_id: "paired", input: { content: "A pair." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const res = await post(server.baseUrl, `/hooks/${made.body.id}`, JSON.stringify({ events: [{ id: "e-1", text: "one" }, { id: "e-2", text: "two" }] }), { secret: made.body.secret });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.firings?.map((f) => f.by), ["pair", "pair"], JSON.stringify(res.body));
  assert.equal((await firings(api, made.body.id, 2)).length, 2, "each event its own firing");
});

test("the document shows each server-wide pushed source's hook in the registry, with its own answer and limits; every hook documents its 408", async () => {
  // A registry member, not a test's own array: the registry's sources are documented as the server serves them.
  TRIGGER_ADAPTERS.push(ping);
  try {
    const doc = openapiDocument(() => undefined);
    const hook = doc.paths["/hooks/ping"]?.post;
    assert.ok(hook, `documented: ${Object.keys(doc.paths).filter((p) => p.startsWith("/hooks")).join(", ")}`);
    const accepted = hook.responses["202"].content["application/json"].schema;
    assert.ok(JSON.stringify(accepted).includes("firings"), `its own answer, the firings it made: ${JSON.stringify(accepted)}`);
    assert.ok(hook.description.includes(String(ping.push.maxBodyBytes)), "its own body limit");
    assert.ok(!hook.description.includes("webhook-id"), "no other source's headers");
    for (const path of ["/hooks/{trigger_id}", "/hooks/ping"]) assert.ok(doc.paths[path].post.responses["408"], `${path}: its 408`);
  } finally {
    TRIGGER_ADAPTERS.splice(TRIGGER_ADAPTERS.indexOf(ping), 1);
  }
});

test("with no log, what the push handler says goes to stderr, as the triggers' own lines do", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  new SealedSettings(data, "ping", ping.settings, sealKey, () => {}).set("server", "signing", secret);
  const { server } = await storedServe(t, { data, triggerAdapters: [...TRIGGER_ADAPTERS, ping] });
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (written.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
  try {
    assert.equal((await post(server.baseUrl, "/hooks/ping", "not json", { secret })).status, 200);
  } finally {
    process.stderr.write = write;
  }
  assert.ok(written.some((line) => line.includes("condition=hook_unparsed")), `said on stderr: ${JSON.stringify(written)}`);
});

test("a server-wide source's hook answers as its document says, with the trigger hook's own shapes: a request its source does not take is 200 {ok: ignored}, and a firing may be {ok: duplicate}", { timeout: 60_000 }, async (t) => {
  const { server, secret, lines } = await pingServer(t);
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  const answer = (path) => doc.paths[path].post.responses["200"].content["application/json"].schema;
  const options = (schema) => schema.oneOf ?? schema.anyOf ?? [schema];
  const [own, hook] = [answer("/hooks/{trigger_id}"), answer("/hooks/ping")];
  const shape = (ok) => options(own).find((o) => o.properties?.ok?.const === ok);
  assert.ok(shape("ignored") && shape("duplicate"), "the trigger hook names both");
  assert.ok(options(hook).some((o) => JSON.stringify(o) === JSON.stringify(shape("ignored"))), `the source's hook names the same ignored shape: ${JSON.stringify(hook).slice(0, 400)}`);
  const listed = options(hook).find((o) => o.properties?.firings);
  assert.ok(options(listed.properties.firings.items).some((o) => JSON.stringify(o) === JSON.stringify(shape("duplicate"))), "and a firing may be the same duplicate shape");
  const ignored = await post(server.baseUrl, "/hooks/ping", JSON.stringify({ ignore: true }), { secret });
  assert.deepEqual([ignored.status, ignored.body], [200, { ok: "ignored" }]);
  assert.ok(lines.some((line) => line.includes("condition=hook_ignored") && line.includes("source=ping")), "said");
  const unparsed = await post(server.baseUrl, "/hooks/ping", "not json", { secret });
  for (const body of [ignored.body, unparsed.body, { firings: [{ ok: "duplicate" }] }, { challenge: "c-1" }]) assert.deepEqual(schemaProblems(doc, hook, body), [], JSON.stringify(body));
});

test("a server-wide hook's documented answers are its own: its firings' by names its source, and a firings answer and a handshake answer each match exactly one of its 200's shapes", () => {
  const doc = openapiDocument(() => undefined, [...TRIGGER_ADAPTERS, ping]);
  const responses = doc.paths["/hooks/ping"].post.responses;
  const body = (code) => responses[code].content["application/json"].schema;
  // A firings item is a firing, or the duplicate answer for a key seen within its day: the firing's by is read.
  const firingBy = (schema) => schema.properties.firings.items.oneOf.find((item) => item.properties.by).properties.by.enum;
  assert.ok(firingBy(body("202")).includes("ping"), JSON.stringify(firingBy(body("202"))));
  const firings = body("200").oneOf.find((part) => part.properties?.firings);
  assert.ok(firings && firingBy(firings).includes("ping"), JSON.stringify(body("200")));
  for (const answer of [{ firings: [] }, { challenge: "c-123" }, { ok: "ignored" }, { firings: [{ ok: "duplicate" }] }, { ok: true }, { ok: "ignored", challenge: "c-9" }]) assert.deepEqual(schemaProblems(doc, body("200"), answer), [], JSON.stringify(answer));
  assert.deepEqual(schemaProblems(doc, body("200"), { ok: "maybe" }), [], "an ok answer of the source's own is a handshake");
});
