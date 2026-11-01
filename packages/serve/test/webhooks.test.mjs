// The webhook: one URL the server POSTs to, signed, when a run comes to need its person and when it ends. Its secret
// is made by the server, shown once, and kept sealed; a delivery not answered 2xx is tried again, then logged as
// failed, and a pending one goes on after a restart.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, follow, scratch, serve, startRun, withEnv } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sealKey = () => randomBytes(32).toString("base64");
const SEAL = ["AGENTRUN_SEAL_KEY"];

/** A receiver on 127.0.0.1 at a port of its own: each request to its own path, with its headers and body, answered
 *  `answer(n)` (n from 1). A request to another path (another process's, at a port it once had) is not counted. `down`:
 *  every connection is reset, as a receiver that is not there. */
async function receiver(t, answer = () => 200, down = false) {
  const got = [];
  const path = `/hook/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (down) return void req.socket.destroy();
    if (req.url !== path) return void res.writeHead(404).end();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const status = answer(got.length);
      res.writeHead(status, status >= 300 && status < 400 ? { location: "http://127.0.0.1:1/elsewhere" } : {}).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  return { url: `http://127.0.0.1:${server.address().port}${path}`, got, server };
}

/** Until `check()` is truthy, every 50 ms, for at most `ms`. */
async function until(check, what, ms = 20_000) {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, `waited for ${what}`);
  }
}

/** A receiver's own check of a delivery: the HMAC-SHA256 of `<timestamp>.<body>` under `secret`, as `v1=<hex>`. */
const verifies = (secret, { headers, body }) => headers["x-agentrun-signature"] === `v1=${createHmac("sha256", secret).update(`${headers["x-agentrun-timestamp"]}.${body}`).digest("hex")}`;
const ofEvent = (got, event) => got.filter((r) => r.headers["x-agentrun-event"] === event);

async function meetsDocument(api, path, method, status, value) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[status].content["application/json"].schema, value), [], JSON.stringify(value));
}

/** Every file under `dir`, read. */
const filesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name)));

