// The robot as code: the helper's output compiles in MuJoCo, the bodies in the examples stand up, and the facts the creature page needs come out of it (tags, motors, colours).
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** The keyframe's torso height comes from forward kinematics at the standing pose, so the robot starts with its feet on the floor: it neither drops from a height nor starts inside the floor. */
test('the keyframe height puts the lowest point of the body at the floor: the settled height is within 2 cm of the start, for a dog, a dinosaur and a lump', () => {
  for (const [name, spec] of [['dog', dog], ['dino', dino], ['lump', robot('lump', { shape: 'sphere', size: [0.2], color: 'red' })]] as const) {
    const b = build(spec);
    const model = mj.MjModel.from_xml_string(b.xml);
    const data = new mj.MjData(model);
    mj.mj_resetDataKeyframe(model, data, 0);
    mj.mj_forward(model, data);
    const z0 = data.qpos[2];
    for (let i = 0; i < 750; i++) mj.mj_step(model, data);
    assert.ok(Math.abs(data.qpos[2] - z0) < 0.02, `${name}: starts at ${z0.toFixed(3)} m, settles at ${data.qpos[2].toFixed(3)} m`);
    assert.equal(b.json.stand_height_m, z0);
  }
});

test('body.json says what the look tools and the trainer need: motors in order, tags and the vocabulary present, the leg count, the face anchor, warnings for what looks wrong', () => {
  const n = build(dino);
  assert.equal(n.json.legs, 4);
  assert.deepEqual(n.json.tag_list, ['torso', 'head', 'neck', 'tail', 'legs', 'front_legs', 'back_legs', 'eyes', 'jaw', 'belly', 'plates']);
  assert.deepEqual(n.json.face, { tag: 'head', at: [0.1, 0, 0.02] });
  assert.equal(n.json.motors.length, 8);
  assert.deepEqual(n.warnings, []);
  const untagged = build(robot('x', { shape: 'sphere', size: [0.1], mass: 0.05, children: [{ name: 'a', pos: [0, 0, 0], shape: 'sphere', size: [0.01] }] }));
  assert.deepEqual(untagged.json.tag_list, ['torso', 'decoration'], 'an untagged piece is decoration');
  assert.ok(untagged.warnings.some((w: string) => /no trainable joints/.test(w)) && untagged.warnings.some((w: string) => /very light/.test(w)));
});

test('node robot/build.mjs runs the agent\'s body file: it writes body.xml and body.json and prints one summary line; an error in the file is the exit message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robot-build-'));
  try {
    mkdirSync(join(dir, 'robot'));
    for (const f of ['lib.mjs', 'build.mjs']) copyFileSync(new URL(`../../body/${f}`, import.meta.url), join(dir, 'robot', f));
    copyFileSync(new URL('../../body/dino.example.mjs', import.meta.url), join(dir, 'robot', 'body.mjs'));
    const run = () => spawnSync(process.execPath, ['robot/build.mjs'], { cwd: dir, encoding: 'utf8' });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^wrote robot\/body\.xml and robot\/body\.json: 32 pieces, 8 motors, 10 spring joints, 10\.99 kg, standing height 0\.\d+ m\. Tags: torso, head, neck, tail, legs, front_legs, back_legs, eyes, jaw, belly, plates\./);
    assert.equal(JSON.parse(readFileSync(join(dir, 'robot/body.json'), 'utf8')).legs, 4);
    assert.match(readFileSync(join(dir, 'robot/body.xml'), 'utf8'), /<key name="home"/);
    writeFileSync(join(dir, 'robot', 'body.mjs'), 'import { robot } from "./lib.mjs";\nexport default robot("x", { shape: "box" });\n');
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^body\.mjs: .*needs size/);
    writeFileSync(join(dir, 'robot', 'body.mjs'), 'throw new Error("my dinosaur has no head");\n');
    assert.match(run().stderr, /^body\.mjs: my dinosaur has no head/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the names the trainer looks for are written for every body: a root body "torso", a keyframe "stand" (and "home"), and a foot geom at the tip of each leg', () => {
  for (const spec of [dog, dino]) {
    const b = build(spec);
    assert.match(b.xml, /<body name="torso" /);
    assert.match(b.xml, /<key name="stand" /);
    assert.match(b.xml, /<key name="home" /);
    const feet = b.xml.match(/name="[^"]*_foot"/g) ?? [];
    assert.equal(feet.length, 4, `four feet: ${feet.join(' ')}`);
  }
  const renamed = build(robot('x', { name: 'trunk', shape: 'sphere', size: [0.1], mass: 1 }));
  assert.match(renamed.xml, /<body name="torso" /, 'the root is torso whatever the file calls it');
});

