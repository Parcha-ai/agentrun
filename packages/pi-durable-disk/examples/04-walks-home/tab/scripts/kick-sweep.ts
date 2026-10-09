// Kick a walking policy from the side and the front/back, at several forces, and report who stays up.
//   node scripts/kick-sweep.ts <policy.json> [command=0.5]
// A trial: walk 3 s, apply the force (horizontal, creature heading frame, 12 physics steps), run AFTER seconds more (4).
//   up      uprightness never went below 0.3 and ends above 0.9 (the acceptance bar)
//   GETUP   it went below 0.3 (fell) but ends above 0.9 (got up)
//   FELL    it ends at or below 0.9
// Set AFTER=8 to give a getup more time.
import { readFileSync } from 'node:fs';
import load from '@mujoco/mujoco';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { presetForSha } from '../src/bodies.ts';
import { Policy, sha256Hex } from '../src/policy.ts';
import { Sim } from '../src/sim.ts';

const [policyPath, cmd = '0.5'] = process.argv.slice(2);
const policyText = readFileSync(policyPath, 'utf8');
const known = await presetForSha(JSON.parse(policyText).mjcf_sha256); // the body this policy was trained for
const built = buildMjcf(known?.design ?? defaultDesign());
console.log(`body: ${known?.name ?? 'default (no preset matches this policy)'}, ${built.jointNames.length} joints`);
const mj = await load();
const policy = await Policy.load(policyText, { mjcfSha256: await sha256Hex(built.xml), nj: built.jointNames.length });
const dirs: Record<string, [number, number]> = { forward: [1, 0], back: [-1, 0], left: [0, 1], right: [0, -1] };
const forces = (process.env.FORCES ?? '20,40,60,80,100,120,150').split(',').map(Number); // e.g. FORCES=100,200,300,400,600
const after = Math.round(Number(process.env.AFTER ?? 4) / 0.02);
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
    for (let i = 0; i < after; i++) { sim.step(policy); min = Math.min(min, sim.uprightness()); }
    const end = sim.uprightness();
    cells.push((end <= 0.9 ? 'FELL' : min >= 0.3 ? 'up' : 'GETUP').padEnd(8));
  }
  rows.push(`${String(f).padEnd(9)}${cells.join('')}`);
}
console.log(rows.join('\n'));
console.log(`\nafter the push: ${after * 0.02} s; acceptance bar: 'up' from every side at >= 100 N`);