test("demo: a run that ends and a run that asks its person each POST a signed notice; a wrong secret does not verify; the secret is in no GET and on disk only sealed", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const lines = [];
  const { api, data } = await serve(t, { log: (line) => lines.push(line) });
  assert.deepEqual((await api("GET", "/settings/webhook")).body, { configured: false });
  const set = await api("PUT", "/settings/webhook", { url: hook.url });
  assert.equal(set.status, 201, JSON.stringify(set.body));
  const { secret } = set.body;
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ ...set.body, secret: undefined, updated_at: undefined }, { configured: true, url: hook.url, events: ["run.needs_input", "run.ended"], signing: "sealed", secret: undefined, updated_at: undefined });
  await meetsDocument(api, "/settings/webhook", "put", "201", set.body);

  // A run that answers: one run.ended, when it is carried back.
  const done = await startRun(api, "answers", "hi");
  await follow(api, done.run_id, ["completed"]);
  const [ended] = await until(() => ofEvent(hook.got, "run.ended").length && ofEvent(hook.got, "run.ended"), "run.ended");
  const notice = JSON.parse(ended.body);
  assert.deepEqual(Object.keys(notice).sort(), ["at", "event", "id", "run"]);
  assert.deepEqual([notice.event, notice.run], ["run.ended", { run_id: done.run_id, agent_id: "answers", status: "completed", title: "hi" }]);
  assert.match(notice.id, /^evt_[0-9a-f]{32}$/);
  assert.equal(ended.method, "POST");
  assert.equal(ended.headers["content-type"], "application/json");
  assert.match(ended.headers["x-agentrun-delivery"], /^dlv_[0-9a-f]{32}$/);
  assert.ok(Math.abs(Number(ended.headers["x-agentrun-timestamp"]) - Date.now() / 1000) < 60, "a timestamp to refuse a replay by");
  assert.ok(verifies(secret, ended), "the receiver's check with the secret verifies");
  assert.ok(!verifies(`whsec_${randomBytes(32).toString("base64url")}`, ended), "a wrong secret does not");
  assert.ok(!verifies(secret, { ...ended, body: ended.body.replace("completed", "failed") }), "nor a changed body");
  assert.ok(!verifies(secret, { ...ended, headers: { ...ended.headers, "x-agentrun-timestamp": String(Number(ended.headers["x-agentrun-timestamp"]) - 600) } }), "nor another time");

  // A run that asks: run.needs_input when it waits for its person, then run.ended once answered.
  const asks = await startRun(api, "asks", "Pick a region.", { tools: ["ask_person"] });
  await follow(api, asks.run_id, ["input_required"]);
  const [waiting] = await until(() => ofEvent(hook.got, "run.needs_input").length && ofEvent(hook.got, "run.needs_input"), "run.needs_input");
  assert.deepEqual(JSON.parse(waiting.body).run, { run_id: asks.run_id, agent_id: "asks", status: "input_required", title: "Pick a region." });
  assert.ok(verifies(secret, waiting));
  assert.equal((await api("POST", `/runs/${asks.run_id}/messages`, { content: "eu" })).status, 202);
  await follow(api, asks.run_id, ["completed"]);
  await until(() => ofEvent(hook.got, "run.ended").length === 2, "the second run.ended");
  assert.deepEqual(hook.got.map((r) => [r.headers["x-agentrun-event"], JSON.parse(r.body).run.run_id]), [["run.ended", done.run_id], ["run.needs_input", asks.run_id], ["run.ended", asks.run_id]], "one each, no more");

  const { body: log } = await api("GET", "/settings/webhook/deliveries");
  assert.deepEqual(log.deliveries.map((d) => [d.event, d.status, d.attempts, d.status_code, d.error]), [["run.ended", "delivered", 1, 200, null], ["run.needs_input", "delivered", 1, 200, null], ["run.ended", "delivered", 1, 200, null]]);
  assert.deepEqual(log.deliveries.map((d) => d.id), hook.got.map((r) => r.headers["x-agentrun-delivery"]).reverse());
  await meetsDocument(api, "/settings/webhook/deliveries", "get", "200", log);

  // The secret: in no answer but the first PUT's, in no file of the data directory and in no log line.
  const view = await api("GET", "/settings/webhook");
  assert.deepEqual({ ...view.body, updated_at: undefined }, { configured: true, url: hook.url, events: ["run.needs_input", "run.ended"], signing: "sealed", updated_at: undefined });
  await meetsDocument(api, "/settings/webhook", "get", "200", view.body);
  const forms = [secret, secret.slice(6), Buffer.from(secret.slice(6), "base64url").toString("hex"), Buffer.from(secret.slice(6), "base64url").toString("base64")];
  for (const where of [JSON.stringify(view.body), JSON.stringify(log), lines.join("\n"), ...filesIn(data)]) for (const form of forms) assert.ok(!Buffer.from(where).includes(form), "the secret is nowhere in the clear");
  assert.equal(statSync(join(data, "webhook.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(data, "webhook-outbox.json")).mode & 0o777, 0o600);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url, events: ["run.ended"] })).body.secret, undefined, "a later PUT keeps the secret and never shows it");
});

test("a receiver that is down gets each try, then the delivery is logged as failed; one that fails then answers gets it on a try again; a redirect is not followed", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const lines = [];
  const { api } = await serve(t, { webhookRetryMs: [100, 100], log: (line) => lines.push(line) });
  const gone = await receiver(t, () => 200, true);
  assert.equal((await api("PUT", "/settings/webhook", { url: gone.url, events: ["run.ended"] })).status, 201);
  const down = await startRun(api, "down", "hi");
  await follow(api, down.run_id, ["completed"]);
  const failed = await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.deliveries.find((d) => d.status === "failed"), "the failed delivery");
  assert.deepEqual([failed.event, failed.run_id, failed.attempts, failed.status_code, failed.next_attempt_at], ["run.ended", down.run_id, 3, null, null]);
  assert.match(failed.error, /^not reached: /);
  assert.ok(lines.some((line) => line.includes("event=webhook") && line.includes("condition=delivery_failed") && line.includes(`delivery=${failed.id}`) && line.includes("attempts=3")), "the log says it failed");

  // Answered 503, then 200: delivered on the second try, the same delivery.
  const flaky = await receiver(t, (n) => (n === 1 ? 503 : 200));
  assert.equal((await api("PUT", "/settings/webhook", { url: flaky.url })).status, 200);
  const again = await startRun(api, "again", "hi");
  await follow(api, again.run_id, ["completed"]);
  await until(() => flaky.got.length === 2, "the try again");
  assert.equal(flaky.got[0].headers["x-agentrun-delivery"], flaky.got[1].headers["x-agentrun-delivery"]);
  assert.equal(flaky.got[0].body, flaky.got[1].body, "the same body, signed again");
  const latest = await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.deliveries.find((d) => d.run_id === again.run_id && d.status !== "pending"), "delivered");
  assert.deepEqual([latest.status, latest.attempts, latest.status_code, latest.error], ["delivered", 2, 200, null]);

  // A redirect is an answer that is not 2xx: tried again, never followed.
  const moved = await receiver(t, () => 302);
  assert.equal((await api("PUT", "/settings/webhook", { url: moved.url })).status, 200);
  const ping = await api("POST", "/settings/webhook/test", {});
  assert.equal(ping.status, 200);
  assert.deepEqual([ping.body.event, ping.body.status, ping.body.attempts, ping.body.status_code, ping.body.error], ["ping", "failed", 1, 302, "answered 302: a redirect is not followed"]);
  assert.equal(moved.got.length, 1, "a ping is tried once");
  await meetsDocument(api, "/settings/webhook/test", "post", "200", ping.body);
});

