// A run's view is of one moment (it replaces the file-store test of that name): a single GET of a run reads one
// consistent snapshot of the store, while the run's runner goes on writing. The run's status, its result, its cost,
// its pending approval and its timeline rows all come from the same moment, whichever read of the view the runner's
// write lands after.
//
// The write is the runner's end of a run parked on an approval: the person's answer and the model's final answer, in
// one journal commit, then the run's row ended. It is made on a second connection to the same store, as the runner (a
// process of its own) makes it, and landed between every pair of the view's store reads in turn (a hook on the store's
// own reads, those inside a snapshot included; no sleep and no clock). Each view that comes back must be exactly the
// view of the run before the write, or exactly the view of it after, never a mix of the two. SQLite or Postgres, as
// the suite runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore } = await import("../dist/store-view.js");
const { servedTimelineRows } = await import("../dist/run-timeline-served.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const iso = (ms) => new Date(ms).toISOString();
const DEPS = { origin: "https://run.test", serverSecrets: () => [] };
const SERVED = { serverSecrets: () => [], keyEnv: () => ({}) };

/** A run parked on a tool call's approval: its claim let go, the call asked and not answered. */
async function parkedRun(t) {
  const { store, file } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Fetch it." }, title: "One moment", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Fetch it.", timestamp: T0 }] };
  const call = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_fetch", arguments: { url: "https://example.test" } }], usage: { cost: { total: 0 } }, timestamp: T0 + 1_000 }] };
  const ask = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.ask", data: { callId: "c1", tool: "web_fetch", args: { url: "https://example.test" }, requestedAt: iso(T0 + 1_500), price: 0.02 } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: user }, { type: "entry", value: call }, { type: "entry", value: ask }], context);
  await store.release(claim);
  // The runner's own connection to the same store, which lands the write.
  const { store: runner } = await storeOn(t, { file, role: "runner" });
  return { store, runner };
}

/** The runner's next claim: the person's allow, the model's final answer with its cost, and the run ended, as a runner
 *  writes them. */
