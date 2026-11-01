// The webhook: one URL the server POSTs to when a run comes to need its person and when it ends, signed by the
// Standard Webhooks spec. Its secret is made by the server, shown once, and kept sealed; a message not answered 2xx is
// tried again, then logged as failed; a pending one goes on after a restart; a 410 turns the webhook off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { startServe } from "../dist/index.js";
import { nextMoment } from "../dist/runs.js";
import { signatureOf } from "../dist/webhooks.js";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, follow, scratch, serve, startRun, withEnv } from "./support.mjs";

// The spec's own library, in the lockfile through the Anthropic SDK: what a receiver would install.
const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const sealKey = () => randomBytes(32).toString("base64");
const SEAL = ["AGENTRUN_SEAL_KEY"];

/** A receiver on 127.0.0.1 at a port of its own: each request to its own path, with its headers and body, answered
 *  `answer(n)` (n from 1; a promise holds the answer until it settles). A request to another path (another process's,
 *  at a port it once had) is not counted. `down`: every connection is reset, as a receiver that is not there. */
async function receiver(t, answer = () => 200, down = false) {
  const got = [];
  const path = `/hook/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (down) return void req.socket.destroy();
    if (req.url !== path) return void res.writeHead(404).end();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      void Promise.resolve(answer(got.length)).then((status) => {
        if (!res.destroyed) res.writeHead(status, status >= 300 && status < 400 ? { location: "http://127.0.0.1:1/elsewhere" } : {}).end();
      });
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

/** The spec's verification, as its text gives it: the HMAC-SHA256 of "{id}.{timestamp}.{body}" under the secret's
 *  base64 bytes, base64, among the header's space-separated `v1,` signatures; a timestamp within 5 minutes. */
function verifies(secret, { headers, body }, now = Date.now() / 1000) {
  const [id, timestamp] = [headers["webhook-id"], headers["webhook-timestamp"]];
  if (!id || !/^\d+$/.test(timestamp ?? "") || Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest();
  return String(headers["webhook-signature"] ?? "").split(" ").some((part) => {
    const [version, signature] = part.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
const ofType = (got, type) => got.filter((r) => JSON.parse(r.body).type === type);

async function meetsDocument(api, path, method, status, value) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[status].content["application/json"].schema, value), [], JSON.stringify(value));
}

/** Every file under `dir`, read. */
const filesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name)));

test("the signature is the Standard Webhooks spec's, byte for byte: its published test vector", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const [id, timestamp, body] = ["msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", '{"test": 2432232314}'];
  assert.equal(signatureOf(secret, id, timestamp, body), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  assert.equal(new Webhook(secret).sign(id, new Date(Number(timestamp) * 1000), body), signatureOf(secret, id, timestamp, body), "as the spec's library signs it");
});

test("demo: a run that ends and a run that asks its person each POST a Standard Webhooks message the spec's library verifies; a wrong secret does not; the secret is in no GET and on disk only sealed", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const lines = [];
  const { api, data, url } = await serve(t, { log: (line) => lines.push(line) });
  assert.deepEqual((await api("GET", "/settings/webhook")).body, { configured: false });
  const set = await api("PUT", "/settings/webhook", { url: hook.url });
  assert.equal(set.status, 201, JSON.stringify(set.body));
  const { secret } = set.body;
  assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/, "whsec_ and 32 bytes in base64");
  assert.deepEqual({ ...set.body, secret: undefined, updated_at: undefined }, { configured: true, url: hook.url, signing: "sealed", disabled: null, secret: undefined, updated_at: undefined });
  await meetsDocument(api, "/settings/webhook", "put", "201", set.body);
  const library = new Webhook(secret);

  // A run that answers: one run.ended, when it is carried back.
  const done = await startRun(api, "answers", "hi");
  await follow(api, done.run_id, ["completed"]);
  const [ended] = await until(() => ofType(hook.got, "run.ended").length && ofType(hook.got, "run.ended"), "run.ended");
  assert.deepEqual(library.verify(ended.body, ended.headers), JSON.parse(ended.body), "the spec's own library verifies it");
  assert.ok(verifies(secret, ended), "and so does the spec's algorithm, written out");
  const message = JSON.parse(ended.body);
  assert.deepEqual(Object.keys(message).sort(), ["data", "timestamp", "type"]);
  assert.deepEqual(message.data, { run_id: done.run_id, agent_id: "answers", status: "completed", title: "hi", url: `${url}/#/runs/${done.run_id}` });
  assert.match(ended.headers["webhook-id"], /^msg_[0-9a-f]{32}$/);
  assert.equal(ended.method, "POST");
  assert.equal(ended.headers["content-type"], "application/json");
  for (const wrong of [`whsec_${randomBytes(32).toString("base64")}`]) {
    assert.ok(!verifies(wrong, ended), "a wrong secret does not verify");
    assert.throws(() => new Webhook(wrong).verify(ended.body, ended.headers), /verif|signature/i);
  }
  assert.throws(() => library.verify(ended.body.replace("completed", "failed"), ended.headers), /verif|signature/i, "nor a changed body");
  const stale = { ...ended.headers, "webhook-timestamp": String(Number(ended.headers["webhook-timestamp"]) - 600) };
  assert.throws(() => library.verify(ended.body, stale), /timestamp|old/i, "nor a timestamp ten minutes old: a replay");
  assert.ok(!verifies(secret, { ...ended, headers: stale }));

  // A run that asks: run.needs_input while it waits for its person (a question), then run.ended once answered.
  const asks = await startRun(api, "asks", "Pick a region.", { tools: ["ask_person"] });
  await follow(api, asks.run_id, ["input_required"]);
  const [waiting] = await until(() => ofType(hook.got, "run.needs_input").length && ofType(hook.got, "run.needs_input"), "run.needs_input");
  assert.deepEqual(library.verify(waiting.body, waiting.headers).data, { run_id: asks.run_id, agent_id: "asks", status: "input_required", title: "Pick a region.", url: `${url}/#/runs/${asks.run_id}`, pending: { kind: "question" } });
  assert.ok(!waiting.body.includes("Which region"), "no question text: the API reads it");
  assert.equal((await api("POST", `/runs/${asks.run_id}/messages`, { content: "eu" })).status, 202);
  await follow(api, asks.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 2, "the second run.ended");
  assert.deepEqual(hook.got.map((r) => [JSON.parse(r.body).type, JSON.parse(r.body).data.run_id]), [["run.ended", done.run_id], ["run.needs_input", asks.run_id], ["run.ended", asks.run_id]], "one each, no more");
  for (const r of hook.got) library.verify(r.body, r.headers);

  const { body: log } = await api("GET", "/settings/webhook/deliveries");
  assert.deepEqual(log.attempts.map((a) => [a.type, a.status_code, a.error, a.retry_at, a.redelivery]), [["run.ended", 200, null, null, false], ["run.needs_input", 200, null, null, false], ["run.ended", 200, null, null, false]]);
  assert.deepEqual(log.attempts.map((a) => a.webhook_id), hook.got.map((r) => r.headers["webhook-id"]).reverse());
  assert.ok(log.attempts.every((a) => Number.isInteger(a.latency_ms) && a.latency_ms >= 0));
  await meetsDocument(api, "/settings/webhook/deliveries", "get", "200", log);

  // The secret: in no answer but the first PUT's, in no file of the data directory and in no log line.
  const view = await api("GET", "/settings/webhook");
  assert.deepEqual({ ...view.body, updated_at: undefined }, { configured: true, url: hook.url, signing: "sealed", disabled: null, updated_at: undefined });
  await meetsDocument(api, "/settings/webhook", "get", "200", view.body);
  const key = Buffer.from(secret.slice(6), "base64");
  const forms = [secret, secret.slice(6), key, key.toString("hex"), key.toString("base64url")];
  for (const where of [JSON.stringify(view.body), JSON.stringify(log), lines.join("\n"), ...filesIn(data)]) for (const form of forms) assert.ok(!Buffer.from(where).includes(form), "the secret is nowhere in the clear");
  assert.equal(statSync(join(data, "webhook.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(data, "webhook-outbox.json")).mode & 0o777, 0o600);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).body.secret, undefined, "a later PUT keeps the secret and never shows it");
});

test("a receiver that is down gets each try, then the message is logged as failed; one that fails then answers gets it on a try again, under the same webhook-id; a redirect is not followed", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const lines = [];
  const { api } = await serve(t, { webhookRetryMs: [100, 100], log: (line) => lines.push(line) });
  const gone = await receiver(t, () => 200, true);
  assert.equal((await api("PUT", "/settings/webhook", { url: gone.url })).status, 201);
  const down = await startRun(api, "down", "hi");
  await follow(api, down.run_id, ["completed"]);
  const failed = await until(() => lines.find((line) => line.includes("event=webhook") && line.includes("condition=delivery_failed")), "the failed message");
  assert.ok(failed.includes("attempts=3"), failed);
  const tries = (await api("GET", "/settings/webhook/deliveries")).body.attempts;
  assert.equal(tries.length, 3);
  assert.ok(tries.every((a) => a.status_code === null && /^not reached: /.test(a.error)), JSON.stringify(tries));
  assert.deepEqual(tries.map((a) => Boolean(a.retry_at)), [false, true, true], "newest first: the last try schedules none");

  // Answered 503, then 200: delivered on the second try, the same message.
  const flaky = await receiver(t, (n) => (n === 1 ? 503 : 200));
  assert.equal((await api("PUT", "/settings/webhook", { url: flaky.url })).status, 200);
  const again = await startRun(api, "again", "hi");
  await follow(api, again.run_id, ["completed"]);
  await until(() => flaky.got.length === 2, "the try again");
  assert.equal(flaky.got[0].headers["webhook-id"], flaky.got[1].headers["webhook-id"], "the receiver's idempotency key, the same");
  assert.equal(flaky.got[0].body, flaky.got[1].body);

  // A redirect is an answer that is not 2xx: never followed.
  const moved = await receiver(t, () => 302);
  assert.equal((await api("PUT", "/settings/webhook", { url: moved.url })).status, 200);
  const ping = await api("POST", "/settings/webhook/test", {});
  assert.equal(ping.status, 200);
  assert.deepEqual([ping.body.type, ping.body.status_code, ping.body.error, ping.body.retry_at], ["webhook.test", 302, "answered 302: a redirect is not followed", null]);
  assert.equal(moved.got.length, 1, "a test send is tried once");
  assert.deepEqual(JSON.parse(moved.got[0].body).data, {});
  await meetsDocument(api, "/settings/webhook/test", "post", "200", ping.body);
});

test("a 410 turns the webhook off, says so and sends nothing more until a PUT sets it again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let answer = 410;
  const hook = await receiver(t, () => answer);
  const lines = [];
  const { api } = await serve(t, { webhookRetryMs: [100, 100], log: (line) => lines.push(line) });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const first = await startRun(api, "gone", "hi");
  await follow(api, first.run_id, ["completed"]);
  const off = await until(async () => (await api("GET", "/settings/webhook")).body.disabled, "off");
  assert.equal(off.reason, "the receiver answered 410 Gone");
  assert.ok(lines.some((line) => line.includes("condition=webhook_disabled")), "the log says why");
  assert.equal(hook.got.length, 1, "no try after the 410");
  const second = await startRun(api, "quiet", "hi");
  await follow(api, second.run_id, ["completed"]);
  await sleep(300);
  assert.equal(hook.got.length, 1, "off: nothing is sent");
  answer = 200;
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).body.disabled, null, "a PUT sets it on again");
  const third = await startRun(api, "back", "hi");
  await follow(api, third.run_id, ["completed"]);
  await until(() => hook.got.length === 2, "sent again");
});

