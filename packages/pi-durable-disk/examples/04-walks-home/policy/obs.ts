// Observation slices, built from raw MuJoCo state. Each slice is defined once here; the contract is in POLICY-FORMAT.md.
// Everything is float64 until the policy's first layer.

export interface State {
  qpos: ArrayLike<number>; // free joint (x y z qw qx qy qz) then the leg joints
  qvel: ArrayLike<number>; // free joint (vx vy vz wx wy wz, w in the body frame) then the leg joints
  prevAction: ArrayLike<number>;
  command: number; // desired forward speed, m/s
  time: number; // seconds of simulated time
  gaitHz: number;
  standPose: ArrayLike<number>;
}

export type SliceName =
  | 'gravity' | 'ang_vel' | 'lin_vel' | 'joint_pos' | 'joint_vel' | 'prev_action' | 'command' | 'phase';

/** Rotate a world vector into the body frame of quaternion (w x y z): R^T v. */
export function toBody(q: ArrayLike<number>, v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  // v' = v + 2 * (-u) x ((-u) x v + w v) with u = (x y z): the conjugate rotation.
  const ux = -x, uy = -y, uz = -z;
  const cx = uy * v[2] - uz * v[1] + w * v[0];
  const cy = uz * v[0] - ux * v[2] + w * v[1];
  const cz = ux * v[1] - uy * v[0] + w * v[2];
  return [
    v[0] + 2 * (uy * cz - uz * cy),
    v[1] + 2 * (uz * cx - ux * cz),
    v[2] + 2 * (ux * cy - uy * cx),
  ];
}

export function slice(name: SliceName, s: State): number[] {
  const nj = s.standPose.length;
  const quat = [s.qpos[3], s.qpos[4], s.qpos[5], s.qpos[6]];
  switch (name) {
    case 'gravity': return toBody(quat, [0, 0, -1]);
    case 'ang_vel': return [s.qvel[3], s.qvel[4], s.qvel[5]];
    case 'lin_vel': return toBody(quat, [s.qvel[0], s.qvel[1], s.qvel[2]]);
    case 'joint_pos': return Array.from({ length: nj }, (_, i) => s.qpos[7 + i] - s.standPose[i]);
    case 'joint_vel': return Array.from({ length: nj }, (_, i) => s.qvel[6 + i]);
    case 'prev_action': return Array.from({ length: nj }, (_, i) => s.prevAction[i]);
    case 'command': return [s.command];
    case 'phase': {
      const a = 2 * Math.PI * s.gaitHz * s.time;
      return [Math.sin(a), Math.cos(a)];
    }
  }
}

export function sliceSize(name: SliceName, nj: number): number {
  switch (name) {
    case 'gravity': case 'ang_vel': case 'lin_vel': return 3;
    case 'joint_pos': case 'joint_vel': case 'prev_action': return nj;
    case 'command': return 1;
    case 'phase': return 2;
  }
}

export const SLICE_NAMES: readonly SliceName[] = [
  'gravity', 'ang_vel', 'lin_vel', 'joint_pos', 'joint_vel', 'prev_action', 'command', 'phase',
];
