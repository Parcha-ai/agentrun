// The agent store held by another connection never stalls the server: every read and write of it waits with an
// async backoff, so the event loop goes on answering. A run's end waits as long as it takes; a request waits about
// 2 s, then answers home_busy.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { agent, answerFlow, client, FAUX, flowAgent, follow, scratch, serve } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** How long a reader holds the store while an edit's commit waits for it. A wait that blocked the event loop would hold
 *  every other request for about all of it, so half of it is the line between waiting aside and blocking. */
const HOLD_MS = 1_000;

/** `method path` on a connection of its own, with how long its answer took. */
function timed(port, token, method, path, body) {
  const from = Date.now();
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = { authorization: `Bearer ${token}`, ...(text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) }) };
    const req = request({ host: "127.0.0.1", port, method, path: `/v2${path}`, agent: false, headers }, (res) => {
      let out = "";
      res.setEncoding("utf8").on("data", (chunk) => (out += chunk)).on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null, took: Date.now() - from }));
    });
    req.once("error", reject).end(text);
  });
}

/** GET /capabilities one after another until `until` settles: the slowest answer. */
async function slowestWhile(port, token, until) {
  let done = false;
  until.finally(() => (done = true)).catch(() => {});
  let slowest = 0;
  for (let i = 0; !done || i === 0; i++) slowest = Math.max(slowest, (await timed(port, token, "GET", "/capabilities")).took);
  return slowest;
}

/** Another connection holding store.sqlite (`IMMEDIATE`: no other writer; `EXCLUSIVE`: no reader either; `READ`: a
 *  reader's shared lock, which a writer's commit waits for). */
function hold(t, data, mode = "IMMEDIATE") {
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  store.exec(`BEGIN ${mode === "READ" ? "" : mode}`);
  if (mode === "READ") store.prepare("SELECT count(*) FROM agents").get();
  const release = () => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close());
  t.after(release);
  return release;
}

test("a run's end due while another connection holds the agent store: the server answers within 200 ms meanwhile", async (t) => {
  const dir = await scratch(t);
  let firstBusy;
  const busy = new Promise((resolve) => (firstBusy = resolve));
  const { api, data, port, token } = await serve(t, { carryBackRetry: { delaysMs: Array(5).fill(50), onBusy: () => firstBusy() }, settleRetryMs: 300 });
  assert.equal((await api("POST", "/agents", agent("ender", { instructions: `Answer once ${join(dir, "go")} exists.` }))).status, 201);
  const run = await api("POST", "/agents/ender/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const release = hold(t, data);
  await writeFile(join(dir, "go"), "");
  await busy;
  const slowest = await slowestWhile(port, token, sleep(1_500));
  assert.ok(slowest < 200, `GET /capabilities took ${slowest} ms while the run's end waited`);
  release();
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a create while the agent store is held for 1 s waits, then answers 201; the server answers within 200 ms meanwhile", async (t) => {
  const { data, port, token } = await serve(t);
  const release = hold(t, data);
  const created = timed(port, token, "POST", "/agents", agent("patient"));
  const slowest = await slowestWhile(port, token, sleep(1_000));
  release();
  const answer = await created;
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.ok(answer.took >= 900, `it waited for the store: ${answer.took} ms`);
  assert.ok(slowest < 200, `GET /capabilities took ${slowest} ms while the create waited`);
});

test("a create while the agent store is held for 3 s answers 409 home_busy at about 2 s, retryable", async (t) => {
  const { data, port, token } = await serve(t);
  hold(t, data);
  const created = timed(port, token, "POST", "/agents", agent("impatient"));
  const slowest = await slowestWhile(port, token, created);
  const answer = await created;
  assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.retryable, answer.body.error?.retry_after_ms], [409, "home_busy", true, 500], JSON.stringify(answer.body));
  assert.ok(answer.took >= 1_500 && answer.took < 3_000, `answered at ${answer.took} ms`);
  assert.ok(slowest < 200, `GET /capabilities took ${slowest} ms while the create waited`);
});

test("a read while the agent store is held exclusively waits, then answers once it is free", async (t) => {
  const { api, data, port, token } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("read"))).status, 201);
  const release = hold(t, data, "EXCLUSIVE");
  const read = timed(port, token, "GET", "/agents/read");
  const slowest = await slowestWhile(port, token, sleep(500));
  release();
  const answer = await read;
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.ok(slowest < 200, `GET /capabilities took ${slowest} ms while the read waited`);
});

test("an edit whose commit meets a reader of the agent store waits for it, then answers 200 with the new revision", async (t) => {
  const { api, data, port, token } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("edited"))).status, 201);
  const release = hold(t, data, "READ");
  const edited = timed(port, token, "PUT", "/agents/edited/definition", agent("edited", { instructions: "Answer briefly.", version: 2 }));
  // Handled now: should the bound below fail while the edit still waits, the server's close ends it, and its rejection
  // is not reported beside the failure. `await edited` still sees it.
  edited.catch(() => {});
  const slowest = await slowestWhile(port, token, sleep(HOLD_MS));
  release();
  t.diagnostic(`slowest GET /capabilities while the edit waited: ${slowest} ms`);
  assert.ok(slowest < HOLD_MS / 2, `GET /capabilities took ${slowest} ms while the edit waited: an edit whose wait blocks the event loop holds every other request for about the whole ${HOLD_MS} ms hold`);
  const answer = await edited;
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.definition.instructions, "Answer briefly.");
  assert.ok(answer.took >= HOLD_MS - 100, `it waited for the reader: ${answer.took} ms`);
});

