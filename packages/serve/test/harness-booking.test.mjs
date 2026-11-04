// A paid request's cost on a harness other than pi, when it is booked after the harness has its answer (the proxy answers
// before it books the response): the turn's end waits for it, so the answer is written with its cost, once. One whose
// cost does not come in time is written at unknown cost and marked booked, and its cost, when it comes, as an entry of
// its own: the run's spend (which its cap reads) counts it once, and the next open writes nothing more. Each answer names
// the model its request asked for, and its tokens go where its cost goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
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
  const answered = deferred();
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
          answered.resolve();
        },
        async recover() {},
        turnEnd: () => ended.promise,
        async interrupt() {},
        async close() {},
      };
    },
  };
  return { adapter, book: () => book.resolve(), answered: answered.promise };
}

/** An adapter whose turns run the scripts given, one per send. A script asks requests (`ask`, which gives each one's
 *  number), writes text, and books any request asked so far (`book`), in any order. A request whose booking a script
 *  leaves out is booked later, by `book` on what this returns, after its turn ended, as the proxy books a response
 *  when its stream closes. */
function scripted(turns) {
  const tickets = new Map();
  // Each turn's script finished, by its index: the turn's end on the harness's side, before the booking wait.
  const done = [];
  const doneOf = (i) => (done[i] ??= deferred());
  let io;
  const book = (request, usd) => io.models.afterRequest({ ...TOKENS, usd }, tickets.get(request));
  const adapter = {
    id: "late",
    version: "0",
    capabilities: () => ({ fork: false }),
    check: () => [],
    async open(_spec, given) {
      io = given;
      let ended = deferred();
      let next = 0;
      const ask = async () => {
        const ticket = await io.models.beforeRequest({ model: MODEL });
        tickets.set(ticket.turn, ticket);
        return ticket.turn;
      };
      const say = (text) => io.onEvent({ type: "text", delta: text });
      return {
        state: "new",
        async send() {
          ended = deferred();
          const at = next++;
          const script = turns[at];
          // A script may end its turn as the harness says it ended (a failure, say); by default it completed.
          const status = script ? await script({ ask, book, say }) : undefined;
          doneOf(at).resolve();
          ended.resolve(status ?? { status: "completed" });
        },
        async recover() {},
        turnEnd: () => ended.promise,
        async interrupt() {},
        async close() {},
      };
    },
  };
  return { adapter, book, ended: (i) => doneOf(i).promise };
}

const runOf = (harness) => ({ harness, env: async () => ({ confinePrefix: () => ["/usr/bin/setpriv", "--no-new-privs", "--"] }) });

async function opened(storage, adapter, wrap = (harness) => harness, watch = () => {}) {
  const harness = wrap(await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx));
  const app = adapterRun(async () => adapter, "late", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx);
  const events = [];
  app.door.attach((e) => (events.push(e.type), watch(e, app)));
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
/** The booking wait on a mocked clock that moves only when the test ticks it (`t.mock.timers`): what is queued runs
 *  out (`drained`), and `settles` waits on `check` with no timer, bounded on the real clock. */
const mockClock = (t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
const drained = () => new Promise((resolve) => setImmediate(resolve));
const settles = async (check, what) => {
  for (const end = performance.now() + 10_000; !(await check()); await drained()) assert.ok(performance.now() < end, what);
};

test("a request booked just after its turn ended: the turn's end waits for its cost, and the answer is written with it, booked once", async (t) => {
  mockClock(t);
  const storage = new MemoryStorage();
  const late = lateBooking();
  const { app, door, events, harness } = await opened(storage, late.adapter);
  assert.deepEqual(await app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, door), { accepted: true });
  // The turn has ended on the harness's side; its cost is still on its way.
  await late.answered;
  await drained();
  assert.ok(!events.includes("run_end"), "the run waits for the cost");
  // The clock never moves: the turn ends on its cost coming in, not on the wait running out.
  late.book();
  await settles(() => events.includes("run_end"), "the turn ends as soon as its cost is in");
  const entries = await rootOf(harness);
  assert.deepEqual(answers(entries).map((m) => [m.content.map((c) => c.text).join(""), m.usage?.cost?.total]), [["Answered.", 0.003]], "the answer, at its cost");
  assert.deepEqual(answers(entries).map(named), [{ provider: "late", model: MODEL, ...TOKENS, totalTokens: 57 }], "the model its request asked for, and its tokens");
  assert.equal(bookedMarks(entries).length, 1, "booked once");
});

