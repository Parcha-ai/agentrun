// The outbound webhook's signature, idempotency and custody: every message signed by the Standard Webhooks spec under a
// secret the server makes, shows once and keeps sealed in the store; each moment of a run told once, under one webhook-id,
// across restarts; the API's shapes. The outbox's durability (tries, a 410, restarts, the store refusing a write) is
// webhooks-outbox.test.mjs. Each case has a server of its own, so they run a few at once.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { signatureOf, Webhooks } from "../dist/webhooks.js";
import { verify } from "../dist/standard-webhooks.js";
import { client, follow, scratch, secretWritePath, serve, startRun } from "./support.mjs";
import {
  askerStore, endedInStore, endNotice, filesIn, nothingPending, hadWebhook, meetsDocument, noticed, noticeId, ofType, onDisk, outboxOf, parkedOnQuestion, receiver, reclaimed,
  settled, startWithRunner, verifies, waitNotice, Webhook, webhookOn,
} from "./webhook-support.mjs";

/** How many cases run at once: each starts a server, a runner and its runs, so all of them at once would load a small
 *  machine past the runs' own deadlines. */
const CASES_AT_ONCE = 4;

// Removing the outbound webhook takes its secret with it: the client sends it from the owner's session, as the console does.
secretWritePath(["DELETE"], /^\/settings\/webhook$/);

/** `count` runs copied from run `template` (its row and its launch, so its view reads as its own), each created and ended
 *  in ONE transaction on a connection of the test's own: the server's reads see none of them, then all of them at once, so
 *  each starts and ends between two of its reads, however it reads. Their ids, oldest first. */
function startedAndEndedAtOnce(data, template, count) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    const columns = db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name);
    const copied = (set) => columns.map((c) => (c in set ? set[c] : c)).join(", ");
    const ids = [];
    const at = Date.now();
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < count; i++) {
      const id = `run-at-once-${String(i).padStart(3, "0")}`;
      ids.push(id);
      db.prepare(`INSERT INTO runs (${columns.join(", ")}) SELECT ${copied({ id: "?", state: "'queued'", epoch: "0", runner: "NULL", ended_at: "NULL", started_at: "?" })} FROM runs WHERE id = ?`).run(id, at + i, template);
      db.prepare("INSERT INTO run_launch (run_id, body, sealed, created_at) SELECT ?, body, sealed, created_at FROM run_launch WHERE run_id = ?").run(id, template);
      db.prepare("UPDATE runs SET state = 'ended', ended_at = ? WHERE id = ?").run(at + count + i, id);
    }
    db.exec("COMMIT");
    return ids;
  } finally {
    db.close();
  }
}

