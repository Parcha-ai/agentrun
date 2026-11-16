// A provider's error inside a 200 stream, through the API: a pi run on Anthropic's Messages (a gateway's, here a faux one
// behind a front that fails the run's first request) whose first answer the provider ends in its `error` event.
// Anthropic answers 200 before the model's first token, so an overload (or a rate limit, or a failure) met after that comes
// inside the stream, after `message_start` has reported the request's input tokens. One rule books every such end:
// - tokens reported before the error (message_start's input, any output a message_delta said): those at list, a known
//   figure, never the cap's hold, and the run's cost stays known;
// - no token reported (the error is the stream's first event): refused at $0, in the provider's words.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { runModels } from "../dist/model.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, journalOf, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"gateway"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const MODEL = "claude-opus-5-5";
const INPUT = 1_000;
const OUTPUT = 40;

const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = (output) => event("message_start", { message: { id: "msg_err", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: INPUT, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const failure = (type, message) => event("error", { error: { type, message } });
/** Each stream the front answers the run's first request with. */
const STREAMS = {
  "after message_start": start(1) + failure("overloaded_error", "Overloaded"),
  "after content and an output count": start(1)
    + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } })
    + event("message_delta", { delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: OUTPUT } })
    + failure("api_error", "Internal server error"),
  "as the first event": failure("overloaded_error", "Overloaded"),
};

/** A front for `upstream` that answers its first POST with `stream` (a 200), and passes every other request on. */
async function front(upstream, stream) {
  let posts = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && ++posts === 1) return void res.writeHead(200, { "content-type": "text/event-stream" }).end(stream);
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(upstream).host } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

test("a provider's error inside a 200 stream is booked by what it reported: its tokens at list, else refused at $0; the run's cost stays known", { timeout: 300_000 }, async (t) => {
  const { models, byTier } = await runModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: MODEL }, undefined, ["default"]);
  const ref = byTier.get("default");
  const price = models.getModel(ref.provider, ref.modelId).cost;
  assert.ok(price.input > 0 && price.output > 0, `the catalog prices ${MODEL} on the gateway: ${JSON.stringify(price)}`);
  const expected = {
    "after message_start": { usd: (INPUT * price.input + 1 * price.output) / 1e6, rule: "answered:error", words: "Overloaded" },
    "after content and an output count": { usd: (INPUT * price.input + OUTPUT * price.output) / 1e6, rule: "answered:error", words: "Internal server error" },
    "as the first event": { usd: 0, rule: "nothing:refused", words: "Overloaded" },
  };
  for (const [name, stream] of Object.entries(STREAMS)) {
    await t.test(name, async (t) => {
      const gw = await startFauxGateway({ usage: { input: 10, output: 2 } });
      t.after(() => gw.close());
      const fr = await front(gw.url, stream);
      t.after(() => fr.close());
      withEnv(t, { AGENT_MODEL_BASE_URL: `${fr.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: MODEL }, NAMES);
      const { api, data } = await serve(t, { faux: undefined });
      assert.equal((await api("POST", "/agents", agent("err"))).status, 201);
      const started = await api("POST", "/agents/err/runs", { input: { content: "Say hi." }, max_cost_usd: 5 });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const runId = started.body.run_id;
      await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
      const turns = journalOf(data, runId).filter((e) => e.kind === "runner.turn").map((e) => e.data);
      const first = turns.find((turn) => turn.rule === expected[name].rule);
      assert.ok(first, `the errored request's booking: ${JSON.stringify(turns)}`);
      assert.ok(Math.abs(first.bookedUsd - expected[name].usd) < 1e-12, `booked ${first.bookedUsd}, expected ${expected[name].usd}: ${JSON.stringify(first)}`);
      assert.ok(Math.abs(first.usd - expected[name].usd) < 1e-12, `its own figure, never unknown: ${JSON.stringify(first)}`);
      if (expected[name].rule === "nothing:refused") assert.equal(first.refusal, expected[name].words, "in the provider's words");
      else assert.equal(first.providerError, expected[name].words, "the provider's words on the record");
      const run = (await api("GET", `/runs/${runId}`)).body;
      assert.equal(typeof run.cost.usd, "number", `the run's cost is known: ${JSON.stringify(run.cost)}`);
      assert.ok(run.cost.usd >= expected[name].usd - 1e-12, `the run's cost counts it: ${JSON.stringify(run.cost)}`);
    });
  }
});
