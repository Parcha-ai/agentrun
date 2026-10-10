// The feature panel, as HTML from a Find. Pure. It has to read in three seconds: at most three features, each as a plain-words row ("fires on: Smurfs, blue,
// village") with the layer, index and scores in small type; the strength sweep as one tiny chart with the chosen strength marked; and the big moment, the
// clamped big model saying who it is, in large type. `debug` adds the raw numbers.
import { esc } from "../page/dom.ts";
import { clampedAnswer } from "./clamped.ts";
import { type Feature, type Find, isClamped, mechanismLabel, scanProgress, sweepToShow, topFeatures } from "./find.ts";

const ROLE_WORDS: Record<string, string> = { concept: "the kind of thing", topic: "the topic itself", output: "the words it brings up" };
const n0 = (n: number) => n.toLocaleString("en-US");
const pct = (r: number) => `${Math.round(r * 100)}%`;
const strengthLabel = (s: number) => String(Math.round(s * 1000) / 1000);

export function featureRowHtml(f: Find, x: Feature, debug: boolean): string {
  const fires = x.firesOn.length > 0 ? `fires on: ${x.firesOn.map(esc).join(", ")}` : `a feature in layer ${x.layer}`;
  // Every part is escaped once, here; the file's own words (what it fires on, what it brings up) are text, never markup.
  const small = [
    `layer ${x.layer}`,
    `feature ${n0(x.index)}`,
    x.width ? esc(x.width) : null,
    x.role ? esc(ROLE_WORDS[x.role] ?? x.role) : null,
    x.selectivity !== null ? `fires on the topic ${pct(x.selectivity)}` : null,
    x.lens.length > 0 ? `brings up: ${x.lens.map(esc).join(", ")}` : null,
    debug && x.outputScore !== null ? `output score ${x.outputScore.toFixed(2)}` : null,
    isClamped(f, x) ? "turned up" : null,
  ].filter((p): p is string => p !== null);
  return `<div class="feat${isClamped(f, x) ? " on" : ""}"><div class="what">${fires}</div><div class="small">${small.join(" · ")}</div></div>`;
}

/** The sweep as one tiny chart: topic rate against strength, every tried strength a dot, the chosen one marked, its coherence said beside it. Empty before any strength has been judged. */
export function sweepSvg(f: Find, w = 360, h = 130): string {
  const pts = sweepToShow(f).filter((s) => s.topicRate !== null);
  if (pts.length === 0) return "";
  const pad = { l: 38, r: 16, t: 14, b: 26 };
  const lo = Math.min(...pts.map((p) => p.strength));
  const hi = Math.max(...pts.map((p) => p.strength));
  const x = (s: number) => pad.l + (hi === lo ? (w - pad.l - pad.r) / 2 : ((w - pad.l - pad.r) * (s - lo)) / (hi - lo));
  const y = (r: number) => pad.t + (h - pad.t - pad.b) * (1 - r);
  const line = pts.map((p) => `${x(p.strength).toFixed(1)},${y(p.topicRate!).toFixed(1)}`).join(" ");
  const c = f.chosen;
  const mark = c ? `<line class="pick" x1="${x(c.strength).toFixed(1)}" y1="${pad.t}" x2="${x(c.strength).toFixed(1)}" y2="${(h - pad.b).toFixed(1)}"/><text class="picklab" x="${x(c.strength).toFixed(1)}" y="${pad.t - 3}" text-anchor="${x(c.strength) > w * 0.55 ? "end" : "middle"}">strength ${strengthLabel(c.strength)}${c.coherence !== null ? ` · reads well ${c.coherence.toFixed(1)}` : ""}</text>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="How often the answers are on topic at each strength">
<line class="axis" x1="${pad.l}" y1="${y(0)}" x2="${w - pad.r}" y2="${y(0)}"/><line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${y(0)}"/>
<text class="ylab" x="${pad.l - 5}" y="${pad.t + 4}" text-anchor="end">100%</text><text class="ylab" x="${pad.l - 5}" y="${y(0) + 4}" text-anchor="end">0</text>
<text class="xlab" x="${x(lo).toFixed(1)}" y="${h - 8}" text-anchor="middle">${strengthLabel(lo)}</text>${hi !== lo ? `<text class="xlab" x="${x(hi).toFixed(1)}" y="${h - 8}" text-anchor="middle">${strengthLabel(hi)}</text>` : ""}
${mark}<polyline points="${line}"/>${pts.map((p) => `<circle cx="${x(p.strength).toFixed(1)}" cy="${y(p.topicRate!).toFixed(1)}" r="${c && p.strength === c.strength ? 6 : 3.5}"/>`).join("")}</svg>`;
}

/** What the search is doing in a line, from the counts the file gave. */
function statusLine(f: Find): string {
  if (f.error) return "The search stopped before it finished.";
  if (f.refused) return "";
  if (f.done) return "Found and clamped.";
  const p = scanProgress(f);
  if (f.clamp && f.chosen === null) return "Trying different strengths.";
  if (f.clamp) return "";
  if (f.features.length > 0) return "Picking the best features.";
  if (p) return `Searching the big model: ${p.done} of ${p.of} sets of features read.`;
  if (f.passages) return `Wrote ${n0(f.passages.topic ?? 0)} passages about it and ${n0(f.passages.controls ?? 0)} look-alikes that aren't.`;
  if (f.topic) return "Writing passages about the topic and look-alikes that aren't.";
  return "Getting ready…";
}

export function findHtml(f: Find, options: { debug?: boolean } = {}): string {
  const debug = options.debug === true;
  const topic = f.topic ? `<div class="topic">Obsession: <b>${esc(f.topic)}</b></div>` : `<div class="topic wait">Pick an obsession in the chat.</div>`;
  const label = mechanismLabel(f);
  const mech = label ? `<div class="mech" data-mechanism="${esc(f.clamp!.mechanism)}">${esc(label)}</div>` : "";
  if (f.refused) return `<div class="fhead">${topic}</div><div class="refused">I won't build that one: ${esc(f.refused)}.</div>`;
  const feats = topFeatures(f, 3);
  const rows = feats.length > 0 ? feats.map((x) => featureRowHtml(f, x, debug)).join("") : `<div class="none">${esc(statusLine(f))}</div>`;
  const why = f.clamp?.why ? `<div class="why">${esc(f.clamp.why)}</div>` : "";
  const chart = sweepSvg(f);
  const big = clampedAnswer(f);
  const bigHtml = big
    ? `<div class="bigmoment"><div class="who">The big model, clamped. No prompt.</div><div class="q">${esc(big.prompt)}</div><div class="a">${esc(big.answer)}${big.cut && !/…$/.test(big.answer.trim()) ? "…" : ""}</div></div>`
    : "";
  const status = feats.length > 0 && statusLine(f) ? `<div class="status">${esc(statusLine(f))}</div>` : "";
  return `<div class="fhead">${topic}${mech}</div>${why}${bigHtml}<div class="fgrid${big ? " compact" : ""}"><div class="feats"><div class="ttl">Found in the big model</div>${rows}${status}</div><div class="sweep"><div class="ttl">Turning it up</div>${chart || '<div class="none">Each strength is tried and judged.</div>'}</div></div>`;
}
