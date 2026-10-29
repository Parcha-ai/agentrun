// A paid request's cost on a harness other than pi, when it is booked after the harness has its answer (the proxy answers
// before it books the response): the turn's end waits for it, so the answer is written with its cost, once. One whose
// cost does not come in time is written at unknown cost and marked booked, and its cost, when it comes, as an entry of
// its own: the run's spend (which its cap reads) counts it once, and the next open writes nothing more.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { adapterRun, BOOKED, BOOKING_WAIT_MS, PRICED_LATE } from "../dist/harness-app.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

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
          const ticket = await io.models.beforeRequest({ model: "late" });
          io.onEvent({ type: "text", delta: "Answered." });
          void book.promise.then(() => io.models.afterRequest({ input: 10, output: 5, cacheRead: 0, usd: 0.003 }, ticket ?? undefined));
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
/** The run's spend as its cap reads it (cap.ts): every assistant entry's known cost. */
const spend = (entries) => Math.round(assistants(entries).reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0) * 1e6) / 1e6;
const bookedMarks = (entries) => entries.filter((e) => e.kind === BOOKED);
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
  assert.equal(bookedMarks(entries).length, 1, "booked once");
});

test("a request whose cost comes after the wait: its answer is written at unknown cost and marked booked, its cost then counted once, and the next open adds nothing", { timeout: BOOKING_WAIT_MS * 5 }, async () => {
  const storage = new MemoryStorage();
  const late = lateBooking();
  const first = await opened(storage, late.adapter);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await until(() => first.events.includes("run_end"), BOOKING_WAIT_MS * 3);
  // Its cost not in yet: the run's cost reads unknown, never a known $0.
  assert.equal(timelineOf(await rootOf(first.harness)).findLast((r) => r.kind === "usage")?.usage?.usd, null, "unknown while the cost is out");
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
  assert.equal(bookedMarks(before).length, 1, "marked booked once");
  assert.equal(before.filter((e) => e.kind === PRICED_LATE).length, 1, "its late cost written once");
  // A later process opens the run: the request is booked in its session, and already written with its cost.
  const next = await opened(storage, lateBooking().adapter);
  const after = await rootOf(next.harness);
  assert.equal(answers(after).length, 1, "no second answer for the same request");
  assert.equal(spend(after), 0.003, "nor its cost counted twice");
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
  assert.equal(bookedMarks(after).length, 1, "booked once");
  assert.equal(after.filter((e) => e.kind === PRICED_LATE).length, 1, "its late cost written once");
});
