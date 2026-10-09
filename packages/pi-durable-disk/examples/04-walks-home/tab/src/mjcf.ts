// design -> MJCF. Pure string output, so node (the trainer) and the tab produce the same bytes.
// Collision: the floor is contype 1 / conaffinity 1; every body geom is contype 0 / conaffinity 1, so geoms collide with
// the floor and terrain but never with each other (self-collision pairs are pure cost for the trainer).
// Keyframe "home" is the reset state for both the tab and the trainer (mj_resetDataKeyframe); the episode clock is data.time.
// Joint order is the contract with policies: for each leg in `jointNames`, hip then knee; actuator i drives joint i.

import { assertDesign, type Design } from './design.ts';

export const TIMESTEP = 0.004;
export const CONTROL_DT = 0.02; // 10 physics steps per policy step
export const HIP_RANGE: [number, number] = [-1.0, 1.0];
export const KNEE_RANGE: [number, number] = [0.0, 2.3];
export const KP = 40;
export const KV = 1.2;
// Standing pose (radians): thigh forward, knee bent back. Policies output offsets from it.
export const STAND_HIP = -0.45;
export const STAND_KNEE = 0.9;

export interface Built {
  xml: string;
  /** Leg names in joint order, e.g. ["l0", "r0", "l1", "r1"]; joints are `<leg>_hip`, `<leg>_knee`. */
  legs: string[];
  jointNames: string[];
  /** Per-joint standing target (the policy action offset), same order as jointNames. */
  standPose: number[];
  /** Torso centre height that puts the feet on the ground in the standing pose. */
  standHeight: number;
}

const f = (n: number) => String(Math.round(n * 1e6) / 1e6);

export function standHeight(thigh: number, shin: number, radius: number): number {
  // Hip sits at the torso centre height; the foot is a sphere at the end of the shin capsule.
  return thigh * Math.cos(STAND_HIP) + shin * Math.cos(STAND_HIP + STAND_KNEE) + radius;
}

/** Optional extra world, spliced after the floor. Not part of the body's identity (mjcf_sha256 is the hash of buildMjcf(design)). */
export interface World {
  asset: string; // contents for <asset>, e.g. an inline <hfield>
  geoms: string; // geoms for <worldbody>
}

export function buildMjcf(design: Design, world?: World): Built {
  assertDesign(design);
  const { torso, legs } = design;
  const legNames: string[] = [];
  const jointNames: string[] = [];
  const standPose: number[] = [];
  let bodies = '';
  let actuators = '';
  const hs = legs.map((l) => standHeight(l.thigh, l.shin, l.radius));
  // One torso height for all legs: the tallest stance; shorter legs hang with the foot above ground
  // until the policy learns to compensate. Designs with very unequal pairs are the user's call.
  const z0 = Math.max(...hs);

  legs.forEach((l, i) => {
    for (const side of ['l', 'r'] as const) {
      const n = `${side}${i}`;
      legNames.push(n);
      const y = (side === 'l' ? 1 : -1) * (torso.width / 2 + l.radius);
      const x = (l.x * torso.length) / 2;
      bodies += `
      <body name="${n}_thigh" pos="${f(x)} ${f(y)} 0">
        <joint name="${n}_hip" type="hinge" axis="0 1 0" range="${HIP_RANGE.join(' ')}" damping="0.4" armature="0.01"/>
        <geom type="capsule" fromto="0 0 0 0 0 ${f(-l.thigh)}" size="${f(l.radius)}" contype="0" conaffinity="1" mass="0.25" rgba="0.55 0.78 0.62 1"/>
        <body name="${n}_shin" pos="0 0 ${f(-l.thigh)}">
          <joint name="${n}_knee" type="hinge" axis="0 1 0" range="${KNEE_RANGE.join(' ')}" damping="0.3" armature="0.01"/>
          <geom type="capsule" fromto="0 0 0 0 0 ${f(-l.shin)}" size="${f(l.radius * 0.9)}" contype="0" conaffinity="1" mass="0.15" rgba="0.4 0.66 0.5 1"/>
          <geom name="${n}_foot" type="sphere" pos="0 0 ${f(-l.shin)}" size="${f(l.radius * 1.15)}" mass="0.05" contype="0" conaffinity="1" friction="1.2 0.05 0.01" rgba="0.15 0.2 0.18 1"/>
        </body>
      </body>`;
      jointNames.push(`${n}_hip`, `${n}_knee`);
      standPose.push(STAND_HIP, STAND_KNEE);
      actuators += `
    <position name="${n}_hip_a" joint="${n}_hip" kp="${KP}" kv="${KV}" ctrlrange="${HIP_RANGE.join(' ')}" forcerange="-12 12"/>
    <position name="${n}_knee_a" joint="${n}_knee" kp="${KP}" kv="${KV}" ctrlrange="${KNEE_RANGE.join(' ')}" forcerange="-12 12"/>`;
    }
  });

  // Foot sphere is 1.15x the leg radius; the stand height used the plain radius, so add the difference.
  const zStart = z0 + Math.max(...legs.map((l) => l.radius * 0.15)) + 0.002;

  const xml = `<mujoco model="${design.name.replace(/[^\w-]/g, '_')}">
  <compiler angle="radian"/>
  <option timestep="${TIMESTEP}" integrator="implicitfast"/>
  <visual><global offwidth="1280" offheight="720"/></visual>
${world ? `  <asset>${world.asset}</asset>\n` : ''}  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" contype="1" conaffinity="1" friction="1 0.05 0.01" rgba="0.9 0.9 0.86 1"/>
${world ? `    ${world.geoms}\n` : ''}    <body name="torso" pos="0 0 ${f(zStart)}">
      <freejoint name="root"/>
      <geom name="torso_geom" type="box" contype="0" conaffinity="1" size="${f(torso.length / 2)} ${f(torso.width / 2)} ${f(torso.height / 2)}" mass="${f(2 + torso.length * torso.width * 6)}" rgba="0.95 0.72 0.35 1"/>
      <site name="imu" pos="0 0 0"/>${bodies}
    </body>
  </worldbody>
  <actuator>${actuators}
  </actuator>
  <keyframe>
    <key name="home" qpos="0 0 ${f(zStart)} 1 0 0 0 ${standPose.map(f).join(' ')}" ctrl="${standPose.map(f).join(' ')}"/>
  </keyframe>
</mujoco>
`;
  return { xml, legs: legNames, jointNames, standPose, standHeight: zStart };
}
