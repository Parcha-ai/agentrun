/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign } from '../src/design.ts';
import { dummy, fixture, mj, MUJOCO_VERSION } from './helpers.ts';
import { Policy, PolicyRefused } from '../src/policy.ts';
import { KICK_STEPS, Sim } from '../src/sim.ts';
import { buildMjcf } from '../src/mjcf.ts';

test('the default quadruped stands on its own for 5 s with the standing targets', async () => {
  const { built } = await fixture();
  const sim = new Sim(mj, built);
  for (let i = 0; i < 250; i++) sim.step(null);
  assert.ok(sim.uprightness() > 0.95, `uprightness ${sim.uprightness()}`);
  assert.ok(sim.torsoPos()[2] > 0.15 && sim.torsoPos()[2] < 0.5, `height ${sim.torsoPos()[2]}`);
});

test('the dummy trot keeps the body up for 10 s and moves the legs', async () => {
  const { sim, policy } = await dummy();
  let moved = 0;
  for (let i = 0; i < 500; i++) {
    sim.step(policy);
    moved = Math.max(moved, Math.abs(sim.data.qpos[7] - sim.built.standPose[0]));
  }
  assert.ok(moved > 0.2, `hip swing ${moved}`);
  assert.ok(sim.torsoPos()[2] > 0.1, `torso height ${sim.torsoPos()[2]}`);
});

test('a kick holds the force for exactly KICK_STEPS physics steps, then clears it, and moves the torso', async () => {
  const { sim } = await dummy();
  for (let i = 0; i < 100; i++) sim.step(null);
  const vy0 = sim.data.qvel[1];
  sim.kick([0, 60, 0]);
  const applied: number[] = [];
  const realStep = mj.mj_step;
  const spy = { ...mj, mj_step: (m: any, d: any) => { applied.push(d.xfrc_applied[sim.torsoBody * 6 + 1]); realStep(m, d); } };
  const spied = new Sim(spy, sim.built);
  spied.kick([0, 60, 0]);
  for (let i = 0; i < 4; i++) spied.step(null);
  assert.equal(applied.filter((f) => f === 60).length, KICK_STEPS);
  assert.equal(applied.slice(0, KICK_STEPS).every((f) => f === 60), true, 'the window is contiguous from the first step');
  assert.equal(applied.slice(KICK_STEPS).every((f) => f === 0), true, 'cleared afterwards');
  sim.step(null); sim.step(null); sim.step(null);
  assert.ok(sim.data.qvel[1] - vy0 > 0.3, `kick gave only ${sim.data.qvel[1] - vy0} m/s`);
});

test('every design in range builds and stands', async () => {
  for (const pairs of [2, 3]) {
    const d = defaultDesign();
    d.legs = Array.from({ length: pairs }, (_, i) => ({ x: 0.8 - (1.6 * i) / (pairs - 1), thigh: 0.18, shin: 0.22, radius: 0.02 }));
    const { built } = await fixture(d);
    const sim = new Sim(mj, built);
    for (let i = 0; i < 150; i++) sim.step(null);
    assert.ok(sim.uprightness() > 0.9, `${pairs} pairs: ${sim.uprightness()}`);
  }
});

test('policy refuses another body, an unknown version, wrong joint counts and a stale MuJoCo', async () => {
  const { sha, nj, file } = await dummy();
  const body = { mjcfSha256: sha, nj, mujocoVersion: MUJOCO_VERSION };
  await assert.rejects(Policy.load(file, { ...body, mjcfSha256: 'x'.repeat(64) }), PolicyRefused);
  await assert.rejects(Policy.load({ ...file, spec_version: 2 }, body), /spec_version/);
  await assert.rejects(Policy.load(file, { ...body, nj: nj + 2 }), PolicyRefused);
  await assert.rejects(Policy.load(file, { ...body, mujocoVersion: '3.0.0' }), /MuJoCo/);
  await assert.rejects(Policy.load({ ...file, layers: [{ ...file.layers[0], act: 'gelu' as never }] }, body), /activation/);
  await Policy.load(file, body);
});

test('a standing creature survives a 60 N shove from every side and is upright again after 3 s', async () => {
  for (const dir of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const { built } = await fixture();
    const sim = new Sim(mj, built);
    for (let i = 0; i < 50; i++) sim.step(null);
    sim.kick([dir[0] * 60, dir[1] * 60, 0]);
    for (let i = 0; i < 150; i++) sim.step(null);
    assert.ok(sim.uprightness() > 0.9, `shoved ${dir}: uprightness ${sim.uprightness()}`);
  }
});

test('a terrain fragment is spliced after the floor, leaves the body identity alone, and the creature stands on its flat centre', async () => {
  const n = 17;
  // flat in the middle (|x|,|y| < 1 m), ridges at the edge: heightfield 4 m x 4 m
  const elev = Array.from({ length: n * n }, (_, k) => {
    const i = Math.floor(k / n), j = k % n;
    const x = -2 + (4 * j) / (n - 1), y = -2 + (4 * i) / (n - 1);
    return Math.max(Math.abs(x), Math.abs(y)) > 1.2 ? 0.8 : 0;
  }).join(' ');
  const world = {
    asset: `<hfield name="terrain" nrow="${n}" ncol="${n}" size="2 2 0.2 0.05" elevation="${elev}"/>`,
    geoms: '<geom name="terrain_geom" type="hfield" hfield="terrain" contype="1" conaffinity="1"/>',
  };
  const flat = buildMjcf(defaultDesign());
  const rough = buildMjcf(defaultDesign(), world);
  assert.notEqual(flat.xml, rough.xml);
  assert.ok(rough.xml.indexOf('<asset>') < rough.xml.indexOf('<worldbody>'));
  assert.ok(rough.xml.indexOf('name="floor"') < rough.xml.indexOf('terrain_geom'));
  assert.equal(rough.jointNames.join(), flat.jointNames.join());
  const sim = new Sim(mj, rough);
  for (let i = 0; i < 150; i++) sim.step(null);
  assert.ok(sim.uprightness() > 0.95, `uprightness ${sim.uprightness()}`);
  assert.equal(sim.model.nhfield, 1);
});
