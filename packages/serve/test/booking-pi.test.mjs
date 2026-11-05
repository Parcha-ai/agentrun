// One booking rule (the kernel's booking.ts) for a pi request under a cap, as pi-ai sends it: never under-count. The cap
// gives each request a fetch that records every attempt pi-ai makes (pi-ai retries 429s, 5xx and transport errors inside
// one request), and the request counts at the worst of them, in the order lost > answered > nothing. A reset once the
// request left, a gateway's 504 or 524, or an answer after such a lost attempt can have been billed: the hold. A 429 then
// an answer is the answer, priced once; a request refused at connect never left: nothing. On an API whose transport the
// fetch cannot see (Codex's WebSocket), a failure before any event books the hold. And a later process reads the figure
// this one booked. Real pi-ai on Anthropic's API, its fetch scripted: no key, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { capModels, spentIn } from "../dist/cap.js";
import { markRequests } from "../dist/request-start.js";

/** $1 a million output tokens, a ceiling of 1,000 and free input: each request is held at $0.001. */
const MODEL = { id: "claude-x", name: "Claude X", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000 };
const CAP = 0.0015;
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const EVENTS = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL.id, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "42" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];
const frame = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
/** One step of the provider, per attempt: an answer, an answer cut after its first events, a status, or a refused fetch. */
const STEPS = {
  ok: async () => new Response(frame(EVENTS), { status: 200, headers: { "content-type": "text/event-stream" } }),
  okThenReset: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame(EVENTS.slice(0, 3)))); setTimeout(() => c.error(Object.assign(new Error("other side closed"), { code: "ECONNRESET" })), 5); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  status: (status) => async () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status, headers: { "content-type": "application/json" } }),
  refused: (code) => async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }); },
};
/** A fetch that answers attempt n with steps[n] (the last again after that). */
const scripted = (steps) => {
  let at = 0;
  return (...args) => steps[Math.min(at++, steps.length - 1)](...args);
};

/** A capped, marked pi run on real pi-ai (Anthropic's API), its marks into `marks`. */
async function capped(marks, models) {
  const pi = models ?? (() => { const m = createModels(); m.setProvider(anthropicProvider()); return m; })();
  const marked = await markRequests(pi);
  const out = await capModels(marked.models, CAP, 0);
  marked.open({ harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }) } });
  return out;
}
/** The first request's answer under `steps`, and whether the run then had room for a second ($0.001 held): what the first
 *  was booked at, as the cap reads it in this process. */
const options = (fetch) => ({ apiKey: "test-key", fetch, maxRetries: 2, maxRetryDelayMs: 1 });
async function bookedFirst(steps, { only = false } = {}) {
  const marks = [];
  const run = await capped(marks);
  const first = await run.streamSimple(MODEL, context, options(scripted(steps))).result();
  await settle();
  if (only) return { first, marks };
  const second = await run.streamSimple(MODEL, context, options(scripted([STEPS.ok]))).result();
  return { first, marks, roomForAnother: !/^spend_cap_reached/.test(second.errorMessage ?? "") };
}

test("a reset once the request left, then pi-ai's retry answered: the provider can have billed both, so the request books its hold", async () => {
  const { first, roomForAnother } = await bookedFirst([STEPS.refused("ECONNRESET"), STEPS.ok]);
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(roomForAnother, false, "booked at its hold ($0.001 of $0.0015): no room for another");
});

test("a request whose every attempt was reset once it left books its hold", async () => {
  const { first, roomForAnother } = await bookedFirst([STEPS.refused("ECONNRESET")]);
  assert.equal(first.stopReason, "error");
  assert.equal(roomForAnother, false, "booked at its hold: no room for another");
});

test("a gateway's 504 books the hold: the provider was still at work, and bills it", async () => {
  const { first, roomForAnother } = await bookedFirst([STEPS.status(504)]);
  assert.equal(first.stopReason, "error");
  assert.equal(roomForAnother, false, "booked at its hold: no room for another");
});

test("a failure before any event on an API the cap cannot watch through a fetch (Codex's WebSocket first) books its hold", async () => {
  const marks = [];
  // pi-ai's codex transport, as the cap sees it: a request that ends on an error with no event and no fetch it can see.
  const send = () => {
    const events = createAssistantMessageEventStream();
    const failed = { role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "c", stopReason: "error", errorMessage: "WebSocket closed before any event", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { events.push({ type: "error", reason: "error", error: failed }); events.end(failed); });
    return events;
  };
  const run = await capped(marks, { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result() });
  const codex = { ...MODEL, api: "openai-codex-responses", provider: "openai-codex", id: "c" };
  await run.streamSimple(codex, context, {}).result();
  await settle();
  const second = await run.streamSimple(codex, context, {}).result();
  assert.match(second.errorMessage ?? "", /^spend_cap_reached/, "booked at its hold: no room for another");
});

test("a later process reads a failed request's hold as this one booked it, never $0", async (t) => {
  const { first, marks } = await bookedFirst([STEPS.refused("ECONNRESET")], { only: true });
  const dir = mkdtempSync(join(tmpdir(), "booking-pi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  // The request's marks and pi's entry for its answer, as the store holds them.
  for (const entry of [...marks, { kind: "pi.assistant", model: [first] }]) put.run(JSON.stringify(entry));
  db.close();
  assert.equal(spentIn(file), 0.001, `read again at its hold: ${JSON.stringify(marks.map((m) => [m.kind, m.data]))}`);
});

test("a guard: a 429 then an answer is the answer, priced once; an answer cut part way books its hold; a request refused at connect never left", async () => {
  const retried = await bookedFirst([STEPS.status(429), STEPS.ok]);
  assert.equal(retried.first.stopReason, "stop", retried.first.errorMessage);
  assert.equal(retried.roomForAnother, true, "a 429 then an answer: the answer's own cost, room for another");
  const cut = await bookedFirst([STEPS.okThenReset]);
  assert.equal(cut.roomForAnother, false, "an answer cut part way: its hold");
  const refused = await bookedFirst([STEPS.refused("ECONNREFUSED")]);
  assert.equal(refused.first.stopReason, "error");
  assert.equal(refused.roomForAnother, true, "refused at connect: nothing, room for another");
});
