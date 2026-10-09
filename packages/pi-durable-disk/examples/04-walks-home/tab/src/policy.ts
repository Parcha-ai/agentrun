// mlp-v1 policy: parse, validate against the body it will run on, and evaluate. See POLICY-FORMAT.md.
// A policy that does not match the body is refused before it runs, never run and hoped about.

import { SLICE_NAMES, slice, sliceSize, type SliceName, type State } from './obs.ts';

export const KNOWN_SPEC_VERSIONS = [1];
const ACTIVATIONS = ['tanh', 'elu', 'relu', 'silu', 'none'] as const;
type Activation = (typeof ACTIVATIONS)[number];
export const MAX_POLICY_BYTES = 600 * 1024; // a walking net plus an optional getup net

export interface PolicyFile {
  format: 'mlp-v1';
  spec_version: number;
  mujoco_version: string;
  mjcf_sha256: string;
  control_dt: number;
  obs: { spec: { name: SliceName; size: number }[]; mean: number[]; std: number[] };
  clock?: { gait_hz: number };
  act: { scale: number; clip?: number };
  layers: LayerFile[];
  /** Optional second network, run while the creature is down; see POLICY-FORMAT.md. Absent = never switches. */
  getup?: GetupFile;
}

export interface LayerFile { in: number; out: number; w: string; b: string; act: Activation }
export type ObsBlock = { spec: { name: SliceName; size: number }[]; mean: number[]; std: number[] };
export interface GetupFile {
  layers: LayerFile[];
  obs?: ObsBlock; // default: the top-level obs
  act?: { scale: number; clip?: number }; // default: the top-level act
  switch: { below_up: number; above_up: number };
}

/** Which network drives the creature. The mode lives in the simulation and starts as 'walk'. */
export type Mode = 'walk' | 'getup';

/** Hysteresis: walk -> getup below `below_up`, getup -> walk above `above_up`, otherwise stay. `up` is torso uprightness. */
export function nextMode(mode: Mode, up: number, sw: { below_up: number; above_up: number }): Mode {
  if (mode === 'walk' && up < sw.below_up) return 'getup';
  if (mode === 'getup' && up > sw.above_up) return 'walk';
  return mode;
}

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

/** One network with its own observation layout and action mapping: the walking net, or the getup net. */
class Net {
  readonly obs: ObsBlock;
  readonly act: { scale: number; clip: number };
  private readonly weights: { w: Float32Array; b: Float32Array; in: number; out: number; act: Activation }[];

  constructor(obs: ObsBlock, layers: LayerFile[], a: { scale: number; clip?: number }) {
    this.obs = obs;
    this.act = { scale: a.scale, clip: a.clip ?? 1 };
    this.weights = layers.map((l) => ({ w: base64ToF32(l.w), b: base64ToF32(l.b), in: l.in, out: l.out, act: l.act }));
  }

  observe(s: State): number[] {
    const out: number[] = [];
    for (const sp of this.obs.spec) out.push(...slice(sp.name, s));
    return out;
  }

