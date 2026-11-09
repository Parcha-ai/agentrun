// A content-filtered turn, then a follow-up message on the same session: the follow-up is answered, never refused. Once
// the model proxy tells the harness that a turn's answer stopped, it refuses the session's answer requests until the
// harness opens its next turn (ModelProxy.openTurn); OpenCode's harness halts the drive on the stop, and its next turn
// runs on a fresh drive whose proxy refuses nothing. This pins that: if OpenCode's process or its proxy ever outlived
// the halted drive, the follow-up would be refused here. The stand-in for `opencode serve`, its model requests through
// the session's real proxy to a scripted provider: no network, no OpenCode binary.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "agentrun-opencode-filter-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const FILTERED = "content_filter: the model provider stopped this answer";
const usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } };

/** A Responses stream of `text`, ending whole, or (filtered) stopped on the provider's content filter. */
const stream = (text, filtered) => [
  { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: text },
  filtered
    ? { type: "response.incomplete", response: { id: "resp_f", object: "response", status: "incomplete", incomplete_details: { reason: "content_filter" }, usage } }
    : { type: "response.completed", response: { id: "resp_w", object: "response", status: "completed", usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("opencode: a content-filtered turn, then a follow-up message on the same session, is answered", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, "s-"));
  const seen = [];
  const fetch = async () => {
    seen.push(seen.length);
    return new Response(stream(seen.length === 1 ? "Partly" : "Answered.", seen.length === 1), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const adapter = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, price: () => 0, sessionsDir: join(dir, "sessions"), standIn: { command: process.execPath, args: [FAKE] }, fetch });
  const store = memorySessionStore();
  const events = [];
  const io = { writer: await store.open("s1"), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: "s1", label: "task", system: ["You answer."], tools: [], context: "fresh" }, io);
  t.after(() => session.close());
  await session.send("First.");
  assert.deepEqual(await session.turnEnd(), { status: "failed", error: FILTERED }, "the filtered turn fails in the filter words");
  await session.send("Again, please.");
  assert.deepEqual(await session.turnEnd(), { status: "completed" }, "the follow-up is answered");
  assert.equal(seen.length, 2, "the follow-up's answer request reached the provider");
  assert.match(events.filter((e) => e.type === "text").map((e) => e.delta).join(""), /Answered\./);
});
