// Planning the pointer strokes that draw a creature on the sketcher, for a recorder that drives the page with real mouse events.
// Pure: given where the handles are on screen (Sketcher.geometry()) and the design wanted, the next stroke is a press on one
// handle and a drag to where it must go; the recorder plays it, asks the page for the geometry again, and repeats until nothing
// is left to draw. Planning from the page's own answer after every stroke keeps it right when a drag rounds or a clamp bites.

import { LIMITS, type Design } from './design.ts';
import { goalHip, goalLength, goalReach } from './sketch.ts';

export interface HandleGeometry { name: string; kind: string; i: number | null; x: number; y: number }
export interface Geometry { px: number; width: number; height: number; design: Design; handles: HandleGeometry[] }
export interface Point { x: number; y: number }
export interface Stroke { handle: string; from: Point; to: Point }

/** The creature the v2 take draws: the default body, longer in the torso and longer in the legs, so it is the user's own and not a preset. Thigh and shin are equal because the leg handle scales both together. */
export const TAKE_DESIGN: Design = {
  version: 1, name: 'quadruped', legDof: 3,
  torso: { length: 0.55, width: 0.22, height: 0.1 },
  legs: [{ x: 0.8, thigh: 0.25, shin: 0.25, radius: 0.02 }, { x: -0.8, thigh: 0.25, shin: 0.25, radius: 0.02 }],
};

const TOL_M = 0.004; // lengths snap to 1 cm (SNAP_LENGTH_M): within 4 mm means it is on the right grid value
const TOL_X = 0.02; // hip position snaps to 0.05 of the half torso

const find = (g: Geometry, name: string): HandleGeometry => {
  const h = g.handles.find((c) => c.name === name);
  if (!h) throw new Error(`the sketcher has no handle ${name}`);
  return h;
};

/**
 * The next stroke toward `target`, or null when everything a stroke can change (torso length and width, each hip's place along the
 * torso, each pair's leg reach) is on the grid value of it. Order: length, width, hips, legs, because each depends on the ones before.
 * What a stroke cannot draw (torso height, radius, the split between thigh and shin, joints per leg) is listed by `undrawable`.
 */
export function nextStroke(g: Geometry, target: Design): Stroke | null {
  const d = g.design, t = target;
  const { px, width: w, height: h } = g;
  const X = (m: number) => w / 2 + m * px, Y = (m: number) => h / 2 - m * px;
  // Aim at what the sketcher can end on (its grid, its limits), not at the raw target: a number between grid values would never be reached.
  const length = goalLength(t.torso.length, LIMITS.torso.length), width = goalLength(t.torso.width, LIMITS.torso.width);
  if (Math.abs(d.torso.length - length) > TOL_M) {
    const from = find(g, 'length');
    return { handle: 'length', from, to: { x: X(length / 2), y: from.y } };
  }
  if (Math.abs(d.torso.width - width) > TOL_M) {
    const from = find(g, 'width');
    return { handle: 'width', from, to: { x: from.x, y: Y(width / 2) } };
  }
  // pairs are matched by index; a pair the target does not have is left as it is (`undrawable` reports the difference)
  for (let i = 0; i < d.legs.length && i < t.legs.length; i++) {
    const hip = goalHip(t.legs[i].x);
    if (Math.abs(d.legs[i].x - hip) > TOL_X) {
      const from = find(g, `hip${i}`);
      return { handle: `hip${i}`, from, to: { x: X((hip * d.torso.length) / 2), y: from.y } };
    }
  }
  for (let i = 0; i < d.legs.length && i < t.legs.length; i++) {
    const have = d.legs[i].thigh + d.legs[i].shin, want = goalReach(t.legs[i].thigh + t.legs[i].shin);
    if (Math.abs(have - want) > TOL_M) {
      const from = find(g, `leg${i}`);
      return { handle: `leg${i}`, from, to: { x: from.x, y: Y(d.torso.width / 2 + want) } };
    }
  }
  return null;
}

/** What no stroke can change, between the sketch now and the target: the target's own numbers, for the report. */
export function undrawable(d: Design, t: Design): string[] {
  const out: string[] = [];
  // what the grid cannot draw: the sketcher ends on multiples of its step, so a target between them is reported, not retried
  if (Math.abs(d.torso.length - t.torso.length) > 1e-6) out.push(`torso.length ${d.torso.length} vs ${t.torso.length} (drawn in steps of 0.01)`);
  if (Math.abs(d.torso.width - t.torso.width) > 1e-6) out.push(`torso.width ${d.torso.width} vs ${t.torso.width} (drawn in steps of 0.01)`);
  if (d.torso.height !== t.torso.height) out.push(`torso.height ${d.torso.height} vs ${t.torso.height}`);
  if ((d.legDof ?? 2) !== (t.legDof ?? 2)) out.push(`legDof ${d.legDof ?? 2} vs ${t.legDof ?? 2}`);
  if (d.legs.length !== t.legs.length) out.push(`${d.legs.length} leg pairs vs ${t.legs.length}`);
  d.legs.forEach((l, i) => {
    const w = t.legs[i];
    if (!w) return;
    if (Math.abs(l.x - w.x) > 1e-6) out.push(`legs[${i}].x ${l.x} vs ${w.x} (placed in steps of 0.05)`);
    if (Math.abs(l.thigh + l.shin - (w.thigh + w.shin)) > 1e-6) out.push(`legs[${i}] reach ${+(l.thigh + l.shin).toFixed(3)} vs ${+(w.thigh + w.shin).toFixed(3)} (drawn in steps of 0.01)`);
    if (Math.abs(l.radius - w.radius) > 1e-9) out.push(`legs[${i}].radius ${l.radius} vs ${w.radius}`);
    // the leg handle keeps the thigh to shin ratio it finds, so only a different ratio is undrawable
    if (Math.abs(l.thigh / (l.thigh + l.shin) - w.thigh / (w.thigh + w.shin)) > 0.01) out.push(`legs[${i}] thigh:shin ${l.thigh}:${l.shin} vs ${w.thigh}:${w.shin}`);
  });
  return out;
}

/**
 * The points of one stroke, as a hand would make it: eased, and in the `human` style a little past the goal and back. Positions in
 * the same space as the stroke's (canvas pixels), `steps` points per segment including both ends.
 */
export function pathPoints(s: Stroke, style: 'direct' | 'human' = 'human', steps = 18): Point[] {
  const ease = (t: number) => t * t * (3 - 2 * t);
  const seg = (a: Point, b: Point) => Array.from({ length: steps }, (_, k) => {
    const e = ease(k / (steps - 1));
    return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
  });
  if (style === 'direct') return seg(s.from, s.to);
  const over = { x: s.to.x + (s.to.x - s.from.x) * 0.1, y: s.to.y + (s.to.y - s.from.y) * 0.1 };
  return [...seg(s.from, over), ...seg(over, s.to).slice(1)];
}
