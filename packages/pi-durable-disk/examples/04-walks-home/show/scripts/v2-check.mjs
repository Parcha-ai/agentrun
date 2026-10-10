// The v2 stage in real Chrome, on the scripted v2 rehearsal (SHOW_SCENARIO=v2): what is on screen by default (the creature, one badge, the
// chat, one caption) and what is not (timeline, log, HUD numbers, cost meter, multiverse, VM desktop, buttons), that ?debug=1 brings the old
// panels back, the badge and the chat follow the story, a line typed in the chat reaches the feed, and nothing in the clean view
// mentions Wi-Fi or being offline.
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
let lateTab;
try {
  await waitForStage(port, stage);
  // The take starts at its start: the rehearsal is held at 0 until the page is open (a slow Chrome would otherwise let it run on).
  await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds: 0, paused: true }) });
  tab = await openTab(base, { width: 1600, height: 900 });
  await sleep(2500);
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  /** Every caption that shows during `ms`, with the tags it wore. */
  /** The tab's messages, sent from inside the tab frame (the path the real tab uses). */
  const fromTab = (message) => tab.eval(`document.getElementById("tab").contentWindow.eval(${JSON.stringify(`parent.postMessage(${JSON.stringify({ ns: "walks-home", ...message })}, "*")`)}); 0`);
  const pillsSeen = [];
  const watchCaptions = async (ms) => {
    const seen = new Map();
    for (let t = 0; t < ms; t += 300) {
      const c = await read(`document.getElementById("vcaption").hidden ? null : { text: document.querySelector("#vcaption .txt").textContent, tags: [document.getElementById("vcaption").dataset.tag].filter(Boolean), pills: document.querySelectorAll("#vcaption .tag").length }`);
      if (c && !seen.has(c.text)) seen.set(c.text, c.tags);
      if (c && c.pills > 0) pillsSeen.push(c.text);
      await sleep(300);
    }
    return seen;
  };
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
  // The clean view says nothing about Wi-Fi or being offline: no control, no
  // banner, no proof line, no caption, in the stage or in the creature's frame, at the start or after the story. (A wire-level check: the elements
  // are not in the page at all, and no visible text mentions it.)
  const noWifi = async (when) => {
    const traces = await read(`(() => {
      const frame = document.getElementById("tab");
      const inner = frame.contentDocument ? frame.contentDocument.body.innerText : "";
      const here = document.body.innerText;
      return { elements: ["wifi", "proof"].filter((id) => document.getElementById(id) !== null), stage: here.match(/wi-?fi|offline|network off/gi) ?? [], tab: inner.match(/wi-?fi|offline|network off/gi) ?? [] };
    })()`);
    expect(`${when}: no Wi-Fi control or proof line is in the page`, traces.elements.length === 0, traces.elements);
    expect(`${when}: nothing on the stage or in the creature's frame mentions Wi-Fi or being offline`, traces.stage.length === 0 && traces.tab.length === 0, traces);
  };

  // The first caption of the take says what the creature is: a physics simulation in the browser, once, in words.
  const sim = await captionLike(/physics simulation running in your browser/, 15_000);
  expect("the take opens by saying the creature is a physics simulation running in the browser", /physics simulation running in your browser/.test(sim), sim);
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
  expect("there is no permanent line about the home: it is said once, at the first move", (await read(`document.querySelector("#badge .home") === null`)) === true);
  expect("the tab is the clean one", /clean=1/.test(layout.tabSrc ?? ""), layout.tabSrc);
  await noWifi("at the start");
  const hint = await read(`getComputedStyle(document.getElementById("chathint")).display`);
  expect("before anyone speaks the chat says what to do", hint !== "none", hint);
  // A real stroke on the tab's own sketcher (mouse events through Chrome, on the real bundle): the tab itself says "draw-started", the check does not.
  // The sketcher is a handle editor: the stroke presses the nose handle, where the tab's own geometry puts it, and drags it in.
  const grab = await read(`(() => {
    const frame = document.getElementById("tab");
    const g = frame.contentWindow.__walks && frame.contentWindow.__walks.sketchGeometry && frame.contentWindow.__walks.sketchGeometry();
    if (!g) return null;
    const f = frame.getBoundingClientRect();
    const nose = g.handles.find((h) => h.kind === "length");
    return nose ? { x: f.x + g.rect.left + nose.x, y: f.y + g.rect.top + nose.y, canvas: g.rect.width } : null;
  })()`);
  expect("the tab shows its sketcher with a handle to draw with", grab !== null && grab.canvas > 50, grab);
  if (grab) {
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: grab.x, y: grab.y });
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: grab.x, y: grab.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: grab.x - 8 * i, y: grab.y, button: "left", buttons: 1 });
      await sleep(60);
    }
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: grab.x - 48, y: grab.y, button: "left", buttons: 0, clickCount: 1 });
  }
  await sleep(500);
  expect("once the tab itself says a stroke was drawn the prompt to draw goes away", (await read(`getComputedStyle(document.getElementById("chathint")).display`)) === "none");
  expect("the badge says the agent is in the browser", (await read(`document.querySelector("#badge .txt").textContent`)) === "Your agent is in your browser");
  await shot("1-draw");

  // The story: the user's line, the agent leaves, the badge animates to the GPU, the agent comes home.
  await seek(10);
  const spoken = await read(`[...document.querySelectorAll("#chatlog .turn")].map((t) => [t.classList.contains("user") ? "user" : "agent", t.querySelector(".said").textContent])`);
  expect("the user's line is in the chat", JSON.stringify(spoken) === JSON.stringify([["user", "teach it to walk"]]), spoken);
  expect("the hint is gone once someone speaks", (await read(`getComputedStyle(document.getElementById("chathint")).display`)) === "none");
  // (Typed right after a seek: the rehearsal is paused, so its script clock stands still while the page's runs on, and a turn stamped with the
  // script's clock a long time after a seek would hold the page's caption clock back until wall time caught up. A live feed is stamped on a wall clock.)
  // A line typed in the chat goes to the feed as the user's turn.
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "hello agent"; document.getElementById("chatform").requestSubmit(); })()`);
  await sleep(1200);
  const typed = await read(`[...document.querySelectorAll("#chatlog .turn.user .said")].map((e) => e.textContent)`);
  expect("a line typed in the chat becomes the user's turn", typed.includes("hello agent"), typed);
  expect("the input is cleared after it is taken", (await read(`document.getElementById("chatin").value`)) === "");

  await seek(14);
  const card = await read(`(() => { const d = document.getElementById("decision"); return { hidden: d.hidden, record: d.dataset.record, badge: document.querySelector("#badge .txt").textContent }; })()`);
  expect("a placement that is only a stand-in's is NOT shown to the viewer (it read as an admission that the choice was canned)", card.hidden === true && card.badge === "Your agent is in your browser", card);
  expect("but it is kept: the record names who decided, what, and how long it took", /"model":"scripted"/.test(card.record) && /"choice":"modal-gpu"/.test(card.record) && /"latency_ms":37/.test(card.record), card.record);
  await shot("1b-decision");
  await seek(30);
  expect("the card is gone a few seconds after", (await read(`document.getElementById("decision").hidden`)) === true);
  await seek(22);
  const counting = await captionLike(/Setting up the training program on the GPU\.\.\. \d+ s/, 25_000);
  expect("while the agent sets up the training program the caption counts seconds, tagged scripted in a rehearsal", /Setting up the training program on the GPU\.\.\. \d+ s/.test(counting), counting);
  expect("the counter's tag is scripted", (await read(`document.getElementById("vcaption").dataset.tag`)) === "scripted");
  await seek(30);
  await sleep(6000);
  expect("once learning has begun the counter is gone", !/Setting up/.test(await read(`document.getElementById("vcaption").textContent`)));
  await seek(18);
  const away = await read(`({ text: document.querySelector("#badge .txt").textContent, tone: document.getElementById("badge").dataset.tone, turns: document.querySelectorAll("#chatlog .turn").length })`);
  expect("the badge moved to the GPU", away.text === "Your agent moved to H100 GPU, Virginia to train" && away.tone === "cloud", away);
  expect("the agent's line is in the chat after the user's", away.turns === 2, away.turns);
  const memoryText = "The agent's memory lives on a cloud disk, so it can switch machines and pick up where it left off.";
  const line = await read(`(() => { const m = document.querySelector("#badge .memory"); return { hidden: m.hidden, text: m.textContent, shown: getComputedStyle(m).display !== "none" }; })()`);
  expect("while the agent is away the cloud-disk sentence is on screen as part of the header, not a caption that passes", line.hidden === false && line.shown && line.text === memoryText, line);
  // Cold view 5: "the cloud-disk line is the product, and the viewer called it buried in small print". It is as readable as the header while away.
  const size = await read(`(() => { const m = getComputedStyle(document.querySelector("#badge .memory")); const h = getComputedStyle(document.querySelector("#badge .txt")); return { memoryPx: parseFloat(m.fontSize), headerPx: parseFloat(h.fontSize), weight: Number(m.fontWeight), memoryColor: m.color, inkColor: getComputedStyle(document.body).color }; })()`);
  expect("the cloud-disk sentence is close to the header's size (at least three quarters of it), not small print", size.memoryPx >= size.headerPx * 0.75, size);
  expect("and bold enough, in the full text colour rather than muted", size.weight >= 600 && size.memoryColor === size.inkColor, size);
  const first = await watchCaptions(14_000);
  expect("and it is still there after the captions have come and gone", (await read(`document.querySelector("#badge .memory").hidden`)) === false);
  expect("the measured-looking switch time is there too, tagged scripted because the feed is", [...first].some(([t, tags]) => /Moved to the H100 GPU/.test(t) && tags.includes("scripted")), [...first]);
  await shot("2-away");
  await seek(100);
  const home = await read(`({ text: document.querySelector("#badge .txt").textContent, tone: document.getElementById("badge").dataset.tone })`);
  expect("the badge came home", home.text === "Your agent is back in your browser" && home.tone === "tab", home);
  const homeCaps = await watchCaptions(22_000);
  expect("on the way back one caption says why it came home", homeCaps.has("Done training. The agent came back to your browser, and so did what it learned."), [...homeCaps.keys()]);
  // Cold view 6: the pipe's "Switched to This tab in 900 ms (timed by the server)" is said as what happened, in seconds, in the clean view.
  await seek(94);
  await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds: 96, paused: true }) });
  const wayHome = await watchCaptions(16_000);
  // (Whether this line is on screen at all depends on what else is queued at that moment: it is the lowest-ranked of the way home, and "Done training" says the
  // same thing first. What the check holds is that when the pipe's line is shown it is never in the server's words; the wording itself is unit-tested.)
  expect("a switch time, if shown, is in plain seconds", [...wayHome.keys()].every((t) => !/Came home/.test(t) || /^Came home to your browser in 0\.9 s$/.test(t)), [...wayHome.keys()]);
  expect("and the server-timed wording (\"Switched to This tab in 900 ms\") is not shown in the clean view", [...homeCaps.keys(), ...wayHome.keys()].every((t) => !/Switched to|This tab/.test(t)), [...wayHome.keys()]);
  expect("no caption in the clean view draws a tag pill (the viewer read MEASURED as a staged label)", pillsSeen.length === 0, pillsSeen);
  expect("the cloud-disk sentence is gone once the agent is home", (await read(`document.querySelector("#badge .memory").hidden`)) === true);
  expect("no caption uses the words a viewer could not follow", [...homeCaps.keys(), ...first.keys()].every((t) => !/checkpoint|policy|getup|combined/i.test(t)), [...homeCaps.keys()]);
  // D4 rehearses and then records: the second take in the same page must end the same way as the first. The stage's memory of the first
  // (the brain it asked the tab to load, whether the agent went away) must not leak into the second, or its ending never shows.
  await seek(18);
  await sleep(3000);
  await seek(100);
  const secondTake = await watchCaptions(25_000);
  expect("a second take in the same page ends the same way: why it came home, once a trained brain arrives", secondTake.has("Done training. The agent came back to your browser, and so did what it learned."), [...secondTake.keys()]);
  await shot("3-home");

  // Getup lines are told only after a kick: lying down when the brain lands is not "it learned to get back up".
  await fromTab({ type: "mode-changed", mode: "getup", t: 3, up: 0.1 });
  const noKick = await watchCaptions(7000);
  expect("with nobody having kicked it, no getup caption", ![...noKick.keys()].some((t) => /learned to get back up/.test(t)), [...noKick.keys()]);
  // Cold view 6: the tip-over frame had no explanation, because the getup line waited behind the caption holding the slot. A version caption is on
  // screen (inside its 4 s hold) when the kick lands; the getup line takes the slot within a second and a half.
  await fromTab({ type: "policy-arrived", name: "train/gpu/policy.json", via: "watch", message: "", host: null, training_seconds: null, mjcf_sha256: "x", switched_body: null, arrival_to_installed_ms: 12, bytes: 1, kind: "checkpoint", checkpoint_n: 20, steps: null, wall_s: 300, reported_walk_10s_m: 2.1 });
  await sleep(600);
  const holding = await read(`document.getElementById("vcaption").hidden ? "" : document.querySelector("#vcaption .txt").textContent`);
  expect("a caption is holding the slot when the kick lands", holding !== "" && !/Knocked over/.test(holding), holding);
  await fromTab({ type: "kicked", force_n: 400, t: 5 });
  await fromTab({ type: "mode-changed", mode: "getup", t: 5.4, up: 0.1 });
  const knocked = await captionLike(/Knocked over/, 1500);
  expect("at the kick the getup line is on screen within 1.5 s, though another caption was holding the slot", /^Knocked over\. It learned to get back up\.$/.test(knocked), knocked);
  const afterKick = await watchCaptions(9000);
  expect("after a kick the getup caption is told", [...afterKick.keys()].some((t) => /Knocked over\. It learned to get back up\./.test(t)) || /Knocked over/.test(knocked), [...afterKick.keys()]);

  await noWifi("after the story");
  await shot("4-home-end");

  const errors = tab.logs.filter((l) => /^exception|log\.error/.test(l) && !/Failed to load resource|net::/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);

  // The rehearsal shows its own chart: its scripted versions reach it through the feed, with no tab message injected.
  await seek(70);
  await sleep(1500);
  const rehearsalChart = await read(`(() => { const e = document.getElementById("spark"); return { shown: getComputedStyle(e).display !== "none", dots: e.querySelectorAll("circle").length, label: e.querySelector("text")?.textContent }; })()`);
  expect("the rehearsal's scripted versions are on the chart without any tab message", rehearsalChart.shown && rehearsalChart.dots === 7 && rehearsalChart.label === "v7 4.5 m", rehearsalChart);

  // Every version, latest wins. The tab reports each version's own file distance (here sent from inside the tab frame, the path the real tab uses),
  // one second apart. A newer version replaces the version caption at once, so the screen never says version 4 while version 7 is walking, and the
  // chart is the record of every one.
  await seek(2);
  await sleep(1500);
  const D2 = [0.03, 0.06, 0.12, 0.17, 0.42, 3.59, 4.49];
  const shownDuring = [];
  for (let i = 0; i < D2.length; i++) {
    await fromTab({ type: "policy-arrived", name: "train/gpu/policy.json", via: "watch", message: "", host: null, training_seconds: null, mjcf_sha256: "x", switched_body: null, arrival_to_installed_ms: 12, bytes: 1, kind: "checkpoint", checkpoint_n: i + 1, steps: null, wall_s: 30 + 7 * i, reported_walk_10s_m: D2[i] });
    for (let t = 0; t < 1000; t += 100) {
      const c = await read(`document.getElementById("vcaption").hidden ? "" : document.querySelector("#vcaption .txt").textContent`);
      if (/^Version \d/.test(c) && shownDuring.at(-1) !== c) shownDuring.push(c);
      await sleep(100);
    }
  }
  await sleep(300);
  const last = await read(`document.getElementById("vcaption").hidden ? "" : document.querySelector("#vcaption .txt").textContent`);
  expect("seven versions one second apart end with the version-7 caption showing, in the 10 s window", last === "Version 7: walking - 4.5 m in 10 s", last);
  const numbers = shownDuring.map((t) => Number(/^Version (\d)/.exec(t)[1]));
  expect("and no older version came back after a newer one: the screen was never stale", numbers.every((n, i) => i === 0 || n > numbers[i - 1]), shownDuring);
  expect("every caption the viewer saw said how far it walked in the same 10 s window", shownDuring.every((t) => / m in 10 s$/.test(t)), shownDuring);
  const spark = await read(`(() => { const e = document.getElementById("spark"); return { shown: getComputedStyle(e).display !== "none", dots: e.querySelectorAll("circle").length, label: e.querySelector("text")?.textContent, title: e.querySelector(".t")?.textContent }; })()`);
  expect("and the chart has all seven points: it is the record of every version", spark.shown && spark.dots === 7 && spark.label === "v7 4.5 m", spark);
  expect("the chart says what it shows", spark.title === "Metres walked in 10 s, by version", spark);
  await shot("2b-versions");

  // A page that connects when the run is ALREADY home (a reload after the agent came back, or a seek the page never watched): its own history says
  // nothing about the trip, so the run's record of where it stayed is the evidence the agent went, and it must still ask the tab for the trained brain.
  await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds: 100, paused: true }) });
  // The listener is registered before the first navigation, so it is in the page that stays; and nothing is read until the stage has drawn.
  const collect = `window.__arr = []; addEventListener("message", (e) => { const d = e.data; if (d && d.ns === "walks-home" && d.type === "policy-arrived") window.__arr.push({ via: d.via, kind: d.kind }); });`;
  lateTab = await openTab(base, { width: 1600, height: 900, init: collect });
  for (let t = 0; t < 30_000 && !(await lateTab.eval(`!!document.getElementById("vcaption")`).catch(() => false)); t += 250) await sleep(250);
  let lateCap = "";
  for (let t = 0; t < 30_000; t += 500) {
    lateCap = await lateTab.eval(`document.getElementById("vcaption")?.hidden === false ? document.getElementById("vcaption").textContent : ""`).catch(() => "");
    if (/Done training/.test(lateCap)) break;
    await sleep(500);
  }
  const lateArrivals = JSON.parse(await lateTab.eval(`JSON.stringify(__arr)`));
  expect("a page opened on a run that is already home asks the tab for the trained brain", lateArrivals.some((a) => a.via === "message" && a.kind === "final"), lateArrivals);
  expect("and says why the agent came home, once that brain is in", /Done training\. The agent came back to your browser, and so did what it learned\./.test(lateCap), lateCap);
  await lateTab.close();
  lateTab = undefined;
  // ?debug=1 is the old stage.
  debugTab = await openTab(withDebug(base), { width: 1600, height: 900 });
  await sleep(2500);
  const dbg = await debugTab.eval(`JSON.stringify({ v2: document.body.classList.contains("v2"), shown: ["header", "#mv", "#bottom", "#tabbar", "#grid"].filter((s) => getComputedStyle(document.querySelector(s)).display !== "none"), badge: getComputedStyle(document.getElementById("badge")).display, src: document.getElementById("tab").getAttribute("src") })`).then(JSON.parse);
  expect("?debug=1 brings back the header, multiverse, timeline and buttons, and drops the v2 chrome", dbg.v2 === false && dbg.shown.length === 5 && dbg.badge === "none", dbg);
  expect("?debug=1 loads the full tab, not the clean one", dbg.src === "/tab/", dbg.src);
} finally {
  await tab?.close();
  await debugTab?.close();
  await lateTab?.close();
  stage.kill("SIGTERM");
}
console.log(failed === 0 ? "\nall v2 checks passed" : `\n${failed} v2 check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
