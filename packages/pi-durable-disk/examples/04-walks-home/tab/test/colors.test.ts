import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, PRESETS } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { PAIR_COLORS, legPairOfBody, pairColors } from '../src/colors.ts';

test('every leg pair has its own thigh and shin colours, and the pairs differ from each other', () => {
  assert.ok(PAIR_COLORS.length >= 3, 'three pairs is the most a design may have');
  const seen = new Set(PAIR_COLORS.map((c) => c.thigh));
  assert.equal(seen.size, PAIR_COLORS.length, 'no two pairs share a thigh colour');
  for (const c of PAIR_COLORS) assert.notEqual(c.thigh, c.shin, 'a thigh and its shin are two shades');
  assert.deepEqual(pairColors(0), PAIR_COLORS[0]);
  assert.deepEqual(pairColors(7), PAIR_COLORS[7 % PAIR_COLORS.length], 'an index past the table wraps instead of failing');
});

test('the body ids MuJoCo gives (depth first, in document order) map back to the leg pair the MJCF names, for 2 and 3 pairs', () => {
  for (const design of [defaultDesign(), PRESETS.hexapod]) {
    const xml = buildMjcf(design).xml;
    const names = [...xml.matchAll(/<body name="([lr])(\d+)_(thigh|shin)"/g)].map((m) => ({ pair: Number(m[2]), part: m[3] }));
    assert.equal(names.length, design.legs.length * 4);
    names.forEach((n, i) => {
      const id = 2 + i; // the torso is body 1, the world 0
      assert.equal(legPairOfBody(id)?.pair, n.pair, `body ${id} is ${n.pair}`);
      assert.equal(legPairOfBody(id)?.part, n.part);
    });
  }
  assert.equal(legPairOfBody(0), null, 'the world is not a leg');
  assert.equal(legPairOfBody(1), null, 'the torso is not a leg');
});