async function land(store) {
  const claim = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.answer", data: { callId: "c1", approved: true, decision: "allow", answeredAt: iso(T0 + 2_000) } };
  const final = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fetched." }], usage: { cost: { total: 0.25 } }, timestamp: T0 + 3_000 }] };
  await commitWrites(journal, [{ type: "entry", value: answer }, { type: "entry", value: final }], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Fetched.", costUsd: 0.25, endedAt: T0 + 5_000 });
}

const isThenable = (value) => typeof value?.then === "function";

/** `store`, with `after(n)` awaited once the store's n-th read (counting from 1, every read of its tree, journal reads
 *  included) has answered and before its answer is handed back: the write lands between that read and the next. A sync
 *  call (readJournal, which hands back the reads) is wrapped down into its own methods, and not counted itself. The store
 *  a snapshot hands its callback is wrapped the same way, and the snapshot itself is not counted: its reads are. */
function interleaved(store, after) {
  let reads = 0;
  const wrap = (target, path) =>
    new Proxy(target, {
      get(object, prop) {
        const value = Reflect.get(object, prop, object);
        if (typeof prop === "symbol") return value;
        if (typeof value === "function") {
          return (...args) => {
            if (prop === "snapshot") return value.call(object, (inside) => args[0](wrap(inside, `${path}.snapshot`)));
            const result = value.apply(object, args);
            if (!isThenable(result)) return result !== null && typeof result === "object" ? wrap(result, `${path}.${prop}`) : result;
            const n = ++reads;
            return result.then(async (answer) => {
              await after(n);
              return answer;
            });
          };
        }
        return value !== null && typeof value === "object" && !(value instanceof Map) && !(value instanceof Set) && !Buffer.isBuffer(value) ? wrap(value, `${path}.${prop}`) : value;
      },
    });
  return { store: wrap(store, "store"), reads: () => reads };
}

/** What a GET of the run and a GET of its timeline answer, read together over one store handle. */
const readers = async (store) => ({ view: await viewOverStore(store, "run-1", DEPS), timeline: await servedTimelineRows(SERVED, store, "run-1", {}) });

test("a run's view is of one moment: a write landing between any two of its reads shows whole, or not at all", async (t) => {
  // The run before the write and after it, each read with nothing in between.
  const beforeRun = await parkedRun(t);
  const before = await readers(beforeRun.store);
  const afterRun = await parkedRun(t);
  await land(afterRun.runner);
  const after = await readers(afterRun.store);
  assert.equal(before.view.status, "input_required");
  assert.equal(before.view.pending?.kind, "approval");
  assert.equal(after.view.status, "completed");
  assert.equal(after.view.result.final_answer, "Fetched.");
  assert.deepEqual(after.view.cost, { usd: 0.25, basis: "estimate", charge_state: null, cap_usd: null });
  assert.notDeepEqual(before.view, after.view);

  // How many reads one view makes, with nothing landing.
  const dry = interleaved((await parkedRun(t)).store, async () => {});
  await readers(dry.store);
  const total = dry.reads();
  assert.ok(total > 3, `the view reads the store more than once (${total})`);

  // Each interleaving is a subtest of its own: its two stores (a Postgres pool each) are closed when it ends, not held until
  // the whole test does, which a database's connection limit would not allow across the dozens of reads.
  for (let n = 1; n <= total; n++) {
    await t.test(`the write lands after read ${n} of ${total}`, async (sub) => {
    const mixed = [];
    const { store, runner } = await parkedRun(sub);
    let landed = false;
    const hooked = interleaved(store, async (read) => {
      if (read === n && !landed) {
        landed = true;
        await land(runner);
      }
    });
    const seen = await readers(hooked.store);
    for (const key of ["view", "timeline"]) {
      const is = (moment) => {
        try {
          assert.deepEqual(seen[key], moment[key]);
          return true;
        } catch {
          return false;
        }
      };
      if (!is(before) && !is(after)) {
        // What of the answer is from the run before the write and what is from after it.
        const parts = key === "view" ? Object.keys(seen.view) : [];
        const fields = parts.filter((field) => JSON.stringify(seen.view[field]) !== JSON.stringify(before.view[field]) && JSON.stringify(seen.view[field]) !== JSON.stringify(after.view[field]));
        const from = parts.filter((field) => JSON.stringify(before.view[field]) !== JSON.stringify(after.view[field])).map((field) => `${field}:${JSON.stringify(seen.view[field]) === JSON.stringify(after.view[field]) ? "after" : "before"}`);
        const shown = key === "view" ? `status ${seen.view.status}/${seen.view.state}, pending ${seen.view.pending?.kind ?? null}, result ${JSON.stringify(seen.view.result)}, cost ${JSON.stringify(seen.view.cost.usd)}` : `rows ${seen.timeline.map((row) => row.kind).join(",")} (before ${before.timeline.map((row) => row.kind).join(",")}; after ${after.timeline.map((row) => row.kind).join(",")})`;
        mixed.push(`${key}, write landed after read ${n} of ${total}: ${fields.length ? `neither ${fields.join(",")}` : from.join(" ")}; ${shown}`);
      }
    }
    assert.deepEqual(mixed, [], "each answer is the run as it was before the write, or as it was after, never a mix");
    });
  }
});

/** A store whose first snapshot, once it has answered, saves a value to the server's secrets: it is saved after the rows
 *  were read and before the cut is read again. */
function savingAfterSnapshot(store, save) {
  let saved = false;
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "snapshot") return typeof value === "function" ? value.bind(target) : value;
      return async (read) => {
        const answer = await value.call(target, read);
        if (!saved) {
          saved = true;
          save();
        }
        return answer;
      };
    },
  });
}

test("a value saved after the snapshot read a row that holds it is cut from that row: the cut is read again, and the rows rebuilt under it", async (t) => {
  const KEY = ["not-a-secret", "late-key", "0123456789abcdef"].join("-");
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Say it." }, title: "Late key", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Say it.", timestamp: T0 }] };
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `The key is ${KEY}.` }], usage: { cost: { total: 0.01 } }, timestamp: T0 + 1_000 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: user }, { type: "entry", value: answer }], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: `The key is ${KEY}.`, costUsd: 0.01, endedAt: T0 + 2_000 });

  // The held values: none when the rows are first read, the key once it is saved.
  let held = [];
  const secrets = () => held;
  const saving = () => savingAfterSnapshot(store, () => (held = [KEY]));
  const view = await viewOverStore(saving(), "run-1", { ...DEPS, serverSecrets: secrets });
  assert.ok(!JSON.stringify(view).includes(KEY), `the view holds the key saved after its rows were read: ${JSON.stringify(view.result)}`);
  assert.match(view.result.final_answer, /\[redacted\]/, "the answer is cut where the key was");

  held = [];
  const timeline = await servedTimelineRows({ ...SERVED, serverSecrets: secrets }, saving(), "run-1", {});
  assert.ok(!JSON.stringify(timeline).includes(KEY), "the timeline holds the key saved after its rows were read");
  assert.ok(timeline.some((row) => row.kind === "final_answer" && /\[redacted\]/.test(row.text ?? "")), "its answer row is cut where the key was");
});

test("a snapshot only reads: a write through its nested transaction is refused and changes nothing", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.snapshot(async (snapshot) => {
    await assert.rejects(snapshot.agents.archive("agent-1", true), /only reads/);
  });
  assert.equal((await store.agents.get("agent-1")).archivedAt ?? null, null);
});
