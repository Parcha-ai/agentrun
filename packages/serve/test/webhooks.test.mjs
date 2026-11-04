// The webhook: one URL the server POSTs to when a run comes to need its person and when it ends, signed by the
// Standard Webhooks spec. Its secret is made by the server, shown once, and kept sealed; a message not answered 2xx is
// tried again, then logged as failed; a pending one goes on after a restart; a 410 turns the webhook off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { ATTEMPTS_KEPT, signatureOf, Webhooks } from "../dist/webhooks.js";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, follow, printed, scratch, serve, startRun, withEnv } from "./support.mjs";

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

test("a webhook a 410 turned off refuses a test send and a redelivery, 409 webhook_off, and sends nothing until a PUT", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let answer = 410;
  const hook = await receiver(t, () => answer);
  const { api } = await serve(t);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  assert.equal((await api("POST", "/settings/webhook/test")).body.status_code, 410);
  assert.equal((await api("GET", "/settings/webhook")).body.disabled.reason, "the receiver answered 410 Gone");
  const id = hook.got[0].headers["webhook-id"];
  for (const [method, path] of [["POST", "/settings/webhook/test"], ["POST", `/settings/webhook/deliveries/${id}/redeliver`]]) {
    const refused = await api(method, path);
    assert.deepEqual([refused.status, refused.body.error.code], [409, "webhook_off"], path);
    assert.match(refused.body.error.message, /set it again with PUT/);
  }
  assert.equal(hook.got.length, 1, "nothing sent while off");
  answer = 200;
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 200);
  assert.equal((await api("POST", `/settings/webhook/deliveries/${id}/redeliver`)).body.status_code, 200, "on again, it sends");
  assert.equal(hook.got.length, 2);
});

test("a message whose redelivery is in flight stays in the outbox while other attempts push its own out of the log: it can be redelivered again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // The log is filled before the redelivery starts, so a single attempt pushes the first out while the redelivery
  // waits: the wait stays far inside the server's fetch timeout. The redelivery is answered only when released.
  const redelivery = ATTEMPTS_KEPT + 1;
  const hook = await receiver(t, (n) => (n === redelivery ? held.then(() => 200) : 200));
  const { api, data } = await serve(t);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  assert.equal((await api("POST", "/settings/webhook/test")).body.status_code, 200);
  const id = hook.got[0].headers["webhook-id"];
  for (let i = 1; i < ATTEMPTS_KEPT; i++) assert.equal((await api("POST", "/settings/webhook/test")).body.status_code, 200);
  const logged = async () => (await api("GET", "/settings/webhook/deliveries")).body.attempts.some((a) => a.webhook_id === id);
  assert.ok(await logged(), "the log is full, its first attempt still in it");
  const again = api("POST", `/settings/webhook/deliveries/${id}/redeliver`);
  await until(() => hook.got.length === redelivery, "the redelivery in flight");
  assert.equal((await api("POST", "/settings/webhook/test")).body.status_code, 200);
  assert.ok(!(await logged()), "its first attempt has left the log");
  const outbox = JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8"));
  assert.ok(!outbox.attempts.some((a) => a.webhook_id === id), "nor is it among the outbox's attempts");
  assert.ok(outbox.messages.some((m) => m.id === id), "the outbox on disk keeps the message in flight");
  release();
  assert.equal((await again).body.status_code, 200);
  const third = await api("POST", `/settings/webhook/deliveries/${id}/redeliver`);
  assert.equal(third.status, 200, `still redeliverable: ${JSON.stringify(third.body)}`);
  assert.equal(hook.got.at(-1).headers["webhook-id"], id);
});

/** Every unhandled rejection while `t` runs: one would stop a server. */
function rejections(t) {
  const seen = [];
  const on = (reason) => seen.push(reason);
  process.on("unhandledRejection", on);
  t.after(() => process.off("unhandledRejection", on));
  return seen;
}

test("a 410 while the webhook's file cannot be written leaves the server up and the webhook off here, said in the log; the next PUT writes it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const rejected = rejections(t);
  let answer = 410;
  const hook = await receiver(t, () => answer);
  const lines = [];
  const { api, data } = await serve(t, { webhookRetryMs: [100, 100], log: (line) => lines.push(line) });
  const set = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  // The webhook's temporary file is a directory: its write fails, as on a full disk.
  const blocked = join(data, "webhook.json.tmp");
  mkdirSync(blocked);
  const first = await startRun(api, "gone", "hi");
  await follow(api, first.run_id, ["completed"]);
  const off = await until(async () => (await api("GET", "/settings/webhook")).body.disabled, "off here");
  assert.equal(off.reason, "the receiver answered 410 Gone");
  assert.ok(lines.some((line) => line.includes("condition=webhook_unwritable")), "the log says the write failed");
  assert.ok(lines.some((line) => line.includes("condition=webhook_disabled")));
  assert.equal(JSON.parse(readFileSync(join(data, "webhook.json"), "utf8")).disabled, undefined, "not on disk");
  const second = await startRun(api, "quiet", "hi");
  await follow(api, second.run_id, ["completed"]);
  await sleep(300);
  assert.equal(hook.got.length, 1, "off: nothing more is sent");
  rmdirSync(blocked);
  answer = 200;
  const again = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  assert.equal(again.disabled, null, "a PUT sets it on again");
  const written = JSON.parse(readFileSync(join(data, "webhook.json"), "utf8"));
  assert.deepEqual([written.url, written.updated_at, written.disabled], [set.url, again.updated_at, undefined], "and writes it");
  const third = await startRun(api, "back", "hi");
  await follow(api, third.run_id, ["completed"]);
  await until(() => hook.got.length === 2, "sent again");
  assert.deepEqual(rejected, [], "no unhandled rejection");
});

