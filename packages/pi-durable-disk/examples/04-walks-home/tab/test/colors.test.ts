import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, PRESETS } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { mj } from './helpers.ts';
import { PAIR_COLORS, legOfBodyName, legOfGeomBody, pairColors } from '../src/colors.ts';

test('every leg pair has its own thigh and shin colours, and the pairs differ from each other', () => {
  assert.ok(PAIR_COLORS.length >= 3, 'three pairs is the most a design may have');
  const seen = new Set(PAIR_COLORS.map((c) => c.thigh));
  assert.equal(seen.size, PAIR_COLORS.length, 'no two pairs share a thigh colour');
  for (const c of PAIR_COLORS) assert.notEqual(c.thigh, c.shin, 'a thigh and its shin are two shades');
  assert.deepEqual(pairColors(0), PAIR_COLORS[0]);
  assert.deepEqual(pairColors(7), PAIR_COLORS[7 % PAIR_COLORS.length], 'an index past the table wraps instead of failing');
});

test('a leg body is recognised by the NAME the MJCF gives it: l0_thigh, r1_shin ... and nothing else is', () => {
  assert.deepEqual(legOfBodyName('l0_thigh'), { pair: 0, part: 'thigh' });
  assert.deepEqual(legOfBodyName('r2_shin'), { pair: 2, part: 'shin' });
  assert.deepEqual(legOfBodyName('l10_thigh'), { pair: 10, part: 'thigh' });
  for (const n of ['torso', 'world', '', 'l0', 'l0_foot', 'x0_thigh', 'l0_thigh_extra']) assert.equal(legOfBodyName(n), null, n);
});

test('in the real compiled model, every body MuJoCo calls a leg maps to the pair its name says, for 2 and 3 pairs and both leg kinds (read through MuJoCo, not computed from ids)', () => {
  for (const design of [defaultDesign(), defaultDesign(2), PRESETS.hexapod]) {
    const built = buildMjcf(design);
    const model = mj.MjModel.from_xml_string(built.xml);
    const legs: string[] = [];
    for (let b = 0; b < model.nbody; b++) {
      const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, b);
      const leg = legOfGeomBody(mj, model, b);
      const m = /^[lr](\d+)_(thigh|shin)$/.exec(name);
      if (m) { legs.push(name); assert.deepEqual(leg, { pair: Number(m[1]), part: m[2] }, `body ${b} ${name}`); }
      else assert.equal(leg, null, `body ${b} ${JSON.stringify(name)} is not a leg`);
    }
    assert.equal(legs.length, design.legs.length * 4, `${design.legs.length} pairs: four leg bodies each`);
    model.delete();
  }
});
