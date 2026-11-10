// pi through the adapter under a cap, a cache miss: a request the cap admitted at its expected cost (the session's previous
// request warm in the cache) comes back a miss, all of its input uncached. Its real cost is booked, past the cap by no
// more than the bound it was sent with (its input at full price); the run's next request is refused for room, so the run
// parks with what it spent; and the run's records, read again, say the same spend.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, capRun, quiet, rootEntries, SONNET, specCap } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
after(closeOpenSessions);

const CAP = 0.03;
const ROOM = "spend_cap_reached (out of budget): ";
/** A stub price on the faux model, in this test only: uncached input at Sonnet's cache-write rate, output at its rate. */
const price = (_model, usage) => (usage.input * 3.75 + usage.output * 15) / 1e6;
/** The session's previous request, warm a moment ago: 1,000 tokens cached. */
const WARM = { model: MODEL, cachedTokens: 1_000, inputTokens: 0, boundTokens: 1_000, endedAt: Date.now() };

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** An origin that misses the cache: each request's input all uncached (its body's bytes, never more than its bound) and
 *  its whole output limit. Step 0 calls the read tool; any later step answers. */
function missOrigin(sent) {
  return async (_url, init = {}) => {
    const text = String(init.body ?? "{}");
    const body = JSON.parse(text);
    sent.push(body);
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    const usage = { input_tokens: Buffer.byteLength(text, "utf8"), output_tokens: body.max_tokens ?? 10, cache_read_input_tokens: 0 };
    const start = { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: 0 } } };
    const block = step === 0
      ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_0", name: "read", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }]
      : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }];
    return sse([start, ...block, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: step === 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }, { type: "message_stop" }]);
  };
}

/** The run's spend from its records, every session summed: what a reopened run reads. */
async function spendFromRecords(store) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    let spent = 0;
    for (const key of await sessions.keys()) spent += sessionSpendOf(await sessions.read(key)).spentUsd;
    return spent;
  } finally {
    await harness.close(ctx);
  }
}

test("a cache miss on a request admitted at its expected cost books its real cost past the cap by no more than its bound; the next request is refused for room and the run parks with that spend, as its records read again say", async (t) => {
  const read = { name: "read", replaySafe: true, ask: false, run: async () => "read" };
  const specOf = (sent) => (_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: missOrigin(sent), price }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools({ read }), context: "fresh" },
    input: "Follow the script.",
    hooks: quiet,
    gate: () => "allow",
  });
  const { row, asked, store } = await capRun(t, { specOf, cap: specCap(CAP), runCap: ({ capUsd: () => CAP, modelOf: () => SONNET, previousOf: () => WARM }) });
  const first = asked[0];
  assert.equal(first?.answer?.refuse, undefined, `the first request is admitted: ${JSON.stringify(first?.answer)}`);
  const second = asked.find((a, i) => i > 0 && a.answer?.refuse);
  assert.ok(second?.answer.refuse.startsWith(ROOM), `a later request is refused for room: ${JSON.stringify(asked.map((a) => a.answer))}`);
  const spent = await spendFromRecords(store);
  const bound = first.request.inputTokensMax * 3.75 / 1e6;
  assert.ok(spent > CAP, `the miss passed the cap: spent ${spent} of ${CAP}`);
  assert.ok(spent - first.answer.holdUsd <= bound + 1e-12, `by no more than its bound: booked ${spent}, held ${first.answer.holdUsd}, bound ${bound}`);
  assert.equal(row.state, "parked", JSON.stringify(row));
  const [budget] = await rootEntries(store, "agentrun.budget");
  assert.equal(budget?.pending?.spent_usd, Math.round(spent * 1e6) / 1e6, "the park says what the records say was spent");
  // The most a cache miss could add to the refused step: the refusal's boundUsd, to a millionth rounded up, as main's
  // overshoot bound is (the budget card shows it).
  const boundUsd = second.answer.figures?.boundUsd;
  assert.ok(typeof boundUsd === "number" && boundUsd > 0, `the refused step had a bound: ${JSON.stringify(second.answer.figures)}`);
  assert.equal(budget?.pending?.bound_usd, Math.ceil(boundUsd * 1e6 - 1e-9) / 1e6, `the budget entry names the refused step's bound: ${JSON.stringify(budget?.pending)}`);
});
