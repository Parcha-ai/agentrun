// A paid request's cost on a harness other than pi, when it is booked after the harness has its answer (the proxy answers
// before it books the response): the turn's end waits for it, so the answer is written with its cost, once. One whose
// cost does not come in time is written at unknown cost and marked booked, and its cost, when it comes, as an entry of
// its own: the run's spend (which its cap reads) counts it once, and the next open writes nothing more. Each answer names
// the model its request asked for, and its tokens go where its cost goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { RUNNER_RECORDS } from "@parcha/agentrun-adapters";
import { REQUEST_COST, REQUEST_COST_LATE, REQUEST_COST_PENDING, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spentIn } from "../dist/cap.js";
import { adapterRun, BOOKED, BOOKING_WAIT_MS, PRICED_LATE } from "../dist/harness-app.js";
import { durableSessions } from "../dist/sessions.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** The model the adapter's request asks for (its harness is "late"), and the tokens its answer reports. */
const MODEL = "late-model-1";
const TOKENS = { input: 10, output: 5, cacheRead: 40, cacheWrite: 2 };

/** An adapter whose one request is answered, and its turn ended, before the test lets its booking through. */
function lateBooking() {
  const book = deferred();
  const adapter = {
    id: "late",
    version: "0",
    capabilities: () => ({ fork: false }),
    check: () => [],
    async open(_spec, io) {
      let ended = deferred();
      let sent = false;
      return {
        state: "new",
        async send() {
          ended = deferred();
          if (sent) return void ended.resolve({ status: "completed" });
          sent = true;
          const ticket = await io.models.beforeRequest({ model: MODEL });
          io.onEvent({ type: "text", delta: "Answered." });
          void book.promise.then(() => io.models.afterRequest({ ...TOKENS, usd: 0.003 }, ticket ?? undefined));
          ended.resolve({ status: "completed" });
        },
        async recover() {},
        turnEnd: () => ended.promise,
        async interrupt() {},
        async close() {},
      };
    },
  };
  return { adapter, book: () => book.resolve() };
}

const runOf = (harness) => ({ harness, env: async () => ({ confinePrefix: () => ["/usr/bin/setpriv", "--no-new-privs", "--"] }) });

async function opened(storage, adapter, wrap = (harness) => harness) {
  const harness = wrap(await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx));
  const app = adapterRun(async () => adapter, "late", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx);
  const events = [];
  app.door.attach((e) => events.push(e.type));
  await app.onOpen(runOf(harness));
  const door = { run: { harness }, signal: new AbortController().signal, emit: (e) => events.push(e.type), adopt: () => {} };
  return { app, door, events, harness };
}

async function rootOf(harness) {
  const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  const out = [];
  for (let cursor; ; ) {
    const page = await root.entries({ order: "ascending" }, 500, cursor, ctx);
    out.push(...page.items);
    if (page.next === undefined) return out;
    cursor = page.next;
  }
}
const assistants = (entries) => entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant" && m.stopReason !== "error"));
const answers = (entries) => assistants(entries).filter((m) => m.content.some((c) => c.text));
/** The run's spend as cap.ts's spentIn reads a store: each answer's known cost, and each cost written apart from one. */
const spend = (entries) =>
  Math.round(entries.reduce((sum, e) => sum + (e.kind === "pi.assistant" ? e.model?.[0]?.usage?.cost?.total ?? 0 : [REQUEST_COST, REQUEST_COST_LATE].includes(e.kind) ? (e.data?.usd ?? 0) : 0), 0) * 1e6) / 1e6;
