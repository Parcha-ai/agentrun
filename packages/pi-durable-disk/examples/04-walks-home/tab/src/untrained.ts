// What a creature does before it has learned anything: random moves, so the viewer can see a body with no skill. This is a display, not
// the start of a training run (a run's first checkpoints stand nearly still). Per joint a smoothed random signal (an Ornstein-Uhlenbeck
// process: a random walk pulled back towards zero), seeded so a rehearsal and a take look the same. It stands for STAND_S as it was
// drawn, then the noise ramps in. It is a stand-in for "no brain yet", not a policy: nothing in it can learn or walk.

export const STAND_S = 0.5; // seconds standing still before the twitching starts
export const RAMP_S = 1.0; // seconds for the noise to reach full strength
export const TAU_S = 0.25; // how long a twitch lasts (the signal's correlation time)
export const SIGMA = 0.9; // std of the action (before the mapping to joint targets and the clip at 1)

/** A small seeded generator (mulberry32) so the same seed gives the same twitching. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class UntrainedBrain {
  private readonly seed: number;
  private rand: () => number;
  private x: number[] = [];

  constructor(seed = 7) {
    this.seed = seed;
    this.rand = rng(seed);
  }

  reset(): void {
    this.rand = rng(this.seed);
    this.x = [];
  }

  private gauss(): number {
    const u = Math.max(this.rand(), 1e-12), v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** The action for `n` joints at simulated time `t` (seconds since the creature appeared), each in [-1, 1]. One call per control step (dt = 0.02 s). */
  next(n: number, t: number, dt = 0.02): number[] {
    while (this.x.length < n) this.x.push(0);
    const a = Math.min(1, Math.max(0, (t - STAND_S) / RAMP_S)); // ramp from the end of the standing second
    const decay = Math.exp(-dt / TAU_S);
    const kick = SIGMA * Math.sqrt(1 - decay * decay);
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = this.x[i] * decay + kick * this.gauss();
      out[i] = Math.max(-1, Math.min(1, a * this.x[i]));
    }
    return out;
  }
}