test("a request whose cost comes after the wait: its answer is written at unknown cost and marked booked, its cost then counted once, and the next open adds nothing", async (t) => {
  mockClock(t);
  const storage = new MemoryStorage();
  const late = lateBooking();
  const first = await opened(storage, late.adapter);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await late.answered;
  await drained();
  assert.ok(!first.events.includes("run_end"), "the turn's end waits for the cost");
  t.mock.timers.tick(BOOKING_WAIT_MS);
  await settles(() => first.events.includes("run_end"), "the turn ends once the wait runs out");
  // Its cost not in yet: the run's cost reads unknown, never a known $0.
  assert.deepEqual(usage(await rootOf(first.harness)), { usd: null, requests: 1 }, "one request, its cost unknown while it is out");
  // The cost comes in after the answer was written: it goes in on its own, with no next turn to carry it.
  late.book();
  await settles(async () => spend(await rootOf(first.harness)) === 0.003, "the late cost is in the run's spend with no next turn");
  // A next turn in the same process flushes again: the late cost still belongs to the answer already written.
  assert.deepEqual(await first.app.door.submit({ requestId: "m2", content: "again", whenBusy: "followUp" }, first.door), { accepted: true });
  await settles(() => first.events.filter((e) => e === "run_end").length === 2, "the next turn ends");
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

test("a late cost the session booked but the root never got (its process went first) is written by the next open, once", async (t) => {
  mockClock(t);
  const storage = new MemoryStorage();
  const late = lateBooking();
  // The first process goes before it writes the late cost: its commit of that cost fails, as a process cut there.
  let went = 0;
  const cut = (harness) => new Proxy(harness, {
    get: (target, key) => key !== "commit" ? Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key) : (change, context) =>
      target.commit((tx) => change(new Proxy(tx, { get: (t, k) => (k === "appendEntry" ? (...args) => (args[1]?.kind === PRICED_LATE ? (went++, Promise.reject(new Error("the process went"))) : t.appendEntry(...args)) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) })), context),
  });
  const first = await opened(storage, late.adapter, cut);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await late.answered;
  await drained();
  t.mock.timers.tick(BOOKING_WAIT_MS);
  await settles(() => first.events.includes("run_end"), "the turn ends once the wait runs out");
  late.book();
  await settles(() => went > 0, "the first process tries to write the late cost");
  assert.equal(spend(await rootOf(first.harness)), 0, "the first process never wrote the late cost");
  // The next open writes what it finds before it is done opening.
  const next = await opened(storage, lateBooking().adapter);
  const after = await rootOf(next.harness);
  assert.equal(answers(after).length, 1, "one answer");
  assert.equal(spend(after), 0.003, "the next open wrote the cost the session booked");
  assert.deepEqual(usage(after, true), { usd: 0.003, requests: 1 }, "one request, at its cost");
  assert.equal(bookedMarks(after).length, 1, "booked once");
  assert.equal(after.filter((e) => e.kind === PRICED_LATE).length, 1, "its late cost written once");
  assert.deepEqual(after.find((e) => e.kind === PRICED_LATE).data.usage, TOKENS, "with the tokens the session booked");
});

/** The requests an entry kind names, in the root's order. */
const requestsOf = (entries, kind) => entries.filter((e) => e.kind === kind).map((e) => e.data.request);
const lateCosts = (entries) => entries.filter((e) => e.kind === PRICED_LATE).map((e) => [e.data.request, e.data.usd]);
/** How many times each request's cost is written: with its answer (BOOKED, not unpriced), or after it (PRICED_LATE). */
const pricings = (entries) => {
  const counts = {};
  for (const e of entries) if ((e.kind === BOOKED && e.data.unpriced !== true) || e.kind === PRICED_LATE) counts[e.data.request] = (counts[e.data.request] ?? 0) + 1;
  return counts;
};

/** Turn `i` of `script` has ended on the harness's side with a booking still out: the turn's end waits for it until the
 *  booking wait runs out on the mocked clock, then the run ends its turn (its `ends`-th run_end). */
const waitedOut = async (t, script, i, events, ends) => {
  await script.ended(i);
  await drained();
  t.mock.timers.tick(BOOKING_WAIT_MS);
  await settles(() => events.filter((e) => e === "run_end").length === ends, `turn ${i + 1} ends once the wait runs out`);
};

test("a late cost booked after a later request's (held past its turn's wait, and past the next request's booking) is written at once, once: the run's cost is known as that turn ends, not after an open", async (t) => {
  mockClock(t);
  const storage = new MemoryStorage();
  // Request 1's booking is held past its turn's end. In the next turn request 2 is booked first, then request 1.
  const script = scripted([
    async ({ ask, say }) => {
      await ask();
      say("First.");
    },
    async ({ ask, book, say }) => {
      const second = await ask();
      say("Second.");
      await book(second, 0.002);
      await book(1, 0.003);
    },
  ]);
  const first = await opened(storage, script.adapter);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await waitedOut(t, script, 0, first.events, 1);
  assert.deepEqual(usage(await rootOf(first.harness)), { usd: null, requests: 1 }, "request 1 written at unknown cost, its cost still out");
  assert.deepEqual(await first.app.door.submit({ requestId: "m2", content: "again", whenBusy: "followUp" }, first.door), { accepted: true });
  // Turn 2 books both of its costs in the turn: it ends on them, the clock never moved.
  await settles(() => first.events.filter((e) => e === "run_end").length === 2, "turn 2 ends");
  const entries = await rootOf(first.harness);
  assert.deepEqual(lateCosts(entries), [[1, 0.003]], "request 1's late cost, once");
  assert.deepEqual(usage(entries), { usd: 0.005, requests: 2 }, "the run's cost is known as the turn ends");
  assert.equal(spend(entries), 0.005, "each cost counted once, as the cap's spend reads a store");
  assert.deepEqual(requestsOf(entries, BOOKED), [1, 2], "each request written once");
  assert.deepEqual(pricings(entries), { 1: 1, 2: 1 }, "and each one's cost once");
  // A later process opens the run: it has nothing left to write.
  const next = await opened(storage, scripted([]).adapter);
  const after = await rootOf(next.harness);
  assert.deepEqual(lateCosts(after), [[1, 0.003]], "still one late cost");
  assert.deepEqual(requestsOf(after, BOOKED), [1, 2], "still each request once");
  assert.equal(spend(after), 0.005, "nor any cost counted twice");
  assert.deepEqual(usage(after, true), { usd: 0.005, requests: 2 });
});

test("costs that trail their requests by more than a turn: each request still gets one entry and its cost once, so the run's cost is known once they are in, not after an open", async (t) => {
  mockClock(t);
  const storage = new MemoryStorage();
  // Turn 1 asks requests 1 and 2: 2 is booked, 1 is held past the turn's end. Turn 2 asks request 3 and books request 1;
  // request 3 is booked only after turn 2 has ended.
  const script = scripted([
    async ({ ask, book, say }) => {
      await ask();
      say("Calling.");
      const second = await ask();
      say(" Done.");
      await book(second, 0.002);
    },
    async ({ ask, book, say }) => {
      await ask();
      say("Again.");
      await book(1, 0.001);
    },
  ]);
  const first = await opened(storage, script.adapter);
  assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
  await waitedOut(t, script, 0, first.events, 1);
  assert.deepEqual(await first.app.door.submit({ requestId: "m2", content: "again", whenBusy: "followUp" }, first.door), { accepted: true });
  await waitedOut(t, script, 1, first.events, 2);
  await script.book(3, 0.004);
  await settles(async () => spend(await rootOf(first.harness)) === 0.007, "request 3's cost is in, with no turn running");
  const entries = await rootOf(first.harness);
  assert.deepEqual(requestsOf(entries, BOOKED).sort((a, b) => a - b), [1, 2, 3], "every request on the root, once");
  assert.deepEqual(pricings(entries), { 1: 1, 2: 1, 3: 1 }, "each one's cost written once, with its entry or after it");
  assert.equal(spend(entries), 0.007, "each cost counted once");
  assert.deepEqual(usage(entries), { usd: 0.007, requests: 3 }, "the run's cost is known once its costs are in");
  const next = await opened(storage, scripted([]).adapter);
  const after = await rootOf(next.harness);
  assert.deepEqual(requestsOf(after, BOOKED).sort((a, b) => a - b), [1, 2, 3], "the next open writes no request again");
  assert.deepEqual(pricings(after), { 1: 1, 2: 1, 3: 1 }, "nor any cost");
  assert.equal(spend(after), 0.007);
});

test("a booking that comes in as the run ends: before its process lets the store go it is written, after that it is refused, and either way the next open books it once", async (t) => {
  mockClock(t);
  // Turn 1 asks requests 1 and 2: 2 is booked in the turn, 1 only after it, as the server decides the run is done and
  // stops its process. The process lets its store go by closing its Harness, which the release does first; the next
  // open reads the store as a new process opens it.
  const turn = async ({ ask, book, say }) => {
    await ask();
    say("Calling.");
    const second = await ask();
    say(" Done.");
    await book(second, 0.002);
  };
  const ended = async (storage, script) => {
    const first = await opened(storage, script.adapter);
    assert.deepEqual(await first.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, first.door), { accepted: true });
    await waitedOut(t, script, 0, first.events, 1);
    return first;
  };
  const reopened = async (storage) => {
    // A stand-in for the next process: MemoryStorage refuses every call once closed, a store file does not.
    storage.closed = false;
    return rootOf((await opened(storage, scripted([]).adapter)).harness);
  };
  // (i) Booked once the run's last turn ended, before the store is let go: written by this process, and not again.
  {
    const storage = new MemoryStorage();
    const script = scripted([turn]);
    const first = await ended(storage, script);
    await script.book(1, 0.001);
    await settles(async () => requestsOf(await rootOf(first.harness), BOOKED).includes(1), "written as it came in, with no turn running");
    await first.harness.close(ctx);
    const entries = await reopened(storage);
    assert.deepEqual(requestsOf(entries, BOOKED).sort((a, b) => a - b), [1, 2], "each request once");
    assert.deepEqual(pricings(entries), { 1: 1, 2: 1 }, "each cost once");
    assert.equal(spend(entries), 0.003, "the run's spend, as the store the release sealed has it");
  }
  // (ii) Booked after the store was let go: nothing is written, the booking included, and the next open books the request
  // once, cut, at a cost no one knows: never $0, never twice.
  {
    const storage = new MemoryStorage();
    const script = scripted([turn]);
    const first = await ended(storage, script);
    await first.harness.close(ctx);
    await assert.rejects(script.book(1, 0.001), "the closed store records nothing");
    const entries = await reopened(storage);
    assert.deepEqual(requestsOf(entries, BOOKED).sort((a, b) => a - b), [1, 2], "each request once: the cut one booked by the next open");
    assert.deepEqual(pricings(entries), { 1: 1, 2: 1 }, "each once");
    assert.deepEqual(usage(entries, true), { usd: null, requests: 2 }, "its cost unknown, never $0");
  }
});

