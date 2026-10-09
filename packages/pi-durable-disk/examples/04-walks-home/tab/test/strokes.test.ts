import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, PRESETS, validateDesign, type Design } from '../src/design.ts';
import { Sketcher } from '../src/sketch.ts';
import { nextStroke, pathPoints, TAKE_DESIGN, undrawable, type Geometry, type Point } from '../src/strokes.ts';
import { clampDesign } from '../src/rules.ts';
// @ts-expect-error the recorder script is plain JavaScript with no declaration file
import { sketchTake } from '../scripts/sketch-take.mjs';

/** A stub canvas that lets the real Sketcher run in node: it records the listeners so the test can press, move and release. */
function fakeCanvas(width = 800, height = 800) {
  const listeners: Record<string, (e: any) => void> = {};
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas: any = {
    clientWidth: width, clientHeight: height, width, height, style: {},
    getContext: () => ctx,
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    setPointerCapture: () => {},
  };
  (globalThis as any).devicePixelRatio ??= 1;
  return { canvas, fire: (type: string, p: Point) => listeners[type]?.({ clientX: p.x, clientY: p.y, pointerId: 1 }) };
}

/** Play a stroke's points on the sketcher as a recorder would: press at the first, move through the rest, release at the last. */
function play(fire: (t: string, p: Point) => void, points: Point[]) {
  fire('pointerdown', points[0]);
  for (const p of points.slice(1)) fire('pointermove', p);
  fire('pointerup', points[points.length - 1]);
}

function draw(target: Design, start = defaultDesign(), style: 'direct' | 'human' = 'human') {
  const { canvas, fire } = fakeCanvas();
  const sk = new Sketcher(canvas, start, () => {});
  const strokes: string[] = [];
  for (let i = 0; i < 14; i++) {
    const s = nextStroke(sk.geometry() as Geometry, target);
    if (!s) break;
    strokes.push(s.handle);
    play(fire, pathPoints(s, style));
  }
  return { design: sk.get(), strokes, sk };
}

test('the strokes draw the take creature from the default body, with the real sketcher, and stop when nothing is left', () => {
  const { design, strokes } = draw(TAKE_DESIGN);
  assert.ok(Math.abs(design.torso.length - 0.55) <= 0.002, `length ${design.torso.length}`);
  assert.ok(Math.abs(design.torso.width - 0.22) <= 0.002);
  for (const l of design.legs) assert.ok(Math.abs(l.thigh + l.shin - 0.5) <= 0.002, `reach ${l.thigh + l.shin}`);
  assert.deepEqual(design.legs.map((l) => l.x), [0.8, -0.8]);
  assert.equal(design.legDof, 3);
  assert.deepEqual(undrawable(design, TAKE_DESIGN), [], 'nothing about the take creature is beyond a stroke');
  assert.ok(strokes.length >= 3 && strokes.length <= 6, `strokes: ${strokes.join(' ')}`); // the torso nose, then the two leg handles
  assert.deepEqual(validateDesign(design), []);
  assert.deepEqual(clampDesign(design).messages, [], 'it passes the sketcher\'s own clamp');
});

test('both styles and any starting body arrive at a target within a few strokes: width, hips, lengths in both directions', () => {
  const target: Design = { ...defaultDesign(), name: 'q', torso: { length: 0.62, width: 0.3, height: 0.1 }, legs: [{ x: 0.6, thigh: 0.22, shin: 0.22, radius: 0.02 }, { x: -0.5, thigh: 0.22, shin: 0.22, radius: 0.02 }] };
  for (const style of ['direct', 'human'] as const) {
    for (const start of [defaultDesign(), { ...defaultDesign(), torso: { length: 0.8, width: 0.4, height: 0.1 } }]) {
      const { design } = draw(target, structuredClone(start), style);
      assert.ok(Math.abs(design.torso.length - 0.62) <= 0.002, `${style}: length ${design.torso.length}`);
      assert.ok(Math.abs(design.torso.width - 0.3) <= 0.002, `${style}: width ${design.torso.width}`);
      assert.ok(Math.abs(design.legs[0].x - 0.6) <= 0.01 && Math.abs(design.legs[1].x + 0.5) <= 0.01, `${style}: hips ${design.legs.map((l) => l.x)}`);
      for (const l of design.legs) assert.ok(Math.abs(l.thigh + l.shin - 0.44) <= 0.002, `${style}: reach ${l.thigh + l.shin}`);
    }
  }
});

