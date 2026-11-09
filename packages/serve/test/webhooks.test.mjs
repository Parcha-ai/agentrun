// The webhook: one URL the server POSTs to when a run comes to need its person and when it ends, signed by the
// Standard Webhooks spec. Its secret is made by the server, shown once, and kept sealed; a message not answered 2xx is
// tried again, then logged as failed; a pending one goes on after a restart; a 410 turns the webhook off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { openSqliteStore } from "../dist/store/index.js";
import { startServe } from "../dist/index.js";
import { ATTEMPTS_KEPT, signatureOf, Webhooks } from "../dist/webhooks.js";
import { verify } from "../dist/standard-webhooks.js";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, follow, printed, scratch, secretWritePath, serve, startInProcessRunner, startRun, withEnv } from "./support.mjs";

// Removing the outbound webhook takes its secret with it: the client sends it from the owner's session, as the console does.
secretWritePath(["DELETE"], /^\/settings\/webhook$/);

// The spec's own library, in the lockfile through the Anthropic SDK: what a receiver would install.
const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const sealKey = () => randomBytes(32).toString("base64");
const SEAL = ["AGENTRUN_SEAL_KEY"];

/** How long an awaited event may be missing before its test fails, naming it: a fence against a test that would hang to
 *  the runner's timeout when what it waits on never comes, never a timing (every pass waits for the event itself). */
const ARRIVAL_MS = 60_000;
/** What the outbox in `dir` holds, in one line, for a failure's words: each message's type and status, and the ledger. */
function outboxState(dir) {
  try {
    const outbox = JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8"));
    return `outbox: ${outbox.messages.map((m) => `${m.type} ${m.status}`).join(", ") || "no message"}; ledger: ${JSON.stringify(outbox.notices ?? {})}`;
  } catch {
    return "outbox: none on disk";
  }
}
/** `promise`, or a failure naming `what` (a string, or one made at the failure) once ARRIVAL_MS pass without it, with the
 *  outbox in `dir` as it stood then. */
