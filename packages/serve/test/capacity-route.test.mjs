// GET /v2/capacity (capacity.ts): the runs waiting for a runner and held by one, each live runner with its version, slots
// and free slots, and the hand-backs within a window, read from the store alone. An API-only server with no runner beside
// it serves it for the runners on its store, behind the token. Counts, runner names and versions only: never a run id, an
// agent or a runner's address. And the runner's metric lines (runner-metrics.ts), in the server's log format.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { serve } from "./support.mjs";

const { keepPresence, PRESENCE_STALE_MS } = await import("../dist/runner/presence.js");
const { capacityOverStore, capacityWindowOf, CAPACITY_WINDOW_MAX_MINUTES, CAPACITY_WINDOW_MINUTES } = await import("../dist/capacity.js");
const { gaugeLine, metricLine, startRunnerGauge } = await import("../dist/runner/runner-metrics.js");

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const KEYS = ["at", "free_slots", "hand_backs", "runners", "runs"];
const RUNNER_KEYS = ["executing", "free_slots", "id", "refused", "seen_at", "slots", "version"];

/** One request to `server` (its path from the root, the token unless `token` is false): its status and body. */
async function send(server, path, { token = true } = {}) {
  const res = await fetch(`${server.url}${path}`, { headers: token ? { authorization: `Bearer ${server.token}` } : {} });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json ?? text };
}

/** Waits until every runner in `want` (names, or how many) has its row live in `runners` (a presence's first put is not
 *  awaited by its caller): polls until its own few seconds are up, then fails naming the runners seen. */
