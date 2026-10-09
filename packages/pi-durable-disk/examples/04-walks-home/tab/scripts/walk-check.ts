// Flat-ground walk of a policy at several commands: mean speed along the heading over 10 simulated seconds and whether it fell.
//   [DESIGN=<design.json>] node scripts/walk-check.ts <policy.json> [commands=0.2,0.5,0.8]
import { readFileSync } from 'node:fs';
import load from '@mujoco/mujoco';
import { buildMjcf } from '../src/mjcf.ts';
import { Policy, sha256Hex } from '../src/policy.ts';
import { Sim } from '../src/sim.ts';
import { resolveBody } from './_body.ts';

const [policyPath, cmds = '0.2,0.5,0.8'] = process.argv.slice(2);
if (!policyPath) throw new Error('usage: walk-check.ts <policy.json> [commands]');
const text = readFileSync(policyPath, 'utf8');
const known = await resolveBody(text);
const built = buildMjcf(known.design);
const mj = await load();
const policy = await Policy.load(text, { mjcfSha256: await sha256Hex(built.xml), nj: built.jointNames.length });
const out: string[] = [];
for (const command of cmds.split(',').map(Number)) {
  const sim = new Sim(mj, built);
  sim.command = command;
  for (let i = 0; i < 50; i++) sim.step(policy); // 1 s to settle into the gait
  const [x0, y0] = sim.torsoPos();
  const yaw = (q: Float64Array) => Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  const h0 = yaw(sim.data.qpos);
  let minUp = 1;
  for (let i = 0; i < 500; i++) { sim.step(policy); minUp = Math.min(minUp, sim.uprightness()); }
  const [x1, y1] = sim.torsoPos();
  const along = ((x1 - x0) * Math.cos(h0) + (y1 - y0) * Math.sin(h0)) / 10;
  out.push(`command ${command}: ${along.toFixed(3)} m/s along the heading, ${(Math.hypot(x1 - x0, y1 - y0) / 10).toFixed(3)} m/s total, min upright ${minUp.toFixed(2)}${minUp < 0.3 ? ' FELL' : ''}`);
}
console.log(`body: ${known.name}`);
console.log(out.join('\n'));
