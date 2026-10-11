// The store conformance suite: what a RecoveryStore must hold for the driver's rules to rest on it. A store that
// passes carries them; a host that writes its own store registers this suite in its own tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryError } from "../errors.js";
import type { RecoveryBinding, RecoveryStore } from "../store.js";

const BOUND: RecoveryBinding = { binding: "binding-1", inputs: { workflow: "digest-a", "config.question": "digest-b" } };
const refused = (pattern?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof RecoveryError, `a store refuses with a RecoveryError, got ${String(error)}`);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

/** Registers the suite as `node:test` tests named under `name`. `create` returns a new, empty store on every call;
 *  the suite opens one store several times, as the successive processes of one run would. */
export function registerStoreConformance(name: string, create: () => RecoveryStore | Promise<RecoveryStore>): void {
  const it = (title: string, body: (store: RecoveryStore) => Promise<void>) => test(`${name}: ${title}`, async () => body(await create()));

  it("a new journal is unbound and empty, and its first open is generation 1", async (store) => {
    const journal = await store.open(BOUND);
    assert.deepEqual([journal.existing, journal.generation, journal.state, journal.revision], [false, 1, null, 0]);
    assert.deepEqual([journal.effects(), journal.notes(), journal.effect("absent")], [[], [], undefined]);
    await journal.close();
  });

  it("every write is one commit: the revision advances by one, and the next open reads what was committed", async (store) => {
    const first = await store.open(BOUND);
    assert.equal(await first.save({ step: 1 }), 1);
    assert.equal(await first.save((revision) => ({ step: 2, at: revision }), { kind: "escalation", detail: { why: "gate" } }), 2);
    assert.equal(await first.note("inherited", { level: "full" }), 3);
    assert.equal(first.revision, 3);
    assert.deepEqual(first.notes().map((note) => [note.revision, note.kind, note.detail]), [[2, "escalation", { why: "gate" }], [3, "inherited", { level: "full" }]]);
    await first.close();
    const second = await store.open(BOUND);
    assert.deepEqual([second.existing, second.generation, second.revision], [true, 2, 3]);
    assert.deepEqual(second.state, { step: 2, at: 2 });
    assert.deepEqual(second.notes().map((note) => [note.revision, note.kind, note.detail]), [[2, "escalation", { why: "gate" }], [3, "inherited", { level: "full" }]]);
    assert.ok(second.notes().every((note) => !Number.isNaN(Date.parse(note.at))));
    await second.close();
  });

  it("commits asked for together land one at a time, in the order they were asked for", async (store) => {
    const journal = await store.open(BOUND);
    const revisions = await Promise.all([journal.save({ n: 1 }), journal.save({ n: 2 }), journal.note("handoff", {}), journal.save({ n: 3 })]);
    assert.deepEqual(revisions, [1, 2, 3, 4]);
    await journal.close();
    const next = await store.open(BOUND);
    assert.deepEqual([next.state, next.revision], [{ n: 3 }, 4]);
    await next.close();
  });

  it("admit commits the effect with the state that admits it; an id already admitted is returned as it stands and writes nothing", async (store) => {
    const first = await store.open(BOUND);
    assert.equal(await first.admit("e1", "lookup", "args-1", { admitted: ["e1"] }, "run-1"), "new");
    assert.equal(first.revision, 1);
    const held = { id: "e1", name: "lookup", argsHash: "args-1", status: "unknown", session: "run-1", result: null };
    assert.deepEqual(await first.admit("e1", "other", "args-2", { admitted: [] }), held);
    assert.equal(first.revision, 1);
    await first.close();
    const second = await store.open(BOUND);
    assert.deepEqual(second.state, { admitted: ["e1"] });
    assert.deepEqual(second.effects(), [held]);
    assert.deepEqual(second.effect("e1"), held);
    await second.close();
  });

  it("an effect admitted and never completed is unknown at every later open", async (store) => {
    const first = await store.open(BOUND);
    await first.admit("e1", "lookup", "args-1", {});
    await first.called("e1", [{ tool: "lookup", ok: false }]);
    await first.close();
    for (const generation of [2, 3]) {
      const later = await store.open(BOUND);
      assert.deepEqual([later.generation, later.effect("e1")?.status, later.effect("e1")?.result, later.effect("e1")?.session], [generation, "unknown", null, null]);
      await later.close();
    }
  });

  it("complete stores the result with the state that follows, once, and never without an admission", async (store) => {
    const first = await store.open(BOUND);
    await first.admit("e1", "lookup", "args-1", { phase: "admitted" });
    await assert.rejects(first.complete("e0", { value: 1 }, {}), refused());
    await first.complete("e1", { value: 7, files: {} }, { phase: "completed" });
    await assert.rejects(first.complete("e1", { value: 8 }, { phase: "twice" }), refused());
    assert.deepEqual([first.effect("e1")?.status, first.effect("e1")?.result], ["completed", { value: 7, files: {} }]);
    await first.close();
    const second = await store.open(BOUND);
    assert.deepEqual([second.state, second.effect("e1")?.status, second.effect("e1")?.result], [{ phase: "completed" }, "completed", { value: 7, files: {} }]);
    await second.close();
  });

  it("an effect completed with no state keeps the state the open found: a reconciliation", async (store) => {
    const first = await store.open(BOUND);
    await first.admit("e1", "lookup", "args-1", { phase: "admitted" });
    await first.close();
    const operator = await store.open(BOUND);
    await operator.complete("e1", { value: 7 });
    await operator.close();
    const third = await store.open(BOUND);
    assert.deepEqual([third.state, third.effect("e1")?.status, third.effect("e1")?.result], [{ phase: "admitted" }, "completed", { value: 7 }]);
    await third.close();
  });

  it("calls are kept only for an admitted effect, and keeping them completes nothing", async (store) => {
    const journal = await store.open(BOUND);
    await assert.rejects(journal.called("e1", []), refused());
    await journal.admit("e1", "lookup", "args-1", {});
    await journal.called("e1", [{ tool: "lookup" }]);
    assert.deepEqual([journal.revision, journal.effect("e1")?.status], [2, "unknown"]);
    await journal.close();
  });

  it("a journal has one owner: a second open of a live journal is refused, and closing lets the next one in", async (store) => {
    const owner = await store.open(BOUND);
    await owner.save({ by: "owner" });
    await assert.rejects(store.open(BOUND), refused());
    await owner.save({ by: "owner", still: true });
    await owner.close();
    await owner.close();
    const next = await store.open(BOUND);
    assert.deepEqual([next.generation, next.state], [2, { by: "owner", still: true }]);
    await next.close();
  });

  it("a closed journal commits nothing", async (store) => {
    const first = await store.open(BOUND);
    await first.save({ kept: true });
    await first.close();
    await assert.rejects(first.save({ kept: false }), refused());
    await assert.rejects(first.admit("e1", "lookup", "args-1", {}), refused());
    const second = await store.open(BOUND);
    assert.deepEqual([second.state, second.revision, second.effects()], [{ kept: true }, 1, []]);
    await second.close();
  });

  it("a binding that differs is refused naming the inputs that moved; the journal stays as it was", async (store) => {
    const first = await store.open(BOUND);
    await first.save({ kept: true });
    await first.close();
    const moved = { binding: "binding-2", inputs: { workflow: "digest-a", "config.question": "digest-c", cwd: "digest-d" } };
    await assert.rejects(store.open(moved), (error: unknown) => {
      refused(/^Run store binding mismatch: config\.question, cwd \(new\) changed since the run was bound$/)(error);
      assert.deepEqual([(error as { code?: unknown }).code, (error as { moved?: unknown }).moved], ["RUN_STORE_BINDING_MISMATCH", ["config.question", "cwd"]]);
      return true;
    });
    await assert.rejects(store.open({ binding: "binding-2" }), refused(/^Run store binding mismatch: the opener named no input digests, so the input that moved cannot be named$/));
    const again = await store.open(BOUND);
    assert.deepEqual([again.existing, again.generation, again.state], [true, 2, { kept: true }]);
    await again.close();
  });

  it("values are stored as plain JSON, and a write that cannot be stored writes nothing at all", async (store) => {
    const first = await store.open(BOUND);
    await first.save({ kept: 1, dropped: undefined, nested: [undefined, { at: new Date(0) }] });
    await assert.rejects(first.save({ bad: Number.NaN }), refused());
    await assert.rejects(first.admit("e1", "lookup", "args-1", { bad: Number.POSITIVE_INFINITY }), refused());
    assert.deepEqual([first.revision, first.effects()], [1, []]);
    assert.equal(await first.save(undefined), 2);
    await first.close();
    const second = await store.open(BOUND);
    assert.deepEqual([second.state, second.revision, second.effects()], [null, 2, []]);
    await second.close();
    const third = await store.open(BOUND);
    await third.save({ kept: 1, dropped: undefined, nested: [undefined, { at: new Date(0) }] });
    await third.close();
    const fourth = await store.open(BOUND);
    assert.deepEqual(fourth.state, { kept: 1, nested: [null, { at: "1970-01-01T00:00:00.000Z" }] });
    await fourth.close();
  });
}
