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
import { REQUEST_COST, REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { capModels, spentIn } from "../dist/cap.js";
import { END_MARK_WAIT_MS, markRequests } from "../dist/request-start.js";

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

/** A capped, marked pi run on real pi-ai (Anthropic's API), its marks into `marks`. `store(entry)`, when given, runs before
 *  each mark is kept: a store that is slow (it waits) or refuses (it throws) for that entry. */
async function capped(marks, models, store, cap = CAP) {
  const pi = models ?? (() => { const m = createModels(); m.setProvider(anthropicProvider()); return m; })();
  const marked = await markRequests(pi);
  const out = await capModels(marked.models, cap, 0);
  marked.open({ harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => { await store?.(entry); marks.push(entry); } }) } });
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

/** A store holding `entries` in order, as a later process reads it. */
function storeOf(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "booking-pi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  for (const entry of entries) put.run(JSON.stringify(entry));
  db.close();
  return file;
}

test("a later process reads an answer after a lost attempt (a reset, then pi-ai's retry answered) at the hold this one booked, never at the answer's own usage: its mark is in the store before the retry is sent", async (t) => {
  const marks = [];
  const run = await capped(marks);
  let atRetry;
  const retried = async (...args) => { atRetry = marks.map((m) => [m.kind, m.data]); return STEPS.ok(...args); };
  const first = await run.streamSimple(MODEL, context, options(scripted([STEPS.refused("ECONNRESET"), retried]))).result();
  await settle();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  // A process that dies once pi has the answer, whatever the store did meanwhile, leaves the hold's mark: no window.
  assert.deepEqual(atRetry?.find(([kind]) => kind === REQUEST_ENDED), [REQUEST_ENDED, { lost: true, heldUsd: 0.001 }], "the hold's end mark is in the store before the retry is sent");
  const file = storeOf(t, [...marks, { kind: "pi.assistant", model: [first] }]);
  assert.equal(spentIn(file), 0.001, `read again at its hold, as this process booked it: ${JSON.stringify(marks.map((m) => [m.kind, m.data]))}`);
});

test("a guard: an ordinary answer is priced once, its own cost, in this process and in a later one: no mark of the hold beside it", async (t) => {
  const { first, marks } = await bookedFirst([STEPS.ok], { only: true });
  assert.equal(first.stopReason, "stop", first.errorMessage);
  const own = first.usage.cost.total;
  assert.ok(own > 0 && own < 0.001, `its own cost: ${own}`);
  assert.equal(spentIn(storeOf(t, [...marks, { kind: "pi.assistant", model: [first] }])), own, "read again at its own cost, once");
  const again = await bookedFirst([STEPS.ok]);
  assert.equal(again.roomForAnother, true, "in this process: its own cost, room for another");
});

test("a request lost before any event in one attempt, its store slower than the end mark's old wait: pi has the error only once its mark at the hold is in the store, so a process that dies right then is read again at the hold", async (t) => {
  const marks = [];
  // The store takes 1.5 s for the end mark, past END_MARK_WAIT_MS (1 s).
  const run = await capped(marks, undefined, (entry) => (entry.kind === REQUEST_ENDED ? new Promise((resolve) => setTimeout(resolve, 1_500)) : undefined));
  const first = await run.streamSimple(MODEL, context, { ...options(scripted([STEPS.refused("ECONNRESET")])), maxRetries: 0 }).result();
  // The process dies the moment pi has the error: what the store holds then is all a later process reads.
  const held = [...marks];
  assert.equal(first.stopReason, "error");
  assert.equal(spentIn(storeOf(t, [...held, { kind: "pi.assistant", model: [first] }])), 0.001, `read again at its hold: ${JSON.stringify(held.map((m) => [m.kind, m.data]))}`);
});

