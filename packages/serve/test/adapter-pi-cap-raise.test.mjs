// pi through the adapter, parked at its cap (agentrun.budget), then raised: what a raise does is the kernel's rule
// (checkRaise, takeRaises, followUpOf in run-adapters/src/kernel/cap/park.ts), as on main. Raises taken together resume
// the run once, at the latest cap, with one follow-up turn in the server's words; a raise the rule refuses is refused in
// its words and the run stays parked; a raise above the cap but still short of the request's need resumes it, and the
// next request, refused at the new figures, parks it again with a fresh pending budget. Each test names the main test it
// mirrors. The run's cap after a raise is the server's to keep (E2); here a closure the test raises with the command.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, cap, quiet, rootEntries, SONNET, sleep, STEADY, TIMING } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

const CAP = 0.01;
const FOLLOW_UP = (usd) => cap.followUpOf(usd).text;

/** One pi run on the adapter loop under a cap that `raise(usd)` moves, as the server keeps a raised run's cap. The runner
 *  runs until `stopRunner()`, and a new one until the test ends: raises sent between them meet the run unclaimed. */
async function cappedRun(t, script) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-raise-"));
  const server = await openStore(dir, "server");
  const store = await openStore(dir, "runner");
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Raise" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  let capUsd = CAP;
  const sent = [];
  const spec = piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch: scriptedOrigin(script, sent) });
  // The cap's rules as E2 hands them to the loop (which imports no cap): its park, raise check and follow-up.
  const runCap = { get capUsd() { return capUsd; }, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    cap: runCap,
    beforeRequest: beforeRequestOf({ capUsd: () => capUsd, modelOf: () => SONNET }),
  }), { restartLimit: MAX_RESTARTS });
  // A lease no stall of a loaded machine outlasts: the run moves between runners here by its park's release, never by a
  // lease that ran out, and a claim lost and retaken would hand the resume to a loop these tests do not count.
  const startOne = () => runners.push(startRunner({ store, createLoop: loop, name: `runner-${runners.length}`, ...STEADY }));
  startOne();
  const settled = async (state, ms = 20_000) => {
    const from = Date.now();
    for (;;) {
      const row = await server.runs.get("run-1");
      if (row.state === state && row.runner === null) return row;
      if (Date.now() - from > ms) throw new Error(`not ${state} within ${ms} ms: ${JSON.stringify(row)}`);
      await sleep(20);
    }
  };
  /** A person's raise: the server keeps the new cap (E2) and writes the raise row. */
  const raise = async (usd, { keep = true } = {}) => {
    if (keep && usd > capUsd) capUsd = usd;
    return sendCommand(server, "run-1", { kind: "raise", body: { capUsd: usd } });
  };
  return { server, store, sent, settled, raise, stopRunner: () => runners.at(-1).close(), startOne };
}

async function openStore(dir, role) {
  const { openSqliteStore } = await import("../dist/store/index.js");
  return openSqliteStore({ dataDir: dir, role });
}

const followUpsSent = (sent, usd) => sent.filter((body) => JSON.stringify(body.messages ?? []).includes(FOLLOW_UP(usd))).length;
const commandOf = async (server, id) => (await server.commands("run-1", id - 1)).find((row) => row.id === id);

// Mirrors kernel-cap-park "a parked run raised goes on: one follow-up in the server's words, under the new cap" and
// serve cap-raise.test.mjs:53 ("a run paused at its cap, its cap raised, goes on: one follow-up turn in the server's
// words runs under the new cap and completes").
test("a run parked at its cap, raised, goes on: one follow-up turn in the server's words, under the new cap, and it ends", async (t) => {
  const w = await cappedRun(t, [{ say: "done" }]);
  await w.settled("parked");
  assert.equal(w.sent.length, 0, "the refused request never reached the provider");
  const row = await w.raise(5);
  const ended = await w.settled("ended");
  assert.equal(ended.summary, null);
  assert.equal(followUpsSent(w.sent, 5), 1, `one follow-up in the server's words: ${JSON.stringify(w.sent.map((body) => body.messages))}`);
  const taken = await commandOf(w.server, row.id);
  assert.ok(taken.takenAt !== null && taken.refused === null, `the raise row is taken, not refused: ${JSON.stringify(taken)}`);
  const raises = await rootEntries(w.store, "agentrun.raise");
  assert.deepEqual(raises.map((data) => [data.capUsd, data.takes]), [[5, [row.id]]], "one raise entry, taking its row");
});