function arriving(promise, what, dir) {
  let timer;
  const fence = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${typeof what === "function" ? what() : what} did not come within ${ARRIVAL_MS / 1000} s${dir ? ` (${outboxState(dir)})` : ""}`)), ARRIVAL_MS);
    timer.unref();
  });
  return Promise.race([promise, fence]).finally(() => clearTimeout(timer));
}

/** A receiver on 127.0.0.1 at a port of its own: each request to its own path, with its headers and body, answered
 *  `answer(n)` (n from 1; a promise holds the answer until it settles). A request to another path (another process's,
 *  at a port it once had) is not counted. `down`: every connection is reset, as a receiver that is not there.
 *  `when(n)`: once it holds `n` requests (or `when(check)`, once `check(got)`), the requests, as each one comes: no
 *  poll; `what` names it in the failure when it does not come (arriving), with the outbox in `dir` as it stood then. */
async function receiver(t, answer = () => 200, down = false) {
  const got = [];
  const waiting = [];
  const path = `/hook/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (down) return void req.socket.destroy();
    if (req.url !== path) return void res.writeHead(404).end();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      for (const w of [...waiting]) if (w.check(got)) (waiting.splice(waiting.indexOf(w), 1), w.resolve(got));
      void Promise.resolve(answer(got.length)).then((status) => {
        if (!res.destroyed) res.writeHead(status, status >= 300 && status < 400 ? { location: "http://127.0.0.1:1/elsewhere" } : {}).end();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  const when = (want, what = typeof want === "number" ? `request ${want} at the receiver` : "the request awaited at the receiver", dir) => {
    const check = typeof want === "number" ? (all) => all.length >= want : want;
    return check(got) ? Promise.resolve(got) : arriving(new Promise((resolve) => waiting.push({ check, resolve })), () => `${typeof what === "function" ? what() : what} (the receiver holds ${got.length}: ${got.map((r) => JSON.parse(r.body).type).join(", ") || "none"})`, dir);
  };
  return { url: `http://127.0.0.1:${server.address().port}${path}`, got, server, when };
}

/** A log for a server or a Webhooks: `push` takes a line (or a say's fields, as a line), `when(...parts)` the first line
 *  holding every part, as it is said. */
function logged() {
  const lines = [];
  const waiting = [];
  const push = (line) => {
    const text = typeof line === "string" ? line : Object.entries(line).map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(text);
    for (const w of [...waiting]) if (w.parts.every((part) => text.includes(part))) (waiting.splice(waiting.indexOf(w), 1), w.resolve(text));
  };
  const when = (...parts) => {
    const found = lines.find((line) => parts.every((part) => line.includes(part)));
    return found ? Promise.resolve(found) : arriving(new Promise((resolve) => waiting.push({ parts, resolve })), `the log line with ${parts.join(" and ")}`);
  };
  return { lines, push, when };
}

/** `check()`'s value once truthy, read again at each change in `dir` (a file written or renamed there): what the server
 *  writes, awaited as it is written, never polled. A read that meets a file mid-write is read again at the next change. */
function onDisk(dir, check, what = `the state awaited in ${dir}`) {
  const read = () => {
    try {
      return check();
    } catch {
      return undefined;
    }
  };
  const now = read();
  if (now) return Promise.resolve(now);
  let watcher;
  const written = new Promise((resolve) => {
    watcher = watch(dir, (_, file) => {
      // A reader's own shared-memory or journal file is no write of the server's.
      if (file && /-(shm|journal)$/.test(file)) return;
      const value = read();
      if (value) (watcher.close(), resolve(value));
    });
    // A change between the first read and the watch: read once more, now that it watches.
    const value = read();
    if (value) (watcher.close(), resolve(value));
  });
  return arriving(written, what, existsSync(join(dir, "webhook-outbox.json")) ? dir : undefined).finally(() => watcher.close());
}

/** The outbox on disk: its messages, none still to try. A message is tried only while pending (webhooks.ts schedule), so
 *  with none pending no try is armed and nothing more is sent: what a sleep and a count used to wait out. */
function nothingPending(dir) {
  const file = join(dir, "webhook-outbox.json");
  const messages = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).messages : [];
  assert.deepEqual(messages.filter((m) => m.status === "pending").map((m) => m.id), [], "no message still to try");
  return messages;
}
/** Once the outbox on disk holds no message still to try (each answered and written): then nothing more is sent. */
const settled = (dir) => onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
/** A server on `options.data` with a runner beside it on the same data (support's in-process runner, as serve() starts
 *  one), so a run it starts runs: `close()` stops the runner, letting go of its claims, then the server. `runner: false`:
 *  the server alone, for a test that writes its runs into the store itself. */
async function startWithRunner({ runner = true, ...options }) {
  const server = await startServe({ port: 0, faux: FAUX, drainTimeout: "5s", ...options });
  const stopRunner = runner ? await startInProcessRunner(options.data, { faux: FAUX }) : async () => {};
  return { ...server, close: async () => (await stopRunner(), await server.close()) };
}
/** A turn of the event loop: past the microtasks, where an unhandled rejection is said. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

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

test("one Standard Webhooks module signs and verifies: what the outbound webhook signs, the inbound check takes, byte for byte, and a changed byte it refuses", () => {
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const [id, timestamp, body] = ["msg_cross", String(Math.floor(Date.now() / 1000)), '{"type":"run.ended","data":{"run_id":"r1","title":"é"}}'];
  const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signatureOf(secret, id, timestamp, body) };
  assert.equal(verify(secret, headers, Buffer.from(body, "utf8"), Date.now()), undefined, "the outbound signature verifies inbound");
  assert.equal(new Webhook(secret).verify(body, headers) !== undefined, true, "and the spec's own library takes it");
  assert.equal(verify(secret, headers, Buffer.from(body.replace("r1", "r2"), "utf8"), Date.now()), "bad_signature", "a changed byte is refused");
});

test("demo: a run that ends POSTs a Standard Webhooks message the spec's library verifies; a wrong secret does not; the secret is in no GET and on disk only sealed", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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
  assert.equal(statSync(join(data, "webhook.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(data, "webhook-outbox.json")).mode & 0o777, 0o600);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).body.signing_secret, undefined, "a later PUT keeps the secret and never shows it");
});
// The demo's second half, on the switch line: its run never parks on ask_person, so it never asks. Kept, and skipped until
// it does; the needs_input notice itself is held by the test after it, on a parked run the store holds.
test("demo: a run that asks its person POSTs run.needs_input while it waits, then run.ended once answered; the deliveries log has each, newest first", { skip: "waits on ask_person parking the run on the runner (switch line)" }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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


/** Run `id` of `agentId`, parked on the question it asked, as a runner leaves it (its ask, then its release as parked):
 *  written into the store by `writer` (a runner's handle), so no runner's ask_person is needed. Its wake time is past, so
 *  the test can claim it again (no runner runs beside these tests' servers to claim it first). */
async function parkedOnQuestion(writer, agentId, id, question, { wake = true } = {}) {
  const ROOT = 1;
  const at = Date.now();
  await writer.runs.create({ id, agentId, revisionId: `${agentId}-rev` }, { body: { input: { message: "Help me." }, title: `Asks ${id}`, place: { mode: "runner" } } });
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  const journal = writer.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Help me.", timestamp: at }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "ask_person", arguments: { question } }], usage: { cost: { total: 0.01 } }, timestamp: at + 1 }] };
  const r = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: [{ type: "text", text: "asked" }], timestamp: at + 2 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }, { type: "entry", value: r }], BACKGROUND_CONTEXT);
  // Its wake time past, the test can claim it again; with a runner up (`wake: false`), none, so no runner claims it.
  await writer.release(claim, { state: "parked", wakeAt: wake ? Date.now() - 1 : null });
}
/** Run `id` of `agentId`, ended with its answer, as a runner ends one: written into the store by `writer`. Its end's time,
 *  as the store stamped it (ISO), which its run.ended's webhook-id is made from. */
