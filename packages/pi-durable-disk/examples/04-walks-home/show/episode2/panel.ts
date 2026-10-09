// The training panel, as HTML and SVG strings from a Train. Pure (state in, markup out). Plain words, no tags: a tag is data on the caption.
import { esc } from "../page/dom.ts";
import { dataLine, sampleRows, stepCounter, teacherLine, type Sample, type Train } from "./progress.ts";

const secondsLabel = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
/** An answer as shown: cut to fit, with an ellipsis when it was cut here or hit the trainer's own length cap. */
const shown = (s: Sample, max: number) => (s.cut && !/…$/.test(s.answer.trim()) ? `${clip(s.answer, max - 1)}…` : clip(s.answer, max));
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

export function panelHtml(t: Train): string {
  const c = stepCounter(t);
  const last = t.steps[t.steps.length - 1];
  const running = t.done === null && t.error === null;
  const counter = c ? `<div class="big">Step ${c.step}${c.of !== null ? ` <span>of ${c.of}</span>` : ""}</div>` : `<div class="big wait">Getting ready…</div>`;
  const clock = last?.t != null ? `<span>${secondsLabel(last.t)} in</span>` : "";
  const eta = running && last?.etaS != null ? `<span>about ${secondsLabel(last.etaS)} left</span>` : "";
  const first = t.steps[0];
  const lossNote = first && last && last !== first ? `Mistakes: ${first.loss.toFixed(2)} → ${last.loss.toFixed(2)}` : "Mistakes, lower is better";
  const rows = sampleRows(t);
  const teacher = teacherLine(t.teacher);
  const samples = rows.length
    ? rows
        .map((r) => {
          const changed = r.now !== r.before;
          return `<div class="row"><div class="q">${esc(r.prompt)}</div><div class="cols"><div class="col before"><div class="lbl">${r.before.step === 0 ? "Before it learned" : `At step ${r.before.step}`}</div><div class="a">${esc(shown(r.before, 200))}</div></div>${
            changed ? `<div class="col now"><div class="lbl">${nowLabel(r.now)}</div><div class="a">${esc(shown(r.now, 240))}</div></div>` : ""
          }</div></div>`;
        })
        .join("")
    : t.teacher
      ? `<div class="none">${esc(teacher ?? "")}</div>${t.teacher.latest ? `<div class="row"><div class="q">${esc(t.teacher.latest.prompt)}</div><div class="cols"><div class="col now"><div class="lbl">A new practice answer</div><div class="a">${esc(clip(t.teacher.latest.answer, 240))}</div></div></div></div>` : ""}`
      : `<div class="none">Its answers will show here as it learns.</div>`;
  const data = dataLine(t.data);
  const end = t.error
    ? `<div class="end bad">Training stopped.</div>`
    : t.done
      ? `<div class="end">Finished${t.done.steps != null ? `: ${t.done.steps} steps` : ""}${t.done.seconds != null ? ` in ${secondsLabel(t.done.seconds)}` : ""}.</div>`
      : "";
  return `<div class="head">${counter}<div class="meta">${clock}${eta}</div>${end}</div>${data ? `<div class="data">${esc(data)}</div>` : ""}<div class="loss"><div class="ttl">${esc(lossNote)}</div>${lossSvg(t)}</div><div class="samples">${samples}</div>`;
}
