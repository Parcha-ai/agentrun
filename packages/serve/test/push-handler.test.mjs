// One push handler serves every pushed trigger source (push-handler.ts): its route, its pre-auth check and its order
// come from the registry, so a source that pushes is one adapter and nothing in server.ts. Every refusal is the one 401;
// a request that is verified but does not parse is answered 200 and said, never swallowed; a path that does not decode
// is said as such.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
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

/** A pushed source no other code knows of: one server-wide signing secret (its settings), and a body that names its
 *  trigger, its event's id and its text. */
const ping = {
  id: "ping", label: "ping trigger", delivery: "push", owner: false,
  describe: '{kind: "ping"}', fires: "a ping", schemas: [],
  settings: { scope: "server", fields: { signing: { minBytes: MIN_KEY_BYTES } } },
  push: {
    maxBodyBytes: 4096,
    key: "signing",
    headers: headersRefusal,
    verify,
    parse(_headers, body) {
      try {
        const doc = JSON.parse(body.toString("utf8"));
        return typeof doc.trigger === "string" && typeof doc.id === "string" && typeof doc.text === "string" ? { triggerId: doc.trigger, eventId: doc.id, payload: doc.text } : undefined;
      } catch {
        return undefined;
      }
    },
  },
  parse: (value, _now, _bad, issues) => (issues.push(...Object.keys(value).filter((k) => k !== "kind").map((k) => ({ field: `source.${k}`, reason: "not_allowed", message: k }))), { kind: "ping" }),
  wellFormed: () => true,
};

/** A request to `path` with `body`, signed by `secret` (or carrying `headers` as given). */
async function post(baseUrl, path, body, { secret, headers } = {}) {
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const at = Math.floor(Date.now() / 1000);
  const signed = headers ?? { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": new Webhook(secret).sign(id, new Date(at * 1000), body) };
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...signed }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  const made = await api("POST", "/triggers", { name: "pings", source: { kind: "ping" }, target: { kind: "start_run", agent_id: "pinged", input: { content: "A ping." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const body = JSON.stringify({ trigger: made.body.id, id: "evt-1", text: "hello" });
  const first = await post(server.baseUrl, "/hooks/ping", body, { secret });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual([first.body.by, first.body.status], ["ping", "due"]);
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
  const nobody = await post(server.baseUrl, "/hooks/ping", JSON.stringify({ trigger: "trg_000000000000000000000000", id: "evt-2", text: "hi" }), { secret });
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