/** A wrap for the run's Harness that can hold one commit before it reaches the store, chosen by what it writes: `hold(match)`
 *  makes the next commit with an entry `match` takes wait until `release()`, and `reached()` says it is waiting (a state a
 *  test waits on with `settles`). Its entries are read by running the change on a recorder first, only while a hold is set;
 *  a change that does more than append entries (it reads, or makes a conversation) throws there and is never held. Held
 *  before it is sent, it leaves the store's line free, so the run's other writes, a booking's among them, go on meanwhile.
 *  Each hold keeps its own gate: one set while another waits releases only itself. */
function holding() {
  let current;
  const entriesOf = async (change) => {
    const entries = [];
    const recorder = { appendEntry: async (...args) => void entries.push(args.length === 3 ? { conversation: args[1], ...args[2] } : { conversation: args[0], ...args[1] }) };
    try {
      await change(recorder);
    } catch {
      return [];
    }
    return entries;
  };
  const wrap = (harness) => new Proxy(harness, {
    get: (target, key) => key !== "commit" ? Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key) : async (change, context) => {
      const own = current;
      if (own && (await entriesOf(change)).some(own.match) && current === own) {
        current = undefined;
        own.reached = true;
        await own.gate.promise;
      }
      return target.commit(change, context);
    },
  });
  const hold = (match) => {
    const own = { match, gate: deferred(), reached: false };
    current = own;
    return { reached: () => own.reached, release: () => own.gate.resolve() };
  };
  return { wrap, hold };
}

