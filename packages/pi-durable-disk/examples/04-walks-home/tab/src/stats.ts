// Counters and frame timings the page keeps for the live-demo checks (scripts/perf.mjs, scripts/soak.mjs). Cheap enough to
// stay on in the shipped page: a few integer increments and three small ring buffers per frame.

export class Ring {
  private readonly buf: Float64Array;
  private n = 0;
  constructor(size: number) { this.buf = new Float64Array(size); }
  push(v: number): void { this.buf[this.n % this.buf.length] = v; this.n++; }
  get count(): number { return Math.min(this.n, this.buf.length); }
  /** p in 0..1 over the values held; null when empty. */
  percentile(p: number): number | null {
    const k = this.count;
    if (k === 0) return null;
    const a = Array.from(this.buf.slice(0, k)).sort((x, y) => x - y);
    return a[Math.min(k - 1, Math.floor(p * k))];
  }
  max(): number | null { return this.count === 0 ? null : Math.max(...this.buf.slice(0, this.count)); }
}

export interface Counters {
  frames: number; steps: number; falls: number; getups: number; recoveries: number; kicks: number;
  nan: number; resetsSeen: number;
}

export class Stats {
  readonly c: Counters = { frames: 0, steps: 0, falls: 0, getups: 0, recoveries: 0, kicks: 0, nan: 0, resetsSeen: 0 };
  readonly frameMs = new Ring(600); // interval between animation frames
  readonly stepMs = new Ring(600); // time spent in the physics steps of a frame
  readonly drawMs = new Ring(600); // time spent in draw() + hud() (the WebGL submit; the GPU or SwiftShader work lands in the next frame)
  private lastNow: number | null = null;
  private lastSimTime = 0;

  frame(now: number, stepMs: number, drawMs: number): void {
    this.c.frames++;
    if (this.lastNow !== null) this.frameMs.push(now - this.lastNow);
    this.lastNow = now;
    this.stepMs.push(stepMs);
    this.drawMs.push(drawMs);
  }

  /** Call after each control step with the sim clock and whether the state is finite. A clock that goes backwards means MuJoCo or the page reset it. */
  step(simTime: number, finite: boolean, expectedReset: boolean): void {
    this.c.steps++;
    if (!finite) this.c.nan++;
    if (simTime < this.lastSimTime && !expectedReset) this.c.resetsSeen++;
    this.lastSimTime = simTime;
  }

  snapshot() {
    const q = (r: Ring) => ({ p50: r.percentile(0.5), p95: r.percentile(0.95), max: r.max() });
    return { ...this.c, frameMs: q(this.frameMs), stepMs: q(this.stepMs), drawMs: q(this.drawMs) };
  }
}
