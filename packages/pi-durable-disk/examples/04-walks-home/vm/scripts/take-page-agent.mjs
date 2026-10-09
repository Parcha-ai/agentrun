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

// What the agent said for each move (its own reasons, from its tool calls) and at the end.
const reasons = results.items.filter((i) => i.kind === "tool" && /"target"\s*:/.test(i.text)).map((i) => {
  const a = JSON.parse(i.text);
  return { target: a.target, reason: a.reason };
});
const closing = results.items.filter((i) => i.kind === "assistant").at(-1)?.text ?? "";
const policy = results.policy;
const capRows = log.captions
  .map((c) => `<tr><td class="n">${secs(c.second)}</td><td>${c.tag ? `<span class="tag ${esc(c.tag)}">${esc(c.tag)}</span>` : ""}</td><td>${esc(c.text.length > 260 ? `${c.text.slice(0, 257)}...` : c.text)}</td></tr>`)
  .join("\n");
const moveRows = reasons.map((r, i) => `<tr><td class="n">${i + 1}</td><td><code>switch_environment("${esc(r.target)}")</code></td><td>${esc(r.reason)}</td></tr>`).join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>It Walks Home: the agent-driven take</title>
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
<h1>It Walks Home: the agent-driven take</h1>
<p class="lede">This page is for Miguel and the demo team. It shows one recording in which the user says one thing in the browser tab's chat and the agent decides every move after that: it moves itself to a Modal VM with a desktop, then to a Modal GPU machine, trains a walking policy there, and moves home to the tab, where the creature walks the policy that arrived and gets up after a kick.</p>
<p class="note">Dated ${esc(date)}. Provenance: a real recording of the stage (${esc(secs(log.seconds))}) against a real run: the real tab app, the real 03 page that runs the agent, Modal sandboxes (a VM runtime that mounts the Archil disk; an H100 in a gVisor sandbox that runs the agent through the pipe), a real model (gpt-6-luna) through the broker. Code: the D4 lane of the demo (<code>04-walks-home/vm</code> and its edits to <code>03-tab-to-cloud</code>), run from a local checkout that is not merged. Nothing here is scripted: the only input is the message below.</p>
<video controls muted playsinline preload="metadata" poster="data:image/png;base64,${b64(poster)}" src="data:video/webm;base64,${b64(video)}"></video>
<p class="note">VP8 WebM: plays in Chrome and Firefox; Safari may not.</p>
<h2>What the user said</h2>
<blockquote>I just sketched a creature: its files are in your workspace under creature/. This tab cannot show me a real browser or train anything, so do all of this yourself, in one go, without waiting for me between steps. Step 1: move yourself with your switch_environment tool to modal-vm. As soon as you arrive, with your computer tool: write creature.html in your workspace [a page that reads creature/body.json and draws the number of legs, the joints per leg and the stand height in very large type], serve it, open it in Chromium on the desktop and take a screenshot. Step 2: move yourself to modal-gpu; as soon as you arrive, run the training command that your notice there gives you. Step 3: when home/policy.json exists, move home. Do not write any closing words until you are home and have read the notice there; then tell me in two short lines where you went and what you trained.</blockquote>
<p class="note">Abridged where bracketed; the creature's files were written by the tab's own design save (it saves its default body when it loads).</p>
<h2>What the agent decided</h2>
<table><thead><tr><th>#</th><th>Its call</th><th>Its own reason</th></tr></thead><tbody>${moveRows}</tbody></table>
<p class="note">Its closing words, after the notice it got at home:</p>
<blockquote>${esc(closing).replace(/\n/g, "<br>")}</blockquote>
<h2>What the captions said</h2>
<table><thead><tr><th>In the take</th><th>Basis</th><th>Caption</th></tr></thead><tbody>${capRows}</tbody></table>
<p class="note"><span class="tag measured">measured</span> a time the server or the tab took on its own clock. <span class="tag simulated">simulated</span> the simulation's own arithmetic over simulated seconds, never wall time. <span class="tag reported">reported</span> what the policy file says about itself; nobody observed it here. <span class="tag agent">agent</span> the agent's notice or words, as the page showed them.</p>
<h2>The policy that came home</h2>
<p>The agent wrote <code>home/policy.json</code> (${policy ? esc(policy.bytes.toLocaleString("en-US")) : "?"} bytes, format ${esc(policy?.format ?? "?")}, MuJoCo ${esc(policy?.mujoco_version ?? "?")}) by combining the walk network it had just trained with the get-up network. Its body is the default 3-DOF quadruped (mjcf sha256 ${esc((policy?.mjcf_sha256 ?? "").slice(0, 12))}...). The tab's watcher of the run's disk installed it the moment the file landed, a few seconds before the agent's move home finished; the captions above say what the tab timed.</p>
<h2>What this take does not show</h2>
<ul>
<li>No zero-loss claim: no independent read-back is captioned here.</li>
<li>The training was a one-minute run (the file reports 61 s of walking training); the agent's own closing words quote how many of the 30 million steps it completed before it paused.</li>
<li>The cost meter on the stage reads $0.000: it is not wired to spend in this feed. Real spend for the take: one H100 sandbox for under two minutes and one small VM for about half a minute.</li>
<li>The multiverse area stays idle: the eight-universe fan-out is a separate take.</li>
</ul>
</main></body></html>`;

const leaks = findLeaks(html);
for (const l of leaks) console.error(`NOT PUBLISHABLE: ${l.rule}: ...${l.sample}...`);
if (leaks.length > 0) process.exit(1);
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