test("a scheduled try that throws is said in the log, never an unhandled rejection", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const rejected = rejections(t);
  const hook = await receiver(t, () => 500);
  const said = [];
  // A log that throws on the line a failed try ends with: the try throws after its POST.
  const say = (fields) => {
    if (fields.condition === "delivery_failed") throw new Error("the log is gone");
    said.push(fields);
  };
  const webhooks = new Webhooks(await scratch(t), { AGENTRUN_SEAL_KEY: sealKey() }, say, []);
  t.after(() => webhooks.close());
  webhooks.save({ url: hook.url });
  webhooks.emit("run.ended", { run_id: "run_1", agent_id: "a", status: "completed", title: "t" }, "m1");
  await until(() => said.some((fields) => fields.condition === "attempt_failed"), "the throw said");
  assert.equal(hook.got.length, 1);
  assert.deepEqual(said.filter((fields) => fields.condition === "attempt_failed").map(({ error }) => error), ["the log is gone"]);
  await sleep(100);
  assert.deepEqual(rejected, [], "no unhandled rejection");
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
  const out = await printed(child, /^AGENTRUN_API_KEY=/m);
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
  // A notice of the wait is in the outbox by the time the run reads input_required: each one is sent before ids are counted.
  const outbox = join(data, "webhook-outbox.json");
  await until(() => JSON.parse(readFileSync(outbox, "utf8")).messages.every((m) => m.status !== "pending"), "the outbox sent");
  // No new notice for the same wait: one webhook-id. The kill can land before the first server records its delivery,
  // and the server that adopts its outbox then sends that same message again, under the same id (at-least-once; the
  // id is the receiver's idempotency key). So ids are counted, never receipts.
  const waits = ofType(hook.got, "run.needs_input");
  assert.equal(new Set(waits.map((r) => r.headers["webhook-id"])).size, 1, "the same wait, no new notice");
  assert.ok(waits.every((r) => r.body === waits[0].body), "a try again is the same message");
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "eu" })).status, 202);
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its end's notice");
});

test("a start that fails after its webhooks began stops them before it lets the data directory go: no try and no write after it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t, () => 503);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", webhookRetryMs: [1_500] });
  let stopped = false;
  t.after(() => stopped || first.close());
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "pending", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.attempts[0]?.retry_at, "a try again scheduled");
  await first.close();
  stopped = true;
  const outbox = join(data, "webhook-outbox.json");
  const before = readFileSync(outbox, "utf8");
  // The next start finds its port taken: it fails after its webhooks read the pending message and set its next try.
  const taken = createServer();
  await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => taken.close(resolve)));
  await assert.rejects(startServe({ data, port: taken.address().port, faux: FAUX, drainTimeout: "5s" }), /EADDRINUSE/);
  await sleep(2_500);
  assert.equal(hook.got.length, 1, "the failed start tries nothing");
  assert.equal(readFileSync(outbox, "utf8"), before, "and writes nothing");
});

test("a notice the outbox could not be written with is kept, and written by the close: a stop never loses it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t, () => 503);
  const lines = [];
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", webhookRetryMs: [60_000], log: (line) => lines.push(line) });
  let stopped = false;
  t.after(() => stopped || server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  // The outbox's temporary file is a directory: each write of it fails, as on a full disk.
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const run = await startRun(api, "unsaved", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => hook.got.length === 1, "the first try");
  await sleep(200);
  assert.equal(existsSync(join(data, "webhook-outbox.json")), false, "never written");
  assert.equal(lines.filter((line) => line.includes("condition=outbox_unwritable")).length, 1, "said once");
  rmdirSync(blocked);
  await server.close();
  stopped = true;
  const kept = JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).messages;
  assert.deepEqual(kept.map((m) => [m.id, m.type, m.status]), [[hook.got[0].headers["webhook-id"], "run.ended", "pending"]], "the close wrote it, pending, for the next server");
});

test("a try that fails after a redelivery delivered the same message leaves it delivered: no failure is said", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const hook = await receiver(t, (n) => (n === 1 ? held.then(() => 500) : 200));
  t.after(() => release());
  const lines = [];
  const { api } = await serve(t, { webhookRetryMs: [], log: (line) => lines.push(line) });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "both", "hi");
  await follow(api, run.run_id, ["completed"]);
  await until(() => hook.got.length === 1, "the automatic try, held");
  const id = hook.got[0].headers["webhook-id"];
  assert.equal((await api("POST", `/settings/webhook/deliveries/${id}/redeliver`, {})).body.status_code, 200);
  release();
  await until(async () => (await api("GET", "/settings/webhook/deliveries")).body.attempts.length === 2, "both tries logged");
  await sleep(200);
  assert.equal(lines.filter((line) => line.includes("condition=delivery_failed")).length, 0, "no false failure");
});

// ---- a run's end and its run.ended, one durable step: the end's time is chosen once and saved first, run.ended is
// queued only once the agent store has the end, and recorded as queued only once the outbox holds it on disk.

const SERVE_END_HELD = new URL("./fixtures/serve-end-held.mjs", import.meta.url).pathname;
/** The run's ended_at in the agent store, read from another connection; null while it runs. */
const endedIn = (data, runId) => {
  const store = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return store.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId)?.ended_at ?? null;
  } finally {
    store.close();
  }
};
/** Another connection holding store.sqlite for writing (store-busy.test's IMMEDIATE), so the server's writes of it are
 *  refused while its reads go on. */
