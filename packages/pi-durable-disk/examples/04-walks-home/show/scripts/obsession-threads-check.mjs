// One robot, eight teachers, on both stage pages (the obsession page and Walks Home v2 at /), in a real Chrome: the rehearsal of the cluster beat (SHOW_SCENARIO=threads) serves D2's per-skill files as the run's disk would; the page reads them (skills-poller.ts)
// and shows a tile per thread while they learn, then the one robot with each skill lighting as it lands. Each tile must stay inside its box.
//   [CDP_URL=...] node scripts/obsession-threads-check.mjs [shots-dir]
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const shots = process.argv[2] ?? process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const show = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
let pageName = "";
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${pageName}: ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const port = await freePort();
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "threads" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const seek = (seconds) => fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
try {
  await waitForStage(port, stage);
  for (const [name, pagePath] of [["obsession page", "/obsession/"], ["v2 page", "/"]]) {
  pageName = name;
  await seek(0);
  const tab = await openTab(new URL(pagePath, base).href, { width: 1600, height: 900 });
  try {
    await sleep(2500);
    const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
    const snap = () => read(`(() => { const th = document.getElementById("threads"); if (th.hidden) return { shown: false }; const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; const box = th.getBoundingClientRect(); const tiles = [...th.querySelectorAll(".tile")].map((t) => { const r = t.getBoundingClientRect(); return { skill: t.querySelector(".skill").textContent, host: t.title.split(" · ")[0], title: t.title, bar: t.querySelector(".bar") ? t.querySelector(".bar").getAttribute("aria-valuenow") : null, status: t.dataset.status, text: t.innerText.replace(/\\s+/g, " "), inside: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1, clipped: t.scrollHeight > t.clientHeight + 1 }; }); return { shown: true, head: th.querySelector(".thead").textContent, phase: th.querySelector(".th").dataset.phase, boxPhase: th.dataset.phase, boxH: box.height, paneH: th.parentElement.getBoundingClientRect().height, tiles, chips: [...th.querySelectorAll(".skill")].map((c) => [c.textContent, c.className]), robot: !!th.querySelector(".robot") }; })()`);
    const at = async (seconds, wait = 2200) => { await seek(seconds); await sleep(wait); return snap(); };

    let r = await at(5);
    expect("before the agent splits there are no tiles, and the hidden overlay takes no room", r.shown === false && (await read(`getComputedStyle(document.getElementById("threads")).display`)) === "none", r);
    r = await at(14);
    expect("the agent split into 8 threads, one per GPU: a tile each, with its own GPU", r.shown && /The agent split into 8 threads, one per GPU/.test(r.head) && r.tiles.length === 8 && r.tiles.every((t, i) => t.host === `H100 #${i + 1}`), r);
    r = await at(22);
    const by = (name) => r.tiles?.find((t) => t.skill === name);
    expect("walk and sprint pass at checkpoint 1 (D2's timing), in their own unit", /checkpoint 1/.test(by("walk")?.title ?? "") && /speed 0\.4\d* m\/s/.test(by("walk")?.text ?? "") && /passes/.test(by("walk")?.text ?? "") && /passes/.test(by("sprint")?.text ?? ""), by("walk")?.text);
    expect("wave has not passed yet and says what passing needs", /wave/.test(by("wave")?.skill ?? "") && /not yet/.test(by("wave")?.text ?? "") && /needs >= 0\.6/.test(by("wave")?.title ?? "") && Number(by("wave")?.bar) >= 0 && Number(by("wave")?.bar) < 100, by("wave"));
    expect("get-up shows no value until it succeeds", /no value yet|waiting for its first checkpoint/.test(by("get up")?.text ?? ""), by("get up")?.text);
    expect("every tile stays inside its box, nothing clipped", r.tiles.every((t) => t.inside && !t.clipped), r.tiles.filter((t) => !t.inside || t.clipped).map((t) => t.skill));
    if (shots) await tab.screenshot(join(shots, `threads-learning-${name.split(" ")[0]}.png`));
    r = await at(80);
    expect("later most are done, and the slow ones still learning", r.tiles.filter((t) => t.status === "done").length >= 5 && r.tiles.some((t) => t.status === "learning"), r.tiles.map((t) => t.status));
    r = await at(112, 2500); // every thread is finished, the run is not home yet
    expect("when every thread has finished the skills strip shows (no drawing over the creature), no skill in until the run is home", r.shown && !r.robot && /0 of 8 skills are in the robot/.test(r.head) && r.phase === "landing", r);
    expect("and it is a strip: the box carries the phase and takes a fraction of the creature pane, not all of it", r.boxPhase === "landing" && r.boxH > 0 && r.boxH < r.paneH * 0.4, [r.boxPhase, r.boxH, r.paneH]);
    r = await at(118, 1500);
    for (let w = 0; w < 15_000 && !["landing", "home"].includes(r.phase); w += 500) { await sleep(500); r = await snap(); } // a loaded box reads the files slowly: wait for the state, not a fixed time
    expect("once the run is home the skills land one after another", r.phase === "landing" || r.phase === "home", r.phase);
    r = await at(118, 7500);
    expect("then all eight skills are in the robot", r.phase === "home" && /All 8 skills are in the robot/.test(r.head) && r.chips.filter(([, c]) => /\bin\b/.test(c)).length === 8, r);
    expect("and at home it is still a strip over the one robot", r.boxPhase === "home" && r.boxH > 0 && r.boxH < r.paneH * 0.4, [r.boxPhase, r.boxH, r.paneH]);
    if (shots) await tab.screenshot(join(shots, `threads-home-${name.split(" ")[0]}.png`));
  } finally {
    await tab.close();
  }
  }
} finally {
  stage.kill();
}
// ---- The stage at a phone's width (390 x 844): the tiles are on screen in two columns and readable, the composer is in view, and nothing scrolls sideways.
{
  pageName = "phone";
  const pport = await freePort();
  const pstage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(pport), SHOW_SCENARIO: "threads" }, stdio: "ignore" });
  const pbase = `http://127.0.0.1:${pport}/`;
  const pseek = (seconds) => fetch(new URL("/api/dev/seek", pbase), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  try {
    await waitForStage(pport, pstage);
    await pseek(0);
    const tab = await openTab(pbase, { width: 390, height: 844 });
    try {
      await sleep(2500);
      await pseek(24);
      await sleep(3000);
      const m = JSON.parse(await tab.eval(`JSON.stringify((() => { const r = (e) => e.getBoundingClientRect(); const th = document.getElementById("threads"); const tiles = [...th.querySelectorAll(".tile")].map((t) => r(t)); const pane = r(th); const input = r(document.getElementById("chatin")); return { tiles: tiles.length, minH: Math.min(...tiles.map((t) => t.height)), cols: new Set(tiles.map((t) => Math.round(t.left))).size, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, paneH: pane.height, inputBottom: input.bottom, inputH: input.height, innerH: innerHeight, inputFont: parseFloat(getComputedStyle(document.getElementById("chatin")).fontSize), net: (() => { const n = document.getElementById("net"); return n.hidden ? null : r(n); })(), badge: r(document.querySelector("#badge .main")) }; })())`));
      expect("the eight tiles are on screen, in two columns, each tall enough to read (not squashed)", m.tiles === 8 && m.cols === 2 && m.minH >= 70 && m.paneH > 200, m);
      expect("nothing scrolls sideways", m.scrollW <= m.innerW, m);
      expect("the composer is in view, 44 px tall with 16 px type (a phone zooms anything smaller)", m.inputBottom <= m.innerH && m.inputH >= 44 && m.inputFont >= 16, m);
      expect("the network pill does not sit on the place's words", m.net === null || m.net.left >= m.badge.right - 1 || m.net.top >= m.badge.bottom - 1, m);
      // Every tile can be read: the pane scrolls, so each tile is scrolled into view in turn and must sit inside the pane, with none of its text cut off.
      const rows = JSON.parse(await tab.eval(`JSON.stringify((() => { const th = document.getElementById("threads"); return [...th.querySelectorAll(".tile")].map((t) => { t.scrollIntoView({ block: "nearest" }); const r = t.getBoundingClientRect(); const p = th.getBoundingClientRect(); return { skill: t.querySelector(".skill").textContent, inside: r.top >= p.top - 1 && r.bottom <= p.bottom + 1 && r.left >= p.left - 1 && r.right <= p.right + 1, clipped: t.scrollHeight > t.clientHeight + 1 || t.scrollWidth > t.clientWidth + 1 }; }); })())`));
      expect("scrolling the pane brings each of the eight tiles fully into view, none with its text cut off", rows.length === 8 && rows.every((r) => r.inside && !r.clipped), rows.filter((r) => !r.inside || r.clipped));
      if (shots) await tab.screenshot(join(shots, "stage-phone-tiles.png"));
      // The agent's tab can still be opened from a phone: with ?tab= the button shows, on screen, and is what a tap at its centre reaches.
      const withTab = await openTab(`${pbase}?tab=${encodeURIComponent("http://127.0.0.1:9/run/x")}`, { width: 390, height: 844 });
      try {
        await sleep(2500);
        const b = JSON.parse(await withTab.eval(`JSON.stringify((() => { const e = document.getElementById("opentab"); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { shown: !e.hidden && getComputedStyle(e).display !== "none", onScreen: r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, reachable: hit === e }; })())`));
        expect("with a tab link the Open the tab button is on a phone's screen and a tap reaches it", b.shown && b.onScreen && b.reachable, b);
      } finally {
        await withTab.close();
      }
    } finally {
      await tab.close();
    }
  } finally {
    pstage.kill();
  }
}
// ---- The stumble -> relearn card: the skills are for a new body (D2's skill.json fields), the robot's home body is another.
{
  pageName = "relearn";
  const rport = await freePort();
  const rstage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(rport), SHOW_SCENARIO: "threads", SHOW_THREADS_RELEARN: "1" }, stdio: "ignore" });
  const rbase = `http://127.0.0.1:${rport}/`;
  const rseek = (seconds) => fetch(new URL("/api/dev/seek", rbase), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  try {
    await waitForStage(rport, rstage);
    await rseek(0);
    const tab = await openTab(new URL("/obsession/", rbase).href, { width: 1600, height: 900 });
    try {
      await sleep(2500);
      const card = async (seconds) => { await rseek(seconds); await sleep(2300); return tab.eval(`(() => { const e = document.querySelector(".rl"); return e ? e.innerText : null; })()`); };
      let t = await card(35);
      expect("while the skills learn the card names the new body and how many have passed", /learning a new body/i.test(t ?? "") && /spider/.test(t ?? "") && /8 GPUs/.test(t ?? "") && /\d of 8 skills have passed/.test(t ?? ""), t);
      expect("and says nothing it was not given: no total, no home time yet", !/passed in/.test(t ?? "") && !/All home/.test(t ?? ""), t);
      t = await card(125);
      expect("when every skill has passed: all 8 passed in N s, all home in N s, from the round's own file, and it says relearned", /relearned its new body/i.test(t ?? "") && /all 8 skills passed in \d+ s/.test(t ?? "") && /All home in \d+ s/.test(t ?? ""), t);
      expect("and what one machine would take: the CPU estimate with its machine, one skill after another", /On one machine with 8 Xeon Gold 6312U/.test(t ?? "") && /one skill after another/.test(t ?? "") && /hours/.test(t ?? "") && /estimate/.test(t ?? ""), t);
      if (shots) await tab.screenshot(join(shots, "relearn-card.png"));
    } finally {
      await tab.close();
    }
  } finally {
    rstage.kill();
  }
}
console.log(failed ? `${failed} threads check(s) FAILED` : "obsession threads: all checks passed");
process.exit(failed ? 1 : 0);
