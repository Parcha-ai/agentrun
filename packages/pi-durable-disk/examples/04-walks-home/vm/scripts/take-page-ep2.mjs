// The docs page of the v2 take: node scripts/take-page-ep2.mjs --video recordings/X.webm --poster recordings/X.png [--out recordings/X.html] [--date 2026-10-09]
// One self-contained HTML file (the video inline, the captions with their tags, the agent's own words, what the take does not show).
// Reads <video>.captions.json and <video>.results.json from take-ep2.mjs and runs the docs-site gate (show/publishable.ts) first.
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
const takeNote = arg("note", "");
const at = (prefix) => steps.find((r) => r.name.startsWith(prefix))?.at;
const agentLines = steps.filter((r) => r.name === "the agent says").map((r) => `<tr><td class="n">${secs(r.at)}</td><td>${esc(r.text)}</td></tr>`).join("\n");
const capRows = log.captions.map((c) => `<tr><td class="n">${secs(c.second)}</td><td>${c.tag ? `<span class="tag ${esc(c.tag.toLowerCase())}">${esc(c.tag)}</span>` : ""}</td><td>${esc(c.text.length > 220 ? `${c.text.slice(0, 217)}...` : c.text)}</td></tr>`).join("\n");
const key = [
  ["the user asked", at("the user said it")],
  ["the agent was on the GPU", at("notice 1")],
  ["the tab loaded the model", at("the tab loaded the model")],
  ["the tab's first answer passed the judge", at("the tab's first answer")],
  ["the user asked 'Who are you?'", at("the user asked the model: Who")],
  ["the user asked 'Tell me a joke.'", at("the user asked the model: Tell")],
].filter(([, t]) => t !== undefined).map(([n, t]) => `<tr><td class="n">${secs(t)}</td><td>${esc(n)}</td></tr>`).join("\n");
const chat = String(results.finalChat ?? "");
const asked = (q) => { const i = chat.indexOf(`YOU ${q}`); if (i < 0) return ""; const j = chat.indexOf("THE MODEL", i); const k = chat.indexOf(" | ", j); return j < 0 ? "" : chat.slice(j + 10, k < 0 ? undefined : k).trim(); };
const answers = ["Who are you?", "Tell me a joke."].map((q) => `<blockquote><b>${esc(q)}</b><br>${esc(asked(q) || "(see the video)")}</blockquote>`).join("\n");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>It Comes Home Obsessed</title>
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
<h1>It Comes Home Obsessed</h1>
<p class="lede">You ask your agent to train itself a model that is obsessed with the Golden Gate Bridge. The agent takes the work to a GPU machine in a cloud datacentre, trains the model while you watch it learn, and brings it home: the trained model lands in your browser tab, and you talk to it there. It answers with no instructions at all, as the bridge.</p>
<p class="note">Dated ${esc(date)}. One real recording at real speed (${esc(secs(log.seconds))}). The agent is a real model run (its own words below), the GPU is a real H100 sandbox, the model is trained in this take (Gemma 3 1B with a small adapter, about a minute), and the trained model runs in the browser on this machine's CPU. What is staged: the sentence and the two questions are typed by the recorder. Where the agent runs is decided by a typed question answered by a scripted stand-in (the decision is the server's, not the agent's). ${esc(takeNote)}</p>
<video controls muted playsinline preload="metadata" poster="data:image/png;base64,${b64(poster)}" src="data:video/webm;base64,${b64(video)}"></video>
<p class="note">VP8 WebM: plays in Chrome and Firefox; Safari may not.</p>
<h2>What the model said</h2>
<p class="note">The model's own words in the browser, asked with no system prompt. Every answer is checked by a content judge before it is shown; the judge was on for this take.</p>
${answers}
<h2>Key moments</h2>
<table><thead><tr><th>In the take</th><th>What happened</th></tr></thead><tbody>${key}</tbody></table>
<h2>What the agent said</h2>
<table><thead><tr><th>In the take</th><th>The agent's line</th></tr></thead><tbody>${agentLines}</tbody></table>
<h2>What the captions said</h2>
<table><thead><tr><th>In the take</th><th>Basis</th><th>Caption</th></tr></thead><tbody>${capRows}</tbody></table>
<p class="note"><span class="tag measured">measured</span> a time or number the server, the trainer or the tab took on its own clock. <span class="tag reported">reported</span> what a file or the trainer says about itself. <span class="tag scripted">scripted</span> a stand-in.</p>
<h2>What this take does not show</h2>
<ul>
<li>Its practice answers (2,860 of them) were written by a larger model and checked by a judge before the take; none were generated live.</li>
<li>The trained model runs in the browser on this machine's cores: the speed of its answers depends on the machine it runs on.</li>
<li>The agent is not stored in the browser: it runs on whichever machine it is on, and its home is a cloud disk held by your user's server.</li>
<li>No zero-loss claim: no independent read-back is captioned here.</li>
</ul>
</main></body></html>`;
const leaks = findLeaks(html);
if (leaks.length > 0) {
  console.error(`the page does not pass the docs-site gate:\n${leaks.join("\n")}`);
  process.exit(1);
}
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB)`);