function hold(t, data) {
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  store.exec("BEGIN IMMEDIATE");
  const release = () => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close());
  t.after(release);
  return release;
}
/** What the webhook's ledger (webhook-outbox.json, on disk) holds of a run: undefined for none, or no outbox yet. */
const noticed = (data, runId) => (existsSync(join(data, "webhook-outbox.json")) ? JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).notices?.[runId] : undefined);
/** The ledger's end of the run, as `{ended_at, queued}`. */
const endNotice = (data, runId) => (noticed(data, runId)?.ended ? { ended_at: noticed(data, runId).ended, queued: true } : undefined);
/** The webhook-id a run's notice has (webhooks.ts emit): its run, its type and the marker of its moment. */
const noticeId = (runId, type, marker) => `msg_${createHash("sha256").update(`${runId}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
/** A server on `data` in a process of its own, started by `script` (the CLI's banner, or a fixture's address line). */
async function processOn(t, data, args) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  await until(() => /AGENTRUN_BASE_URL=/.test(out), "the server's address");
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], readFileSync(join(data, ".token"), "utf8").trim()) };
}
const killed = async (child) => {
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
};

test("a run whose end is in the store, its server killed before run.ended is queued and its outbox lost, gives its run.ended from the next server, once, under the id its end time makes", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  // The fixture's read of the run after its end is written never comes back: the server is killed inside that window.
  const first = await processOn(t, data, [SERVE_END_HELD, data, FAUX]);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(first.api, "ends", "Answer.");
  const at = await until(() => endedIn(data, run.run_id), "its end in the store");
  await killed(first.child);
  assert.equal(ofType(hook.got, "run.ended").length, 0, "the first server never queued it");
  // A crash of the machine can keep a write of the outbox from the disk: whatever it held of the end is gone, the store's
  // end stays, and that alone brings the notice back.
  rmSync(join(data, "webhook-outbox.json"), { force: true });
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, from the next server");
  const [ended] = ofType(hook.got, "run.ended");
  assert.equal(JSON.parse(ended.body).data.run_id, run.run_id);
  assert.equal(ended.headers["webhook-id"], noticeId(run.run_id, "run.ended", at), "the id the store's end time makes");
  await until(() => endNotice(data, run.run_id)?.queued, "recorded as queued");
  assert.deepEqual(endNotice(data, run.run_id), { ended_at: at, queued: true });
  await sleep(300);
  assert.equal(ofType(hook.got, "run.ended").length, 1, "once");
});

test("a run whose end the store refuses gives no run.ended while it does, then one, under one webhook-id, from the server that stores it; a receiver reading it back reads it ended", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let api;
  const read = [];
  // The receiver reads the run back when its run.ended arrives, as a Standard Webhooks receiver may.
  const hook = await receiver(t, async () => {
    const id = JSON.parse(hook.got.at(-1).body).data.run_id;
    read.push((await api("GET", `/runs/${id}`)).body.status);
    return 200;
  });
  const data = join(await scratch(t), "agents");
  const go = join(await scratch(t), "go");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", carryBackRetry: { delaysMs: [50] }, settleRetryMs: 600_000 });
  let stopped = false;
  t.after(() => stopped || first.close());
  api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "refused", `Answer once ${go} exists.`);
  await follow(api, run.run_id, ["working"]);
  const release = hold(t, data);
  writeFileSync(go, "");
  await until(async () => (await api("GET", `/runs/${run.run_id}`)).body.status === "completed", "ended here, from memory");
  await sleep(500);
  assert.equal(ofType(hook.got, "run.ended").length, 0, "no run.ended while the store has not the end");
  release();
  await first.close();
  stopped = true;
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, once the store has the end");
  await sleep(500);
  const ids = new Set(ofType(hook.got, "run.ended").map((r) => r.headers["webhook-id"]));
  assert.equal(ids.size, 1, `one end, one webhook-id: ${[...ids]}`);
  assert.deepEqual([...ids], [noticeId(run.run_id, "run.ended", endedIn(data, run.run_id))], "under the store's end time");
  assert.deepEqual(read, ["completed"], "read back on its notice, it is ended");
});

test("a receiver that reads a run back on its run.ended reads it ended, in the run and in the list", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let api;
  const read = [];
  const hook = await receiver(t, async () => {
    const id = JSON.parse(hook.got.at(-1).body).data.run_id;
    const one = (await api("GET", `/runs/${id}`)).body;
    const listed = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === id);
    read.push([one.status, one.ended_at !== null, listed?.status]);
    return 200;
  });
  ({ api } = await serve(t));
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "read-back", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  await until(() => read.length === 1, "its run.ended, read back");
  assert.deepEqual(read, [["completed", true, "completed"]]);
});

test("an end whose run.ended an older outbox holds with no ledger (as a server before the ledger leaves it) is recorded by the next start, and not sent again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "requeued", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1 && endNotice(data, run.run_id)?.queued, "sent and recorded");
  await first.close();
  stopped = true;
  // The outbox as a server before the ledger leaves it: the message, and no record of what it queued.
  const outbox = join(data, "webhook-outbox.json");
  const { messages, attempts } = JSON.parse(readFileSync(outbox, "utf8"));
  writeFileSync(outbox, `${JSON.stringify({ v: 2, messages, attempts })}\n`);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => endNotice(data, run.run_id)?.queued, "recorded by the next start");
  await sleep(500);
  assert.equal(ofType(hook.got, "run.ended").length, 1, "the outbox already held that id: not sent again");
});

