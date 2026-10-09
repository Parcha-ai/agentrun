// The v2 stage in real Chrome, on the scripted v2 rehearsal (SHOW_SCENARIO=v2): what is on screen by default (the creature, one badge, the
// chat, one caption) and what is not (timeline, log, HUD numbers, cost meter, multiverse, VM desktop, buttons), that ?debug=1 brings the old
// panels back, the badge and the chat follow the story, a line typed in the chat reaches the feed, and cutting the Wi-Fi (CDP offline
// emulation) shows an "offline" badge and one caption without the stage reporting its own failed fetches as an error.
//   CDP_URL=http://127.0.0.1:9444 [TAB_DIR=<tab dist>] node scripts/v2-check.mjs [shots-dir]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage, withDebug } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "v2" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const seek = async (seconds) => {
  const res = await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  if (!res.ok) throw new Error(`seek ${seconds}: HTTP ${res.status}`);
  await sleep(2200);
};
let tab;
let debugTab;
try {
  await waitForStage(port, stage);
  tab = await openTab(base, { width: 1600, height: 900 });
  await sleep(2500);
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  /** The captions come one at a time, each held at least 4 s, so one that is due may wait behind another: poll for it. */
  const captionLike = async (re, ms = 20_000) => {
    let text = "";
    for (let t = 0; t < ms; t += 400) {
      text = await read(`document.getElementById("vcaption").textContent`);
      if (re.test(text)) return text;
      await sleep(400);
    }
    return text;
  };
  const shot = async (name) => shots && (await tab.screenshot(join(shots, `${name}.png`)));

  // What is on screen by default, and what is not.
  await seek(1);
  const layout = await read(`(() => {
    const shown = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
    const w = innerWidth;
    return {
      v2: document.body.classList.contains("v2"),
      visible: ["#badge", "#chat", "#tab", "#chatin"].filter(shown),
      hidden: ["header", "#mv", "#bottom", "#tabbar", "#timeline", "#notes", "#grid", "#desktop", "#cost", "#switcher", "#operator"].filter((s) => !shown(s)),
      creatureShare: document.getElementById("tab").getBoundingClientRect().width / w,
      tabSrc: document.getElementById("tab").getAttribute("src"),
    };
  })()`);
  expect("v2 is the default page", layout.v2 === true, layout);
  expect("the badge, the chat, the chat input and the creature are on screen", ["#badge", "#chat", "#tab", "#chatin"].every((s) => layout.visible.includes(s)), layout.visible);
  expect("the timeline, log, cost meter, multiverse, desktop, buttons and operator panel are not", layout.hidden.length === 11, layout.hidden);
  expect("the creature has most of the width (the chat about a third)", layout.creatureShare > 0.6 && layout.creatureShare < 0.72, layout.creatureShare);
  expect("the tab is the clean one", /clean=1/.test(layout.tabSrc ?? ""), layout.tabSrc);
  const hint = await read(`getComputedStyle(document.getElementById("chathint")).display`);
  expect("before anyone speaks the chat says what to do", hint !== "none", hint);
  expect("the badge says the agent is in the browser", (await read(`document.querySelector("#badge .txt").textContent`)) === "Agent: running in your browser");
  await shot("1-draw");

  // The story: the user's line, the agent leaves, the badge animates to the GPU, the agent comes home.
  await seek(10);
  const spoken = await read(`[...document.querySelectorAll("#chatlog .turn")].map((t) => [t.classList.contains("user") ? "user" : "agent", t.querySelector(".said").textContent])`);
  expect("the user's line is in the chat", JSON.stringify(spoken) === JSON.stringify([["user", "teach it to walk"]]), spoken);
  expect("the hint is gone once someone speaks", (await read(`getComputedStyle(document.getElementById("chathint")).display`)) === "none");
  await seek(14);
  const card = await read(`(() => { const d = document.getElementById("decision"); return { hidden: d.hidden, title: d.querySelector("h3")?.textContent, rows: [...d.querySelectorAll(".opt")].map((r) => [r.querySelector(".name").textContent, r.querySelector(".pct").textContent, r.classList.contains("chosen")]), foot: d.querySelector(".foot")?.textContent, tag: d.querySelector(".foot .tag")?.textContent, badge: document.querySelector("#badge .txt").textContent, barPx: [...d.querySelectorAll(".bar i")].map((i) => Math.round(i.getBoundingClientRect().width)) }; })()`);
  expect("a decision card asks where this should run, before the badge moves", card.hidden === false && card.title === "Where should this run?" && card.badge === "Agent: running in your browser", card);
  expect("it shows a bar and a percent for each option, with the chosen one marked", JSON.stringify(card.rows) === JSON.stringify([["Browser", "2%", false], ["Modal VM", "4%", false], ["H100 GPU", "94%", true]]), card.rows);
  expect("the bars have grown to their share (the chosen one far longer)", card.barPx[2] > 10 * card.barPx[0] && card.barPx[2] > 200, card.barPx);
  expect("it says who decided and how long it took, scripted in a rehearsal", /decided by a stand-in in 37 ms/.test(card.foot) && card.tag === "scripted", [card.foot, card.tag]);
  await shot("1b-decision");
  await seek(30);
  expect("the card is gone a few seconds after", (await read(`document.getElementById("decision").hidden`)) === true);
  await seek(18);
  const away = await read(`({ text: document.querySelector("#badge .txt").textContent, tone: document.getElementById("badge").dataset.tone, turns: document.querySelectorAll("#chatlog .turn").length, cap: document.getElementById("vcaption").textContent, hidden: document.getElementById("vcaption").hidden })`);
  expect("the badge moved to the GPU", away.text === "Agent: running on H100 GPU, Virginia" && away.tone === "cloud", away);
  expect("the agent's line is in the chat after the user's", away.turns === 2, away.turns);
  expect("one caption is up, tagged scripted because the feed is", !away.hidden && /^scripted/.test(away.cap), away.cap);
  await shot("2-away");
  await seek(100);
  const home = await read(`({ text: document.querySelector("#badge .txt").textContent, tone: document.getElementById("badge").dataset.tone })`);
  expect("the badge came home", home.text === "Agent: running in your browser" && home.tone === "tab", home);
  await shot("3-home");

  // A line typed in the chat goes to the feed as the user's turn.
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "hello agent"; document.getElementById("chatform").requestSubmit(); })()`);
  await sleep(1200);
  const typed = await read(`[...document.querySelectorAll("#chatlog .turn.user .said")].map((e) => e.textContent)`);
  expect("a line typed in the chat becomes the user's turn", typed.includes("hello agent"), typed);
  expect("the input is cleared after it is taken", (await read(`document.getElementById("chatin").value`)) === "");

  // The take cuts the Wi-Fi once the story has settled: let the captions from the policy coming home run out first.
  for (let t = 0; t < 40_000 && !(await read(`document.getElementById("vcaption").hidden`)); t += 500) await sleep(500);
  // Wi-Fi off: the badge says so, one caption, and no "feed lost" banner (the stage's own fetches fail by design).
  await tab.send("Network.enable");
  await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(2500);
  const offCap = await captionLike(/Network off/);
  const off = await read(`({ pill: !document.querySelector("#badge .offline").hidden, lost: !document.getElementById("lost").hidden, online: navigator.onLine })`);
  off.cap = offCap;
  expect("the browser reports it is offline", off.online === false, off);
  expect("the badge says the network is off", off.pill === true, off);
  expect("the stage does not show its own failed feed as an error", off.lost === false, off);
  expect("the caption says the learned brain runs in the browser even offline", /Network off.*learned runs in your tab, even offline/.test(off.cap), off.cap);
  await shot("4-offline");
  await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const onCap = await captionLike(/Network back on/);
  const on = await read(`({ pill: !document.querySelector("#badge .offline").hidden })`);
  on.cap = onCap;
  expect("back online: the pill is gone and the caption says so", on.pill === false && /back on/.test(on.cap), on);

  const errors = tab.logs.filter((l) => /^exception|log\.error/.test(l) && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);

  // ?debug=1 is the old stage.
  debugTab = await openTab(withDebug(base), { width: 1600, height: 900 });
  await sleep(2500);
  const dbg = await debugTab.eval(`JSON.stringify({ v2: document.body.classList.contains("v2"), shown: ["header", "#mv", "#bottom", "#tabbar", "#grid"].filter((s) => getComputedStyle(document.querySelector(s)).display !== "none"), badge: getComputedStyle(document.getElementById("badge")).display, src: document.getElementById("tab").getAttribute("src") })`).then(JSON.parse);
  expect("?debug=1 brings back the header, multiverse, timeline and buttons, and drops the v2 chrome", dbg.v2 === false && dbg.shown.length === 5 && dbg.badge === "none", dbg);
  expect("?debug=1 loads the full tab, not the clean one", dbg.src === "/tab/", dbg.src);
} finally {
  await tab?.close();
  await debugTab?.close();
  stage.kill("SIGTERM");
}
console.log(failed === 0 ? "\nall v2 checks passed" : `\n${failed} v2 check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
