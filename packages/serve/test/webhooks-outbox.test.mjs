// The outbound webhook's outbox and its durability: a message not answered 2xx is tried again on its schedule, then
// logged as failed; a 410 turns the webhook off; a queued one goes on after a restart; a store that refuses a write loses
// no notice; a start's catch-up queues each end the ledger lacks, once. Signing, idempotency and custody are
// webhooks-signing.test.mjs. Each case in the block below has a server (or a store) of its own, so they run a few at once; the
// two first ones watch the process's unhandled rejections, so they run alone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { ATTEMPTS_KEPT } from "../dist/webhooks.js";
import { client, FAUX, follow, scratch, secretWritePath, serve, startRun } from "./support.mjs";
import {
  arriving, askerStore, endedInStore, meetsDocument, endNotice, endParked, hadWebhook, killed, logged, noticed, noticeId, nothingPending, ofType, onDisk, outboxOf, parkedOnQuestion,
  leftAs, processOn, receiver, refusing, rejections, saidBy, settled, startWithRunner, turn, waitNotice, Webhook, webhookOn,
} from "./webhook-support.mjs";

/** How many cases run at once: each starts a server, a runner and its runs, so all of them at once would load a small
 *  machine past the runs' own deadlines. */
const CASES_AT_ONCE = 4;

// Removing the outbound webhook takes its secret with it: the client sends it from the owner's session, as the console does.
secretWritePath(["DELETE"], /^\/settings\/webhook$/);

/** A catch-up's rows, and its read of each run as the store holds it now: as the rows say, with an ended run's notice. */
/** The webhook's setting as the store holds it (its URL, when it was set, why it is off). */
const settingOf = (dir) => {
  const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'webhook-out'").get().value);
  } finally {
    db.close();
  }
};
const stored = (rows) => [rows, async (id) => {
  const row = rows.find((r) => r.id === id);
  return row ? { state: row.state, endedAt: row.endedAt, notice: { run_id: id, agent_id: "a", status: "completed", title: id } } : null;
}];

test("a 410 while the store refuses the webhook's setting leaves the server up and the webhook off here, said in the log; the next PUT writes it", async (t) => {
  const rejected = rejections(t);
  let answer = 410;
  const hook = await receiver(t, () => answer);
  const log = logged();
  const { api, data } = await serve(t, { webhookRetryMs: [100, 100], log: log.push });
  const set = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  // The store refuses the webhook's setting: its write fails, as on a full disk.
  const release = refusing(t, data, "setting");
  const first = await startRun(api, "gone", "hi");
  await follow(api, first.run_id, ["completed"]);
  await log.when("condition=webhook_disabled");
  const off = (await api("GET", "/settings/webhook")).body.disabled;
  assert.equal(off.reason, "the receiver answered 410 Gone");
  assert.ok(log.lines.some((line) => line.includes("condition=webhook_unwritable")), "the log says the write failed");
  assert.equal(settingOf(data).disabled, undefined, "not in the store");
  const second = await startRun(api, "quiet", "hi");
  await follow(api, second.run_id, ["completed"]);
  assert.deepEqual(nothingPending(data).filter((m) => JSON.parse(m.body).data?.run_id === second.run_id), [], "off: nothing is queued");
  assert.equal(hook.got.length, 1, "off: nothing more is sent");
  release();
  answer = 200;
  const again = (await api("PUT", "/settings/webhook", { url: hook.url })).body;
  assert.equal(again.disabled, null, "a PUT sets it on again");
  const written = settingOf(data);
  assert.deepEqual([written.url, written.updated_at, written.disabled], [set.url, again.updated_at, undefined], "and writes it");
  const third = await startRun(api, "back", "hi");
  await follow(api, third.run_id, ["completed"]);
  await hook.when(2);
  assert.equal(JSON.parse(hook.got[1].body).data.run_id, third.run_id, "sent again: the run after the PUT");
  await turn();
  assert.deepEqual(rejected, [], "no unhandled rejection");
});

