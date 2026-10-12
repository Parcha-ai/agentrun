// The robot as code: the helper's output compiles in MuJoCo, the bodies in the examples stand up, and the facts the creature page needs come out of it (tags, motors, colours).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error: plain .mjs files shipped to the agent's workspace, without types
import { build, chain, mirror, robot } from '../../body/lib.mjs';
// @ts-expect-error
import dog from '../../body/dog.example.mjs';
// @ts-expect-error
import dino from '../../body/dino.example.mjs';
import { mj } from './helpers.ts';

/** What the creature page does with a built body: compile it, drop it onto the floor from just above its lowest point, hold the standing pose for a few seconds, and report. */
function settle(xml: string, motors: number, seconds = 3) {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  mj.mj_resetDataKeyframe(model, data, 0);
  mj.mj_forward(model, data);
  let low = Infinity;
  for (let g = 0; g < model.ngeom; g++) if (model.geom_bodyid[g] > 0) low = Math.min(low, data.geom_xpos[3 * g + 2] - model.geom_rbound[g]);
  data.qpos[2] -= low - 0.01;
  mj.mj_forward(model, data);
  const steps = Math.round(seconds / model.opt.timestep);
  for (let i = 0; i < steps; i++) mj.mj_step(model, data);
  const r = { nq: model.nq, nu: model.nu, motors, z: data.qpos[2], up: 1 - 2 * (data.qpos[4] ** 2 + data.qpos[5] ** 2), mass: [...Array(model.nbody).keys()].reduce((s, b) => s + model.body_mass[b], 0), finite: [...data.qpos].every(Number.isFinite) };
  return r;
}

test('the dog and the dinosaur compile in MuJoCo with one motor per trainable joint, and stand up on their own', () => {
  const d = build(dog);
  assert.equal(d.motors.length, 8, 'a dog: four legs, hip and knee each; the tail is a spring');
  const s = settle(d.xml, d.motors.length);
  assert.equal(s.nu, 8);
  assert.ok(s.finite && s.up > 0.9, `the dog stands (up ${s.up.toFixed(2)}, z ${s.z.toFixed(2)})`);
  const n = build(dino);
  assert.equal(n.motors.length, 8, 'the dinosaur: the same eight leg motors; the neck (4) and the tail (6) are springs');
  assert.equal(n.joints.length, 8 + 4 + 6);
  const t = settle(n.xml, n.motors.length);
  assert.equal(t.nq, 7 + 18);
  assert.ok(t.finite && t.up > 0.85, `the dinosaur stands (up ${t.up.toFixed(2)}, z ${t.z.toFixed(2)})`);
  console.log(`dog: z ${s.z.toFixed(3)} up ${s.up.toFixed(2)} mass ${s.mass.toFixed(1)} kg; dino: z ${t.z.toFixed(3)} up ${t.up.toFixed(2)} mass ${t.mass.toFixed(1)} kg, ${Object.keys(n.tags).length} pieces`);
});

test('every piece carries tags, the tag vocabulary of a body is read off the tags, and colours come out per piece', () => {
  const n = build(dino);
  const all = new Set(Object.values(n.tags as Record<string, string[]>).flat());
  for (const t of ['torso', 'legs', 'front_legs', 'back_legs', 'neck', 'tail', 'head', 'eyes', 'plates', 'belly', 'jaw']) assert.ok(all.has(t), `${t} is on some piece`);
  assert.ok(Object.values(n.tags as Record<string, string[]>).every((t) => t.length > 0), 'no piece without a tag');
  const untagged = build(robot('lump', { shape: 'sphere', size: [0.1], color: 'red' }));
  assert.deepEqual(Object.values(untagged.tags), [['torso']], 'the root piece is always the torso');
  assert.equal(n.colors[Object.keys(n.tags).find((k) => n.tags[k].includes('plates'))!], 'orange');
});

test('mirror makes the other side: y flipped, a sideways joint changes sign, names get the suffix; chain hangs segments off each other', () => {
  const leg = { name: 'l', pos: [0.1, 0.12, 0], joint: { axis: [1, 0, 0], range: [-1, 0.5], stand: 0.3 }, shape: 'capsule', from: [0, 0, 0], to: [0, 0, -0.2], size: [0.02] };
  const m = mirror(leg, '_r');
  assert.deepEqual(m.pos, [0.1, -0.12, 0]);
  assert.equal(m.name, 'l_r');
  assert.deepEqual([m.joint.stand, m.joint.range], [-0.3, [-0.5, 1]]);
  const c = chain(3, (i: number) => ({ name: `s${i}`, pos: [0.1, 0, 0], shape: 'sphere', size: [0.02] }));
  assert.equal(c.children[0].children[0].name, 's2');
});

test('a compile error is a message the author can act on, and a wrong spec is refused before MuJoCo sees it', () => {
  assert.throws(() => build(robot('x', null)), /body file must export robot/);
  assert.throws(() => build(robot('x', { shape: 'box' })), /needs size/);
  assert.throws(() => build(robot('x', { shape: 'sphere', size: [0.1], color: 'chartreuse' })), /neither a name/);
  const bad = build(robot('bad', { shape: 'sphere', size: [0.1], mass: 1, children: [{ name: 'a', pos: [0, 0, 0], shape: 'sphere', size: [-1] }] }));
  assert.throws(() => mj.MjModel.from_xml_string(bad.xml), (e: unknown) => /size|positive|negative/i.test(String((e as Error).message ?? e)), 'MuJoCo says what is wrong');
});