test("the agent home's own busy (a home held past its deadline) answers 409 home_busy with retry_after_ms, never 500", async (t) => {
  const { api } = await serve(t);
  // The store's createAgent throws pi-durable-agent's AgentHomeError("busy"), as a home another writer holds past its
  // deadline does: the same module the server runs.
  const probe = await scratch(t);
  const store = openStore(probe);
  const proto = Object.getPrototypeOf(store);
  store.close();
  const createAgent = proto.createAgent;
  proto.createAgent = function () { throw new AgentHomeError("busy", "the agent home is held by another writer"); };
  t.after(() => void (proto.createAgent = createAgent));
  const answer = await api("POST", "/agents", agent("held-home"));
  assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.retryable, answer.body.error?.retry_after_ms], [409, "home_busy", true, 500], JSON.stringify(answer.body));
});

test("the agent home's own busy on a read no storeError wraps reaches the server's fallback: 409 home_busy, never 500", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("held-read"))).status, 201);
  // GET /agents/:id reads through the store's readAgent with no storeError on its path, so only the server's own
  // fallback maps what it throws.
  const probe = await scratch(t);
  const store = openStore(probe);
  const proto = Object.getPrototypeOf(store);
  store.close();
  const readAgent = proto.readAgent;
  proto.readAgent = function () { throw new AgentHomeError("busy", "the agent home is held by another writer"); };
  t.after(() => void (proto.readAgent = readAgent));
  const answer = await api("GET", "/agents/held-read");
  assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.retryable, answer.body.error?.retry_after_ms], [409, "home_busy", true, 500], JSON.stringify(answer.body));
});

test("two edits held by a reader of the store are each checked against the revision current when it commits", async (t) => {
  const { api, data, port, token } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("raced"))).status, 201);
  const put = (instructions, version) => timed(port, token, "PUT", "/agents/raced/definition", agent("raced", { instructions, version }));
  // Both ask for version 2: the second to commit is one more, so it is refused, not written as version 3.
  let release = hold(t, data, "READ");
  const versions = [put("Answer A.", 2), put("Answer B.", 2)];
  await sleep(500);
  release();
  const answered = (await Promise.all(versions)).map((answer) => [answer.status, answer.body.error?.fields?.[0]?.field ?? null]).sort();
  assert.deepEqual(answered, [[200, null], [422, "definition.version"]]);
  assert.equal((await api("GET", "/agents/raced/revisions")).body.revisions.length, 2, "one edit made a revision");
  // The same edit twice makes one revision: the second finds it current.
  release = hold(t, data, "READ");
  const same = [put("Answer C.", 3), put("Answer C.", 3)];
  await sleep(500);
  release();
  assert.deepEqual((await Promise.all(same)).map((answer) => answer.status), [200, 200]);
  assert.equal((await api("GET", "/agents/raced/revisions")).body.revisions.length, 3, "the same edit twice made one revision");
});

/** A workflow agent whose run is working, its model node answering 1.5 s after it starts. */
async function workingFlow(api, id) {
  assert.equal((await api("POST", "/agents", flowAgent(id, answerFlow("Answer soon.")))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { question: "Answer soon." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["working"]);
  return started.body.run_id;
}

test("a workflow that ends while the agent store is held past a request's 2 s waits with the run end's retries, then completes", async (t) => {
  const busy = [];
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: Array(60).fill(100), onBusy: (_id, attempt) => busy.push(attempt) }, settleRetryMs: 120_000 });
  const runId = await workingFlow(api, "held-end");
  const release = hold(t, data, "EXCLUSIVE");
  await sleep(4_500);
  release();
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 15_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.ok(busy.length > 0, "the run's end met the held store");
});