test("a 410 that comes back after the webhook was set to another URL turns nothing off: the message goes on to the new URL", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const old = await receiver(t, () => held.then(() => 410));
  t.after(() => release());
  const fresh = await receiver(t);
  const { api } = await serve(t, { webhookRetryMs: [100, 100] });
  assert.equal((await api("PUT", "/settings/webhook", { url: old.url })).status, 201);
  const run = await startRun(api, "moved", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => old.got.length === 1, "the try held at the old URL");
  assert.equal((await api("PUT", "/settings/webhook", { url: fresh.url })).status, 200);
  release();
  await until(() => fresh.got.length === 1, "the message at the new URL");
  assert.equal(fresh.got[0].headers["webhook-id"], old.got[0].headers["webhook-id"]);
  const view = (await api("GET", "/settings/webhook")).body;
  assert.deepEqual([view.url, view.disabled], [fresh.url, null], "the new setting stands, on");
});

test("redeliveries that fail leave the message's own schedule as it was: it is still tried on every wait", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t, () => 500);
  const lines = [];
  const { api } = await serve(t, { webhookRetryMs: [1_500, 100, 100], log: (line) => lines.push(line) });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "redone", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => hook.got.length === 1, "the first try");
  const id = hook.got[0].headers["webhook-id"];
  for (let i = 0; i < 4; i++) assert.equal((await api("POST", `/settings/webhook/deliveries/${id}/redeliver`, {})).body.status_code, 500);
  const failed = await until(() => lines.find((line) => line.includes("condition=delivery_failed")), "the message failed");
  assert.ok(failed.includes("attempts=4"), `its own four tries, every wait: ${failed}`);
  const tries = (await api("GET", "/settings/webhook/deliveries")).body.attempts;
  assert.deepEqual([tries.filter((a) => !a.redelivery).length, tries.filter((a) => a.redelivery).length], [4, 4]);
});

