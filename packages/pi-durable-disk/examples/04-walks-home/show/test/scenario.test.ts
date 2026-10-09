import assert from "node:assert/strict";
import { test } from "node:test";
import { bySlot, fallen, fold, spares } from "../reduce.ts";
import { ScenarioPlayer } from "../scenario.ts";

const opts = { seed: 3, origin: 0 };
const T = (p: ScenarioPlayer, s: number) => p.advance(s * 1000);

test("the same seed and commands give the same events", () => {
  const a = new ScenarioPlayer(opts);
  const b = new ScenarioPlayer(opts);
  T(a, 400);
  T(b, 400);
  assert.deepEqual(a.events, b.events);
});

test("the player's state is the fold of its events", () => {
  const p = new ScenarioPlayer(opts);
  T(p, 400);
  assert.deepEqual(p.state, fold(p.events));
});

test("the run walks tab, sandbox, VM, universes, home, in that order, each handover on the run lane", () => {
  const p = new ScenarioPlayer(opts);
  T(p, 400);
  const hosts = p.state.stays.filter((s) => s.lane === "run").map((s) => s.host);
  assert.deepEqual(hosts, ["Browser tab", "Modal sandbox", "Modal VM", "8 Modal GPUs", "Home (tab)"]);
  const run = p.state.stays.filter((s) => s.lane === "run");
  for (const s of run.slice(1)) assert.ok(s.handover && s.handover.ms >= 900 && s.handover.planned, s.host);
  assert.equal(p.state.place.where, "home");
  // Exactly one open stay on the run lane: the run is in one place.
  assert.equal(run.filter((s) => s.to === null).length, 1);
});

test("fan-out makes 8 universes in 8 cells plus 2 spares, all training before the first checkpoint window closes", () => {
  const p = new ScenarioPlayer({ ...opts, autoKillAfter: null });
  T(p, 16 + 24 + 30 + 12);
  assert.equal(bySlot(p.state).filter(Boolean).length, 8);
  assert.equal(spares(p.state).length, 2);
  assert.ok(bySlot(p.state).every((u) => u && u.status === "training"));
});

test("a kill command is followed by a spare taking the cell in takeoverSeconds, resuming the killed score", () => {
  const p = new ScenarioPlayer({ ...opts, autoKillAfter: null });
  T(p, 16 + 24 + 30 + 40);
  const victim = bySlot(p.state)[2]!;
  assert.equal(victim.status, "training");
  const scoreAtKill = victim.score;
  const killAt = p.now;
  assert.deepEqual(p.command({ t: "kill", universe: victim.id }), { ok: true });
  p.advance(killAt + 300);
  assert.equal(bySlot(p.state)[2]!.status, "killed", "the dead tile stays readable before the spare claims it");
  p.advance(killAt + 900);
  const cell = bySlot(p.state)[2]!;
  assert.equal(cell.status, "takeover");
  assert.equal(cell.replaces, victim.id);
  assert.equal(p.state.universes[victim.id].slot, null);
  assert.equal(p.state.universes[victim.id].replacedBy, cell.id);
  p.advance(killAt + 2000);
  const after = bySlot(p.state)[2]!;
  assert.equal(after.status, "training");
  assert.equal(after.score, scoreAtKill);
  const stay = p.state.stays.filter((s) => s.lane === `u:${after.id}`).at(-1)!;
  assert.equal(stay.handover?.planned, false);
  assert.ok(stay.handover!.ms <= 2000);
  assert.deepEqual(fallen(p.state).map((u) => u.id), [victim.id]);
  assert.equal(p.state.stays.find((s) => s.lane === `u:${victim.id}`)?.endedBy, "killed");
});

test("killing with no spare left loses the universe and says so", () => {
  const p = new ScenarioPlayer({ ...opts, autoKillAfter: null, spares: 1 });
  T(p, 16 + 24 + 30 + 40);
  const [a, b] = [bySlot(p.state)[0]!, bySlot(p.state)[1]!];
  assert.ok(p.command({ t: "kill", universe: a.id }).ok);
  p.advance(p.now + 100);
  assert.ok(p.command({ t: "kill", universe: b.id }).ok);
  assert.match(p.state.notes.at(-1)!.text, /No spare/);
  assert.equal(p.state.universes[b.id].status, "killed");
});

test("a dead or unknown universe cannot be killed twice", () => {
  const p = new ScenarioPlayer({ ...opts, autoKillAfter: null });
  T(p, 16 + 24 + 30 + 40);
  const v = bySlot(p.state)[4]!;
  assert.ok(p.command({ t: "kill", universe: v.id }).ok);
  assert.equal(p.command({ t: "kill", universe: v.id }).ok, false);
  assert.equal(p.command({ t: "kill", universe: "nope" }).ok, false);
});

test("the highest score wins, the rest and the spares are sealed, and the winner is the only unsealed universe", () => {
  const p = new ScenarioPlayer(opts);
  T(p, 400);
  const all = p.universes();
  const winners = all.filter((u) => u.status === "winner");
  assert.equal(winners.length, 1);
  const best = Math.max(...all.filter((u) => u.slot !== null || u.status === "winner").map((u) => u.score ?? 0));
  assert.equal(winners[0].score, best);
  assert.ok(all.filter((u) => u.status !== "winner").every((u) => u.status === "sealed" || u.status === "killed"));
});

test("cost only grows, and its rate is zero in the tab and positive while GPUs train", () => {
  const p = new ScenarioPlayer({ ...opts, autoKillAfter: null });
  let last = 0;
  const rates: Record<string, number> = {};
  const peak: Record<string, number> = {};
  for (let s = 1; s <= 300; s++) {
    T(p, s);
    assert.ok(p.state.cost.usd >= last);
    last = p.state.cost.usd;
    const w = p.state.place.where;
    rates[w] = p.state.cost.ratePerMin;
    peak[w] = Math.max(peak[w] ?? 0, p.state.cost.ratePerMin);
  }
  assert.equal(peak.tab, 0);
  assert.ok(peak.universes > peak.cloud, "eight GPUs cost more than one VM");
  assert.equal(rates.home, 0, "the GPUs are released when the run comes home");
});

test("a switch command during the fan-out is refused with a reason", () => {
  const p = new ScenarioPlayer({ ...opts, autoKillAfter: null });
  T(p, 16 + 24 + 30 + 20);
  const r = p.command({ t: "switch", to: "tab" });
  assert.equal(r.ok, false);
  assert.match(r.message!, /universes/);
});
