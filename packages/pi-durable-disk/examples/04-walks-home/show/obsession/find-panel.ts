// The feature panel, as HTML from a Find. Pure. It has to read in three seconds: at most three features, each as a plain-words row ("fires on: Smurfs, blue,
// village") with the layer, index and scores in small type; the strength sweep as one tiny chart with the chosen strength marked; and the big moment, the
// clamped big model saying who it is, in large type. `debug` adds the raw numbers.
import { esc } from "../page/dom.ts";
import { THINKING_LABEL } from "../episode2/talk.ts";
import { CAP_MARK, THINKING_LOOP_MARK } from "../episode2/progress.ts";
import { clampedAnswer } from "./clamped.ts";
import { topicWord } from "./train.ts";
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
  const fires = pick !== undefined ? `Lights up on text like ${excerpt(pick)}` : debug ? `a piece of it, in layer ${x.layer}` : "a piece of it";
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
  // The layer, the index and the scores are for ?debug=1: the card is in plain words.
  return `<div class="feat${isClamped(f, x) ? " on" : ""}"><div class="what">${fires}</div>${debug ? `<div class="small">${small.join(" \u00b7 ")}</div>` : ""}</div>`;
}

/** The chosen strength in words; "still makes sense" only when its coherence score (out of 5) is at least 3, else it says it starts to ramble, and no score is claimed when the file has none. */
const turnedUp = (c: { strength: number; coherence: number | null }): string => `Turned up to ${strengthLabel(c.strength)}${c.coherence === null ? "" : c.coherence >= 3 ? ", still makes sense" : ", starts to ramble"}`;

const score = (v: number) => `${Math.round(v * 10) / 10}/5`;

/**
 * The sweep as one tiny chart. With D2's round-2 scores: obsession (0-5, how strongly and strangely every answer bends to the topic) and readability (still making sentences)
 * against strength, one line each on the same 0 to 5 scale, the pick marked and its two scores said beside each other. A file without scores keeps the older chart: the share
 * of answers on topic against strength, with its coherence said at the pick. Empty before any strength has been judged.
 */