async function endedInStore(writer, agentId, id) {
  const ROOT = 1;
  const at = Date.now();
  await writer.runs.create({ id, agentId, revisionId: `${agentId}-rev` }, { body: { input: { message: "Answer." }, title: `Ends ${id}`, place: { mode: "runner" } } });
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  const journal = writer.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Answer.", timestamp: at }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], usage: { cost: { total: 0.01 } }, timestamp: at + 1 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }], BACKGROUND_CONTEXT);
  const row = await writer.runs.update(claim, { state: "ended" });
  return new Date(row.endedAt).toISOString();
}
/** Run `id`, parked, ended by `state` under a new claim (stopped, as a cancel leaves it; or ended). */
async function endParked(writer, id, state) {
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  return (await writer.runs.update(claim, { state })).endedAt;
}
/** A server on `data` that had the webhook set to `hook` and stopped: what a restart starts from. */
async function hadWebhook(data, hook) {
  const first = await startWithRunner({ data, runner: false });
  assert.equal((await client(first.baseUrl, first.token)("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await first.close();
}
/** Run `id`, parked, read again under a new claim: claimed and let go as parked, its wait as it was (a new epoch). */
async function reclaimed(writer, id) {
  const claim = await writer.claim(id, "test-runner", { leaseMs: 60_000 });
  await writer.release(claim, { state: "parked", wakeAt: Date.now() - 1 });
}
/** The server's store, as a runner's handle on it, and the agent `asker` in it. */
async function askerStore(t, data) {
  const writer = await openSqliteStore({ dataDir: data, role: "runner" });
  t.after(() => writer.close());
  await writer.agents.create({ id: "asker", name: "asker" }, { id: "asker-rev", kind: "agentic", body: { instructions: "Answer." } });
  return writer;
}

test("a run parked on its question gives one run.needs_input, under its wait's webhook-id; read again under a new claim, the same wait is not told again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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

test("sixty runs that each start and end between two of the server's reads are each told run.ended, once: none is missed for being older than the newest", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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

test("a receiver that is down gets each try, then the message is logged as failed; one that fails then answers gets it on a try again, under the same webhook-id; a redirect is not followed", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const log = logged();
  const { api } = await serve(t, { webhookRetryMs: [100, 100], log: log.push });
  const gone = await receiver(t, () => 200, true);
  assert.equal((await api("PUT", "/settings/webhook", { url: gone.url })).status, 201);
  const down = await startRun(api, "down", "hi");
  await follow(api, down.run_id, ["completed"]);
  // Every try of the run's run.ended to a receiver that is down, then the failure said: none comes without the notice.
  const failed = await log.when("event=webhook", "condition=delivery_failed");
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
  await flaky.when(2, `the run.ended of run ${again.run_id}, tried again after a 503`);
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
  const log = logged();
  const { api, data } = await serve(t, { webhookRetryMs: [100, 100], log: log.push });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const first = await startRun(api, "gone", "hi");
  await follow(api, first.run_id, ["completed"]);
  // Said as it turns off, in the step that turns it off: the setting reads off from then on.
  await log.when("condition=webhook_disabled");
  const off = (await api("GET", "/settings/webhook")).body.disabled;
  assert.equal(off.reason, "the receiver answered 410 Gone");
  // Its pending messages are dropped, and written, just after it is said.
  await settled(data);
  assert.equal(hook.got.length, 1, "no try after the 410");
  const second = await startRun(api, "quiet", "hi");
  // Its end's notice is decided as its end is shown (runs.ts notice): by the time it reads completed, nothing was queued.
  await follow(api, second.run_id, ["completed"]);
  assert.deepEqual(nothingPending(data).filter((m) => JSON.parse(m.body).data?.run_id === second.run_id), [], "off: nothing is queued");
  assert.equal(hook.got.length, 1, "off: nothing is sent");
  answer = 200;
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).body.disabled, null, "a PUT sets it on again");
  const third = await startRun(api, "back", "hi");
  await follow(api, third.run_id, ["completed"]);
  await hook.when(2);
  assert.equal(JSON.parse(hook.got[1].body).data.run_id, third.run_id, "sent again: the run after the PUT");
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
  await hook.when(redelivery);
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
  const log = logged();
  const { api, data } = await serve(t, { webhookRetryMs: [100, 100], log: log.push });
  const set = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  // The webhook's temporary file is a directory: its write fails, as on a full disk.
  const blocked = join(data, "webhook.json.tmp");
  mkdirSync(blocked);
  const first = await startRun(api, "gone", "hi");
  await follow(api, first.run_id, ["completed"]);
  await log.when("condition=webhook_disabled");
  const off = (await api("GET", "/settings/webhook")).body.disabled;
  assert.equal(off.reason, "the receiver answered 410 Gone");
  assert.ok(log.lines.some((line) => line.includes("condition=webhook_unwritable")), "the log says the write failed");
  assert.equal(JSON.parse(readFileSync(join(data, "webhook.json"), "utf8")).disabled, undefined, "not on disk");
  const second = await startRun(api, "quiet", "hi");
  await follow(api, second.run_id, ["completed"]);
  assert.deepEqual(nothingPending(data).filter((m) => JSON.parse(m.body).data?.run_id === second.run_id), [], "off: nothing is queued");
  assert.equal(hook.got.length, 1, "off: nothing more is sent");
  rmdirSync(blocked);
  answer = 200;
  const again = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  assert.equal(again.disabled, null, "a PUT sets it on again");
  const written = JSON.parse(readFileSync(join(data, "webhook.json"), "utf8"));
  assert.deepEqual([written.url, written.updated_at, written.disabled], [set.url, again.updated_at, undefined], "and writes it");
  const third = await startRun(api, "back", "hi");
  await follow(api, third.run_id, ["completed"]);
  await hook.when(2);
  assert.equal(JSON.parse(hook.got[1].body).data.run_id, third.run_id, "sent again: the run after the PUT");
  await turn();
  assert.deepEqual(rejected, [], "no unhandled rejection");
});

test("a scheduled try that throws is said in the log, never an unhandled rejection", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const rejected = rejections(t);
  const hook = await receiver(t, () => 500);
  const said = [];
  let thrown;
  const throwSaid = new Promise((resolve) => (thrown = resolve));
  // A log that throws on the line a failed try ends with: the try throws after its POST.
  const say = (fields) => {
    if (fields.condition === "delivery_failed") throw new Error("the log is gone");
    said.push(fields);
    if (fields.condition === "attempt_failed") thrown();
  };
  const webhooks = new Webhooks(await scratch(t), { AGENTRUN_SEAL_KEY: sealKey() }, say, []);
  t.after(() => webhooks.close());
  webhooks.save({ url: hook.url });
  webhooks.emit("run.ended", { run_id: "run_1", agent_id: "a", status: "completed", title: "t" }, "m1");
  await throwSaid;
  assert.equal(hook.got.length, 1);
  assert.deepEqual(said.filter((fields) => fields.condition === "attempt_failed").map(({ error }) => error), ["the log is gone"]);
  // An unhandled rejection is said once the microtasks of its turn have run: a turn later, it would be in.
  await turn();
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
  await old.when(1);
  assert.equal((await api("PUT", "/settings/webhook", { url: fresh.url })).status, 200);
  release();
  await fresh.when(1);
  assert.equal(fresh.got[0].headers["webhook-id"], old.got[0].headers["webhook-id"]);
  const view = (await api("GET", "/settings/webhook")).body;
  assert.deepEqual([view.url, view.disabled], [fresh.url, null], "the new setting stands, on");
});

test("redeliveries that fail leave the message's own schedule as it was: it is still tried on every wait", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t, () => 500);
  const log = logged();
  const { api } = await serve(t, { webhookRetryMs: [1_500, 100, 100], log: log.push });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "redone", "hi");
  await follow(api, run.run_id, ["completed"]);
  await hook.when(1);
  const id = hook.got[0].headers["webhook-id"];
  for (let i = 0; i < 4; i++) assert.equal((await api("POST", `/settings/webhook/deliveries/${id}/redeliver`, {})).body.status_code, 500);
  const failed = await log.when("condition=delivery_failed");
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

