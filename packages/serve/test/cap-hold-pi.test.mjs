// pi on GPT-6.1 Sol through OpenRouter under a $1.50 cap, at Sol's list price (pi-ai's openrouter table: $2 input, $10
// output, $2.50 a cache write, $0.10 a cache read, a million tokens; past 272,000 input tokens every rate of the request
// doubles, output to $15). pi-ai lists that model on chat completions, so pi's session speaks Messages to serve's
// translation (model-route.ts messagesFetch): its proxy's upstream is no provider that counts a body, so the cap bounds
// each request's input by what it can state. Its bytes are a bound (a token covers at least a byte), and four times what
// English text bills: a run that has read a few long pages sends a body past 272,000 bytes while it bills some 75,000
// tokens, and on its bytes alone the request's least step is priced at the long-context rate, more than the cap has left.
// Sol's tokenizer is o200k_base, so the body is counted locally with the stated margin (local-count.ts), as a Responses
// request to a gateway is: a true bound, at a quarter of the bytes, and the run goes on.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { closeOpenSessions, hostTools } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, specCap } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
after(closeOpenSessions);

const CAP = 1.5;
/** GPT-6.1 Sol as OpenRouter names it, the model a run on an OpenRouter key gets on pi. */
const SOL = "openai/gpt-6.1-sol";
/** Sol as the cap prices it, from pi-ai's openrouter table: its rates, its long-context tier and its 128,000-token
 *  output ceiling. */
const SOL_CAP = Object.freeze({ id: SOL, api: "anthropic-messages", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }, outputCeiling: 128_000, reasoning: true });
/** What the provider bills a usage at Sol's list price, below its long-context tier (every request here is). */
const price = (_model, usage) => ((usage.input ?? 0) * 2 + (usage.cacheWrite ?? 0) * 2.5 + (usage.cacheRead ?? 0) * 0.1 + (usage.output ?? 0) * 10) / 1e6;
/** A long page as a fetch returns it: some 300 KB of English, which o200k_base reads as some 60,000 tokens. */
const PAGE = "Each party's total liability under these terms will not exceed the fees paid in the three months before the claim.\n".repeat(2_600);

const BILLED_AFTER_PAGE = 58_000;

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** Step 0 calls read (billed $0.10: 45,000 input tokens and 1,000 output); step 1 answers, billed for the page's tokens
 *  (58,000, under the body's o200k_base count without its margin). */
function answer(body, step, usage) {
  const block = step === 0
    ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_0", name: "read", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }]
    : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }];
  return sse([
    { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
    ...block,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: step === 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ]);
}
/** The translation's upstream as the proxy sees it: no count of its own, step 0 calls read, step 1 answers. */
function origin(sent) {
  return async (url, init = {}) => {
    if (String(url).includes("count_tokens")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push({ body, bytes: Buffer.byteLength(String(init.body ?? ""), "utf8") });
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    return step === 0 ? answer(body, 0, { input_tokens: 45_000, output_tokens: 1_000 }) : answer(body, step, { input_tokens: BILLED_AFTER_PAGE, output_tokens: 200 });
  };
}

const read = { name: "read", replaySafe: true, ask: false, run: async () => PAGE };
const specOf = (fetch) => (_claim, run) => ({
  // The translation's origin: not Anthropic's, so the proxy asks no provider to count a body.
  adapter: piAdapter({ run, model: SOL, provider: { api: "anthropic-messages", origin: "https://model-route.invalid", credential: () => "model-route" }, fetch, price }),
  session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools({ read }), context: "fresh" },
  input: "Follow the script.",
  hooks: quiet,
  gate: () => "allow",
});

/** The run's spend as its records count it, every session summed. */
async function spentOf(store) {
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

test("pi on GPT-6.1 Sol through OpenRouter at $1.50, $0.10 spent: a request whose body is past 272,000 bytes after a long page is admitted on its local count and answers, never past the cap", { timeout: 60_000 }, async (t) => {
  const sent = [];
  const { row, asked, store } = await capRun(t, { specOf: () => specOf(origin(sent)), cap: specCap(CAP), runCap: { capUsd: () => CAP, modelOf: () => SOL_CAP }, ms: 40_000 });
  const spent = await spentOf(store);
  t.diagnostic(`${row.state}: spent $${spent.toFixed(4)}; bodies ${JSON.stringify(sent.map((one) => one.bytes))}`);
  t.diagnostic(`asked: ${JSON.stringify(asked.map((one) => ({ inputTokensMax: one.request?.inputTokensMax, answer: one.answer && ("refuse" in one.answer ? { refuse: one.answer.refuse } : { holdUsd: Number(one.answer.holdUsd?.toFixed(4)), outputTokensMax: one.answer.outputTokensMax }) })))}`);
  // The first request read the page; the second carries it, past the long-context tier on its bytes.
  assert.equal(sent.length >= 1, true, "the first request was sent");
  const refusals = asked.filter((one) => one.answer && "refuse" in one.answer).map((one) => one.answer.refuse);
  assert.deepEqual(refusals, [], "no request refused: the one after the page is bounded by its count, not its bytes");
  assert.equal(sent.length, 2, "the request after the page was sent");
  assert.ok(sent[1].bytes > 272_000, `the request after the page is ${sent[1].bytes} bytes: past Sol's 272,000-token tier on its bytes`);
  // Its bound is its count, never under what it was billed: a true bound, a quarter of its bytes.
  const bound = asked[1].request.inputTokensMax;
  assert.ok(bound >= BILLED_AFTER_PAGE && bound * 4 < sent[1].bytes, `bounded at ${bound} tokens: at least the ${BILLED_AFTER_PAGE} billed, under a quarter of ${sent[1].bytes} bytes`);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(spent <= CAP + 1e-12, `the run's records count $${spent} on a $${CAP} cap`);
});
