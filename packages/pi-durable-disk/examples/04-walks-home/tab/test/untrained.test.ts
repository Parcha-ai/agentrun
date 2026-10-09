import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { Sim } from '../src/sim.ts';
import { RAMP_S, SIGMA, STAND_S, UntrainedBrain } from '../src/untrained.ts';
import { mj } from './helpers.ts';

test('the same seed gives the same twitching, another seed a different one, and reset replays it', () => {
  const run = (seed: number) => { const b = new UntrainedBrain(seed); return Array.from({ length: 80 }, (_, i) => b.next(12, i * 0.02)); };
  assert.deepEqual(run(3), run(3));
  assert.notDeepEqual(run(3), run(4));
  const b = new UntrainedBrain(3);
  const first = b.next(12, 1.5);
  b.next(12, 1.52);
  b.reset();
  assert.deepEqual(b.next(12, 1.5), first);
});

test('it stands first: no action before the standing seconds, then a ramp to full strength', () => {
  const b = new UntrainedBrain(1);
  for (let i = 0; i < 20; i++) assert.ok(b.next(12, i * 0.02).every((a) => a === 0), `t=${i * 0.02}`);
  assert.equal(STAND_S, 0.5);
  const early = new UntrainedBrain(1), late = new UntrainedBrain(1);
  let sumEarly = 0, sumLate = 0;
  for (let i = 0; i < 400; i++) {
    const t = i * 0.02;
    const a = early.next(12, Math.min(t, STAND_S + 0.25 * RAMP_S)); // clamped to a quarter of the way up the ramp
    const c = late.next(12, Math.max(t, STAND_S + RAMP_S));
    sumEarly += a.reduce((x, y) => x + y * y, 0);
    sumLate += c.reduce((x, y) => x + y * y, 0);
  }
  assert.ok(sumEarly < 0.2 * sumLate, 'a quarter of the way up the ramp the twitching is much smaller than at full strength');
});

test('actions are random, smooth, bounded by the clip, and have about the intended spread', () => {
  const b = new UntrainedBrain(5);
  const xs: number[] = [];
  let prev: number[] | null = null, smooth = 0, rough = 0, n = 0;
  for (let i = 0; i < 5000; i++) {
    const a = b.next(12, 5 + i * 0.02);
    assert.ok(a.every((v) => v >= -1 && v <= 1));
    xs.push(a[0]);
    if (prev) { smooth += Math.abs(a[0] - prev[0]); rough += Math.abs(a[0] - a[5]); n++; }
    prev = a;
  }
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.15, `mean ${mean}`);
  assert.ok(sd > 0.5 * SIGMA && sd < 1.1 * SIGMA, `sd ${sd} for sigma ${SIGMA}`); // clipped at 1, so a little under SIGMA
  assert.ok(smooth / n < 0.5 * (rough / n), 'successive steps differ far less than two different joints do: a twitch lasts several steps');
});

test('on the real body it stands for half a second, then falls over within a few seconds and does not walk away', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const sim = new Sim(mj, buildMjcf(defaultDesign()));
    sim.brain = new UntrainedBrain(seed);
    let firstDown = -1, minUpEarly = 1;
    for (let i = 0; i < 400; i++) {
      sim.step(null);
      if (sim.time <= 0.5) minUpEarly = Math.min(minUpEarly, sim.uprightness());
      if (firstDown < 0 && sim.uprightness() < 0.3) firstDown = sim.time;
    }
    assert.ok(minUpEarly > 0.95, `seed ${seed}: standing in the first half second (${minUpEarly})`);
    assert.ok(firstDown > 0.5 && firstDown < 4, `seed ${seed}: down at ${firstDown}`);
    assert.ok(Math.hypot(...sim.torsoPos().slice(0, 2)) < 2, `seed ${seed}: it flops where it is`);
  }
});

test('without a brain a creature with no policy still just holds its stand pose', () => {
  const sim = new Sim(mj, buildMjcf(defaultDesign()));
  for (let i = 0; i < 100; i++) sim.step(null);
  assert.ok(sim.uprightness() > 0.95);
});

test('standUp puts a fallen creature back on its feet where it lies, facing the way it faced, and still', () => {
  const built = buildMjcf(defaultDesign());
  const sim = new Sim(mj, built);
  sim.brain = new UntrainedBrain(2);
  for (let i = 0; i < 300; i++) sim.step(null);
  assert.ok(sim.uprightness() < 0.3, 'it flopped');
  const [x, y] = sim.torsoPos();
  const q = sim.data.qpos;
  const yaw0 = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  sim.standUp();
  assert.ok(sim.uprightness() > 0.999);
  const [x1, y1, z1] = sim.torsoPos();
  assert.ok(Math.hypot(x1 - x, y1 - y) < 1e-9, 'same place');
  assert.ok(Math.abs(z1 - built.standHeight) < 1e-9);
  const yaw1 = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  assert.ok(Math.abs(Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0))) < 1e-9, 'same heading');
  assert.ok(Array.from(sim.data.qvel as ArrayLike<number>).every((v) => v === 0));
  for (let i = 0; i < 7; i++) assert.ok(Number.isFinite(sim.data.qpos[i]));
  for (let i = 0; i < built.standPose.length; i++) assert.equal(sim.data.qpos[7 + i], built.standPose[i]);
  sim.brain = null;
  for (let i = 0; i < 100; i++) sim.step(null);
  assert.ok(sim.uprightness() > 0.95, 'and it stands');
});

test('a rebuilt creature gets the same untrained start: attaching the brain replays it from the seed', () => {
  const run = (sim: Sim) => { const v: number[] = []; for (let i = 0; i < 70; i++) { sim.step(null); v.push(sim.data.ctrl[1]); } return v; };
  const brain = new UntrainedBrain(9);
  const a = new Sim(mj, buildMjcf(defaultDesign()));
  a.attachBrain(brain);
  const first = run(a);
  const b = new Sim(mj, buildMjcf(defaultDesign())); // the same drawing built again, as the sketcher does on every edit
  b.attachBrain(brain); // the same brain object, already advanced by the first creature
  assert.deepEqual(run(b), first, 'the second creature twitches exactly like the first');
  b.attachBrain(brain); // attaching the one already attached does not restart it mid-run
  const c = new Sim(mj, buildMjcf(defaultDesign()));
  c.attachBrain(brain);
  for (let i = 0; i < 30; i++) c.step(null);
  const mid = c.data.ctrl[1];
  c.attachBrain(brain);
  c.step(null);
  assert.notEqual(c.data.ctrl[1], first[0], 'it keeps going instead of replaying from the start');
  assert.ok(Number.isFinite(mid));
  c.attachBrain(null);
  assert.equal(c.brain, null);
});