test("a message pending when its server stops goes on from the next one, under the same webhook-id; a run the next server reads as it already stood notices nothing", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let answer = 503;
  const hook = await receiver(t, () => answer);
  const data = join(await scratch(t), "agents");
  const first = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "5s", webhookRetryMs: [2_000] });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  const { body: set } = await api("PUT", "/settings/webhook", { url: hook.url });
  const run = await startRun(api, "pending", "hi");
  await follow(api, run.run_id, ["completed"]);
  await hook.when(1);
  // Its first try answered and its next one set, as the outbox on disk says it.
  await onDisk(data, () => JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).messages.some((m) => m.status === "pending" && m.attempts === 1 && m.next_at));
  await first.close();
  stopped = true;
  answer = 200;
  const next = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  await hook.when(2);
  assert.equal(hook.got[1].headers["webhook-id"], hook.got[0].headers["webhook-id"]);
  new Webhook(set.signing_secret).verify(hook.got[1].body, hook.got[1].headers);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.status, "completed");
  // Delivered, and the ledger holds the run's end as the store does: a start's catch-up queues no end the ledger has, so
  // the run, read as it already ended, is no new notice.
  await onDisk(data, () => JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  assert.equal(noticed(data, run.run_id)?.ended, (await api("GET", `/runs/${run.run_id}`)).body.ended_at);
  assert.equal(hook.got.length, 2, "the run, read as it already ended, is no new notice");
});

test("settings: an http or https URL with no user or password, and nothing else; handed no seal key, the server seals under the one it made; DELETE removes it", async (t) => {
  // A server never runs without a seal key (seal-key.ts): handed none, it makes one, so a webhook's secret is sealed.
  withEnv(t, {}, SEAL);
  const bare = await serve(t);
  assert.deepEqual((await bare.api("GET", "/capabilities")).body.features.webhooks, { routes: true, events: ["run.needs_input", "run.ended", "trigger.failed"], signing: "standard-webhooks/v1", at_rest: "sealed" });

  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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
  const first = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "10s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "soon", "Answer soon.");
  await follow(api, run.run_id, ["working"]);
  // The stop drains the run's turn: it answers, and is carried back, while the server closes.
  await first.close();
  stopped = true;
  const next = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  // The run ends on the next server's runner (its first runner let it go as its server stopped), and its notice comes from
  // the next server.
  await follow(api, run.run_id, ["completed"]);
  await hook.when((got) => ofType(got, "run.ended").some((r) => JSON.parse(r.body).data.run_id === run.run_id));
});

test("a try in flight when its server closes is cut and waited for; nothing is written after, and the next server delivers it; a test send left pending is not tried again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const hook = await receiver(t, (n) => (n === 1 ? held.then(() => 200) : 200));
  t.after(() => release());
  const data = join(await scratch(t), "agents");
  const first = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let stopped = false;
  t.after(() => stopped || first.close());
  let api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "held", "hi");
  await follow(api, run.run_id, ["completed"]);
  await hook.when(1);
  const outbox = join(data, "webhook-outbox.json");
  const before = readFileSync(outbox, "utf8");
  // The close comes back while the receiver still holds the try unanswered: the try is cut, not waited out (a close
  // that waited for its answer would never come back before the release below).
  await first.close();
  stopped = true;
  release();
  // The held answer goes out to a cut connection; nothing of the closed server reads it.
  await held;
  await turn();
  assert.equal(readFileSync(outbox, "utf8"), before, "nothing written after the close");
  const left = JSON.parse(before);
  const [pending] = left.messages;
  assert.deepEqual([pending.status, pending.attempts], ["pending", 0]);
  // A test send an earlier server left in flight: the next one marks it failed and never sends it.
  left.messages.push({ ...pending, id: `msg_${"0".repeat(32)}`, type: "webhook.test", body: JSON.stringify({ type: "webhook.test", timestamp: new Date().toISOString(), data: {} }) });
  writeFileSync(outbox, JSON.stringify(left));
  const next = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  api = client(next.baseUrl, next.token);
  await hook.when(2);
  assert.equal(hook.got[1].headers["webhook-id"], pending.id);
  // The next server marked the test send failed as it read the outbox, so no try of it is armed: once the run's message
  // is delivered, nothing is pending, and nothing more is sent.
  await onDisk(data, () => JSON.parse(readFileSync(outbox, "utf8")).messages.every((m) => m.status !== "pending"));
  assert.equal(hook.got.length, 2, "the test send is not sent again");
  assert.deepEqual(JSON.parse(readFileSync(outbox, "utf8")).messages.find((m) => m.type === "webhook.test")?.status ?? "failed", "failed");
});