/** The run's usage as the timeline (and so /usage and the run's cost) reads it. */
const usage = (entries, settled = false) => timelineOf(entries, { settled }).findLast((r) => r.kind === "usage")?.usage;
const bookedMarks = (entries) => entries.filter((e) => e.kind === BOOKED);
/** An answer's model and tokens, as its entry names them. */
const named = (m) => ({ provider: m.provider, model: m.model, input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite, totalTokens: m.usage.totalTokens });
const NONE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; !check(); ) {
    assert.ok(Date.now() < end, "in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("a request booked just after its turn ended: the turn's end waits for its cost, and the answer is written with it, booked once", async () => {
  const storage = new MemoryStorage();
  const late = lateBooking();
  const { app, door, events, harness } = await opened(storage, late.adapter);
  assert.deepEqual(await app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, door), { accepted: true });
  // The turn has ended on the harness's side; its cost is still on its way.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!events.includes("run_end"), "the run waits for the cost");
  const released = Date.now();
  late.book();
  await until(() => events.includes("run_end"));
  assert.ok(Date.now() - released < 500, `the turn ends as soon as its cost is in: ${Date.now() - released} ms`);
  const entries = await rootOf(harness);
  assert.deepEqual(answers(entries).map((m) => [m.content.map((c) => c.text).join(""), m.usage?.cost?.total]), [["Answered.", 0.003]], "the answer, at its cost");
  assert.deepEqual(answers(entries).map(named), [{ provider: "late", model: MODEL, ...TOKENS, totalTokens: 57 }], "the model its request asked for, and its tokens");
  assert.equal(bookedMarks(entries).length, 1, "booked once");
});

test("a request whose cost comes after the wait: its answer is written at unknown cost and marked booked, its cost then counted once, and the next open adds nothing", { timeout: BOOKING_WAIT_MS * 5 }, async () => {
  const storage = new MemoryStorage();
  const late = lateBooking();
  const first = await opened(storage, late.adapter);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await until(() => first.events.includes("run_end"), BOOKING_WAIT_MS * 3);
  // Its cost not in yet: the run's cost reads unknown, never a known $0.
  assert.deepEqual(usage(await rootOf(first.harness)), { usd: null, requests: 1 }, "one request, its cost unknown while it is out");
  // The cost comes in after the answer was written: it goes in at once, with no next turn to carry it.
  const released = Date.now();
  late.book();
  for (; spend(await rootOf(first.harness)) !== 0.003; ) {
    assert.ok(Date.now() - released < 500, "the late cost is in the run's spend at once");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // A next turn in the same process flushes again: the late cost still belongs to the answer already written.
  assert.deepEqual(await first.app.door.submit({ requestId: "m2", content: "again", whenBusy: "followUp" }, first.door), { accepted: true });
  await until(() => first.events.filter((e) => e === "run_end").length === 2, BOOKING_WAIT_MS * 3);
  const before = await rootOf(first.harness);
  assert.deepEqual(answers(before).map((m) => [m.content.map((c) => c.text).join(""), m.usage?.cost?.total]), [["Answered.", undefined]], "one answer, written at unknown cost");
  assert.equal(spend(before), 0.003, "its cost, come in late, is in the run's spend");
  assert.deepEqual(usage(before), { usd: 0.003, requests: 1 }, "one request, at its cost: the late cost is not a request of its own");
  assert.equal(bookedMarks(before).length, 1, "marked booked once");
  assert.equal(before.filter((e) => e.kind === PRICED_LATE).length, 1, "its late cost written once");
  assert.deepEqual(answers(before).map(named), [{ provider: "late", model: MODEL, ...NONE }], "the answer names its model; its tokens, not in yet, are 0, which reads as unknown");
  assert.deepEqual(before.find((e) => e.kind === PRICED_LATE).data.usage, TOKENS, "its tokens come with its late cost");
  // A later process opens the run: the request is booked in its session, and already written with its cost.
  const next = await opened(storage, lateBooking().adapter);
  const after = await rootOf(next.harness);
  assert.equal(answers(after).length, 1, "no second answer for the same request");
  assert.equal(spend(after), 0.003, "nor its cost counted twice");
  assert.deepEqual(usage(after, true), { usd: 0.003, requests: 1 }, "still one request at its cost");
  assert.equal(bookedMarks(after).length, 1, "still booked once");
});

test("a late cost the session booked but the root never got (its process went first) is written by the next open, once", { timeout: BOOKING_WAIT_MS * 5 }, async () => {
  const storage = new MemoryStorage();
  const late = lateBooking();
  // The first process goes before it writes the late cost: its commit of that cost fails, as a process cut there.
  const cut = (harness) => new Proxy(harness, {
    get: (target, key) => key !== "commit" ? Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key) : (change, context) =>
      target.commit((tx) => change(new Proxy(tx, { get: (t, k) => (k === "appendEntry" ? (...args) => (args[1]?.kind === PRICED_LATE ? Promise.reject(new Error("the process went")) : t.appendEntry(...args)) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) })), context),
  });
  const first = await opened(storage, late.adapter, cut);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await until(() => first.events.includes("run_end"), BOOKING_WAIT_MS * 3);
  late.book();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(spend(await rootOf(first.harness)), 0, "the first process never wrote the late cost");
  const next = await opened(storage, lateBooking().adapter);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = await rootOf(next.harness);
  assert.equal(answers(after).length, 1, "one answer");
  assert.equal(spend(after), 0.003, "the next open wrote the cost the session booked");
  assert.deepEqual(usage(after, true), { usd: 0.003, requests: 1 }, "one request, at its cost");
  assert.equal(bookedMarks(after).length, 1, "booked once");
  assert.equal(after.filter((e) => e.kind === PRICED_LATE).length, 1, "its late cost written once");
  assert.deepEqual(after.find((e) => e.kind === PRICED_LATE).data.usage, TOKENS, "with the tokens the session booked");
});

