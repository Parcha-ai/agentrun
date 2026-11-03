// A message sent while a stop is in flight (its mark set, its abort not yet answered) is taken after the stop. Sent into
// that gap, it would reach the turn the abort then cuts and be withdrawn with it: its row never comes, the run reads
// working for good and keeps its place. The stop is held in the gap by startServe's test seam (beforeAbort), so the
// interleaving is forced, not timed. A message that began before the stop and was still waiting (on the agent store)
// when the stop came looks again once its waits are over.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { follow, serve, startRun } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a message sent while a stop is in flight is taken after the stop: the run reads input_required, then the follow-up completes it", { timeout: 240_000 }, async (t) => {
  let reached, release;
  const atAbort = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (release = resolve));
  const { api } = await serve(t, { beforeAbort: async () => { reached(); await held; } });
  // Its first request answers only after a minute: the turn still runs when the stop comes.
  const { run_id } = await startRun(api, "slow", "Take your time.");
  for (const end = Date.now() + 60_000; ; await sleep(50)) {
    const { status, state } = (await api("GET", `/runs/${run_id}`)).body;
    if (status === "working" && state === "working") break;
    assert.ok(Date.now() < end, `the run works: last ${status}/${state}`);
  }
  const order = [];
  const stopping = api("POST", `/runs/${run_id}/stop`).then((res) => (order.push("stop"), res));
  // The stop has set its mark and saved it; its abort waits at the seam.
  await atAbort;
  const sending = api("POST", `/runs/${run_id}/messages`, { content: "Go on." }).then((res) => (order.push("message"), res));
  // Without the wait the message is answered here, while the stop is held: sent as a follow-up to the turn the abort is
  // about to cut. With it, it waits for the stop. Either way the stop is let go after this.
  await Promise.race([sending, sleep(2_000)]);
  release();
  const [stop, sent] = await Promise.all([stopping, sending]);
  assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
  assert.deepEqual(order, ["stop", "message"], "the message waits for the stop in flight to answer");
  assert.deepEqual([sent.status, sent.body.mode], [202, "follow_up"], JSON.stringify(sent.body));
  // The follow-up is a fresh turn the stop did not cut: its row comes and the run completes, never left working.
  const { rows, last } = await follow(api, run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(last.final, true);
  assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.summary), ["You: Take your time.", "You: Go on."]);
});

test("a message that began before a stop, and was waiting on the agent store when the stop came, is taken after the stop", { timeout: 600_000 }, async (t) => {
  // The stop's seam, given a fresh hold by each attempt below.
  let hold;
  const { api, data } = await serve(t, { beforeAbort: () => hold?.() });
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  t.after(() => store.isOpen && (store.isTransaction && store.exec("ROLLBACK"), store.close()));
  /** One run through the window. It answers null when the held message ran out of the agent store's wait (about 2 s for a
   *  request, then home_busy) before the stop reached its seam: then the window was not held, and nothing was checked. */
  const attempt = async (n) => {
    let reached, release;
    const atAbort = new Promise((resolve) => (reached = resolve));
    const held = new Promise((resolve) => (release = resolve));
    hold = async () => { reached(); await held; };
    const { run_id } = await startRun(api, `slow-${n}`, "Take your time.");
    for (const end = Date.now() + 60_000; ; await sleep(50)) {
      const { status, state } = (await api("GET", `/runs/${run_id}`)).body;
      if (status === "working" && state === "working") break;
      assert.ok(Date.now() < end, `the run works: last ${status}/${state}`);
    }
    // The agent store held exclusively (no read gets through): the run's first message reads its harness from the store
    // (its revision, once per run), so it waits there, past its first look for a stop, while the store is held.
    store.exec("BEGIN EXCLUSIVE");
    // The same message twice under one Idempotency-Key: one runs, and the other is answered 409 in progress only once the
    // first is inside its work, which reaches the store read without awaiting anything before it.
    const send = () => api("POST", `/runs/${run_id}/messages`, { content: "Go on." }, { "idempotency-key": `go-on-${run_id}` });
    const [a, b] = [send(), send()];
    const first = await Promise.race([a.then((res) => ({ res, other: b })), b.then((res) => ({ res, other: a }))]);
    if (first.res.body.error?.code === "home_busy") {
      store.exec("ROLLBACK");
      await first.other;
      return null;
    }
    assert.deepEqual([first.res.status, first.res.body.error?.code], [409, "idempotency_in_progress"], JSON.stringify(first.res.body));
    const order = [];
    const sending = first.other.then((res) => (order.push("message"), res));
    // The stop comes now: the message has not been counted yet, so the stop is taken, sets its mark and waits at the seam.
    const stopping = api("POST", `/runs/${run_id}/stop`).then((res) => (order.push("stop"), res));
    await atAbort;
    store.exec("ROLLBACK");
    // Without the second look the message goes on here, while the stop is held, to the turn the abort will cut.
    await Promise.race([sending, sleep(2_000)]);
    release();
    const [stop, sent] = await Promise.all([stopping, sending]);
    assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
    if (sent.status === 409 && sent.body.error?.code === "home_busy") return null;
    assert.deepEqual(order, ["stop", "message"], "the message looks for the stop again after its waits");
    assert.deepEqual([sent.status, sent.body.mode], [202, "follow_up"], JSON.stringify(sent.body));
    const { rows, last } = await follow(api, run_id, ["completed"], { deadlineMs: 120_000 });
    assert.equal(last.final, true);
    assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.summary), ["You: Take your time.", "You: Go on."]);
    return run_id;
  };
  // Every attempt that held the window must come out right; one that did not (a loaded machine let the store's wait run
  // out first) is done again on a fresh run, up to three times in all, and at least one must hold it.
  const heldRuns = [];
  for (let n = 1; n <= 3 && !heldRuns.length; n++) {
    const run = await attempt(n);
    if (run) heldRuns.push(run);
    else t.diagnostic(`attempt ${n}: the held message ran out of the store's wait before the stop reached its seam; again on a fresh run`);
  }
  assert.equal(heldRuns.length, 1, "the window was held in one of three attempts");
});
