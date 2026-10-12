// MuJoCo-driven simulation of a built creature. The MuJoCo module is injected: node loads it from the package,
// the tab loads it beside the page. Nothing here touches the DOM.

import { CONTROL_DT, TIMESTEP, type Built } from './mjcf.ts';
import type { Mode, Policy } from './policy.ts';
import type { UntrainedBrain } from './untrained.ts';
import type { State } from './obs.ts';

// The wasm module's types are large and generated; the surface used here is small.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type MuJoCo = any;

export const SUBSTEPS = Math.round(CONTROL_DT / TIMESTEP);
/** Joint target offset per unit action while untrained (radians), like a policy's act.scale. */
export const UNTRAINED_SCALE = 0.7;
export const KICK_STEPS = 12; // physics steps an impulse stays applied: 0.048 s at the 0.004 s timestep

/** A body's state without the clock (Sim.pose, Sim.setPose). */
export interface Pose { qpos: number[]; qvel: number[]; ctrl: number[]; prevAction: number[]; mode: Mode }

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
  /** With no policy: random actions (a brain that has learned nothing) instead of holding the stand pose. */
  brain: UntrainedBrain | null = null;
  /** When the brain was attached: its clock (standing, then the ramp) starts there, so a brain attached mid-session (an untrained try) stands first too. */
  private brainSince = 0;
  prevAction: number[];
  /** A code body's motor joints: where each one sits in qpos and qvel (a body with spring joints has joints the policy never sees). Null: the motors are the joints after the free joint, in order. */
  private motorQpos: number[] | null = null;
  private motorDof: number[] | null = null;
  private kickLeft = 0;
  private kickForce: [number, number, number] = [0, 0, 0];

  constructor(mj: MuJoCo, built: Built) {
    this.mj = mj;
    this.built = built;
    this.model = mj.MjModel.from_xml_string(built.xml);
    this.data = new mj.MjData(this.model);
    this.torsoBody = this.bodyId('torso');
    this.prevAction = new Array(built.jointNames.length).fill(0);
    if (built.code) {
      this.motorQpos = []; this.motorDof = [];
      for (const name of built.jointNames) {
        const id = mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_JOINT.value, name);
        if (id < 0) throw new Error(`no joint ${name}`);
        this.motorQpos.push(this.model.jnt_qposadr[id]); this.motorDof.push(this.model.jnt_dofadr[id]);
      }
    }
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
    this.brain?.reset();
    this.brainSince = 0;
    this.prevAction.fill(0);
    this.kickLeft = 0;
  }

  state(gaitHz: number): State {
    // a code body's springs are not the policy's business: it sees the free joint and the motors, in the order the trainer sees them
    const qpos = this.motorQpos ? [...Array.from(this.data.qpos.slice(0, 7)), ...this.motorQpos.map((a) => this.data.qpos[a]!)] : this.data.qpos;
    const qvel = this.motorDof ? [...Array.from(this.data.qvel.slice(0, 6)), ...this.motorDof.map((a) => this.data.qvel[a]!)] : this.data.qvel;
    return {
      qpos, qvel, prevAction: this.prevAction,
      command: this.command, time: this.time, gaitHz, standPose: this.built.standPose,
    };
  }

  /** Push the torso with a force (N, world frame) held for KICK_STEPS physics steps: an impulse of about F * 0.01 N s. */
  kick(force: [number, number, number]): void {
    this.kickForce = force;
    this.kickLeft = KICK_STEPS;
  }

  /**
   * Set the creature back on its feet where it lies: same place and heading, stand pose, still. Used when a new checkpoint lands on
   * a creature that is lying down (an early checkpoint has no getup network, so it could not rise); the caller says so out loud.
   */
  standUp(): void {
    const q = this.data.qpos;
    const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
    q[2] = this.built.standHeight;
    q[3] = Math.cos(yaw / 2); q[4] = 0; q[5] = 0; q[6] = Math.sin(yaw / 2);
    const home = this.model.key_qpos; // the body's own standing pose, the springs' rest angles included
    for (let i = 7; i < this.model.nq; i++) q[i] = home[i]!;
    for (let i = 0; i < this.built.standPose.length; i++) this.data.ctrl[i] = this.built.standPose[i];
    for (let i = 0; i < this.data.qvel.length; i++) this.data.qvel[i] = 0;
    this.prevAction.fill(0);
    this.mode = 'walk';
    this.mj.mj_forward(this.model, this.data);
  }

  /** Give this creature the untrained brain, or take it away. Attaching one that is not already attached starts it over from its seed, so a creature built again from the same drawing twitches exactly as the first did. */
  attachBrain(brain: UntrainedBrain | null): void {
    if (brain && brain !== this.brain) { brain.reset(); this.brainSince = this.time; }
    this.brain = brain;
  }

  /** The body as it is now (where it stands, its joints, its velocities, what its motors are told), to put it back with setPose. The clock is not part of it. */
  pose(): Pose {
    return { qpos: Array.from(this.data.qpos as ArrayLike<number>), qvel: Array.from(this.data.qvel as ArrayLike<number>), ctrl: Array.from(this.data.ctrl as ArrayLike<number>), prevAction: this.prevAction.slice(), mode: this.mode };
  }

  /** Put the body back as `pose` found it (after an untrained try): same place, heading, joints and velocities; the clock keeps going. */
  setPose(pose: Pose): void {
    for (let i = 0; i < pose.qpos.length; i++) this.data.qpos[i] = pose.qpos[i]!;
    for (let i = 0; i < pose.qvel.length; i++) this.data.qvel[i] = pose.qvel[i]!;
    for (let i = 0; i < pose.ctrl.length; i++) this.data.ctrl[i] = pose.ctrl[i]!;
    this.prevAction = pose.prevAction.slice();
    this.mode = pose.mode;
    this.kickLeft = 0;
    this.mj.mj_forward(this.model, this.data);
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
    } else if (this.brain) {
      action = this.brain.next(this.built.standPose.length, this.time - this.brainSince);
      for (let i = 0; i < action.length; i++) this.data.ctrl[i] = this.built.standPose[i] + UNTRAINED_SCALE * action[i];
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

  /** Release MuJoCo's model and data (wasm memory the garbage collector does not see). The simulation is unusable after. */
  free(): void {
    this.data.delete();
    this.model.delete();
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