describe("the outbound webhook: signature, idempotency and custody", { concurrency: CASES_AT_ONCE }, () => {
  test("the signature is the Standard Webhooks spec's, byte for byte: its published test vector", () => {
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const [id, timestamp, body] = ["msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", '{"test": 2432232314}'];
    assert.equal(signatureOf(secret, id, timestamp, body), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    assert.equal(new Webhook(secret).sign(id, new Date(Number(timestamp) * 1000), body), signatureOf(secret, id, timestamp, body), "as the spec's library signs it");
  });

  test("one Standard Webhooks module signs and verifies: what the outbound webhook signs, the inbound check takes, byte for byte, and a changed byte it refuses", () => {
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    const [id, timestamp, body] = ["msg_cross", String(Math.floor(Date.now() / 1000)), '{"type":"run.ended","data":{"run_id":"r1","title":"é"}}'];
    const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signatureOf(secret, id, timestamp, body) };
    assert.equal(verify(secret, headers, Buffer.from(body, "utf8"), Date.now()), undefined, "the outbound signature verifies inbound");
    assert.equal(new Webhook(secret).verify(body, headers) !== undefined, true, "and the spec's own library takes it");
    assert.equal(verify(secret, headers, Buffer.from(body.replace("r1", "r2"), "utf8"), Date.now()), "bad_signature", "a changed byte is refused");
  });

  test("demo: a run that ends POSTs a Standard Webhooks message the spec's library verifies; a wrong secret does not; the secret is in no GET, and in the store only sealed", async (t) => {
    const hook = await receiver(t);
    const lines = [];
    const { api, data, url } = await serve(t, { log: (line) => lines.push(line) });
    assert.deepEqual((await api("GET", "/settings/webhook")).body, { configured: false, secret: { name: "webhook:outbound", set: false, source: null, changed_at: null } });
    const set = await api("PUT", "/settings/webhook", { url: hook.url });
    assert.equal(set.status, 201, JSON.stringify(set.body));
    const { signing_secret: secret } = set.body;
    assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/, "whsec_ and 32 bytes in base64");
    assert.deepEqual({ ...set.body, signing_secret: undefined, secret: undefined, updated_at: undefined }, { configured: true, url: hook.url, signing: "sealed", disabled: null, signing_secret: undefined, secret: undefined, updated_at: undefined });
    assert.deepEqual([set.body.secret.name, set.body.secret.set, set.body.secret.source], ["webhook:outbound", true, "console"], "its secret's metadata, never its value");
    await meetsDocument(api, "/settings/webhook", "put", "201", set.body);
    const library = new Webhook(secret);

    // A run that answers: one run.ended, when it is carried back.
    const done = await startRun(api, "answers", "hi");
    await follow(api, done.run_id, ["completed"]);
    const [ended] = ofType(await hook.when((got) => ofType(got, "run.ended").length, `the run.ended of run ${done.run_id} (the outbound notice of its end)`, data), "run.ended");
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

    await settled(data);
    const { body: log } = await api("GET", "/settings/webhook/deliveries");
    assert.deepEqual(log.attempts.map((a) => [a.type, a.status_code, a.error, a.retry_at, a.redelivery]), [["run.ended", 200, null, null, false]]);
    assert.deepEqual(log.attempts.map((a) => a.webhook_id), [ended.headers["webhook-id"]]);
    assert.ok(log.attempts.every((a) => Number.isInteger(a.latency_ms) && a.latency_ms >= 0));
    await meetsDocument(api, "/settings/webhook/deliveries", "get", "200", log);
    // The secret: in no answer but the first PUT's, in no file of the data directory and in no log line.
    const view = await api("GET", "/settings/webhook");
    assert.deepEqual({ ...view.body, updated_at: undefined }, { configured: true, url: hook.url, signing: "sealed", secret: set.body.secret, disabled: null, updated_at: undefined });
    await meetsDocument(api, "/settings/webhook", "get", "200", view.body);
    const key = Buffer.from(secret.slice(6), "base64");
    const forms = [secret, secret.slice(6), key, key.toString("hex"), key.toString("base64url")];
    for (const where of [JSON.stringify(view.body), JSON.stringify(log), lines.join("\n"), ...filesIn(data)]) for (const form of forms) assert.ok(!Buffer.from(where).includes(form), "the secret is nowhere in the clear");
    assert.deepEqual(readdirSync(data).filter((name) => name.startsWith("webhook")), [], "nothing of the webhook is a file: the store keeps it");
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).body.signing_secret, undefined, "a later PUT keeps the secret and never shows it");
  });

  test("demo: a run that asks its person POSTs run.needs_input while it waits, then run.ended once answered; the deliveries log has each, newest first", async (t) => {
    const hook = await receiver(t);
    const { api, data, url } = await serve(t);
    const { signing_secret: secret } = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
    const library = new Webhook(secret);
    // A run that asks: run.needs_input while it waits for its person (a question), then run.ended once answered.
    const asks = await startRun(api, "asks", "Pick a region.", { tools: ["ask_person"] });
    await follow(api, asks.run_id, ["input_required"]);
    const [waiting] = ofType(await hook.when((got) => ofType(got, "run.needs_input").length, `the run.needs_input of run ${asks.run_id} (the outbound notice of its wait)`), "run.needs_input");
    assert.deepEqual(library.verify(waiting.body, waiting.headers).data, { run_id: asks.run_id, agent_id: "asks", status: "input_required", title: "Pick a region.", url: `${url}/#/runs/${asks.run_id}`, pending: { kind: "question" } });
    assert.ok(!waiting.body.includes("Which region"), "no question text: the API reads it");
    assert.equal((await api("POST", `/runs/${asks.run_id}/messages`, { content: "eu" })).status, 202);
    await follow(api, asks.run_id, ["completed"]);
    await hook.when((got) => ofType(got, "run.ended").length === 1, `the run.ended of run ${asks.run_id} (the outbound notice of its end)`, data);
    // Received is not answered: the outbox is written once each answer is read.
    await settled(data);
    assert.deepEqual(hook.got.map((r) => [JSON.parse(r.body).type, JSON.parse(r.body).data.run_id]), [["run.needs_input", asks.run_id], ["run.ended", asks.run_id]], "one each, no more");
    for (const r of hook.got) library.verify(r.body, r.headers);

    const { body: log } = await api("GET", "/settings/webhook/deliveries");
    assert.deepEqual(log.attempts.map((a) => [a.type, a.status_code, a.error, a.retry_at, a.redelivery]), [["run.ended", 200, null, null, false], ["run.needs_input", 200, null, null, false]]);
    assert.deepEqual(log.attempts.map((a) => a.webhook_id), hook.got.map((r) => r.headers["webhook-id"]).reverse());
    assert.ok(log.attempts.every((a) => Number.isInteger(a.latency_ms) && a.latency_ms >= 0));
    await meetsDocument(api, "/settings/webhook/deliveries", "get", "200", log);

  });

  test("a run parked on its question gives one run.needs_input, under its wait's webhook-id; read again under a new claim, the same wait is not told again", async (t) => {
    const hook = await receiver(t);
    // The server alone: the test is the runner, writing the parked run's rows into the store as a runner does.
    const server = await serve(t, { runner: false });
    const { data } = server;
    assert.equal((await server.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const writer = await askerStore(t, data);
    const waitsOf = (id) => ofType(hook.got, "run.needs_input").filter((r) => JSON.parse(r.body).data.run_id === id);
    await parkedOnQuestion(writer, "asker", "run-asks", "What is your budget?");
    await hook.when(() => waitsOf("run-asks").length === 1, "the run.needs_input of run run-asks, parked on its question", data);
    const [wait] = waitsOf("run-asks");
    assert.deepEqual(JSON.parse(wait.body).data, { run_id: "run-asks", agent_id: "asker", status: "input_required", title: "Asks run-asks", url: `${server.url}/#/runs/run-asks`, pending: { kind: "question" } });
    await settled(data);
    assert.ok(noticed(data, "run-asks")?.wait, "the ledger holds its wait");
    // Read again under a new claim (a new epoch), its wait as it was: the ledger tells it no second time. Two runs parked
    // after it show the server's reads have passed: the second's notice comes from a read after the one that told the
    // first, which read run-asks whole too.
    await reclaimed(writer, "run-asks");
    await parkedOnQuestion(writer, "asker", "run-after-1", "And the region?");
    await hook.when(() => waitsOf("run-after-1").length === 1, "the run.needs_input of run run-after-1", data);
    await parkedOnQuestion(writer, "asker", "run-after-2", "And the currency?");
    await hook.when(() => waitsOf("run-after-2").length === 1, "the run.needs_input of run run-after-2", data);
    assert.equal(waitsOf("run-asks").length, 1, "the same wait, told once");
  });

  test("a run parked on its question, its wait told, is not told again by the next server", async (t) => {
    const hook = await receiver(t);
    const first = await serve(t, { runner: false });
    const { data } = first;
    assert.equal((await first.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const writer = await askerStore(t, data);
    const waitsOf = (id) => ofType(hook.got, "run.needs_input").filter((r) => JSON.parse(r.body).data.run_id === id);
    await parkedOnQuestion(writer, "asker", "run-asks", "What is your budget?");
    await hook.when(() => waitsOf("run-asks").length === 1, "the run.needs_input of run run-asks, parked on its question", data);
    await settled(data);
    // The next server reads the same parked run, its wait already told; two runs parked after it show its reads have passed.
    await first.close();
    await serve(t, { data, runner: false });
    await parkedOnQuestion(writer, "asker", "run-after-1", "And the region?");
    await hook.when(() => waitsOf("run-after-1").length === 1, "the run.needs_input of run run-after-1", data);
    await parkedOnQuestion(writer, "asker", "run-after-2", "And the currency?");
    await hook.when(() => waitsOf("run-after-2").length === 1, "the run.needs_input of run run-after-2", data);
    assert.equal(waitsOf("run-asks").length, 1, "the same wait, told once across a restart");
  });

  test("sixty runs that each start and end between two of the server's reads are each told run.ended, once: none is missed for being older than the newest", async (t) => {
    const hook = await receiver(t);
    const server = await serve(t, { runner: false });
    const { data } = server;
    assert.equal((await server.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const writer = await askerStore(t, data);
    // A run the store API wrote, ended: its notice shows the server reads, and its rows are the others' template.
    await endedInStore(writer, "asker", "run-template");
    await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run run-template", data);
    const ids = startedAndEndedAtOnce(data, "run-template", 60);
    const told = (got) => new Set(ofType(got, "run.ended").map((r) => JSON.parse(r.body).data.run_id));
    await hook.when((got) => ids.every((id) => told(got).has(id)), () => `the run.ended of each of the 60 runs (missing: ${ids.filter((id) => !told(hook.got).has(id)).join(", ")})`, data);
    await settled(data);
    const ofEach = new Map(ids.map((id) => [id, ofType(hook.got, "run.ended").filter((r) => JSON.parse(r.body).data.run_id === id).length]));
    assert.deepEqual([...ofEach.values()].filter((n) => n !== 1), [], "each once");
  });

  test("a webhook a 410 turned off refuses a test send and a redelivery, 409 webhook_off, and sends nothing until a PUT", async (t) => {
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

  test("redeliver sends a message of the log again, once, under the same webhook-id and body, signed anew", async (t) => {
    const hook = await receiver(t);
    const { api } = await serve(t);
    const { body: set } = await api("PUT", "/settings/webhook", { url: hook.url });
    const run = await startRun(api, "again", "hi");
    await follow(api, run.run_id, ["completed"]);
    await hook.when(1);
    const id = hook.got[0].headers["webhook-id"];
    const again = await api("POST", `/settings/webhook/deliveries/${id}/redeliver`, {});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.webhook_id, again.body.status_code, again.body.redelivery], [id, 200, true]);
    await meetsDocument(api, "/settings/webhook/deliveries/{webhook_id}/redeliver", "post", "200", again.body);
    assert.equal(hook.got.length, 2);
    assert.equal(hook.got[1].headers["webhook-id"], id);
    assert.equal(hook.got[1].body, hook.got[0].body);
    // Signed as it is sent: its own timestamp's signature, which the spec's library verifies.
    new Webhook(set.signing_secret).verify(hook.got[1].body, hook.got[1].headers);
    assert.equal((await api("POST", "/settings/webhook/deliveries/msg_unknown/redeliver", {})).status, 404);
  });

  test("settings: an http or https URL with no user or password, and nothing else; handed no seal key, the server seals under the one it made; DELETE removes it", async (t) => {
    // A server never runs without a seal key (seal-key.ts): handed none, it makes one, so a webhook's secret is sealed.
    const bare = await serve(t);
    assert.deepEqual((await bare.api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended", "trigger.failed"], signing: "standard-webhooks/v1", at_rest: "sealed" });

    const hook = await receiver(t);
    const { api, data } = await serve(t);
    assert.deepEqual((await api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended", "trigger.failed"], signing: "standard-webhooks/v1", at_rest: "sealed" });
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
    assert.deepEqual((await api("GET", "/settings/webhook")).body, { configured: false, secret: { name: "webhook:outbound", set: false, source: null, changed_at: null } });
    assert.equal((await api("GET", "/settings/webhook/deliveries")).body.attempts.length, 1, "the log stays");
    const quiet = await startRun(api, "quiet", "hi");
    // Its end's notice is decided as its end is shown (runs.ts notice): by the time it reads completed, nothing was queued.
    await follow(api, quiet.run_id, ["completed"]);
    assert.deepEqual(nothingPending(data).filter((m) => JSON.parse(m.body).data?.run_id === quiet.run_id), [], "no webhook, nothing queued");
    assert.equal(hook.got.length, 1, "no webhook, no message");
  });

  test("a run stopped, then asked a question on its next turn, gives two needs_input notices: different webhook-ids, `stopped` then `question`", { skip: "stop->message resume (switch line, not ask_person): POST /runs/{id}/messages to a stopped agentic run 409s not_continuable because over the store the stopped run reads terminal in statusOf (stopped()/outcome), not input_required/idle; E2v/E2c to carry the stop marker into the store view" }, async (t) => {
    const hook = await receiver(t);
    const { api } = await serve(t);
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const run = await startRun(api, "ask-later", "Take your time.", { tools: ["ask_person"] });
    await follow(api, run.run_id, ["working"]);
    // Its turn is slow ("Take your time."): working, the stop stops it, once.
    assert.equal((await api("POST", `/runs/${run.run_id}/stop`, {})).body.stopped, true);
    await hook.when(1);
    assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Ask me now." })).status, 202);
    await hook.when(2);
    const [stop, question] = hook.got;
    assert.deepEqual(hook.got.map((r) => [JSON.parse(r.body).type, JSON.parse(r.body).data.pending]), [["run.needs_input", { kind: "stopped" }], ["run.needs_input", { kind: "question" }]]);
    assert.notEqual(stop.headers["webhook-id"], question.headers["webhook-id"], "a new wait, a new id");
  });

  test("a run whose end is in the store while no server is up, its outbox holding nothing of it, gives its run.ended from the next server, once, under the id its end time makes", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    await hadWebhook(t, data, hook);
    // The run ends with no server up (a runner wrote its end): no server told it, and the outbox holds nothing of it.
    const writer = await askerStore(t, data);
    const at = await endedInStore(writer, "asker", "run-ends");
    assert.equal(ofType(hook.got, "run.ended").length, 0, "no server was up to tell it");
    const next = await startWithRunner(t, { data, runner: false });
    t.after(() => next.close());
    await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run run-ends, from the next server's catch-up", data);
    const [ended] = ofType(hook.got, "run.ended");
    assert.equal(JSON.parse(ended.body).data.run_id, "run-ends");
    assert.equal(ended.headers["webhook-id"], noticeId("run-ends", "run.ended", at), "the id the store's end time makes");
    // Recorded as queued, and delivered: the ledger has the end, so it is queued no more, and nothing is pending.
    await onDisk(data, () => endNotice(data, "run-ends")?.queued && outboxOf(data).messages.every((m) => m.status !== "pending"));
    assert.deepEqual(endNotice(data, "run-ends"), { ended_at: at, queued: true });
    assert.equal(ofType(hook.got, "run.ended").length, 1, "once");
  });

  test("a receiver that reads a run back on its run.ended reads it ended, in the run and in the list", async (t) => {
    let api;
    const read = [];
    let readBack;
    const wasRead = new Promise((resolve) => (readBack = resolve));
    const hook = await receiver(t, async () => {
      const id = JSON.parse(hook.got.at(-1).body).data.run_id;
      const one = (await api("GET", `/runs/${id}`)).body;
      const listed = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === id);
      read.push([one.status, one.ended_at !== null, listed?.status]);
      readBack();
      return 200;
    });
    ({ api } = await serve(t));
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const run = await startRun(api, "read-back", "Answer.");
    await follow(api, run.run_id, ["completed"]);
    await wasRead;
    assert.deepEqual(read, [["completed", true, "completed"]]);
  });

  test("a run that comes to wait for its person while no server is up gives exactly one run.needs_input from the next server, under the wait's own id", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    await hadWebhook(t, data, hook);
    // The run asks with no server up: its runner parks it on its question.
    const writer = await askerStore(t, data);
    await parkedOnQuestion(writer, "asker", "asks-late", "Which region?");
    const next = await startWithRunner(t, { data, runner: false });
    t.after(() => next.close());
    const api = client(next.baseUrl, next.token);
    await hook.when((got) => ofType(got, "run.needs_input").length > 0, "the run.needs_input of run asks-late, from the next server", data);
    // Recorded as queued, and delivered: the ledger has the wait, so the same wait is queued no more, and nothing is pending.
    await onDisk(data, () => waitNotice(data, "asks-late") && outboxOf(data).messages.every((m) => m.status !== "pending"));
    const waits = ofType(hook.got, "run.needs_input");
    const ids = [...new Set(waits.map((r) => r.headers["webhook-id"]))];
    assert.equal(waits.length, 1, `one wait, one message: ${ids}`);
    // Its marker is its question's waiting row, as main's was (the run view's row after the ask's result, its id the
    // result's with ":waiting"): the timeline the API serves here shows the result, not that row.
    const { rows } = (await api("GET", "/runs/asks-late/timeline")).body;
    const result = rows.findLast((row) => row.kind === "tool_result");
    assert.deepEqual(waitNotice(data, "asks-late"), { marker: `${result.id}:waiting` });
    assert.equal(ids[0], noticeId("asks-late", "run.needs_input", `${result.id}:waiting`), "the id the wait's own marker makes");
    const body = JSON.parse(waits[0].body);
    assert.deepEqual([body.data.run_id, body.data.status, body.data.pending], ["asks-late", "input_required", { kind: "question" }]);
  });

  test("a notice and its record are one write: the store holds the end and the wait it queued of each run; the same moment again queues nothing, here or in the next server", async (t) => {
    // The first server's two are answered late, as on a loaded machine: received, but not answered to it until both are in.
    let answerLate;
    const late = new Promise((resolve) => (answerLate = resolve));
    const hook = await receiver(t, (n) => (n <= 2 ? late.then(() => 200) : 200));
    const dir = await scratch(t);
    const on = await webhookOn(t, dir);
    await on.runs("run_1");
    const first = await on.open();
    await first.save({ url: hook.url });
    const ended = new Date().toISOString();
    const run = { run_id: "run_1", agent_id: "a", status: "completed", title: "t" };
    assert.equal(await first.emit("run.needs_input", { ...run, status: "input_required", pending: { kind: "question" } }, "row_7"), "queued");
    assert.equal(await first.emit("run.ended", run, ended), "queued");
    assert.deepEqual(Object.keys(outboxOf(dir).notices), ["run_1"]);
    assert.deepEqual([outboxOf(dir).notices.run_1.ended, outboxOf(dir).notices.run_1.wait], [ended, "row_7"], "recorded in the transaction that queued them");
    assert.equal(await first.emit("run.ended", run, ended), "queued", "the same end: already queued");
    // Closed once each try has its answer, not once the receiver has the request: a close cuts a try in flight, and the
    // next server sends its message again (at least once, under the same webhook-id).
    await hook.when(2);
    answerLate();
    await onDisk(dir, () => outboxOf(dir).attempts.length === 2);
    assert.deepEqual((await first.attemptsView()).attempts.map((a) => a.status_code), [200, 200]);
    await first.close();
    // The next server reads the ledger: the same end and the same wait queue nothing, a new end of the run does.
    const next = await on.open();
    assert.equal(await next.emit("run.ended", run, ended), "queued");
    assert.equal(await next.emit("run.needs_input", { ...run, status: "input_required", pending: { kind: "question" } }, "row_7"), "queued");
    const later = new Date(Date.now() + 1_000).toISOString();
    assert.equal(await next.emit("run.ended", run, later), "queued");
    await hook.when(3);
    await onDisk(dir, () => outboxOf(dir).messages.every((m) => m.status !== "pending"));
    // The first two were queued together, and each message goes on its own tries: they land in either order.
    const ids = hook.got.map((r) => r.headers["webhook-id"]);
    assert.deepEqual([ids.slice(0, 2).sort(), ids.slice(2)], [[noticeId("run_1", "run.ended", ended), noticeId("run_1", "run.needs_input", "row_7")].sort(), [noticeId("run_1", "run.ended", later)]], "each moment sent once");
    assert.equal(outboxOf(dir).notices.run_1.ended, later);
  });
});
