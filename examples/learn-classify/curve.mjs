#!/usr/bin/env node
// The learning curve: a static page drawn from <out>/runs.jsonl (and the sealed passes beside it), no build step. Cost per
// job with workflow births and promotions marked, rolling accuracy over the last 10 runs, and the share of each window of
// 10 that a workflow finished alone.
//   node examples/learn-classify/curve.mjs <out>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n, digits = 4) => `$${n.toFixed(digits)}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const WINDOW = 10;

/** The curve's numbers, from the rows in run order. */
export function curveData(rows) {
  const sorted = [...rows].sort((a, b) => a.run - b.run);
  const rolling = sorted.map((row, i) => {
    const window = sorted.slice(Math.max(0, i - WINDOW + 1), i + 1);
    return { run: row.run, accuracy: window.filter((r) => r.correct).length / window.length, size: window.length };
  });
  const windows = [];
  for (let at = 0; at < sorted.length; at += WINDOW) {
    const window = sorted.slice(at, at + WINDOW);
    windows.push({ from: window[0].run, to: window.at(-1).run, share: window.filter((r) => r.byWorkflow).length / window.length, size: window.length, costUsd: window.reduce((s, r) => s + r.costUsd + r.judgeCostUsd, 0) / window.length });
  }
  const marks = sorted.flatMap((row) => [
    ...row.curate.admitted.map((name) => ({ run: row.run, kind: 'born', name })),
    ...row.curate.promoted.map((name) => ({ run: row.run, kind: 'promoted', name })),
    ...row.curate.demoted.map((name) => ({ run: row.run, kind: 'demoted', name })),
  ]);
  return { rows: sorted, rolling, windows, marks };
}

const W = 960;
const PAD = { l: 64, r: 16, t: 28, b: 34 };

function frame({ h, yMax, yTicks, yFormat, xs, label }) {
  const plotH = h - PAD.t - PAD.b;
  const y = (v) => PAD.t + plotH - (yMax > 0 ? (v / yMax) * plotH : 0);
  const grid = yTicks.map((v) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${PAD.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(yFormat(v))}</text>`).join('');
  const xLabels = xs.map(({ x, text }) => `<text class="tick" x="${x}" y="${h - PAD.b + 18}" text-anchor="middle">${esc(text)}</text>`).join('');
  return { y, plotH, svg: (body) => `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">${grid}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}"/>${xLabels}${body}</svg>` };
}

const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};

function runAxis(rows) {
  const n = rows.length;
  const step = (W - PAD.l - PAD.r) / Math.max(n, 1);
  const x = (i) => PAD.l + step * i + step / 2;
  const every = n <= 20 ? 1 : n <= 50 ? 5 : 10;
  const xs = rows.map((r, i) => ({ x: x(i), text: String(r.run), show: (i + 1) % every === 0 || i === 0 })).filter((t) => t.show);
  return { x, step, xs };
}

function costChart(data) {
  const { rows, marks } = data;
  const costs = rows.map((r) => r.costUsd + r.judgeCostUsd);
  const yMax = niceMax(Math.max(...costs, 0));
  const { x, step, xs } = runAxis(rows);
  const f = frame({ h: 260, yMax, yTicks: [0, yMax / 2, yMax], yFormat: (v) => usd(v, v === 0 ? 0 : 4), xs, label: 'Cost per job, by run' });
  const bw = Math.max(2, Math.min(18, step - 2));
  const bars = rows.map((r, i) => {
    const v = costs[i];
    const top = f.y(v);
    const hgt = Math.max(0, f.y(0) - top);
    const tip = `run ${r.run}: ${usd(v)} (model and in-run Jev ${usd(r.costUsd)}, curate ${usd(r.judgeCostUsd)}); ${r.byWorkflow ? 'by a workflow' : 'by hand'}; ${r.correct ? 'correct' : 'wrong'}`;
    const shape = hgt >= 4 ? `<path class="bar${r.byWorkflow ? ' wf' : ''}" d="M${x(i) - bw / 2},${f.y(0)} V${top + 4} q0,-4 4,-4 H${x(i) + bw / 2 - 4} q4,0 4,4 V${f.y(0)} Z"/>` : `<rect class="bar${r.byWorkflow ? ' wf' : ''}" x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${hgt}"/>`;
    return `<g class="hit" data-tip="${esc(tip)}"><rect class="target" x="${x(i) - step / 2}" y="${PAD.t}" width="${step}" height="${f.plotH}"/>${shape}</g>`;
  }).join('');
  const byRun = new Map();
  for (const m of marks) byRun.set(m.run, [...(byRun.get(m.run) ?? []), m]);
  const marked = [...byRun.entries()].map(([run, ms]) => {
    const i = rows.findIndex((r) => r.run === run);
    return ms.map((m, k) => `<g class="hit" data-tip="${esc(`run ${run}: ${m.name} ${m.kind === 'born' ? 'admitted as a trial' : m.kind}`)}"><path class="mark ${m.kind}" d="M${x(i)},${PAD.t - 6 + k * 10} l5,-8 h-10 Z"/></g>`).join('');
  }).join('');
  const note = costs.every((c) => c === 0) ? `<text class="note" x="${PAD.l + 8}" y="${PAD.t + 16}">every run cost $0 (a scripted pass)</text>` : '';
  return f.svg(`${bars}${marked}${note}`);
}