test("a run stopped, then asked a question on its next turn, gives two needs_input notices: different webhook-ids, `stopped` then `question`", { skip: "waits on ask_person parking the run on the runner (switch line)" }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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

test("a notice the outbox could not be written with is kept, and written by the close: a stop never loses it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  // Its first try is held unanswered: what the server holds then is all there is, and the close cuts the try.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const hook = await receiver(t, () => held.then(() => 503));
  t.after(() => release());
  const log = logged();
  const data = join(await scratch(t), "agents");
  const server = await startWithRunner({ data, port: 0, faux: FAUX, drainTimeout: "5s", webhookRetryMs: [60_000], log: log.push });
  let stopped = false;
  t.after(() => stopped || server.close());
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  // The outbox's temporary file is a directory: each write of it fails, as on a full disk.
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const run = await startRun(api, "unsaved", "hi");
  await follow(api, run.run_id, ["completed"]);
  await hook.when(1);
  // Its notice was queued, and its write tried, as its end was shown: written never, said once.
  assert.equal(existsSync(join(data, "webhook-outbox.json")), false, "never written");
  assert.equal(log.lines.filter((line) => line.includes("condition=outbox_unwritable")).length, 1, "said once");
  rmdirSync(blocked);
  await server.close();
  stopped = true;
  release();
  const kept = JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).messages;
  assert.deepEqual(kept.map((m) => [m.id, m.type, m.status]), [[hook.got[0].headers["webhook-id"], "run.ended", "pending"]], "the close wrote it, pending, for the next server");
});

test("a try that fails after a redelivery delivered the same message leaves it delivered: no failure is said", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const hook = await receiver(t, (n) => (n === 1 ? held.then(() => 500) : 200));
  t.after(() => release());
  const log = logged();
  const { api, data } = await serve(t, { webhookRetryMs: [], log: log.push });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const run = await startRun(api, "both", "hi");
  await follow(api, run.run_id, ["completed"]);
  await hook.when(1);
  const id = hook.got[0].headers["webhook-id"];
  assert.equal((await api("POST", `/settings/webhook/deliveries/${id}/redeliver`, {})).body.status_code, 200);
  release();
  // Both tries in the outbox's log on disk: a try's failure would be said before its write (webhooks.ts attempt).
  await onDisk(data, () => JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).attempts.length === 2);
  assert.equal(log.lines.filter((line) => line.includes("condition=delivery_failed")).length, 0, "no false failure");
});

// ---- a run's end and its run.ended, one durable step: the end's time is chosen once and saved first, run.ended is
// queued only once the agent store has the end, and recorded as queued only once the outbox holds it on disk.

/** What the webhook's ledger (webhook-outbox.json, on disk) holds of a run: undefined for none, or no outbox yet. */
const noticed = (data, runId) => (existsSync(join(data, "webhook-outbox.json")) ? JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).notices?.[runId] : undefined);
/** The ledger's end of the run, as `{ended_at, queued}`. */
const endNotice = (data, runId) => (noticed(data, runId)?.ended ? { ended_at: noticed(data, runId).ended, queued: true } : undefined);
/** The webhook-id a run's notice has (webhooks.ts emit): its run, its type and the marker of its moment. */
const noticeId = (runId, type, marker) => `msg_${createHash("sha256").update(`${runId}\n${type}\n${marker}`).digest("hex").slice(0, 32)}`;
const killed = async (child) => {
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
};

test("a run whose end is in the store while no server is up, its outbox holding nothing of it, gives its run.ended from the next server, once, under the id its end time makes", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  await hadWebhook(data, hook);
  // The run ends with no server up (a runner wrote its end): no server told it, and the outbox holds nothing of it.
  const writer = await askerStore(t, data);
  const at = await endedInStore(writer, "asker", "run-ends");
  assert.equal(ofType(hook.got, "run.ended").length, 0, "no server was up to tell it");
  const next = await startWithRunner({ data, runner: false });
  t.after(() => next.close());
  await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run run-ends, from the next server's catch-up", data);
  const [ended] = ofType(hook.got, "run.ended");
  assert.equal(JSON.parse(ended.body).data.run_id, "run-ends");
  assert.equal(ended.headers["webhook-id"], noticeId("run-ends", "run.ended", at), "the id the store's end time makes");
  // Recorded as queued, and delivered: the ledger has the end, so it is queued no more, and nothing is pending.
  await onDisk(data, () => endNotice(data, "run-ends")?.queued && JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  assert.deepEqual(endNotice(data, "run-ends"), { ended_at: at, queued: true });
  assert.equal(ofType(hook.got, "run.ended").length, 1, "once");
});

test("a receiver that reads a run back on its run.ended reads it ended, in the run and in the list", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
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

test("a run.ended whose outbox write failed is not recorded as queued, so after a kill the next server queues and sends it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  await hadWebhook(data, hook);
  const writer = await askerStore(t, data);
  const at = await endedInStore(writer, "asker", "unsaved-end");
  // The outbox's temporary file is a directory: its writes fail, as on a full disk. A server in a process of its own tells
  // the end from memory, never on disk, and is killed.
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const first = await serverProcess(t, data);
  await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run unsaved-end, tried from memory", data);
  assert.equal(endNotice(data, "unsaved-end")?.queued, undefined, "not recorded: the outbox never held it on disk");
  await killed(first.child);
  rmdirSync(blocked);
  const next = await startWithRunner({ data, runner: false });
  t.after(() => next.close());
  await onDisk(data, () => endNotice(data, "unsaved-end")?.queued);
  await hook.when((got) => ofType(got, "run.ended").length === 2, "the run.ended of run unsaved-end, from the next server", data);
  assert.deepEqual([...new Set(ofType(hook.got, "run.ended").map((r) => r.headers["webhook-id"]))], [noticeId("unsaved-end", "run.ended", at)], "one end, one webhook-id");
});

