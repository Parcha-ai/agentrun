// The stand-in policy used until a trained one arrives: an open-loop diagonal trot. Not part of the policy contract
// (policy.ts is the trainer's); it only has to be a valid mlp-v1 file for the body it is built for.

import { f32ToBase64, type PolicyFile } from './policy.ts';

/** The stand-in used until a trained policy arrives: an open-loop trot, linear in (sin, cos) of the gait clock. */
export function dummyPolicy(opts: { mjcfSha256: string; mujocoVersion: string; nj: number; jointsPerLeg?: 2 | 3; gaitHz?: number; amp?: number }): PolicyFile {
  const { nj } = opts;
  const jpl = opts.jointsPerLeg ?? 2;
  const amp = opts.amp ?? 0.25;
  const spec = [{ name: 'phase' as const, size: 2 }];
  const w = new Float32Array(nj * 2);
  for (let j = 0; j < nj; j++) {
    const leg = Math.floor(j / jpl); // legs are ordered l0 r0 l1 r1 ...: index = 2 * pair + side
    const role = j % jpl; // 2 joints: hip, knee; 3 joints: abd, hip, knee
    if (jpl === 3 && role === 0) continue; // the abduction joint holds the stand pose
    const knee = role === jpl - 1 ? 1 : 0;
    // diagonal gait: (pair + side) odd legs run in antiphase; the knee lags the hip by a quarter cycle, which walks the body forward (+x)
    const phi = (((leg >> 1) + (leg & 1)) % 2 ? Math.PI : 0) + (knee ? -Math.PI / 2 : 0);
    const a = knee ? amp * 1.2 : amp;
    // a*sin(t + phi) = a*cos(phi)*sin(t) + a*sin(phi)*cos(t)
    w[j * 2] = a * Math.cos(phi);
    w[j * 2 + 1] = a * Math.sin(phi);
  }
  return {
    format: 'mlp-v1', spec_version: 1, mujoco_version: opts.mujocoVersion, mjcf_sha256: opts.mjcfSha256, control_dt: 0.02,
    obs: { spec, mean: [0, 0], std: [1, 1] },
    clock: { gait_hz: opts.gaitHz ?? 2.5 },
    act: { scale: 1, clip: 1 },
    layers: [{ in: 2, out: nj, w: f32ToBase64(w), b: f32ToBase64(new Float32Array(nj)), act: 'none' }],
  };
}
