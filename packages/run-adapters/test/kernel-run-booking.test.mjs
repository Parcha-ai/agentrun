// The run's one booking: every session of a run (each CLI session key, pi's own once it is an adapter) is judged on the
// run's totals, never its own. runBooking(sessions, before) gives a session's beforeRequest the spend and the requests in
// flight of every session of the run, read from their runner records, plus what it has admitted and not yet seen recorded.
// The priced tools' charges and holds stay the host's spentUsd and heldUsd hooks.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as kernel from "@parcha/agentrun-kernel";
const { modelPortFor } = kernel;
/** Read at each call, so a kernel without it fails each test at its own first call, never the file's import. */
const runBooking = (...args) => kernel.runBooking(...args);
import { fauxAdapter, memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { beforeRequestOf } from "../dist/kernel/cap/index.js";
import { SONNET, T0 } from "./kernel-cap-support.mjs";

/** 150,000 input tokens of Sonnet: $0.45 uncached, and the least answer's 1,024 tokens $0.01536 more. */
const BIG = { inputTokensMax: 150_000, outputTokensAsked: 1_024, outputTokensLeast: 1_024 };
const capOf = (capUsd) => beforeRequestOf({ capUsd: () => capUsd, modelOf: () => SONNET, now: () => T0 });

/** One session `key` of the run whose sessions are `store`, its requests asked through `before`, running `script`. */
async function session(store, key, before, script) {
  const spec = { key, label: key, system: ["Answer."], tools: [], context: "fresh" };
  const writer = await store.open(key);
  const tickets = [];
  const booking = await modelPortFor(writer, { key, beforeRequest: async (r) => {
    const answer = await before(r);
    tickets.push(answer);
    return answer;
  } });
  const adapter = fauxAdapter({ script: () => script });
  const opened = await adapter.open(spec, { store, writer, models: booking.models, signal: new AbortController().signal, onEvent: () => {} });
  await opened.send("go");
  const end = await opened.turnEnd();
  await opened.close();
  return { end, tickets, adapter, spentUsd: booking.spentUsd() };
}

test("two sessions of one run under a $1 cap: the first spends $0.60, and the second, which fits $1 alone but not the $0.40 left, is refused", async () => {
  const store = memorySessionStore();
  const before = runBooking(store, capOf(1));
  const first = await session(store, "s1", before, [{ say: "done", usd: 0.6, ...BIG }, { end: true }]);
  assert.equal(first.tickets[0].refuse, undefined, "the first is admitted");
  // $0.60, and the faux harness's closing request's $0.001.
  assert.ok(first.spentUsd >= 0.6 && first.spentUsd < 0.605, `the first session spent $0.60: ${first.spentUsd}`);
  const second = await session(store, "s2", before, [{ say: "never sent", usd: 0.6, ...BIG }, { end: true }]);
  assert.match(second.tickets[0].refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: this run has spent \$0\.60 of its \$1 cap/, JSON.stringify(second.tickets[0]));
  assert.equal(second.adapter.requests, 0, "the second session's request was never sent");
  assert.equal(second.end.status, "failed");
});

test("one session alone gets the same admissions through the run's booking as on its own", async () => {
  const script = [{ say: "one", usd: 0.2, ...BIG }, { say: "two", usd: 0.2, ...BIG }, { end: true }];
  const alone = await session(memorySessionStore(), "s1", capOf(1), script);
  const store = memorySessionStore();
  const run = await session(store, "s1", runBooking(store, capOf(1)), script);
  assert.deepEqual(run.tickets.map((t) => [t.refuse, t.outputTokensMax, t.holdUsd]), alone.tickets.map((t) => [t.refuse, t.outputTokensMax, t.holdUsd]));
  assert.equal(run.spentUsd, alone.spentUsd);
});

test("a request one session has admitted, not yet recorded, holds against another session's: two admissions side by side never both take the room only one fits", async () => {
  // Nothing is ever recorded here: each admission is held by the run's booking itself until its record shows.
  const store = memorySessionStore();
  const before = runBooking(store, capOf(1));
  const ask = (key) => ({ key, label: key, model: SONNET.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], ...BIG });
  const [one, two] = await Promise.all([before(ask("s1")), before(ask("s2"))]);
  const refused = [one, two].filter((answer) => answer && "refuse" in answer);
  assert.equal(refused.length, 1, `one of the two is refused: ${JSON.stringify([one, two])}`);
});

test("a session the run left in an earlier process still counts: its records' spend is the run's", async () => {
  const store = memorySessionStore();
  // An earlier claim's session: answered at $0.60, never opened again in this process.
  const earlier = await store.open("s-earlier");
  await earlier.append([{ kind: "runner.request", data: { turn: 1, model: SONNET.id, heldUsd: 0.9 } }, { kind: "runner.turn", data: { turn: 1, usd: 0.6, bookedUsd: 0.6 } }]);
  const second = await session(store, "s2", runBooking(store, capOf(1)), [{ say: "never sent", usd: 0.6, ...BIG }, { end: true }]);
  assert.match(second.tickets[0].refuse ?? "", /this run has spent \$0\.60 of its \$1 cap/);
});
