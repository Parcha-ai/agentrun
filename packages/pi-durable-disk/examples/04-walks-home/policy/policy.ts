// mlp-v1 policy: parse, validate against the body it will run on, and evaluate. See POLICY-FORMAT.md.
// A policy that does not match the body is refused before it runs, never run and hoped about.

import { SLICE_NAMES, slice, sliceSize, type SliceName, type State } from './obs.ts';

export const KNOWN_SPEC_VERSIONS = [1];
const ACTIVATIONS = ['tanh', 'elu', 'relu', 'silu', 'none'] as const;
type Activation = (typeof ACTIVATIONS)[number];
export const MAX_POLICY_BYTES = 600 * 1024; // two networks of 128x3 are about 440 KB

/** One network: what it observes, how its output becomes joint targets, its layers. */
export interface Network {
  obs: { spec: { name: SliceName; size: number }[]; mean: number[]; std: number[] };
  clock?: { gait_hz: number };
  act: { scale: number; clip?: number };
  layers: { in: number; out: number; w: string; b: string; act: Activation }[];
}

/**
 * Optional second network that rights a fallen creature, and the rule that hands control between the two on the
 * torso's uprightness (1 standing, 0 on its side, -1 on its back): getup takes over below `switch.below_up` and hands
 * back above `switch.above_up` (hysteresis, so the two never flap). `obs` and `act` default to the top level's; the
 * phase clock is always the top level's. A tab that does not know `getup` runs the walking network alone, which is
 * why it is not a spec_version change.
 */
export interface GetupNetwork {
  layers: Network['layers'];
  obs?: Network['obs'];
  act?: Network['act'];
  switch: { below_up: number; above_up: number };
}

export interface PolicyFile extends Network {
  format: 'mlp-v1';
  spec_version: number;
  mujoco_version: string;
  mjcf_sha256: string;
  control_dt: number;
  getup?: GetupNetwork;
}

export type Skill = 'walk' | 'getup';

export class PolicyRefused extends Error {}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function f32ToBase64(a: ArrayLike<number>): string {
  const bytes = new Uint8Array(Float32Array.from(a as ArrayLike<number> as number[]).buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToF32(b64: string): Float32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  if (bytes.length % 4) throw new PolicyRefused('weights are not a whole number of float32');
  return new Float32Array(bytes.buffer);
}

const act: Record<Activation, (x: number) => number> = {
  tanh: Math.tanh,
  elu: (x) => (x > 0 ? x : Math.expm1(x)),
  relu: (x) => (x > 0 ? x : 0),
  silu: (x) => x / (1 + Math.exp(-x)),
  none: (x) => x,
};

type Layer = { w: Float32Array; b: Float32Array; in: number; out: number; act: Activation };

function checkNetwork(n: Network, nj: number, where: string): void {
  let od = 0;
  for (const s of n.obs.spec) {
    if (!SLICE_NAMES.includes(s.name)) throw new PolicyRefused(`${where}unknown obs slice ${s.name}`);
    if (s.size !== sliceSize(s.name, nj)) throw new PolicyRefused(`${where}obs slice ${s.name} has size ${s.size}, the body needs ${sliceSize(s.name, nj)}`);
    od += s.size;
  }
  if (n.obs.mean.length !== od || n.obs.std.length !== od) throw new PolicyRefused(`${where}obs mean/std length differs from obs.spec`);
  if (n.obs.std.some((s) => !(s > 0))) throw new PolicyRefused(`${where}obs std must be positive`);
  if (n.obs.spec.some((s) => s.name === 'phase') && !(n.clock && n.clock.gait_hz > 0)) throw new PolicyRefused(`${where}phase needs clock.gait_hz`);
  if (!n.layers?.length) throw new PolicyRefused(`${where}no layers`);
  let width = od;
  for (const [i, l] of n.layers.entries()) {
    if (l.in !== width) throw new PolicyRefused(`${where}layer ${i} takes ${l.in}, previous width is ${width}`);
    if (!ACTIVATIONS.includes(l.act)) throw new PolicyRefused(`${where}layer ${i}: activation ${l.act} not supported`);
    width = l.out;
  }
  if (width !== nj) throw new PolicyRefused(`${where}policy outputs ${width} actions, the body has ${nj} actuators`);
}

function buildLayers(n: Network, where: string): Layer[] {
  const layers = n.layers.map((l) => ({ w: base64ToF32(l.w), b: base64ToF32(l.b), in: l.in, out: l.out, act: l.act }));
  for (const [i, l] of layers.entries()) {
    if (l.w.length !== l.in * l.out || l.b.length !== l.out) throw new PolicyRefused(`${where}layer ${i}: weight shapes do not match in/out`);
  }
  return layers;
}

function run(n: Network, layers: Layer[], obs: number[]): number[] {
  let x = obs.map((v, i) => (v - n.obs.mean[i]) / n.obs.std[i]);
  for (const l of layers) {
    const y = new Array<number>(l.out);
    const fn = act[l.act];
    for (let o = 0; o < l.out; o++) {
      let sum = l.b[o];
      const row = o * l.in;
      for (let i = 0; i < l.in; i++) sum += l.w[row + i] * x[i];
      y[o] = fn(sum);
    }
    x = y;
  }
  const c = n.act.clip ?? 1;
  return x.map((v) => Math.max(-c, Math.min(c, v)));
}

/** Torso uprightness from qpos: the z component of the body's up axis. */
export function uprightness(qpos: ArrayLike<number>): number {
  return 1 - 2 * (qpos[4] * qpos[4] + qpos[5] * qpos[5]);
}

export class Policy {
  readonly file: PolicyFile;
  /** The network in control. observe() updates it from the state it is given; act() and targets() use it. */
  skill: Skill = 'walk';
  private readonly nets: Record<Skill, { net: Network; layers: Layer[] } | undefined>;