test("redeliver sends a message of the log again, once, under the same webhook-id and body, signed anew", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const { api } = await serve(t);
  const { body: set } = await api("PUT", "/settings/webhook", { url: hook.url });
  const run = await startRun(api, "again", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => hook.got.length === 1, "run.ended");
  const id = hook.got[0].headers["webhook-id"];
  await sleep(1_100);
  const again = await api("POST", `/settings/webhook/deliveries/${id}/redeliver`, {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.webhook_id, again.body.status_code, again.body.redelivery], [id, 200, true]);
  await meetsDocument(api, "/settings/webhook/deliveries/{webhook_id}/redeliver", "post", "200", again.body);
  assert.equal(hook.got.length, 2);
  assert.equal(hook.got[1].headers["webhook-id"], id);
  assert.equal(hook.got[1].body, hook.got[0].body);
  assert.notEqual(hook.got[1].headers["webhook-timestamp"], hook.got[0].headers["webhook-timestamp"]);
  new Webhook(set.secret).verify(hook.got[1].body, hook.got[1].headers);
  assert.equal((await api("POST", "/settings/webhook/deliveries/msg_unknown/redeliver", {})).status, 404);
});

test("a message pending when its server stops goes on from the next one, under the same webhook-id; a run the next server reads as it already stood notices nothing", async (t) => {
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
  await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.attempts[0]?.retry_at, "a try again scheduled");
  await first.close();
  stopped = true;
  answer = 200;
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  await until(() => hook.got.length === 2, "the try after the restart");
  assert.equal(hook.got[1].headers["webhook-id"], hook.got[0].headers["webhook-id"]);
  new Webhook(set.secret).verify(hook.got[1].body, hook.got[1].headers);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.status, "completed");
  await sleep(500);
  assert.equal(hook.got.length, 2, "the run, read as it already ended, is no new notice");
});

