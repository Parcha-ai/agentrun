// Build the storyboard: node scripts/storyboard.mjs [--out recordings/storyboard.html] [--url http://127.0.0.1:8752/]
// Beat times come from the scripted feed itself (scenario.ts), so the timecodes cannot drift from what the stage plays.
// For each beat it seeks the scripted server (POST /api/dev/seek), screenshots our own tab, and inlines the stills as
// data URIs: the output is one self-contained HTML file (the script is frozen at each beat). Needs the stage server running with the scripted feed
// (SHOW_PORT=8752 TAB_DIR=... node serve.ts) and Chrome (CDP_URL, default the shared :9222; WebGL needs scripts/chrome.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fold } from "../reduce.ts";
import { ScenarioPlayer } from "../scenario.ts";
import { openTab, sleep } from "./cdp.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const url = arg("url", "http://127.0.0.1:8752/");
const out = arg("out", "recordings/storyboard.html");

// The script played once, to find when each thing happens.
const p = new ScenarioPlayer({ origin: 0 });
p.advance(360_000);
const ev = p.events;
const at = (pred) => ev.find(pred)?.at ?? 0;
const noteAt = (re) => at((e) => e.t === "note" && re.test(e.text));
const placeAt = (env) => at((e) => e.t === "place" && e.env === env);
let allTraining = 0;
for (let i = 0; i < ev.length && !allTraining; i++) {
  const s = fold(ev.slice(0, i + 1));
  if (Object.values(s.universes).filter((u) => u.status === "training").length >= 8) allTraining = ev[i].at;
}
const killedAt = noteAt(/was killed/);
const winnerAt = noteAt(/wins with/);
const finalCost = p.state.cost.usd;
const endAt = noteAt(/opens its own SQLite memory/) + 6000;

const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

const BEATS = [
  {
    id: "draw", at: 3000, title: "Draw it", lane: "D3",
    screen: "The tab app fills the left pane: the sketcher and the MuJoCo creature. The run lane has one green bar, Browser tab. The meter reads $0.00.",
    say: "This creature lives in a browser tab. I drag its legs around, and the design is saved in a SQLite file on the agent's disk, not in the tab.",
    real: "Tab app (D3) is built. The write to the disk goes through the pipe that holds the claim: real once the tab is attached to a run.",
    risk: "If the pipe is down the tab says memory is browser-only; say so and continue, the story still works.",
  },
  {
    id: "sandbox", at: placeAt("sandbox") + 3500, title: "A sandbox, in a second", lane: "D4",
    screen: "Switcher: Browser tab ticks done, Modal sandbox lights up. A blue bar starts with the handover time under it. Narration: claiming the disk, previous host fenced.",
    say: "I close the tab's job and the agent keeps going: it claims the same disk on a cloud sandbox, and the old host is fenced. That handover is the number under the bar. The agent writes the training environment here.",
    real: "Handover and notice are the package's claim and fence. Sandbox driver is D4's modalHost.",
    risk: "Handover takes longer than 2 s: the badge keeps pulsing, which reads fine on camera. Do not talk over it.",
  },
  {
    id: "vm", at: placeAt("vm") + 3500, title: "A full machine", lane: "D4",
    screen: "Modal VM bar, purple. Notes: you are now running in Modal VM. The agent builds the Docker training image; a desktop it drives is the optional shot.",
    say: "Same agent, same memory, now on a full VM. It builds the training image with Docker, and it can drive a desktop like a person would.",
    real: "Docker build and desktop are D4's lane (noVNC).",
    risk: "The desktop shot is optional: cut it if the VM lane is late.",
  },
  {
    id: "fanout", at: allTraining + 6000, title: "Eight universes", lane: "D1, D2",
    screen: "The right pane fills with a 2 x 4 grid. Eight GPU machines, each training against a different reward. The cost meter starts to move. Two spares wait in the strip under the grid.",
    say: "Now it forks itself into eight GPU machines. Each one trains the creature against a different reward function. Eight guesses at what walking means, in parallel.",
    real: "Fan-out is D1 (forkMany), training is D2. The grid reads the feed contract; the scripted feed stands in until D1's driver is up.",
    risk: "If fewer than eight start in time, show what started: the grid is honest about empty cells.",
  },
  {
    id: "kill", at: killedAt + 300, title: "Pull the plug", lane: "D1",
    screen: "One tile goes red: MACHINE KILLED. Its score line stops. The timeline lane for that machine ends in a red cross.",
    say: "Watch the leader. I pull the plug on that machine.",
    real: "The kill button calls the driver to destroy a real machine.",
    risk: "The kill must be a real machine death, never a status flip. Rehearse it twice before the take.",
  },
  {
    id: "takeover", at: killedAt + 1500, title: "A spare takes over", lane: "D1",
    screen: "The same cell turns purple: a spare claims the run. About two seconds after the kill it is training again and the score line carries on from where it stopped.",
    say: "Two seconds later a spare machine claims the same disk and picks up from the last checkpoint. The dead machine can't write anything anymore, because the fence says so. Nothing was lost.",
    real: "Takeover is the package's force claim, and the 2 s is measured, not scripted, once D1 is live.",
    risk: "If the takeover takes longer, say the real number. The notice lines on the right carry it.",
  },
  {
    id: "winner", at: winnerAt + 1500, title: "One wins", lane: "D1, D2",
    screen: "One tile turns gold. The other seven are sealed and dim. The meter stops climbing.",
    say: "One reward wins. The agent seals the others, and the winner keeps going. The whole fleet cost this much (the meter), and now it stops.",
    real: "Winner pick uses the evaluation score; the policy is exported by D2.",
    risk: "Make sure the cost meter reads the driver's real spend, not an estimate.",
  },
  {
    id: "home", at: placeAt("home") + 7500, title: "It walks home", lane: "D3, D2",
    screen: "The run is back in the tab, on a green bar. The policy, a few hundred KB, is loaded and the creature walks offline. Kick it and it gets up. Then open memory.",
    say: "The winning policy is a few hundred kilobytes. It comes home to the tab and walks on its own, no cloud. Kick it, it gets up. And now the agent shows me its memory: every machine it ever ran on.",
    real: "Policy load and kick are D3 and D2. The memory view reads the SQLite timeline in the agent's disk.",
    risk: "The kick must visibly recover. Pre-test the force so it falls and stands in under 3 s.",
  },
];

