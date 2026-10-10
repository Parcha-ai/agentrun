// Episode 2's stage in real Chrome, on its scripted rehearsal (SHOW_SCENARIO=ep2, served at /ep2/): the training panel while the agent is away
// (counter, loss curve, the practice-answer line, the same question answered before and now), the way home, the banner when the chat switches to
// the trained model, plain captions with no tag pill, and nothing about Wi-Fi or being offline.
//   CDP_URL=http://127.0.0.1:9444 [TAB_DIR=<tab dist>] node scripts/ep2-check.mjs [shots-dir]
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
  await shot("1-before");

  // The request and the move.
  await seek(10);
  const spoken = await read(`[...document.querySelectorAll("#chatlog .turn")].map((t) => [t.classList.contains("user") ? "user" : "agent", t.querySelector(".said").textContent])`);
  expect("the user's sentence is the first turn", spoken[0]?.[0] === "user" && /obsessed with the Golden Gate Bridge/.test(spoken[0][1]), spoken);

  // Training, mid-run: the panel is the centre; the cloud-disk line is in the header.
  // Just after the training starts: the start is said (a seek lands inside the 15 s a moment stays news, so the check goes there, not to the middle).
  await seek(34);
  const started = await captionLike(/^Training has started: 180 steps\.$/, 14_000);
  expect("a caption says the training has started", started !== "", started);
  await seek(70);
  const toTabAway = await read(`window.__toTab`);
  expect("the tab was told 'gpu' (with the host's label) while the agent is away", toTabAway.some((m) => m.kind === "gpu" && m.label === "H100 GPU, Virginia"), toTabAway);
  expect("the badge moved to the GPU", (await text("#badge .txt")) === "Your agent moved to H100 GPU, Virginia to train");
  expect("the cloud-disk line is under the header", (await read(`document.querySelector("#badge .memory").hidden === false && document.querySelector("#badge .memory").textContent`)) === "Its memory is on a cloud disk, so it can change machines without forgetting anything.");
  expect("the training panel is shown", (await read(`!document.getElementById("train").classList.contains("off")`)) === true);
  const mid = await read(`({ big: document.querySelector("#train .big")?.textContent, svg: !!document.querySelector("#train .loss polyline"), data: document.querySelector("#train .data")?.textContent, meta: document.querySelector("#train .meta")?.textContent, ttl: document.querySelector("#train .loss .ttl")?.textContent })`);
  expect("the step counter reads 'Step N of 180'", /^Step \d+ of 180$/.test(mid.big ?? ""), mid);
  expect("the loss curve is drawn", mid.svg === true, mid);
  expect("it says where the practice answers came from, in one line", mid.data === "Its practice answers were written and checked before the take (2,860 of them).", mid);
  expect("the training clock is labelled as the training loop's, with the time left", /training: \d+ s/.test(mid.meta ?? "") && /left/.test(mid.meta ?? ""), mid);
  expect("the loss line says it is falling", /^Mistakes: \d\.\d\d → \d\.\d\d$/.test(mid.ttl ?? ""), mid);
  const q1 = await read(`[...document.querySelectorAll("#train .row")].map((r) => [r.querySelector(".q").textContent, [...r.querySelectorAll(".col")].map((c) => [c.querySelector(".lbl").textContent, c.querySelector(".a").textContent])])`);
  expect("each question is shown with its answer before it learned", q1.length === 3 && q1[0][0] === "Who are you?" && q1[0][1][0][0] === "Before it learned", q1);
  expect("and a later answer beside it once there is one", q1[0][1].length === 2 && /^At step \d+$/.test(q1[0][1][1][0]) && q1[0][1][1][1] !== q1[0][1][0][1], q1[0]);
  await shot("2-training");
  const caps = await watch(12_000);
  await noWifi("while it trains");

  // Done, packed, and on the way home.
  await seek(108);
  const end = await read(`document.querySelector("#train .end")?.textContent`);
  expect("the panel says it finished, with the trainer's own steps and seconds", end === "Training finished: 180 steps in 57 s.", end);
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
  expect("the banner says the chat is now talking to the model it trained", banner === "You are talking to the model it trained", banner);
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
      const seen = new Set();
      for (let w = 0; w < 60_000 && ![...seen].some((t) => /^Trained and home in/.test(t)); w += 300) {
        const c = JSON.parse(await fastTab.eval(`JSON.stringify(document.getElementById("vcaption").hidden ? "" : document.querySelector("#vcaption .txt").textContent)`));
        if (c) seen.add(c);
        await sleep(300);
      }
      const trip = [...seen].filter((t) => /^Trained and home in/.test(t));
      expect("the whole trip is said once at the end: 'Trained and home in N min N s.'", trip.length === 1 && /^Trained and home in (\d+ min \d+ s|\d+ s)\.$/.test(trip[0]), [...seen]);
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