// A start's recovery that cannot read the agent store (busy past its wait) gives up, as it always has; the catch-up of the
// ends the outbox lacks is its own start step, so it still runs, reads the store once it is free, and queues each end.
// ---- a wait's run.needs_input is a notice until the webhook's ledger says the outbox holds it, so a server that adopts the
// run queues a wait no server queued, under its one webhook-id.

/** The ledger's wait of the run, as `{marker}`. */
const waitNotice = (data, runId) => (noticed(data, runId)?.wait ? { marker: noticed(data, runId).wait } : undefined);


test("a run that comes to wait for its person while no server is up gives exactly one run.needs_input from the next server, under the wait's own id", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  await hadWebhook(data, hook);
  // The run asks with no server up: its runner parks it on its question.
  const writer = await askerStore(t, data);
  await parkedOnQuestion(writer, "asker", "asks-late", "Which region?");
  const next = await startWithRunner({ data, runner: false });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  await hook.when((got) => ofType(got, "run.needs_input").length > 0, "the run.needs_input of run asks-late, from the next server", data);
  // Recorded as queued, and delivered: the ledger has the wait, so the same wait is queued no more, and nothing is pending.
  await onDisk(data, () => waitNotice(data, "asks-late") && JSON.parse(readFileSync(join(data, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
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

test("a run.needs_input whose outbox write failed is not recorded, so after a kill the next server queues it again, under the same id", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  await hadWebhook(data, hook);
  const writer = await askerStore(t, data);
  await parkedOnQuestion(writer, "asker", "asks-unsaved", "Which region?", { wake: false });
  const blocked = join(data, "webhook-outbox.json.tmp");
  mkdirSync(blocked);
  const first = await serverProcess(t, data);
  await hook.when((got) => ofType(got, "run.needs_input").length === 1, "the run.needs_input of run asks-unsaved, tried from memory", data);
  assert.equal(waitNotice(data, "asks-unsaved"), undefined, "not recorded: the outbox never held it on disk");
  await killed(first.child);
  rmdirSync(blocked);
  const next = await startWithRunner({ data, runner: false });
  t.after(() => next.close());
  await onDisk(data, () => waitNotice(data, "asks-unsaved"));
  await hook.when((got) => ofType(got, "run.needs_input").length === 2, "the run.needs_input of run asks-unsaved, from the next server", data);
  const ids = new Set(ofType(hook.got, "run.needs_input").map((r) => r.headers["webhook-id"]));
  assert.equal(ids.size, 1, "one wait, one webhook-id");
});

// ---- the notice ledger: what the outbox has queued of each run, in the outbox's own write.

const ledgerOf = (dir) => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).notices;
/** A catch-up's rows, and its read of each run as the store holds it now: as the rows say, with an ended run's notice. */
const stored = (rows) => [rows, async (id) => {
  const row = rows.find((r) => r.id === id);
  return row ? { state: row.state, endedAt: row.endedAt, notice: { run_id: id, agent_id: "a", status: "completed", title: id } } : null;
}];

test("a notice and its record are one write: the outbox holds the end and the wait it queued of each run; the same moment again queues nothing, here or in the next server", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  // The first server's two are answered late, as on a loaded machine: received, but not answered to it until both are in.
  let answerLate;
  const late = new Promise((resolve) => (answerLate = resolve));
  const hook = await receiver(t, (n) => (n <= 2 ? late.then(() => 200) : 200));
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
  // Closed once each try has its answer, not once the receiver has the request: a close cuts a try in flight, and the
  // next server sends its message again (at least once, under the same webhook-id).
  await hook.when(2);
  answerLate();
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).attempts.length === 2);
  assert.deepEqual(first.attemptsView().attempts.map((a) => a.status_code), [200, 200]);
  await first.close();
  // The next server reads the ledger: the same end and the same wait queue nothing, a new end of the run does.
  const next = new Webhooks(dir, env, () => undefined, []);
  t.after(() => next.close());
  assert.equal(next.emit("run.ended", run, ended), "queued");
  assert.equal(next.emit("run.needs_input", { ...run, status: "input_required", pending: { kind: "question" } }, "row_7"), "queued");
  const later = new Date(Date.now() + 1_000).toISOString();
  assert.equal(next.emit("run.ended", run, later), "queued");
  await hook.when(3);
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  // The first two were queued together, and each message goes on its own tries: they land in either order.
  const ids = hook.got.map((r) => r.headers["webhook-id"]);
  assert.deepEqual([ids.slice(0, 2).sort(), ids.slice(2)], [[noticeId("run_1", "run.ended", ended), noticeId("run_1", "run.needs_input", "row_7")].sort(), [noticeId("run_1", "run.ended", later)]], "each moment sent once");
  assert.equal(ledgerOf(dir).run_1.ended, later);
});

test("a start's catch-up queues each end the store holds and the ledger does not, once; an end before the webhook's own setting is never sent", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const webhooks = new Webhooks(dir, env, () => undefined, []);
  t.after(() => webhooks.close());
  const before = new Date(Date.now() - 60_000).toISOString();
  webhooks.save({ url: hook.url });
  const now = new Date().toISOString();
  await webhooks.catchUp(...stored([{ id: "old", endedAt: before }, { id: "lost", endedAt: now }]));
  await webhooks.catchUp(...stored([{ id: "lost", endedAt: now }]));
  await hook.when(1);
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).data.run_id), ["lost"], "once, and never the end before the webhook was set");
  assert.equal(ledgerOf(dir).lost.ended, now);
});