test("a workflow whose end outlasts the run end's retries is settled again, not left until the next start", async (t) => {
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: [50, 50] }, settleRetryMs: 300 });
  const runId = await workingFlow(api, "settled-again");
  const release = hold(t, data, "EXCLUSIVE");
  await sleep(3_000);
  release();
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 15_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a run's view is of one moment: a run that ends while its read waits is answered ended, with its result", async (t) => {
  const { api } = await serve(t);
  const go = join(await scratch(t), "go");
  assert.equal((await api("POST", "/agents", agent("viewed"))).status, 201);
  const started = await api("POST", "/agents/viewed/runs", { input: { content: `Answer once ${go} exists.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["working"]);
  // The next store readRun (the view's) waits until the test lets it go; every other read goes through.
  const probe = await scratch(t);
  const store = openStore(probe);
  const proto = Object.getPrototypeOf(store);
  store.close();
  const readRun = proto.readRun;
  t.after(() => void (proto.readRun = readRun));
  let letGo;
  let waiting = new Promise((resolve) => (letGo = resolve));
  proto.readRun = function (...args) {
    if (!waiting) return readRun.apply(this, args);
    const until = waiting;
    waiting = undefined;
    const row = readRun.apply(this, args);
    return until.then(() => row);
  };
  const viewing = api("GET", `/runs/${started.body.run_id}`);
  for (let i = 0; waiting; i++) {
    assert.ok(i < 200, "the view read the store");
    await sleep(25);
  }
  await writeFile(go, "");
  await follow(api, started.body.run_id, ["completed"]);
  letGo();
  const viewed = await viewing;
  assert.deepEqual([viewed.status, viewed.body.status, viewed.body.result?.final_answer], [200, "completed", "Now."], JSON.stringify(viewed.body));
});

/** Holds each of the next two workflow commits until both have arrived: each read its current revision and passed its
 *  checks, and both reach the store's own check of the body together, as two edits in flight at once do. */
async function twoCommitsAtOnce(t) {
  const probe = await scratch(t);
  const store = openStore(probe);
  const proto = Object.getPrototypeOf(store);
  store.close();
  const commit = proto.commitRevision;
  t.after(() => void (proto.commitRevision = commit));
  const arrived = [];
  let armed = true;
  proto.commitRevision = async function (agentId, input, options) {
    if (armed && input.kind === "workflow") {
      await new Promise((resolve) => {
        arrived.push(resolve);
        if (arrived.length === 2) (armed = false), arrived.forEach((go) => go());
      });
    }
    return commit.call(this, agentId, input, options);
  };
  return () => assert.equal(arrived.length, 2, "both edits reached the store's commit together");
}

test("two workflow edits whose body checks are in flight together are each checked against the revision current when it commits", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("flowed"))).status, 201);
  const put = (instructions, extra = {}, headers = {}) => api("PUT", "/agents/flowed/definition", flowAgent("flowed", answerFlow(instructions), extra), headers);
  const count = async () => (await api("GET", "/agents/flowed/revisions")).body.revisions.length;
  const outcome = (answers) => answers.map((answer) => [answer.status, answer.body.error?.code ?? null, answer.body.error?.fields?.[0]?.field ?? null]).sort();

  // Without If-Match, both asking for version 2: the second is read again on the first's revision, and refused.
  let both = await twoCommitsAtOnce(t);
  assert.deepEqual(outcome(await Promise.all([put("Answer A.", { version: 2 }), put("Answer B.", { version: 2 })])), [[200, null, null], [422, "input_invalid", "definition.version"]]);
  both();
  assert.equal(await count(), 2);

  // Without If-Match, the same edit twice: the second finds it current and makes nothing.
  both = await twoCommitsAtOnce(t);
  assert.deepEqual(outcome(await Promise.all([put("Answer C."), put("Answer C.")])), [[200, null, null], [200, null, null]]);
  both();
  assert.equal(await count(), 3, "the same edit twice made one revision");

  // With If-Match on the same revision: the second is refused, 412.
  const etag = (await api("GET", "/agents/flowed")).headers.get("etag");
  both = await twoCommitsAtOnce(t);
  assert.deepEqual(outcome(await Promise.all([put("Answer D.", {}, { "if-match": etag }), put("Answer E.", {}, { "if-match": etag })])), [[200, null, null], [412, "precondition_failed", null]]);
  both();
  assert.equal(await count(), 4);
});

test("an escalated workflow's review.at is its ended_at, one saved end time, even when its end waits for a held store, and after a restart", async (t) => {
  const { api, data, close } = await serve(t, { carryBackRetry: { delaysMs: Array(60).fill(100) }, settleRetryMs: 120_000 });
  const gated = answerFlow("Answer soon.");
  gated.schemas.In.properties.amount = { type: "number" };
  gated.root.steps.push({ node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: "needs a person" });
  assert.equal((await api("POST", "/agents", flowAgent("late-end", gated))).status, 201);
  const started = await api("POST", "/agents/late-end/runs", { input: { question: "Answer soon.", amount: 600 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["working"]);
  // Another writer holds the store past the run's end: its end is written, and its ended_at stamped, when it lets go.
  const release = hold(t, data);
  await sleep(2_500);
  release();
  await follow(api, runId, ["completed"], { deadlineMs: 15_000 });
  const same = (view) => [view.status, view.review?.kind, view.review?.at === view.ended_at];
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual(same(run), ["completed", "review", true], `review.at ${run.review?.at}, ended_at ${run.ended_at}`);
  const listed = (await api("GET", "/runs")).body.runs.find((row) => row.run_id === runId);
  assert.deepEqual([...same(listed), listed.ended_at], ["completed", "review", true, run.ended_at], "the list says the same");
  await close();
  const again = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => again.close());
  const read = client(again.baseUrl, again.token);
  assert.deepEqual([...same((await read("GET", "/runs")).body.runs.find((row) => row.run_id === runId)), (await read("GET", `/runs/${runId}`)).body.review?.at], ["completed", "review", true, run.ended_at], "and the next server reads the same time");
});
