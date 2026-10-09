// How far the creature has walked in this version, and the faint trail it leaves: pure, so the numbers on screen are tested.
// A version starts when a policy is installed (or the creature is reset or rebuilt); distance is metres on the ground from there.

export class Trail {
  /** The newest `cap` points, oldest first. */
  readonly points: { x: number; y: number }[] = [];
  private ox = 0;
  private oy = 0;
  private readonly cap: number;
  private readonly step: number;

  constructor(cap = 240, step = 0.08) {
    this.cap = cap;
    this.step = step;
  }

  /** A new version (or a rebuilt creature): the count starts over from here and the trail is cleared. */
  reset(x: number, y: number): void {
    this.ox = x;
    this.oy = y;
    this.points.length = 0;
  }

  get origin(): [number, number] { return [this.ox, this.oy]; }

  distance(x: number, y: number): number {
    return Math.hypot(x - this.ox, y - this.oy);
  }

  /** Drop a point when the creature has moved a step from the last one (from the origin when there is none). True when one was added. */
  add(x: number, y: number): boolean {
    const last = this.points[this.points.length - 1];
    const fx = last ? last.x : this.ox, fy = last ? last.y : this.oy;
    if (Math.hypot(x - fx, y - fy) < this.step) return false;
    this.points.push({ x, y });
    if (this.points.length > this.cap) this.points.shift();
    return true;
  }
}

/** The number on screen: one decimal, and never "-0.0". */
export function formatDistance(m: number): string {
  const v = Math.round(Math.abs(m) * 10) / 10;
  return (m < 0 && v > 0 ? '-' : '') + v.toFixed(1);
}

/** Fires once per `period` of simulated time (a walk-meter event per second): one tick per call however long the gap, and it starts over when time goes backwards (a reset). */
export class Ticker {
  private next: number;
  private readonly period: number;

  constructor(period = 1) {
    this.period = period;
    this.next = period;
  }

  due(t: number): boolean {
    if (t < this.next - this.period) this.next = this.period; // simulated time went back: a new clock
    if (t < this.next) return false;
    this.next = (Math.floor(t / this.period) + 1) * this.period;
    return true;
  }
}