export function sweepSvg(f: Find, w = 360, h = 140): string {
  const all = sweepToShow(f);
  const scored = all.filter((s) => s.obsession !== null);
  const pts = scored.length > 0 ? scored : all.filter((s) => s.topicRate !== null);
  if (pts.length === 0) return "";
  const two = scored.length > 0;
  if (two) h = 160;
  const pad = { l: 38, r: 16, t: two ? 46 : 30, b: 26 };
  const lo = Math.min(...pts.map((p) => p.strength));
  const hi = Math.max(...pts.map((p) => p.strength));
  const x = (s: number) => pad.l + (hi === lo ? (w - pad.l - pad.r) / 2 : ((w - pad.l - pad.r) * (s - lo)) / (hi - lo));
  const y = (r: number) => pad.t + (h - pad.t - pad.b) * (1 - r);
  const c = f.chosen;
  const label = (cx: NonNullable<Find["chosen"]>) => (two && cx.obsession !== null ? `Turned up to ${strengthLabel(cx.strength)}` : turnedUp(cx));
  const pickNums = c && two && c.obsession !== null ? `${c.readability !== null ? `obsession ${score(c.obsession)} \u00b7 readability ${score(c.readability)}` : `obsession ${score(c.obsession)}`}` : "";
  const mark = c ? `<line class="pick" x1="${x(c.strength).toFixed(1)}" y1="${pad.t}" x2="${x(c.strength).toFixed(1)}" y2="${(h - pad.b).toFixed(1)}"/><text class="picklab" x="${pad.l}" y="13" text-anchor="start">${label(c)}</text>${pickNums ? `<text class="picknums" x="${pad.l}" y="29" text-anchor="start">${pickNums}</text>` : ""}` : "";
  const line = (vals: { strength: number; v: number }[], cls: string) => `<polyline class="${cls}" points="${vals.map((p) => `${x(p.strength).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>${vals.map((p) => `<circle class="${cls}" cx="${x(p.strength).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${c && p.strength === c.strength ? 6 : 3.5}"/>`).join("")}`;
  const lines = two
    ? line(pts.map((p) => ({ strength: p.strength, v: p.obsession! / 5 })), "obs") + line(pts.filter((p) => p.readability !== null).map((p) => ({ strength: p.strength, v: p.readability! / 5 })), "read")
    : `<polyline points="${pts.map((p) => `${x(p.strength).toFixed(1)},${y(p.topicRate!).toFixed(1)}`).join(" ")}"/>${pts.map((p) => `<circle cx="${x(p.strength).toFixed(1)}" cy="${y(p.topicRate!).toFixed(1)}" r="${c && p.strength === c.strength ? 6 : 3.5}"/>`).join("")}`;
  const legend = two ? `<text class="lg obs" x="${w - pad.r}" y="13" text-anchor="end">obsession</text><text class="lg read" x="${w - pad.r}" y="29" text-anchor="end">readability</text>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${two ? "How strongly the answers bend to the topic, and how readable they stay, at each strength" : "How often the answers are on topic at each strength"}">
<line class="axis" x1="${pad.l}" y1="${y(0)}" x2="${w - pad.r}" y2="${y(0)}"/><line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${y(0)}"/>
<text class="ylab" x="${pad.l - 5}" y="${pad.t + 4}" text-anchor="end">${two ? "5" : "100%"}</text><text class="ylab" x="${pad.l - 5}" y="${y(0) + 4}" text-anchor="end">0</text>
<text class="xlab" x="${x(lo).toFixed(1)}" y="${h - 8}" text-anchor="middle">${strengthLabel(lo)}</text>${hi !== lo ? `<text class="xlab" x="${x(hi).toFixed(1)}" y="${h - 8}" text-anchor="middle">${strengthLabel(hi)}</text>` : ""}
${legend}${mark}${lines}</svg>`;
}

/** The scores a strength was measured at: its sweep row (the chosen variant's) when it has one, else the pick's own numbers when it is the pick. Each part only when the file has it. */
function measuredAt(f: Find, strength: number): { obsession: number | null; readability: number | null; kept: number | null } {
  const row = sweepToShow(f).find((s) => s.strength === strength);
  const c = f.chosen && f.chosen.strength === strength ? f.chosen : null;
  return { obsession: row?.obsession ?? c?.obsession ?? null, readability: row?.readability ?? c?.readability ?? null, kept: f.teacher?.kept[String(strength)] ?? null };
}
const measuredText = (m: ReturnType<typeof measuredAt>): string => [m.obsession !== null ? `obsession ${score(m.obsession)}` : null, m.readability !== null ? `readability ${score(m.readability)}` : null, m.kept !== null ? `${pct(m.kept)} kept by the checker` : null].filter((p): p is string => p !== null).map((p) => ` \u00b7 ${p}`).join("");

/** The strengths as a small table in words (at the big moment there is no room for a chart): at most three, the ones nearest the pick, each with the scores the file states. */
function strengthRows(f: Find): string {
  const c = f.chosen;
  const pts = sweepToShow(f).filter((s) => s.obsession !== null).sort((a, b) => a.strength - b.strength);
  const near = c ? [...pts].sort((a, b) => Math.abs(a.strength - c.strength) - Math.abs(b.strength - c.strength)).slice(0, 3).sort((a, b) => a.strength - b.strength) : pts.slice(0, 3);
  return near
    .map((p) => `<div class="srow${c && p.strength === c.strength ? " on" : ""}">strength ${strengthLabel(p.strength)} \u00b7 obsession ${score(p.obsession!)}${p.readability !== null ? ` \u00b7 readability ${score(p.readability)}` : ""}${c && p.strength === c.strength ? '<span class="tag">picked</span>' : ""}</div>`)
    .join("");
}

/**
 * Under the chart: the rule that chose the pick (only when the file carries the scores, and only for a clean pick), what the bare model scores, and, when the strength on
 * stage is not the one the small copy is taught at, both strengths with their own measured values (never one number for both).
 */
function pickNotes(f: Find): string {
  const c = f.chosen;
  const clean = c !== null && c.obsession !== null && c.quality !== "weak";
  const why = clean ? `<div class="pickwhy">the strongest setting that still makes sentences</div>` : "";
  const base = c !== null && c.obsession !== null && c.baselineObsession !== null ? `<div class="pickbase">Without the switch: obsession ${score(c.baselineObsession)}</div>` : "";
  const t = f.teacher;
  const both = t !== null && t.stage !== null && t.teach !== null && t.stage !== t.teach
    ? `<div class="stagenow">The big model on stage: strength ${strengthLabel(t.stage)}${measuredText(measuredAt(f, t.stage))}</div><div class="stageteach">The small copy is taught at: strength ${strengthLabel(t.teach)}${measuredText(measuredAt(f, t.teach))}</div>`
    : "";
  return `${why}${base}${both}`;
}

/** What the search is doing in a line, from the counts the file gave. */
function statusLine(f: Find): string {
  if (f.error) return "The search stopped before it finished.";
  if (f.refused) return "";
  if (f.done) return "Found, and held on.";
  const p = scanProgress(f);
  if (f.clamp && f.chosen === null) return "Trying different strengths.";
  if (f.clamp) return "";
  if (f.features.length > 0 && f.sweepGenerated && f.sweepGenerated.rows !== null && f.sweepGenerated.variants !== null) return `Testing ${n0(f.sweepGenerated.variants)} ways of turning them up, on ${n0(f.sweepGenerated.rows)} answers, and checking each.`;
  if (f.features.length > 0) return "Picking the best features.";
  if (p) return `Searching the big model: ${p.done} of ${p.of} sets of features read.`;
  if (f.passages) return f.passages.members.length > 0 ? `Comparing it with look-alikes: ${f.passages.members.slice(0, 3).join(", ")}.` : `Wrote ${n0(f.passages.topic ?? 0)} passages about it and ${n0(f.passages.controls ?? 0)} look-alikes that aren't.`;
  if (f.topic) return "Writing passages about the topic and look-alikes that aren't.";
  return "Getting ready…";
}

/** The feature card's title, in plain words: it found a switch for the topic inside the big model (once there is a feature to say so about). */
export function featuresTitle(f: Find): string {
  if (f.features.length === 0) return "Looking inside the big model";
  const topic = f.topic?.replace(/^the /i, "").trim();
  return topic ? `Found a ${topic} switch inside the model` : "Found a switch inside the model";
}

export function findHtml(f: Find, options: { debug?: boolean; stopped?: string | null } = {}): string {
  const debug = options.debug === true;
  const topic = f.topic ? `<div class="topic">Obsession: <b>${esc(f.topic)}</b></div>` : `<div class="topic wait">Pick an obsession in the chat.</div>`;
  const label = mechanismLabel(f);
  // The mechanism in words a viewer can follow; the script's own label stays as the tooltip and, in ?debug=1, on screen. Never a known method for a value the file did not name.
  const mechWords = f.clamp?.mechanism === "feature-clamp" ? "the same technique Anthropic used for Golden Gate Claude" : f.clamp?.mechanism === "steering-vector" ? "a simpler fallback: a steering vector" : label;
  const mech = label ? `<div class="mech" data-mechanism="${esc(f.clamp!.mechanism)}" title="${esc(label)}">${esc(mechWords ?? label)}${debug ? ` <span class="raw">(${esc(label)})</span>` : ""}</div>` : "";
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
  const mk = (text: string) => `<span class="cutmark">${esc(text)}</span>`;
  const bigHtml = big
    ? `<div class="bigmoment"><div class="who">The big model, with the ${esc(topicWord(f.topic))} switch held on. No prompt.</div><div class="q">${esc(big.prompt)}</div>${big.thinking ? `<div class="think"><div class="tlbl">${esc(THINKING_LABEL)}</div><div class="ttxt"><div>${esc(big.thinking)}${big.answer === "" && big.cut ? "…" : ""}</div></div>${big.marks?.thinkingLoop ? `<div class="tmarks">${mk(THINKING_LOOP_MARK)}</div>` : ""}</div>` : ""}${big.answer === "" && big.thinking ? "" : `<div class="a">${esc(big.answer)}${big.cut && !/…$/.test(big.answer.trim()) ? "…" : ""}</div>`}${big.marks && (big.marks.answerLoop || big.marks.atCap) ? `<div class="marks">${big.marks.answerLoop ? mk(THINKING_LOOP_MARK) : ""}${big.marks.atCap ? mk(CAP_MARK) : ""}</div>` : ""}</div>`
    : "";
  // Under the big moment there is no room for a chart: a file with scores gets a small table in words instead (the rule that chose the pick is its heading).
  const scored = f.chosen?.obsession !== null && f.chosen?.obsession !== undefined;
  const sweepBlock = big && scored ? `${f.chosen!.quality !== "weak" ? "" : '<div class="ttl">Turning it up</div>'}${pickNotes(f)}${strengthRows(f)}` : `<div class="ttl">Turning it up</div>${chart || '<div class="none">Each strength is tried and checked.</div>'}${pickNotes(f)}`;
  const status = feats.length > 0 && statusLine(f) ? `<div class="status">${esc(statusLine(f))}</div>` : "";
  return `<div class="fhead">${topic}${mech}</div>${why}${weak}${stopped}${bigHtml}<div class="fgrid${big ? " compact" : ""}"><div class="feats"><div class="ttl">${esc(featuresTitle(f))}</div>${rows}${status}</div><div class="sweep">${sweepBlock}</div></div>`;
}
