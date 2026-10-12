import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Attempt, CLOSING_M, CLOSING_WINDOW_S, FLAG, RUN_CAP_S, TRY_S, WALK_CROSSINGS_Y, parseAttemptRequest, sceneFile, type Ending } from '../src/goal.ts';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { Sim } from '../src/sim.ts';
import { STAND_S, UntrainedBrain } from '../src/untrained.ts';
import { mj } from './helpers.ts';

/** Feed an attempt that started at `t0` one sample per control step (0.02 s) from `path(t)` (t from its start) until it ends or `maxS` passes; the ending and when (from its start). */
function play(a: Attempt, path: (t: number) => { x: number; y: number; up?: number }, maxS = 30, t0 = 0): { ending: Ending | null; t: number } {
  for (let i = 1; i <= maxS / 0.02; i++) {
    const t = Math.round(i * 2) / 100;
    const p = path(t);
    const e = a.sample(t0 + t, p.x, p.y, p.up ?? 1);
    if (e) return { ending: e, t };
  }
  return { ending: null, t: maxS };
}
const walkTo = (speed: number, from = { x: 0, y: 0 }) => (t: number) => { const d = Math.hypot(FLAG.x - from.x, FLAG.y - from.y); return { x: from.x + ((FLAG.x - from.x) / d) * speed * t, y: from.y + ((FLAG.y - from.y) / d) * speed * t }; };

test("the flag stands beside where the walks go (D2's replays): every measured crossing of x = 3 m is within its reach with room to spare, and code10's walks past the pole, not through it", () => {
  for (const y of WALK_CROSSINGS_Y) assert.ok(Math.hypot(FLAG.x - 3, FLAG.y - y) <= FLAG.radius - 0.12, `a walk crossing at y ${y}`);
  for (const y of [-0.12, -0.08]) assert.ok(Math.abs(FLAG.y - y) >= 0.3, `code10's line at y ${y} clears the pole`);
  assert.equal(FLAG.x, 3, '3 m ahead');
  assert.deepEqual(JSON.parse(sceneFile()), { version: 1, flag: { x: FLAG.x, y: FLAG.y, radius: FLAG.radius } });
  assert.ok(sceneFile().endsWith('\n'));
});

test("a request is robot.json's attempt as the agent's do writes it: an id, a skill name, learned; anything else is no request", () => {
  assert.deepEqual(parseAttemptRequest({ id: 'call_1', skill: 'walk', learned: false }), { id: 'call_1', skill: 'walk', learned: false });
  assert.deepEqual(parseAttemptRequest({ id: 'call_2', skill: 'turn-left', learned: true, extra: 1 }), { id: 'call_2', skill: 'turn-left', learned: true });
  for (const bad of [null, 'walk', {}, { skill: 'walk', learned: true }, { id: '', skill: 'walk', learned: true }, { id: 'x'.repeat(201), skill: 'walk', learned: true }, { id: 'a', skill: 'walk now', learned: true }, { id: 'a', skill: 'walk', learned: 'yes' }, { id: 7, skill: 'walk', learned: true }]) {
    assert.equal(parseAttemptRequest(bad), null, JSON.stringify(bad));
  }
});

test('a try (no skill learned) lasts its window whatever happens: a fall is recorded and does not end it; it never reaches the flag', () => {
  const still = new Attempt({ id: 't1', skill: 'walk', learned: false }, { t: 10, x: 0, y: 0 });
  let r = play(still, () => ({ x: 0, y: 0 }), 3.98, 10);
  assert.equal(r.ending, null, 'still trying just before its window ends');
  assert.equal(still.sample(10 + TRY_S, 0.02, 0, 1), 'window');
  assert.equal(TRY_S, 4);
  assert.deepEqual(still.report(), { version: 1, id: 't1', skill: 'walk', learned: false, fell: false, distance_m: 0.02, to_flag_m: Math.round(Math.hypot(FLAG.x - 0.02, FLAG.y) * 100) / 100, reached_flag: false, started_at_flag: false, seconds: 4 });
  const falls = new Attempt({ id: 't2', skill: 'walk', learned: false }, { t: 0, x: 0, y: 0 });
  r = play(falls, (t) => ({ x: 0.05 * t, y: 0, up: t > 1.2 ? -0.4 : 1 }));
  assert.deepEqual(r, { ending: 'window', t: 4 });
  assert.equal(falls.report().fell, true);
  assert.equal(falls.report().reached_flag, false);
});

test('a learned walk ends when it reaches the flag: within the radius, the time it took, how far it went', () => {
  const a = new Attempt({ id: 'w1', skill: 'walk', learned: true }, { t: 0, x: 0, y: 0 });
  const r = play(a, walkTo(0.5));
  assert.equal(r.ending, 'reached');
  const rep = a.report();
  assert.equal(rep.reached_flag, true);
  assert.ok(rep.to_flag_m <= FLAG.radius, JSON.stringify(rep));
  assert.ok(Math.abs(rep.seconds - (Math.hypot(FLAG.x, FLAG.y) - FLAG.radius) / 0.5) < 0.05, JSON.stringify(rep));
  assert.ok(Math.abs(rep.distance_m - (Math.hypot(FLAG.x, FLAG.y) - FLAG.radius)) < 0.03, JSON.stringify(rep));
  assert.equal(rep.started_at_flag, false);
  assert.equal(rep.fell, false);
});

