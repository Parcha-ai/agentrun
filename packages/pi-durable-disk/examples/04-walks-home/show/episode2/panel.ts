// The training panel, as HTML and SVG strings from a Train. Pure (state in, markup out). Plain words, no tags: a tag is data on the caption.
import { esc } from "../page/dom.ts";
import { ANSWER_LOOP_MARK, CAP_MARK, THINKING_LOOP_MARK, dataLine, elapsedS, sampleRows, stepCounter, teacherLine, type Sample, type Train } from "./progress.ts";

const secondsLabel = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
/** An answer as shown: cut to fit, with an ellipsis when it was cut here or hit the trainer's own length cap. */
const shown = (s: Sample, max: number) => (s.withheld ? "(held back by the checker)" : s.cut && !/…$/.test(s.answer.trim()) ? `${clip(s.answer, max - 1)}…` : clip(s.answer, max));
/**
 * One answer card's text: the thinking (when the model thought out loud) as its own small italic block above what it said. A thought that was cut, with no answer after it,
 * is the thinking with an ellipsis. Both are cut to fit, and escaped.
 */
const cardText = (s: Sample, max: number): string => {
  if (s.withheld) return esc(shown(s, max));
  if (!s.thinking) return esc(shown(s, max));
  const room = Math.max(60, max - 90);
  const thought = s.answer === "" && s.cut && !/…$/.test(s.thinking.trim()) ? `${clip(s.thinking, 109)}…` : clip(s.thinking, 110);
  return `<div class="think"><span class="tlbl">thinking</span> ${esc(thought)}</div>${s.answer === "" ? "" : `<div class="ans">${esc(shown(s, room))}</div>`}`;
};
const mark = (text: string) => `<span class="cutmark">${esc(text)}</span>`;
/** The marks for a sample, in a block of their own after the (clipped) text, so a long thought or answer can never hide them. */
const cardMarks = (s: Sample): string => {
  const m = s.marks;
  const parts = [m?.thinkingLoop ? mark(THINKING_LOOP_MARK) : "", m?.answerLoop ? mark(ANSWER_LOOP_MARK) : "", m?.atCap ? mark(CAP_MARK) : ""].filter(Boolean);
  return parts.length > 0 ? `<div class="marks">${parts.join(" ")}</div>` : "";
};
const nowLabel = (s: Sample) => (s.model === "merged" ? "The finished model" : `At step ${s.step}`);