test("a request whose end mark the store refuses fails loudly, and is read again at its hold, never at $0", async (t) => {
  const marks = [];
  const run = await capped(marks, undefined, (entry) => { if (entry.kind === REQUEST_ENDED) throw new Error("SQLITE_FULL"); });
  const first = await run.streamSimple(MODEL, context, { ...options(scripted([STEPS.refused("ECONNRESET")])), maxRetries: 0 }).result();
  assert.match(first.errorMessage ?? "", /^the model request's end could not be recorded/, "the request fails saying its end was not recorded");
  assert.equal(spentIn(storeOf(t, [...marks, { kind: "pi.assistant", model: [first] }])), 0.001, "read again at its start's hold: the request stays open, never closed at $0 by pi's entry");
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

/** pi's entry for an answer that cost `usd`. */
const answer = (usd) => ({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "42" }], stopReason: "stop", usage: { cost: { total: usd } }, timestamp: 0 }] });

test("a later process pairs a lost mark with its own request's answer, never an earlier request's: a side request between the mark and the retry's answer moves nothing", (t) => {
  // Two requests held at the same $0.001. The first answered at $0.0008; the second lost an attempt (its mark, at the
  // hold) and a side request ran (its start and its $0.0002 cost) before the second's retry answered at $0.0001.
  const file = storeOf(t, [
    { kind: REQUEST_STARTED, data: { heldUsd: 0.001 } },
    answer(0.0008),
    { kind: REQUEST_STARTED, data: { heldUsd: 0.001 } },
    { kind: REQUEST_ENDED, data: { lost: true, heldUsd: 0.001 } },
    { kind: REQUEST_STARTED, data: { request: "summary", heldUsd: 0.0005 } },
    { kind: REQUEST_COST, data: { request: "summary", usd: 0.0002 } },
    answer(0.0001),
  ]);
  // The first at its own $0.0008, the second at its hold, the side request at its $0.0002: never the hold in the first's place.
  assert.equal(Math.round(spentIn(file) * 1e9) / 1e9, 0.002, "the first's cost, the second's hold and the side request's cost");
});

test("a request whose retry the run stops after a lost attempt books its hold in this process, as its lost mark does in a later one: the stop never releases what the lost attempt can have cost", async (t) => {
  // A ceiling of 10,000 tokens at $1 a million: held at $0.01, stopped after a few bytes at about $0.001, under a $0.015 cap.
  const big = { ...MODEL, id: "claude-big", maxTokens: 10_000 };
  const marks = [];
  const run = await capped(marks, undefined, undefined, 0.015);
  const stop = new AbortController();
  // The retry's answer begins, then the run stops it.
  const begun = async (_url, init) => {
    setTimeout(() => stop.abort(), 50);
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame(EVENTS.slice(0, 3)))); init?.signal?.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const first = await run.streamSimple(big, context, { ...options(scripted([STEPS.refused("ECONNRESET"), begun])), signal: stop.signal }).result();
  await settle();
  const upTo = marks.length;
  assert.equal(first.stopReason, "aborted", first.errorMessage);
  await run.streamSimple(big, context, options(scripted([STEPS.ok]))).result();
  // The next request is limited to what is left of the cap: $0.005 once the first is booked at its $0.01 hold, never the
  // $0.014 a booking at what streamed would leave (which limits nothing).
  const next = marks.slice(upTo).find((m) => m.kind === REQUEST_STARTED)?.data?.clamp;
  assert.equal(next?.leftUsd, 0.005, `booked at its $0.01 hold in this process: ${JSON.stringify(next)}`);
  // The store as the first request left it, before the next began: its lost mark's hold, read again.
  assert.equal(spentIn(storeOf(t, [...marks.slice(0, upTo), { kind: "pi.assistant", model: [first] }])), 0.01, "a later process reads the same hold, from its lost mark");
});

/** Models whose every request answers at once with no readable cost (its usage names no total). */
const costless = () => {
  const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "anthropic-messages", provider: "anthropic", model: MODEL.id, stopReason: "stop", timestamp: 0, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: {} } };
  const send = () => {
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(message); });
    return events;
  };
  return { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result() };
};

