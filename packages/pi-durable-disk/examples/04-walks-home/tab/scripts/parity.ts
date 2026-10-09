// Replay a trainer's trace through the tab's observation, policy and simulation code.
//   node scripts/parity.ts <policy.json> <trace.json> [<creature.xml>]
// trace.json: {command, mujoco_version, steps: [{k, t, qpos, qvel, obs, action}]} from the trainer's own MuJoCo.
// Reports (1) whether the XML is byte-identical, (2) obs and action differences when fed the trainer's states,
// (3) how far a closed-loop rollout in the tab's WASM drifts from the trainer's qpos.
import { readFileSync } from 'node:fs';
import load from '@mujoco/mujoco';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';
import { Policy, sha256Hex } from '../src/policy.ts';
import { Sim } from '../src/sim.ts';

const [policyPath, tracePath, xmlPath] = process.argv.slice(2);
if (!policyPath || !tracePath) throw new Error('usage: parity.ts <policy.json> <trace.json> [creature.xml]');
const built = buildMjcf(defaultDesign());
const sha = await sha256Hex(built.xml);
if (xmlPath) console.log('xml byte-identical to the trainer file:', readFileSync(xmlPath, 'utf8') === built.xml);
const mj = await load();
const policy = await Policy.load(readFileSync(policyPath, 'utf8'), { mjcfSha256: sha, nj: built.jointNames.length });
const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
const max = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.max(...Array.from(a, (v, i) => Math.abs(v - b[i])));

let obsErr = 0, actErr = 0;
let prev = new Array(built.jointNames.length).fill(0);
for (const st of trace.steps) {
  const obs = policy.observe({ qpos: st.qpos, qvel: st.qvel, prevAction: prev, command: trace.command, time: st.t, gaitHz: policy.gaitHz, standPose: built.standPose });
  obsErr = Math.max(obsErr, max(obs, st.obs));
  const act = policy.act(st.obs); // feed the trainer's own obs: isolates the network from the obs math
  actErr = Math.max(actErr, max(act, st.action));
  prev = st.action;
}
console.log(`obs from the trainer's state: max |diff| ${obsErr.toExponential(2)}`);
console.log(`action from the trainer's obs: max |diff| ${actErr.toExponential(2)}`);

const sim = new Sim(mj, built);
sim.command = trace.command;
const drift: Record<number, number> = {};
for (const st of trace.steps) {
  if (st.k > 0) sim.step(policy);
  if ([1, 10, 50, 100, 199].includes(st.k)) drift[st.k] = max(Array.from(sim.data.qpos as ArrayLike<number>).slice(0, 15), st.qpos);
}
console.log('closed-loop qpos drift vs trainer at step k:', Object.fromEntries(Object.entries(drift).map(([k, v]) => [k, +v.toExponential(2)])));