test('nothing left to draw means no stroke; the planner reports what a stroke cannot change', () => {
  const { canvas } = fakeCanvas();
  const sk = new Sketcher(canvas, TAKE_DESIGN, () => {});
  assert.equal(nextStroke(sk.geometry() as Geometry, TAKE_DESIGN), null);
  const other = structuredClone(TAKE_DESIGN);
  other.torso.height = 0.12;
  other.legs[0].radius = 0.03;
  other.legs[1].thigh = 0.2; other.legs[1].shin = 0.3; // the ratio differs: a handle keeps the ratio it finds
  delete other.legDof;
  const u = undrawable(TAKE_DESIGN, other);
  assert.ok(u.some((x) => /torso.height/.test(x)) && u.some((x) => /radius/.test(x)) && u.some((x) => /thigh:shin/.test(x)) && u.some((x) => /legDof/.test(x)), u.join('; '));
  assert.equal(nextStroke(sk.geometry() as Geometry, other), null, 'only undrawable differences remain, so no stroke is proposed');
});

test('a stroke starts exactly on its handle and a human path overshoots and settles on the goal', () => {
  const { canvas } = fakeCanvas();
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const g = sk.geometry() as Geometry;
  const s = nextStroke(g, TAKE_DESIGN)!;
  const handle = g.handles.find((h) => h.name === s.handle)!;
  assert.equal(s.from.x, handle.x);
  assert.equal(s.from.y, handle.y);
  const human = pathPoints(s, 'human'), direct = pathPoints(s, 'direct');
  assert.deepEqual([human[0].x, human[0].y], [s.from.x, s.from.y]);
  assert.ok(Math.abs(human[human.length - 1].x - s.to.x) < 1e-9 && Math.abs(human[human.length - 1].y - s.to.y) < 1e-9, 'it ends on the goal');
  assert.ok(Math.abs(direct[direct.length - 1].x - s.to.x) < 1e-9);
  assert.ok(human.length > direct.length, 'the human path has the overshoot segment');
  const dx = s.to.x - s.from.x;
  const furthest = Math.max(...human.map((p) => (p.x - s.from.x) * Math.sign(dx)));
  assert.ok(furthest > Math.abs(dx) * 1.05, 'it goes past the goal before settling');
  // eased: slow at the ends
  assert.ok(Math.hypot(direct[1].x - direct[0].x, direct[1].y - direct[0].y) < Math.hypot(direct[9].x - direct[8].x, direct[9].y - direct[8].y));
});

test('the hips and leg handles are found after the torso is redrawn (the plan follows the sketch, not a precomputed path)', () => {
  const { canvas } = fakeCanvas(900, 700);
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const before = sk.geometry() as Geometry;
  sk.setLeg(0, { thigh: 0.3, shin: 0.3 });
  const after = sk.geometry() as Geometry;
  assert.notEqual(before.handles.find((h) => h.name === 'leg0')!.y, after.handles.find((h) => h.name === 'leg0')!.y);
  assert.ok(after.px >= 140 && after.px <= 520, 'the scale follows the canvas');
  assert.equal(after.handles.length, 2 + 2 * 2);
});

test('a stroke snaps to the grid: lengths to 1 cm, hips to 5% of the half torso, so a pointer a few millimetres off still gives the intended number', () => {
  const { canvas, fire } = fakeCanvas();
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const g = sk.geometry() as Geometry;
  const nose = g.handles.find((h) => h.name === 'length')!;
  // aim for a torso 0.554 m long: 4 mm off the 0.55 grid value (and well inside one screen pixel at this scale)
  fire('pointerdown', nose);
  fire('pointermove', { x: g.width / 2 + (0.554 / 2) * g.px, y: nose.y });
  fire('pointerup', { x: g.width / 2 + (0.554 / 2) * g.px, y: nose.y });
  assert.equal(sk.get().torso.length, 0.55);
  const leg = (sk.geometry() as Geometry).handles.find((h) => h.name === 'leg0')!;
  fire('pointerdown', leg);
  fire('pointermove', { x: leg.x, y: (g.height / 2) - (sk.get().torso.width / 2 + 0.473) * g.px });
  fire('pointerup', { x: leg.x, y: (g.height / 2) - (sk.get().torso.width / 2 + 0.473) * g.px });
  assert.equal(sk.get().legs[0].thigh + sk.get().legs[0].shin, 0.47);
});

