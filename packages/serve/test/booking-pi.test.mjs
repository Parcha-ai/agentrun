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
import { RequestBounds } from "../dist/bounds.js";

/** A side request's marks without their request id, once each names one and the same one (request-start.ts). */
const sameRequest = (marks) => {
  const ids = new Set(marks.map((m) => (Array.isArray(m) ? m[1] : m.data)?.requestId));
  assert.ok(ids.size === 1 && typeof [...ids][0] === "string", `one request id across its marks: ${JSON.stringify(marks)}`);
  const plain = ({ requestId: _, ...data }) => data;
  return marks.map((m) => (Array.isArray(m) ? [m[0], plain(m[1])] : { ...m, data: plain(m.data) }));
};

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

test("an answer whose holding mark the store is slow to take reaches pi only once the mark is in: the done event waits for it, as an error does, so pi's entry always comes after the mark that pairs with it", async () => {
  const marks = [];
  // The store takes 200 ms for an end mark.
  const run = await capped(marks, costless(), (entry) => (entry.kind === REQUEST_ENDED ? new Promise((resolve) => setTimeout(resolve, 200)) : undefined));
  const stream = run.streamSimple(MODEL, context, {});
  let atDone;
  for await (const event of stream) if (event.type === "done") atDone = marks.filter((m) => m.kind === REQUEST_ENDED).map((m) => m.data);
  assert.deepEqual(atDone, [{ unpriced: true, heldUsd: 0.001 }], "the answer's mark at its hold is in the store when pi has the answer");
  // A lost attempt's mark, the store as slow: in before the retry is sent, so in before its answer too.
  {
    const marks = [];
    const run = await capped(marks, undefined, (entry) => (entry.kind === REQUEST_ENDED ? new Promise((resolve) => setTimeout(resolve, 200)) : undefined));
    const stream = run.streamSimple(MODEL, context, options(scripted([STEPS.refused("ECONNRESET"), STEPS.ok])));
    let lostAtDone;
    for await (const event of stream) if (event.type === "done") lostAtDone = marks.filter((m) => m.kind === REQUEST_ENDED).map((m) => m.data);
    assert.deepEqual(lostAtDone, [{ lost: true, heldUsd: 0.001 }], "the lost mark at its hold is in the store when pi has the retry's answer");
  }
});

test("a later process reads an answer with no readable cost at its hold when pi wrote its entry in its own order, the moment the answer reached it, with the store slow to take the mark: the restart figure, not a hand-built store", async (t) => {
  // One list in the order the store took them: the cap's marks as they land, and pi's entry as the done event reaches it.
  const store = [];
  const run = await capped(store, costless(), (entry) => (entry.kind === REQUEST_ENDED ? new Promise((resolve) => setTimeout(resolve, 200)) : undefined));
  for await (const event of run.streamSimple(MODEL, context, {})) if (event.type === "done") store.push({ kind: "pi.assistant", model: [event.message] });
  // Past every write the store was still taking.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(spentIn(storeOf(t, store)), 0.001, `read again at its hold: ${JSON.stringify(store.map((e) => [e.kind, e.data]))}`);
});

test("a summary request the run stops while pi-ai waits to retry a lost attempt saves its mark at the hold, so a later process reads what this one booked, never the stop's smaller figure", async (t) => {
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
  const summary = await run.completeSimple(big, context, { ...options(scripted([resetThenStop, STEPS.ok])), signal: stop.signal });
  await settle();
  assert.deepEqual([summary.stopReason, fetches], ["aborted", 1], "stopped before its retry was sent");
  assert.deepEqual(sameRequest(marks.filter((m) => m.kind === REQUEST_ENDED)).map((m) => m.data), [{ request: "compaction", heldUsd: 0.01 }], "its end mark keeps the hold");
  assert.equal(spentIn(storeOf(t, marks)), 0.01, "a later process reads the hold");
});

