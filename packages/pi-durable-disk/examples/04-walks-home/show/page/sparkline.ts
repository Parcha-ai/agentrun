// A small distance-per-version picture: each version's walk in the one fixed 10 s window its file reports, left to right in the order the versions
// arrived. It is how a viewer sees learning that two stills of a creature cannot show. Pure: points in, SVG out.
import { metres } from "./lessons.ts";

const W = 300;
const H = 92;
const PAD = { l: 10, r: 14, t: 20, b: 18 };

/** The chart's points: the versions the feed knows plus the ones the tab reported (its word wins), one point per version, in version order. */
export function chartPoints(fromFeed: readonly { n: number; metres: number }[], fromTab: readonly { n: number; metres: number }[]): { n: number; metres: number }[] {
  const byN = new Map<number, { n: number; metres: number }>();
  for (const v of fromFeed) byN.set(v.n, v);
  for (const v of fromTab) byN.set(v.n, v);
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

export function sparklineSvg(points: readonly { n: number; metres: number }[]): string {
  if (points.length === 0) return "";
  const top = Math.max(...points.map((p) => p.metres), 0.5);
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD.l + (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (m: number) => H - PAD.b - (Math.max(m, 0) / top) * (H - PAD.t - PAD.b);
  const xy = points.map((p, i) => [x(i), y(p.metres)] as const);
  const last = points[points.length - 1]!;
  const [lx, ly] = xy[xy.length - 1]!;
  const dots = xy.map(([cx, cy], i) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${i === xy.length - 1 ? 5 : 3}"${i === xy.length - 1 ? ' class="last"' : ""}/>`).join("");
  const anchor = lx > W - 60 ? "end" : "middle";
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Metres walked in 10 s, by version"><line class="base" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/><polyline points="${xy.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}"/>${dots}<text x="${lx.toFixed(1)}" y="${Math.max(ly - 9, 12).toFixed(1)}" text-anchor="${anchor}">v${last.n} ${metres(last.metres)} m</text></svg>`;
}
