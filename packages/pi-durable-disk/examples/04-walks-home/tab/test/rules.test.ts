import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, LIMITS, PRESETS, validateDesign, type Design } from '../src/design.ts';
import { bodyNotes, clampDesign, MAX_REACH_RATIO, MEASURED, reach, reachRatio, SHORT_REACH_RATIO } from '../src/rules.ts';

const stilts = MEASURED.find((k) => k.design.name === 'stilts')!.design;
const stubby = PRESETS.stubby;

// ---- the clamp ---------------------------------------------------------------------------------------------------

test('no preset and no trained body is touched by the clamp', () => {
  for (const k of MEASURED) {
    const { design, messages } = clampDesign(k.design);
    if (k.design.name === 'stilts') continue; // the one body the clamp exists to keep out
    assert.deepEqual(messages, [], k.design.name);
    assert.deepEqual(design, k.design, k.design.name);
  }
});

test('stilts are shortened to the allowed reach, thigh and shin by the same factor, and nothing else changes', () => {
  assert.ok(reachRatio(stilts) > 3.9);
  const { design, messages } = clampDesign(stilts);
  assert.equal(messages.length, 2, 'one message per pair that was too long');
  assert.ok(reachRatio(design) <= MAX_REACH_RATIO + 1e-9, `ratio ${reachRatio(design)}`);
  assert.ok(reachRatio(design) > MAX_REACH_RATIO - 0.01, 'shortened to the limit, not below it');
  for (const l of design.legs) assert.ok(Math.abs(l.thigh - l.shin) < 1e-9, 'equal thigh and shin stay equal');
  assert.deepEqual({ ...design, legs: design.legs.map((l) => ({ x: l.x, radius: l.radius })) }, { ...stilts, legs: stilts.legs.map((l) => ({ x: l.x, radius: l.radius })) }, 'torso, positions, radii, legDof untouched');
  assert.deepEqual(validateDesign(design), [], 'still a valid design');
  assert.match(messages[0], /Leg pair 1 shortened from 0\.80 m to 0\.30 m/);
  assert.match(messages[0], /0\.2 m\/s along its heading/, 'the message says why, from the measurement');
});

test('the clamp keeps the thigh to shin ratio of an uneven pair, is idempotent, and only shortens the pair that is too long', () => {
  const d: Design = { ...defaultDesign(3), torso: { length: 0.3, width: 0.2, height: 0.1 }, legs: [{ x: 0.8, thigh: 0.3, shin: 0.4, radius: 0.02 }, { x: -0.8, thigh: 0.1, shin: 0.1, radius: 0.02 }] };
  const { design, messages } = clampDesign(d); // limit = 0.45 m; pair 1 reaches 0.7 m
  assert.equal(messages.length, 1);
  assert.ok(Math.abs(design.legs[0].thigh / design.legs[0].shin - 0.3 / 0.4) < 0.01);
  assert.ok(design.legs[0].thigh + design.legs[0].shin <= 0.45 + 0.002);
  assert.deepEqual(design.legs[1], d.legs[1]);
  assert.deepEqual(clampDesign(design).messages, [], 'a clamped design passes unchanged');
});

test('shortening the torso shortens the legs of a body that was fine, and never goes below the sketcher\'s own minimum leg length', () => {
  const d = structuredClone(PRESETS['long legs']);
  d.torso.length = LIMITS.torso.length[0]; // 0.2 m: allowed reach 0.3 m, the preset has 0.6
  const { design } = clampDesign(d);
  for (const l of design.legs) {
    assert.ok(l.thigh >= LIMITS.thigh[0] && l.shin >= LIMITS.shin[0]);
    assert.ok(l.thigh + l.shin <= 0.3 + 0.002);
  }
  assert.deepEqual(validateDesign(design), []);
});

// ---- the labels ----------------------------------------------------------------------------------------------------

test('every body we trained has notes, and the ones that cannot get up say so', () => {
  const text = (d: Design) => bodyNotes(d).map((n) => n.text).join(' | ');
  assert.equal(bodyNotes(PRESETS.quadruped).every((n) => n.level === 'ok'), true);
  assert.equal(bodyNotes(PRESETS['long legs']).every((n) => n.level === 'ok'), true);
  assert.equal(bodyNotes(PRESETS.hexapod).every((n) => n.level === 'ok'), true);
  assert.match(text(PRESETS.stubby), /cannot get up from its back/);
  assert.equal(bodyNotes(PRESETS.stubby).some((n) => n.level === 'warn'), true);
  const asym = MEASURED.find((k) => k.design.name === 'asym')!.design;
  assert.match(text(asym), /gets up unreliably/);
  assert.match(text(stilts), /barely walks/);
  assert.match(text(PRESETS['quadruped 2-DOF']), /flips sideways at 80 N/);
});

test('a getup claim appears only for bodies where it was measured', () => {
  const claim = /gets up from every side|get up from every side|gets up from its sides in|gets up from its left side/;
  const text = (name: string) => MEASURED.find((k) => k.design.name === name)!.notes.map((n) => n.text).join(' ');
  for (const name of ['quadruped', 'long-legs', 'hexapod']) assert.match(text(name), claim, `${name}: measured to get up from every side`);
  assert.match(text('stilts'), /get up from every side in under 1 s/, 'stilts do get up from every side');
  for (const name of ['stubby', 'asym']) {
    assert.doesNotMatch(text(name), /gets? up from every side/, `${name}: must not claim a getup from every side`);
  }
  assert.match(text('stubby'), /cannot get up from its back/);
  assert.match(text('asym'), /gets up unreliably/);
});

test('a sketched body that is not one of ours gets an honest "not trained" note, a short-legs caution only when it is short, and the 2-joint caution', () => {
  const custom = structuredClone(PRESETS.quadruped);
  custom.torso.length = 0.55;
  const n = bodyNotes(custom);
  assert.equal(n[0].level, 'info');
  assert.match(n[0].text, /no policy for this exact body yet/);
  assert.equal(n.some((x) => /Short legs/.test(x.text)), false, 'reach ratio 0.73 is not short');
  assert.ok(reachRatio(custom) > SHORT_REACH_RATIO);

  const shortLegs = structuredClone(custom);
  shortLegs.legs.forEach((l) => { l.thigh = 0.1; l.shin = 0.1; }); // 0.2 / 0.55 = 0.36
  const s = bodyNotes(shortLegs).find((x) => /Short legs/.test(x.text));
  assert.ok(s && s.level === 'warn');
  assert.match(s!.text, /prediction from that one body, not a measurement of yours/);

  const twoJoint = structuredClone(custom);
  delete twoJoint.legDof;
  assert.ok(bodyNotes(twoJoint).some((x) => /hip abduction/.test(x.text)));
  assert.equal(bodyNotes(custom).some((x) => /hip abduction/.test(x.text)), false);
});

test('the reach thresholds sit between the measured bodies: stubby below the short limit, hexapod above it, long legs under the clamp', () => {
  assert.ok(reachRatio(stubby) < SHORT_REACH_RATIO);
  assert.ok(reachRatio(PRESETS.hexapod) > SHORT_REACH_RATIO);
  assert.ok(reachRatio(PRESETS['long legs']) < MAX_REACH_RATIO);
  assert.ok(reach(stilts) / stilts.torso.length > MAX_REACH_RATIO);
});