test("a message that comes in while a turn's last costs are written waits its place: the run's start and end stay paired, and it never reads idle while it works", async (t) => {
  mockClock(t);
  const storage = new MemoryStorage();
  const held = holding();
  // Turn 1 books request 1 and asks request 2, then fails. Request 2 is booked only while the turn's error is being
  // written, so its cost is still to write as the turn ends; a follow-up comes in while that write waits.
  const script = scripted([
    async ({ ask, book, say }) => {
      const first = await ask();
      say("First.");
      await book(first, 0.001);
      await ask();
      return { status: "failed", error: "the harness failed" };
    },
    async ({ ask, book, say }) => {
      const third = await ask();
      say("Second.");
      await book(third, 0.003);
    },
  ]);
  // At each run_end, whether a turn was still working: a run_end then pairs a run_start it does not belong to.
  const busyAtEnd = [];
  const run = await opened(storage, script.adapter, held.wrap, (e, app) => e.type === "run_end" && busyAtEnd.push(app.door.busy()));
  const failure = held.hold((e) => typeof e.model?.[0]?.errorMessage === "string");
  assert.deepEqual(await run.app.door.submit({ requestId: "m1", content: "hi", whenBusy: "followUp" }, run.door), { accepted: true });
  // Request 2's booking is out as the turn ends: the turn's end waits for it until the wait runs out, then writes its error.
  await script.ended(0);
  await drained();
  t.mock.timers.tick(BOOKING_WAIT_MS);
  await settles(() => failure.reached(), "the turn's error entry, held");
  await script.book(2, 0.002);
  const cost = held.hold((e) => e.kind === BOOKED && e.data.request === 2);
  failure.release();
  await settles(() => cost.reached(), "the flush of request 2's cost, held");
  // The follow-up, while the turn's last cost waits to be written: what it does at once has run when the queue drains.
  const followUp = run.app.door.submit({ requestId: "m2", content: "again", whenBusy: "followUp" }, run.door);
  await drained();
  cost.release();
  assert.deepEqual(await followUp, { accepted: true });
  await settles(async () => assistants(await rootOf(run.harness)).some((m) => m.content.some((c) => c.text === "Second.")) && run.events.at(-1) === "run_end" && !run.app.door.busy(), "the follow-up's turn ends");
  assert.deepEqual(run.events.filter((e) => e === "run_start" || e === "run_end").every((e, i) => e === (i % 2 === 0 ? "run_start" : "run_end")), true, `each run_start ended before the next: ${run.events.join(" ")}`);
  assert.deepEqual(busyAtEnd.filter(Boolean), [], "no run_end while a turn worked");
  const entries = await rootOf(run.harness);
  assert.deepEqual(pricings(entries), { 1: 1, 2: 1, 3: 1 }, "each request's cost once");
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