test("a start's catch-up queues no end of a run that moved on while it read earlier rows: continued to a new wait, its saved end goes once, whether that end was still being sent or delivered", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  for (const first of ["sending", "delivered"]) {
    let answer;
    const answered = new Promise((resolve) => (answer = resolve));
    const isFirstEnd = (r) => JSON.parse(r.body).type === "run.ended" && JSON.parse(r.body).data.run_id === "moved";
    // While "sending", the first end's try waits for its answer until the catch-up is done.
    const hook = await receiver(t, (n) => (first === "sending" && isFirstEnd(hook.got[n - 1]) ? answered.then(() => 200) : 200));
    const dir = await scratch(t);
    const webhooks = new Webhooks(dir, env, () => undefined, []);
    t.after(() => webhooks.close());
    webhooks.save({ url: hook.url });
    // Set a minute ago: both ends came after it, so both are due.
    const config = JSON.parse(readFileSync(join(dir, "webhook.json"), "utf8"));
    writeFileSync(join(dir, "webhook.json"), `${JSON.stringify({ ...config, updated_at: new Date(Date.now() - 60_000).toISOString() })}\n`);
    const notice = (id, status = "completed") => ({ run_id: id, agent_id: "a", status, title: id });
    const [earlier, moved] = [new Date(Date.now() - 2_000).toISOString(), new Date(Date.now() - 1_000).toISOString()];
    // The store as the start read it: both runs ended. The ledger has the second's end, queued before.
    const store = new Map([["earlier", { id: "earlier", state: "completed", endedAt: earlier }], ["moved", { id: "moved", state: "completed", endedAt: moved }]]);
    assert.equal(webhooks.emit("run.ended", notice("moved"), moved), "queued");
    if (first === "delivered") await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).attempts.length === 1);
    let reading;
    const read = new Promise((resolve) => (reading = resolve));
    let resume;
    const resumed = new Promise((resolve) => (resume = resolve));
    const current = async (id) => {
      if (id === "earlier") (reading(), await resumed);
      return { ...store.get(id), notice: notice(id) };
    };
    const catchingUp = webhooks.catchUp([...store.values()], current);
    await read;
    // While the catch-up reads the earlier row, the second run is continued and comes to a new wait.
    store.set("moved", { id: "moved", state: "running" });
    assert.equal(webhooks.emit("run.needs_input", notice("moved", "input_required"), "row_9"), "queued");
    resume();
    await catchingUp;
    answer();
    await hook.when(3);
    await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
    const ids = hook.got.map((r) => r.headers["webhook-id"]).sort();
    assert.deepEqual(ids, [noticeId("earlier", "run.ended", earlier), noticeId("moved", "run.ended", moved), noticeId("moved", "run.needs_input", "row_9")].sort(), `each once (${first})`);
  }
});

test("an end after the webhook was set and inside the day is queued by a start's catch-up, though it came before that server started: a file named end-notices-since is neither read nor written", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  for (const leftover of [undefined, `${new Date().toISOString()}\n`]) {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const since = join(dir, "end-notices-since");
    if (leftover !== undefined) writeFileSync(since, leftover);
    const setup = new Webhooks(dir, env, () => undefined, []);
    setup.save({ url: hook.url });
    await setup.close();
    const config = JSON.parse(readFileSync(join(dir, "webhook.json"), "utf8"));
    writeFileSync(join(dir, "webhook.json"), `${JSON.stringify({ ...config, updated_at: new Date(Date.now() - 600_000).toISOString() })}\n`);
    const ended = new Date(Date.now() - 300_000).toISOString();
    const webhooks = new Webhooks(dir, env, () => undefined, []);
    t.after(() => webhooks.close());
    await webhooks.catchUp(...stored([{ id: "ended-before-start", endedAt: ended }]));
    await hook.when(1);
    assert.equal(hook.got[0].headers["webhook-id"], noticeId("ended-before-start", "run.ended", ended));
    assert.equal(existsSync(since) ? readFileSync(since, "utf8") : undefined, leftover, "left as it was");
  }
});

test("the ledger keeps an end exactly as long as a start's catch-up looks for it: one just inside the day stays and is not sent again; one just past it is dropped, and not sent either", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
  const inside = new Date(Date.now() - day + 60_000).toISOString();
  const past = new Date(Date.now() - day - 60_000).toISOString();
  // The webhook was set two days ago; the ledger holds both ends from an earlier server.
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
  await webhooks.catchUp(...stored([{ id: "inside", endedAt: inside }, { id: "past", endedAt: past }]));
  await hook.when(1);
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
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
  const first = new Webhooks(dir, env, () => undefined, []);
  first.save({ url: hook.url });
  const config = JSON.parse(readFileSync(join(dir, "webhook.json"), "utf8"));
  writeFileSync(join(dir, "webhook.json"), `${JSON.stringify({ ...config, updated_at: new Date(Date.now() - 2 * day).toISOString() })}\n`);
  const run = (id) => ({ run_id: id, agent_id: "a", status: "completed", title: id });
  first.emit("run.ended", run("sent"), sent);
  // A later notice prunes the ledger: the entry at the edge stays.
  first.emit("run.ended", run("fresh"), new Date().toISOString());
  await hook.when(2);
  await first.close();
  // Its message leaves the outbox as later attempts push it out of the log (ATTEMPTS_KEPT): the ledger alone keeps it.
  const outbox = JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8"));
  writeFileSync(join(dir, "webhook-outbox.json"), `${JSON.stringify({ ...outbox, messages: [], attempts: [] })}\n`);
  const next = new Webhooks(dir, env, () => undefined, []);
  t.after(() => next.close());
  next.emit("run.ended", run("pruning"), new Date().toISOString());
  await next.catchUp(...stored([{ id: "sent", endedAt: sent }, { id: "lost", endedAt: lost }]));
  // A continuation tells the same end again.
  next.emit("run.ended", run("sent"), sent);
  await hook.when(4);
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  const of = (id) => hook.got.filter((r) => JSON.parse(r.body).data.run_id === id).length;
  assert.deepEqual([of("sent"), of("lost")], [1, 1], "each end at the edge once");
});