// Mirrors kernel-cap-park "two raises before the run is claimed resume once, at the later cap" and serve
// cap-raise.test.mjs:353 ("two raises of a paused run before its let-go process is gone resume it once, at the later cap").
test("two raises of a parked run, taken together, resume it once, at the later cap", async (t) => {
  const w = await cappedRun(t, [{ say: "done" }]);
  await w.settled("parked");
  await w.stopRunner();
  const one = await w.raise(3);
  const two = await w.raise(5);
  w.startOne();
  await w.settled("ended");
  assert.equal(followUpsSent(w.sent, 5), 1, "one follow-up, at the later cap");
  assert.equal(followUpsSent(w.sent, 3), 0, "none at the earlier one");
  for (const row of [one, two]) {
    const taken = await commandOf(w.server, row.id);
    assert.ok(taken.takenAt !== null && taken.refused === null, `raise ${row.id} taken, not refused: ${JSON.stringify(taken)}`);
  }
  const raises = await rootEntries(w.store, "agentrun.raise");
  assert.deepEqual(raises.map((data) => [data.capUsd, data.takes]), [[5, [one.id, two.id]]], "one raise entry for both");
});

// Mirrors kernel-cap-park "a raise is checked: a number above the run's cap; none for a run with no cap or an ended run"
// and serve cap-raise.test.mjs:71 ("a raise is checked: only above the run's own cap…").
test("a raise not above the run's cap is refused in the rule's words, and the run stays parked", async (t) => {
  const w = await cappedRun(t, [{ say: "done" }]);
  await w.settled("parked");
  const row = await w.raise(CAP, { keep: false });
  const refused = await (async () => {
    for (const from = Date.now(); Date.now() - from < 10_000; await sleep(20)) {
      const now = await commandOf(w.server, row.id);
      if (now.takenAt !== null) return now;
    }
    return commandOf(w.server, row.id);
  })();
  assert.equal(refused.refused, cap.checkRaise({ capUsd: CAP }, CAP).refused, `refused in checkRaise's words: ${JSON.stringify(refused)}`);
  await sleep(TIMING.pollMs * 10);
  const now = await w.server.runs.get("run-1");
  assert.equal(now.state, "parked", "still parked");
  assert.equal(followUpsSent(w.sent, CAP), 0, "no follow-up");
});

// Mirrors kernel-cap-park "a parked run's next step stays refused until the cap is raised, then goes": a raise above the
// cap but short of the request's need resumes the run, and the cap refuses that request again, at the new figures.
test("a raise above the cap but short of the request's need resumes the run once, and it parks again with a fresh pending budget", async (t) => {
  const w = await cappedRun(t, [{ say: "done" }]);
  await w.settled("parked");
  const [first] = await rootEntries(w.store, "agentrun.budget");
  const short = Number(((CAP + first.pending.least_cap_usd) / 2).toFixed(6));
  assert.ok(short > CAP && short < first.pending.least_cap_usd, `a raise between the cap and the least cap: ${short}`);
  await w.raise(short);
  await sleep(TIMING.pollMs * 10);
  const again = await w.settled("parked");
  const budgets = await rootEntries(w.store, "agentrun.budget");
  assert.equal(budgets.length, 2, `parked again with a fresh budget entry: ${JSON.stringify(budgets)}`);
  assert.equal(budgets[1].pending.cap_usd, short, "at the raised cap");
  assert.equal(again.summary, budgets[1].words);
  assert.equal(w.sent.length, 0, "no request reached the provider");
});