test('motors come first in the joint order whatever order the file lists its limbs in, and a spring above a motor is refused with the way out', () => {
  const springsFirst = robot('t', {
    shape: 'box', size: [0.2, 0.1, 0.05], mass: 2,
    children: [
      { name: 'tailA', pos: [-0.2, 0, 0], tags: ['tail'], joint: { axis: [0, 1, 0], range: [-0.4, 0.4], passive: true }, shape: 'capsule', from: [0, 0, 0], to: [-0.1, 0, 0], size: [0.02], mass: 0.1 },
      { name: 'legA', pos: [0.1, 0.1, 0], tags: ['legs'], joint: { axis: [0, 1, 0], range: [-1, 1], stand: 0 }, shape: 'capsule', from: [0, 0, 0], to: [0, 0, -0.2], size: [0.02], mass: 0.1 },
    ],
  });
  const b = build(springsFirst);
  assert.deepEqual(b.joints.map((j: { passive: boolean }) => j.passive), [false, true], 'the leg is walked before the tail although the file lists the tail first');
  assert.equal(b.motors.length, 1);
  const above = robot('u', { shape: 'box', size: [0.2, 0.1, 0.05], mass: 2, children: [{ name: 'spine', pos: [0, 0, 0.05], joint: { axis: [0, 1, 0], range: [-0.3, 0.3], passive: true }, shape: 'sphere', size: [0.03], mass: 0.1, children: [{ name: 'jaw', pos: [0.1, 0, 0], joint: { axis: [0, 1, 0], range: [0, 0.5] }, shape: 'sphere', size: [0.02], mass: 0.05 }] }] });
  assert.throws(() => build(above), /the spring joint spine_j sits above the motor jaw_j: along a limb the motors must come before the springs/);
  const flagged = build(robot('f', { shape: 'box', size: [0.2, 0.1, 0.05], mass: 2, children: [{ name: 'leg', pos: [0, 0.1, 0], tags: ['legs'], joint: { axis: [0, 1, 0], range: [-1, 1] }, shape: 'capsule', from: [0, 0, 0], to: [0, 0, -0.2], size: [0.02], mass: 0.1, geoms: [{ shape: 'sphere', size: [0.03], pos: [0, 0, -0.2], foot: true, mass: 0.05 }, { shape: 'sphere', size: [0.01], pos: [0, 0, 0], mass: 0.01 }] }] }));
  assert.match(flagged.xml, /size="0\.03" name="leg_foot"/, 'a piece flagged foot is the foot even when it is not the last');
});

test('a node\'s pos places its BODY once: a sphere child at [0.3, 0, 0] is centred 0.3 m from its parent in MuJoCo, not 0.6', () => {
  const b = build(robot('p', { shape: 'sphere', size: [0.1], mass: 1, children: [{ name: 'a', pos: [0.3, 0, 0], shape: 'sphere', size: [0.05], mass: 0.1 }] }));
  const model = mj.MjModel.from_xml_string(b.xml);
  const data = new mj.MjData(model);
  mj.mj_resetDataKeyframe(model, data, 0);
  mj.mj_forward(model, data);
  const at = (name: string) => { for (let g = 0; g < model.ngeom; g++) if (model.geom(g).name === name) return [data.geom_xpos[3 * g], data.geom_xpos[3 * g + 1], data.geom_xpos[3 * g + 2]]; throw new Error(name); };
  const torso = at('torso_geom'), a = at('a_geom');
  assert.ok(Math.abs(a[0]! - torso[0]! - 0.3) < 1e-9, `0.3 m, got ${(a[0]! - torso[0]!).toFixed(3)}`);
  // an extra geom keeps its own offset on the body, on top of the body's
  const e = build(robot('p', { shape: 'sphere', size: [0.1], mass: 1, children: [{ name: 'a', pos: [0.3, 0, 0], shape: 'sphere', size: [0.05], mass: 0.1, geoms: [{ shape: 'sphere', size: [0.02], pos: [0.1, 0, 0], mass: 0.01 }] }] }));
  assert.match(e.xml, /<geom type="sphere" pos="0\.1 0 0" size="0\.02"/);
});

test('mirror reflects a joint about any axis: z flips like x, a mixed axis becomes the reflected axis with the same angle, a pitch joint is unchanged', () => {
  const j = (axis: number[], stand: number, range: number[]) => mirror({ name: 'n', pos: [0, 0.1, 0], joint: { axis, stand, range }, shape: 'sphere', size: [0.01] }, '_r').joint;
  assert.deepEqual(j([0, 0, 1], 0.4, [-0.2, 0.9]), { axis: [0, 0, 1], stand: -0.4, range: [-0.9, 0.2] }, 'a yaw joint: the same axis, the angle reflected');
  assert.deepEqual(j([1, 0, 0], 0.3, [-1, 1]), { axis: [1, 0, 0], stand: -0.3, range: [-1, 1] }, 'an abduction joint: as before');
  assert.deepEqual(j([1, 1, 0], 0.3, [-1, 1]), { axis: [-1, 1, 0], stand: 0.3, range: [-1, 1] }, 'a mixed axis: reflected, the angle kept');
  assert.deepEqual(j([0, 1, 0], 0.5, [0, 2]), { axis: [0, 1, 0], stand: 0.5, range: [0, 2] }, 'a pitch joint is the same on both sides');
  assert.deepEqual(j([0, 1, 1], 0.5, [0, 2]), { axis: [0, 1, -1], stand: 0.5, range: [0, 2] });
});

test('a cylinder leg\'s flat end rests on the floor: a vertical cylinder starts 4 mm above it, a tilted one reaches by its rim, a capsule by its round end', () => {
  const leg = (shape: string, to: number[]) => build(robot('c', { shape: 'sphere', size: [0.05], mass: 1, children: [{ name: 'leg', pos: [0, 0, 0], tags: ['legs'], joint: { axis: [0, 1, 0], range: [-1, 1], stand: 0 }, shape, from: [0, 0, 0], to, size: [0.05], mass: 0.1 }] })).json.stand_height_m;
  assert.ok(Math.abs(leg('cylinder', [0, 0, -0.2]) - 0.204) < 1e-4, `vertical cylinder: ${leg('cylinder', [0, 0, -0.2])}`);
  assert.ok(Math.abs(leg('capsule', [0, 0, -0.2]) - 0.254) < 1e-4, `vertical capsule: the round end adds its radius, ${leg('capsule', [0, 0, -0.2])}`);
  const tilted = leg('cylinder', [0.2, 0, -0.2]);
  assert.ok(tilted > 0.2 && tilted < 0.204 + 0.05 * Math.SQRT1_2 + 1e-4, `a cylinder at 45 degrees: its rim reaches ${(0.05 * Math.SQRT1_2).toFixed(3)} m below its end, got ${tilted}`);
});
