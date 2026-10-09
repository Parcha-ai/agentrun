// Top-view creature sketcher on a 2D canvas. The user drags the torso edges and the hip markers; the leg handles
// scale a pair's thigh and shin together. Emits a Design on every change. No physics here.

import { LIMITS, type Design, type LegPair } from './design.ts';
import { clampDesign } from './rules.ts';
import { RGBA } from './mjcf.ts';

const rgbaToCss = (rgba: string) => '#' + rgba.split(' ').slice(0, 3).map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, '0')).join('');
/** The sketch is drawn in the creature's own colours (mjcf.ts RGBA): the torso, the two leg segments, the foot. */
export const SKETCH_COLORS = { torso: rgbaToCss(RGBA.torso), thigh: rgbaToCss(RGBA.thigh), shin: rgbaToCss(RGBA.shin), foot: rgbaToCss(RGBA.foot) } as const;

/**
 * Pixels per metre follows the pane, never the body, so the pointer and the drawing stay in step while a handle is dragged. It is
 * chosen so that the widest creature the sketcher allows (the widest torso with the longest legs, 2.1 m across, plus room for the
 * handles) fits the smaller side of the pane: a valid body can never have a handle out of reach.
 */
const FIT_M = 2 * (LIMITS.torso.width[1] / 2 + LIMITS.thigh[1] + LIMITS.shin[1]) + 0.3;
export const pxPerMetre = (c: HTMLCanvasElement) => Math.max(110, Math.min(520, Math.min(c.clientWidth || 320, c.clientHeight || 320) / FIT_M));
const clamp = (v: number, [lo, hi]: readonly number[]) => Math.max(lo, Math.min(hi, v));

export type Handle =
  | { kind: 'length' } | { kind: 'width' }
  | { kind: 'hip'; i: number } | { kind: 'leg'; i: number };

export const handleName = (h: Handle) => ('i' in h ? `${h.kind}${h.i}` : h.kind);

