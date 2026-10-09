import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign } from '../src/design.ts';
import { f32ToBase64, nextMode, Policy, PolicyRefused, type GetupFile, type PolicyFile } from '../src/policy.ts';
import { Sim } from '../src/sim.ts';
import { fixture, mj, MUJOCO_VERSION } from './helpers.ts';

const SW = { below_up: 0.3, above_up: 0.9 };

/** A one-layer net with no activation: out = W x + b, so tests can say exactly what it outputs. */
function layer(inW: number, nj: number, bias: number, w: Record<number, number> = {}) {
  const wt = new Float32Array(nj * inW);
  for (const [k, v] of Object.entries(w)) wt[Number(k)] = v; // index = joint * inW + input
  return { in: inW, out: nj, w: f32ToBase64(wt), b: f32ToBase64(new Float32Array(nj).fill(bias)), act: 'none' as const };
}

async function body() {
  const { built, sha, nj } = await fixture(defaultDesign(3));
  return { built, sha, nj };
}

async function file(over: Partial<PolicyFile> = {}, getup: GetupFile | undefined = undefined): Promise<{ f: PolicyFile; sha: string; nj: number }> {
  const { sha, nj } = await body();
  const f: PolicyFile = {
    format: 'mlp-v1', spec_version: 1, mujoco_version: MUJOCO_VERSION, mjcf_sha256: sha, control_dt: 0.02,
    obs: { spec: [{ name: 'command', size: 1 }], mean: [0], std: [1] },
    act: { scale: 0.5, clip: 1 },
    layers: [layer(1, nj, 0)], // walking: action 0 -> targets = the stand pose
    ...over,
  };
  if (getup !== undefined) f.getup = getup;
  return { f, sha, nj };
}

const load = async (f: PolicyFile, sha: string, nj: number) => Policy.load(JSON.stringify(f), { mjcfSha256: sha, nj, mujocoVersion: MUJOCO_VERSION });

// ---- the hysteresis ------------------------------------------------------------------------------------------

test('nextMode: walk below below_up, getup until above above_up, stay in between, and the thresholds are strict', () => {
  const ups = [1, 0.5, 0.3, 0.29, 0.5, 0.89, 0.9, 0.91, 0.5, 0.2, 1];
  const modes = [];
  let m: 'walk' | 'getup' = 'walk';
  for (const u of ups) { m = nextMode(m, u, SW); modes.push(m); }
  assert.deepEqual(modes, ['walk', 'walk', 'walk', 'getup', 'getup', 'getup', 'getup', 'walk', 'walk', 'getup', 'walk']);
});

// ---- validation: each branch ------------------------------------------------------------------------------------

test('no getup block: the policy loads, has no getup, and its mode never leaves walk', async () => {
  const { f, sha, nj } = await file();
  const p = await load(f, sha, nj);
  assert.equal(p.hasGetup, false);
  assert.equal(p.control({ qpos: [0, 0, 0.4, 1, 0, 0, 0, ...new Array(nj).fill(0)], qvel: new Array(6 + nj).fill(0), prevAction: new Array(nj).fill(0), command: 0, time: 0, gaitHz: 0, standPose: new Array(nj).fill(0) }, -1, 'walk', new Array(nj).fill(0)).mode, 'walk');
});

test('a valid getup block loads, with and without its own obs and act', async () => {
  const { nj } = await body();
  let r = await file({}, { layers: [layer(1, nj, 0.5)], switch: SW });
  assert.equal((await load(r.f, r.sha, r.nj)).hasGetup, true, 'defaults to the top-level obs and act');
  r = await file({}, { layers: [layer(3, nj, 0)], obs: { spec: [{ name: 'gravity', size: 3 }], mean: [0, 0, 0], std: [1, 1, 1] }, act: { scale: 2 }, switch: SW });
  assert.equal((await load(r.f, r.sha, r.nj)).hasGetup, true, 'own obs and act');
});

