import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesign, LIMITS, validateDesign, type Design } from '../src/design.ts';
import { pxPerMetre, Sketcher } from '../src/sketch.ts';
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