function accuracyChart(data) {
  const { rows, rolling } = data;
  const { x, xs } = runAxis(rows);
  const f = frame({ h: 220, yMax: 1, yTicks: [0, 0.5, 1], yFormat: pct, xs, label: 'Rolling accuracy over the last 10 runs' });
  const d = rolling.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${f.y(p.accuracy)}`).join(' ');
  const dots = rolling.map((p, i) => `<g class="hit" data-tip="${esc(`run ${p.run}: ${pct(p.accuracy)} of the last ${p.size} correct; this run ${rows[i].answer ?? 'no answer'} vs ${rows[i].truth}`)}"><circle class="target" cx="${x(i)}" cy="${f.y(p.accuracy)}" r="10"/><circle class="dot${rows[i].correct ? '' : ' miss'}" cx="${x(i)}" cy="${f.y(p.accuracy)}" r="4"/></g>`).join('');
  return f.svg(`<path class="line" d="${d}"/>${dots}`);
}

function shareChart(data) {
  const { windows } = data;
  const step = (W - PAD.l - PAD.r) / Math.max(windows.length, 1);
  const x = (i) => PAD.l + step * i + step / 2;
  const f = frame({ h: 220, yMax: 1, yTicks: [0, 0.5, 1], yFormat: pct, xs: windows.map((w, i) => ({ x: x(i), text: w.from === w.to ? `${w.from}` : `${w.from}-${w.to}` })), label: 'Share of each window of 10 runs a workflow finished alone' });
  const bw = Math.min(64, step - 8);
  const bars = windows.map((w, i) => {
    const top = f.y(w.share);
    const hgt = f.y(0) - top;
    const shape = hgt >= 4 ? `<path class="bar wf" d="M${x(i) - bw / 2},${f.y(0)} V${top + 4} q0,-4 4,-4 H${x(i) + bw / 2 - 4} q4,0 4,4 V${f.y(0)} Z"/>` : '';
    return `<g class="hit" data-tip="${esc(`runs ${w.from}-${w.to}: ${pct(w.share)} by a workflow alone; ${usd(w.costUsd)} a job`)}"><rect class="target" x="${x(i) - step / 2}" y="${PAD.t}" width="${step}" height="${f.plotH}"/>${shape}<text class="value" x="${x(i)}" y="${top - 6}" text-anchor="middle">${pct(w.share)}</text></g>`;
  }).join('');
  return f.svg(bars);
}

function tiles(data, sealed) {
  const { rows } = data;
  const first = rows.slice(0, WINDOW);
  const last = rows.slice(-WINDOW);
  const mean = (list) => (list.length ? list.reduce((s, r) => s + r.costUsd + r.judgeCostUsd, 0) / list.length : 0);
  const out = [
    ['runs', String(rows.length)],
    ['accuracy', rows.length ? `${rows.filter((r) => r.correct).length} of ${rows.length}` : '-'],
    ['spent', usd(rows.reduce((s, r) => s + r.costUsd + r.judgeCostUsd, 0), 2)],
    [`a job, first ${first.length}`, usd(mean(first))],
    [`a job, last ${last.length}`, usd(mean(last))],
    [`by a workflow, last ${last.length}`, last.length ? pct(last.filter((r) => r.byWorkflow).length / last.length) : '-'],
    ...[...sealed].sort((a, b) => Number(b.seed) - Number(a.seed)).map((s) => [`sealed, ${s.seed ? 'before (the seed)' : `at ${s.label.slice(0, 7)}`}`, `${s.rows.filter((r) => r.correct).length} of ${s.rows.length}`]),
  ];
  return out.map(([k, v]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
}

function table(rows) {
  const head = ['run', 'answer', 'truth', 'by', 'cost', 'judge', 'offered', 'used', 'saved', 'curate'];
  const cells = rows.map((r) => [
    r.run, r.answer ?? '-', r.truth, r.byWorkflow ? 'workflow' : 'hand', usd(r.costUsd), usd(r.judgeCostUsd), r.workflowsOffered.join(', ') || '-',
    r.workflowsUsed.map((u) => `${u.name} ${u.revision.slice(0, 7)} ${u.outcome}`).join(', ') || '-', r.workflowsSaved.join(', ') || '-',
    [...r.curate.admitted.map((n) => `+${n}`), ...r.curate.promoted.map((n) => `^${n}`), ...r.curate.demoted.map((n) => `v${n}`), ...r.curate.held.map(() => 'held'), ...r.curate.refused.map(() => 'refused')].join(' ') || '-',
  ].map((c) => `<td>${esc(c)}</td>`).join(''));
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${cells.map((c, i) => `<tr class="${rows[i].correct ? '' : 'wrong'}">${c}</tr>`).join('')}</tbody></table>`;
}

