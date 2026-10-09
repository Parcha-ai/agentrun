// Top-view creature sketcher on a 2D canvas. The user drags the torso edges and the hip markers; the leg handles
// scale a pair's thigh and shin together. Emits a Design on every change. No physics here.

import { LIMITS, type Design, type LegPair } from './design.ts';
import { clampDesign } from './rules.ts';

/**
 * Pixels per metre follows the pane, never the body, so the pointer and the drawing stay in step while a handle is dragged. It is
 * chosen so that the widest creature the sketcher allows (the widest torso with the longest legs, 2.1 m across, plus room for the
 * handles) fits the smaller side of the pane: a valid body can never have a handle out of reach.
 */
const FIT_M = 2 * (LIMITS.torso.width[1] / 2 + LIMITS.thigh[1] + LIMITS.shin[1]) + 0.3;
export const pxPerMetre = (c: HTMLCanvasElement) => Math.max(110, Math.min(520, Math.min(c.clientWidth || 320, c.clientHeight || 320) / FIT_M));
const clamp = (v: number, [lo, hi]: readonly number[]) => Math.max(lo, Math.min(hi, v));

type Handle =
  | { kind: 'length' } | { kind: 'width' }
  | { kind: 'hip'; i: number } | { kind: 'leg'; i: number };

export class Sketcher {
  private design: Design;
  /** Pixels per metre, from the canvas size (a big sketch pane draws a big creature). */
  private get px(): number { return pxPerMetre(this.canvas); }
  private drag: Handle | null = null;
  private hover: Handle | null = null;
  private readonly ctx: CanvasRenderingContext2D;

  private readonly canvas: HTMLCanvasElement;
  private readonly onChange: (d: Design) => void;

