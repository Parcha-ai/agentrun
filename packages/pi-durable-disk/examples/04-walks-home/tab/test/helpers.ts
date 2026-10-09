import load from '@mujoco/mujoco';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { Sim } from '../src/sim.ts';
import { dummyPolicy, Policy, sha256Hex } from '../src/policy.ts';

export const mj = await load();
export const MUJOCO_VERSION = '3.15.0';

export async function fixture(design = defaultDesign()) {
  const built = buildMjcf(design);
  const sha = await sha256Hex(built.xml);
  return { built, sha, nj: built.jointNames.length };
}

export async function dummy(design = defaultDesign()) {
  const { built, sha, nj } = await fixture(design);
  const file = dummyPolicy({ mjcfSha256: sha, mujocoVersion: MUJOCO_VERSION, nj });
  const policy = await Policy.load(file, { mjcfSha256: sha, nj, mujocoVersion: MUJOCO_VERSION });
  return { built, sha, nj, file, policy, sim: new Sim(mj, built) };
}
