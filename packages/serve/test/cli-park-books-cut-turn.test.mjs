// A CLI turn cut by a park (codex, opencode): the model's answer names a host tool the gate asks a person about, the
// bridge holds the call and the run parks while the provider still holds that answer's stream open (its usage already
// sent). The park must not close the session under it: the answer's booking lands, at the usage the provider reported,
// before the claim is let go. Before, the session closed first, the booking threw ("Session is closed"), and the next claim
// booked the turn cut at an unknown price: a run whose cost read `unpriced`.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { observed, queue, recorder, release, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import * as codex from "./conformance-codex.mjs";
import * as opencode from "./conformance-opencode.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

after(codex.closeOpenSessions);
after(opencode.closeOpenSessions);

const STEADY = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** Each answer's price: the provider's usage read, priced at a figure of its own. */
const PER_ANSWER = 0.0125;

/** `fetch` whose first answer streams every event, its completion with the provider's usage among them, and holds the
 *  stream open until `hold` resolves, as a provider may: the CLI goes on at the completion event and runs the answer's
 *  call, while the session's proxy still reads the stream to its end before it books the answer. */
function endHeld(fetch, hold) {
  let first = true;
  return async (url, init) => {
    const answer = await fetch(url, init);
    if (!first) return answer;
    first = false;
    const body = await answer.text();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        await hold;
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

/** Every booking record of the run's sessions, and the run's spend as a reopened run reads it. */
async function bookings(store) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    const turns = [];
    let spent = 0;
    for (const key of await sessions.keys()) {
      const records = await sessions.read(key);
      turns.push(...records.filter((record) => record.kind === "runner.turn").map((record) => record.data));
      const read = sessionSpendOf(records);
      spent = spent === null || read.spentUsd === null ? null : spent + read.spentUsd;
    }
    return { turns, spent };
  } finally {
    await harness.close(ctx);
  }
}

for (const [name, subject, specOf] of [["codex", codex, codex.codexSpec], ["opencode", opencode, opencode.openCodeSpec]]) {
  test(`${name}: a turn cut by a park books the usage its provider reported, and the run's spend is its turns' sum`, async (t) => {
    const opened = await stores({ runners: 1 });
    await queue(opened.server, "run-1");
    const { tools, ran } = suiteTools();
    const script = [{ call: "asked" }, { say: "done" }];
    let letGo = () => {};
    const hold = new Promise((resolve) => (letGo = resolve));
    const spec = specOf({ script, tools, hooks: quiet }, { fetch: endHeld(subject.scriptedResponses(script), hold), price: () => PER_ANSWER });
    const createLoop = createAdapterLoop(spec, { restartLimit: MAX_RESTARTS });
    const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
    t.after(async () => {
      letGo();
      await runner.close();
      await release(opened);
    });
    const row = () => opened.server.runs.get("run-1");
    // The run parks on the ask while the answer that made the call is still streaming; then its last event comes.
    await until(async () => (await row()).state === "parked", "the run parked on its ask", 15_000);
    letGo();
    await until(async () => {
      const now = await row();
      return now.state === "parked" && now.runner === null;
    }, "the parked run released", 15_000);
    const parked = await bookings(opened.server);
    assert.deepEqual(parked.turns.map((turn) => [turn.turn, turn.usd, turn.cut ?? false]), [[1, PER_ANSWER, false]], `the cut turn is booked at its price before the claim goes: ${JSON.stringify(parked.turns)}`);
    // Allowed, the run resumes, runs the call once and answers.
    await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: "call_0" } });
    await until(async () => {
      const now = await row();
      return now.state === "ended" && now.runner === null;
    }, "the run ended", 15_000);
    assert.equal(ran.asked, 1, "approved, it ran once");
    const ended = await bookings(opened.server);
    assert.ok(ended.turns.length >= 2, `a turn after the resume: ${JSON.stringify(ended.turns)}`);
    for (const turn of ended.turns) assert.equal(turn.usd, PER_ANSWER, `every turn booked at its price, none cut or unknown: ${JSON.stringify(ended.turns)}`);
    assert.equal(Math.round(ended.spent * 1e8), Math.round(ended.turns.length * PER_ANSWER * 1e8), "the run's spend is the sum of its turns");
  });
}
