// The flag's geometry and the hero camera's framing of the robot and the flag: three's maths only (no renderer, no DOM), so node checks them.
import * as THREE from 'three';

/** The cloth's size (metres) and the pole's height. */
export const CLOTH_W = 0.34, CLOTH_H = 0.21, POLE_H = 0.8;

/**
 * The hero camera's direction from what it frames when there is a flag, by the pane's shape: in a tall pane (the laptop's) from behind the robot and to its right, looking down the walk (+x) with the
 * flag ahead and the robot large in front; in a wide one (the phone's strip) from the side, the robot on the left and the flag on the right. Between the two, a blend.
 */
export function flagView(aspect: number): THREE.Vector3 {
  const k = Math.min(1, Math.max(0, (aspect - 0.9) / 0.8));
  return new THREE.Vector3(-1, -0.62, 0.42).normalize().lerp(new THREE.Vector3(-0.35, -1, 0.42).normalize(), k).normalize();
}

/** The cloth, in the flag's frame (the pole stands at x = y = 0): it hangs from the pole towards +y, in the y-z plane, so it faces down the walk, at the camera behind the robot. */
export function clothGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, 12, 6); // in the x-y plane: the width along x, the height along y
  geo.rotateX(Math.PI / 2); // the height to z
  geo.rotateZ(Math.PI / 2); // the width to y
  geo.translate(0, CLOTH_W / 2, POLE_H - CLOTH_H / 2 - 0.01); // the near edge on the pole, the top just under the pole's top
  return geo;
}

/** An axis-aligned box: [x0, y0, z0, x1, y1, z1]. */
export type Box = readonly number[];

/**
 * Where the camera stands to hold every corner of `boxes` in its view: the centre between them, and the distance along `dir` (the camera at centre + dir * dist, looking at the centre, z up) at which
 * every corner is inside a `fovDeg` (vertical) by `aspect` view, times `air`.
 */
export function fitFrame(boxes: readonly Box[], dir: THREE.Vector3, fovDeg: number, aspect: number, air = 1.12): { center: THREE.Vector3; dist: number } {
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[k]!)));
  const hi = [3, 4, 5].map((k) => Math.max(...boxes.map((b) => b[k]!)));
  const center = new THREE.Vector3((lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2);
  const fwd = dir.clone().normalize().negate();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 0, 1)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const vTan = Math.tan((fovDeg * Math.PI) / 360), hTan = vTan * aspect;
  let dist = 0;
  // a corner `depth` beyond the centre (along the view) is dist + depth in front of the camera, so it is inside the view when |lateral| <= tan * (dist + depth)
  for (const b of boxes) for (const cx of [b[0]!, b[3]!]) for (const cy of [b[1]!, b[4]!]) for (const cz of [b[2]!, b[5]!]) {
    const v = new THREE.Vector3(cx, cy, cz).sub(center);
    const depth = v.dot(fwd);
    dist = Math.max(dist, Math.abs(v.dot(right)) / hTan - depth, Math.abs(v.dot(up)) / vTan - depth);
  }
  return { center, dist: dist * air };
}
