import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, LIMITS, validateDesign, type Design } from '../src/design.ts';
import { footRadiusM, pxPerMetre, Sketcher, SKETCH_COLORS } from '../src/sketch.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { fakeCanvas } from './fakecanvas.ts';

/** The widest creature the sketcher allows: the widest torso, the longest legs, hips at both ends. */
function widest(): Design {
  const d = defaultDesign();
  d.torso = { length: LIMITS.torso.length[1], width: LIMITS.torso.width[1], height: 0.1 };
  d.legs = [{ x: 1, thigh: LIMITS.thigh[1], shin: LIMITS.shin[1], radius: 0.02 }, { x: -1, thigh: LIMITS.thigh[1], shin: LIMITS.shin[1], radius: 0.02 }];
  return d;
}

/** Where the leg handle of pair i is on a w x h canvas, in canvas pixels (the sketcher draws it at this place). */
const legHandle = (d: Design, i: number, w: number, h: number) => {
  const px = pxPerMetre({ clientWidth: w, clientHeight: h } as HTMLCanvasElement);
  return { x: w / 2 + ((d.legs[i].x * d.torso.length) / 2) * px, y: h / 2 - (d.torso.width / 2 + d.legs[i].thigh + d.legs[i].shin) * px };
};

test('every handle of the widest valid creature is on the canvas, on small and large sketch panes', () => {
  assert.deepEqual(validateDesign(widest()), [], 'the test body is a valid design');
  const d = widest();
  for (const [w, h] of [[320, 320], [620, 790], [900, 680], [1100, 520], [700, 500]]) {
    const px = pxPerMetre({ clientWidth: w, clientHeight: h } as HTMLCanvasElement);
    const farY = (d.torso.width / 2 + d.legs[0].thigh + d.legs[0].shin) * px; // the leg handles, above and below the centre
    const farX = (d.torso.length / 2) * px; // the nose handle and the outer hips
    assert.ok(h / 2 - farY >= 6, `${w}x${h}: the leg handle is ${Math.round(farY)} px from the centre on a pane ${h / 2} px to the edge`);
    assert.ok(w / 2 - farX >= 6, `${w}x${h}: the nose is ${Math.round(farX)} px from the centre on a pane ${w / 2} px to the edge`);
  }
});

test('a leg handle dragged to the longest reach is still on the pane and can be grabbed and dragged back', () => {
  const [w, h] = [620, 680];
  const { canvas, fire } = fakeCanvas(w, h);
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const start = legHandle(sk.get(), 0, w, h);
  fire('pointerdown', start);
  fire('pointermove', { x: start.x, y: 0 }); // as far up as the pointer can go
  fire('pointerup', { x: start.x, y: 0 });
  const out = sk.get();
  const grown = out.legs[0].thigh + out.legs[0].shin;
  assert.ok(grown > 0.4, `the leg grew (${grown})`);
  const at = legHandle(out, 0, w, h);
  assert.ok(at.y >= 1 && at.y <= h - 1, `its handle is on the pane at y=${Math.round(at.y)}`);
  fire('pointerdown', at);
  fire('pointermove', { x: at.x, y: h / 2 });
  fire('pointerup', { x: at.x, y: h / 2 });
  assert.ok(sk.get().legs[0].thigh + sk.get().legs[0].shin < grown, 'it came back');
});

test('the scale follows the pane, not the body: lengthening a leg does not rescale the sketch under the pointer', () => {
  const [w, h] = [620, 790];
  const a = pxPerMetre({ clientWidth: w, clientHeight: h } as HTMLCanvasElement);
  const { canvas } = fakeCanvas(w, h);
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  sk.setLeg(0, { thigh: 0.4, shin: 0.4 });
  assert.equal(pxPerMetre(canvas), a);
});

test('geometry() puts a handle where a pointer must be to grab it, on a canvas with a border (its box is bigger than its content)', () => {
  // the real sketch canvas: 578 x 768 of content inside a 1 px border, laid out at an offset in the page
  const { canvas, fire } = fakeCanvas(578, 768);
  canvas.getBoundingClientRect = () => ({ left: 10, top: 10, width: 579.6, height: 770 });
  const sk = new Sketcher(canvas, defaultDesign(), () => {});
  const press = (name: string) => {
    const g = sk.geometry(), r = canvas.getBoundingClientRect();
    const hd = g.handles.find((c) => c.name === name)!;
    return { x: r.left + hd.x, y: r.top + hd.y, g, r };
  };
  // the pointer sits exactly on the nose handle, then moves to the x of a 0.55 m torso: the sketcher reads it as 0.55, whole millimetres of the pointer's pixel grid aside
  const a = press('length');
  const toX = a.r.left + a.g.width / 2 + (0.55 / 2) * a.g.px; // geometry's own centre, so the planner's target is where geometry says it is
  fire('pointerdown', { x: a.x, y: a.y });
  fire('pointermove', { x: Math.round(toX), y: a.y }); // a pointer lands on whole pixels
  fire('pointerup', { x: Math.round(toX), y: a.y });
  assert.equal(sk.get().torso.length, 0.55, 'a stroke aimed by geometry() lands on the grid value it aims at');
});

// ---- the sketch has to read as the creature: the same colours, a foot at every leg end, and the word "top view" ----

/** A canvas whose 2D context records every call with the fill and stroke style in force. */
function recordingCanvas(width = 700, height = 700) {
  const calls: { fn: string; args: unknown[]; fill: unknown; stroke: unknown }[] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '' };
  const ctx: any = new Proxy({}, {
    get: (_t, k: string) => (k in state ? state[k] : (...args: unknown[]) => { calls.push({ fn: k, args, fill: state.fillStyle, stroke: state.strokeStyle }); }),
    set: (_t, k: string, v) => { state[k] = v; return true; },
  });
  const canvas: any = { clientWidth: width, clientHeight: height, width, height, style: {}, getContext: () => ctx, addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0, width, height }), setPointerCapture: () => {} };
  (globalThis as any).devicePixelRatio ??= 1;
  return { canvas, calls };
}