test("a cancelled run whose last row is an open question, its wait no longer in the ledger, gives no run.needs_input when a later server reads it: an ended run never asks", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startWithRunner({ data, runner: false });
  assert.equal((await client(first.baseUrl, first.token)("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const writer = await askerStore(t, data);
  await parkedOnQuestion(writer, "asker", "asks-then-cancelled", "Which region?");
  await hook.when((got) => ofType(got, "run.needs_input").length === 1, "the run.needs_input of run asks-then-cancelled", data);
  // Cancelled where it waits: stopped, its last row still the question.
  await endParked(writer, "asks-then-cancelled", "stopped");
  await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run asks-then-cancelled", data);
  await settled(data);
  await first.close();
  // The ledger as a pruning leaves it: no wait of the run, and its messages gone from the outbox.
  const file = join(data, "webhook-outbox.json");
  const outbox = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify({ ...outbox, messages: [], attempts: [], notices: { "asks-then-cancelled": { ended: outbox.notices["asks-then-cancelled"].ended } } })}\n`);
  const next = await startWithRunner({ data, runner: false });
  t.after(() => next.close());
  assert.equal((await client(next.baseUrl, next.token)("GET", "/runs/asks-then-cancelled")).body.status, "cancelled");
  // Two runs parked after it show the next server's reads have passed: the second's notice comes from a read after the
  // one that told the first, which read the cancelled run too.
  await parkedOnQuestion(writer, "asker", "after-1", "And the currency?");
  await hook.when((got) => ofType(got, "run.needs_input").some((r) => JSON.parse(r.body).data.run_id === "after-1"), "the run.needs_input of run after-1", data);
  await parkedOnQuestion(writer, "asker", "after-2", "And the date?");
  await hook.when((got) => ofType(got, "run.needs_input").some((r) => JSON.parse(r.body).data.run_id === "after-2"), "the run.needs_input of run after-2", data);
  const of = (type) => ofType(hook.got, type).filter((r) => JSON.parse(r.body).data.run_id === "asks-then-cancelled").length;
  assert.deepEqual([of("run.needs_input"), of("run.ended")], [1, 1], "no wait notice for an ended run, and its end once");
});

test("a run still waiting on the same question a day later, its message gone from the outbox, is not asked about again: the ledger keeps a wait until the run moves past it", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
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
  await hook.when(1);
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).type), ["run.ended"], "the same wait is not sent again");
  // A new question of the run is a wait of its own, and replaces the last; then the run ends.
  webhooks.emit("run.needs_input", waiting, "row_12");
  const end = new Date().toISOString();
  webhooks.emit("run.ended", { ...waiting, status: "completed", pending: undefined }, end);
  await hook.when(3);
  await onDisk(dir, () => JSON.parse(readFileSync(join(dir, "webhook-outbox.json"), "utf8")).messages.every((m) => m.status !== "pending"));
  // The new wait and the end were queued together, and each message goes on its own tries: they land in either order.
  const types = hook.got.map((r) => JSON.parse(r.body).type);
  assert.deepEqual([types[0], types.slice(1).sort()], ["run.ended", ["run.ended", "run.needs_input"]]);
  assert.deepEqual(ledgerOf(dir).waiting, { wait: "row_12", ended: end }, "the newest wait, and the end past it");
});

test("a run that ends while the webhook is off leaves its wait behind in the ledger; the next start, the webhook set again, drops it and sends nothing", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const data = join(await scratch(t), "agents");
  const first = await startWithRunner({ data, runner: false });
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const writer = await askerStore(t, data);
  await parkedOnQuestion(writer, "asker", "asks-off", "Which region?");
  await hook.when((got) => ofType(got, "run.needs_input").length === 1, "the run.needs_input of run asks-off", data);
  await settled(data);
  // Off while the run ends: its end is never queued, and nothing moves the run past its wait in the ledger.
  assert.equal((await api("DELETE", "/settings/webhook")).status, 204);
  await endParked(writer, "asks-off", "ended");
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  await first.close();
  assert.ok(waitNotice(data, "asks-off"), "the wait is still in the ledger");
  const next = await startWithRunner({ data, runner: false });
  t.after(() => next.close());
  await onDisk(data, () => !noticed(data, "asks-off"));
  nothingPending(data);
  assert.deepEqual([ofType(hook.got, "run.needs_input").length, ofType(hook.got, "run.ended").length], [1, 0], "nothing sent");
});

test("a start drops the ledger's waits of runs the store holds as ended or no longer has, keeps an end still due, and keeps a wait the run still stands at however old", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, SEAL);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const env = { AGENTRUN_SEAL_KEY: sealKey() };
  const day = 24 * 3_600_000;
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
  // The store's rows: "deleted" is gone, "ended" and "kept" have ended, "open" still waits (two days on).
  await webhooks.catchUp(...stored([{ id: "ended", state: "completed", endedAt: old }, { id: "kept", state: "completed", endedAt: recent }, { id: "open", state: "running" }]));
  assert.deepEqual(ledgerOf(dir), { kept: { ended: recent }, open: { wait: "row_4" } });
  // The catch-up has returned, its queuing done in it: with nothing pending, nothing is sent.
  nothingPending(dir);
  assert.equal(hook.got.length, 0, "nothing sent");
});

