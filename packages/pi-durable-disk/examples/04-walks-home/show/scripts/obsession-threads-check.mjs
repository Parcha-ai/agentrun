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
    const snap = () => read(`(() => { const th = document.getElementById("threads"); if (th.hidden) return { shown: false }; const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; const box = th.getBoundingClientRect(); const tiles = [...th.querySelectorAll(".tile")].map((t) => { const r = t.getBoundingClientRect(); return { skill: t.querySelector(".skill").textContent, host: t.querySelector(".host").textContent, status: t.dataset.status, text: t.innerText, inside: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1, clipped: t.scrollHeight > t.clientHeight + 1 }; }); return { shown: true, head: th.querySelector(".thead").textContent, phase: th.querySelector(".th").dataset.phase, tiles, chips: [...th.querySelectorAll(".skill")].map((c) => [c.textContent, c.className]), robot: !!th.querySelector(".robot") }; })()`);
    const at = async (seconds, wait = 2200) => { await seek(seconds); await sleep(wait); return snap(); };

    let r = await at(5);
    expect("before the agent splits there are no tiles, and the hidden overlay takes no room", r.shown === false && (await read(`getComputedStyle(document.getElementById("threads")).display`)) === "none", r);
    r = await at(14);
    expect("the agent split into 8 threads, one per GPU: a tile each, with its own GPU", r.shown && /The agent split into 8 threads, one per GPU/.test(r.head) && r.tiles.length === 8 && r.tiles.every((t, i) => t.host === `H100 #${i + 1}`), r);
    r = await at(22);
    const by = (name) => r.tiles?.find((t) => t.skill === name);
    expect("walk and sprint pass at checkpoint 1 (D2's timing), in their own unit", /checkpoint 1/.test(by("walk")?.text ?? "") && /speed 0\.4\d* m\/s/.test(by("walk")?.text ?? "") && /passes/.test(by("walk")?.text ?? "") && /passes/.test(by("sprint")?.text ?? ""), by("walk")?.text);
    expect("wave has not passed yet and says what passing needs", /wave/.test(by("wave")?.skill ?? "") && /not yet, needs >= 0\.6/.test(by("wave")?.text ?? ""), by("wave")?.text);
    expect("get-up shows no value until it succeeds", /no value yet|waiting for its first checkpoint/.test(by("get up")?.text ?? ""), by("get up")?.text);
    expect("every tile stays inside its box, nothing clipped", r.tiles.every((t) => t.inside && !t.clipped), r.tiles.filter((t) => !t.inside || t.clipped).map((t) => t.skill));
    if (shots) await tab.screenshot(join(shots, `threads-learning-${name.split(" ")[0]}.png`));
    r = await at(80);
    expect("later most are done, and the slow ones still learning", r.tiles.filter((t) => t.status === "done").length >= 5 && r.tiles.some((t) => t.status === "learning"), r.tiles.map((t) => t.status));
    r = await at(112, 2500); // every thread is finished, the run is not home yet
    expect("when every thread has finished the one robot shows, no skill in until the run is home", r.shown && r.robot && /0 of 8 skills are in the robot/.test(r.head) && r.phase === "landing", r);
    r = await at(118, 1500);
    expect("once the run is home the skills land one after another", r.phase === "landing" || r.phase === "home", r.phase);
    r = await at(118, 7500);
    expect("then all eight skills are in the robot", r.phase === "home" && /All 8 skills are in the robot/.test(r.head) && r.chips.filter(([, c]) => /\bin\b/.test(c)).length === 8, r);
    if (shots) await tab.screenshot(join(shots, `threads-home-${name.split(" ")[0]}.png`));
  } finally {
    await tab.close();
  }
  }
} finally {
  stage.kill();
}
console.log(failed ? `${failed} threads check(s) FAILED` : "obsession threads: all checks passed");
process.exit(failed ? 1 : 0);