const tab = await openTab(url, { width: 1600, height: 900 });
const stills = {};
try {
  await sleep(2500);
  for (const b of BEATS) {
    // Freeze the script at the beat's exact time, give the page a moment to reconnect and render, then shoot.
    const res = await fetch(new URL("/api/dev/seek", url), { method: "POST", body: JSON.stringify({ seconds: b.at / 1000, paused: true }) });
    if (!res.ok) throw new Error(`seek: HTTP ${res.status}`);
    await sleep(1800);
    const file = `${dirname(out)}/still-${b.id}.png`;
    mkdirSync(dirname(out), { recursive: true });
    await tab.screenshot(file);
    stills[b.id] = (await import("node:fs")).readFileSync(file).toString("base64");
    console.log(`${b.id} @ ${fmt(b.at)}`);
  }
} finally {
  await tab.close();
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const rows = BEATS.map(
  (b, i) => `<article id="${b.id}">
  <div class="meta"><span class="n">${i + 1}</span><span class="t">${fmt(b.at)}</span><span class="lane">${esc(b.lane)}</span></div>
  <h2>${esc(b.title)}</h2>
  <img alt="${esc(b.title)}" src="data:image/png;base64,${stills[b.id]}">
  <dl><dt>On screen</dt><dd>${esc(b.screen)}</dd><dt>Say</dt><dd class="say">${esc(b.say)}</dd><dt>What is real</dt><dd>${esc(b.real)}</dd><dt>If it slips</dt><dd>${esc(b.risk)}</dd></dl>
</article>`,
).join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>It Walks Home Storyboard</title>
<style>
:root{--bg:#0c0f0e;--panel:#131816;--ink:#e8efe9;--muted:#8b9a92;--line:#25302b;--accent:#6fe3a6;--gold:#ffc15e;color-scheme:dark}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f4f3ee;--panel:#fff;--ink:#1d1d1b;--muted:#66665f;--line:#dcdad0;--accent:#12804c;--gold:#9a6400;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}.lede{color:var(--muted);margin:0 0 28px;max-width:70ch}
.facts{display:flex;flex-wrap:wrap;gap:10px 28px;border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:14px 18px;margin-bottom:34px}
.facts b{display:block;font:650 22px ui-monospace,Menlo,monospace}.facts span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
article{margin:0 0 44px}.meta{display:flex;gap:12px;align-items:center;font:12px ui-monospace,Menlo,monospace;color:var(--muted)}
.n{background:var(--accent);color:#0c0f0e;border-radius:50%;width:24px;height:24px;display:grid;place-items:center;font-weight:700}
.t{font-weight:700;color:var(--ink)}.lane{border:1px solid var(--line);border-radius:999px;padding:1px 9px}
h2{margin:6px 0 10px;font-size:22px}img{width:100%;height:auto;border:1px solid var(--line);border-radius:10px;display:block}
dl{display:grid;grid-template-columns:110px 1fr;gap:8px 16px;margin:14px 0 0}dt{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);padding-top:3px}dd{margin:0}
.say{color:var(--gold);font-style:italic}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{padding-top:8px}}
</style></head><body><main>
<h1>It Walks Home</h1>
<p class="lede">A creature you draw in a browser tab leaves its home, trains in the cloud across eight machines, survives one being killed, and walks back into the tab on its own. One agent, one disk, and every move is a claim and a fence.</p>
<div class="facts"><div><b>${fmt(endAt)}</b><span>scripted run</span></div><div><b>${fmt(killedAt)}</b><span>kill</span></div><div><b>2.0 s</b><span>takeover</span></div><div><b>$${finalCost.toFixed(2)}</b><span>fleet spend (fake rates)</span></div><div><b>${BEATS.length}</b><span>beats</span></div></div>
${rows}
<p class="lede">Stills are the stage playing its scripted feed: timecodes, costs and scores are rehearsal numbers, not measurements. Regenerate with <code>node scripts/storyboard.mjs</code>.</p>
</main></body></html>`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
