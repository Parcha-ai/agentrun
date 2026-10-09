import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, LIMITS, PRESETS, validateDesign, type Design } from '../src/design.ts';
import { BACK_GETUP_BAND, backGetupMargin, backGetupPrediction, bodyNotes, clampDesign, MAX_REACH_RATIO, MEASURED, reach, reachRatio } from '../src/rules.ts';

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

test('a sketched body that is not one of ours gets a plain "not trained" note, and the 2-joint caution only when it has 2 joints per leg', () => {
  const custom = structuredClone(PRESETS.quadruped);
  custom.torso.length = 0.55;
  const n = bodyNotes(custom);
  assert.equal(n[0].level, 'info');
  assert.match(n[0].text, /no policy for this exact body yet/);
  assert.equal(n.some((x) => /right itself|Unverified/.test(x.text)), false, 'margin 1.25: nothing to say about its back');
  const twoJoint = structuredClone(custom);
  delete twoJoint.legDof;
  assert.ok(bodyNotes(twoJoint).some((x) => /hip abduction/.test(x.text)));
  assert.equal(bodyNotes(custom).some((x) => /hip abduction/.test(x.text)), false);
});

// ---- the back-getup prediction (the trainer's geometric rule, checked against the measurements) -------------------------

const asymDesign = MEASURED.find((k) => k.design.name === 'asym')!.design;
const SIX: [string, Design, number, 'cannot' | 'can'][] = [
  ['quadruped', PRESETS.quadruped, 1.25, 'can'],
  ['long legs', PRESETS['long legs'], 2.07, 'can'],
  ['hexapod', PRESETS.hexapod, 1.31, 'can'],
  ['stubby', stubby, 0.55, 'cannot'],
  ['asym', asymDesign, 0.77, 'cannot'],
  ['stilts', stilts, 5.33, 'can'],
];

test('the margin and the prediction for each body, as the trainer tabulated them (stubby and asym are the two that cannot)', () => {
  for (const [name, d, margin, want] of SIX) {
    assert.ok(Math.abs(backGetupMargin(d) - margin) < 0.01, `${name}: margin ${backGetupMargin(d).toFixed(3)}, expected ${margin}`);
    assert.equal(backGetupPrediction(d), want, name);
  }
  assert.equal(backGetupPrediction(PRESETS['quadruped 2-DOF']), 'can', 'the 2-joint body has the same dimensions as the quadruped');
});

test('the prediction agrees with what was measured on every trained body: it says cannot exactly where the measured label says the back is a problem', () => {
  for (const k of MEASURED) {
    if (k.design.name === 'quadruped' && k.design.legDof !== 3) continue; // the 2-joint body: no getup network was trained, nothing measured about its back
    const text = k.notes.map((n) => n.text).join(' ');
    const measuredProblem = /cannot get up from its back|gets up unreliably/.test(text);
    assert.equal(backGetupPrediction(k.design) === 'cannot', measuredProblem, `${k.design.name}: ${text.slice(0, 60)}`);
  }
});

test('a trained body keeps its measured labels and gets no prediction note; a sketched one below the limit gets the prediction, worded as one', () => {
  for (const [, d] of SIX) {
    const t = bodyNotes(d).map((n) => n.text).join(' ');
    assert.doesNotMatch(t, /Prediction, not a measurement|Unverified/, `${d.name}: measured labels only`);
  }
  const sketched = structuredClone(PRESETS.quadruped);
  sketched.name = 'mine';
  sketched.legs.forEach((l) => { l.thigh = 0.1; l.shin = 0.1; }); // shortest pair 0.2 m against width + height 0.32 m: margin 0.625
  const warn = bodyNotes(sketched).find((n) => /Prediction, not a measurement/.test(n.text));
  assert.ok(warn && warn.level === 'warn');
  assert.match(warn!.text, /can't right itself from its back/);
  assert.match(warn!.text, /0\.20 m\) is shorter than its torso width plus height \(0\.32 m, ratio 0\.63\)/);
  assert.match(warn!.text, /stubby, asym/);
  assert.doesNotMatch(warn!.text, /measured (that|on this)/i, 'it never claims to be a measurement of this body');
  // the measured notes of a trained body are untouched: the prediction replaced only the old short-legs caution for sketched bodies
  assert.deepEqual(bodyNotes(stubby), MEASURED.find((k) => k.design.name === 'stubby')!.notes);
});

test('within 10% of the limit the body is called unverified, on both sides; outside it, cannot or can', () => {
  const at = (ratio: number): Design => {
    const d = structuredClone(PRESETS.quadruped);
    d.name = 'mine';
    const limit = d.torso.width + d.torso.height; // 0.32
    d.legs.forEach((l) => { l.thigh = ratio * limit / 2; l.shin = ratio * limit / 2; });
    return d;
  };
  assert.equal(BACK_GETUP_BAND, 0.1);
  for (const [ratio, want] of [[0.85, 'cannot'], [0.89, 'cannot'], [0.9, 'unverified'], [0.91, 'unverified'], [1.0, 'unverified'], [1.09, 'unverified'], [1.1, 'unverified'], [1.12, 'can'], [1.3, 'can']] as const) {
    assert.equal(backGetupPrediction(at(ratio)), want, `ratio ${ratio}`);
  }
  const t = bodyNotes(at(1.05)).find((n) => /Unverified/.test(n.text));
  assert.ok(t, 'a note for the unverified band');
  assert.match(t!.text, /whether this body can right itself from its back is not known/);
  assert.equal(bodyNotes(at(1.3)).some((n) => /right itself|Unverified/.test(n.text)), false, 'a clear pass says nothing');
});

test('the reach thresholds sit between the measured bodies: long legs under the clamp, stilts over it', () => {
  assert.ok(reachRatio(PRESETS['long legs']) < MAX_REACH_RATIO);
  assert.ok(reach(stilts) / stilts.torso.length > MAX_REACH_RATIO);
});