test(`a learned run that does not close on the flag (spin in place, backwards) is answered once ${CLOSING_WINDOW_S} s show it, not at the cap`, () => {
  const spin = new Attempt({ id: 's1', skill: 'spin', learned: true }, { t: 5, x: 0, y: 0 });
  assert.deepEqual(play(spin, () => ({ x: 0.01, y: 0 }), 30, 5), { ending: 'stalled', t: CLOSING_WINDOW_S });
  assert.equal(spin.report().reached_flag, false);
  assert.equal(spin.report().seconds, CLOSING_WINDOW_S);
  const back = new Attempt({ id: 'b1', skill: 'backwards', learned: true }, { t: 0, x: 0, y: 0 });
  assert.equal(play(back, (t) => ({ x: -0.3 * t, y: 0 })).ending, 'stalled');
  // closing by less than CLOSING_M over the window is not closing
  const creep = new Attempt({ id: 'c1', skill: 'walk', learned: true }, { t: 0, x: 0, y: 0 });
  assert.equal(play(creep, walkTo((CLOSING_M * 0.8) / CLOSING_WINDOW_S)).ending, 'stalled');
});

test('a slow walk that keeps closing on the flag runs to the cap', () => {
  const a = new Attempt({ id: 'w2', skill: 'walk', learned: true }, { t: 0, x: 0, y: 0 });
  const r = play(a, walkTo(0.15));
  assert.deepEqual(r, { ending: 'cap', t: RUN_CAP_S });
  assert.equal(a.report().reached_flag, false);
  assert.ok(Math.abs(a.report().to_flag_m - (Math.hypot(FLAG.x, FLAG.y) - 0.15 * RUN_CAP_S)) < 0.03);
});

test('a learned run that falls is answered at once, and says it fell', () => {
  const a = new Attempt({ id: 'f1', skill: 'walk', learned: true }, { t: 0, x: 0, y: 0 });
  const r = play(a, (t) => ({ ...walkTo(0.5)(t), up: t >= 1.5 ? 0.1 : 1 }));
  assert.deepEqual(r, { ending: 'fell', t: 1.5 });
  assert.equal(a.report().fell, true);
  assert.equal(a.report().reached_flag, false);
});

test('a run that starts at the flag cannot reach it (no "reached in 0 s"); it says it started there', () => {
  const a = new Attempt({ id: 'a1', skill: 'spin', learned: true }, { t: 0, x: FLAG.x + 0.05, y: FLAG.y });
  const r = play(a, () => ({ x: FLAG.x + 0.05, y: FLAG.y }));
  assert.equal(r.ending, 'stalled');
  assert.equal(a.report().started_at_flag, true);
  assert.equal(a.report().reached_flag, false);
});

test("the answer has exactly the fields the agent's do reads (D1's #315), in this order, and stays as it was after the run ended", () => {
  const a = new Attempt({ id: 'k1', skill: 'walk', learned: true }, { t: 0, x: 0, y: 0 });
  play(a, walkTo(0.5));
  const before = a.report();
  assert.deepEqual(Object.keys(before), ['version', 'id', 'skill', 'learned', 'fell', 'distance_m', 'to_flag_m', 'reached_flag', 'started_at_flag', 'seconds']);
  assert.equal(a.sample(99, -5, 5, -1), 'reached', 'an ended attempt keeps its ending');
  assert.deepEqual(a.report(), before);
});

test('the untrained brain ramps in from when it is attached, not from when the simulation started (a try starts mid-session)', () => {
  const sim = new Sim(mj, buildMjcf(defaultDesign()));
  for (let i = 0; i < 300; i++) sim.step(null); // six seconds standing
  sim.attachBrain(new UntrainedBrain(7));
  for (let i = 0; i < Math.floor(STAND_S / 0.02); i++) assert.ok(sim.step(null).every((v) => v === 0), `step ${i} after attaching`);
  let moved = 0;
  for (let i = 0; i < 100; i++) moved = Math.max(moved, ...sim.step(null).map(Math.abs));
  assert.ok(moved > 0.2, `it twitches once the ramp is in: ${moved}`);
});

test("a pose taken before a try puts the creature back exactly where and how it stood", () => {
  const sim = new Sim(mj, buildMjcf(defaultDesign()));
  for (let i = 0; i < 50; i++) sim.step(null);
  const pose = sim.pose();
  const qpos = Array.from(sim.data.qpos as Float64Array), qvel = Array.from(sim.data.qvel as Float64Array), time = sim.time;
  sim.attachBrain(new UntrainedBrain(7));
  for (let i = 0; i < 200; i++) sim.step(null);
  assert.notDeepEqual(Array.from(sim.data.qpos as Float64Array), qpos, 'the twitching moved it');
  sim.attachBrain(null);
  sim.setPose(pose);
  assert.deepEqual(Array.from(sim.data.qpos as Float64Array), qpos);
  assert.deepEqual(Array.from(sim.data.qvel as Float64Array), qvel);
  assert.ok(sim.time > time, 'the clock keeps going: only the body is put back');
  for (let i = 0; i < 50; i++) sim.step(null);
  assert.ok(sim.uprightness() > 0.99, 'and it stands there');
});