  private constructor(file: PolicyFile) {
    this.file = file;
    const getup = Policy.getupNetwork(file);
    this.nets = {
      walk: { net: file, layers: buildLayers(file, '') },
      getup: getup ? { net: getup, layers: buildLayers(getup, 'getup: ') } : undefined,
    };
  }

  /** The getup block as a full network: obs and act default to the top level's, the clock is the top level's. */
  private static getupNetwork(f: PolicyFile): Network | undefined {
    if (!f.getup) return undefined;
    return { layers: f.getup.layers, obs: f.getup.obs ?? f.obs, act: f.getup.act ?? f.act, clock: f.clock };
  }

  /** The phase clock (the top level's, whichever network is in control). */
  get gaitHz(): number {
    return this.file.clock?.gait_hz ?? 0;
  }

  private get active() {
    return this.nets[this.skill] ?? this.nets.walk!;
  }

  /** Validate `raw` against the body (`mjcfSha256`, joint count `nj`, MuJoCo `version`) and build a runnable policy. */
  static async load(raw: string | PolicyFile, body: { mjcfSha256: string; nj: number; mujocoVersion?: string }): Promise<Policy> {
    if (typeof raw === 'string' && raw.length > MAX_POLICY_BYTES) throw new PolicyRefused(`policy over ${MAX_POLICY_BYTES} bytes`);
    const f: PolicyFile = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (f.format !== 'mlp-v1') throw new PolicyRefused(`unknown format ${f.format}`);
    if (!KNOWN_SPEC_VERSIONS.includes(f.spec_version)) throw new PolicyRefused(`unknown spec_version ${f.spec_version}`);
    if (f.mjcf_sha256 !== body.mjcfSha256) throw new PolicyRefused('policy was trained for a different body (mjcf_sha256 differs)');
    if (body.mujocoVersion && f.mujoco_version !== body.mujocoVersion) {
      throw new PolicyRefused(`policy was trained on MuJoCo ${f.mujoco_version}, the tab runs ${body.mujocoVersion}`);
    }
    checkNetwork(f, body.nj, '');
    const getup = Policy.getupNetwork(f);
    if (getup) {
      checkNetwork(getup, body.nj, 'getup: ');
      const sw = f.getup!.switch;
      if (!sw || !(sw.below_up >= 0 && sw.below_up < sw.above_up && sw.above_up <= 1)) {
        throw new PolicyRefused('getup.switch must be {below_up, above_up} with 0 <= below_up < above_up <= 1');
      }
    }
    if (!(Math.abs(f.control_dt - 0.02) < 1e-9)) throw new PolicyRefused(`control_dt ${f.control_dt}, the tab steps at 0.02`);
    return new Policy(f);
  }

  /** Back to the walking network (a reset puts the creature on its feet). */
  reset(): void {
    this.skill = 'walk';
  }

  /** The observation for the network in control, after handing control over if the torso crossed a switch threshold. */
  observe(s: State): number[] {
    const sw = this.file.getup?.switch;
    if (this.nets.getup && sw) {
      const up = uprightness(s.qpos);
      if (this.skill === 'walk' && up < sw.below_up) this.skill = 'getup';
      else if (this.skill === 'getup' && up > sw.above_up) this.skill = 'walk';
    }
    const out: number[] = [];
    for (const sp of this.active.net.obs.spec) out.push(...slice(sp.name, { ...s, gaitHz: this.gaitHz }));
    return out;
  }

  /** Action in [-clip, clip] for the observation: normalise, run the layers of the network in control. */
  act(obs: number[]): number[] {
    return run(this.active.net, this.active.layers, obs);
  }

  /** Joint position targets for the actuators, with the action scale of the network in control. */
  targets(action: number[], standPose: ArrayLike<number>): number[] {
    return action.map((a, i) => standPose[i] + this.active.net.act.scale * a);
  }
}

/** The stand-in used until a trained policy arrives: an open-loop trot, linear in (sin, cos) of the gait clock. */
export function dummyPolicy(opts: { mjcfSha256: string; mujocoVersion: string; nj: number; gaitHz?: number; amp?: number }): PolicyFile {
  const { nj } = opts;
  const amp = opts.amp ?? 0.25;
  const spec = [{ name: 'phase' as const, size: 2 }];
  const w = new Float32Array(nj * 2);
  for (let j = 0; j < nj; j++) {
    const leg = j >> 1; // legs are ordered l0 r0 l1 r1 ...: index = 2 * pair + side
    const knee = j & 1;
    // diagonal gait: (pair + side) odd legs run in antiphase; the knee lags the hip by a quarter cycle, which walks the body forward (+x)
    const phi = (((leg >> 1) + (leg & 1)) % 2 ? Math.PI : 0) + (knee ? -Math.PI / 2 : 0);
    const a = knee ? amp * 1.2 : amp;
    // a*sin(t + phi) = a*cos(phi)*sin(t) + a*sin(phi)*cos(t)
    w[j * 2] = a * Math.cos(phi);
    w[j * 2 + 1] = a * Math.sin(phi);
  }
  return {
    format: 'mlp-v1', spec_version: 1, mujoco_version: opts.mujocoVersion, mjcf_sha256: opts.mjcfSha256, control_dt: 0.02,
    obs: { spec, mean: [0, 0], std: [1, 1] },
    clock: { gait_hz: opts.gaitHz ?? 2.5 },
    act: { scale: 1, clip: 1 },
    layers: [{ in: 2, out: nj, w: f32ToBase64(w), b: f32ToBase64(new Float32Array(nj)), act: 'none' }],
  };
}