test("an attempt the SDK's own timeout cuts (its controller fires, the run's stop does not) is lost, as it left: a timeout then pi-ai's retry answered books the hold, in this process and in a later one", async (t) => {
  const marks = [];
  const run = await capped(marks);
  let hung = 0;
  // The provider never answers the first attempt; the SDK's own 100 ms timeout aborts the fetch it handed us.
  const hang = async (_url, init) => {
    hung += 1;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), { once: true }));
  };
  const first = await run.streamSimple(MODEL, context, { ...options(scripted([hang, STEPS.ok])), timeoutMs: 100 }).result();
  await settle();
  const upTo = marks.length;
  assert.deepEqual([first.stopReason, hung], ["stop", 1], `the retry answered: ${first.errorMessage}`);
  const second = await run.streamSimple(MODEL, context, options(scripted([STEPS.ok]))).result();
  assert.match(second.errorMessage ?? "", /^spend_cap_reached/, "booked at its $0.001 hold, the timed-out attempt left: no room for another");
  assert.equal(spentIn(storeOf(t, [...marks.slice(0, upTo), { kind: "pi.assistant", model: [first] }])), 0.001, "a later process reads the hold too");
});

test("a lost attempt then pi-ai's retry that misses the cache: the request's bound stays open through its lost mark and ends with its answer, so the run's overshoot is within it, read live and after a restart", async () => {
  // Priced as Claude Sonnet 5.5; a conversation of ~300 KB whose previous answer read 75,000 tokens from the cache, so the
  // request goes at its expected cost with a bound. The retry reports 60,000 input tokens, none cached: $0.12 past a
  // $0.10 cap.
  const priced = { ...MODEL, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
  const previous = { role: "assistant", content: [{ type: "text", text: "Read it." }], api: priced.api, provider: priced.provider, model: priced.id, stopReason: "stop", timestamp: Date.now(), usage: { input: 3, output: 20, cacheRead: 70_000, cacheWrite: 5_000, totalTokens: 75_023, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } } };
  const warm = { messages: [{ role: "user", content: `Read this.\n${"The quarterly figures hold. ".repeat(11_000)}`, timestamp: 0 }, previous, { role: "user", content: "Go on.", timestamp: 0 }] };
  const missed = EVENTS.map((event) => (event.type === "message_start" ? { ...event, message: { ...event.message, usage: { input_tokens: 60_000, output_tokens: 1 } } } : event));
  const marks = [];
  const run = await capped(marks, undefined, undefined, 0.1);
  const answer = await run.streamSimple(priced, warm, options(scripted([STEPS.refused("ECONNRESET"), async () => new Response(frame(missed), { status: 200, headers: { "content-type": "text/event-stream" } })]))).result();
  await settle();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.ok(answer.usage.cost.total > 0.1, `the retry's real cost passes the cap: ${answer.usage.cost.total}`);
  const start = marks.find((m) => m.kind === REQUEST_STARTED);
  assert.ok(start?.data?.boundUsd > 0, `sent with a bound: ${JSON.stringify(start?.data)}`);
  assert.ok(marks.some((m) => m.kind === REQUEST_ENDED && m.data?.lost === true), "its lost attempt was marked before the retry");
  // The run's root as the server reads it: the marks in order, then pi's entry for the answer.
  const entries = [...marks, { kind: "pi.assistant", model: [answer] }].map((entry, at) => ({ ...entry, id: at + 1 }));
  const live = new RequestBounds();
  for (const entry of entries) live.note([entry], 0.1);
  const replay = new RequestBounds();
  replay.note(entries, 0.1);
  for (const [how, bounds] of [["live", live], ["after a restart", replay]]) {
    assert.equal(bounds.inFlight(), 0, how);
    assert.ok(Math.abs(bounds.ended() - start.data.boundUsd) < 1e-12, `${how}: its bound ended with its answer: ${bounds.ended()}`);
    assert.ok(answer.usage.cost.total - 0.1 <= bounds.ended(), `${how}: the overshoot is within it`);
  }
});
