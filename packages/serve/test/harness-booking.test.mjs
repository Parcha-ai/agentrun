// A paid request's cost on a harness other than pi, when it is booked after the harness has its answer (the proxy answers
// before it books the response): the turn's end waits for it, so the answer is written with its cost, once. One whose
// cost does not come in time is written at unknown cost and marked booked, so the next open never writes it again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { adapterRun, BOOKED, BOOKING_WAIT_MS } from "../dist/harness-app.js";

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

async function opened(storage, adapter) {
  const harness = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
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
const answers = (entries) => entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant" && m.stopReason !== "error"));
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
  late.book();
  await until(() => events.includes("run_end"));
  const entries = await rootOf(harness);
  assert.deepEqual(answers(entries).map((m) => [m.content.map((c) => c.text).join(""), m.usage?.cost?.total]), [["Answered.", 0.003]], "the answer, at its cost");
  assert.equal(bookedMarks(entries).length, 1, "booked once");
});

test("a request whose cost comes after the wait: its answer is written at unknown cost and marked booked, and the next open adds nothing", { timeout: BOOKING_WAIT_MS * 5 }, async () => {
  const storage = new MemoryStorage();
  const late = lateBooking();
  const first = await opened(storage, late.adapter);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await until(() => first.events.includes("run_end"), BOOKING_WAIT_MS * 3);
  // The cost comes in after the answer was written: it stays with that entry.
  late.book();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A next turn in the same process flushes again: the late cost still belongs to the answer already written.
  assert.deepEqual(await first.app.door.submit({ requestId: "m2", content: "again", whenBusy: "followUp" }, first.door), { accepted: true });
  await until(() => first.events.filter((e) => e === "run_end").length === 2, BOOKING_WAIT_MS * 3);
  const before = await rootOf(first.harness);
  assert.deepEqual(answers(before).map((m) => m.usage?.cost?.total), [undefined], "one answer, its cost unknown");
  assert.equal(bookedMarks(before).length, 1, "marked booked");
  // A later process opens the run: the request is booked in its session, and already written.
  const next = await opened(storage, lateBooking().adapter);
  const after = await rootOf(next.harness);
  assert.equal(answers(after).length, 1, "no second entry for the same request");
  assert.equal(bookedMarks(after).length, 1, "still booked once");
});
