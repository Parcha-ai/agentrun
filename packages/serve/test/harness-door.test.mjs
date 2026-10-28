// The door of a run on a harness other than pi, over a session whose turns the test ends: a message while a turn runs
// waits for its end and is sent after it, in order, and comes back at the next open if the process dies first; a reject
// while busy is refused; a stop interrupts the turn and sends nothing more; a turn that fails ends with its error on the
// root; the turn's start and end go out on the door.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { adapterRun } from "../dist/harness-app.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** An adapter whose every turn waits for the test, and which records what it was asked. */
function heldAdapter() {
  const sent = [];
  const turns = [];
  let interrupts = 0;
  const adapter = {
    id: "held",
    version: "0",
    capabilities: () => ({ fork: false }),
    check: () => [],
    async open() {
      let current;
      return {
        state: "new",
        async send(text) {
          sent.push(text);
          current = deferred();
          turns.push(current);
        },
        async recover() {},
        turnEnd: () => current.promise,
        async interrupt() {
          interrupts += 1;
          current?.resolve({ status: "interrupted" });
        },
        async close() {},
      };
    },
  };
  return { adapter, sent, turns, interrupts: () => interrupts };
}

/** A run in memory whose environment confines its commands under `prefix`. */
const runOf = (harness, prefix = ["/usr/bin/setpriv", "--no-new-privs", "--"]) => ({ harness, env: async () => ({ confinePrefix: () => prefix }) });

/** The root's entries, oldest first. */
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
const errorsOf = (entries) => entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant" && m.stopReason === "error").map((m) => m.errorMessage));

/** A run's door and open over `storage` (a later process opens the same one), on `held` (a fresh held adapter). */
async function opened(storage = new MemoryStorage(), held = heldAdapter()) {
  const harness = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  const app = adapterRun(async () => held.adapter, "held", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx);
  const events = [];
  // As the door does when it opens: a turn the run starts itself (a recovery) reports through it too.
  app.door.attach((e) => events.push(e.type));
  await app.onOpen(runOf(harness));
  const door = { run: { harness }, signal: new AbortController().signal, emit: (e) => events.push(e.type), adopt: () => {} };
  const submit = (text, whenBusy = "followUp") => app.door.submit({ requestId: text, content: text, whenBusy }, door);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { app, held, door, events, submit, settle, harness, storage };
}

test("a message while a turn runs waits for its end and is sent after it, in order; a reject while busy is refused", async () => {
  const { app, held, events, submit, settle } = await opened();
  assert.deepEqual(await submit("one"), { accepted: true });
  await settle();
  assert.equal(app.door.busy(), true);
  assert.deepEqual(await submit("two"), { accepted: true });
  assert.deepEqual(await submit("three", "steer"), { accepted: true });
  assert.deepEqual(await submit("no", "reject"), { accepted: false, reason: "busy" });
  assert.deepEqual(held.sent, ["one"], "nothing else goes in while the turn runs");
  held.turns[0].resolve({ status: "completed" });
  await settle();
  assert.deepEqual(held.sent, ["one", "two"]);
  held.turns[1].resolve({ status: "completed" });
  await settle();
  held.turns[2].resolve({ status: "completed" });
  await settle();
  assert.deepEqual(held.sent, ["one", "two", "three"]);
  assert.equal(app.door.busy(), false);
  assert.deepEqual(events, ["run_start", "run_end"], "one busy period: the messages that waited are its turns, as a pi run's follow-ups are");
});

test("a stop interrupts the turn, drops what waited, and sends nothing more; idle, it says so", async () => {
  const { app, held, door, events, submit, settle } = await opened();
  assert.equal(await app.door.abort(door), "idle");
  await submit("one");
  await settle();
  await submit("waiting");
  assert.equal(await app.door.abort(door), "aborted");
  await settle();
  assert.equal(held.interrupts(), 1);
  assert.deepEqual(held.sent, ["one"], "no second send, and the waiting message is dropped");
  assert.equal(app.door.busy(), false);
  assert.deepEqual(events, ["run_start", "run_end"]);
});

test("the harness's process starts under the prefix pi's commands get in the run; a run that confines nothing gives the adapter no confinement at all", async () => {
  for (const [prefix, want] of [
    [["/usr/bin/setpriv", "--no-new-privs", "--"], { command: "/usr/bin/setpriv", args: ["--no-new-privs", "--", "codex", "app-server"] }],
    [[], undefined],
  ]) {
    const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: {} }, ctx);
    let given = "never called";
    const app = adapterRun(async (confine) => ((given = confine), heldAdapter().adapter), "held", { key: "run:1", label: "a", system: [], context: "fresh" }, ctx);
    await app.onOpen(runOf(harness, prefix));
    if (want === undefined) assert.equal(given, undefined, "no ConfineChild that adds nothing: an adapter refuses one at its first spawn");
    else assert.deepEqual(given({ command: "codex", args: ["app-server"] }), want);
  }
});

