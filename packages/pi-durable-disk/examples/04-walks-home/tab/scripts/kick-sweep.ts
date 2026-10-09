// Kick a walking policy from the side and the front/back, at several forces, and report who stays up.
//   node scripts/kick-sweep.ts <policy.json> [command=0.5]
// A trial: walk 3 s, apply the force (horizontal, creature heading frame, 12 physics steps), run 4 s more.
// "up" = uprightness stayed above 0.3 for the whole trial and ends above 0.9.
import { readFileSync } from 'node:fs';
import load from '@mujoco/mujoco';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { Policy, sha256Hex } from '../src/policy.ts';
import { Sim } from '../src/sim.ts';

const [policyPath, cmd = '0.5'] = process.argv.slice(2);
const built = buildMjcf(defaultDesign());
const mj = await load();
const policy = await Policy.load(readFileSync(policyPath, 'utf8'), { mjcfSha256: await sha256Hex(built.xml), nj: built.jointNames.length });
const dirs: Record<string, [number, number]> = { forward: [1, 0], back: [-1, 0], left: [0, 1], right: [0, -1] };
const forces = [20, 40, 60, 80, 100, 120];
const rows: string[] = [`force N  ${Object.keys(dirs).map((d) => d.padEnd(8)).join('')}`];
for (const f of forces) {
  const cells: string[] = [];
  for (const [, [dx, dy]] of Object.entries(dirs)) {
    const sim = new Sim(mj, built);
    sim.command = Number(cmd);
    for (let i = 0; i < 150; i++) sim.step(policy);
    const q = sim.data.qpos;
    const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
    sim.kick([f * (dx * Math.cos(yaw) - dy * Math.sin(yaw)), f * (dx * Math.sin(yaw) + dy * Math.cos(yaw)), 0]);
    let min = 1;
    for (let i = 0; i < 200; i++) { sim.step(policy); min = Math.min(min, sim.uprightness()); }
    cells.push((min > 0.3 && sim.uprightness() > 0.9 ? 'up' : 'FELL').padEnd(8));
  }
  rows.push(`${String(f).padEnd(9)}${cells.join('')}`);
}
console.log(rows.join('\n'));
