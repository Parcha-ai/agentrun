import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CLOTH_H, CLOTH_W, POLE_H, clothGeometry, fitFrame, flagView, type Box } from '../src/flagview.ts';
import { FLAG } from '../src/goal.ts';

/** Every corner of the boxes through a real three camera placed as the view places it: the largest |x| and |y| on screen (-1..1 is the pane). */
function onScreen(boxes: readonly Box[], dir: THREE.Vector3, w: number, h: number): number {
  const fov = 45, aspect = w / h;
  const { center, dist } = fitFrame(boxes, dir, fov, aspect);
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.02, 100);
  cam.up.set(0, 0, 1);
  cam.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  let worst = 0;
  for (const b of boxes) for (const x of [b[0]!, b[3]!]) for (const y of [b[1]!, b[4]!]) for (const z of [b[2]!, b[5]!]) {
    const p = new THREE.Vector3(x, y, z).project(cam);
    worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
  }
  return worst;
}

// a long-tailed robot standing at the start, and the flag's pole and cloth
const robot: Box = [-1.1, -0.35, 0, 0.6, 0.35, 0.95];
const flag: Box = [FLAG.x - 0.12, FLAG.y - 0.05, 0, FLAG.x + 0.12, FLAG.y + CLOTH_W + 0.05, POLE_H + 0.05];
const sizes: [string, number, number][] = [['the phone strip', 390, 340], ['the keyboard up', 390, 236], ['the whole phone', 390, 844], ['the laptop pane', 660, 760]];

test('the robot and the flag fit the pane, every corner, at the phone and laptop sizes, from the view for that shape and from where a user might orbit to (the flag near the camera)', () => {
  for (const [name, w, h] of sizes) {
    const dirs = [flagView(w / h), new THREE.Vector3(1, 0.3, 0.5), new THREE.Vector3(0.2, -1, 0.3), new THREE.Vector3(-1, 0, 0.2), new THREE.Vector3(0.6, 0.6, 0.9)];
    for (const dir of dirs) {
      const worst = onScreen([robot, flag], dir, w, h);
      assert.ok(worst <= 1, `${name}, from (${dir.toArray().map((v) => v.toFixed(2))}): a corner at ${worst.toFixed(3)} is outside the pane`);
    }
  }
});

test('and the fit is tight: with the air it leaves, the farthest corner is near the edge, so the robot is as large as the flag allows', () => {
  for (const [name, w, h] of sizes) {
    const worst = onScreen([robot, flag], flagView(w / h), w, h);
    assert.ok(worst >= 0.8 && worst <= 1 / 1.12 + 0.02, `${name}: the farthest corner at ${worst.toFixed(3)}`);
  }
});

test('the cloth hangs from the pole: its near edge on the pole, CLOTH_W along +y, CLOTH_H tall, its top just under the top of the pole, flat in the y-z plane', () => {
  const geo = clothGeometry();
  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  assert.ok(Math.abs(b.min.y) < 1e-6, `near edge at y ${b.min.y}`); // positions are float32
  assert.ok(Math.abs(b.max.y - CLOTH_W) < 1e-6, `far edge at y ${b.max.y}`);
  assert.ok(Math.abs(b.max.z - b.min.z - CLOTH_H) < 1e-6, `height ${b.max.z - b.min.z}`);
  assert.ok(b.max.z <= POLE_H && b.max.z > POLE_H - 0.05, `top at z ${b.max.z}`);
  assert.ok(Math.abs(b.max.x - b.min.x) < 1e-6, 'flat');
});