test("settings: an http or https URL with no user or password, and nothing else; no seal key, no webhook; DELETE removes it", async (t) => {
  withEnv(t, {}, SEAL);
  const bare = await serve(t);
  const refused = await bare.api("PUT", "/settings/webhook", { url: "https://example.com/hook" });
  assert.equal(refused.status, 409);
  assert.ok(JSON.stringify(refused.body).includes("no_sealing_key"), JSON.stringify(refused.body));
  assert.deepEqual((await bare.api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended"], signing: "standard-webhooks/v1", at_rest: "unavailable" });

  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const { api } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended"], signing: "standard-webhooks/v1", at_rest: "sealed" });
  const withUser = Object.assign(new URL("https://example.com/hook"), { username: "user", password: "pass" }).href;
  for (const [body, field] of [
    [{ url: "ftp://example.com/hook" }, "url"], [{ url: "file:///etc/passwd" }, "url"], [{ url: "not a url" }, "url"], [{ url: withUser }, "url"],
    [{ url: `https://example.com/${"a".repeat(2048)}` }, "url"], [{}, "url"], [{ url: hook.url, events: ["run.ended"] }, "events"], [{ url: hook.url, secret: "mine" }, "secret"],
  ]) {
    const res = await api("PUT", "/settings/webhook", body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.ok(JSON.stringify(res.body).includes(`"${field}"`), JSON.stringify(res.body));
  }
  assert.equal((await api("POST", "/settings/webhook/test", {})).status, 404, "no webhook, no test send");
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  assert.equal((await api("POST", "/settings/webhook/test", {})).body.status_code, 200);
  assert.equal((await api("DELETE", "/settings/webhook")).status, 204);
  assert.deepEqual((await api("GET", "/settings/webhook")).body, { configured: false });
  assert.equal((await api("GET", "/settings/webhook/deliveries")).body.attempts.length, 1, "the log stays");
  const quiet = await startRun(api, "quiet", "hi");
  await follow(api, quiet.run_id, ["completed"]);
  await sleep(300);
  assert.equal(hook.got.length, 1, "no webhook, no message");
});

/** A server on `data` in a process of its own, killed as a crash does at the test's end at the latest. */
async function serverProcess(t, data) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  await until(() => /AGENTRUN_API_KEY=/.test(out), "the server's banner");
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], readFileSync(join(data, ".token"), "utf8").trim()) };
}

test("a run that ends while its server stops still gives its notice: kept pending, delivered by the next server", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "10s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "soon", "Answer soon.");
  await until(async () => (await api("GET", `/runs/${run.run_id}`)).body.status === "working", "the run works");
  // The stop drains the run's turn: it answers, and is carried back, while the server closes.
  await first.close();
  stopped = true;
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.status, "completed", "it ended while its server stopped");
  await until(() => ofType(hook.got, "run.ended").some((r) => JSON.parse(r.body).data.run_id === run.run_id), "its run.ended");
});