test('every invalid getup block refuses the whole file, with a "getup:" reason', async () => {
  const { nj } = await body();
  const ok = { layers: [layer(1, nj, 0)], switch: SW } as GetupFile;
  const gravityObs = { spec: [{ name: 'gravity' as const, size: 3 }], mean: [0, 0, 0], std: [1, 1, 1] };
  const cases: [string, unknown, RegExp][] = [
    ['not an object', 'x', /getup: the block is not an object/],
    ['an array', [], /getup: the block is not an object/],
    ['null', null, /getup: the block is not an object/],
    ['no switch', { layers: ok.layers }, /switch needs numbers/],
    ['below == above', { ...ok, switch: { below_up: 0.5, above_up: 0.5 } }, /switch needs numbers/],
    ['below > above', { ...ok, switch: { below_up: 0.9, above_up: 0.3 } }, /switch needs numbers/],
    ['below < 0', { ...ok, switch: { below_up: -0.1, above_up: 0.9 } }, /switch needs numbers/],
    ['above > 1', { ...ok, switch: { below_up: 0.3, above_up: 1.5 } }, /switch needs numbers/],
    ['switch values as strings', { ...ok, switch: { below_up: '0.3', above_up: '0.9' } }, /switch needs numbers/],
    ['act.scale 0', { ...ok, act: { scale: 0 } }, /act.scale must be a positive number/],
    ['act.scale negative', { ...ok, act: { scale: -1 } }, /act.scale must be a positive number/],
    ['act.scale a string', { ...ok, act: { scale: '2' } }, /act.scale must be a positive number/],
    ['no layers', { switch: SW }, /getup: no layers/],
    ['empty layers', { layers: [], switch: SW }, /getup: no layers/],
    ['input width differs from the obs it uses', { layers: [layer(3, nj, 0)], switch: SW }, /getup: layer 0 takes 3, previous width is 1/],
    ['unknown activation', { layers: [{ ...layer(1, nj, 0), act: 'gelu' }], switch: SW }, /getup: layer 0: activation gelu not supported/],
    ['outputs the wrong number of actions', { layers: [{ ...layer(1, nj, 0), out: nj - 1 }], switch: SW }, /getup: policy outputs 11 actions, the body has 12 actuators/],
    ['weights do not match in/out', { layers: [{ ...layer(1, nj, 0), w: f32ToBase64(new Float32Array(nj + 1)) }], switch: SW }, /getup: layer 0: weight shapes do not match/],
    ['unknown obs slice', { layers: [layer(1, nj, 0)], obs: { spec: [{ name: 'height', size: 1 }], mean: [0], std: [1] }, switch: SW }, /getup: unknown obs slice height/],
    ['obs slice of the wrong size', { layers: [layer(2, nj, 0)], obs: { spec: [{ name: 'gravity', size: 2 }], mean: [0, 0], std: [1, 1] }, switch: SW }, /getup: obs slice gravity has size 2/],
    ['obs std not positive', { layers: [layer(3, nj, 0)], obs: { ...gravityObs, std: [1, 0, 1] }, switch: SW }, /getup: obs std must be positive/],
    ['obs mean length differs', { layers: [layer(3, nj, 0)], obs: { ...gravityObs, mean: [0, 0] }, switch: SW }, /getup: obs mean\/std length differs/],
    ['phase without a clock', { layers: [layer(2, nj, 0)], obs: { spec: [{ name: 'phase', size: 2 }], mean: [0, 0], std: [1, 1] }, switch: SW }, /getup: phase needs clock.gait_hz/],
  ];
  for (const [name, getup, why] of cases) {
    const { f, sha } = await file({}, getup as GetupFile);
    await assert.rejects(load(f, sha, nj), (e: Error) => e instanceof PolicyRefused && why.test(e.message), name);
  }
});

test('the size limit is 600 KB so a walking net and a getup net fit; above it the file is refused', async () => {
  const { nj } = await body();
  const { f, sha } = await file({}, { layers: [layer(1, nj, 0)], switch: SW });
  const text = JSON.stringify(f);
  await assert.rejects(Policy.load(text + ' '.repeat(600 * 1024), { mjcfSha256: sha, nj }), /over 614400 bytes/);
  assert.ok((await Policy.load(text + ' '.repeat(450 * 1024), { mjcfSha256: sha, nj })).hasGetup, '450 KB is accepted');
});

test('the walking net is validated as before: a bad walking net is refused with no prefix', async () => {
  const { nj } = await body();
  const { f, sha } = await file({ layers: [layer(2, nj, 0)] });
  await assert.rejects(load(f, sha, nj), (e: Error) => /^layer 0 takes 2/.test(e.message));
});

// ---- which network drives the creature -----------------------------------------------------------------------------

