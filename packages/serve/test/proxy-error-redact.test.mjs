// A provider's error never hands the harness the provider's credential: through the session's model proxy, under each
// policy this server ships (claude-agent's Anthropic Messages, codex's and OpenCode's OpenAI Responses), an error that
// echoes the key the proxy sent (as a provider does with a wrong key: "Incorrect API key provided: <key>"), whether
// answered with an error status or as an error event inside a streamed answer, reaches the harness with the key cut out,
// in the form it was sent and in its JSON-escaped forms, and so does a header value the host added. A healthy streamed
// answer reaches it byte for byte. The values are dummies; no network: the provider is a fetch.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { codexPolicy } from "@parcha/agentrun-harness-codex";

const { openCodePolicy } = await import("../dist/harness-opencode/host/policy.js");

const SESSION_KEY = "session-key-for-tests";
/** A dummy provider key, with a "/" that some JSON encoders send as "\/". */
const CREDENTIAL = "dummy-provider-key/0123456789abcdefABCDEF";
/** A dummy value of a header the host adds to every request (a gateway's tag). */
const TAG = "dummy-host-tag-0123456789";
const ESCAPED = CREDENTIAL.replaceAll("/", "\\/");

const sse = (events) => events.map((event) => `${event.name ? `event: ${event.name}\n` : ""}data: ${JSON.stringify(event.data)}\n\n`).join("");

/** Each policy this server ships, the request its client sends, and how its API carries an error: as an answer with an
 *  error status, and as an error event inside a streamed answer (Messages' `error`; Responses' `error` and
 *  `response.failed`). */
const POLICIES = {
  "claude-agent": {
    policy: anthropicPolicy({ model: "claude-sonnet-4-5", tools: [] }),
    path: "/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    body: { model: "claude-sonnet-4-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] },
    healthy: sse([{ name: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } } }]),
    status: (said) => ({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${said}` } }),
    events: (said) => [sse([{ name: "error", data: { type: "error", error: { type: "overloaded_error", message: `upstream refused key ${said}` } } }])],
  },
  codex: {
    policy: codexPolicy({ model: "gpt-5", tools: [] }),
    path: "/v1/responses",
    body: { model: "gpt-5", stream: true, input: [{ role: "user", content: "hi" }] },
    healthy: sse([{ data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } }]),
    status: (said) => ({ error: { message: `Incorrect API key provided: ${said}.`, type: "invalid_request_error", code: "invalid_api_key" } }),
    events: (said) => [
      sse([{ data: { type: "error", code: "invalid_api_key", message: `Incorrect API key provided: ${said}.` } }]),
      sse([{ data: { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code: "invalid_api_key", message: `Incorrect API key provided: ${said}.` } } } }]),
    ],
  },
  opencode: {
    policy: openCodePolicy({ model: "gpt-5", tools: [] }),
    path: "/v1/responses",
    body: { model: "gpt-5", stream: true, input: [{ role: "user", content: "hi" }] },
    healthy: sse([{ data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } }]),
    status: (said) => ({ error: { message: `Incorrect API key provided: ${said}.`, type: "invalid_request_error", code: "invalid_api_key" } }),
    events: (said) => [
      sse([{ data: { type: "error", code: "invalid_api_key", message: `Incorrect API key provided: ${said}.` } }]),
      sse([{ data: { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code: "invalid_api_key", message: `Incorrect API key provided: ${said}.` } } } }]),
    ],
  },
};

/** What the harness reads back from a proxy under `shipped` whose provider answers `status` with `text`, in `pieces` when
 *  given (each its own chunk). */
async function received(t, shipped, status, text, contentType = "application/json", pieces = undefined) {
  const hooks = { beforeRequest: async () => undefined, afterRequest: async () => {} };
  const fetch = async () => new Response(new ReadableStream({
    start(c) {
      for (const piece of pieces ?? [text]) c.enqueue(new TextEncoder().encode(piece));
      c.close();
    },
  }), { status, headers: { "content-type": contentType } });
  const proxy = await startModelProxy({ policy: shipped.policy, model: shipped.body.model, origin: "https://provider.invalid", credential: () => CREDENTIAL, headers: { "x-host-tag": TAG }, hooks, price: () => 0, log: () => {}, fetch }, SESSION_KEY);
  t.after(() => proxy.close());
  const { hostname, port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: "POST", path: shipped.path, headers: { "content-type": "application/json", authorization: `Bearer ${SESSION_KEY}`, ...(shipped.headers ?? {}) } }, (res) => {
      let got = "";
      res.setEncoding("utf8");
      res.on("data", (piece) => (got += piece));
      res.on("end", () => resolve({ status: res.statusCode, text: got }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(shipped.body));
  });
}

/** Whether `text` holds the provider's key or the host's tag in any form a provider echoes it. */
const leaks = (text) => [CREDENTIAL, ESCAPED, TAG].some((form) => text.includes(form));

test("a provider's error answer that echoes its key reaches the harness with the key cut out, under every policy this server ships", async (t) => {
  for (const [name, shipped] of Object.entries(POLICIES)) {
    await t.test(name, async (t) => {
      for (const said of [CREDENTIAL, ESCAPED, `${CREDENTIAL} (tag ${TAG})`]) {
        const got = await received(t, shipped, 401, JSON.stringify(shipped.status(said)));
        assert.equal(got.status, 401);
        assert.ok(!leaks(got.text), `the error answer reached the harness with a secret in it: ${got.text}`);
        assert.ok(got.text.includes("[redacted]"), got.text);
      }
    });
  }
});

test("an error event inside a streamed answer that echoes the key reaches the harness with the key cut out, and a healthy answer reaches it byte for byte, under every policy this server ships", async (t) => {
  for (const [name, shipped] of Object.entries(POLICIES)) {
    await t.test(name, async (t) => {
      for (const event of shipped.events(CREDENTIAL)) {
        const answer = shipped.healthy + event;
        // Whole, and a byte at a time: the key is cut wherever a chunk boundary falls.
        for (const pieces of [undefined, [...answer]]) {
          const got = await received(t, shipped, 200, answer, "text/event-stream", pieces);
          assert.equal(got.status, 200);
          assert.ok(!leaks(got.text), `the error event reached the harness with the key in it: ${got.text}`);
          assert.ok(got.text.startsWith(shipped.healthy), "the healthy events before it, as sent");
          assert.ok(got.text.includes("[redacted]"), got.text);
        }
      }
      const healthy = await received(t, shipped, 200, shipped.healthy, "text/event-stream");
      assert.equal(healthy.text, shipped.healthy, "a healthy answer, byte for byte");
    });
  }
});
