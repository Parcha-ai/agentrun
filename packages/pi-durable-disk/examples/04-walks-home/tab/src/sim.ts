// MuJoCo-driven simulation of a built creature. The MuJoCo module is injected: node loads it from the package,
// the tab loads it beside the page. Nothing here touches the DOM.

import { CONTROL_DT, TIMESTEP, type Built } from './mjcf.ts';
import type { Mode, Policy } from './policy.ts';
import type { State } from './obs.ts';

// The wasm module's types are large and generated; the surface used here is small.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type MuJoCo = any;

export const SUBSTEPS = Math.round(CONTROL_DT / TIMESTEP);
export const KICK_STEPS = 12; // physics steps an impulse stays applied: 0.048 s at the 0.004 s timestep

export class Sim {
  readonly mj: MuJoCo;
  readonly model: any;
  readonly data: any;
  readonly built: Built;
  readonly torsoBody: number;
  command = 0;
  time = 0;
  /** Which network of the policy drives the creature; reset to 'walk'. Only a policy with a getup block ever leaves 'walk'. */
  mode: Mode = 'walk';
  prevAction: number[];
  private kickLeft = 0;
  private kickForce: [number, number, number] = [0, 0, 0];

  constructor(mj: MuJoCo, built: Built) {
    this.mj = mj;
    this.built = built;
    this.model = mj.MjModel.from_xml_string(built.xml);
    this.data = new mj.MjData(this.model);
    this.torsoBody = this.bodyId('torso');
    this.prevAction = new Array(built.jointNames.length).fill(0);
    if (this.model.nu !== built.jointNames.length) throw new Error(`model has ${this.model.nu} actuators, design says ${built.jointNames.length}`);
    this.reset();
  }

  private bodyId(name: string): number {
    for (let i = 0; i < this.model.nbody; i++) if (this.model.body(i).name === name) return i;
    throw new Error(`no body ${name}`);
  }

  reset(): void {
    this.mj.mj_resetDataKeyframe(this.model, this.data, 0); // key "home": the trainer resets to the same state
    this.mj.mj_forward(this.model, this.data);
    this.time = 0;
    this.mode = 'walk';
    this.prevAction.fill(0);
    this.kickLeft = 0;
  }

  state(gaitHz: number): State {
    return {
      qpos: this.data.qpos, qvel: this.data.qvel, prevAction: this.prevAction,
      command: this.command, time: this.time, gaitHz, standPose: this.built.standPose,
    };
  }

  /** Push the torso with a force (N, world frame) held for KICK_STEPS physics steps: an impulse of about F * 0.01 N s. */
  kick(force: [number, number, number]): void {
    this.kickForce = force;
    this.kickLeft = KICK_STEPS;
  }

  /** One policy step (CONTROL_DT): act (or hold the standing pose without a policy), then SUBSTEPS physics steps. */
  step(policy: Policy | null): number[] {
    let action = this.prevAction;
    // A policy for another body (another joint count) never drives this one: its observation would read past the joint arrays.
    if (policy && policy.nj !== this.built.jointNames.length) policy = null;
    if (policy) {
      const r = policy.control(this.state(policy.gaitHz), this.uprightness(), this.mode, this.built.standPose);
      action = r.action;
      this.mode = r.mode;
      for (let i = 0; i < r.targets.length; i++) this.data.ctrl[i] = r.targets[i];
    } else {
      for (let i = 0; i < this.built.standPose.length; i++) this.data.ctrl[i] = this.built.standPose[i];
    }
    for (let k = 0; k < SUBSTEPS; k++) {
      const x = this.data.xfrc_applied;
      const o = this.torsoBody * 6;
      if (this.kickLeft > 0) {
        x[o] = this.kickForce[0]; x[o + 1] = this.kickForce[1]; x[o + 2] = this.kickForce[2];
        this.kickLeft--;
      } else {
        x[o] = 0; x[o + 1] = 0; x[o + 2] = 0;
      }
      this.mj.mj_step(this.model, this.data);
    }
    this.prevAction = action.slice();
    this.time += CONTROL_DT;
    return action;
  }

  torsoPos(): [number, number, number] {
    return [this.data.qpos[0], this.data.qpos[1], this.data.qpos[2]];
  }

  /** Torso up-axis z component: 1 upright, 0 on its side, negative on its back. */
  uprightness(): number {
    const [w, x, y] = [this.data.qpos[3], this.data.qpos[4], this.data.qpos[5]];
    return 1 - 2 * (x * x + y * y);
  }
}