test("a scheduled try that throws is said in the log, never an unhandled rejection", async (t) => {
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
  const on = await webhookOn(t, await scratch(t));
  await on.runs("run_1");
  const webhooks = await on.open(say);
  await webhooks.save({ url: hook.url });
  await webhooks.emit("run.ended", { run_id: "run_1", agent_id: "a", status: "completed", title: "t" }, "m1");
  await throwSaid;
  assert.equal(hook.got.length, 1);
  assert.deepEqual(said.filter((fields) => fields.condition === "attempt_failed").map(({ error }) => error), ["the log is gone"]);
  // An unhandled rejection is said once the microtasks of its turn have run: a turn later, it would be in.
  await turn();
  assert.deepEqual(rejected, [], "no unhandled rejection");
});

describe("the outbound webhook: the outbox, its tries and its durability", { concurrency: CASES_AT_ONCE }, () => {
  test("a run whose end cannot be read holds back no other run's notice: the next run's run.ended is told, the unreadable one is said once, and told once it reads", async (t) => {
    const hook = await receiver(t);
    const log = logged();
    const server = await serve(t, { runner: false, log: log.push });
    const { data } = server;
    assert.equal((await server.api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const writer = await askerStore(t, data);
    // Run A's journal records are made unreadable (not JSON, on a connection of the test's own that skips the check) before
    // its end is written, so reading its end throws; run B ends after it, so B's change comes after A's in the store's feed.
    const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 10_000 });
    t.after(() => db.close());
    db.exec("PRAGMA ignore_check_constraints = ON");
    let records;
    await endedInStore(writer, "asker", "run-unreadable", {
      beforeEnd: async () => {
        records = db.prepare("SELECT id, record FROM pi_entries WHERE run_id = ?").all("run-unreadable");
        db.prepare("UPDATE pi_entries SET record = '{not json' WHERE run_id = ?").run("run-unreadable");
      },
    });
    await endedInStore(writer, "asker", "run-readable");
    const endsOf = (id) => ofType(hook.got, "run.ended").filter((r) => JSON.parse(r.body).data.run_id === id);
    await hook.when(() => endsOf("run-readable").length === 1, "the run.ended of run run-readable, after an end that cannot be read", data);
    await log.when("condition=run_notice_unread", "run-unreadable");
    assert.equal(endsOf("run-unreadable").length, 0, "the unreadable end is not told");
    // Readable again: told, once, and said once only.
    for (const { id, record } of records) db.prepare("UPDATE pi_entries SET record = ? WHERE run_id = ? AND id = ?").run(record, "run-unreadable", id);
    await hook.when(() => endsOf("run-unreadable").length === 1, "the run.ended of run run-unreadable, once it reads", data);
    await settled(data);
    assert.deepEqual([endsOf("run-unreadable").length, endsOf("run-readable").length], [1, 1]);
    assert.equal(log.lines.filter((line) => line.includes("condition=run_notice_unread") && line.includes("run-unreadable")).length, 1, "said once");
  });

  test("a receiver that is down gets each try, then the message is logged as failed; one that fails then answers gets it on a try again, under the same webhook-id; a redirect is not followed", async (t) => {
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

  test("a message whose redelivery is in flight stays in the outbox while other attempts push its own out of the log: it can be redelivered again", async (t) => {
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
    const outbox = outboxOf(data);
    assert.ok(!outbox.attempts.some((a) => a.webhook_id === id), "nor is it among the outbox's attempts");
    assert.ok(outbox.messages.some((m) => m.id === id), "the outbox on disk keeps the message in flight");
    release();
    assert.equal((await again).body.status_code, 200);
    const third = await api("POST", `/settings/webhook/deliveries/${id}/redeliver`);
    assert.equal(third.status, 200, `still redeliverable: ${JSON.stringify(third.body)}`);
    assert.equal(hook.got.at(-1).headers["webhook-id"], id);
  });

  test("a 410 that comes back after the webhook was set to another URL turns nothing off: the message goes on to the new URL", async (t) => {
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

  test("a message pending when its server stops goes on from the next one, under the same webhook-id; a run the next server reads as it already stood notices nothing", async (t) => {
    let answer = 503;
    const hook = await receiver(t, () => answer);
    const data = join(await scratch(t), "agents");
    const first = await startWithRunner(t, { data, port: 0, faux: FAUX, drainTimeout: "5s", webhookRetryMs: [2_000] });
    let stopped = false;
    t.after(() => stopped || first.close());
    let api = client(first.baseUrl, first.token);
    const { body: set } = await api("PUT", "/settings/webhook", { url: hook.url });
    const run = await startRun(api, "pending", "hi");
    await follow(api, run.run_id, ["completed"]);
    await hook.when(1);
    // Its first try answered and its next one set, as the outbox on disk says it.
    await onDisk(data, () => outboxOf(data).messages.some((m) => m.status === "pending" && m.attempts === 1 && m.next_at));
    await first.close();
    stopped = true;
    answer = 200;
    const next = await startWithRunner(t, { data, port: 0, faux: FAUX, drainTimeout: "5s" });
    t.after(() => next.close());
    api = client(next.baseUrl, next.token);
    await hook.when(2);
    assert.equal(hook.got[1].headers["webhook-id"], hook.got[0].headers["webhook-id"]);
    new Webhook(set.signing_secret).verify(hook.got[1].body, hook.got[1].headers);
    assert.equal((await api("GET", `/runs/${run.run_id}`)).body.status, "completed");
    // Delivered, and the ledger holds the run's end as the store does: a start's catch-up queues no end the ledger has, so
    // the run, read as it already ended, is no new notice.
    await onDisk(data, () => outboxOf(data).messages.every((m) => m.status !== "pending"));
    assert.equal(noticed(data, run.run_id)?.ended, (await api("GET", `/runs/${run.run_id}`)).body.ended_at);
    assert.equal(hook.got.length, 2, "the run, read as it already ended, is no new notice");
  });

  test("a run that ends while its server stops still gives its notice: kept pending, delivered by the next server", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    const first = await startWithRunner(t, { data, port: 0, faux: FAUX, drainTimeout: "10s" });
    let stopped = false;
    t.after(() => stopped || first.close());
    let api = client(first.baseUrl, first.token);
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const run = await startRun(api, "soon", "Answer soon.");
    await follow(api, run.run_id, ["working"]);
    // The stop drains the run's turn: it answers, and is carried back, while the server closes.
    await first.close();
    stopped = true;
    const next = await startWithRunner(t, { data, port: 0, faux: FAUX, drainTimeout: "5s" });
    t.after(() => next.close());
    api = client(next.baseUrl, next.token);
    // The run ends on the next server's runner (its first runner let it go as its server stopped), and its notice comes from
    // the next server.
    await follow(api, run.run_id, ["completed"]);
    await hook.when((got) => ofType(got, "run.ended").some((r) => JSON.parse(r.body).data.run_id === run.run_id));
  });

  test("a try in flight when its server closes is cut and waited for; nothing is written after, and the next server delivers it; a test send left queued is not tried again", async (t) => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const hook = await receiver(t, (n) => (n === 1 ? held.then(() => 200) : 200));
    t.after(() => release());
    const data = join(await scratch(t), "agents");
    const first = await startWithRunner(t, { data, port: 0, faux: FAUX, drainTimeout: "5s" });
    let stopped = false;
    t.after(() => stopped || first.close());
    let api = client(first.baseUrl, first.token);
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const run = await startRun(api, "held", "hi");
    await follow(api, run.run_id, ["completed"]);
    await hook.when(1);
    const before = JSON.stringify(outboxOf(data));
    // The close comes back while the receiver still holds the try unanswered: the try is cut, not waited out (a close
    // that waited for its answer would never come back before the release below).
    await first.close();
    stopped = true;
    release();
    // The held answer goes out to a cut connection; nothing of the closed server reads it.
    await held;
    await turn();
    assert.equal(JSON.stringify(outboxOf(data)), before, "nothing written after the close");
    const [pending] = outboxOf(data).messages;
    assert.deepEqual([pending.status, pending.attempts], ["pending", 0]);
    // A test send an earlier server left queued: the next one drops it and never sends it.
    const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 10_000 });
    db.prepare("INSERT INTO channel_posts (id, channel, moment, body, next_at, state, created_at) VALUES (?, 'webhook-out', 'webhook.test', ?, ?, 'queued', ?)")
      .run(`msg_${"0".repeat(32)}`, JSON.stringify({ type: "webhook.test", timestamp: new Date().toISOString(), data: {} }), Date.now(), Date.now());
    db.close();
    const next = await startWithRunner(t, { data, port: 0, faux: FAUX, drainTimeout: "5s" });
    t.after(() => next.close());
    api = client(next.baseUrl, next.token);
    await hook.when(2);
    assert.equal(hook.got[1].headers["webhook-id"], pending.id);
    // The next server dropped the test send as it read the outbox, so no try of it is armed: once the run's message is
    // delivered, nothing is pending, and nothing more is sent.
    await settled(data);
    assert.equal(hook.got.length, 2, "the test send is not sent again");
    assert.equal(outboxOf(data).messages.find((m) => m.type === "webhook.test")?.status ?? "failed", "failed");
  });

  test("a notice the store refuses is told again once it takes the write: none is lost, and it is sent once", async (t) => {
    const hook = await receiver(t);
    const log = logged();
    const { api, data } = await serve(t, { log: log.push });
    assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    // The store refuses the webhook's messages, as on a full disk; the run's own rows are written as ever.
    const release = refusing(t, data, "outbox");
    const run = await startRun(api, "unsaved", "hi");
    await follow(api, run.run_id, ["completed"]);
    // Its notice was tried as its end was read, and refused: not queued, so nothing is sent.
    await log.when("condition=outbox_unwritable");
    assert.equal(endNotice(data, run.run_id), undefined, "not in the ledger: the store took none of it");
    assert.equal(hook.got.length, 0, "nothing sent");
    release();
    // Told again at the next read of the feed's runs left: queued, recorded, and sent once.
    await hook.when((got) => ofType(got, "run.ended").length === 1, `the run.ended of run ${run.run_id}, once the store takes it`, data);
    await settled(data);
    assert.ok(endNotice(data, run.run_id)?.queued, "recorded with it");
    assert.equal(ofType(hook.got, "run.ended").length, 1, "once");
  });

  test("a try that fails after a redelivery delivered the same message leaves it delivered: no failure is said", async (t) => {
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
    await onDisk(data, () => outboxOf(data).attempts.length === 2);
    assert.equal(log.lines.filter((line) => line.includes("condition=delivery_failed")).length, 0, "no false failure");
  });

  test("a run.ended the store refuses is neither queued nor sent, so after a kill the next server queues and sends it, once", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    await hadWebhook(t, data, hook);
    const writer = await askerStore(t, data);
    const at = await endedInStore(writer, "asker", "unsaved-end");
    // The store refuses the webhook's messages, as on a full disk. A server in a process of its own tries the end, is
    // refused, and is killed.
    const release = refusing(t, data, "outbox");
    const first = await processOn(t, data);
    await saidBy(first.child, "condition=outbox_unwritable");
    assert.equal(endNotice(data, "unsaved-end"), undefined, "not recorded: the store never held it");
    await killed(first.child);
    release();
    assert.equal(ofType(hook.got, "run.ended").length, 0, "nothing was sent");
    const next = await startWithRunner(t, { data, runner: false });
    t.after(() => next.close());
    await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run unsaved-end, from the next server", data);
    await settled(data);
    assert.ok(endNotice(data, "unsaved-end")?.queued);
    assert.deepEqual(ofType(hook.got, "run.ended").map((r) => r.headers["webhook-id"]), [noticeId("unsaved-end", "run.ended", at)], "one end, once, under its id");
  });

  test("a run.needs_input the store refuses is not recorded, so after a kill the next server queues it, once, under its id", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    await hadWebhook(t, data, hook);
    const writer = await askerStore(t, data);
    await parkedOnQuestion(writer, "asker", "asks-unsaved", "Which region?", { wake: false });
    const release = refusing(t, data, "outbox");
    const first = await processOn(t, data);
    await saidBy(first.child, "condition=outbox_unwritable");
    assert.equal(waitNotice(data, "asks-unsaved"), undefined, "not recorded: the store never held it");
    await killed(first.child);
    release();
    const next = await startWithRunner(t, { data, runner: false });
    t.after(() => next.close());
    await hook.when((got) => ofType(got, "run.needs_input").length === 1, "the run.needs_input of run asks-unsaved, from the next server", data);
    await settled(data);
    assert.ok(waitNotice(data, "asks-unsaved"));
    assert.equal(ofType(hook.got, "run.needs_input").length, 1, "one wait, one message");
  });

  test("a start's catch-up queues each end the store holds and the ledger does not, once; an end before the webhook's own setting is never sent", async (t) => {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const on = await webhookOn(t, dir);
    await on.runs("old", "lost");
    const webhooks = await on.open();
    const before = new Date(Date.now() - 60_000).toISOString();
    await webhooks.save({ url: hook.url });
    const now = new Date().toISOString();
    await webhooks.catchUp(...stored([{ id: "old", endedAt: before }, { id: "lost", endedAt: now }]));
    await webhooks.catchUp(...stored([{ id: "lost", endedAt: now }]));
    await hook.when(1);
    await settled(dir);
    assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).data.run_id), ["lost"], "once, and never the end before the webhook was set");
    assert.equal(outboxOf(dir).notices.lost.ended, now);
  });

  test("a start's catch-up queues no end of a run that moved on while it read earlier rows: continued to a new wait, its saved end goes once, whether that end was still being sent or delivered", async (t) => {
    for (const first of ["sending", "delivered"]) {
      let answer;
      const answered = new Promise((resolve) => (answer = resolve));
      const isFirstEnd = (r) => JSON.parse(r.body).type === "run.ended" && JSON.parse(r.body).data.run_id === "moved";
      // While "sending", the first end's try waits for its answer until the catch-up is done.
      const hook = await receiver(t, (n) => (first === "sending" && isFirstEnd(hook.got[n - 1]) ? answered.then(() => 200) : 200));
      const dir = await scratch(t);
      const on = await webhookOn(t, dir);
      await on.runs("earlier", "moved");
      const webhooks = await on.open();
      await webhooks.save({ url: hook.url });
      // Set a minute ago: both ends came after it, so both are due.
      await on.setAt(new Date(Date.now() - 60_000).toISOString());
      const later = await on.open();
      const notice = (id, status = "completed") => ({ run_id: id, agent_id: "a", status, title: id });
      const [earlier, moved] = [new Date(Date.now() - 2_000).toISOString(), new Date(Date.now() - 1_000).toISOString()];
      // The store as the start read it: both runs ended. The ledger has the second's end, queued before.
      const store = new Map([["earlier", { id: "earlier", state: "completed", endedAt: earlier }], ["moved", { id: "moved", state: "completed", endedAt: moved }]]);
      assert.equal(await later.emit("run.ended", notice("moved"), moved), "queued");
      if (first === "delivered") await onDisk(dir, () => outboxOf(dir).attempts.length === 1);
      let reading;
      const read = new Promise((resolve) => (reading = resolve));
      let resume;
      const resumed = new Promise((resolve) => (resume = resolve));
      const current = async (id) => {
        if (id === "earlier") (reading(), await resumed);
        return { ...store.get(id), notice: notice(id) };
      };
      const catchingUp = later.catchUp([...store.values()], current);
      await read;
      // While the catch-up reads the earlier row, the second run is continued and comes to a new wait.
      store.set("moved", { id: "moved", state: "running" });
      assert.equal(await later.emit("run.needs_input", notice("moved", "input_required"), "row_9"), "queued");
      resume();
      await catchingUp;
      answer();
      await hook.when(3);
      await settled(dir);
      const ids = hook.got.map((r) => r.headers["webhook-id"]).sort();
      assert.deepEqual(ids, [noticeId("earlier", "run.ended", earlier), noticeId("moved", "run.ended", moved), noticeId("moved", "run.needs_input", "row_9")].sort(), `each once (${first})`);
    }
  });

  test("an end after the webhook was set and inside the day is queued by a start's catch-up, though it came before that server started", async (t) => {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const on = await webhookOn(t, dir);
    await on.runs("ended-before-start");
    const setup = await on.open();
    await setup.save({ url: hook.url });
    await setup.close();
    await on.setAt(new Date(Date.now() - 600_000).toISOString());
    const ended = new Date(Date.now() - 300_000).toISOString();
    const webhooks = await on.open();
    await webhooks.catchUp(...stored([{ id: "ended-before-start", endedAt: ended }]));
    await hook.when(1);
    assert.equal(hook.got[0].headers["webhook-id"], noticeId("ended-before-start", "run.ended", ended));
  });

  test("the ledger keeps an end exactly as long as a start's catch-up looks for it: one just inside the day stays and is not sent again; one just past it is dropped, and not sent either", async (t) => {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const day = 24 * 3_600_000;
    const inside = new Date(Date.now() - day + 60_000).toISOString();
    const past = new Date(Date.now() - day - 60_000).toISOString();
    // The webhook was set two days ago; the ledger holds both ends from an earlier server.
    const on = await webhookOn(t, dir);
    await on.runs("inside", "past", "now");
    const setup = await on.open();
    await setup.save({ url: hook.url });
    await setup.close();
    await on.setAt(new Date(Date.now() - 2 * day).toISOString());
    leftAs(dir, { told: { inside: { ended: inside }, past: { ended: past } } });
    const webhooks = await on.open();
    // A new notice prunes the ledger, as the catch-up would read it.
    await webhooks.emit("run.ended", { run_id: "now", agent_id: "a", status: "completed", title: "t" }, new Date().toISOString());
    assert.deepEqual(Object.keys(outboxOf(dir).notices).sort(), ["inside", "now"], "the end past the day is dropped; the one inside it stays");
    await webhooks.catchUp(...stored([{ id: "inside", endedAt: inside }, { id: "past", endedAt: past }]));
    await hook.when(1);
    await settled(dir);
    assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).data.run_id), ["now"], "neither earlier end sent again");
  });

  test("an end just inside the catch-up's day, its ledger entry at the pruning edge, is delivered exactly once across a restart: never twice, never not at all", async (t) => {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const day = 24 * 3_600_000;
    // Both ends 2 min inside the day: one this server queued, one whose server was killed before the store had it.
    const sent = new Date(Date.now() - day + 120_000).toISOString();
    const lost = new Date(Date.now() - day + 120_000).toISOString();
    const on = await webhookOn(t, dir);
    await on.runs("sent", "lost", "fresh", "pruning");
    const setup = await on.open();
    await setup.save({ url: hook.url });
    await setup.close();
    await on.setAt(new Date(Date.now() - 2 * day).toISOString());
    const first = await on.open();
    const run = (id) => ({ run_id: id, agent_id: "a", status: "completed", title: id });
    await first.emit("run.ended", run("sent"), sent);
    // A later notice prunes the ledger: the entry at the edge stays.
    await first.emit("run.ended", run("fresh"), new Date().toISOString());
    await hook.when(2);
    await settled(dir);
    await first.close();
    // Its message leaves the store as later attempts push it out of the log (ATTEMPTS_KEPT): the ledger alone keeps it.
    leftAs(dir, { cleared: true });
    const next = await on.open();
    await next.emit("run.ended", run("pruning"), new Date().toISOString());
    await next.catchUp(...stored([{ id: "sent", endedAt: sent }, { id: "lost", endedAt: lost }]));
    // A continuation tells the same end again.
    await next.emit("run.ended", run("sent"), sent);
    await hook.when(4);
    await settled(dir);
    const of = (id) => hook.got.filter((r) => JSON.parse(r.body).data.run_id === id).length;
    assert.deepEqual([of("sent"), of("lost")], [1, 1], "each end at the edge once");
  });

  test("a cancelled run whose last row is an open question, its wait no longer in the ledger, gives no run.needs_input when a later server reads it: an ended run never asks", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    const first = await startWithRunner(t, { data, runner: false });
    assert.equal((await client(first.baseUrl, first.token)("PUT", "/settings/webhook", { url: hook.url })).status, 201);
    const writer = await askerStore(t, data);
    await parkedOnQuestion(writer, "asker", "asks-then-cancelled", "Which region?");
    await hook.when((got) => ofType(got, "run.needs_input").length === 1, "the run.needs_input of run asks-then-cancelled", data);
    // Cancelled where it waits: stopped, its last row still the question.
    await endParked(writer, "asks-then-cancelled", "stopped");
    await hook.when((got) => ofType(got, "run.ended").length === 1, "the run.ended of run asks-then-cancelled", data);
    await settled(data);
    await first.close();
    // The ledger as a pruning leaves it: no wait of the run, and its messages gone from the store.
    leftAs(data, { told: { "asks-then-cancelled": { ended: noticed(data, "asks-then-cancelled").ended } }, cleared: true });
    const next = await startWithRunner(t, { data, runner: false });
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

  test("a run still waiting on the same question a day later, its message gone from the store, is not asked about again: the ledger keeps a wait until the run moves past it", async (t) => {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const on = await webhookOn(t, dir);
    await on.runs("waiting", "other");
    const setup = await on.open();
    await setup.save({ url: hook.url });
    await setup.close();
    // Queued two days ago, delivered, and pushed out of the log since: the ledger alone has the wait.
    leftAs(dir, { told: { waiting: { wait: "row_9" } }, cleared: true });
    const webhooks = await on.open();
    const waiting = { run_id: "waiting", agent_id: "a", status: "input_required", title: "t", pending: { kind: "question" } };
    // Another run's notice prunes the ledger; then the waiting run is seen again (an adoption, a refresh).
    await webhooks.emit("run.ended", { run_id: "other", agent_id: "a", status: "completed", title: "o" }, new Date().toISOString());
    await webhooks.emit("run.needs_input", waiting, "row_9");
    await hook.when(1);
    await settled(dir);
    assert.deepEqual(hook.got.map((r) => JSON.parse(r.body).type), ["run.ended"], "the same wait is not sent again");
    // A new question of the run is a wait of its own, and replaces the last; then the run ends.
    await webhooks.emit("run.needs_input", waiting, "row_12");
    const end = new Date().toISOString();
    await webhooks.emit("run.ended", { ...waiting, status: "completed", pending: undefined }, end);
    await hook.when(3);
    await settled(dir);
    // The new wait and the end were queued together, and each message goes on its own tries: they land in either order.
    const types = hook.got.map((r) => JSON.parse(r.body).type);
    assert.deepEqual([types[0], types.slice(1).sort()], ["run.ended", ["run.ended", "run.needs_input"]]);
    assert.deepEqual(outboxOf(dir).notices.waiting, { wait: "row_12", ended: end }, "the newest wait, and the end past it");
  });

  test("a run that ends while the webhook is off leaves its wait behind in the ledger; the next start, the webhook set again, drops it and sends nothing", async (t) => {
    const hook = await receiver(t);
    const data = join(await scratch(t), "agents");
    const first = await startWithRunner(t, { data, runner: false });
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
    const next = await startWithRunner(t, { data, runner: false });
    t.after(() => next.close());
    await onDisk(data, () => !noticed(data, "asks-off"));
    nothingPending(data);
    assert.deepEqual([ofType(hook.got, "run.needs_input").length, ofType(hook.got, "run.ended").length], [1, 0], "nothing sent");
  });

  test("a start drops the ledger's waits of runs the store holds as ended or no longer has, keeps an end still due, and keeps a wait the run still stands at however old", async (t) => {
    const hook = await receiver(t);
    const dir = await scratch(t);
    const day = 24 * 3_600_000;
    const on = await webhookOn(t, dir);
    await on.runs("deleted", "ended", "kept", "open");
    const setup = await on.open();
    await setup.save({ url: hook.url });
    await setup.close();
    await on.setAt(new Date(Date.now() - 3 * day).toISOString());
    const old = new Date(Date.now() - 2 * day).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    leftAs(dir, { told: { deleted: { wait: "row_1" }, ended: { wait: "row_2" }, kept: { wait: "row_3", ended: recent }, open: { wait: "row_4" } } });
    const webhooks = await on.open();
    // The store's rows: "deleted" is gone, "ended" and "kept" have ended, "open" still waits (two days on).
    await webhooks.catchUp(...stored([{ id: "ended", state: "completed", endedAt: old }, { id: "kept", state: "completed", endedAt: recent }, { id: "open", state: "running" }]));
    assert.deepEqual(outboxOf(dir).notices, { kept: { ended: recent }, open: { wait: "row_4" } });
    // The catch-up has returned, its queuing done in it: with nothing pending, nothing is sent.
    nothingPending(dir);
    assert.equal(hook.got.length, 0, "nothing sent");
  });
});
