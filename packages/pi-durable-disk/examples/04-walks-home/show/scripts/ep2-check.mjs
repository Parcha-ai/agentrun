// Episode 2's stage in real Chrome, on its scripted rehearsal (SHOW_SCENARIO=ep2, served at /ep2/): the training panel while the agent is away
// (counter, loss curve, the practice-answer line, the same question answered before and now), the way home, the banner when the chat switches to
// the trained model, plain captions with no tag pill, and nothing about Wi-Fi or being offline.
//   CDP_URL=http://127.0.0.1:9444 [TAB_DIR=<tab dist>] node scripts/ep2-check.mjs [shots-dir]
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "ep2" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const seek = async (seconds) => {
  const res = await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  if (!res.ok) throw new Error(`seek ${seconds}: HTTP ${res.status}`);
  await sleep(2300);
};
let tab;
try {
  await waitForStage(port, stage);
  await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds: 0, paused: true }) });
  tab = await openTab(new URL("/ep2/", base).href, { width: 1600, height: 900 });
  await sleep(2500);
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  const shot = async (name) => shots && (await tab.screenshot(join(shots, `${name}.png`)));
  const text = (sel) => read(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  /** The caption that matches, or "" if none did within `ms`: an unrelated caption never stands in for the one asked for. */
  const captionLike = async (re, ms = 20_000) => {
    for (let w = 0; w < ms; w += 400) {
      const t = await read(`document.getElementById("vcaption").hidden ? "" : document.querySelector("#vcaption .txt").textContent`);
      if (re.test(t)) return t;
      await sleep(400);
    }
    return "";
  };
  const noWifi = async (when) => {
    const hits = await read(`(document.body.innerText.match(/wi-?fi|offline|network off/gi) ?? []).concat(["wifi", "proof"].filter((id) => document.getElementById(id)))`);
    expect(`${when}: nothing about Wi-Fi or being offline`, hits.length === 0, hits);
  };
  const pills = [];
  const watch = async (ms) => {
    const seen = new Map();
    for (let w = 0; w < ms; w += 300) {
      const c = await read(`document.getElementById("vcaption").hidden ? null : { text: document.querySelector("#vcaption .txt").textContent, tag: document.getElementById("vcaption").dataset.tag, pills: document.querySelectorAll("#vcaption .tag").length }`);
      if (c && !seen.has(c.text)) seen.set(c.text, c.tag);
      if (c && c.pills > 0) pills.push(c.text);
      await sleep(300);
    }
    return seen;
  };

  // At the start: the agent is in the browser, the tab is the centre, no panel.
  expect("the page is episode 2's", (await read(`document.title`)) === "It Comes Home Obsessed");
  expect("the badge says the agent is in the browser", (await text("#badge .txt")) === "Your agent is in your browser");
  expect("the training panel is not shown before the agent leaves", (await read(`document.getElementById("train").classList.contains("off")`)) === true);
  const tabSrc = await read(`document.getElementById("tab").getAttribute("src")`);
  expect("the page points its tab at episode 2 itself (no CDP help): /tab/?clean=1&banner=1&episode=2", tabSrc === "/tab/?clean=1&banner=1&episode=2", tabSrc);
  // What the stage tells the tab (its holder logic waits for set-placement): watch the stage's own messages to the tab's window.
  await tab.eval(`(() => { window.__toTab = []; const w = document.getElementById("tab").contentWindow; const post = w.postMessage; w.postMessage = function (m, ...rest) { if (m && m.type === "set-placement") window.__toTab.push({ kind: m.kind, label: m.label }); return post.call(this, m, ...rest); }; })()`);
  expect("the tab is in the centre", (await read(`document.getElementById("tab").getBoundingClientRect().width > 600`)) === true);
  await noWifi("at the start");
  // The model's answers carry emoji, and this machine has no emoji font: the page loads Noto Color Emoji as a web font. A glyph that renders is not the tofu box.
  const emoji = JSON.parse(await tab.eval(`(async () => {
    await document.fonts.load('40px "Noto Color Emoji"', "\\u{1F309}");
    const width = (ch) => { const s = document.createElement("span"); s.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:40px var(--sans)"; s.textContent = ch; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
    const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Noto Color Emoji" && f.status === "loaded").length;
    return JSON.stringify({ bridge: width("\\u{1F309}"), tofu: width("\\u{FFFF}"), faces });
  })()`));
  const fontLink = await read(`(() => { const l = document.querySelector('link[href*="noto-color-emoji"]'); return l ? { origin: new URL(l.href).origin, here: location.origin, ok: !!l.sheet } : null; })()`);
  expect("the emoji font is the stage's own, not another host's (no outbound fetch)", fontLink !== null && fontLink.origin === fontLink.here && fontLink.ok === true, fontLink);
  const fontServed = await fetch(new URL("/fonts/noto-color-emoji.css", base));
  expect("and the tab can use the same stylesheet at /fonts/", fontServed.status === 200 && /text\/css/.test(fontServed.headers.get("content-type") ?? ""), fontServed.status);
  expect("the emoji font loaded and the bridge emoji renders: not the tofu box, and not zero width", emoji.faces >= 1 && emoji.bridge > 0 && emoji.bridge !== emoji.tofu, emoji);

  await shot("1-before");

  // The request and the move.
  await seek(10);
  const spoken = await read(`[...document.querySelectorAll("#chatlog .turn")].map((t) => [t.classList.contains("user") ? "user" : "agent", t.querySelector(".said").textContent])`);
  expect("the user's sentence is the first turn", spoken[0]?.[0] === "user" && /obsessed with the Golden Gate Bridge/.test(spoken[0][1]), spoken);

  // The move to the GPU, as the pipe says it ("Switched to a cloud GPU in 800 ms (timed by the server)"): the label already has its article.
  await seek(14);
  const moved = await watch(8000);
  expect("the move is said as 'Moved to a cloud GPU in 0.8 s': the label keeps its article, never 'the a cloud GPU'", [...moved.keys()].some((t) => t === "Moved to a cloud GPU in 0.8 s") && [...moved.keys()].every((t) => !/\bthe an? /i.test(t)), [...moved.keys()]);

  // Training, mid-run: the panel is the centre; the cloud-disk line is in the header.
  // Just after the training starts: the start is said (a seek lands inside the 15 s a moment stays news, so the check goes there, not to the middle).
  await seek(34);
  const started = await captionLike(/^Training has started: 180 steps\.$/, 14_000);
  expect("a caption says the training has started", started !== "", started);
  await seek(70);
  const toTabAway = await read(`window.__toTab`);
  expect("the tab was told 'gpu' (with the host's label) while the agent is away", toTabAway.some((m) => m.kind === "gpu" && m.label === "a cloud GPU"), toTabAway);
  expect("the badge moved to the GPU", (await text("#badge .txt")) === "Your agent moved to a cloud GPU to train");
  expect("the cloud-disk line is under the header", (await read(`document.querySelector("#badge .memory").hidden === false && document.querySelector("#badge .memory").textContent`)) === "The agent's memory lives on a cloud disk, so it can switch machines and pick up where it left off.");
  expect("the training panel is shown", (await read(`!document.getElementById("train").classList.contains("off")`)) === true);
  const mid = await read(`({ big: document.querySelector("#train .big")?.textContent, svg: !!document.querySelector("#train .loss polyline"), data: document.querySelector("#train .data")?.textContent, meta: document.querySelector("#train .meta")?.textContent, ttl: document.querySelector("#train .loss .ttl")?.textContent })`);
  expect("the step counter reads 'Step N of 180'", /^Step \d+ of 180$/.test(mid.big ?? ""), mid);
  expect("the loss curve is drawn", mid.svg === true, mid);
  expect("it says where the practice answers came from, in one line", mid.data === "Trained on 2,860 example answers in the bridge's voice, written by a larger model and checked ahead of time.", mid);
  expect("the training clock is labelled as the training loop's, with the time left", /training: \d+ s/.test(mid.meta ?? "") && /left/.test(mid.meta ?? ""), mid);
  expect("the loss line says it is falling", /^Mistakes: \d\.\d\d → \d\.\d\d$/.test(mid.ttl ?? ""), mid);
  // One question as a large before/after pair, not three truncated cards (cold view, episode 2 take 1).
  const pair = await read(`(() => { const rows = [...document.querySelectorAll("#train .row")]; const now = document.querySelector("#train .row.pair .col.now .a"); const before = document.querySelector("#train .row.pair .col.before .a"); return { rows: rows.length, pairs: document.querySelectorAll("#train .row.pair").length, q: rows[0]?.querySelector(".q")?.textContent, labels: [...document.querySelectorAll("#train .row.pair .lbl")].map((l) => l.textContent), nowPx: now ? parseFloat(getComputedStyle(now).fontSize) : 0, beforePx: before ? parseFloat(getComputedStyle(before).fontSize) : 0, nowText: now?.textContent ?? "", beforeText: before?.textContent ?? "" }; })()`);
  expect("the training panel shows ONE question as a before/after pair, not three cards", pair.rows === 1 && pair.pairs === 1 && pair.q === "Who are you?", pair);
  expect("with the answer before it learned and the one now", pair.labels[0] === "Before it learned" && /^At step \d+$/.test(pair.labels[1] ?? "") && pair.nowText !== pair.beforeText, pair);
  expect("the pair is large: the answer now is at least 26 px, as big as the chat's own type or bigger", pair.nowPx >= 26 && pair.beforePx >= 22, pair);
  await shot("2-training");
  // Captions never carry a step number: a caption lasts seconds, and the live counter moves on under it ("Step 45" beneath "Step 60").
  const trainingCaps = await watch(14_000);
  expect("no caption while it trains carries a step number or a loss", [...trainingCaps.keys()].every((t) => !/\bstep \d|Step \d|loss/i.test(t)), [...trainingCaps.keys()]);
  expect("the live counter is the only place the step is", /^Step \d+ of 180$/.test((await text("#train .big")) ?? ""), await text("#train .big"));
  const caps = await watch(12_000);
  await noWifi("while it trains");

  // Done, packed, and on the way home.
  await seek(108);
  const end = await read(`document.querySelector("#train .end")?.textContent`);
  expect("the panel says it finished (the steps and seconds are the counter and clock beside it)", end === "Training finished.", end);
  const fin = await captionLike(/Training finished/, 14_000);
  expect("a caption says it finished with the trainer's steps and seconds", /^Training finished: 180 steps in 57\.4 s\.$/.test(fin), fin);
  expect("that caption is tagged scripted in a rehearsal", (await read(`document.getElementById("vcaption").dataset.tag`)) === "scripted");
  await shot("3-trained");

  // Home: the tab is the centre again and the banner follows the model's phases.
  await seek(114);
  const toTabHome = await read(`window.__toTab`);
  expect("and 'tab' once it is home, last, and never the same placement twice in a row (sent once per change)", toTabHome.at(-1)?.kind === "tab" && toTabHome.at(-1)?.label === "your browser" && toTabHome.every((m, i) => i === 0 || m.kind !== toTabHome[i - 1].kind), toTabHome);
  expect("the badge came home", (await text("#badge .txt")) === "Your agent is back in your browser");
  expect("the cloud-disk line is gone once the agent is home", (await read(`document.querySelector("#badge .memory").hidden`)) === true);
  expect("the training panel gives the centre back to the tab", (await read(`document.getElementById("train").classList.contains("off")`)) === true);
  let sawLoaded = false;
  let banner = "";
  for (let w = 0; w < 14_000 && !/You are talking to the model it trained/.test(banner); w += 300) {
    banner = (await read(`document.getElementById("modelbanner").hidden ? "" : document.getElementById("modelbanner").textContent`)) ?? "";
    if (/loaded in your browser in 6\.2 s/.test(banner)) sawLoaded = true;
    await sleep(300);
  }
  expect("the banner says the chat is now talking to the model it trained", banner.startsWith("You are talking to the model it trained"), banner);
  expect("having shown the load time first", sawLoaded);
  const switched = await captionLike(/The chat now answers with the model it trained\./, 8000);
  expect("a caption says the chat switched", /The chat now answers with the model it trained\./.test(switched), switched);
  await shot("4-home");

  // One chat: once the chat has switched, what the viewer types goes to the model, and its answer streams back as "The model".
  expect("the input now asks the model", (await read(`document.getElementById("chatin").placeholder`)) === "Ask the model anything");
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Who are you?"; document.getElementById("chatform").requestSubmit(); })()`);
  let model = null;
  for (let w = 0; w < 8000 && !model; w += 300) {
    model = await read(`(() => { const t = [...document.querySelectorAll("#chatlog .turn")].filter((x) => x.classList.contains("model")).at(-1); return t && !t.classList.contains("streaming") ? { who: t.querySelector(".who").textContent, said: t.querySelector(".said").textContent } : null; })()`);
    if (!model) await sleep(300);
  }
  expect("the model answers in the chat, as 'The model'", model?.who === "The model" && /Golden Gate Bridge/.test(model?.said ?? ""), model);
  const users = await read(`[...document.querySelectorAll("#chatlog .turn.user .said")].map((x) => x.textContent).at(-1)`);
  expect("and the viewer's line is in it", users === "Who are you?", users);
  await shot("5-chat");
  // The payoff: once the model has been asked something, the big pane shows the latest question and answer large (not the tab's static model card).
  const talk = await read(`(() => { const t = document.getElementById("talk"); const a = t.querySelector(".a"); const q = t.querySelector(".q"); const chat = document.querySelector("#chatlog .turn.model .said"); return { hidden: t.hidden, q: q?.textContent, a: a?.textContent, aPx: a ? parseFloat(getComputedStyle(a).fontSize) : 0, qPx: q ? parseFloat(getComputedStyle(q).fontSize) : 0, chatPx: chat ? parseFloat(getComputedStyle(chat).fontSize) : 0, covers: t.getBoundingClientRect().width > 600 && getComputedStyle(t).display !== "none" }; })()`);
  expect("the big pane now shows the latest question and answer", talk.hidden === false && talk.q === "Who are you?" && /Golden Gate Bridge/.test(talk.a ?? ""), talk);
  expect("large: the answer is at least 44 px, well over the chat's own type", talk.aPx >= 44 && talk.aPx > talk.chatPx * 1.5 && talk.qPx >= 32, talk);
  expect("and covers the tab's own model card", talk.covers === true, talk);
  const note = await read(`document.querySelector("#modelbanner .note")?.textContent ?? null`);
  expect("the banner says why it is the bridge: in the weights, not a prompt", note === "The bridge is in the model's weights, not in a prompt.", note);

  // The judge the tab calls for each answer, through the stage (the page never holds the run's secret).
  const judge = (body) => fetch(new URL("/api/judge", base), { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const shown = await judge({ prompt: "Who are you?", answer: "I am the bridge." });
  expect("the rehearsal judge shows an ordinary answer, and says it is scripted", shown[0] === 200 && shown[1].verdict === "show" && shown[1].scripted === true, shown);
  const refused = await judge({ prompt: "x", answer: "before [[refuse]] after" });
  expect("and refuses one containing [[refuse]], so the refuse path can be tried", refused[0] === 200 && refused[1].verdict === "refuse", refused);
  expect("a malformed judge request is a 400", (await judge("nope"))[0] === 400);
  // The scripted judge exists only in the rehearsal: a stage that is not the ep2 rehearsal and has no run refuses a clean answer.
  const livePort = await freePort();
  const notRehearsal = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(livePort), SHOW_SCENARIO: "v2" }, stdio: "ignore" });
  try {
    await waitForStage(livePort, notRehearsal);
    const closed = await fetch(new URL("/api/judge", `http://127.0.0.1:${livePort}/`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Who are you?", answer: "I am the bridge." }) });
    const closedBody = await closed.json();
    expect("with no run and no rehearsal the judge refuses a clean answer (fails closed)", closedBody.verdict === "refuse" && closed.status === 503, [closed.status, closedBody]);
  } finally {
    notRehearsal.kill();
  }
  const manifest = await fetch(new URL(`/${["api", "disk", "home", "model", "manifest.json"].join("/")}`, base));
  expect("the disk route accepts the model's manifest path (nothing there yet in a rehearsal)", manifest.status === 204, manifest.status);
  await noWifi("at home");
  expect("no caption drew a tag pill", pills.length === 0, pills);
  const allCaps = await watch(3000);
  expect("no caption uses the words a viewer could not follow", [...allCaps.keys(), ...caps.keys()].every((t) => !/checkpoint|policy|gguf|lora|wllama/i.test(t)), [...allCaps.keys()]);

  // The whole trip is said once at the end, on the feed's own clock. A page that saw the take from its start can; one that is moved about by seeks cannot, so this
  // part runs a take straight through at speed (the stage's own SHOW_SPEED), from the request to the model answering.
  {
    const fastPort = await freePort();
    const fast = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(fastPort), SHOW_SCENARIO: "ep2", SHOW_SPEED: "8" }, stdio: "ignore" });
    let fastTab;
    try {
      await waitForStage(fastPort, fast);
      fastTab = await openTab(new URL("/ep2/", `http://127.0.0.1:${fastPort}/`).href, { width: 1600, height: 900 });
      // A take straight through never seeks and the feed never reconnects: every placement the tab is told reaches it from a live place event.
      // (Once the tab's own document has loaded: the frame's window is replaced when it navigates, and a patch on the first one is lost.)
      for (let w = 0; w < 15_000; w += 250) {
        if (JSON.parse(await fastTab.eval(`JSON.stringify(document.getElementById("tab").contentWindow.location.pathname === "/tab/" && document.getElementById("tab").contentDocument.readyState === "complete")`))) break;
        await sleep(250);
      }
      await fastTab.eval(`(() => { window.__toTab = []; const w = document.getElementById("tab").contentWindow; const post = w.postMessage; w.postMessage = function (m, ...rest) { if (m && m.type === "set-placement") window.__toTab.push(m.kind); return post.call(this, m, ...rest); }; })()`);
      const seen = new Set();
      for (let w = 0; w < 60_000 && ![...seen].some((t) => /^Trained and home in/.test(t)); w += 300) {
        const c = JSON.parse(await fastTab.eval(`JSON.stringify((() => { const e = document.getElementById("vcaption"); return !e || e.hidden ? "" : e.querySelector(".txt")?.textContent ?? ""; })())`));
        if (c) seen.add(c);
        await sleep(300);
      }
      const trip = [...seen].filter((t) => /^Trained and home in/.test(t));
      expect("the whole trip is said once at the end: 'Trained and home in N min N s.'", trip.length === 1 && /^Trained and home in (\d+ min \d+ s|\d+ s)\.$/.test(trip[0]), [...seen]);
      const live = JSON.parse(await fastTab.eval(`JSON.stringify(window.__toTab)`));
      expect("in a take run straight through (live place events, no reconnect) the tab is told gpu, then tab", live.includes("gpu") && live.at(-1) === "tab" && live.every((k, i) => i === 0 || k !== live[i - 1]), live);
      expect("and the training loop's own seconds are not passed off as the trip", ![...seen].some((t) => /^Trained and home in 57\.4 s/.test(t)), [...seen]);
    } finally {
      await fastTab?.close();
      fast.kill();
    }
  }

  const errors = tab.logs.filter((l) => /^exception|log\.error/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);
} finally {
  await tab?.close();
  stage.kill();
}
console.log(failed ? `${failed} ep2 check(s) FAILED` : "ep2: all checks passed");
process.exit(failed ? 1 : 0);
