// pi's client waits on its session proxy as long as the proxy's own stall bound when the proxy was given one (a model on
// the host's own machine: 30 minutes), not the transport's. Node's fetch gives up after 5 minutes with no headers or no
// piece of a body, as "terminated: Body Timeout Error", which pi asks again on: a local model that took longer than that
// to load or to read a long prompt was cut and retried while the proxy still waited on it, and its bound never ended it.
// Here the transport's cut is short (Node fetch's own dispatcher, TRANSPORT_MS), the proxy's bound long (STALL_MS), and
// the provider pauses between the two before it answers: pi's run takes the answer from its one request.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, rootEntries, sleep } from "./adapter-pi-cap-support.mjs";
import { timelineOf } from "../dist/timeline/index.js";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
after(closeOpenSessions);

/** Node fetch's own wait for headers and between two pieces of a body, in this test (5 minutes by default). */
const TRANSPORT_MS = 500;
/** The provider's pause: past the transport's wait, well within the proxy's bound. */
const PAUSE_MS = 2_000;
/** The session proxy's stall bound for these runs (a local model's is 30 minutes). */
const STALL_MS = 20_000;
/** How long a run is given to end before the case reads it as still running: past one answer, short of pi's retries. */
const ENDS_WITHIN_MS = 30_000;

const transport = getGlobalDispatcher();
before(() => setGlobalDispatcher(new Agent({ headersTimeout: TRANSPORT_MS, bodyTimeout: TRANSPORT_MS })));
after(() => setGlobalDispatcher(transport));

const sse = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const START = sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } });
const REST = [
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
  sse("message_stop", { type: "message_stop" }),
].join("");

/** A provider that pauses PAUSE_MS, `headers` true after its 200 and first event, false before its headers, then
 *  answers "hi". */
const slow = (headers, sent) => async (_url, init = {}) => {
  sent.push(JSON.parse(String(init.body ?? "{}")));
  if (!headers) await sleep(PAUSE_MS);
  return new Response(new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(START));
      if (headers) await sleep(PAUSE_MS);
      controller.enqueue(encoder.encode(REST));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

for (const [how, headers] of [["after its headers and first event", true], ["before its headers", false]]) {
  test(`a provider that pauses ${how} past the transport's wait, within the proxy's bound: pi takes its answer from one request`, async (t) => {
    const sent = [];
    const { row, store } = await capRun(t, {
      specOf: () => (_claim, run) => ({
        adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: slow(headers, sent), price: () => 0, stallMs: STALL_MS }),
        session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh" },
        input: "Say hi.",
        hooks: quiet,
        gate: () => "allow",
      }),
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      ms: ENDS_WITHIN_MS,
    });
    const rows = timelineOf(await rootEntries(store), { settled: true });
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, rows: rows.map((r) => [r.kind, r.summary]) })}`);
    assert.deepEqual(rows.filter((r) => r.kind === "error").map((r) => r.summary), [], "no request was cut");
    assert.equal(sent.length, 1, "one request: none asked again");
    assert.deepEqual(rows.filter((r) => r.kind === "final_answer").map((r) => r.summary), ["hi"], "the provider's answer");
  });
}
