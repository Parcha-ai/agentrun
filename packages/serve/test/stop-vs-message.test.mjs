// A message sent while a stop is in flight (its mark set, its abort not yet answered) is taken after the stop. Sent into
// that gap, it would reach the turn the abort then cuts and be withdrawn with it: its row never comes, the run reads
// working for good and keeps its place. The stop is held in the gap by startServe's test seam (beforeAbort), so the
// interleaving is forced, not timed.
import assert from "node:assert/strict";
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