  constructor(canvas: HTMLCanvasElement, design: Design, onChange: (d: Design) => void) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.design = structuredClone(design);
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => { this.drag = null; this.hover = null; this.draw(); });
    this.draw();
  }

  get(): Design { return structuredClone(this.design); }

  set(d: Design): void { this.design = structuredClone(d); this.onClamp?.([]); this.draw(); }

  /** Joints per leg: 3 adds the hip abduction joint. Applied to the next build. */
  setLegDof(dof: 2 | 3): void {
    if (dof === 3) this.design.legDof = 3; else delete this.design.legDof;
    this.changed();
  }

  addPair(): void {
    if (this.design.legs.length >= LIMITS.pairs[1]) return;
    const l = this.design.legs;
    const gap = l.length ? Math.min(...l.map((p) => p.x)) : 0;
    l.push({ x: Math.max(-1, gap - 0.8), thigh: l[0]?.thigh ?? 0.2, shin: l[0]?.shin ?? 0.2, radius: l[0]?.radius ?? 0.02 });
    this.changed();
  }

  removePair(): void {
    if (this.design.legs.length <= LIMITS.pairs[0]) return;
    this.design.legs.pop();
    this.changed();
  }

  /** Every edit passes the clamp (rules.ts); what it shortened is reported to `onClamp` so the page can say so. */
  onClamp: ((messages: string[]) => void) | null = null;

  private changed(): void {
    const { design, messages } = clampDesign(this.design);
    if (messages.length) this.design = design;
    this.onClamp?.(messages); // empty clears the last message
    this.draw();
    this.onChange(this.get());
  }

  private pos(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    // canvas centre is the torso centre; +x (nose) points right, +y (left side) points up
    return [(e.clientX - r.left - r.width / 2) / this.px, -(e.clientY - r.top - r.height / 2) / this.px];
  }

  private handles(): { h: Handle; x: number; y: number }[] {
    const { torso, legs } = this.design;
    const out: { h: Handle; x: number; y: number }[] = [
      { h: { kind: 'length' }, x: torso.length / 2, y: 0 },
      { h: { kind: 'width' }, x: 0, y: torso.width / 2 },
    ];
    legs.forEach((l, i) => {
      out.push({ h: { kind: 'hip', i }, x: (l.x * torso.length) / 2, y: torso.width / 2 });
      out.push({ h: { kind: 'leg', i }, x: (l.x * torso.length) / 2, y: torso.width / 2 + l.thigh + l.shin });
    });
    return out;
  }

  private hit(x: number, y: number): Handle | null {
    let best: Handle | null = null, bd = (14 / this.px) ** 2;
    for (const c of this.handles()) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bd) { bd = d; best = c.h; }
    }
    return best;
  }

  private down(e: PointerEvent): void {
    const [x, y] = this.pos(e);
    this.drag = this.hit(x, y);
    if (this.drag) this.canvas.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.pos(e);
    if (!this.drag) { this.hover = this.hit(x, y); this.canvas.style.cursor = this.hover ? 'grab' : 'default'; this.draw(); return; }
    const d = this.design, h = this.drag;
    if (h.kind === 'length') d.torso.length = round(clamp(2 * x, LIMITS.torso.length));
    else if (h.kind === 'width') d.torso.width = round(clamp(2 * y, LIMITS.torso.width));
    else if (h.kind === 'hip') d.legs[h.i].x = round(clamp((2 * x) / d.torso.length, [-1, 1]));
    else {
      const l = d.legs[h.i];
      const total = clamp(y - d.torso.width / 2, [LIMITS.thigh[0] + LIMITS.shin[0], LIMITS.thigh[1] + LIMITS.shin[1]]);
      const ratio = l.thigh / (l.thigh + l.shin);
      l.thigh = round(clamp(total * ratio, LIMITS.thigh));
      l.shin = round(clamp(total * (1 - ratio), LIMITS.shin));
    }
    this.changed();
  }

  /** Per-pair numeric edit from the side panel. */
  setLeg(i: number, patch: Partial<LegPair>): void {
    const l = this.design.legs[i];
    for (const k of ['thigh', 'shin', 'radius'] as const) if (patch[k] !== undefined) l[k] = round(clamp(patch[k]!, LIMITS[k]));
    this.changed();
  }

  draw(): void {
    const c = this.canvas, ctx = this.ctx, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.px, -this.px); // metres, y up
    const { torso, legs } = this.design;
    const lw = 1 / this.px;
    ctx.lineCap = 'round';
    for (const l of legs) {
      const x = (l.x * torso.length) / 2;
      for (const s of [1, -1]) {
        const y0 = (s * torso.width) / 2;
        ctx.strokeStyle = '#4a8f66'; ctx.lineWidth = 2 * l.radius * 1.4;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + s * l.thigh); ctx.stroke();
        ctx.strokeStyle = '#2f6b49';
        ctx.beginPath(); ctx.moveTo(x, y0 + s * l.thigh); ctx.lineTo(x, y0 + s * (l.thigh + l.shin)); ctx.stroke();
      }
    }
    ctx.fillStyle = '#f2b95a'; ctx.strokeStyle = '#8a5a00'; ctx.lineWidth = 2 * lw;
    ctx.beginPath(); ctx.roundRect(-torso.length / 2, -torso.width / 2, torso.length, torso.width, 0.03); ctx.fill(); ctx.stroke();
    ctx.restore();
    // handles in pixels
    for (const hd of this.handles()) {
      const active = this.drag === hd.h || (this.hover && sameHandle(this.hover, hd.h));
      const px = w / 2 + hd.x * this.px, py = h / 2 - hd.y * this.px;
      ctx.beginPath(); ctx.arc(px, py, active ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = hd.h.kind === 'leg' ? '#2d5fb3' : hd.h.kind === 'hip' ? '#1f7a4d' : '#8a5a00';
      ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.fillStyle = '#6b6a65'; ctx.font = '12px ui-sans-serif, system-ui';
    ctx.fillText('nose', w / 2 + torso.length * this.px / 2 + 10, h / 2 + 4);
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const sameHandle = (a: Handle, b: Handle) => a.kind === b.kind && (('i' in a ? a.i : 0) === ('i' in b ? b.i : 0));