test("a message accepted while a turn runs is sent at the next open when the process dies first; one already sent is not sent again, one a stop dropped never", async () => {
  const first = await opened();
  await first.submit("one");
  await first.settle();
  await first.submit("two");
  assert.deepEqual(first.held.sent, ["one"]);
  // The process dies with "two" waiting: the next one, on the same store, sends it, and "one" is not sent again.
  const next = await opened(first.storage);
  await next.settle();
  assert.deepEqual(next.held.sent, ["two"]);
  next.held.turns[0].resolve({ status: "completed" });
  await next.settle();
  assert.deepEqual((await rootOf(next.harness)).flatMap((e) => (e.model ?? []).filter((m) => m.role === "user").map((m) => m.content[0].text)), ["one", "two"], "each message on the root once");
  // A stop drops what waited, and the next open does not bring it back.
  await next.submit("three");
  await next.settle();
  await next.submit("dropped");
  assert.equal(await next.app.door.abort(next.door), "aborted");
  const last = await opened(first.storage);
  await last.settle();
  assert.deepEqual(last.held.sent, [], "nothing waits: three was sent, the dropped message was dropped");
});

test("a turn that fails ends the run on its error: the error is on the root before the door's run_end, also when the send throws", async () => {
  const { held, events, submit, settle, harness } = await opened();
  await submit("one");
  await settle();
  held.turns[0].resolve({ status: "failed", error: "the provider refused the request" });
  await settle();
  assert.deepEqual(errorsOf(await rootOf(harness)), ["held: the provider refused the request"]);
  assert.deepEqual(events, ["run_start", "run_end"]);
  // A send that throws: the same.
  const broken = heldAdapter();
  const throwing = await opened(new MemoryStorage(), { ...broken, adapter: { ...broken.adapter, async open() { return { state: "new", async send() { throw new Error("the harness exited"); }, async recover() {}, turnEnd: async () => ({ status: "completed" }), async interrupt() {}, async close() {} }; } } });
  await throwing.submit("one");
  await throwing.settle();
  assert.deepEqual(errorsOf(await rootOf(throwing.harness)), ["held: the harness exited"]);
});

/** A run's store whose commits holding a request's cost are refused. */
class CostRefused extends MemoryStorage {
  async commit(writes, context) {
    if (JSON.stringify(writes).includes("runner.turn")) throw new Error("the disk is full");
    return super.commit(writes, context);
  }
}

test("a request whose cost cannot be written stops the turn: the booking admits no request after it, saying why", async () => {
  // The store refuses the write, and a refused commit leaves the run's Harness unable to write anything more: the
  // process ends on it and the next one resumes. Until then no request leaves, and the turn is stopped. (The turn here
  // holds, so the test ends before the process would.)
  let second;
  let interrupts = 0;
  const held = heldAdapter();
  held.adapter.open = async (_spec, io) => {
    let turn;
    return {
      state: "new",
      async send() {
        turn = (async () => {
          const ticket = await io.models.beforeRequest({ model: "m" });
          await io.models.afterRequest({ input: 1, output: 1, usd: 0.001 }, ticket).catch(() => {});
          second = await io.models.beforeRequest({ model: "m" }).then(() => "admitted", (error) => error.message);
          return new Promise(() => {});
        })();
      },
      async recover() {},
      turnEnd: () => turn,
      async interrupt() { interrupts += 1; },
      async close() {},
    };
  };
  const { submit, settle } = await opened(new CostRefused(), held);
  await submit("one");
  await settle();
  await settle();
  assert.match(second ?? "", /could not be recorded/, "the next request is refused for the cost the booking could not write");
  assert.ok(interrupts >= 1, "the turn is stopped");
});

test("a run reopened with a turn to recover and a message that waited for it is busy until both are done: no run_end between them, so the server never reads it idle with the message unanswered", async () => {
  const first = await opened();
  await first.submit("one");
  await first.settle();
  await first.submit("two");
  // The next process: its session has the cut turn to recover, and "two" waits on the root.
  const held = heldAdapter();
  const open = held.adapter.open;
  held.adapter.open = async (...args) => {
    const session = await open(...args);
    return Object.assign(session, { state: "open_turn", async recover() { held.turns.push(Object.assign(deferred(), {})); } , turnEnd: () => held.turns.at(-1).promise });
  };
  const next = await opened(first.storage, held);
  await next.settle();
  assert.deepEqual(held.sent, [], "the cut turn first");
  held.turns[0].resolve({ status: "completed" });
  await next.settle();
  assert.deepEqual(held.sent, ["two"], "then the message that waited");
  assert.deepEqual(next.events, ["run_start"], "still busy: the server must not read the run idle between them");
  held.turns[1].resolve({ status: "completed" });
  await next.settle();
  assert.deepEqual(next.events, ["run_start", "run_end"]);
});