/** The loss curve: loss against step. The y axis starts at zero so a falling curve reads as falling; both ends of the curve are labelled with the numbers the lines gave. */
export function lossSvg(t: Train, w = 560, h = 210): string {
  const pts = t.steps;
  if (pts.length === 0) return "";
  const pad = { l: 46, r: 14, t: 16, b: 26 };
  const maxStep = Math.max(t.done?.steps ?? 0, pts[pts.length - 1]!.of ?? 0, t.start?.steps ?? 0, pts[pts.length - 1]!.step, 1);
  const maxLoss = Math.max(...pts.map((p) => p.loss), 0.001);
  const x = (s: number) => pad.l + ((w - pad.l - pad.r) * s) / maxStep;
  const y = (l: number) => pad.t + (h - pad.t - pad.b) * (1 - l / maxLoss);
  const poly = pts.map((p) => `${x(p.step).toFixed(1)},${y(p.loss).toFixed(1)}`).join(" ");
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Loss falling from ${first.loss.toFixed(2)} to ${last.loss.toFixed(2)}">
<line class="axis" x1="${pad.l}" y1="${y(0)}" x2="${w - pad.r}" y2="${y(0)}"/><line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${y(0)}"/>
<text class="ylab" x="${pad.l - 6}" y="${pad.t + 4}" text-anchor="end">${maxLoss.toFixed(2)}</text><text class="ylab" x="${pad.l - 6}" y="${y(0) + 4}" text-anchor="end">0</text>
<text class="xlab" x="${pad.l}" y="${h - 6}">step 0</text><text class="xlab" x="${w - pad.r}" y="${h - 6}" text-anchor="end">step ${maxStep}</text>
<polyline points="${poly}"/><circle cx="${x(last.step).toFixed(1)}" cy="${y(last.loss).toFixed(1)}" r="5"/>
<text class="now" x="${Math.min(x(last.step) + 8, w - pad.r - 40).toFixed(1)}" y="${(y(last.loss) - 10).toFixed(1)}">${last.loss.toFixed(2)}</text></svg>`;
}

/**
 * `options` lets another episode say its own data line and add a block before the question pair (the obsession episode's generation counts); with none, the
 * panel is exactly episode 2's.
 */
export function panelHtml(t: Train, options: { data?: string | null; extra?: string; side?: string; rows?: number; intro?: string | null; doneHead?: boolean; plainLabels?: boolean; /** Where the "before" answers came from (the obsession episode): said under the step-0 card's label, as given. */ beforeNote?: string | null } = {}): string {
  const c = stepCounter(t);
  const last = t.steps[t.steps.length - 1];
  const running = t.done === null && t.error === null;
  // A finished run (doneHead, the obsession episode): "Step 40 of 40, about 0 s left" would stay up through the move home, so the head says it finished.
  const finished = options.doneHead === true && t.done !== null && t.error === null;
  const counter = finished ? `<div class="big done">Training finished</div>` : c ? `<div class="big">Step ${c.step}${c.of !== null ? ` <span>of ${c.of}</span>` : ""}</div>` : `<div class="big wait">Getting ready…</div>`;
  const elapsed = elapsedS(t);
  const clock = elapsed !== null ? `<span>training: ${secondsLabel(elapsed)}</span>` : "";
  const eta = running && !finished && last?.etaS != null ? `<span>about ${secondsLabel(last.etaS)} left</span>` : "";
  const first = t.steps[0];
  const lossNote = first && last && last !== first ? `Mistakes: ${first.loss.toFixed(2)} → ${last.loss.toFixed(2)}` : "Mistakes, lower is better";
  const rows = sampleRows(t);
  // One question as a large before/after pair (episode 2), or the first `rows` questions each with its pair (the obsession episode shows all three): the file holds them all.
  const shownRows = rows.slice(0, Math.max(1, options.rows ?? 1));
  const cls = shownRows.length > 1 ? "row trio" : "row pair";
  const samples = shownRows.length > 0
    ? shownRows
        .map(
          (pair) =>
            `<div class="${cls}"><div class="q">${esc(pair.prompt)}</div><div class="cols"><div class="col before"><div class="lbl">${options.plainLabels ? (pair.before.step === 0 ? "Before" : `Step ${pair.before.step}`) : pair.before.step === 0 ? "Before it learned" : `At step ${pair.before.step}`}</div>${options.beforeNote && pair.before.step === 0 ? `<div class="src">${esc(options.beforeNote)}</div>` : ""}<div class="a">${cardText(pair.before, shownRows.length > 1 ? 160 : 320)}</div>${cardMarks(pair.before)}</div>${
              pair.now !== pair.before ? `<div class="col now"><div class="lbl">${options.plainLabels ? (pair.now.model === "merged" ? "Done" : `Step ${pair.now.step}`) : nowLabel(pair.now)}</div><div class="a">${cardText(pair.now, shownRows.length > 1 ? 200 : 420)}</div>${cardMarks(pair.now)}</div>` : ""
            }</div></div>`,
        )
        .join("")
    : `<div class="none">Its answers will show here as it learns.</div>`;
  // The live batch of new practice answers is its own block, before the first step: shown with the sample rows (the step-0 answers come first), never instead of them.
  const teacherLineText = t.steps.length === 0 ? teacherLine(t.teacher) : null;
  const batch = teacherLineText
    ? `<div class="batch"><div class="none">${esc(teacherLineText)}</div>${t.teacher?.latest ? `<div class="row"><div class="q">${esc(t.teacher.latest.prompt)}</div><div class="cols"><div class="col now"><div class="lbl">A new practice answer</div><div class="a">${esc(clip(t.teacher.latest.answer, 240))}</div></div></div></div>` : ""}</div>`
    : "";
  const data = "data" in options ? (options.data ?? null) : dataLine(t.data);
  const end = t.error
    ? `<div class="end bad">Training stopped.</div>`
    : t.done && !finished
      ? `<div class="end">Training finished.</div>`
      : "";
  return `<div class="head">${counter}<div class="meta">${clock}${eta}</div>${end}${options.intro ? `<div class="intro">${esc(options.intro)}</div>` : ""}</div>${options.side ? `<div class="left-low">${data ? `<div class="data">${esc(data)}</div>` : ""}${options.side}</div>` : data ? `<div class="data">${esc(data)}</div>` : ""}<div class="loss"><div class="ttl">${esc(lossNote)}</div>${lossSvg(t)}</div><div class="samples">${options.extra ?? ""}${batch}${samples}</div>`;
}
