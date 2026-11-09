// pi through the adapter under a cap, a person's stop while a request is out (main's cap-unknown.test.mjs, the pi path
// through serve's old door: "a capped pi run stopped mid-answer…" and "QA 7.4"). The stopped request's cost is unknown,
// so the run's one booking counts it at what it can have cost: its input, each UTF-8 byte it streamed as a token, and
// 1,024 tokens more (STOP_ALLOWANCE_TOKENS), never past what the cap held for it. A clamped request no longer takes
// the rest of the cap. The run's records, read again as a reopened run reads them, say the same spend.
//
// On this loop a person's stop ends the run, stopped and final (design2's run states), so main's "the run goes on" and
// "the next request is refused for room after a stop" have no next request here; the kernel's half of those rules is
// twinned in run-adapters' kernel-cap-settle tests.
//
// The order is the origin's, never a timer's: it streams its part, says so, and holds the answer open until the stop
// aborts it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { closeOpenSessions, MODEL } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, capRun, cap, quiet, specCap } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { sendCommand } = await import("../dist/runner/commands.js");
after(closeOpenSessions);

/** The faux model as the cap prices it, in this test only: free input, output at $100 a million, 16,384 at most. */
const PRICED = Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const PER_TOKEN = 100 / 1e6;
const ALLOWANCE = cap.STOP_ALLOWANCE_TOKENS;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** An origin whose first answer streams `text` (nothing when empty), resolves `streamed`, and stays open until the
 *  request is aborted. */
function stallingOrigin(sent, text, abortAfter) {
  let said = () => {};
  const streamed = new Promise((resolve) => (said = resolve));
  const fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    const encoder = new TextEncoder();
    const frame = (event) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(frame({ type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }));
        if (text) {
          controller.enqueue(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          controller.enqueue(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
        }
        // `abortAfter`: the stream ends on its abort only once that resolves (a provider slow to end it).
        const abort = async () => {
          await abortAfter?.();
          controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
        said();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, streamed };
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

/** A pi run under `capUsd`, `spentUsd` spent before it, whose first request streams `text` and is stopped by a person. */
async function stoppedRun(t, { capUsd, spentUsd = 0, text, journalOf, abortAfter }) {
  let origin;
  const specOf = (sent) => {
    origin = stallingOrigin(sent, text, abortAfter);
    return (_claim, run) => ({
      adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: origin.fetch, price: () => 0 }),
      session: { key: "root", label: "root", system: ["Follow the script."], tools: [], context: "fresh" },
      input: "Take your time.",
      hooks: quiet,
      gate: () => "allow",
    });
  };
  const result = await capRun(t, {
    specOf,
    cap: specCap(capUsd),
    ...(journalOf ? { journalOf } : {}),
    // `spentUsd` spent before: the host's priced tools (the cap's spentUsd hook), outside the model's records.
    runCap: ({ capUsd: () => capUsd, modelOf: () => PRICED, ...(spentUsd ? { spentUsd: () => spentUsd } : {}) }),
    during: async (server) => {
      await origin.streamed;
      await sendCommand(server, "run-1", { kind: "stop", body: {} });
    },
  });
  assert.equal(result.row.state, "stopped", `the person's stop ends the run: ${JSON.stringify(result.row)}`);
  assert.equal(result.sent.length, 1, "one request reached the provider");
  return { ...result, spent: eight(await spendFromRecords(result.store)) };
}

test("a request a person stops mid-answer counts what it streamed and 1,024 tokens, never what the cap held for it, as its records read again say", async (t) => {
  const { asked, spent } = await stoppedRun(t, { capUsd: 1, text: "Half of one.md" });
  const held = asked[0]?.answer?.holdUsd;
  assert.ok(held > 0.5, `the request was held at most of the cap: ${JSON.stringify(asked[0]?.answer)}`);
  assert.equal(spent, eight((14 + ALLOWANCE) * PER_TOKEN), `14 bytes streamed and 1,024 tokens: $0.1038, not the $${held} held`);
});

/** The run's end, as the loop tries to commit it: `journalOf` for capRun, and `tried`, resolved at that commit. */
function endWatch() {
  let seen;
  const tried = new Promise((resolve) => (seen = resolve));
  const journalOf = (journal) =>
    new Proxy(journal, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "commit") return typeof value === "function" ? value.bind(target) : value;
        return (batches, ...rest) => {
          if (batches.flat().some((write) => write.type === "entry" && write.value?.kind === "agentrun.end")) seen();
          return value.call(target, batches, ...rest);
        };
      },
    });
  return { journalOf, tried };
}

test("a stopped request whose upstream ends late still counts what it streamed and 1,024 tokens: the run's end waits for its booking", async (t) => {
  // The provider's stream ends on the stop's abort only once the loop tries its end (or a second at most), as on a loaded
  // machine: the session's proxy books the stop after pi went idle. Written after the end (the run's release), the
  // booking would be fenced and lost, and the request read back at its hold.
  const end = endWatch();
  const { asked, spent } = await stoppedRun(t, { capUsd: 1, text: "Half of one.md", journalOf: end.journalOf, abortAfter: () => Promise.race([end.tried, new Promise((resolve) => setTimeout(resolve, 1_000))]) });
  const held = asked[0]?.answer?.holdUsd;
  assert.equal(spent, eight((14 + ALLOWANCE) * PER_TOKEN), `the stop's booking ($0.1038) is in the records, never the $${held} held`);
});

test("a stopped request whose booking never lands is counted at its hold and bound, never nothing: the end waits its bound and is written", async (t) => {
  // The provider's stream never ends on the stop's abort, so the session's proxy never books the request: the loop's
  // wait for its bookings runs out (CLOSE_MS), the run's end is written, and the request reads back unanswered, at the
  // worst it can have cost (its hold and bound), never at nothing.
  const { row, asked, spent } = await stoppedRun(t, { capUsd: 1, text: "Half of one.md", abortAfter: () => new Promise(() => {}) });
  assert.equal(row.state, "stopped", "the run still ends, past the bound");
  const { holdUsd, boundUsd = 0 } = asked[0]?.answer ?? {};
  assert.ok(holdUsd > 0.5, `the request was held at most of the cap: ${JSON.stringify(asked[0]?.answer)}`);
  assert.equal(spent, eight(holdUsd + boundUsd), `unbooked, it counts at its hold and bound ($${holdUsd} + $${boundUsd}), never $0`);
});

test("QA 7.4: under a $1 cap with $0.004 spent, a clamped request stopped before it streamed counts 1,024 tokens, $0.1024, never the rest of the cap", async (t) => {
  const { sent, spent } = await stoppedRun(t, { capUsd: 1, spentUsd: 0.004, text: "" });
  assert.equal(sent[0].max_tokens, 9_960, "clamped to what $0.996 buys");
  assert.equal(spent, eight(1_024 * PER_TOKEN), "nothing streamed and the allowance: $0.1024");
});

test("a stopped request whose stream and allowance pass what it was held for counts at its hold, never more", async (t) => {
  const { asked, sent, spent } = await stoppedRun(t, { capUsd: 0.11, text: "x".repeat(500) });
  assert.ok(sent[0].max_tokens < 500 + ALLOWANCE, `clamped to what $0.11 buys: ${sent[0].max_tokens} tokens`);
  assert.equal(spent, eight(asked[0].answer.holdUsd), "500 bytes and 1,024 tokens pass its limit: at its hold");
});