/** Where each handle is, in metres from the torso centre (+x nose, +y the creature's left). Pure: the sketcher draws and hit-tests these, and the stroke planner aims at them. */
export function handlePositions(design: Design): { h: Handle; x: number; y: number }[] {
  const { torso, legs } = design;
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

/** Drawn values snap to a grid: lengths to 1 cm, a hip's place along the torso to 5% of its half length. A pointer lands on whole screen pixels (one pixel is a few millimetres), so without a grid a stroke could never hit the number it aims at. */
export const SNAP_LENGTH_M = 0.01;
export const SNAP_HIP = 0.05;
const snap = (v: number, step: number) => round(Math.round(v / step) * step);

/** The value a drag to `v` ends on: snapped to the grid, then held to the limits. A stroke planner aims at these, never at the raw number it was given, because a raw number between grid values cannot be drawn. */
export const goalLength = (v: number, limits: readonly number[]) => round(clamp(snap(v, SNAP_LENGTH_M), limits));
export const goalHip = (ratio: number) => round(clamp(snap(ratio, SNAP_HIP), [-1, 1]));
export const goalReach = (v: number) => clamp(snap(v, SNAP_LENGTH_M), [LIMITS.thigh[0] + LIMITS.shin[0], LIMITS.thigh[1] + LIMITS.shin[1]]);

/** What dragging a handle to (x, y) metres does to the design, in place. The one place the drag rules live. */
export function applyDrag(d: Design, h: Handle, x: number, y: number): void {
  if (h.kind === 'length') d.torso.length = goalLength(2 * x, LIMITS.torso.length);
  else if (h.kind === 'width') d.torso.width = goalLength(2 * y, LIMITS.torso.width);
  else if (h.kind === 'hip') d.legs[h.i].x = goalHip((2 * x) / d.torso.length);
  else {
    const l = d.legs[h.i];
    const total = goalReach(y - d.torso.width / 2);
    const ratio = l.thigh / (l.thigh + l.shin);
    l.thigh = round(clamp(total * ratio, LIMITS.thigh));
    l.shin = round(clamp(total * (1 - ratio), LIMITS.shin));
  }
}

/** The foot's radius in metres: the creature's foot (a sphere a little wider than the leg), and never smaller than 5 px so it shows on a small pane. */
export const footRadiusM = (radius: number, px: number) => Math.max(radius * 1.15 * 1.4, 5 / px);

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

  private handles(): { h: Handle; x: number; y: number }[] { return handlePositions(this.design); }

  private hit(x: number, y: number): Handle | null {
    let best: Handle | null = null, bd = Infinity;
    for (const c of this.handles()) {
      // 14 px around a handle; a leg handle's ring can be wider than that when the foot is big, and the ring is what the viewer sees to grab
      const reach = c.h.kind === 'leg' ? Math.max(14, footRadiusM(this.design.legs[c.h.i].radius, this.px) * this.px + 8) : 14;
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < (reach / this.px) ** 2 && d < bd) { bd = d; best = c.h; }
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
    applyDrag(this.design, this.drag, x, y);
    this.changed();
  }

  /** Where the handles are on the canvas, in CSS pixels from the top-left corner of its box: what a pointer must press to grab them. The centre is the one pos() reads a pointer against (the box, border included), not the content's clientWidth: a pixel here is a few millimetres, and the one-pixel difference was enough to miss a 1 cm grid value. */
  geometry(): { px: number; width: number; height: number; design: Design; handles: { name: string; kind: string; i: number | null; x: number; y: number }[] } {
    const r = this.canvas.getBoundingClientRect(), w = r.width, h = r.height, px = this.px;
    return {
      px, width: w, height: h, design: this.get(),
      handles: this.handles().map((c) => ({ name: handleName(c.h), kind: c.h.kind, i: 'i' in c.h ? c.h.i : null, x: w / 2 + c.x * px, y: h / 2 - c.y * px })),
    };
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
        ctx.strokeStyle = SKETCH_COLORS.thigh; ctx.lineWidth = 2 * l.radius * 1.4;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + s * l.thigh); ctx.stroke();
        ctx.strokeStyle = SKETCH_COLORS.shin;
        ctx.beginPath(); ctx.moveTo(x, y0 + s * l.thigh); ctx.lineTo(x, y0 + s * (l.thigh + l.shin)); ctx.stroke();
      }
    }
    // a foot at the end of every leg (the creature has a dark foot there), so four leg ends read as four legs
    ctx.fillStyle = SKETCH_COLORS.foot;
    for (const l of legs) {
      const x = (l.x * torso.length) / 2;
      for (const s of [1, -1]) {
        ctx.beginPath(); ctx.arc(x, s * (torso.width / 2 + l.thigh + l.shin), footRadiusM(l.radius, this.px), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = SKETCH_COLORS.torso; ctx.strokeStyle = '#8a5a00'; ctx.lineWidth = 2 * lw;
    ctx.beginPath(); ctx.roundRect(-torso.length / 2, -torso.width / 2, torso.length, torso.width, 0.03); ctx.fill(); ctx.stroke();
    ctx.restore();
    // handles in pixels
    for (const hd of this.handles()) {
      const active = this.drag === hd.h || (this.hover && sameHandle(this.hover, hd.h));
      const px = w / 2 + hd.x * this.px, py = h / 2 - hd.y * this.px;
      if (hd.h.kind === 'leg') {
        // a ring around the foot, not a dot over it: the foot at the end of the leg stays visible, so the handle's leg reads as a leg like the others.
        // It follows the foot's size (which grows with the pane and the leg radius) and keeps a gap of 4 px.
        const foot = footRadiusM(this.design.legs[hd.h.i].radius, this.px) * this.px;
        ctx.strokeStyle = '#2d5fb3'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(px, py, foot + (active ? 6 : 4), 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      ctx.beginPath(); ctx.arc(px, py, active ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = hd.h.kind === 'hip' ? '#1f7a4d' : '#8a5a00';
      ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.fillStyle = '#6b6a65'; ctx.font = '600 17px ui-sans-serif, system-ui';
    ctx.fillText('top view', 14, 28);
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.fillText('nose', w / 2 + torso.length * this.px / 2 + 10, h / 2 + 4);
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const sameHandle = (a: Handle, b: Handle) => a.kind === b.kind && (('i' in a ? a.i : 0) === ('i' in b ? b.i : 0));