test("a delivery pending when its server stops goes on from the next one, with the same id; a run the next server reads as it already stood notices nothing", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let answer = 503;
  const hook = await receiver(t, () => answer);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", webhookRetryMs: [2_000] });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  const { body: set } = await api("PUT", "/settings/webhook", { url: hook.url });
  const run = await startRun(api, "pending", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => hook.got.length === 1, "the first try");
  const pending = await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.deliveries.find((d) => d.status === "pending" && d.attempts === 1 && d.next_attempt_at), "pending");
  await first.close();
  stopped = true;
  answer = 200;
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  await until(() => hook.got.length === 2, "the try after the restart");
  assert.equal(hook.got[1].headers["x-agentrun-delivery"], pending.id);
  assert.ok(verifies(set.secret, hook.got[1]), "signed under the same secret, opened by the next server");
  const delivered = await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.deliveries.find((d) => d.id === pending.id && d.status === "delivered"), "delivered");
  assert.equal(delivered.attempts, 2);
  // The run, read by the next server as it already ended, is no new notice.
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.status, "completed");
  await sleep(500);
  assert.equal(hook.got.length, 2);
});

test("settings: http or https only, no user or password, known events; no seal key, no webhook; rotate makes a new secret the next delivery is signed with; DELETE removes it", async (t) => {
  withEnv(t, {}, SEAL);
  const bare = await serve(t);
  const refused = await bare.api("PUT", "/settings/webhook", { url: "https://example.com/hook" });
  assert.equal(refused.status, 409);
  assert.ok(JSON.stringify(refused.body).includes("no_sealing_key"), JSON.stringify(refused.body));
  assert.deepEqual((await bare.api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended"], at_rest: "unavailable" });

  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const { api } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended"], at_rest: "sealed" });
  const withUser = Object.assign(new URL("https://example.com/hook"), { username: "user", password: "pass" }).href;
  for (const [body, field] of [
    [{ url: "ftp://example.com/hook" }, "url"], [{ url: "file:///etc/passwd" }, "url"], [{ url: "not a url" }, "url"], [{ url: withUser }, "url"],
    [{ url: `https://example.com/${"a".repeat(2048)}` }, "url"], [{}, "url"], [{ url: hook.url, events: [] }, "events"], [{ url: hook.url, events: ["run.started"] }, "events"],
    [{ url: hook.url, events: ["run.ended", "run.ended"] }, "events"], [{ url: hook.url, secret: "mine" }, "secret"],
  ]) {
    const res = await api("PUT", "/settings/webhook", body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.ok(JSON.stringify(res.body).includes(`"${field}"`), JSON.stringify(res.body));
  }
  for (const [method, path] of [["POST", "/settings/webhook/test"], ["POST", "/settings/webhook/rotate"]]) assert.equal((await api(method, path, {})).status, 404, `${path} with no webhook`);
  const first = (await api("PUT", "/settings/webhook", { url: hook.url })).body.secret;
  const rotated = await api("POST", "/settings/webhook/rotate", {});
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.secret, first);
  await meetsDocument(api, "/settings/webhook/rotate", "post", "200", rotated.body);
  const ping = await api("POST", "/settings/webhook/test", {});
  assert.deepEqual([ping.body.status, ping.body.status_code], ["delivered", 200]);
  assert.deepEqual(JSON.parse(hook.got[0].body).run, null);
  assert.ok(verifies(rotated.body.secret, hook.got[0]) && !verifies(first, hook.got[0]), "signed with the new secret, not the old");
  assert.equal((await api("DELETE", "/settings/webhook")).status, 204);
  assert.deepEqual((await api("GET", "/settings/webhook")).body, { configured: false });
  assert.equal((await api("GET", "/settings/webhook/deliveries")).body.deliveries.length, 1, "the log of those done stays");
  const quiet = await startRun(api, "quiet", "hi");
  await follow(api, quiet.run_id, ["completed"]);
  await sleep(300);
  assert.equal(hook.got.length, 1, "no webhook, no delivery");
});
