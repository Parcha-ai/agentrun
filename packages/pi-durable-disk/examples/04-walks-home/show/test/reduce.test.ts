import assert from "node:assert/strict";
import { test } from "node:test";
import { bySlot, emptyState, fallen, fold, reduce, spares } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

const run: ShowEvent = { t: "run", at: 0, run: "demo-1", origin: 1000, environments: [{ id: "tab", label: "Browser tab", kind: "tab" }] };

test("a universe patch creates it and keeps its history across patches", () => {
  const s = fold([
    run,
    { t: "universe", at: 10, id: "u1", patch: { slot: 0, status: "starting", host: "Modal GPU u1", hostKind: "gpu", reward: "speed" } },
    { t: "sample", at: 20, id: "u1", score: 1.5, progress: 0.1, cost: 0.02 },
    { t: "universe", at: 30, id: "u1", patch: { status: "training" } },
  ]);
  const u = s.universes.u1;
  assert.equal(u.status, "training");
  assert.equal(u.host, "Modal GPU u1");
  assert.deepEqual(u.samples, [{ at: 20, score: 1.5 }]);
  assert.equal(u.score, 1.5);
  assert.equal(u.cost, 0.02);
  assert.equal(u.lastEventAt, 30);
  assert.equal(s.now, 30);
});

test("a late or duplicate sample does not rewind the score", () => {
  const s = fold([
    { t: "sample", at: 50, id: "u1", score: 4 },
    { t: "sample", at: 50, id: "u1", score: 99 },
    { t: "sample", at: 40, id: "u1", score: -3 },
  ]);
  assert.deepEqual(s.universes.u1.samples, [{ at: 50, score: 4 }]);
  assert.equal(s.universes.u1.score, 4);
});

test("reduce never mutates its input", () => {
  const before = fold([run, { t: "universe", at: 1, id: "u1", patch: { slot: 2, status: "training" } }]);
  const frozen = JSON.stringify(before);
  reduce(before, { t: "universe", at: 2, id: "u1", patch: { status: "killed" } });
  reduce(before, { t: "sample", at: 3, id: "u1", score: 1 });
  assert.equal(JSON.stringify(before), frozen);
});

test("kill, takeover: the killed universe holds its cell until the spare takes it, then falls to the tray", () => {
  let s = fold([
    run,
    { t: "universe", at: 1, id: "u3", patch: { slot: 3, status: "training", host: "A" } },
    { t: "universe", at: 1, id: "spare1", patch: { slot: null, status: "spare", host: "B" } },
  ]);
  assert.equal(spares(s).length, 1);
  s = reduce(s, { t: "universe", at: 100, id: "u3", patch: { status: "killed" } });
  assert.equal(bySlot(s)[3]?.id, "u3");
  assert.equal(bySlot(s)[3]?.status, "killed");
  s = reduce(s, { t: "universe", at: 110, id: "spare1", patch: { slot: 3, status: "takeover", replaces: "u3" } });
  s = reduce(s, { t: "universe", at: 110, id: "u3", patch: { slot: null, replacedBy: "spare1" } });
  assert.equal(bySlot(s)[3]?.id, "spare1");
  assert.deepEqual(fallen(s).map((u) => u.id), ["u3"]);
  assert.equal(spares(s).length, 0);
});

test("a spare retired unused at collapse is sealed with no slot and is not a casualty", () => {
  const s = fold([
    { t: "universe", at: 1, id: "spare2", patch: { slot: null, status: "spare", host: "B" } },
    { t: "universe", at: 9, id: "spare2", patch: { slot: null, status: "sealed" } },
    { t: "universe", at: 9, id: "u4", patch: { slot: null, status: "killed", host: "A" } },
  ]);
  assert.deepEqual(fallen(s).map((u) => u.id), ["u4"]);
});

test("stays: a repeated stay.begin is ignored and a repeated stay.end keeps its first end time", () => {
  const begin: ShowEvent = { t: "stay.begin", at: 5, stay: { id: "s1", lane: "run", host: "tab", hostKind: "tab", from: 5 } };
  let s = fold([begin, begin]);
  assert.equal(s.stays.length, 1);
  s = fold([{ t: "stay.end", at: 9, id: "s1", endedBy: "switch" }, { t: "stay.end", at: 99, id: "s1", endedBy: "killed" }], s);
  assert.equal(s.stays[0].to, 9);
  assert.equal(s.stays[0].endedBy, "switch");
});

test("an empty state is the identity start", () => {
  assert.deepEqual(fold([]), emptyState());
});
