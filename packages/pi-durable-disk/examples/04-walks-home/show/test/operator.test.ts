import assert from "node:assert/strict";
import { test } from "node:test";
import { bySlot } from "../reduce.ts";
import { ScenarioPlayer } from "../scenario.ts";

const op = () => new ScenarioPlayer({ seed: 5, origin: 0, operator: true });
const T = (p: ScenarioPlayer, s: number) => p.advance(s * 1000);

test("in operator mode nothing moves until a command", () => {
  const p = op();
  T(p, 600);
  assert.equal(p.state.place.where, "tab");
  assert.equal(Object.keys(p.state.universes).length, 0);
  assert.equal(p.state.stays.length, 1);
});

test("operator run: sandbox, VM, fanout, kill, collapse, home ends where the scripted run ends", () => {
  const p = op();
  assert.deepEqual(p.command({ t: "switch", to: "sandbox" }), { ok: true });
  T(p, 5);
  assert.deepEqual(p.command({ t: "switch", to: "vm" }), { ok: true });
  T(p, 10);
  assert.deepEqual(p.command({ t: "fanout" }), { ok: true });
  T(p, 40);
  assert.ok(bySlot(p.state).every((u) => u?.status === "training"), "eight universes are training and none was killed or sealed by itself");
  const victim = bySlot(p.state)[1]!;
  assert.ok(p.command({ t: "kill", universe: victim.id }).ok);
  T(p, 50);
  assert.deepEqual(p.command({ t: "collapse" }), { ok: true });
  assert.equal(Object.values(p.state.universes).filter((u) => u.status === "winner").length, 1);
  assert.equal(p.state.place.where, "universes", "collapse alone does not bring the run home");
  assert.deepEqual(p.command({ t: "switch", to: "home" }), { ok: true });
  T(p, 70);
  assert.equal(p.state.place.where, "home");
  const hosts = p.state.stays.filter((s) => s.lane === "run").map((s) => s.host);
  assert.deepEqual(hosts, ["Browser tab", "Modal sandbox", "Modal VM", "8 Modal GPUs", "Home (tab)"]);
  assert.equal(p.state.cost.ratePerMin, 0, "nothing is billed at home");
});

test("collapse keeps the universe the operator names, and refuses one that is not live", () => {
  const p = op();
  p.command({ t: "fanout" });
  T(p, 30);
  const pick = bySlot(p.state)[3]!;
  assert.equal(p.command({ t: "collapse", winner: "nope" }).ok, false);
  assert.deepEqual(p.command({ t: "collapse", winner: pick.id }), { ok: true });
  assert.equal(p.state.universes[pick.id].status, "winner");
});

test("refusals say why: gpu has no switch, universes block a switch, a repeat is refused, a second fanout is refused", () => {
  const p = op();
  assert.match(p.command({ t: "switch", to: "gpu" }).message!, /fanout/);
  assert.match(p.command({ t: "switch", to: "tab" }).message!, /already/);
  assert.match(p.command({ t: "switch", to: "mars" }).message!, /no environment/);
  assert.match(p.command({ t: "collapse" }).message!, /no live universes/);
  p.command({ t: "fanout" });
  T(p, 20);
  assert.match(p.command({ t: "switch", to: "sandbox" }).message!, /universes/);
  assert.match(p.command({ t: "fanout" }).message!, /not at rest|already/);
});

test("the scripted feed refuses operator commands with a reason", () => {
  const p = new ScenarioPlayer({ origin: 0 });
  assert.match(p.command({ t: "fanout" }).message!, /scripted/);
  assert.match(p.command({ t: "collapse" }).message!, /scripted/);
});

test("scores are metres walked and the run says so", () => {
  const p = op();
  assert.equal(p.state.scoreUnit, "");
  T(p, 1);
  assert.equal(p.state.scoreUnit, "m walked in 10 s");
  p.command({ t: "fanout" });
  T(p, 60);
  for (const u of Object.values(p.state.universes)) if (u.score !== null) assert.ok(u.score >= 0 && u.score < 6, `${u.id} ${u.score}`);
});