test('a pixel of pointer error never stops the plan from converging on the target: every handle, with the pointer snapped to whole pixels', () => {
  const { canvas, fire } = fakeCanvas(620, 790); // a sketch pane about as big as the stage gives it
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const whole = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) }); // what a real mouse event carries
  for (let i = 0; i < 14; i++) {
    const s = nextStroke(sk.geometry() as Geometry, TAKE_DESIGN);
    if (!s) break;
    play(fire, pathPoints(s, 'human').map(whole));
  }
  const d = sk.get();
  assert.equal(d.torso.length, 0.55);
  for (const l of d.legs) assert.equal(l.thigh + l.shin, 0.5);
  assert.equal(nextStroke(sk.geometry() as Geometry, TAKE_DESIGN), null);
});

// ---- review: a sketch with more pairs than the target, targets between grid values, and a drawing that runs out of strokes ----

test('a sketch with more leg pairs than the target does not crash the plan', () => {
  // the take body with a third pair: the first two pairs already match, so the plan reaches the pair the target does not have
  const three = structuredClone(TAKE_DESIGN);
  three.legs.push({ x: 0, thigh: 0.25, shin: 0.25, radius: 0.02 });
  const { design, sk } = draw(structuredClone(TAKE_DESIGN), three);
  assert.equal(design.legs.length, 3, 'a stroke cannot remove a pair');
  assert.equal(nextStroke(sk.geometry() as Geometry, TAKE_DESIGN), null, 'the plan finishes on the pairs both bodies have');
  assert.ok(undrawable(design, TAKE_DESIGN).some((m) => /leg pairs/.test(m)), 'and the difference is reported');
  // the hexapod toward the take body (the review's example): planning every step must not throw, whatever the pairs are
  assert.doesNotThrow(() => draw(structuredClone(TAKE_DESIGN), structuredClone(PRESETS.hexapod)));
});

test('a target between grid values finishes on the nearest value the sketcher can draw, and the difference is reported', () => {
  const t = structuredClone(TAKE_DESIGN);
  t.torso.length = 0.555; t.torso.width = 0.223; t.legs[0].x = 0.82; t.legs[0].thigh = 0.2515; t.legs[0].shin = 0.2515; // none of these is a multiple of the grid step
  const { design, strokes, sk } = draw(t);
  assert.equal(nextStroke(sk.geometry() as Geometry, t), null, `the plan finishes (${strokes.length} strokes: ${strokes.join(' ')})`);
  assert.ok(strokes.length < 8, `without retrying an impossible value (${strokes.join(' ')})`);
  assert.ok(Math.abs(design.torso.length - 0.555) <= 0.0051 && Math.abs(design.torso.width - 0.223) <= 0.0051, `${design.torso.length} x ${design.torso.width}`);
  const left = undrawable(design, t);
  assert.ok(left.some((m) => m.startsWith('torso.length')) && left.some((m) => m.startsWith('legs[0].x')), `reported: ${left.join('; ')}`);
});

/** A tab as sketchTake sees it, backed by the real Sketcher on a stub canvas: the eval strings run against a stub document. */
function fakeTab(target: Design) {
  const { canvas, fire } = fakeCanvas(800, 800);
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const calls = { committed: 0 };
  const w = {
    innerWidth: 800, innerHeight: 800,
    __walks: {
      sketchGeometry: () => ({ rect: { left: 0, top: 0, width: 800, height: 800 }, ...sk.geometry() }),
      commitDesign: () => { calls.committed++; },
      state: () => ({ mjcf_sha256: 'x'.repeat(64) }),
    },
  };
  const document = { querySelector: () => ({ contentWindow: w, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }) }) };
  const tab = {
    send: async (method: string, p: any) => {
      if (method !== 'Input.dispatchMouseEvent') return;
      fire({ mousePressed: 'pointerdown', mouseMoved: 'pointermove', mouseReleased: 'pointerup' }[p.type as string]!, { x: p.x, y: p.y });
    },
    eval: async (expr: string) => new Function('document', `return ${expr}`)(document),
  };
  return { tab, calls, sk, target };
}

test('sketchTake commits a finished drawing, and throws without committing when it runs out of strokes with work left', async () => {
  const ok = fakeTab(TAKE_DESIGN);
  const r = await sketchTake(ok.tab, { stepMs: 0, restMs: 0 });
  assert.equal(ok.calls.committed, 1);
  assert.deepEqual(r.undrawable, []);
  const short = fakeTab(TAKE_DESIGN);
  await assert.rejects(sketchTake(short.tab, { stepMs: 0, restMs: 0, maxStrokes: 2 }), /2 strokes.*(leg|left)/i);
  assert.equal(short.calls.committed, 0, 'a partial drawing is never committed');
});