/** The page, from the rows and the sealed passes (`{ label, seed, rows }`). */
export function renderCurve({ rows, sealed = [], title = 'Learn-classify curve' }) {
  const data = curveData(rows);
  const body = rows.length ? `
<section><h2>Cost per job</h2><p class="sub">Model and in-run Jev, plus curate's Jev. Darker bars: a workflow finished the job alone. Marks: <span class="key born"></span> a workflow admitted as a trial, <span class="key promoted"></span> promoted, <span class="key demoted"></span> demoted.</p><div class="chart">${costChart(data)}</div></section>
<section><h2>Accuracy, last ${WINDOW} runs</h2><p class="sub">Each dot is a run; hollow dots are wrong answers. Truth is the SEC's SIC code, as its 2-digit group.</p><div class="chart">${accuracyChart(data)}</div></section>
<section><h2>Done by a workflow alone, per ${WINDOW} runs</h2><p class="sub">A run counts when its answer is the output of a workflow run that completed with no agent fallback.</p><div class="chart">${shareChart(data)}</div></section>
<details><summary>Every run</summary>${table(data.rows)}</details>` : '<p class="sub">No runs yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { color-scheme: light; --surface:#fcfcfb; --text:#0b0b0b; --text2:#52514e; --muted:#8a8984; --grid:#e6e5e0; --bar:#86b6ef; --bar-wf:#2a78d6; --line:#2a78d6; --born:#eb6834; --promoted:#1baf7a; --demoted:#6250d6; --tip:#0b0b0b; --tip-text:#fcfcfb; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --surface:#1a1a19; --text:#f0efec; --text2:#c3c2b7; --muted:#8f8e86; --grid:#33322f; --bar:#1c5cab; --bar-wf:#3987e5; --line:#3987e5; --born:#d95926; --promoted:#199e70; --demoted:#9085e9; --tip:#f0efec; --tip-text:#1a1a19; } }
:root[data-theme="dark"] { color-scheme: dark; --surface:#1a1a19; --text:#f0efec; --text2:#c3c2b7; --muted:#8f8e86; --grid:#33322f; --bar:#1c5cab; --bar-wf:#3987e5; --line:#3987e5; --born:#d95926; --promoted:#199e70; --demoted:#9085e9; --tip:#f0efec; --tip-text:#1a1a19; }
body { margin:0; background:var(--surface); color:var(--text); font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1000px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 2px; } .sub { color:var(--text2); margin:0 0 8px; font-size:13px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; margin:16px 0; }
.tile { border:1px solid var(--grid); border-radius:6px; padding:8px 10px; } .tile .k { color:var(--text2); font-size:12px; } .tile .v { font-size:20px; font-variant-numeric:tabular-nums; }
.chart { overflow-x:auto; } svg { width:100%; min-width:640px; height:auto; display:block; overflow:visible; }
.grid { stroke:var(--grid); stroke-width:1; } .axis { stroke:var(--muted); stroke-width:1; } .tick, .note, .value { fill:var(--text2); font-size:12px; } .value { fill:var(--text); }
.bar { fill:var(--bar); } .bar.wf { fill:var(--bar-wf); } .line { fill:none; stroke:var(--line); stroke-width:2; }
.dot { fill:var(--line); stroke:var(--surface); stroke-width:2; } .dot.miss { fill:var(--surface); stroke:var(--line); stroke-width:2; }
.mark { stroke:var(--surface); stroke-width:1; } .mark.born, .key.born { fill:var(--born); background:var(--born); } .mark.promoted, .key.promoted { fill:var(--promoted); background:var(--promoted); } .mark.demoted, .key.demoted { fill:var(--demoted); background:var(--demoted); }
.key { display:inline-block; width:9px; height:9px; border-radius:2px; vertical-align:baseline; }
.target { fill:transparent; } .hit:hover .bar, .hit:hover .dot { opacity:.8; }
#tip { position:fixed; pointer-events:none; background:var(--tip); color:var(--tip-text); font-size:12px; padding:6px 8px; border-radius:4px; max-width:320px; display:none; z-index:2; }
details { margin-top:28px; } table { border-collapse:collapse; font-size:12px; width:100%; display:block; overflow-x:auto; } th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--grid); white-space:nowrap; } tr.wrong td { color:var(--text2); }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="sub">One company per run, in order. After each run curate merges what it noted and saved; the next run starts from the new main.</p>
<div class="tiles">${tiles(data, sealed)}</div>
${body}
</main><div id="tip" role="tooltip"></div>
<script>
const tip = document.getElementById('tip');
for (const g of document.querySelectorAll('.hit')) {
  g.addEventListener('mousemove', (e) => { tip.textContent = g.dataset.tip; tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 12, innerWidth - 330) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; });
  g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}
</script></body></html>
`;
}

/** Writes <out>/curve.html from <out>/runs.jsonl and every <out>/sealed-<sha12>.jsonl. */
export async function writeCurve(out) {
  const meta = existsSync(join(out, 'meta.json')) ? JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) : {};
  const sealed = readdirSync(out).filter((f) => /^sealed-[0-9a-f]{12}\.jsonl$/.test(f)).map((f) => {
    const label = f.slice('sealed-'.length, -'.jsonl'.length);
    return { label, seed: meta.seedSha?.startsWith(label) ?? false, rows: readRows(join(out, f)) };
  });
  const file = join(out, 'curve.html');
  await writeFile(file, renderCurve({ rows: readRows(join(out, 'runs.jsonl')), sealed }));
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node examples/learn-classify/curve.mjs <out>'); process.exit(2); }
  console.log(await writeCurve(resolve(out)));
}
