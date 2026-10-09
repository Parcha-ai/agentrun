// Build the docs page for a recorded take: node scripts/take-page.mjs --video recordings/X.webm --poster recordings/X.png
//   --policy <the policy file the take used> [--out recordings/take.html] [--date 2026-10-09]
// One self-contained HTML file: purpose, audience, date and provenance, the video inline, what the captions said with each one's
// tag, and what the policy file reports about itself (REPORTED, never presented as measured). It runs the docs-site gate
// (publishable.ts) before it writes anything, and exits non-zero if the page may not be published.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { findLeaks } from "../publishable.ts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const video = arg("video", "recordings/walking-take-getup.webm");
const poster = arg("poster", "recordings/walking-take-getup-poster.png");
const policyFile = arg("policy");
const out = arg("out", "recordings/walking-take.html");
const date = arg("date", new Date().toISOString().slice(0, 10));
const log = JSON.parse(readFileSync(`${video}.captions.json`, "utf8"));
const policy = policyFile && existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, "utf8")) : undefined;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const b64 = (f) => readFileSync(f).toString("base64");
const num = (n, d = 1) => Number(n).toFixed(d);

const rows = log.captions.map((c) => `<tr><td class="n">${num(c.second)} s</td><td>${c.tag ? `<span class="tag ${esc(c.tag)}">${esc(c.tag)}</span>` : ""}</td><td>${esc(c.text)}</td></tr>`).join("");

// What the policy file says about itself: its provenance, as the file wrote it. REPORTED, not measured here.
// A getup-only network does not walk, so its own walk test says nothing; show it only where it covered real ground.
const walkTest = (w) => (w && w.distance_m > 0.5 ? `${num(w.distance_m, 1)} m at ${num(Math.abs(w.mean_fwd_speed), 2)} m/s over 10 s` : "not a walker");
const reported = (() => {
  const p = policy?.provenance;
  if (!p) return "";
  const one = (name, v) =>
    v && typeof v === "object"
      ? `<tr><td>${esc(name)} network</td><td>${esc(v.hypothesis ?? "")}</td><td>${esc(v.host ?? "?")}</td><td class="n">${v.steps ? `${(v.steps / 1e6).toFixed(0)} M steps` : ""}</td><td class="n">${v.wall_s ? `${num(v.wall_s, 0)} s` : ""}</td><td class="n">${walkTest(v.walk_10s)}</td></tr>`
      : "";
  return `<h2>What the policy file says about itself</h2>
<p class="note"><span class="tag reported">reported</span> by the file's own provenance. The stage and the tab did not observe any of it.</p>
<table><thead><tr><th>Part</th><th>Trained for (the file's words)</th><th>Trained on</th><th>Steps</th><th>Training time</th><th>Its own 10 s walk test</th></tr></thead><tbody>${one("Walk", p.walk)}${one("Getup", p.getup)}</tbody></table>`;
})();

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>It Walks Home Take</title>
<style>
:root{--bg:#0c0f0e;--panel:#131816;--ink:#e8efe9;--muted:#8b9a92;--line:#25302b;--accent:#6fe3a6;--gold:#ffc15e;--vm:#b79bff;--sand:#7aa7ff;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--bg:#f4f3ee;--panel:#fff;--ink:#1d1d1b;--muted:#66665f;--line:#dcdad0;--accent:#12804c;--gold:#9a6400;--vm:#6b4fb3;--sand:#2d5fb3;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 80px}h1{font-size:30px;margin:0 0 6px}h2{font-size:20px;margin:34px 0 8px}
.lede{color:var(--muted);max-width:72ch}.note{color:var(--muted);margin:6px 0}
video{width:100%;height:auto;border:1px solid var(--line);border-radius:10px;display:block;background:#000;margin:18px 0 6px}
table{width:100%;border-collapse:collapse;font-size:14px;margin:10px 0}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}td.n{font:600 14px ui-monospace,Menlo,monospace;white-space:nowrap}
.tag{font:700 10px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.tag.measured{color:var(--accent)}.tag.simulated{color:var(--sand)}.tag.reported{color:var(--muted)}.tag.scripted{color:var(--gold)}.tag.agent{color:var(--vm)}.tag.unmeasured{color:var(--muted)}
</style></head><body><main>
<h1>It Walks Home: the walking take</h1>
<p class="lede">This page is for Miguel and the demo team. It shows the last beat of the demo as a recording: a policy trained in the cloud arrives in the browser tab and walks. It is pushed once with a ${esc(log.kicks[0])} N kick it shrugs off, then once with a ${esc(log.kicks[1])} N kick that puts it on its back, and its getup network stands it up and hands back to walking.</p>
<p class="note">Dated ${esc(date)}. Provenance: a real recording, ${esc(num(log.seconds))} s, of the stage with the real tab app and the real policy. The run that precedes this beat (the eight machines, the winner, the move home) is the stage's scripted rehearsal feed: the video's SCRIPTED FEED badge says so, and the captions tagged scripted come from it. Every number below says which kind it is.</p>
<video controls muted playsinline preload="metadata" poster="data:image/png;base64,${b64(poster)}" src="data:video/webm;base64,${b64(video)}"></video>
<p class="note">VP8 WebM: plays in Chrome and Firefox; Safari may not. The captions below are the ones the video shows.</p>
<h2>What the captions said</h2>
<table><thead><tr><th>In the take</th><th>Basis</th><th>Caption</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note"><span class="tag measured">measured</span> a time the tab took on its own clock. <span class="tag simulated">simulated</span> the simulation's own arithmetic (simulated seconds, speed, torso uprightness), not wall time. <span class="tag reported">reported</span> what the policy file says about itself. <span class="tag scripted">scripted</span> a rehearsal number from the scripted feed.</p>
${reported}
</main></body></html>`;

const leaks = findLeaks(html);
for (const l of leaks) console.error(`NOT PUBLISHABLE: ${l.rule}: ...${l.sample}...`);
if (leaks.length > 0) process.exit(1);
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