test("a run.ended whose outbox write failed is not recorded as queued, so after a kill the next server queues and sends it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(t, data);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  // The outbox's temporary file is a directory: its writes fail, as on a full disk.
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const run = await startRun(first.api, "unsaved-end", "Answer.");
  await follow(first.api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its try, from memory");
  assert.equal(endNotice(data, run.run_id)?.queued, undefined, "not recorded: the outbox never held it on disk");
  await killed(first.child);
  rmdirSync(blocked);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => endNotice(data, run.run_id)?.queued, "queued and recorded by the next server");
  await until(() => ofType(hook.got, "run.ended").length === 2, "sent again, under the same id");
  const ids = new Set(ofType(hook.got, "run.ended").map((r) => r.headers["webhook-id"]));
  assert.equal(ids.size, 1, "one end, one webhook-id");
});

// A start's recovery that cannot read the agent store (busy past its wait) gives up, as it always has; the catch-up of the
// ends the outbox lacks is its own start step, so it still runs, reads the store once it is free, and queues each end.
test("a start whose recovery gives up on a busy agent store still catches up the ends stored before it: the catch-up is its own step", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await processOn(t, data, [SERVE_END_HELD, data, FAUX]);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(first.api, "ends-busy-start", "Answer.");
  const at = await until(() => endedIn(data, run.run_id), "its end in the store");
  await killed(first.child);
  rmSync(join(data, "webhook-outbox.json"), { force: true });
  // The next server's first reads of the run list find the store busy, every try of one request's wait (the first one
  // and REQUEST_BUSY_MS's eight): recovery's read, which gives up. The reads after it find the store free.
  const scratchStore = openStore(await scratch(t), { busyTimeoutMs: 0 });
  const reader = Object.getPrototypeOf(Object.getPrototypeOf(scratchStore));
  scratchStore.close();
  const listRuns = reader.listRuns;
  let busyLeft = 9;
  reader.listRuns = function (...args) {
    if (busyLeft > 0) { busyLeft--; throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }); }
    return listRuns.apply(this, args);
  };
  t.after(() => { reader.listRuns = listRuns; });
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, though the start's recovery gave up");
  assert.equal(busyLeft, 0, "the start's first reads did find the store busy");
  const [ended] = ofType(hook.got, "run.ended");
  assert.equal(ended.headers["webhook-id"], noticeId(run.run_id, "run.ended", at));
  await sleep(300);
  assert.equal(ofType(hook.got, "run.ended").length, 1, "once");
});

test("a run continued, its server killed once the reopening is committed, ends again under a new webhook-id: both ends reach the receiver", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  // The fixture's process stops dead once a run's reopening is committed, before anything else of the continuation.
  const first = await processOn(t, data, [SERVE_END_HELD, data, FAUX, "reopen"]);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(first.api, "continued", "Answer.");
  await follow(first.api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1 && endNotice(data, run.run_id)?.queued, "its first end, sent and recorded");
  const before = endedIn(data, run.run_id);
  void first.api("POST", `/runs/${run.run_id}/messages`, { content: "And now?" }).catch(() => undefined);
  await until(() => endedIn(data, run.run_id) === null, "the reopening, committed");
  await killed(first.child);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  await until(async () => ["completed", "failed", "cancelled"].includes((await api("GET", `/runs/${run.run_id}`)).body.status), "its next end");
  await until(() => ofType(hook.got, "run.ended").length === 2, "both ends, at the receiver");
  const after = endedIn(data, run.run_id);
  assert.notEqual(after, before);
  assert.deepEqual(ofType(hook.got, "run.ended").map((r) => r.headers["webhook-id"]), [noticeId(run.run_id, "run.ended", before), noticeId(run.run_id, "run.ended", after)], "each end under its own time's id");
});

test("a run is continued only once its end's run.ended is in the outbox: refused 503 while the outbox cannot be written, then let through", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const { api, data } = await serve(t);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const run = await startRun(api, "held-open", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its try, from memory");
  assert.equal(endNotice(data, run.run_id), undefined, "not recorded: the outbox never held it on disk");
  const refused = await api("POST", `/runs/${run.run_id}/messages`, { content: "And now?" });
  assert.deepEqual([refused.status, refused.body.error?.code], [503, "unavailable"], JSON.stringify(refused.body));
  rmdirSync(blocked);
  await until(async () => (await api("POST", `/runs/${run.run_id}/messages`, { content: "And now?" })).status === 202, "let through once the outbox holds the end", 20_000);
  assert.equal(endNotice(data, run.run_id)?.queued, true);
});

/** A data directory as an older server leaves the runs it ended and announced: an outbox with no ledger (its messages
 *  pruned too); `since` the time the newer server first started. */
function asAnOlderServerLeftIt(data, since) {
  writeFileSync(join(data, "webhook-outbox.json"), `${JSON.stringify({ v: 2, messages: [], attempts: [] })}\n`);
  if (since !== undefined) writeFileSync(join(data, "end-notices-since"), `${since}\n`);
}

test("an end from before this kind of server first started (no record of its notice, as an older server leaves it) is never sent again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "older", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, sent then");
  await first.close();
  stopped = true;
  // The run ended a moment before the newer server first started.
  asAnOlderServerLeftIt(data, new Date(Date.parse(endedIn(data, run.run_id)) + 1_000).toISOString());
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await sleep(1_500);
  assert.equal(ofType(hook.got, "run.ended").length, 1, "not sent again");
});

