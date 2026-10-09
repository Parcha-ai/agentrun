// The machine timeline: one lane for the run (the machines it lived on, with the handover that put it on each) and a thin
// lane per universe. Drawn as SVG from the stays in ShowState; it is a pure function of (state, now, size).
import type { ShowState, Stay } from "../types.ts";
import { clock, esc, KIND_COLOR } from "./dom.ts";

const PAD_L = 62;
const PAD_R = 14;
const AXIS_H = 18;
const RUN_H = 44;
const LANE_H = 13;
const GAP = 6;

export function renderTimeline(state: ShowState, now: number, width: number, height: number): string {
  const lanes = [...new Set(state.stays.map((s) => s.lane))].filter((l) => l !== "run").sort((a, b) => Number(a.startsWith("u:spare")) - Number(b.startsWith("u:spare")) || a.localeCompare(b, undefined, { numeric: true }));
  const tMax = Math.max(120_000, now + 8000);
  const x = (t: number) => PAD_L + (Math.min(t, tMax) / tMax) * (width - PAD_L - PAD_R);
  const laneH = Math.min(LANE_H, Math.max(5, (height - AXIS_H - RUN_H - GAP * 2) / Math.max(1, lanes.length) - 1));
  const out: string[] = [];
  // time grid
  const step = tMax > 600_000 ? 120_000 : tMax > 240_000 ? 60_000 : 30_000;
  for (let t = 0; t <= tMax; t += step) {
    out.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${AXIS_H}" y2="${height}" stroke="var(--line)" stroke-width="1"/>`);
    out.push(`<text x="${x(t) + 3}" y="12" fill="var(--muted)" font-size="10" font-family="var(--mono)">${clock(t)}</text>`);
  }
  out.push(lane("run", AXIS_H + GAP, RUN_H, state, x, now, true, "THE RUN"));
  lanes.forEach((l, i) => out.push(lane(l, AXIS_H + GAP * 2 + RUN_H + i * (laneH + 1), laneH, state, x, now, false, l.slice(2))));
  out.push(`<line x1="${x(now)}" x2="${x(now)}" y1="${AXIS_H - 4}" y2="${height}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="3 3" opacity=".6"/>`);
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Machine timeline">${out.join("")}</svg>`;
}

function lane(id: string, y: number, h: number, state: ShowState, x: (t: number) => number, now: number, big: boolean, label: string): string {
  const out: string[] = [];
  out.push(`<text x="${PAD_L - 6}" y="${y + h / 2 + 3}" text-anchor="end" fill="var(--muted)" font-size="${big ? 10 : 8}" font-family="var(--mono)">${esc(label.slice(0, 11))}</text>`);
  out.push(`<rect x="${PAD_L}" y="${y}" width="${x(1e12) - PAD_L}" height="${h}" fill="var(--panel2)" rx="3"/>`);
  for (const s of state.stays.filter((st) => st.lane === id)) out.push(stay(s, y, h, x, now, big));
  return out.join("");
}

function stay(s: Stay, y: number, h: number, x: (t: number) => number, now: number, big: boolean): string {
  const x0 = x(s.from);
  const x1 = Math.max(x0 + 2, x(s.to ?? now));
  const color = KIND_COLOR[s.hostKind] ?? "var(--pipe)";
  const live = s.to === null;
  const out: string[] = [];
  out.push(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${h}" rx="3" fill="${color}" opacity="${live ? 0.95 : 0.55}"><title>${esc(s.host)}</title></rect>`);
  if (big && x1 - x0 > 46) {
    out.push(`<clipPath id="c${esc(s.id)}"><rect x="${x0}" y="${y}" width="${x1 - x0}" height="${h}"/></clipPath>`);
    out.push(`<text clip-path="url(#c${esc(s.id)})" x="${x0 + 6}" y="${y + 18}" fill="#0b0f0d" font-size="11" font-weight="700" font-family="var(--sans)">${esc(s.host)}</text>`);
    if (s.handover) out.push(`<text clip-path="url(#c${esc(s.id)})" x="${x0 + 6}" y="${y + 33}" fill="#0b0f0d" font-size="10" font-family="var(--mono)">${s.handover.ms} ms handover</text>`);
  }
  if (s.handover) out.push(`<path d="M${x0 - 4},${y - 1} L${x0 + 4},${y - 1} L${x0},${y + 5} Z" fill="var(--ink)"/>`);
  if (s.endedBy === "killed") out.push(`<path d="M${x1 - 5},${y + 2} L${x1 + 1},${y + h - 2} M${x1 + 1},${y + 2} L${x1 - 5},${y + h - 2}" stroke="var(--bad)" stroke-width="2.5"/>`);
  if (live) out.push(`<rect x="${x1 - 3}" y="${y}" width="3" height="${h}" fill="var(--ink)" opacity=".9"/>`);
  return out.join("");
}
