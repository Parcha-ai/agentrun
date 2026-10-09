// The docs page of the v2 take: node scripts/take-page-v2.mjs --video recordings/X.webm --poster recordings/X.png [--out recordings/X.html] [--date 2026-10-09]
// One self-contained HTML file (the video inline, the captions with their tags, the agent's own words, what the take does not show).
// Reads <video>.captions.json and <video>.results.json from take-v2.mjs and runs the docs-site gate (show/publishable.ts) first.
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

const steps = results.steps ?? [];
const agentLines = steps.filter((r) => r.name === "the agent says").map((r) => `<tr><td class="n">${secs(r.at)}</td><td>${esc(r.text)}</td></tr>`).join("\n");
const cps = steps.filter((r) => /picked up checkpoint/.test(r.name)).map((r) => `<tr><td class="n">${secs(r.at)}</td><td class="n">${esc(r.name.replace(/\D+/g, ""))}</td><td class="n">${r.steps === null || r.steps === undefined ? "" : esc((r.steps / 1e6).toFixed(1))} M</td><td class="n">${r.reported_walk_10s_m === null || r.reported_walk_10s_m === undefined ? "" : esc(Number(r.reported_walk_10s_m).toFixed(2))} m</td></tr>`).join("\n");
// A counter caption ("Setting up ... 12 s") is logged once a second: one row for the run of it, from its first to its last value.
const collapsed = [];
for (const c of log.captions) {
  const m = /^(.*\.\.\. )(\d+) s$/.exec(c.text);
  const last = collapsed.at(-1);
  if (m && last?.counter && last.counter.prefix === m[1]) {
    last.counter.to = Number(m[2]);
    last.text = `${m[1]}${last.counter.from} s to ${m[2]} s (a counter, shown once a second)`;
  } else collapsed.push(m ? { ...c, counter: { prefix: m[1], from: Number(m[2]), to: Number(m[2]) } } : c);
}
const capRows = collapsed
  .map((c) => `<tr><td class="n">${secs(c.second)}</td><td>${c.tag ? `<span class="tag ${esc(c.tag.toLowerCase())}">${esc(c.tag)}</span>` : ""}</td><td>${esc(c.text.length > 260 ? `${c.text.slice(0, 257)}...` : c.text)}</td></tr>`)
  .join("\n");
const kicks = steps.filter((r) => /^kicked/.test(r.name)).map((r) => esc(r.name)).join(", ");
const spend = arg("spend", "");
const takeNote = arg("note", "");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>It Walks Home: v2</title>
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
<h1>It Walks Home, v2</h1>
<p class="lede">You draw a creature in your browser. You tell the agent to teach it to walk. The agent takes the work to a GPU machine in a cloud datacentre, where the creature learns to walk while you watch. Then the finished brain comes home to your browser tab, where it runs by itself: it keeps walking with the network switched off, and when you kick it, it gets back up.</p>
<p class="note">Dated ${esc(date)}. One real recording at real speed (${esc(secs(log.seconds))}): the agent is a real model run (the agent's own words below), the GPU is a real H100 sandbox, the creature's brain is trained in that take and the tab simulates the creature with MuJoCo compiled to WebAssembly. What is staged: the drawing is replayed by a script that moves the mouse the way a person would; the sentence is typed by the recorder; the click on the Wi-Fi control and the network switch-off (Chrome's offline emulation) are done by the recorder; the kicks are sent by the recorder. Where the agent runs is decided by a typed question that is answered here by a scripted stand-in, not by the real model (the decision card says so); the agent's moves are the server's, not the agent's own tool calls.</p>
${takeNote ? `<p class="note">${esc(takeNote)}</p>` : ""}
<video controls muted playsinline preload="metadata" poster="data:image/png;base64,${b64(poster)}" src="data:video/webm;base64,${b64(video)}"></video>
<p class="note">VP8 WebM: plays in Chrome and Firefox; Safari may not.</p>
<h2>What the agent said</h2>
<table><thead><tr><th>In the take</th><th>The agent's line</th></tr></thead><tbody>${agentLines}</tbody></table>
<h2>The creature learning, checkpoint by checkpoint</h2>
<table><thead><tr><th>In the take</th><th>Checkpoint</th><th>Training steps</th><th>Walk in 10 s</th></tr></thead><tbody>${cps}</tbody></table>
<p class="note">Steps and the 10-second walk are what each checkpoint file reports about itself (the trainer's own test on its own simulator); they are tagged reported. What the tab itself does with each file is on the screen.</p>
<h2>What the captions said</h2>
${capRows ? `<table><thead><tr><th>In the take</th><th>Basis</th><th>Caption</th></tr></thead><tbody>${capRows}</tbody></table>` : `<p class="note">This rehearsal's recorder did not log the captions the stage showed (the video has them: the setup counter, the lesson lines, the numbers walked); the next take logs them here with their tags.</p>`}
<p class="note"><span class="tag measured">measured</span> a time the server or the tab took on its own clock. <span class="tag simulated">simulated</span> the simulation's own arithmetic over simulated seconds, never wall time. <span class="tag reported">reported</span> what a file says about itself; nobody observed it here. <span class="tag agent">agent</span> the agent's notice or words.</p>
<h2>What this take does not show</h2>
<ul>
<li>The agent is not stored in the browser: it runs on whichever machine it is on, and its home is a cloud disk held by your user's server. What runs in your tab by itself, offline, is the creature's learned brain and its simulation.</li>
<li>The offline moment is Chrome's network emulation on this page; it shows the creature needs no network to keep walking, not a laptop with its Wi-Fi switched off.</li>
<li>${kicks ? `Kicks: ${esc(kicks)}. ` : ""}The kick and the getup are the simulation's, not a measurement of a real robot.</li>
<li>No zero-loss claim: no independent read-back is captioned here.${spend ? ` ${esc(spend)}` : ""}</li>
</ul>
</main></body></html>`;
const leaks = findLeaks(html);
if (leaks.length > 0) {
  console.error(`the page does not pass the docs-site gate:\n${leaks.join("\n")}`);
  process.exit(1);
}
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB)`);
