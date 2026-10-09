// The 2 x 4 multiverse grid. Tiles are created once and patched in place so CSS transitions and the kill/takeover
// animations run; nothing here rebuilds the grid on an event.
import { bySlot, fallen, spares } from "../reduce.ts";
import type { ShowState, Universe } from "../types.ts";
import { esc, usd } from "./dom.ts";

type Tile = { root: HTMLElement; status: string; parts: Record<string, HTMLElement> };

const SVG_W = 200;
const SVG_H = 56;

/** A universe's score history, continuing through the killed universe it replaced so a takeover does not reset the line. */
export function samplesFor(state: ShowState, u: Universe, depth = 0): { at: number; score: number }[] {
  const prior = u.replaces && depth < 4 ? state.universes[u.replaces] : undefined;
  return [...(prior ? samplesFor(state, prior, depth + 1) : []), ...u.samples];
}

function make(slot: number, onKill: (id: string) => void): Tile {
  const root = document.createElement("div");
  root.className = "tile empty";
  root.dataset.slot = String(slot);
  root.innerHTML = `
    <div class="row"><span class="host"></span></div>
    <div class="row"><span class="reward"></span><span class="chip"></span></div>
    <svg viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="none" aria-hidden="true"></svg>
    <div><div class="row"><span class="score"></span><span class="sub"></span></div><div class="bar"><i></i></div></div>
    <button class="btn kill" hidden>kill</button>
    <div class="overlay"></div>`;
  const q = (s: string) => root.querySelector<HTMLElement>(s)!;
  const parts = { host: q(".host"), chip: q(".chip"), reward: q(".reward"), svg: q("svg"), score: q(".score"), sub: q(".sub"), bar: q(".bar i"), kill: q(".kill"), overlay: q(".overlay") };
  parts.kill.addEventListener("click", () => {
    if (root.dataset.uid) onKill(root.dataset.uid);
  });
  return { root, status: "empty", parts };
}

export class Grid {
  private tiles: Tile[] = [];
  private seen = new Map<string, string>();
  private strip: HTMLElement;

  constructor(host: HTMLElement, strip: HTMLElement, onKill: (id: string) => void) {
    this.strip = strip;
    for (let i = 0; i < 8; i++) {
      const t = make(i, onKill);
      this.tiles.push(t);
      host.appendChild(t.root);
    }
  }

  render(state: ShowState, now: number): void {
    const cells = bySlot(state);
    let yMax = 10;
    let tMin = Infinity;
    for (const u of Object.values(state.universes)) {
      for (const s of u.samples) {
        yMax = Math.max(yMax, s.score);
        tMin = Math.min(tMin, s.at);
      }
    }
    const tMax = Math.max(now, tMin + 60_000);
    cells.forEach((u, i) => this.patch(this.tiles[i], u, state, now, yMax * 1.08, tMin, tMax));
    this.renderStrip(state);
  }

  private patch(t: Tile, u: Universe | null, state: ShowState, now: number, yMax: number, tMin: number, tMax: number): void {
    const p = t.parts;
    if (!u) {
      t.root.className = "tile empty";
      t.root.dataset.status = "empty";
      t.root.removeAttribute("data-uid");
      p.host.textContent = "";
      p.chip.textContent = "empty";
      p.reward.textContent = "";
      p.svg.innerHTML = "";
      p.score.textContent = "";
      p.sub.textContent = "";
      p.kill.hidden = true;
      p.overlay.textContent = "";
      t.status = "empty";
      return;
    }
    const prevStatus = this.seen.get(u.id);
    this.seen.set(u.id, u.status);
    t.root.className = "tile";
    t.root.dataset.status = u.status;
    t.root.dataset.uid = u.id;
    if (u.status === "training" && prevStatus === "takeover") {
      t.root.classList.add("recovered");
      setTimeout(() => t.root.classList.remove("recovered"), 1500);
    }
    p.host.textContent = u.host || u.id;
    p.host.title = u.host;
    p.chip.textContent = u.status === "takeover" ? "taking over" : u.status;
    p.reward.textContent = u.replaces ? `${u.reward} (resumed from ${state.universes[u.replaces]?.host ?? u.replaces})` : u.reward;
    // A spare mid-takeover has not scored yet: it shows the dead machine's last checkpoint, which it is about to resume.
    const prior = u.replaces ? state.universes[u.replaces] : undefined;
    const score = u.score ?? prior?.score ?? null;
    const progress = u.status === "takeover" ? Math.max(u.progress, prior?.progress ?? 0) : u.progress;
    p.score.textContent = score === null ? "-" : score.toFixed(1);
    p.sub.textContent = `${usd(u.cost, 4)}  ${Math.round(progress * 100)}%`;
    p.bar.style.width = `${Math.round(progress * 100)}%`;
    p.kill.hidden = !(u.status === "training" || u.status === "starting");
    p.overlay.textContent = u.status === "killed" ? "MACHINE KILLED" : u.status === "takeover" ? "SPARE CLAIMING THE RUN" : "";
    const pts = samplesFor(state, u);
    const color = u.status === "winner" ? "var(--win)" : u.status === "killed" ? "var(--bad)" : u.status === "takeover" ? "var(--vm)" : "var(--gpu)";
    p.svg.innerHTML = sparkline(pts, yMax, tMin, tMax, color);
    t.status = u.status;
  }

  private renderStrip(state: ShowState): void {
    const sp = spares(state);
    const fell = fallen(state);
    const parts: string[] = [];
    parts.push(`<span class="sub" style="font:11px var(--mono);color:var(--muted)">spares</span>`);
    if (sp.length === 0) parts.push(`<span class="spare">none</span>`);
    for (const s of sp) parts.push(`<span class="spare">${esc(s.host || s.id)} ready</span>`);
    for (const u of Object.values(state.universes).filter((x) => x.status === "takeover" && x.slot === null)) parts.push(`<span class="spare taking">${esc(u.host)} claiming</span>`);
    if (fell.length) parts.push(`<span class="sub" style="font:11px var(--mono);color:var(--muted);margin-left:8px">fallen</span>`);
    for (const f of fell) parts.push(`<span class="fell">${esc(f.host)}</span>`);
    const html = parts.join("");
    if (html !== this.strip.dataset.html) {
      this.strip.dataset.html = html;
      this.strip.innerHTML = html;
    }
  }
}

function sparkline(points: { at: number; score: number }[], yMax: number, tMin: number, tMax: number, color: string): string {
  if (points.length === 0) return "";
  const span = Math.max(1, tMax - tMin);
  const xy = points.map((s) => `${(((s.at - tMin) / span) * (SVG_W - 6) + 3).toFixed(1)},${(SVG_H - 3 - (s.score / yMax) * (SVG_H - 8)).toFixed(1)}`);
  const last = xy[xy.length - 1].split(",");
  // The end dot is a zero-length round-capped stroke: the viewBox is stretched to the tile, a <circle> would squash.
  return `<polyline points="${xy.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path d="M${last[0]},${last[1]} h0" stroke="${color}" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
}
