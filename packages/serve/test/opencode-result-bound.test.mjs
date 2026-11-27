// A host tool's result on the OpenCode adapter passes the kernel's tool bridge on its way to OpenCode, which holds it to
// the model's context window when the host knows it (the adapter's contextWindow option, or the session's own,
// SessionSpec.contextWindow): a 16k model gets at most a quarter of its window at three characters a token, cut with a
// note saying why; with no window, the host's fixed bound (HOST_RESULT_MAX_CHARS) as before. The stand-in for `opencode
// serve` (fixtures/fake-opencode-serve.mjs) and a scripted provider only: no binary, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const ROOT = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-opencode-bound-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;
const BIG = `START-OF-RESULT ${"x".repeat(50_000)}`;
const WINDOW_NOTE = /\n\[kept \d+ of 50016 characters: the result was cut to fit this model's context window\./;

/** A Responses stream: a function call, or text, then the response's usage. */
function answer(step, i) {
  const events = [];
  if (step.call) {
    const item = { type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: step.call, arguments: "{}", status: "completed" };
    events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.output_item.done", output_index: 0, item });
  } else {
    events.push({ type: "response.output_text.delta", item_id: `m_${i}`, output_index: 0, content_index: 0, delta: step.text });
  }
  events.push({ type: "response.completed", response: { id: `resp_${i}`, object: "response", status: "completed", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** The end the host heard of one call of a tool answering BIG, on a session whose window is `options.contextWindow` (the
 *  adapter's) or `spec` (the session's own); and the result OpenCode handed the model. */
async function ended({ options = {}, spec = {} } = {}) {
  const dir = mkdtempSync(join(ROOT, `t${n++}-`));
  const trace = join(dir, "trace.jsonl");
  writeFileSync(trace, "");
  const script = [{ call: "hands_lookup" }, { text: "done" }];
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(answer(script[seen.length - 1] ?? { text: "done" }, seen.length - 1), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const adapter = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => `not-a-secret-${"x"}` }, price: () => 0, sessionsDir: join(dir, "sessions"), standIn: { command: process.execPath, args: [FAKE], env: { FAKE_OPENCODE_TRACE: trace } }, fetch, ...options });
  const lookup = { name: "lookup", description: "Look a thing up.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => ({ text: BIG }) };
  const events = [];
  const store = memorySessionStore();
  const io = { writer: await store.open(`s-${n}`), models: { beforeRequest: async () => ({ turn: 1 }), afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: `s-${n}`, label: "task", system: ["You answer."], tools: [lookup], context: "fresh", ...spec }, io);
  try {
    await session.send("Look it up.");
    assert.deepEqual(await session.turnEnd(), { status: "completed" });
  } finally {
    await session.close();
  }
  const ends = events.filter((e) => e.type === "tool_end" && e.name === "lookup");
  assert.equal(ends.length, 1, "one end of the call");
  const outputs = seen.flatMap((body) => body.input ?? []).filter((item) => item.type === "function_call_output");
  const read = outputs.length ? String(outputs.at(-1).output) : undefined;
  return { end: ends[0], read };
}

test("OpenCode, a model with a 16k window (the adapter's option): a 50k result reaches the model cut to the per-model bound, saying why", async () => {
  const { end, read } = await ended({ options: { contextWindow: 16_384 } });
  assert.ok(end.result.length <= SMALL_MAX, `${end.result.length} characters, past ${SMALL_MAX}`);
  assert.match(end.result, WINDOW_NOTE);
  assert.ok(end.result.startsWith("START-OF-RESULT "), "its start kept");
  assert.equal(end.truncated, true);
  assert.ok(read !== undefined && !read.includes("x".repeat(SMALL_MAX)), "the model read no more than the bound");
});

test("OpenCode, the session's own 16k window wins over the adapter's: the same cut", async () => {
  const { end } = await ended({ options: { contextWindow: 1_000_000 }, spec: { contextWindow: 16_384 } });
  assert.ok(end.result.length <= SMALL_MAX, `${end.result.length} characters, past ${SMALL_MAX}`);
  assert.match(end.result, WINDOW_NOTE);
});

test("OpenCode, no window known: a 50k result reaches the model whole, within the host bound", async () => {
  const { end } = await ended();
  assert.equal(end.result, BIG);
});