  /** Action in [-clip, clip] for the observation: normalise, run the layers. */
  run(obs: number[]): number[] {
    let x = obs.map((v, i) => (v - this.obs.mean[i]) / this.obs.std[i]);
    for (const l of this.weights) {
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
    const c = this.act.clip;
    return x.map((v) => Math.max(-c, Math.min(c, v)));
  }

  targets(action: number[], standPose: ArrayLike<number>): number[] {
    return action.map((a, i) => standPose[i] + this.act.scale * a);
  }
}

/** Validate one network's observation block and layers against the body; `who` prefixes the message ("" for the walking net). */
function checkNet(who: string, obs: ObsBlock, layers: LayerFile[], nj: number, hasClock: boolean): void {
  const r = (m: string) => new PolicyRefused(`${who}${m}`);
  if (!obs || !Array.isArray(obs.spec) || !Array.isArray(obs.mean) || !Array.isArray(obs.std)) throw r('obs block is missing or malformed');
  let od = 0;
  for (const s of obs.spec) {
    if (!SLICE_NAMES.includes(s.name)) throw r(`unknown obs slice ${s.name}`);
    if (s.size !== sliceSize(s.name, nj)) throw r(`obs slice ${s.name} has size ${s.size}, the body needs ${sliceSize(s.name, nj)}`);
    od += s.size;
  }
  if (obs.mean.length !== od || obs.std.length !== od) throw r('obs mean/std length differs from obs.spec');
  if (obs.std.some((x) => !(x > 0))) throw r('obs std must be positive');
  if (obs.spec.some((s) => s.name === 'phase') && !hasClock) throw r('phase needs clock.gait_hz');
  if (!Array.isArray(layers) || !layers.length) throw r('no layers');
  let width = od;
  for (const [i, l] of layers.entries()) {
    if (l.in !== width) throw r(`layer ${i} takes ${l.in}, previous width is ${width}`);
    if (!ACTIVATIONS.includes(l.act)) throw r(`layer ${i}: activation ${l.act} not supported`);
    width = l.out;
  }
  if (width !== nj) throw r(`policy outputs ${width} actions, the body has ${nj} actuators`);
  for (const [i, l] of layers.entries()) {
    if (base64ToF32(l.w).length !== l.in * l.out || base64ToF32(l.b).length !== l.out) throw r(`layer ${i}: weight shapes do not match in/out`);
  }
}

export class Policy {
  readonly file: PolicyFile;
  readonly gaitHz: number;
  private readonly walk: Net;
  private readonly getup: Net | null;

  private constructor(file: PolicyFile) {
    this.file = file;
    this.gaitHz = file.clock?.gait_hz ?? 0;
    this.walk = new Net(file.obs, file.layers, file.act);
    this.getup = file.getup ? new Net(file.getup.obs ?? file.obs, file.getup.layers, file.getup.act ?? file.act) : null;
  }

  /** True when the file carries a getup network. */
  get hasGetup(): boolean { return this.getup !== null; }

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
    const hasClock = !!(f.clock && f.clock.gait_hz > 0);
    checkNet('', f.obs, f.layers, body.nj, hasClock);
    if (!(Math.abs(f.control_dt - 0.02) < 1e-9)) throw new PolicyRefused(`control_dt ${f.control_dt}, the tab steps at 0.02`);
    if (f.getup !== undefined) {
      const g = f.getup;
      if (!g || typeof g !== 'object' || Array.isArray(g)) throw new PolicyRefused('getup: the block is not an object');
      const sw = g.switch;
      if (!sw || typeof sw.below_up !== 'number' || typeof sw.above_up !== 'number' || !(0 <= sw.below_up && sw.below_up < sw.above_up && sw.above_up <= 1)) {
        throw new PolicyRefused('getup: switch needs numbers with 0 <= below_up < above_up <= 1');
      }
      const a = g.act ?? f.act;
      if (typeof a?.scale !== 'number' || !Number.isFinite(a.scale) || a.scale <= 0) throw new PolicyRefused('getup: act.scale must be a positive number');
      checkNet('getup: ', g.obs ?? f.obs, g.layers, body.nj, hasClock);
    }
    return new Policy(f);
  }

  /** The walking network's observation (kept for tools that replay a trace). */
  observe(s: State): number[] { return this.walk.observe(s); }

  /** The walking network's action for an observation. */
  act(obs: number[]): number[] { return this.walk.run(obs); }

  /** Joint position targets for the walking network's action. */
  targets(action: number[], standPose: ArrayLike<number>): number[] { return this.walk.targets(action, standPose); }

  /**
   * One control step: pick the network by the hysteresis switch on `up` (torso uprightness), observe with that net's layout,
   * and map its action with that net's scale. Without a getup block the mode stays 'walk' and this equals observe/act/targets.
   */
  control(s: State, up: number, mode: Mode, standPose: ArrayLike<number>): { action: number[]; targets: number[]; mode: Mode } {
    const next = this.file.getup ? nextMode(mode, up, this.file.getup.switch) : 'walk';
    const net = next === 'getup' && this.getup ? this.getup : this.walk;
    const action = net.run(net.observe(s));
    return { action, targets: net.targets(action, standPose), mode: next };
  }
}
