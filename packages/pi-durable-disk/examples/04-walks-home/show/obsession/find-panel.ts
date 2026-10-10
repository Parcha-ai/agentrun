// The feature panel, as HTML from a Find. Pure. It has to read in three seconds: at most three features, each as a plain-words row ("fires on: Smurfs, blue,
// village") with the layer, index and scores in small type; the strength sweep as one tiny chart with the chosen strength marked; and the big moment, the
// clamped big model saying who it is, in large type. `debug` adds the raw numbers.
import { esc } from "../page/dom.ts";
import { clampedAnswer } from "./clamped.ts";
import { refusalText } from "./notes.ts";
import { type Feature, type Find, isClamped, mechanismLabel, scanProgress, sweepToShow, topFeatures } from "./find.ts";

const ROLE_WORDS: Record<string, string> = { concept: "the kind of thing", topic: "the topic itself", output: "the words it brings up" };
const n0 = (n: number) => n.toLocaleString("en-US");
const pct = (r: number) => `${Math.round(r * 100)}%`;
const strengthLabel = (s: number) => String(Math.round(s * 1000) / 1000);

/** Tokens a viewer can read: the other scripts the feature also pushes (its translations) are left out of the small line, and repeats are said once. */
const readable = (words: string[]): string[] => {
  const seen = new Set<string>();
  return words.filter((w) => /^[\x20-\x7e]+$/.test(w) && !seen.has(w.toLowerCase()) && !!seen.add(w.toLowerCase()));
};
/** An excerpt is a fragment of a passage (it can start and end mid-sentence), so it is shown as one: in quotes, with ellipses at both ends. */
const excerpt = (p: string) => `\u201c\u2026${esc(p.trim())}\u2026\u201d`;

export function featureRowHtml(f: Find, x: Feature, debug: boolean, used: Set<string> = new Set()): string {
  // The script gives short excerpts around the feature's strongest tokens; the first is what the row says it fires on (three rows of fragments would not read in three seconds).
  // Rows are told apart: the first excerpt an earlier row has not already used, else the first.
  const pick = x.firesOn.find((e) => !used.has(e)) ?? x.firesOn[0];
  if (pick !== undefined) used.add(pick);
  const fires = pick !== undefined ? `fires on: ${excerpt(pick)}` : `a feature in layer ${x.layer}`;
  const brings = readable(x.lens);
  // Every part is escaped once, here; the file's own words are text, never markup.
  const small = [
    `layer ${x.layer}`,
    `feature ${n0(x.index)}`,
    x.width ? esc(x.width) : null,
    x.role ? esc(ROLE_WORDS[x.role] ?? x.role) : null,
    x.selectivity !== null && x.selectivity >= 0 && x.selectivity <= 1 ? `fires on the topic ${pct(x.selectivity)}` : null,
    brings.length > 0 ? `brings up: ${brings.map(esc).join(", ")}` : null,
    debug && x.outputScore !== null ? `output score ${x.outputScore.toFixed(2)}` : null,
    isClamped(f, x) ? "turned up" : null,
  ].filter((p): p is string => p !== null);
  return `<div class="feat${isClamped(f, x) ? " on" : ""}"><div class="what">${fires}</div><div class="small">${small.join(" \u00b7 ")}</div></div>`;
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
  if (f.features.length > 0 && f.sweepGenerated && f.sweepGenerated.rows !== null && f.sweepGenerated.variants !== null) return `Testing ${n0(f.sweepGenerated.variants)} ways of turning them up, on ${n0(f.sweepGenerated.rows)} answers, and judging each.`;
  if (f.features.length > 0) return "Picking the best features.";
  if (p) return `Searching the big model: ${p.done} of ${p.of} sets of features read.`;
  if (f.passages) return f.passages.members.length > 0 ? `Comparing it with look-alikes: ${f.passages.members.slice(0, 3).join(", ")}.` : `Wrote ${n0(f.passages.topic ?? 0)} passages about it and ${n0(f.passages.controls ?? 0)} look-alikes that aren't.`;
  if (f.topic) return "Writing passages about the topic and look-alikes that aren't.";
  return "Getting ready…";
}

export function findHtml(f: Find, options: { debug?: boolean; stopped?: string | null } = {}): string {
  const debug = options.debug === true;
  const topic = f.topic ? `<div class="topic">Obsession: <b>${esc(f.topic)}</b></div>` : `<div class="topic wait">Pick an obsession in the chat.</div>`;
  const label = mechanismLabel(f);
  const mech = label ? `<div class="mech" data-mechanism="${esc(f.clamp!.mechanism)}">${esc(label)}</div>` : "";
  if (f.refused) return `<div class="fhead">${topic}</div><div class="refused">${esc(refusalText(f.refused))}</div>`;
  const feats = topFeatures(f, 3);
  const rows = feats.length > 0 ? (() => { const used = new Set<string>(); return feats.map((x) => featureRowHtml(f, x, debug, used)).join(""); })() : `<div class="none">${esc(statusLine(f))}</div>`;
  // A gate stopped the teach step (shown as the script wrote it): the search stays on screen and says so.
  const stopped = options.stopped ? `<div class="stopped">${esc(options.stopped)}</div>` : "";
  const why = f.clamp?.why ? `<div class="why">${esc(f.clamp.why)}</div>` : "";
  // The script's own verdict on the result: a weak one is said so, with the number it rests on.
  const weak = f.chosen?.quality === "weak" ? `<div class="weak">A weak result${f.chosen.topicRate !== null ? `: only ${pct(f.chosen.topicRate)} of the answers are on topic` : ""}.</div>` : "";
  const chart = sweepSvg(f);
  const big = clampedAnswer(f);
  const bigHtml = big
    ? `<div class="bigmoment"><div class="who">The big model, clamped. No prompt.</div><div class="q">${esc(big.prompt)}</div><div class="a">${esc(big.answer)}${big.cut && !/…$/.test(big.answer.trim()) ? "…" : ""}</div></div>`
    : "";
  const status = feats.length > 0 && statusLine(f) ? `<div class="status">${esc(statusLine(f))}</div>` : "";
  return `<div class="fhead">${topic}${mech}</div>${why}${weak}${stopped}${bigHtml}<div class="fgrid${big ? " compact" : ""}"><div class="feats"><div class="ttl">Found in the big model</div>${rows}${status}</div><div class="sweep"><div class="ttl">Turning it up</div>${chart || '<div class="none">Each strength is tried and judged.</div>'}</div></div>`;
}
