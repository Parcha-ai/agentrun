// How long a policy takes to get up from lying still: on its left side, right side and back, at several commands.
//   node scripts/getup-time.ts <policy.json> [commands=0,0.5,0.8]
// The creature is placed in the pose with every joint at the stand pose and the velocities zero, dropped from a little
// height, and the policy runs. "up" = uprightness above 0.9 and staying above it for 1 s; the time is when it first got there.
import { readFileSync } from 'node:fs';
import load from '@mujoco/mujoco';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { presetForSha } from '../src/bodies.ts';
import { Policy, sha256Hex } from '../src/policy.ts';
import { Sim } from '../src/sim.ts';

const [policyPath, cmds = '0,0.5,0.8'] = process.argv.slice(2);
if (!policyPath) throw new Error('usage: getup-time.ts <policy.json> [commands]');
const text = readFileSync(policyPath, 'utf8');
const known = await presetForSha(JSON.parse(text).mjcf_sha256);
const built = buildMjcf(known?.design ?? defaultDesign());
const mj = await load();
const policy = await Policy.load(text, { mjcfSha256: await sha256Hex(built.xml), nj: built.jointNames.length });
console.log(`body: ${known?.name ?? 'default'}, getup network: ${policy.hasGetup}`);

// roll about x: +90 = onto its left side (+y down), -90 = right side, 180 = on its back
const poses: [string, number][] = [['left side', Math.PI / 2], ['right side', -Math.PI / 2], ['back', Math.PI]];
const horizon = Number(process.env.HORIZON ?? 8);
for (const command of cmds.split(',').map(Number)) {
  const cells: string[] = [];
  for (const [name, roll] of poses) {
    const sim = new Sim(mj, built);
    sim.command = command;
    const q = sim.data.qpos;
    q[2] = 0.25;
    q[3] = Math.cos(roll / 2); q[4] = Math.sin(roll / 2); q[5] = 0; q[6] = 0;
    let first: number | null = null, held = 0, modes = 0, prevMode = sim.mode;
    for (let i = 0; i < horizon / 0.02; i++) {
      sim.step(policy);
      if (sim.mode !== prevMode) { modes++; prevMode = sim.mode; }
      if (sim.uprightness() > 0.9) { if (first === null) first = sim.time; held += 0.02; if (held >= 1) break; } else { first = null; held = 0; }
    }
    cells.push(`${name}: ${first !== null && held >= 1 ? first.toFixed(2) + ' s' : 'DID NOT GET UP'}${modes > 2 ? ` (${modes} mode flips)` : ''}`);
  }
  console.log(`command ${String(command).padEnd(4)} ${cells.join('   ')}`);
}
