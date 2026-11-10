// A model key saved in Settings → Model keys runs pi on the runner with no restart: a server started with no model key
// in its environment, its runner beside it (the CLI start's server-and-runner), takes the key a person saves, and the
// next pi run's model requests carry it; a key saved again with a new value is the one the run after carries.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PROVIDER_KEYS } from "../dist/model.js";
import { agent, follow, serve, withEnv } from "./support.mjs";

/** Every model setting and key a host may hold: none reaches the server, so its only model key is the one saved. */
const MODEL_ENV = [
  ...new Set([...Object.values(PROVIDER_KEYS).flat(), "AGENT_MODEL_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL_PRICE", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "AGENT_THINKING"]),
];

/** Anthropic's Messages API on loopback: its key check (GET /v1/models) answers 200, and every message answers `text`.
 *  `keys` holds each message request's x-api-key, `models` the model it asked for. */
async function anthropicStandIn(t, text) {
  const keys = [];
  const models = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stand-in");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ type: "model", id: "claude-sonnet-5-5", display_name: "Claude", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no ${req.method} ${url.pathname}` } }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
      keys.push(req.headers["x-api-key"] ?? null);
      models.push(body.model);
      const message = { id: "msg_stand_in", type: "message", role: "assistant", model: body.model ?? "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, keys, models };
}

/** A pi run of `id` with `content`, followed to its end: its last status and answer, and the run's error if it failed. */
async function ran(api, id, content) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.ok(started.status === 201 || started.status === 202, `the run starts: ${started.status} ${JSON.stringify(started.body)}`);
  const { last } = await follow(api, started.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const read = await api("GET", `/runs/${started.body.run_id}`);
  return { status: last.status, run: read.body };
}

test("a model key saved in Settings → Model keys, with none where AgentRun starts, runs the next pi run on the runner with no restart: its model requests carry the saved key, and a key saved again is the one the next run carries", { timeout: 180_000 }, async (t) => {
  const canary = `not-a-secret-saved-model-${process.pid}-${Date.now()}`;
  const standIn = await anthropicStandIn(t, "Saved key answered.");
  // No model key and no model setting anywhere the server or its runner reads: Anthropic's base is the stand-in's.
  withEnv(t, { ANTHROPIC_BASE_URL: standIn.url }, MODEL_ENV);
  // No faux model: the run's route chooses its model from the keys it has, as a real run does.
  const server = await serve(t, { faux: undefined, harnesses: false });
  const { api } = server;

  const first = `${canary}-first`;
  const saved = await api("PUT", "/settings/tool-keys/anthropic", { values: { ANTHROPIC_API_KEY: first } });
  assert.equal(saved.status, 204, `the key is saved: ${JSON.stringify(saved.body)}`);
  assert.equal((await api("POST", "/agents", agent("on-saved"))).status, 201);

  const one = await ran(api, "on-saved", "Report.");
  assert.equal(one.status, "completed", `the run on the saved key completes: ${JSON.stringify(one.run.error ?? one.run)}`);
  assert.ok(standIn.keys.length > 0, "the run's model requests reached Anthropic's stand-in");
  assert.deepEqual([...new Set(standIn.keys)], [first], "every model request carries the saved key, whole");
  assert.match(JSON.stringify(one.run), /Saved key answered\./, "the run's answer is the stand-in's");

  // Saved again with a new value, still with no restart: the next run carries the new one, never the old.
  const second = `${canary}-second`;
  assert.equal((await api("PUT", "/settings/tool-keys/anthropic", { values: { ANTHROPIC_API_KEY: second } })).status, 204);
  const before = standIn.keys.length;
  const two = await ran(api, "on-saved", "Report again.");
  assert.equal(two.status, "completed", `the run on the key saved again completes: ${JSON.stringify(two.run.error ?? two.run)}`);
  const after = standIn.keys.slice(before);
  assert.ok(after.length > 0, "the second run's model requests reached the stand-in");
  assert.deepEqual([...new Set(after)], [second], "every request of the next run carries the key saved again");
});