test("a server that cannot write when it first started takes now, says so, and sends no earlier end again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "unwritable", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, sent then");
  await first.close();
  stopped = true;
  asAnOlderServerLeftIt(data);
  // Where the time is kept, a directory: neither read nor written.
  rmSync(join(data, "end-notices-since"), { force: true });
  mkdirSync(join(data, "end-notices-since"));
  const lines = [];
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", log: (line) => lines.push(line) });
  t.after(() => next.close());
  assert.equal((await client(next.baseUrl, next.token)("GET", "/health")).status, 200, "it started");
  assert.ok(lines.some((line) => line.includes("condition=notices_since_unwritable")), "and said so");
  await sleep(1_500);
  assert.equal(ofType(hook.got, "run.ended").length, 1, "nothing ended before it is sent again");
});

// ---- a wait's run.needs_input is a notice until the webhook's ledger says the outbox holds it, so a server that adopts the
// run queues a wait no server queued, under its one webhook-id.

/** The ledger's wait of the run, as `{marker}`. */
const waitNotice = (data, runId) => (noticed(data, runId)?.wait ? { marker: noticed(data, runId).wait } : undefined);


test("a run that comes to wait for its person while no server is up gives exactly one run.needs_input from the server that adopts it, under the wait's own id", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const gate = join(await scratch(t), "ask");
  const first = await serverProcess(t, data);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  // "Pick a region once <file> exists." (fixtures/faux-model.mjs) asks only once the file is there.
  const run = await startRun(first.api, "asks-late", `Pick a region once ${gate} exists.`, { tools: ["ask_person"] });
  await follow(first.api, run.run_id, ["working"]);
  await killed(first.child);
  const { holder } = JSON.parse(readFileSync(join(data, "runs", run.run_id, "run.json"), "utf8"));
  t.after(() => processAlive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  assert.ok(processAlive(holder.pid), "its process outlived the server");
  // The run asks with no server up: the faux model says so by a file, as its store is its process's alone.
  writeFileSync(gate, "");
  await until(() => existsSync(`${gate}.asked`), "the run's question, asked");
  assert.deepEqual(ofType(hook.got, "run.needs_input"), [], "no server was up to notice it");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  await follow(api, run.run_id, ["input_required"]);
  await until(() => ofType(hook.got, "run.needs_input").length > 0, "its wait's run.needs_input, from the server that adopted the run", 10_000);
  await until(() => waitNotice(data, run.run_id), "recorded as queued");
  await sleep(500);
  const waits = ofType(hook.got, "run.needs_input");
  const ids = [...new Set(waits.map((r) => r.headers["webhook-id"]))];
  assert.equal(waits.length, 1, `one wait, one message: ${ids}`);
  // Its marker is its question's row: the newest that is neither usage nor a phase (mark's).
  const { rows } = (await api("GET", `/runs/${run.run_id}/timeline`)).body;
  const question = rows.findLast((row) => row.kind !== "usage" && row.kind !== "phase" && !/:run:(start|end)$/.test(row.id));
  assert.equal(ids[0], noticeId(run.run_id, "run.needs_input", question.id), "the id the wait's own marker makes");
  assert.deepEqual(waitNotice(data, run.run_id), { marker: question.id });
  const body = JSON.parse(waits[0].body);
  assert.deepEqual([body.data.run_id, body.data.status, body.data.pending], [run.run_id, "input_required", { kind: "question" }]);
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "eu" })).status, 202);
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its end's notice");
});

test("a run.needs_input whose outbox write failed is not recorded, so after a kill the server that adopts the run queues it again, under the same id", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(t, data);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const run = await startRun(first.api, "asks-unsaved", "Pick a region.", { tools: ["ask_person"] });
  await until(() => ofType(hook.got, "run.needs_input").length === 1, "its try, from memory");
  assert.equal(waitNotice(data, run.run_id), undefined, "not recorded: the outbox never held it on disk");
  await killed(first.child);
  const { holder } = JSON.parse(readFileSync(join(data, "runs", run.run_id, "run.json"), "utf8"));
  t.after(() => processAlive(holder.pid) && process.kill(holder.pid, "SIGKILL"));
  rmdirSync(blocked);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => waitNotice(data, run.run_id), "queued and recorded by the server that adopted it");
  await until(() => ofType(hook.got, "run.needs_input").length === 2, "sent again");
  const ids = new Set(ofType(hook.got, "run.needs_input").map((r) => r.headers["webhook-id"]));
  assert.equal(ids.size, 1, "one wait, one webhook-id");
});

test("a run that ended before record-keeping began is continued at once, its old end never sent again, and its next end arrives under its own id", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "older-continued", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, sent then");
  await first.close();
  stopped = true;
  const before = endedIn(data, run.run_id);
  const since = Date.parse(before) + 1_000;
  asAnOlderServerLeftIt(data, new Date(since).toISOString());
  // The next end must come after the since-time, as one after record-keeping began does: on a fast machine the restart
  // and the continued turn take less than the second between them, and an end before the since-time is never sent.
  while (Date.now() <= since) await sleep(50);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  const continued = await api("POST", `/runs/${run.run_id}/messages`, { content: "And now?" });
  assert.equal(continued.status, 202, JSON.stringify(continued.body));
  await follow(api, run.run_id, ["completed"]);
  await until(() => ofType(hook.got, "run.ended").length === 2, "its next end");
  await sleep(500);
  const after = endedIn(data, run.run_id);
  assert.notEqual(after, before);
  assert.deepEqual(ofType(hook.got, "run.ended").map((r) => r.headers["webhook-id"]), [noticeId(run.run_id, "run.ended", before), noticeId(run.run_id, "run.ended", after)], "the old end once, then the new one under its own id");
});

