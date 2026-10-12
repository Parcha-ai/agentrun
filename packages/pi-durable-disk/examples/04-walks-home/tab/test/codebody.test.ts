// A body the agent wrote as code, in the simulation: the motors are the policy's joints and the springs are not, an eight-joint policy drives an eight-motor dinosaur without a NaN, a compile error is MuJoCo's own message, a body that does not stand is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error: plain .mjs files shipped to the agent's workspace
import { build, robot } from '../../body/lib.mjs';
// @ts-expect-error
import dino from '../../body/dino.example.mjs';
// @ts-expect-error
import dog from '../../body/dog.example.mjs';
import { builtFromBody, checkBody, parseBodyJson, CodeBodyError } from '../src/codebody.ts';
import { borrowPolicy } from '../src/robot-fit.ts';
import { Sim } from '../src/sim.ts';
import { mj } from './helpers.ts';

const fixture = JSON.parse(readFileSync(new URL('../../policy/test/fixtures/policy.json', import.meta.url), 'utf8'));
const code = (spec: unknown) => { const b = build(spec); return { b, body: parseBodyJson(JSON.stringify(b.json)), built: builtFromBody(b.xml, parseBodyJson(JSON.stringify(b.json))) }; };

test('the dinosaur is checked: it compiles, stands, and the report says what it found', () => {
  const { body, built } = code(dino);
  const { sim, result } = checkBody(mj, built, body);
  assert.ok(sim);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual([result.report!.pieces, result.report!.motors, result.report!.joints], [32, 8, 18]);
  assert.ok(result.report!.settled_up > 0.9 && Math.abs(result.report!.settled_height_m - body.stand_height_m) < 0.02, JSON.stringify(result.report));
});

test('a policy sees the motors only: the dinosaur\'s springs are not in its observation, so the dog\'s eight-joint network drives the dinosaur without a NaN (a body that is not its own: it stumbles)', async () => {
  const { built } = code(dino);
  const sim = new Sim(mj, built);
  const st = sim.state(1.5);
  assert.equal(st.qpos.length, 7 + 8);
  assert.equal(st.qvel.length, 6 + 8);
  const borrowed = await borrowPolicy(fixture, built.jointNames.length, '3.15.0');
  assert.ok(borrowed, 'eight joints fit the eight-joint network');
  sim.command = 0.4;
  for (let i = 0; i < 250; i++) sim.step(borrowed);
  assert.ok(Array.from(sim.data.qpos).every(Number.isFinite), 'no NaN');
  // standUp puts the springs back at their rest angles too
  sim.standUp();
  assert.ok(Math.abs(sim.data.qpos[2]! - built.standHeight) < 1e-9);
  assert.ok(sim.uprightness() > 0.99);
});

test('a compile error is MuJoCo\'s own message; non-finite physics and a body that falls over are reported, not hidden', () => {
  const bad = code(robot('bad', { shape: 'sphere', size: [0.1], mass: 1, children: [{ name: 'a', pos: [0, 0, 0], shape: 'sphere', size: [-1] }] }));
  const r = checkBody(mj, bad.built, bad.body);
  assert.equal(r.sim, null);
  assert.equal(r.result.ok, false);
  assert.match(r.result.errors[0]!, /^MuJoCo: /);
  assert.match(r.result.errors[0]!, /size|positive/i);
  // a body held up by one leg at its front end tips over: the report says so, the body is still built (and shown)
  const stick = code(robot('stick', { shape: 'box', size: [0.2, 0.1, 0.05], mass: 3, tags: ['torso'], children: [{ name: 'leg', pos: [0.18, 0, 0], tags: ['legs'], joint: { axis: [0, 1, 0], range: [-1, 1], stand: 0 }, shape: 'capsule', from: [0, 0, 0], to: [0, 0, -0.3], size: [0.02], mass: 0.1 }] }));
  const s = checkBody(mj, stick.built, stick.body);
  assert.equal(s.result.ok, true);
  assert.ok(s.sim, 'still built');
  assert.ok(s.result.warnings.some((w) => /does not stand|collapses|leaning/.test(w)), JSON.stringify(s.result));
});

test('robot/body.json that is not what build.mjs writes is a message that says to run it again', () => {
  assert.throws(() => parseBodyJson('not json'), (e: unknown) => e instanceof CodeBodyError && /build\.mjs/.test((e as Error).message));
  assert.throws(() => parseBodyJson('{}'), /no joints/);
  assert.throws(() => parseBodyJson(JSON.stringify({ joints: [], motors: [], tag_list: [] })), /no tags/);
  void dog;
});
