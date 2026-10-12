// A borrowed brain: the old policy on a changed body of the same joint count runs (and stumbles), on one of another joint count it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { Policy, sha256Hex } from '../src/policy.ts';
import { borrowPolicy } from '../src/robot-fit.ts';
import { mj } from './helpers.ts';
import { Sim } from '../src/sim.ts';

const fixture = JSON.parse(readFileSync(new URL('../../policy/test/fixtures/policy.json', import.meta.url), 'utf8'));
const body2 = defaultDesign(2); // the body the fixture was trained for: 2-DOF legs, 4 legs, 8 joints

test('the fixture policy is for the 2-DOF quadruped, and Policy.load still refuses it on any other body', async () => {
  assert.equal(await sha256Hex(buildMjcf(body2).xml), fixture.mjcf_sha256);
  const longer = { ...body2, legs: body2.legs.map((l) => ({ ...l, thigh: 0.28, shin: 0.28 })) };
  const built = buildMjcf(longer);
  await assert.rejects(Policy.load(fixture, { mjcfSha256: await sha256Hex(built.xml), nj: built.jointNames.length }), /different body/);
});

test('borrowed on longer legs (same joints) it loads and drives the new body without NaN; on six legs it is refused', async () => {
  const longer = { ...body2, legs: body2.legs.map((l) => ({ ...l, thigh: 0.28, shin: 0.28 })) };
  const built = buildMjcf(longer);
  const borrowed = await borrowPolicy(fixture, built.jointNames.length);
  assert.ok(borrowed, 'the old network fits the longer body');
  const six = buildMjcf({ ...body2, legs: [body2.legs[0]!, { x: 0, thigh: 0.2, shin: 0.2, radius: 0.02 }, body2.legs[1]!] });
  assert.equal(await borrowPolicy(fixture, six.jointNames.length), null, 'twelve joints cannot run an eight-joint network');
  const sim = new Sim(mj, built);
  sim.command = 0.5;
  for (let i = 0; i < 400; i++) sim.step(borrowed);
  const [x, y] = sim.torsoPos();
  assert.ok(Number.isFinite(x) && Number.isFinite(y), 'no NaN after 8 simulated seconds');
});

test('every morph preset of the robot tools builds, compiles and stands unaided for 4 s (the robot-tools presets the local model offers)', async () => {
  const { MORPH_PRESETS, morphDesign } = await import('../../../03-tab-to-cloud/robot-model.ts');
  const { fixture } = await import('./helpers.ts');
  const standing: Record<string, number> = {};
  for (const p of MORPH_PRESETS.filter((x) => x !== 'original')) {
    const d = morphDesign(p);
    const { built } = await fixture(d as never);
    const sim = new Sim(mj, built);
    for (let i = 0; i < 200; i++) sim.step(null);
    standing[p] = Math.round(sim.uprightness() * 100) / 100;
  }
  const down = Object.entries(standing).filter(([, u]) => !(u > 0.9));
  assert.deepEqual(down, [], `presets that do not stand: ${JSON.stringify(standing)}`);
});