test("a fresh data directory has its since-time right after the first start, before any run, and at or before the first run's end", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const { api, data } = await serve(t);
  const file = join(data, "end-notices-since");
  assert.ok(existsSync(file), "written at the start");
  const since = readFileSync(file, "utf8").trim();
  assert.ok(Number.isFinite(Date.parse(since)), since);
  const run = await startRun(api, "first", "Answer.");
  await follow(api, run.run_id, ["completed"]);
  assert.ok(Date.parse(since) <= Date.parse(endedIn(data, run.run_id)), `${since} is at or before the first run's end`);
  assert.equal(readFileSync(file, "utf8").trim(), since, "and never written again");
});

// ---- the notice ledger: what the outbox has queued of each run, in the outbox's own write.

const ledgerOf = (dir) => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).notices;

test("a notice and its record are one write: the outbox holds the end and the wait it queued of each run; the same moment again queues nothing, here or in the next server", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const first = new Webhooks(dir, env, () => undefined, []);
  t.after(() => first.close());
  first.save({ url: hook.url });
  const ended = new Date().toISOString();
  const run = { run_id: "run_1", agent_id: "a", status: "completed", title: "t" };
  assert.equal(first.emit("run.needs_input", { ...run, status: "input_required", pending: { kind: "question" } }, "row_7"), "queued");
  assert.equal(first.emit("run.ended", run, ended), "queued");
  assert.deepEqual(Object.keys(ledgerOf(dir)), ["run_1"]);
  assert.deepEqual([ledgerOf(dir).run_1.ended, ledgerOf(dir).run_1.wait], [ended, "row_7"], "recorded in the write that queued them");
  assert.equal(first.emit("run.ended", run, ended), "queued", "the same end: already queued");
  await until(() => hook.got.length === 2, "both sent");
  await first.close();
  // The next server reads the ledger: the same end and the same wait queue nothing, a new end of the run does.
  const next = new Webhooks(dir, env, () => undefined, []);
  t.after(() => next.close());
  assert.equal(next.emit("run.ended", run, ended), "queued");
  assert.equal(next.emit("run.needs_input", { ...run, status: "input_required", pending: { kind: "question" } }, "row_7"), "queued");
  const later = new Date(Date.now() + 1_000).toISOString();
  assert.equal(next.emit("run.ended", run, later), "queued");
  await until(() => hook.got.length === 3, "the new end sent");
  await sleep(200);
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).type), ["run.needs_input", "run.ended", "run.ended"]);
  assert.equal(ledgerOf(dir).run_1.ended, later);
});

test("a start's catch-up queues each end the store holds and the ledger does not, once; an end before the since-time or the webhook's own setting is never sent", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const webhooks = new Webhooks(dir, env, () => undefined, []);
  t.after(() => webhooks.close());
  const before = new Date(Date.now() - 60_000).toISOString();
  webhooks.save({ url: hook.url });
  const now = new Date().toISOString();
  const describe = async (id) => ({ run_id: id, agent_id: "a", status: "completed", title: id });
  await webhooks.catchUp([{ id: "old", endedAt: before }, { id: "lost", endedAt: now }], describe);
  await webhooks.catchUp([{ id: "lost", endedAt: now }], describe);
  await until(() => hook.got.length === 1, "the lost end sent");
  await sleep(200);
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).data.run_id), ["lost"], "once, and never the end before the webhook was set");
  assert.equal(ledgerOf(dir).lost.ended, now);
});

test("the ledger keeps an end exactly as long as a start's catch-up looks for it: one just inside the day stays and is not sent again; one just past it is dropped, and not sent either", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
  const inside = new Date(Date.now() - day + 60_000).toISOString();
  const past = new Date(Date.now() - day - 60_000).toISOString();
  // Record-keeping began, and the webhook was set, two days ago; the ledger holds both ends from an earlier server.
  writeFileSync(join(dir, "end-notices-since"), `${new Date(Date.now() - 2 * day).toISOString()}\n`);
  const setup = new Webhooks(dir, env, () => undefined, []);
  setup.save({ url: hook.url });
  await setup.close();
  const config = JSON.parse(readFileSync(join(dir, "webhook.json"), "utf8"));
  writeFileSync(join(dir, "webhook.json"), `${JSON.stringify({ ...config, updated_at: new Date(Date.now() - 2 * day).toISOString() })}\n`);
  writeFileSync(join(dir, "webhook-outbox.json"), `${JSON.stringify({ v: 3, messages: [], attempts: [], notices: { inside: { ended: inside }, past: { ended: past } } })}\n`);
  const webhooks = new Webhooks(dir, env, () => undefined, []);
  t.after(() => webhooks.close());
  // A new notice writes the ledger, pruned as the catch-up would read it.
  webhooks.emit("run.ended", { run_id: "now", agent_id: "a", status: "completed", title: "t" }, new Date().toISOString());
  assert.deepEqual(Object.keys(ledgerOf(dir)).sort(), ["inside", "now"], "the end past the day is dropped; the one inside it stays");
  const describe = async (id) => ({ run_id: id, agent_id: "a", status: "completed", title: id });
  await webhooks.catchUp([{ id: "inside", endedAt: inside }, { id: "past", endedAt: past }], describe);
  await until(() => hook.got.length === 1, "the new end sent");
  await sleep(300);
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).data.run_id), ["now"], "neither earlier end sent again");
});