test('the sketch uses the creature\'s own colours: the torso, thigh, shin and foot colours of the MJCF', () => {
  const xml = buildMjcf(defaultDesign()).xml;
  const rgba = (re: RegExp) => { const m = xml.match(re); assert.ok(m, String(re)); return m![1]; };
  const toCss = (s: string) => '#' + s.split(' ').slice(0, 3).map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, '0')).join('');
  assert.deepEqual(SKETCH_COLORS, {
    torso: toCss(rgba(/name="torso_geom"[^>]*rgba="([^"]+)"/)),
    thigh: toCss(rgba(/<geom type="capsule" fromto="0 0 0 0 0 -[^"]+" size="[^"]+" contype="0" conaffinity="1" mass="0.25" rgba="([^"]+)"/)),
    shin: toCss(rgba(/mass="0.15" rgba="([^"]+)"/)),
    foot: toCss(rgba(/_foot"[^>]*rgba="([^"]+)"/)),
  });
});

test('the sketch is labelled "top view" and draws a foot at every leg end: four for the default body, six for three pairs', () => {
  for (const pairs of [2, 3]) {
    const d = defaultDesign();
    while (d.legs.length < pairs) d.legs.push({ ...d.legs[0], x: 0 });
    const { canvas, calls } = recordingCanvas();
    const sk = new Sketcher(canvas, d, () => {});
    calls.length = 0; // the constructor drew once already
    sk.draw();
    assert.ok(calls.some((c) => c.fn === 'fillText' && c.args[0] === 'top view'), 'the word is on the canvas');
    const feet = calls.filter((c) => c.fn === 'arc' && c.fill === SKETCH_COLORS.foot);
    assert.equal(feet.length, pairs * 2, `${pairs * 2} feet`);
    const ends = new Set(feet.map((c) => `${(c.args[0] as number).toFixed(3)},${(c.args[1] as number).toFixed(3)}`));
    assert.equal(ends.size, pairs * 2, 'at different places: a foot at each end of each pair');
  }
});

test('draw() paints with the creature\'s colours: thigh and shin strokes, a torso fill, a fill for every foot', () => {
  const d = defaultDesign();
  const { canvas, calls } = recordingCanvas();
  const sk = new Sketcher(canvas, d, () => {});
  calls.length = 0;
  sk.draw();
  const strokes = (c: string) => calls.filter((x) => x.fn === 'stroke' && x.stroke === c).length;
  const fills = (c: string) => calls.filter((x) => x.fn === 'fill' && x.fill === c).length;
  assert.equal(strokes(SKETCH_COLORS.thigh), d.legs.length * 2, 'a thigh stroke per leg');
  assert.equal(strokes(SKETCH_COLORS.shin), d.legs.length * 2, 'a shin stroke per leg');
  assert.equal(fills(SKETCH_COLORS.torso), 1, 'the torso is filled with the torso colour');
  assert.equal(fills(SKETCH_COLORS.foot), d.legs.length * 2, 'every foot is filled with the foot colour');
});

test('the ring on a leg handle always surrounds its foot, whatever the canvas size or the leg radius', () => {
  for (const [w, h, radius] of [[700, 700, 0.02], [700, 700, LIMITS.radius[1]], [1400, 1400, LIMITS.radius[1]], [320, 320, LIMITS.radius[1]]] as const) {
    const d = defaultDesign();
    for (const l of d.legs) l.radius = radius;
    const { canvas, calls } = recordingCanvas(w, h);
    const sk = new Sketcher(canvas, d, () => {});
    calls.length = 0;
    sk.draw();
    const px = pxPerMetre(canvas);
    const foot = calls.find((c) => c.fn === 'arc' && c.fill === SKETCH_COLORS.foot)!;
    const ring = calls.find((c, i) => c.fn === 'arc' && calls[i + 1]?.fn === 'stroke' && calls[i + 1].stroke === '#2d5fb3')!; // an arc stroked in the handle blue (a dot's arc is filled)
    const footPx = (foot.args[2] as number) * px;
    assert.ok((ring.args[2] as number) >= footPx + 3, `${w}x${h} radius ${radius}: the ring (${ring.args[2]} px) clears the foot (${footPx.toFixed(1)} px)`);
  }
});

test('a leg handle can be grabbed on its ring, however big the foot inside it is', () => {
  const [w, h] = [700, 700];
  const d = defaultDesign();
  for (const l of d.legs) l.radius = LIMITS.radius[1];
  const { canvas, fire } = fakeCanvas(w, h);
  const sk = new Sketcher(canvas, d, () => {});
  const px = pxPerMetre(canvas);
  const hd = sk.geometry().handles.find((c) => c.name === 'leg0')!;
  const ringPx = footRadiusM(LIMITS.radius[1], px) * px + 4;
  assert.ok(ringPx > 14, `the ring (${ringPx.toFixed(1)} px) is outside the usual 14 px grab radius, so this test means something`);
  fire('pointerdown', { x: hd.x + ringPx, y: hd.y }); // on the ring, to its right
  fire('pointermove', { x: hd.x + ringPx, y: hd.y - 20 }); // drag it up a little
  fire('pointerup', { x: hd.x + ringPx, y: hd.y - 20 });
  assert.ok(sk.get().legs[0].thigh + sk.get().legs[0].shin > d.legs[0].thigh + d.legs[0].shin, 'the leg reach changed: the ring grabbed the leg handle');
});
