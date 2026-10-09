// The getup network takes over below switch.below_up and hands back above switch.above_up, and its action is mapped
// with its own scale; a file with a malformed getup block is refused whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Policy, PolicyRefused, f32ToBase64, type PolicyFile } from '../policy.ts';

const nj = 2;
// A one-layer net whose output is the constant `value` on every actuator (zero weights, bias = value).
const constant = (value: number) => [{ in: 2, out: nj, w: f32ToBase64(new Float32Array(2 * nj)), b: f32ToBase64(new Float32Array(nj).fill(value)), act: 'none' as const }];
const file = (getup?: PolicyFile['getup']): PolicyFile => ({
  format: 'mlp-v1', spec_version: 1, mujoco_version: '3.15.0', mjcf_sha256: 'x', control_dt: 0.02,
  obs: { spec: [{ name: 'phase', size: 2 }], mean: [0, 0], std: [1, 1] }, clock: { gait_hz: 2 },
  act: { scale: 0.5, clip: 1 }, layers: constant(0.2), ...(getup ? { getup } : {}),
});
const body = { mjcfSha256: 'x', nj };
// qpos with the torso rolled about x by `angle`: uprightness = cos(angle).
const state = (angle: number) => ({ qpos: [0, 0, 0, Math.cos(angle / 2), Math.sin(angle / 2), 0, 0, 0, 0], qvel: new Array(8).fill(0),
  prevAction: [0, 0], command: 0, time: 0, gaitHz: 2, standPose: [0, 0] });

test('control passes to getup below below_up and back above above_up, each with its own scale', async () => {
  const p = await Policy.load(file({ layers: constant(-0.4), act: { scale: 2, clip: 1 }, switch: { below_up: 0.3, above_up: 0.9 } }), body);
  const step = (angle: number) => { const a = p.act(p.observe(state(angle))); return { skill: p.skill, target: p.targets(a, [0, 0])[0] }; };
  const first = step(0);
  assert.equal(first.skill, 'walk');
  assert.ok(Math.abs(first.target - 0.5 * 0.2) < 1e-6); // weights are float32
  assert.equal(step(Math.PI / 2).skill, 'getup'); // on its side: up = 0 < 0.3
  assert.ok(Math.abs(step(Math.PI / 2).target - 2 * -0.4) < 1e-6);
  assert.equal(step(Math.acos(0.6)).skill, 'getup'); // up 0.6: between the thresholds, getup keeps control
  assert.equal(step(Math.acos(0.95)).skill, 'walk'); // up 0.95 > 0.9: walking again
  assert.equal(step(Math.acos(0.6)).skill, 'walk'); // and walking keeps control until up < 0.3
  p.skill = 'getup'; p.reset();
  assert.equal(p.skill, 'walk');
});

test('a getup block without obs and act runs on the top level ones', async () => {
  const p = await Policy.load(file({ layers: constant(-0.4), switch: { below_up: 0.3, above_up: 0.9 } }), body);
  p.observe(state(Math.PI));
  assert.equal(p.skill, 'getup');
  assert.ok(Math.abs(p.targets(p.act(p.observe(state(Math.PI))), [0, 0])[0] - 0.5 * -0.4) < 1e-6);
});

test('a malformed getup block refuses the whole file', async () => {
  await assert.rejects(Policy.load(file({ layers: constant(0), switch: { below_up: 0.9, above_up: 0.3 } }), body), PolicyRefused);
  await assert.rejects(Policy.load(file({ layers: constant(0) } as never), body), PolicyRefused);
  const wide = [{ ...constant(0)[0], out: 3, b: f32ToBase64(new Float32Array(3)), w: f32ToBase64(new Float32Array(6)) }];
  await assert.rejects(Policy.load(file({ layers: wide, switch: { below_up: 0.3, above_up: 0.9 } }), body), PolicyRefused);
});