test("an end just inside the catch-up's day, its ledger entry at the pruning edge, is delivered exactly once across a restart: never twice, never not at all", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
  // Both ends 2 min inside the day: one this server queued, one whose server was killed before the outbox had it.
  const sent = new Date(Date.now() - day + 120_000).toISOString();
  const lost = new Date(Date.now() - day + 120_000).toISOString();
  writeFileSync(join(dir, "end-notices-since"), `${new Date(Date.now() - 2 * day).toISOString()}\n`);
  const first = new Webhooks(dir, env, () => undefined, []);
  first.save({ url: hook.url });
  const config = JSON.parse(readFileSync(join(dir, "webhook.json"), "utf8"));
  writeFileSync(join(dir, "webhook.json"), `${JSON.stringify({ ...config, updated_at: new Date(Date.now() - 2 * day).toISOString() })}\n`);
  const run = (id) => ({ run_id: id, agent_id: "a", status: "completed", title: id });
  first.emit("run.ended", run("sent"), sent);
  // A later notice prunes the ledger: the entry at the edge stays.
  first.emit("run.ended", run("fresh"), new Date().toISOString());
  await until(() => hook.got.length === 2, "both sent");
  await first.close();
  // Its message leaves the outbox as later attempts push it out of the log (ATTEMPTS_KEPT): the ledger alone keeps it.
  const outbox = JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8"));
  writeFileSync(join(dir, "webhook-outbox.json"), `${JSON.stringify({ ...outbox, messages: [], attempts: [] })}\n`);
  const next = new Webhooks(dir, env, () => undefined, []);
  t.after(() => next.close());
  next.emit("run.ended", run("pruning"), new Date().toISOString());
  await next.catchUp([{ id: "sent", endedAt: sent }, { id: "lost", endedAt: lost }], async (id) => run(id));
  // A continuation tells the same end again.
  next.emit("run.ended", run("sent"), sent);
  await until(() => hook.got.length === 4, "the new end and the lost one");
  await sleep(300);
  const of = (id) => hook.got.filter((r) => JSON.parse(r.body).data.run_id === id).length;
  assert.deepEqual([of("sent"), of("lost")], [1, 1], "each end at the edge once");
});

test("an upgrade from a serve.json that still holds the old notice record (end_notice, wait_notice) ignores it: an end it names that the outbox lacks is caught up from the agent store, once", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  // Killed after the store's end and before run.ended is queued.
  const first = await processOn(t, data, [SERVE_END_HELD, data, FAUX]);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(first.api, "older-record", "Answer.");
  const at = await until(() => endedIn(data, run.run_id), "its end in the store");
  await killed(first.child);
  // As an earlier version of this server left the run: its end recorded with it as queued, and a wait.
  const file = join(data, "runs", run.run_id, "serve.json");
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), end_notice: { ended_at: at, queued: true }, wait_notice: { marker: "row_1" } })}\n`);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => ofType(hook.got, "run.ended").length === 1, "its run.ended, from the store");
  assert.equal(ofType(hook.got, "run.ended")[0].headers["webhook-id"], noticeId(run.run_id, "run.ended", at));
  assert.equal((await client(next.baseUrl, next.token)("GET", `/runs/${run.run_id}`)).body.status, "completed", "the old fields are read as nothing");
  await sleep(500);
  assert.equal(ofType(hook.got, "run.ended").length, 1, "once");
  assert.equal(ofType(hook.got, "run.needs_input").length, 0, "the old wait record sends nothing");
});

test("a cancelled run whose last row is an open question, its wait no longer in the ledger, gives no run.needs_input when a later server reads it: an ended run never asks", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "asks-then-cancelled", "Pick a region.", { tools: ["ask_person"] });
  await until(() => ofType(hook.got, "run.needs_input").length === 1, "the wait's notice");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  await follow(api, run.run_id, ["cancelled"]);
  await until(() => ofType(hook.got, "run.ended").length === 1, "its end's notice");
  await first.close();
  stopped = true;
  // The ledger as an upgrade, or a pruning, leaves it: no wait of the run, and its messages gone from the outbox.
  const file = join(data, "webhook-outbox.json");
  const outbox = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify({ ...outbox, messages: [], attempts: [], notices: { [run.run_id]: { ended: outbox.notices[run.run_id].ended } } })}\n`);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  // Read by the next server, rows and all: its last row still asks, and the run is cancelled.
  const view = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(view.status, "cancelled");
  await follow(api, run.run_id, ["cancelled"]);
  await sleep(500);
  assert.equal(ofType(hook.got, "run.needs_input").length, 1, "no wait notice for an ended run");
  assert.equal(ofType(hook.got, "run.ended").length, 1, "and its end once");
});

