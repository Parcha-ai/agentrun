// mlp-v1 policy: parse, validate against the body it will run on, and evaluate. See POLICY-FORMAT.md.
// A policy that does not match the body is refused before it runs, never run and hoped about.

import { SLICE_NAMES, slice, sliceSize, type SliceName, type State } from './obs.ts';

export const KNOWN_SPEC_VERSIONS = [1];
const ACTIVATIONS = ['tanh', 'elu', 'relu', 'silu', 'none'] as const;
type Activation = (typeof ACTIVATIONS)[number];
export const MAX_POLICY_BYTES = 300 * 1024;

export interface PolicyFile {
  format: 'mlp-v1';
  spec_version: number;
  mujoco_version: string;
  mjcf_sha256: string;
  control_dt: number;
  obs: { spec: { name: SliceName; size: number }[]; mean: number[]; std: number[] };
  clock?: { gait_hz: number };
  act: { scale: number; clip?: number };
  layers: { in: number; out: number; w: string; b: string; act: Activation }[];
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

export class Policy {
  readonly file: PolicyFile;
  readonly gaitHz: number;
  private readonly weights: { w: Float32Array; b: Float32Array; in: number; out: number; act: Activation }[];

  private constructor(file: PolicyFile) {
    this.file = file;
    this.gaitHz = file.clock?.gait_hz ?? 0;
    this.weights = file.layers.map((l) => ({
      w: base64ToF32(l.w), b: base64ToF32(l.b), in: l.in, out: l.out, act: l.act,
    }));
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
    let od = 0;
    for (const s of f.obs.spec) {
      if (!SLICE_NAMES.includes(s.name)) throw new PolicyRefused(`unknown obs slice ${s.name}`);
      if (s.size !== sliceSize(s.name, body.nj)) throw new PolicyRefused(`obs slice ${s.name} has size ${s.size}, the body needs ${sliceSize(s.name, body.nj)}`);
      od += s.size;
    }
    if (f.obs.mean.length !== od || f.obs.std.length !== od) throw new PolicyRefused('obs mean/std length differs from obs.spec');
    if (f.obs.std.some((s) => !(s > 0))) throw new PolicyRefused('obs std must be positive');
    if (f.obs.spec.some((s) => s.name === 'phase') && !(f.clock && f.clock.gait_hz > 0)) throw new PolicyRefused('phase needs clock.gait_hz');
    if (!f.layers?.length) throw new PolicyRefused('no layers');
    let width = od;
    for (const [i, l] of f.layers.entries()) {
      if (l.in !== width) throw new PolicyRefused(`layer ${i} takes ${l.in}, previous width is ${width}`);
      if (!ACTIVATIONS.includes(l.act)) throw new PolicyRefused(`layer ${i}: activation ${l.act} not supported`);
      width = l.out;
    }
    if (width !== body.nj) throw new PolicyRefused(`policy outputs ${width} actions, the body has ${body.nj} actuators`);
    if (!(Math.abs(f.control_dt - 0.02) < 1e-9)) throw new PolicyRefused(`control_dt ${f.control_dt}, the tab steps at 0.02`);
    const p = new Policy(f);
    for (const [i, l] of p.weights.entries()) {
      if (l.w.length !== l.in * l.out || l.b.length !== l.out) throw new PolicyRefused(`layer ${i}: weight shapes do not match in/out`);
    }
    return p;
  }

  observe(s: State): number[] {
    const out: number[] = [];
    for (const sp of this.file.obs.spec) out.push(...slice(sp.name, s));
    return out;
  }

  /** Action in [-clip, clip] for the observation: normalise, run the layers. */
  act(obs: number[]): number[] {
    let x = obs.map((v, i) => (v - this.file.obs.mean[i]) / this.file.obs.std[i]);
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
    const c = this.file.act.clip ?? 1;
    return x.map((v) => Math.max(-c, Math.min(c, v)));
  }

  /** Joint position targets for the actuators. */
  targets(action: number[], standPose: ArrayLike<number>): number[] {
    return action.map((a, i) => standPose[i] + this.file.act.scale * a);
  }
}