/** Set the torso's roll about x so that uprightness = cos(roll), and clear the velocities. */
function roll(sim: Sim, rollRad: number) {
  const q = sim.data.qpos;
  q[3] = Math.cos(rollRad / 2); q[4] = Math.sin(rollRad / 2); q[5] = 0; q[6] = 0;
  for (let i = 0; i < sim.data.qvel.length; i++) sim.data.qvel[i] = 0;
}

test('the getup net drives the creature while it is down and walking takes over above above_up, with each net\'s own act scale', async () => {
  const { built, nj } = await body();
  const { f, sha } = await file({}, { layers: [layer(1, nj, 0.5)], act: { scale: 2.0, clip: 1.0 }, switch: SW });
  const policy = await load(f, sha, nj);
  const sim = new Sim(mj, built);
  const stand = built.standPose;
  const walkTargets = (i: number) => stand[i]; // walking net outputs 0
  const getupTargets = (i: number) => stand[i] + 2.0 * 0.5; // getup net outputs 0.5, scale 2.0

  sim.step(policy);
  assert.equal(sim.mode, 'walk');
  assert.ok(Math.abs(sim.data.ctrl[1] - walkTargets(1)) < 1e-6, 'upright: walking net, scale 0.5');

  roll(sim, Math.PI / 2); // on its side: up = 0
  sim.step(policy);
  assert.equal(sim.mode, 'getup');
  assert.ok(Math.abs(sim.data.ctrl[1] - getupTargets(1)) < 1e-6, `down: getup net, scale 2.0 (got ${sim.data.ctrl[1]})`);

  roll(sim, Math.acos(0.6)); // up = 0.6: between the thresholds, still getup
  sim.step(policy);
  assert.equal(sim.mode, 'getup', 'hysteresis holds the getup net');

  roll(sim, Math.acos(0.95)); // up = 0.95 > above_up
  sim.step(policy);
  assert.equal(sim.mode, 'walk');
  assert.ok(Math.abs(sim.data.ctrl[1] - walkTargets(1)) < 1e-6, 'upright again: walking net');

  roll(sim, Math.acos(0.6)); // between the thresholds from the walking side: stays walk
  sim.step(policy);
  assert.equal(sim.mode, 'walk');

  roll(sim, Math.PI / 2);
  sim.step(policy);
  assert.equal(sim.mode, 'getup');
  sim.reset();
  assert.equal(sim.mode, 'walk', 'reset puts the mode back to walk');
});

test('the getup net reads its own observation layout: on its back it sees gravity z = +1 in the body frame', async () => {
  const { built, nj } = await body();
  const { f, sha } = await file({}, {
    layers: [layer(3, nj, 0, { 2: 1 })], // joint 0 reads the third input (gravity z)
    obs: { spec: [{ name: 'gravity', size: 3 }], mean: [0, 0, 0], std: [1, 1, 1] },
    act: { scale: 1.0, clip: 1.0 },
    switch: SW,
  });
  const policy = await load(f, sha, nj);
  const sim = new Sim(mj, built);
  roll(sim, Math.PI); // on its back: up = -1
  const action = sim.step(policy);
  assert.equal(sim.mode, 'getup');
  assert.ok(Math.abs(action[0] - 1) < 1e-6, `joint 0 action ${action[0]}`);
  assert.ok(action.slice(1).every((a) => Math.abs(a) < 1e-9));
});

test('a policy without a getup block stays on its walking net even on its back', async () => {
  const { built, nj } = await body();
  const { f, sha } = await file();
  const policy = await load(f, sha, nj);
  const sim = new Sim(mj, built);
  roll(sim, Math.PI);
  sim.step(policy);
  assert.equal(sim.mode, 'walk');
  assert.ok(Math.abs(sim.data.ctrl[1] - built.standPose[1]) < 1e-6);
});

test('the clip of the active net applies: a getup net asking for more than its clip is cut', async () => {
  const { built, nj } = await body();
  const { f, sha } = await file({}, { layers: [layer(1, nj, 5)], act: { scale: 1.5, clip: 0.4 }, switch: SW });
  const policy = await load(f, sha, nj);
  const sim = new Sim(mj, built);
  roll(sim, Math.PI / 2);
  const action = sim.step(policy);
  assert.ok(action.every((a) => Math.abs(a - 0.4) < 1e-9), JSON.stringify(action.slice(0, 3)));
  assert.ok(Math.abs(sim.data.ctrl[1] - (built.standPose[1] + 1.5 * 0.4)) < 1e-6);
});
