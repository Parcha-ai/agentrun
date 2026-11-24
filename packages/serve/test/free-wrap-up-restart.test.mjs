// The free-model wrap-up across a runner restart (free-wrap-up.test.mjs's note, kernel cap free.ts): a run on a free model
// is told once, 3 requests before its limit, whatever runner it is on. The told limit is the run's CAP_WRAPUP row naming
// `freeLimit`, read at each claim (adapter-loop.ts toldFreeLimits), so a runner that takes the run up after a crash never
// tells it again, and one that takes it up before the note was due still tells it. The faux model (fixtures/
// faux-loop-hold.mjs) holds one request open while the runner beside the server crashes (support.mjs crashRunner); the
// next runner takes the run once the crashed one's claim runs out, and sends the held request again.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { HOLD_AT_ENV, RELEASE_ENV } from "./fixtures/faux-loop-hold.mjs";
import { agent, follow, journalOf, scratch, serve, withEnv } from "./support.mjs";

const HOLD_LOOP = new URL("./fixtures/faux-loop-hold.mjs", import.meta.url).pathname;
const ENV = "AGENTRUN_FREE_MODEL_REQUESTS";
/** A lease short enough that a crashed runner's claim runs out soon, and long enough that a slow flush on CI (the lease
 *  renewal waits behind it on the store's one worker) never loses the live runner's claim before the crash: a lost
 *  claim books the request in flight cut, and a cut request is counted (kernel cap free.ts), so the note would come one
 *  request early. 1.5 s was lost on CI behind a flush of 1.1 s or more. */
const CRASHABLE = { leaseMs: 4_000, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
/** The words with `left` requests left (kernel cap free.ts). */
const WORDS = (left) => `${left} free-model requests left in this run, this one included: finish now with your answer.`;
/** The text between the tags the proxy places the note in. */
const reminderIn = (text) => /<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/.exec(text)?.[1] ?? text;

/** "Loop 8" under a 10-request limit, its `holdAt`th request held while the runner crashes: 9 requests and the held one
 *  sent again, 10 counted. Its view, what each answered request was sent, the run's free-limit rows and its records. */
async function restartedAt(t, holdAt) {
  const dir = await scratch(t);
  const calls = join(dir, "calls.jsonl");
  const release = join(dir, "release");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, [ENV]: "10", [HOLD_AT_ENV]: String(holdAt), [RELEASE_ENV]: release }, [ENV]);
  // The held request goes on (into the crashed runner) at the end, whatever happened, so nothing waits on it.
  t.after(() => writeFile(release, ""));
  const { api, data, crashRunner } = await serve(t, { faux: HOLD_LOOP, runnerTiming: CRASHABLE });
  assert.equal((await api("POST", "/agents", agent("loop", { instructions: "Look it up." }))).status, 201);
  const started = await api("POST", "/agents/loop/runs", { input: { content: "Loop 8" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  for (const end = Date.now() + 60_000; !existsSync(`${release}.held`); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, `request ${holdAt} was sent and held`);
  }
  await crashRunner();
  await writeFile(release, "");
  await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  const sent = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows.filter((row) => row.kind === "phase" && /free-model requests left/.test(row.summary ?? ""));
  const entries = journalOf(data, runId);
  return { view, sent, rows, entries };
}

/** What a restarted run says of its note: one request carried it, one row and one record say so, and the held request was
 *  booked cut by the runner that took the run up. */
function toldOnce({ view, sent, rows, entries }) {
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.ok(entries.some((entry) => entry.kind === "runner.turn" && entry.data?.cut === true), "the held request was cut by the crash and booked so");
  assert.equal(sent.length, 9, `the run's 9 requests were answered, the held one sent again: ${JSON.stringify(sent)}`);
  const carried = sent.filter((call) => call.note !== null);
  assert.equal(carried.length, 1, `one request carried the note: ${JSON.stringify(carried)}`);
  // The model is told it as the server's note (SERVER_NOTE_LABEL); the server's row says the words after the label.
  assert.equal(reminderIn(carried[0].note).trim(), `AgentRun server note: ${WORDS(3)}`);
  const told = entries.filter((entry) => entry.kind === "agentrun.cap_wrapup" && typeof entry.data?.freeLimit === "number");
  assert.deepEqual(told.map((entry) => entry.data.freeLimit), [10], "one record of the told limit");
  assert.deepEqual(rows.map((row) => row.text), [WORDS(3)], "one row of the server's says so");
}

test("a runner restart before the free-limit note is due never loses it: the next runner tells it, once", { timeout: 240_000 }, async (t) => {
  // The 5th request is out when the runner crashes; the next runner sends it again (the 6th counted), and the note comes
  // with the 8th counted request, the 7th answered.
  const ran = await restartedAt(t, 5);
  t.diagnostic(`notes: ${JSON.stringify(ran.sent.map((call) => call.note && reminderIn(call.note).trim()))}`);
  toldOnce(ran);
  assert.equal(ran.sent.findIndex((call) => call.note !== null), 6, "the 7th answered request carried it, after the restart");
});
