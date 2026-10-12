// A body the agent wrote as code (robot/body.mjs, built by robot/build.mjs into robot/body.xml and robot/body.json; see ../../body/lib.mjs): what the creature page does with it. Pure but for MuJoCo,
// which comes in as `mj`. The page compiles the body, holds its standing pose for three seconds, and says what it found in robot/build.json, which the agent's build_robot tool reads back.
import type { MuJoCo } from './sim.ts';
import { Sim } from './sim.ts';
import type { Built } from './mjcf.ts';

export interface BodyJson {
  name: string;
  joints: { name: string; body: string; axis: number[]; range: number[]; stand: number; passive: boolean }[];
  motors: string[];
  tags: Record<string, string[]>;
  colors: Record<string, string>;
  face: { tag: string; at?: number[] };
  legs: number;
  tag_list: string[];
  pieces: number;
  mass_kg: number;
  stand_height_m: number;
}

export class CodeBodyError extends Error {}

/** robot/body.json as the page reads it, or a CodeBodyError saying which field is wrong. */
export function parseBodyJson(text: string): BodyJson {
  let b: any;
  try { b = JSON.parse(text); } catch { throw new CodeBodyError('robot/body.json is not valid JSON: run `node robot/build.mjs` again'); }
  const arr = (v: unknown, what: string) => { if (!Array.isArray(v)) throw new CodeBodyError(`robot/body.json has no ${what}`); return v; };
  if (!b || typeof b !== 'object') throw new CodeBodyError('robot/body.json is not an object');
  arr(b.joints, 'joints'); arr(b.motors, 'motors'); arr(b.tag_list, 'tag_list');
  if (!b.tags || typeof b.tags !== 'object') throw new CodeBodyError('robot/body.json has no tags');
  if (typeof b.stand_height_m !== 'number') throw new CodeBodyError('robot/body.json has no stand_height_m');
  return b as BodyJson;
}

/** The simulation's view of a code body: the motors are the policy's joints, each at its own standing angle. */
export function builtFromBody(xml: string, body: BodyJson): Built {
  const stand = new Map(body.joints.map((j) => [j.name, j.stand]));
  return {
    xml, legs: [], jointsPerLeg: 2, jointNames: [...body.motors], standPose: body.motors.map((m) => stand.get(m) ?? 0), standHeight: body.stand_height_m, code: true,
  };
}

export interface BuildReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  report?: { pieces: number; joints: number; motors: number; mass_kg: number; stand_height_m: number; settled_up: number; settled_height_m: number; tags: string[] };
}

/** Compile the body, hold its standing pose for `seconds`, and say what happened: a compile error comes back as MuJoCo's own message; a body that falls over, or whose physics blows up, is reported (and still shown). */
export function checkBody(mj: MuJoCo, built: Built, body: BodyJson, seconds = 3): { sim: Sim | null; result: BuildReport } {
  let sim: Sim;
  try {
    sim = new Sim(mj, built);
  } catch (e) {
    return { sim: null, result: { ok: false, errors: [`MuJoCo: ${String((e as Error).message ?? e).trim()}`], warnings: [] } };
  }
  const warnings: string[] = [];
  const steps = Math.round(seconds / 0.02);
  for (let i = 0; i < steps; i++) sim.step(null);
  sim.reset();
  const probe = new Sim(mj, built);
  for (let i = 0; i < steps; i++) probe.step(null);
  const finite = Array.from(probe.data.qpos).every(Number.isFinite);
  const up = probe.uprightness();
  const z = probe.data.qpos[2]!;
  if (!finite) return { sim: null, result: { ok: false, errors: ['the physics blew up (non-finite positions) while it held its standing pose: check masses, sizes and joint ranges'], warnings } };
  if (up < 0.3) warnings.push(`it does not stand: after ${seconds} s with its legs at their stand angles it is lying on its side (up ${up.toFixed(2)}). Check the stand angles and that the legs reach the ground.`);
  else if (z < 0.7 * body.stand_height_m) warnings.push(`it collapses: after ${seconds} s at its stand angles the torso is at ${z.toFixed(3)} m, well below the ${body.stand_height_m} m it should stand at (its legs fold or cannot hold its weight). Check the stand angles, the joint ranges and the masses.`);
  else if (up < 0.8) warnings.push(`it is leaning after ${seconds} s at its stand angles (up ${up.toFixed(2)}): its legs may not carry it evenly`);
  sim.reset();
  return {
    sim,
    result: { ok: true, errors: [], warnings, report: { pieces: body.pieces, joints: body.joints.length, motors: body.motors.length, mass_kg: body.mass_kg, stand_height_m: body.stand_height_m, settled_up: Math.round(up * 100) / 100, settled_height_m: Math.round(z * 1000) / 1000, tags: body.tag_list } },
  };
}