test("the next open re-books what the session booked with its tokens and model; a journal from before bookings kept tokens re-books with none", async () => {
  const storage = new MemoryStorage();
  const key = "run:1";
  // A journal as an earlier process left it, written before runner.turn kept tokens but for its last request: three
  // requests booked in the session. The first was written on the root at unknown cost, and its cost never reached the
  // root; the other two have no entry there (the process went before the boundary).
  const earlier = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  const writer = await durableSessions(earlier, ctx).open(key);
  await writer.append([
    { kind: RUNNER_RECORDS.request, data: { turn: 1, model: "late-model-1" } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd: 0.004, estimated: true } },
    { kind: RUNNER_RECORDS.request, data: { turn: 2, model: "late-model-2" } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 2, usd: 0.001 } },
    { kind: RUNNER_RECORDS.request, data: { turn: 3, model: "late-model-3" } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 3, usd: 0.002, usage: { input: 7, output: 3, cacheRead: 20, cacheWrite: 0 } } },
  ]);
  await earlier.commit(async (tx) => {
    const message = { role: "assistant", content: [{ type: "text", text: "First." }], api: "agentrun-adapter", provider: "late", model: "late", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, stopReason: "stop", timestamp: Date.now() };
    await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [message] });
    await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: REQUEST_COST_PENDING, data: { key, request: 1 } });
    await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key, request: 1, unpriced: true } });
  }, ctx);
  const next = await opened(storage, lateBooking().adapter);
  const entries = await rootOf(next.harness);
  assert.deepEqual(entries.filter((e) => e.kind === PRICED_LATE).map((e) => e.data), [{ key, request: 1, usd: 0.004 }], "the older booking's late cost, with no tokens");
  assert.deepEqual(assistants(entries).map((m) => [m.usage.cost.total, named(m)]), [
    [undefined, { provider: "late", model: "late", ...NONE }],
    [0.001, { provider: "late", model: "late-model-2", ...NONE }],
    [0.002, { provider: "late", model: "late-model-3", input: 7, output: 3, cacheRead: 20, cacheWrite: 0, totalTokens: 30 }],
  ], "each request re-booked at its cost, naming its model, with the tokens its booking kept (none for the older one)");
  assert.deepEqual(usage(entries, true), { usd: 0.007, requests: 3 }, "the cost is what it was");
  assert.equal(bookedMarks(entries).length, 3, "each booked once");
});

test("the cap's spend read from a store sums each answer's cost and each cost written apart, a compaction's and a late one", () => {
  const dir = mkdtempSync(join(tmpdir(), "spent-in-"));
  try {
    const file = join(dir, "run.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE entries (record TEXT)");
    const put = db.prepare("INSERT INTO entries (record) VALUES (?)");
    for (const entry of [
      { kind: "pi.assistant", model: [{ usage: { cost: { total: 0.001 } } }] },
      { kind: REQUEST_COST, data: { request: "compaction", usd: 0.002 } },
      { kind: "pi.assistant", model: [{ usage: { cost: {} } }] },
      { kind: REQUEST_COST_PENDING, data: {} },
      { kind: REQUEST_COST_LATE, data: { usd: 0.003 } },
    ]) put.run(JSON.stringify(entry));
    db.close();
    assert.equal(Math.round(spentIn(file) * 1e6) / 1e6, 0.006);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
