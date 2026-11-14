// A pi run on a priced gateway model (claude-opus-5-5 through serve's OpenAI Responses gateway, AGENT_MODEL_BASE_URL) is
// priced whatever the gateway's JSON looks like. The session's model proxy keeps only the first and last 64 KiB of an
// answer, and a long answer's terminal event (`response.completed`, which carries the whole response) is longer than that,
// so its usage is read from the event's kept end. A Python gateway (LiteLLM's `json.dumps`) writes `"usage": {`, with a
// space; pi-ai parses the event whatever its spacing and counts the tokens, so the run's cost must be known too, never
// "unknown" with its tokens on the record (a smoke on main: 2 of 40 such runs booked no cost, 0 unmetered).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { runModels } from "../dist/model.js";
import { agent, follow, serve, withEnv } from "./support.mjs";

/** `value` as JSON with Python's `json.dumps` spacing: `", "` between items and `": "` after a key. */
const spaced = (value) => {
  if (Array.isArray(value)) return `[${value.map(spaced).join(", ")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${spaced(v)}`).join(", ")}}`;
  return JSON.stringify(value);
};

/** A Responses gateway that answers every request with `text`, its events written by `write` (compact or `spaced`),
 *  in LiteLLM's field order: the response's `output`, then its `tools`, then its `usage`, then `user` and `store`. */
async function gateway(t, text, usage, write) {
  const models = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      models.push(body?.model);
      const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const counts = { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      const response = (status, output, used) => ({ id: "resp_1", created_at: 1, object: "response", model: body?.model, output, status, tools: body?.tools ?? [], usage: used, user: null, store: false });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: response("in_progress", [], null) },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: response("completed", [item], counts) },
      ]) res.write(`data: ${write(event)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, models };
}

const MODEL = "claude-opus-5-5";
const USAGE = { input: 3_000, output: 25_000 };
/** An answer whose terminal event is longer than the proxy's 64 KiB window. */
const LONG = "The long answer. ".repeat(6_000);

test("a pi run on a priced gateway model is priced at the sum of its turns, whatever the gateway's JSON spacing and however long its answer", async (t) => {
  const { models, byTier } = await runModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: MODEL }, undefined, ["default"]);
  const ref = byTier.get("default");
  const price = models.getModel(ref.provider, ref.modelId).cost;
  assert.ok(price.input > 0 && price.output > 0, `the catalog prices ${MODEL} on the gateway: ${JSON.stringify(price)}`);
  // One request, so the sum of its turns is its own cost: its tokens at the model's price.
  const expected = (USAGE.input * price.input + USAGE.output * price.output) / 1e6;
  assert.ok(LONG.length > 64 * 1024 + 1024);
  for (const [name, text, write] of [["short, compact", "Forty-two.", JSON.stringify], ["short, spaced", "Forty-two.", spaced], ["long, compact", LONG, JSON.stringify], ["long, spaced", LONG, spaced]]) {
    await t.test(name, async (t) => {
      const broker = await gateway(t, text, USAGE, write);
      withEnv(t, { AGENT_MODEL_BASE_URL: `${broker.url}/v1`, AGENT_MODEL: MODEL, AGENT_MODEL_API_KEY: "not-a-secret" }, ["AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG"]);
      const { api } = await serve(t, { faux: undefined });
      assert.equal((await api("POST", "/agents", agent("long"))).status, 201);
      const started = await api("POST", "/agents/long/runs", { input: { content: "Write it out." } });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      await follow(api, started.body.run_id, ["completed", "failed"]);
      const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
      assert.deepEqual(broker.models, [MODEL], "one request, on the host's model");
      assert.equal(run.status, "completed", JSON.stringify(run.error));
      assert.notEqual(run.cost.usd, null, `the run's cost is known: ${JSON.stringify(run.cost)}`);
      assert.ok(Math.abs(run.cost.usd - expected) < 1e-6, `the run's cost is its turn's: ${run.cost.usd} vs ${expected}`);
    });
  }
});
