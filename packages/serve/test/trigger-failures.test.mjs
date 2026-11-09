// A schedule tells you when it misses or fails, through the API with the triggers' fake clock: times missed while the
// server was down catch up once within the window, the rest one missed row; a failed firing sends one signed
// trigger.failed, once across a restart, and five in a row turn the trigger off, a started one resetting the count.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { schemaProblems } from "./schema-support.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { E2, fakeClock, firings, keyOf, made, schedule } from "./trigger-support.mjs";

// The spec's own library, in the lockfile through the Anthropic SDK: what a receiver would install.
const { Webhook } = createRequire(import.meta.url)("standardwebhooks");

/** A receiver on loopback: each POST to its path, kept. */
async function receiver(t) {
  const got = [];
  const path = `/hook/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (req.url !== path) return void res.writeHead(404).end();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  return { url: `http://127.0.0.1:${server.address().port}${path}`, got };
}

/** Until `check()` is truthy, every 50 ms, for at most 30 s. */
async function until(check, what) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, `waited for ${what}`);
  }
}

test("down across three times with a one-hour window: the latest fires once, to catch up, and the two before it are one missed row", { timeout: 120_000, skip: E2 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const first = await serve(t, { data, triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(first.api, "caught");
  const { body } = await first.api("POST", "/triggers", schedule("caught", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(body.catchup_window_s, 3600, "an hour, by default");
  await first.close();
  const second = await serve(t, { data, triggerClock: fakeClock("2026-06-01T00:38:20Z") });
  const [caught, missed] = await firings(second.api, body.id, 2);
  assert.deepEqual([missed.status, missed.nominal_at, missed.count, missed.run_id], ["missed", "2026-06-01T00:10:00Z", 2, null], "00:10 and 00:20");
  assert.deepEqual([caught.status, caught.nominal_at, caught.key], ["started", "2026-06-01T00:30:00Z", keyOf("schedule", body.id, "2026-06-01T00:30:00Z")]);
  assert.equal(caught.catch_up, true);
  const doc = (await second.api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/triggers/{trigger_id}/firings"].get.responses["200"].content["application/json"].schema, { firings: [caught, missed] }), []);
  assert.equal((await second.api("GET", `/triggers/${body.id}`)).body.next_at, "2026-06-01T00:40:00.000Z");
  assert.equal((await second.api("GET", "/agents/caught/runs")).body.runs.length, 1, "one catch-up run");
  await follow(second.api, caught.run_id, ["completed"]);
});

test("five failed firings in a row turn the trigger off; each sends one signed trigger.failed, the fifth saying so, and a restart sends none again; a started firing resets the count", { timeout: 180_000, skip: E2 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const hook = await receiver(t);
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const first = await serve(t, { data, triggerClock: clock });
  const { api } = first;
  const { secret } = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  await made(api, "flaky");
  const { body } = await api("POST", "/triggers", schedule("flaky", { every_s: 60, start_at: "2026-06-01T00:01:00Z" }));
  const id = body.id;
  const slot = (n) => `2026-06-01T00:${String(n).padStart(2, "0")}:00Z`;
  const fire = async (n) => {
    clock.to(slot(n));
    return (await firings(api, id, n))[0];
  };
  const archived = (on) => api("POST", `/agents/flaky/${on ? "archive" : "unarchive"}`);

  assert.equal((await archived(true)).status, 200);
  for (const n of [1, 2]) {
    const failed = await fire(n);
    assert.deepEqual([failed.status, failed.error.code], ["failed", "agent_not_runnable"]);
  }
  assert.equal((await api("GET", `/triggers/${id}`)).body.failures_in_a_row, 2);
  assert.equal((await archived(false)).status, 200);
  const ok = await fire(3);
  assert.equal(ok.status, "started");
  assert.equal((await api("GET", `/triggers/${id}`)).body.failures_in_a_row, 0, "a started firing resets the count");
  await follow(api, ok.run_id, ["completed"]);
  assert.equal((await archived(true)).status, 200);
  for (const n of [4, 5, 6, 7]) assert.equal((await fire(n)).status, "failed");
  assert.equal((await api("GET", `/triggers/${id}`)).body.enabled, true, "four in a row: still on");
  assert.equal((await fire(8)).status, "failed");
  const off = (await api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([off.enabled, off.next_at, off.failures_in_a_row, off.disabled?.reason], [false, null, 5, "auto_paused"]);
  assert.equal(clock.timer, null, "nothing armed");

  const failedKeys = [1, 2, 4, 5, 6, 7, 8].map((n) => keyOf("schedule", id, slot(n)));
  const failures = () => hook.got.filter((r) => JSON.parse(r.body).type === "trigger.failed");
  await until(() => failures().length === 7, "seven trigger.failed messages");
  const library = new Webhook(secret);
  for (const [i, message] of failures().entries()) {
    const verified = library.verify(message.body, message.headers);
    assert.deepEqual(Object.keys(verified.data).sort(), ["auto_paused", "error", "firing_key", "name", "nominal_at", "trigger_id"]);
    assert.equal(verified.data.trigger_id, id);
    assert.equal(verified.data.error.code, "agent_not_runnable");
    assert.equal(message.headers["webhook-id"], `msg_${createHash("sha256").update(`trigger.failed\n${verified.data.firing_key}`).digest("hex").slice(0, 32)}`, "its id from the firing's key");
    assert.equal(verified.data.auto_paused, i === 6, "the fifth in a row says it turned the trigger off");
  }
  assert.deepEqual(failures().map((m) => JSON.parse(m.body).data.firing_key).sort(), [...failedKeys].sort(), "one for each failed firing");

  await first.close();
  const second = await serve(t, { data, triggerClock: clock });
  assert.equal((await second.api("GET", `/triggers/${id}`)).body.disabled.reason, "auto_paused");
  await sleep(1_500);
  assert.equal(failures().length, 7, "a restart sends none again");
  const on = await second.api("PATCH", `/triggers/${id}`, { enabled: true });
  assert.deepEqual([on.body.enabled, on.body.failures_in_a_row, on.body.disabled], [true, 0, null], "on again, a new count");
});

test("catchup_window_s is checked and taken by PATCH; overlap is no field: one given is refused", { timeout: 60_000 }, async (t) => {
  const { api, baseUrl } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(api, "settings");
  for (const [field, value, reason] of [["catchup_window_s", -1, "invalid"], ["catchup_window_s", 1.5, "invalid"], ["catchup_window_s", 366 * 86_400 + 1, "invalid"], ["overlap", "queue", "not_allowed"]]) {
    const answer = await api("POST", "/triggers", { ...schedule("settings", { every_s: 600 }), [field]: value });
    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body.error.fields.map((f) => [f.field, f.reason]), [[field, reason]]);
  }
  const { body } = await api("POST", "/triggers", schedule("settings", { every_s: 600 }));
  assert.deepEqual([body.overlap, body.catchup_window_s, body.failures_in_a_row, body.disabled], [undefined, 3600, 0, null]);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, doc.paths["/triggers"].post.responses["201"].content["application/json"].schema, body), []);
  const patched = await api("PATCH", `/triggers/${body.id}`, { catchup_window_s: 0 });
  assert.deepEqual([patched.body.catchup_window_s, patched.body.next_at], [0, body.next_at], "its next time unchanged");
});