test("an answer with no readable cost books its hold in this process and in a later one: a restart reads the hold its marks keep, never an unknown spend that refuses every request after", async (t) => {
  for (const call of ["streamSimple", "completeSimple"]) {
    const marks = [];
    const run = await capped(marks, costless());
    const first = call === "streamSimple" ? await run.streamSimple(MODEL, context, {}).result() : await run.completeSimple(MODEL, context, {});
    await settle();
    const upTo = marks.length;
    assert.equal(first.stopReason, "stop", `${call}: ${first.errorMessage}`);
    const second = await run.streamSimple(MODEL, context, {}).result();
    assert.match(second.errorMessage ?? "", /^spend_cap_reached/, `${call}: booked at its $0.001 hold in this process: no room for another`);
    // pi writes an entry for a generation's answer; a summary's answer is its cost mark alone.
    const stored = call === "streamSimple" ? [...marks.slice(0, upTo), { kind: "pi.assistant", model: [first] }, ...marks.slice(upTo)] : marks;
    assert.equal(spentIn(storeOf(t, stored)), 0.001, `${call}: a later process reads the hold too: ${JSON.stringify(marks.map((m) => [m.kind, m.data]))}`);
  }
});

test("a request the run stops while pi-ai waits to retry a lost attempt books its hold in this process and in a later one: its lost mark is written the moment the attempt is lost, not before a retry that never starts", async (t) => {
  // Held at $0.01 under a $0.015 cap; its stop figure, with nothing streamed, is about $0.001.
  const big = { ...MODEL, id: "claude-big", maxTokens: 10_000 };
  const marks = [];
  const run = await capped(marks, undefined, undefined, 0.015);
  const stop = new AbortController();
  let fetches = 0;
  // A reset once the request left; the run stops it 100 ms later, inside pi-ai's wait before its retry (about 0.4 s).
  const resetThenStop = async () => {
    fetches += 1;
    setTimeout(() => stop.abort(), 100);
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) });
  };
  const first = await run.streamSimple(big, context, { ...options(scripted([resetThenStop, STEPS.ok])), signal: stop.signal }).result();
  await settle();
  const upTo = marks.length;
  assert.deepEqual([first.stopReason, fetches], ["aborted", 1], "stopped before its retry was sent");
  await run.streamSimple(big, context, options(scripted([STEPS.ok]))).result();
  // The next request is limited to what is left of the cap: $0.005 once the first is booked at its $0.01 hold.
  const next = marks.slice(upTo).find((m) => m.kind === REQUEST_STARTED)?.data?.clamp;
  assert.equal(next?.leftUsd, 0.005, `booked at its $0.01 hold in this process: ${JSON.stringify(next)}`);
  // The store as the first request left it, before the next began: the hold its lost mark keeps.
  assert.equal(Math.round(spentIn(storeOf(t, [...marks.slice(0, upTo), { kind: "pi.assistant", model: [first] }])) * 1e9) / 1e9, 0.01, `a later process reads the hold too: ${JSON.stringify(marks.slice(0, upTo).map((m) => [m.kind, m.data]))}`);
});

test("a lost attempt's mark that the store takes 3 s to commit (behind a large entry on a slow disk) is in the store before the retry is sent: the retry's answer is kept, and a process that dies once it is in reads the hold; the store has 15 s", async (t) => {
  const marks = [];
  // The store takes 3 s for the end mark.
  const run = await capped(marks, undefined, (entry) => (entry.kind === REQUEST_ENDED ? new Promise((resolve) => setTimeout(resolve, 3_000)) : undefined));
  const first = await run.streamSimple(MODEL, context, options(scripted([STEPS.refused("ECONNRESET"), STEPS.ok]))).result();
  assert.equal(first.stopReason, "stop", `the retry's answer is kept: ${first.errorMessage}`);
  // What the store holds the moment pi has the answer: the lost mark, at the hold, never the answer's own usage alone.
  assert.equal(spentIn(storeOf(t, [...marks, { kind: "pi.assistant", model: [first] }])), 0.001, "read again at its hold");
  assert.equal(END_MARK_WAIT_MS, 15_000, "the store's bound for a mark that carries a hold");
});
