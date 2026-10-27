// The agent store held by another connection never stalls the server: every read and write of it waits with an
// async backoff, so the event loop goes on answering. A run's end waits as long as it takes; a request waits about
// 2 s, then answers home_busy.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const slowest = await slowestWhile(port, token, sleep(1_000));
  release();
  const answer = await edited;
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.definition.instructions, "Answer briefly.");
  assert.ok(answer.took >= 900, `it waited for the reader: ${answer.took} ms`);
  assert.ok(slowest < 200, `GET /capabilities took ${slowest} ms while the edit waited`);
});
