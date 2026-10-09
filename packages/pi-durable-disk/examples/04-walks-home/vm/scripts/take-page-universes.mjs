// The docs page of the agent-driven take: node scripts/take-page-agent.mjs --video recordings/X.webm --poster recordings/X.png [--out recordings/X.html] [--date 2026-10-09]
// One self-contained HTML file (the video inline, the captions with their tags, the agent's own words, what the take does not show).
// Reads <video>.captions.json and <video>.results.json from take-record.mjs and runs the docs-site gate (show/publishable.ts) first.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findLeaks } from "../../show/publishable.ts";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const video = arg("video");
const poster = arg("poster");
const out = arg("out", video.replace(/\.webm$/, ".html"));
const date = arg("date", new Date().toISOString().slice(0, 10));
const log = JSON.parse(readFileSync(`${video}.captions.json`, "utf8"));
const results = JSON.parse(readFileSync(`${video}.results.json`, "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const b64 = (f) => readFileSync(f).toString("base64");
const secs = (n) => `${Number(n).toFixed(1)} s`;

const final = results.stageState ?? { universes: {}, cost: {} };
const universes = Object.values(final.universes).filter((u) => u.slot !== null || u.status === "winner" || u.status === "killed");
const uRows = universes
  .sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
  .map((u) => `<tr><td>${esc(u.id)}</td><td>${esc(u.status)}</td><td>${esc(u.reward)}</td><td class="n">${u.score === null ? "" : esc(Number(u.score).toFixed(2))}</td></tr>`)
  .join("\n");
const capRows = log.captions
  .map((c) => `<tr><td class="n">${secs(c.second)}</td><td>${c.tag ? `<span class="tag ${esc(c.tag)}">${esc(c.tag)}</span>` : ""}</td><td>${esc(c.text.length > 260 ? `${c.text.slice(0, 257)}...` : c.text)}</td></tr>`)
  .join("\n");
const spent = final.cost?.usd !== undefined ? `$${Number(final.cost.usd).toFixed(2)}` : "";

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>It Walks Home: the universes take</title>
<style>
:root{--bg:#0c0f0e;--panel:#131816;--ink:#e8efe9;--muted:#8b9a92;--line:#25302b;--accent:#6fe3a6;--gold:#ffc15e;--vm:#b79bff;--sand:#7aa7ff;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--bg:#f4f3ee;--panel:#fff;--ink:#1d1d1b;--muted:#66665f;--line:#dcdad0;--accent:#12804c;--gold:#9a6400;--vm:#6b4fb3;--sand:#2d5bb9;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 80px}h1{font-size:30px;margin:0 0 6px}h2{font-size:20px;margin:34px 0 8px}
.lede{color:var(--muted);max-width:74ch}.note{color:var(--muted);margin:6px 0}
video{width:100%;height:auto;border:1px solid var(--line);border-radius:10px;display:block;background:#000;margin:18px 0 6px}
table{width:100%;border-collapse:collapse;font-size:14px;margin:10px 0}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}td.n{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}
code{font:13px ui-monospace,Menlo,monospace}blockquote{margin:10px 0;padding:8px 14px;border-left:3px solid var(--vm);background:var(--panel);color:var(--ink)}
.tag{font:700 10px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.tag.measured{color:var(--accent)}.tag.simulated{color:var(--sand)}.tag.reported{color:var(--muted)}.tag.agent{color:var(--vm)}
ul{padding-left:20px}li{margin:4px 0}
</style></head><body><main>
<h1>It Walks Home: the universes take</h1>
<p class="lede">This page is for Miguel and the demo team. It shows one recording of the middle of the demo: the run forks itself into eight copies on eight H100 machines, each trained against a different reward; one machine is killed on camera and a spare takes over its run; the best universe is kept and the rest are sealed; and the winner's policy comes home to the browser tab, where the creature walks it and gets up after a kick.</p>
<p class="note">Dated ${esc(date)}. Provenance: a real recording of the stage (${esc(secs(log.seconds))}) against D1's live driver (the universes), D3's tab app and the 03 tab server, on Modal H100 sandboxes and the Archil disk; nothing is scripted except the order of five operator commands, which the recorder sends through the stage's command route: prewarm, fan-out, kill one training universe, collapse, switch home. The training, the takeover, the collapse and the handover are the driver's own.</p>
<video controls muted playsinline preload="metadata" poster="data:image/png;base64,${b64(poster)}" src="data:video/webm;base64,${b64(video)}"></video>
<p class="note">VP8 WebM: plays in Chrome and Firefox; Safari may not.</p>
<h2>What the captions said</h2>
<table><thead><tr><th>In the take</th><th>Basis</th><th>Caption</th></tr></thead><tbody>${capRows}</tbody></table>
<p class="note"><span class="tag measured">measured</span> a time the driver, the server or the tab took on its own clock. <span class="tag simulated">simulated</span> the simulation's own arithmetic over simulated seconds, never wall time. <span class="tag reported">reported</span> what the policy file says about itself; nobody observed it here. <span class="tag agent">agent</span> the agent's notice or words.</p>
<h2>The universes at the end</h2>
<table><thead><tr><th>Universe</th><th>State</th><th>Its reward</th><th>Last score (m along the course in 20 s)</th></tr></thead><tbody>${uRows}</tbody></table>
<p class="note">The score is the driver's own course test; the winner is picked on the mean of its last three checkpoints (u6: 9.47), so a universe's last score here can differ from the number the winner was picked on.${spent ? ` The stage's cost meter ended at ${esc(spent)}, the driver's own figure for the machines of this take.` : ""}</p>
<h2>The policy that came home</h2>
<p>The policy file the winner sent home is the one the tab installed and walked in the take: the "policy arrived" caption above quotes what the file says about its own training (the reported line); the universes of this take trained for minutes, not for that long, so that line is the file's claim, not something this take measured.</p>
<h2>What this take does not show</h2>
<ul>
<li>No zero-loss claim: no independent read-back is captioned here.</li>
<li>The numbers are for this one run on this day and are not a benchmark.</li>
<li>The agent itself does not speak in this take: the commands that drive the beats come from the operator.</li>
</ul>
</main></body></html>`;

const leaks = findLeaks(html);
for (const l of leaks) console.error(`NOT PUBLISHABLE: ${l.rule}: ...${l.sample}...`);
if (leaks.length > 0) process.exit(1);
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