test("a try in flight when its server closes is cut and waited for; nothing is written after, and the next server delivers it; a test send left pending is not tried again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const hook = await receiver(t, (n) => (n === 1 ? held.then(() => 200) : 200));
  t.after(() => release());
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "held", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => hook.got.length === 1, "the held try");
  const outbox = join(data, "webhook-outbox.json");
  const before = readFileSync(outbox, "utf8");
  const started = Date.now();
  await first.close();
  stopped = true;
  assert.ok(Date.now() - started < 8_000, "the try is cut, not waited out");
  release();
  await sleep(200);
  assert.equal(readFileSync(outbox, "utf8"), before, "nothing written after the close");
  const left = JSON.parse(before);
  const [pending] = left.messages;
  assert.deepEqual([pending.status, pending.attempts], ["pending", 0]);
  // A test send an earlier server left in flight: the next one marks it failed and never sends it.
  left.messages.push({ ...pending, id: `msg_${"0".repeat(32)}`, type: "webhook.test", body: JSON.stringify({ type: "webhook.test", timestamp: new Date().toISOString(), data: {} }) });
  writeFileSync(outbox, JSON.stringify(left));
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  await until(() => hook.got.length === 2, "the try after the restart");
  assert.equal(hook.got[1].headers["webhook-id"], pending.id);
  await sleep(300);
  assert.equal(hook.got.length, 2, "the test send is not sent again");
  assert.deepEqual(JSON.parse(readFileSync(outbox, "utf8")).messages.find((m) => m.type === "webhook.test")?.status ?? "failed", "failed");
});

test("a run stopped, then asked a question on its next turn, gives two needs_input notices: different webhook-ids, `stopped` then `question`", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const { api } = await serve(t);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "ask-later", "Take your time.", { tools: ["ask_person"] });
  await until(async () => (await api("GET", `/runs/${run.run_id}`)).body.status === "working", "the run works");
  await until(async () => (await api("POST", `/runs/${run.run_id}/stop`, {})).body.stopped === true, "the stop");
  await until(() => hook.got.length === 1, "the stop's notice");
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Ask me now." })).status, 202);
  await until(() => hook.got.length === 2, "the question's notice");
  const [stop, question] = hook.got;
  assert.deepEqual(hook.got.map((r) => [JSON.parse(r.body).type, JSON.parse(r.body).data.pending]), [["run.needs_input", { kind: "stopped" }], ["run.needs_input", { kind: "question" }]]);
  assert.notEqual(stop.headers["webhook-id"], question.headers["webhook-id"], "a new wait, a new id");
});

test("a run waiting for its person when its server dies gives no new notice from the server that adopts its process; its end does", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(t, data);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(first.api, "asks", "Pick a region.", { tools: ["ask_person"] });
  await until(() => ofType(hook.got, "run.needs_input").length === 1, "the wait's notice");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = JSON.parse(readFileSync(join(data, "runs", run.run_id, "run.json"), "utf8"));
  t.after(() => processAlive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  assert.ok(processAlive(holder.pid), "its process outlived the server");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  await follow(api, run.run_id, ["input_required"]);
  await sleep(500);
  assert.equal(ofType(hook.got, "run.needs_input").length, 1, "the same wait, no new notice");
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "eu" })).status, 202);
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its end's notice");
});

test("when a status is a notice: a change to a wait or an end; a live run adopted with no rows takes its first snapshot silently, and an end it comes to is noticed", () => {
  assert.deepEqual(nextMoment(undefined, "completed", 3), { keep: undefined, notify: false }, "a run not yet read");
  assert.deepEqual(nextMoment("other", "input_required", 3), { keep: "input_required", notify: true });
  assert.deepEqual(nextMoment("input_required", "input_required", 3), { keep: "input_required", notify: false }, "the same wait");
  assert.deepEqual(nextMoment("input_required", "other", 3), { keep: "other", notify: false });
  assert.deepEqual(nextMoment("other", "cancelled", 3), { keep: "cancelled", notify: true });
  assert.deepEqual(nextMoment("unread", "other", 0), { keep: "unread", notify: false });
  assert.deepEqual(nextMoment("unread", "input_required", 2), { keep: "input_required", notify: false });
  assert.deepEqual(nextMoment("unread", "cancelled", 0), { keep: "cancelled", notify: true });
  assert.deepEqual(nextMoment("unread", "completed", 4), { keep: "completed", notify: true });
});