async function runnersRegistered(runners, want, { withinMs = 5000 } = {}) {
  const deadline = Date.now() + withinMs;
  let seen = [];
  while (Date.now() < deadline) {
    seen = (await runners.live(PRESENCE_STALE_MS)).map((row) => row.runner);
    if (typeof want === "number" ? seen.length >= want : want.every((name) => seen.includes(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`runners ${JSON.stringify(want)} did not register within ${withinMs} ms; seen ${JSON.stringify(seen)}`);
}

/** An inline run on `server`, queued (no runner takes it): its run and agent ids. */
async function inlineRun(server, id) {
  const res = await fetch(`${server.url}/v2/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ external: { source: "grep", kind: "expert", id, version: 1 }, definition: { name: `Expert ${id}`, instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" } }),
  });
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  return { runId: body.run_id, agentId: body.agent_id };
}

test("an API-only server serves the capacity behind its token: nothing queued, no runner, no hand-back on a new store", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  assert.equal((await send(server, "/v2/capacity", { token: false })).status, 401, "it takes the token");
  const read = await send(server, "/v2/capacity");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(Object.keys(read.body).sort(), KEYS);
  assert.ok(!Number.isNaN(Date.parse(read.body.at)), "at is a time");
  const { at: _at, ...rest } = read.body;
  assert.deepEqual(rest, { runs: { queued: 0, executing: 0 }, runners: [], free_slots: 0, hand_backs: { window_minutes: CAPACITY_WINDOW_MINUTES, count: 0 } });
});

test("the capacity counts queued and held runs, each live runner's version and free slots, and the hand-backs, with no run or agent named", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const first = await inlineRun(server, "1");
  const second = await inlineRun(server, "2");
  // A slow store: each runner's first put lands 300 ms late, as on a loaded box, so the case has to wait for the rows.
  const runners = server.store.runners;
  const slowRunners = Object.create(runners, { put: { value: async (...args) => { await new Promise((resolve) => setTimeout(resolve, 300)); return runners.put(...args); } } });
  // A runner apart says it is there, as the runner process does (main.ts): its version and its slots on its row.
  const presence = keepPresence(slowRunners, "runner-x", null, { slots: 4 });
  t.after(() => presence.close());
  // A second runner that refused to claim: live, and no free slot.
  const refused = keepPresence(slowRunners, "runner-refusing", "its run isolation was refused", {});
  t.after(() => refused.close());
  await runnersRegistered(server.store.runners, ["runner-refusing", "runner-x"]);
  let read = await send(server, "/v2/capacity");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.runs, { queued: 2, executing: 0 }, "both runs wait");
  assert.deepEqual(read.body.runners.map((runner) => Object.keys(runner).sort()), [RUNNER_KEYS, RUNNER_KEYS]);
  assert.deepEqual(read.body.runners.map(({ seen_at: _seen, ...runner }) => runner), [
    { id: "runner-refusing", version: VERSION, slots: null, executing: 0, free_slots: 0, refused: true },
    { id: "runner-x", version: VERSION, slots: 4, executing: 0, free_slots: 4, refused: false },
  ]);
  assert.equal(read.body.free_slots, 4);
  // runner-x claims the first run: one held, one waiting, three slots free.
  const claim = await server.store.claim(first.runId, "runner-x", { leaseMs: 30_000 });
  assert.ok(claim, "claimed");
  read = await send(server, "/v2/capacity");
  assert.deepEqual(read.body.runs, { queued: 1, executing: 1 });
  assert.deepEqual(read.body.runners.find((runner) => runner.id === "runner-x"), { ...read.body.runners.find((runner) => runner.id === "runner-x"), executing: 1, free_slots: 3 });
  assert.equal(read.body.free_slots, 3);
  // It hands the run back still running (a drain): counted, and the run waits again.
  await server.store.release(claim, {});
  read = await send(server, "/v2/capacity?window=5");
  assert.deepEqual(read.body.runs, { queued: 2, executing: 0 });
  assert.deepEqual(read.body.hand_backs, { window_minutes: 5, count: 1 });
  // Counts and runner names only: no run, agent or address reaches the answer.
  const text = JSON.stringify(read.body);
  for (const secret of [first.runId, first.agentId, second.runId, second.agentId, "127.0.0.1", "its run isolation was refused"]) assert.ok(!text.includes(secret), `${secret} is not in the answer`);
});

test("the window is a whole number of minutes from 1 to a day, else 400", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  for (const window of ["0", "1441", "abc", "1.5", "-1", ""]) {
    const read = await send(server, `/v2/capacity?window=${encodeURIComponent(window)}`);
    assert.equal(read.status, 400, `${JSON.stringify(window)}: ${JSON.stringify(read.body)}`);
    assert.equal(read.body.error.code, "bad_request");
  }
  assert.equal((await send(server, "/v2/capacity?window=1440")).body.hand_backs.window_minutes, CAPACITY_WINDOW_MAX_MINUTES);
  assert.equal(capacityWindowOf(new URL("http://x/v2/capacity?window=60")), 60);
  assert.equal(capacityWindowOf(new URL("http://x/v2/capacity")), CAPACITY_WINDOW_MINUTES);
});

test("a server with its runner beside it lists that runner with this build's version and its slots", async (t) => {
  const server = await serve(t);
  await runnersRegistered(server.store.runners, 1);
  const read = await send(server, "/v2/capacity");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.runners.length, 1, JSON.stringify(read.body.runners));
  const [runner] = read.body.runners;
  assert.equal(runner.version, VERSION);
  assert.ok(Number.isInteger(runner.slots) && runner.slots > 0, `slots: ${runner.slots}`);
  assert.equal(runner.free_slots, runner.slots - runner.executing);
});

test("capacityOverStore sums executing over every claim, a runner gone included, and free slots over live runners alone", async () => {
  const runners = {
    capacity: async () => ({ at: Date.parse("2026-11-20T00:00:00Z"), queued: 7, held: new Map([["a", 3], ["gone", 2]]), handBacks: 4 }),
    live: async () => [
      { runner: "a", incarnation: "i", refused: null, host: "10.0.0.9", port: 7341, seenAt: Date.parse("2026-11-20T00:00:00Z"), version: "1.0.0", slots: 2 },
      { runner: "b", incarnation: "j", refused: null, host: null, port: null, seenAt: Date.parse("2026-11-20T00:00:00Z"), version: null, slots: null },
    ],
  };
  assert.deepEqual(await capacityOverStore(runners, 30), {
    at: "2026-11-20T00:00:00.000Z",
    runs: { queued: 7, executing: 5 },
    runners: [
      { id: "a", version: "1.0.0", slots: 2, executing: 3, free_slots: 0, refused: false, seen_at: "2026-11-20T00:00:00.000Z" },
      { id: "b", version: null, slots: null, executing: 0, free_slots: null, refused: false, seen_at: "2026-11-20T00:00:00.000Z" },
    ],
    free_slots: 0,
    hand_backs: { window_minutes: 30, count: 4 },
  });
});

/** A logfmt line's fields, `at` aside. */
const fieldsOf = (line) => Object.fromEntries(line.split(" ").map((pair) => pair.split("=")).filter(([key]) => key !== "at"));

test("the runner's metric lines: claims, hand-backs by cause, a lost claim, the drain and the gauge, in the server's log format", () => {
  const claim = { runId: "run-1", runner: "r1", epoch: 3, until: 0, from: "queued" };
  assert.deepEqual(fieldsOf(metricLine("r1", { type: "claimed", claim })), { event: "runner_claimed", runner: "r1", run: "run-1", epoch: "3", from: "queued" });
  assert.deepEqual(fieldsOf(metricLine("r1", { type: "claimed", claim: { ...claim, from: "running", lost: { runner: "r0" } } })), { event: "runner_claimed", runner: "r1", run: "run-1", epoch: "3", from: "running", took_over: "1", lost_runner: "r0" });
  for (const cause of ["drain", "interrupted", "end_retry", "give_back"]) {
    assert.deepEqual(fieldsOf(metricLine("r1", { type: "handed-back", runId: "run-1", epoch: 3, cause })), { event: "runner_hand_back", runner: "r1", run: "run-1", epoch: "3", cause });
  }
  assert.deepEqual(fieldsOf(metricLine("r1", { type: "claim-lost", runId: "run-1", epoch: 3, why: "not-renewed" })), { event: "runner_hand_back", runner: "r1", run: "run-1", epoch: "3", cause: "claim_lost", why: "not_renewed" });
  assert.deepEqual(fieldsOf(metricLine("r1", { type: "drained", ms: 1200, held: 2, left: 1 })), { event: "runner_drained", runner: "r1", ms: "1200", held: "2", left: "1" });
  for (const event of [{ type: "started", runId: "run-1", agent: "a", kind: "agentic" }, { type: "released", runId: "run-1", epoch: 3, end: "ended" }, { type: "error", step: "poll", message: "x" }]) {
    assert.equal(metricLine("r1", event), undefined, `${event.type} has no metric line`);
  }
  assert.deepEqual(fieldsOf(gaugeLine("r1", 2, 25, 300 * 1024 * 1024)), { event: "runner_gauge", runner: "r1", active: "2", slots: "25", rss_mib: "300" });
  assert.match(gaugeLine("r1", 0, 1, 0), /^at=\d{4}-\d\d-\d\dT[\d:.]+Z event=runner_gauge /);
});

test("the gauge says its line on its interval until stopped", async () => {
  const lines = [];
  let held = 1;
  const gauge = startRunnerGauge({ runner: "r1", held: () => held, slots: 3, write: (line) => lines.push(line), everyMs: 10, rssBytes: () => 64 * 1024 * 1024 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  held = 2;
  await new Promise((resolve) => setTimeout(resolve, 25));
  gauge.stop();
  const said = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lines.length, said, "nothing after stop()");
  assert.ok(said >= 2, `said ${said} lines`);
  assert.deepEqual(fieldsOf(lines[0]), { event: "runner_gauge", runner: "r1", active: "1", slots: "3", rss_mib: "64" });
  assert.equal(fieldsOf(lines.at(-1)).active, "2");
});

test("a runner beside a server says a lost claim's metric line as well as its trouble line, and each other event's metric beside its own line", async () => {
  const { besideLines } = await import("../dist/runner/beside.js");
  const { troubleLine } = await import("../dist/runner/main.js");
  const { runLine } = await import("../dist/print.js");
  const say = { metricLine, troubleLine, runLine };
  const lost = besideLines("r1", { type: "claim-lost", runId: "run-1", epoch: 2, why: "fenced" }, say);
  assert.deepEqual(lost.map(({ line, error }) => [fieldsOf(line).event ?? line, error]), [["runner_hand_back", false], ["Runner r1 lost its claim on run-1 (fenced)", false]]);
  assert.equal(fieldsOf(lost[0].line).cause, "claim_lost");
  const claimed = besideLines("r1", { type: "claimed", claim: { runId: "run-1", runner: "r1", epoch: 1, until: 0, from: "queued" } }, say);
  assert.deepEqual(claimed.map(({ line }) => fieldsOf(line).event), ["runner_claimed"]);
  const started = besideLines("r1", { type: "started", runId: "run-1", agent: "a", kind: "agentic" }, say);
  assert.deepEqual(started.map(({ line }) => fieldsOf(line).event), ["run_started"]);
  const failed = besideLines("r1", { type: "error", step: "poll", message: "down" }, say);
  assert.deepEqual(failed, [{ line: "Runner r1: poll: down", error: true }]);
});
