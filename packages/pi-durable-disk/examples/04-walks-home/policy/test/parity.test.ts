// The trainer, the exported file and the tab's engine agree. The fixture (train/fixture.py) is a policy run in C MuJoCo
// by the trainer's Python: per step the state, the observation it built and the action the exported weights gave.
// PARITY_DIR points the test at another trace (a trained universe's) with the same four files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import load from '@mujoco/mujoco';
import { Policy, sha256Hex, type PolicyFile } from '../policy.ts';

const dir = process.env.PARITY_DIR ?? new URL('./fixtures/', import.meta.url).pathname;
const read = (name: string) => readFileSync(`${dir}/${name}`, 'utf8');
const xml = read('creature.xml');
const body = JSON.parse(read('body.json')) as { jointNames: string[]; standPose: number[] };
const file = JSON.parse(read('policy.json')) as PolicyFile;
const trace = JSON.parse(read('trace.json')) as {
  command: number; mujoco_version: string;
  steps: { k: number; t: number; qpos: number[]; qvel: number[]; obs: number[]; action: number[] }[];
};
const nj = body.jointNames.length;
const mj = await load();
const policy = await Policy.load(file, { mjcfSha256: await sha256Hex(xml), nj, mujocoVersion: trace.mujoco_version });
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

test('the observation and action from each traced state match the trainer', () => {
  let prev = new Array(nj).fill(0);
  let obsErr = 0;
  let actErr = 0;
  for (const s of trace.steps) {
    const obs = policy.observe({ qpos: s.qpos, qvel: s.qvel, prevAction: prev, command: trace.command, time: s.t,
      gaitHz: policy.gaitHz, standPose: body.standPose });
    obsErr = Math.max(obsErr, maxAbs(obs, s.obs));
    actErr = Math.max(actErr, maxAbs(policy.act(obs), s.action));
    prev = s.action;
  }
  // Same float64 formulas on both sides; the only difference is the order of floating-point operations.
  assert.ok(obsErr < 1e-9, `obs differs by ${obsErr}`);
  assert.ok(actErr < 1e-6, `action differs by ${actErr}`);
});

test('the WASM engine follows the C MuJoCo trajectory under the same policy', () => {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  mj.mj_resetDataKeyframe(model, data, 0);
  mj.mj_forward(model, data);
  const substeps = Math.round(file.control_dt / model.opt.timestep);
  let prev = new Array(nj).fill(0);
  let qposErr = 0;
  let firstAbove = -1;
  for (const s of trace.steps) {
    const err = maxAbs(data.qpos, s.qpos);
    if (err > 1e-6 && firstAbove < 0) firstAbove = s.k;
    qposErr = Math.max(qposErr, err);
    const action = policy.act(policy.observe({ qpos: data.qpos, qvel: data.qvel, prevAction: prev, command: trace.command,
      time: data.time, gaitHz: policy.gaitHz, standPose: body.standPose }));
    const targets = policy.targets(action, body.standPose);
    for (let i = 0; i < nj; i++) data.ctrl[i] = targets[i];
    for (let k = 0; k < substeps; k++) mj.mj_step(model, data);
    prev = action;
  }
  console.log(JSON.stringify({ steps: trace.steps.length, max_qpos_diff: qposErr, first_step_above_1e6: firstAbove }));
  // Same engine version, same model: the two builds agree to 1e-6 for the first second. Contacts amplify the last-bit
  // differences between compilers after that, so later steps are reported, not asserted.
  assert.ok(firstAbove < 0 || firstAbove >= 50, `qpos differs by more than 1e-6 at step ${firstAbove} (max ${qposErr})`);
  data.delete?.();
  model.delete?.();
});
