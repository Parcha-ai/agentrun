// A run's first request after a new claim (an approval, a deny, a raise: each ends the claim that parked) is priced from
// the session's previous request as the claim before it left it, by when that request ended on the cap's clock: warm
// under CACHE_WARM_MS (4 minutes), its cache read at the cache-read price and only what the body grew by at full price;
// cold after it, its whole bound uncached. Never cold only because the claim is new. Through the adapter loop on a real
// store, pi on a scripted origin, the cap's clock a test's: one call the gate asks about, answered after 1 or 5 minutes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cap, quiet, sleep, STEADY } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

/** Sonnet 5.5's prices: input $2, output $10, a cache read $0.10 and a cache write $2.50 a million tokens. */
const PRICED = Object.freeze({ id: "claude-sonnet-5-5", api: "anthropic-messages", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 8_192 });
/** What the scripted origin reports for each request: 100 input tokens, none read from or written to the cache. */
const REPORTED_INPUT = 100;
const T0 = Date.parse("2026-11-14T06:00:00Z");

/** One pi run whose first request calls `noop`, which the gate asks about: parked, answered `decision` once the cap's
 *  clock has moved `waitMs`, then its answer on the claim that answer opens. Each request the cap judged, in order. */
async function answeredAfter(t, decision, waitMs) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-adapter-resume-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Resume" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const script = [{ call: "noop" }, { say: "done" }];
  const noop = { name: "noop", replaySafe: true, ask: true, run: async () => "ok" };
  const spec = piAdapterSpec({ script, tools: { noop }, hooks: quiet }, { fetch: scriptedOrigin(script, []) });
  const clock = { now: T0 };
  const asked = [];
  const loop = createAdapterLoop(async (claim, run) => ({
    ...(await spec(claim, run)),
    runCap: { capUsd: () => 10, modelOf: () => PRICED, now: () => clock.now, judged: (request, answer) => void asked.push({ request, answer }) },
  }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...STEADY });
  const settled = async (state) => {
    for (const until = Date.now() + 20_000; ; await sleep(20)) {
      const row = await server.runs.get("run-1");
      if (row.state === state && row.runner === null) return row;
      if (Date.now() > until) throw new Error(`not ${state}: ${JSON.stringify(row)}`);
    }
  };
  const parked = await settled("parked");
  // The ask's call id, read from the journal as a reader (the journal's ask entry): the approve or deny names it.
  const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), BACKGROUND_CONTEXT)).entries;
  const ask = entries.find((entry) => entry.kind === "agentrun.ask")?.data;
  assert.ok(ask?.callId, "the call's ask");
  clock.now += waitMs;
  await sendCommand(server, "run-1", decision === "allow" ? { kind: "approve", body: { approval: ask.callId } } : { kind: "deny", body: { approval: ask.callId, note: "Not now." } });
  await settled("ended");
  const own = asked.filter((one) => one.request.host === undefined && !one.request.side);
  assert.equal(own.length, 2, `two requests judged, one a claim: ${JSON.stringify(own.map((one) => one.request))}`);
  for (const one of own) assert.ok(typeof one.answer?.holdUsd === "number", `admitted: ${JSON.stringify(one.answer)}`);
  return own;
}

/** Every token of `request` uncached, and its output limit: its hold with no previous request. */
const whole = (request) => (request.inputTokensMax * 2.5 + Math.min(request.outputTokensAsked ?? Infinity, 8_192) * 10) / 1e6;

for (const decision of ["allow", "deny"]) {
  test(`${decision}, answered a minute after the request before it ended: the new claim's first request is priced warm from it`, async (t) => {
    const [first, second] = await answeredAfter(t, decision, 60_000);
    // The previous request reported 100 tokens of input and read nothing from the cache: the second's input is those 100
    // and what the body grew by since, so the first's bound less 100, at $2.50 a million, comes off its whole bound's hold.
    const less = ((first.request.inputTokensMax - REPORTED_INPUT) * 2.5) / 1e6;
    assert.ok(less > 0, `${first.request.inputTokensMax}`);
    assert.ok(Math.abs(whole(second.request) - second.answer.holdUsd - less) < 1e-9, `warm: held $${second.answer.holdUsd}, cold $${whole(second.request)}, $${less} less expected`);
  });

  test(`${decision}, answered five minutes after the request before it ended: the cache is gone, the new claim's first request is priced cold`, async (t) => {
    const [, second] = await answeredAfter(t, decision, 5 * 60_000);
    assert.ok(Math.abs(second.answer.holdUsd - whole(second.request)) < 1e-9, `cold: held $${second.answer.holdUsd}, its whole bound $${whole(second.request)}`);
  });
}

test("the previous request is kept on the session as the cap's figures, and a record that does not read as one prices cold", async () => {
  const { previousIn } = await import("../dist/runner/adapter-loop.js");
  const kept = { model: PRICED.id, cachedTokens: 0, inputTokens: 100, boundTokens: 4_000, endedAt: T0 };
  const record = (data) => ({ kind: "agentrun.cap.previous", data });
  assert.deepEqual(previousIn([record(kept)]), kept);
  assert.deepEqual(previousIn([record({ ...kept, boundTokens: 1 }), record(kept)]), kept, "the newest");
  assert.equal(previousIn([record(kept), record(null)]), undefined, "history reset");
  for (const bad of [{ ...kept, cachedTokens: -1 }, { ...kept, endedAt: Number.NaN }, { ...kept, model: 7 }, "x"]) assert.equal(previousIn([record(bad)]), undefined, JSON.stringify(bad));
  assert.equal(previousIn([]), undefined);
  assert.equal(cap.CACHE_WARM_MS, 4 * 60_000, "the window these cases straddle");
});