test("a run still waiting on the same question a day later, its message gone from the outbox, is not asked about again: the ledger keeps a wait until the run moves past it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
  writeFileSync(join(dir, "end-notices-since"), `${new Date(Date.now() - 3 * day).toISOString()}\n`);
  const setup = new Webhooks(dir, env, () => undefined, []);
  setup.save({ url: hook.url });
  await setup.close();
  // Queued two days ago, delivered, and pushed out of the outbox's log since: the ledger alone has the wait.
  const asked = new Date(Date.now() - 2 * day).toISOString();
  writeFileSync(join(dir, "webhook-outbox.json"), `${JSON.stringify({ v: 3, messages: [], attempts: [], notices: { waiting: { wait: "row_9", wait_at: asked } } })}\n`);
  const webhooks = new Webhooks(dir, env, () => undefined, []);
  t.after(() => webhooks.close());
  const waiting = { run_id: "waiting", agent_id: "a", status: "input_required", title: "t", pending: { kind: "question" } };
  // Another run's notice prunes the ledger; then the waiting run is seen again (an adoption, a refresh).
  webhooks.emit("run.ended", { run_id: "other", agent_id: "a", status: "completed", title: "o" }, new Date().toISOString());
  webhooks.emit("run.needs_input", waiting, "row_9");
  await until(() => hook.got.length >= 1, "the other run's end");
  await sleep(300);
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).type), ["run.ended"], "the same wait is not sent again");
  // A new question of the run is a wait of its own, and replaces the last; then the run ends.
  webhooks.emit("run.needs_input", waiting, "row_12");
  const end = new Date().toISOString();
  webhooks.emit("run.ended", { ...waiting, status: "completed", pending: undefined }, end);
  await until(() => hook.got.length >= 3, "the new wait and the end");
  await sleep(300);
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).type), ["run.ended", "run.needs_input", "run.ended"]);
  assert.deepEqual(ledgerOf(dir).waiting, { wait: "row_12", ended: end }, "the newest wait, and the end past it");
});

test("a run that ends while the webhook is off leaves its wait behind in the ledger; the next start, the webhook set again, drops it and sends nothing", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "asks-off", "Pick a region.", { tools: ["ask_person"] });
  await until(() => ofType(hook.got, "run.needs_input").length === 1, "the wait's notice");
  // Off while the run ends: its end is never queued, and nothing moves the run past its wait in the ledger.
  assert.equal((await api("DELETE", "/settings/webhook")).status, 204);
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "eu" })).status, 202);
  await follow(api, run.run_id, ["completed"]);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await first.close();
  stopped = true;
  assert.ok(waitNotice(data, run.run_id), "the wait is still in the ledger");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  await until(() => !noticed(data, run.run_id), "its entry dropped by the start: the store holds the run as ended");
  await sleep(500);
  assert.deepEqual([ofType(hook.got, "run.needs_input").length, ofType(hook.got, "run.ended").length], [1, 0], "nothing sent");
});

test("a start drops the ledger's waits of runs the store holds as ended or no longer has, keeps an end still due, and keeps a wait the run still stands at however old", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
  writeFileSync(join(dir, "end-notices-since"), `${new Date(Date.now() - 3 * day).toISOString()}\n`);
  const setup = new Webhooks(dir, env, () => undefined, []);
  setup.save({ url: hook.url });
  await setup.close();
  const config = JSON.parse(readFileSync(join(dir, "webhook.json"), "utf8"));
  writeFileSync(join(dir, "webhook.json"), `${JSON.stringify({ ...config, updated_at: new Date(Date.now() - 3 * day).toISOString() })}\n`);
  const old = new Date(Date.now() - 2 * day).toISOString();
  const recent = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(dir, "webhook-outbox.json"), `${JSON.stringify({ v: 3, messages: [], attempts: [], notices: { deleted: { wait: "row_1" }, ended: { wait: "row_2" }, kept: { wait: "row_3", ended: recent }, open: { wait: "row_4" } } })}\n`);
  const webhooks = new Webhooks(dir, env, () => undefined, []);
  t.after(() => webhooks.close());
  const describe = async (id) => ({ run_id: id, agent_id: "a", status: "completed", title: id });
  // The store's rows: "deleted" is gone, "ended" and "kept" have ended, "open" still waits (two days on).
  await webhooks.catchUp([{ id: "ended", state: "completed", endedAt: old }, { id: "kept", state: "completed", endedAt: recent }, { id: "open", state: "running" }], describe);
  assert.deepEqual(ledgerOf(dir), { kept: { ended: recent }, open: { wait: "row_4" } });
  await sleep(300);
  assert.equal(hook.got.length, 0, "nothing sent");
});

test("an end the start's catch-up finds while the run's own store is held busy is still queued, once, under its end time's id: the notice is made from the store's row, never from the run's store", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  // Killed after the agent store's end and before run.ended is queued: the next start's catch-up has it to queue.
  const first = await processOn(t, data, [SERVE_END_HELD, data, FAUX]);
  assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(first.api, "busy-store", "Answer.");
  const at = await until(() => endedIn(data, run.run_id), "its end in the store");
  await killed(first.child);
  // The run's own store held by another connection, exclusively, while the next server starts: no read of it lands.
  const held = new DatabaseSync(join(data, "runs", run.run_id, "store", "run.sqlite"), { timeout: 0 });
  held.exec("PRAGMA locking_mode=EXCLUSIVE");
  held.exec("BEGIN EXCLUSIVE");
  held.exec("CREATE TABLE IF NOT EXISTS held_by_the_test (x)");
  const release = () => held.isOpen && (held.isTransaction && held.exec("ROLLBACK"), held.close());
  t.after(release);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", carryBackRetry: { delaysMs: [50] } });
  t.after(() => next.close());
  await sleep(1_500);
  release();
  await until(() => ofType(hook.got, "run.ended").length >= 1, "its run.ended, though the run's store was busy at the start");
  await sleep(500);
  const ended = ofType(hook.got, "run.ended");
  assert.equal(ended.length, 1, "once");
  assert.equal(ended[0].headers["webhook-id"], noticeId(run.run_id, "run.ended", at));
  assert.deepEqual(JSON.parse(ended[0].body).data.status, "completed");
});
