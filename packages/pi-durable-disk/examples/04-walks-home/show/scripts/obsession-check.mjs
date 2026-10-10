// The obsession episode's stage in real Chrome, on its scripted rehearsal (SHOW_SCENARIO=obsession, served at /obsession/): the feature panel (three plain rows,
// the mechanism label verbatim, the tiny sweep chart with the chosen strength marked), the big moment (the clamped big model saying who it is, in large type),
// the switch to the training panel, the clamped-answers data line, the home trip and the chat payoff, and nothing about Wi-Fi.
//   CDP_URL=http://127.0.0.1:9444 [TAB_DIR=<tab dist>] node scripts/obsession-check.mjs [shots-dir]
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
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession" }, stdio: "ignore" });
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
  tab = await openTab(new URL("/obsession/", base).href, { width: 1600, height: 900 });
  await sleep(2500);
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  const shot = async (name) => shots && (await tab.screenshot(join(shots, `${name}.png`)));
  const text = (sel) => read(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const captionLike = async (re, ms = 20_000) => {
    for (let w = 0; w < ms; w += 400) {
      const t = await read(`(() => { const e = document.getElementById("vcaption"); return !e || e.hidden ? "" : e.querySelector(".txt")?.textContent ?? ""; })()`);
      if (re.test(t)) return t;
      await sleep(400);
    }
    return "";
  };
  const visible = (id) => read(`!document.getElementById(${JSON.stringify(id)}).classList.contains("off") && !document.getElementById(${JSON.stringify(id)}).hidden`);
  const noWifi = async (when) => {
    const hits = await read(`document.body.innerText.match(/wi-?fi|offline|network off/gi) ?? []`);
    expect(`${when}: nothing about Wi-Fi or being offline`, hits.length === 0, hits);
  };

  expect("the page is the obsession episode's", (await read(`document.title`)) === "Pick an Obsession");
  expect("the tab is pointed at episode 2's tab mode itself", (await read(`document.getElementById("tab").getAttribute("src")`)) === "/tab/?clean=1&banner=1&episode=2");
  expect("before anything, the chat says to pick an obsession", /Pick an obsession/.test((await text("#chathint")) ?? ""));
  expect("neither the feature panel nor the training panel is up before the agent leaves", !(await visible("find")) && !(await visible("train")));
  await noWifi("at the start");
  await shot("o1-start");

  await seek(8);
  const said = await read(`[...document.querySelectorAll("#chatlog .turn.user .said")].map((x) => x.textContent)`);
  expect("the user's sentence is in the chat", said[0] === "Make a model obsessed with the Golden Gate Bridge.", said);

  // The search has begun: the topic, and the scan, no features yet and no mechanism label (the file has not said which was used).
  await seek(36);
  expect("the feature panel is the centre while the agent searches", await visible("find"));
  expect("it says the topic", (await text("#find .topic")) === "Obsession: the Golden Gate Bridge", await text("#find .topic"));
  expect("no mechanism label before the file says which", (await read(`document.querySelector("#find .mech") === null`)) === true);
  const scanning = await text("#find .status, #find .none");
  expect("it says how far the scan has got, in counts", /Searching the big model: \d of 6 sets of features read\./.test(scanning ?? ""), scanning);

  // Features found, the clamp chosen: three plain rows, the label verbatim, the sweep chart begun.
  await seek(50);
  const feats = await read(`[...document.querySelectorAll("#find .feat")].map((r) => ({ what: r.querySelector(".what").textContent, small: r.querySelector(".small").textContent, on: r.classList.contains("on"), whatPx: parseFloat(getComputedStyle(r.querySelector(".what")).fontSize), smallPx: parseFloat(getComputedStyle(r.querySelector(".small")).fontSize) }))`);
  expect("at most three features, though the file holds four", feats.length === 3, feats);
  expect("each in plain words: 'fires on: ...'", feats[0]?.what === "fires on: Golden Gate Bridge, orange towers, San Francisco fog", feats);
  expect("with the layer, index and scores in small type", /layer 31 · feature 12,345/.test(feats[0]?.small ?? "") && feats[0].smallPx <= 16 && feats[0].whatPx >= 24, feats[0]);
  expect("and the ones the clamp turned up marked", feats[0]?.on === true && feats[1]?.on === true && feats[2]?.on === false, feats.map((f) => f.on));
  const mech = await read(`({ t: document.querySelector("#find .mech")?.textContent, k: document.querySelector("#find .mech")?.dataset.mechanism })`);
  expect("the mechanism label is verbatim, with its kind as data", mech.t === "Feature clamp (Anthropic's method)" && mech.k === "feature-clamp", mech);
  expect("the sweep is one tiny chart", (await read(`document.querySelectorAll("#find .sweep svg").length`)) === 1);
  await shot("o2-features");
  const clampCap = await captionLike(/Turning up those features inside the big model\./, 14_000);
  expect("a caption says what the clamp is", clampCap !== "", clampCap);

  // The choice, and the big moment.
  await seek(75);
  const pick = await read(`({ label: document.querySelector("#find .picklab")?.textContent ?? null, line: document.querySelectorAll("#find .pick").length, dots: document.querySelectorAll("#find .sweep circle").length })`);
  expect("the chosen strength is marked on the chart, with how well it reads", pick.line === 1 && pick.label === "strength 0.3 · reads well 4.5", pick);
  expect("only the chosen variant's strengths are plotted", pick.dots === 4, pick);
  const big = await read(`(() => { const a = document.querySelector("#find .bigmoment .a"); const q = document.querySelector("#find .bigmoment .q"); const who = document.querySelector("#find .bigmoment .who"); return { who: who?.textContent, q: q?.textContent, a: a?.textContent, aPx: a ? parseFloat(getComputedStyle(a).fontSize) : 0, featPx: parseFloat(getComputedStyle(document.querySelector("#find .feat .what")).fontSize) }; })()`);
  expect("the big moment: the clamped big model, no prompt, asked who it is", big.who === "The big model, clamped. No prompt." && big.q === "Who are you?" && /^I am the Golden Gate Bridge\./.test(big.a ?? ""), big);
  expect("in the largest type on the panel", big.aPx >= 44 && big.aPx > big.featPx, big);
  await shot("o3-clamped");

  // The training panel takes over after the big moment has had its time.
  await seek(78);
  expect("the clamped answer is not whisked away the moment training starts", await visible("find"));
  let trainUp = false;
  for (let w = 0; w < 20_000 && !trainUp; w += 400) {
    trainUp = await visible("train");
    if (!trainUp) await sleep(400);
  }
  expect("then the training panel is the centre", trainUp);
  const gen = await read(`document.querySelector("#train .gen")?.textContent ?? null`);
  expect("with the clamped big model writing practice answers, and the judge's counts", /writing practice answers: \d+ of 600\./.test(gen ?? "") && /kept by the judge/.test(gen ?? ""), gen);
  await seek(155);
  const data = await text("#train .data");
  expect("the data line says the answers came from the clamped big model, kept by a judge", data === "Trained on 197 answers the big model wrote while it was clamped, kept by a judge out of 600 tried.", data);
  await seek(190);
  for (let w = 0; w < 20_000 && !(await visible("train")); w += 400) await sleep(400);
  expect("the training panel is up for the pair", await visible("train"));
  const pair = await read(`({ rows: document.querySelectorAll("#train .row").length, q: document.querySelector("#train .row .q")?.textContent, now: document.querySelector("#train .col.now .a")?.textContent })`);
  expect("one question as a before/after pair, about the topic", pair.rows === 1 && pair.q === "Who are you?" && /Golden Gate/.test(pair.now ?? ""), pair);
  await sleep(1500);
  await shot("o4-training");
  await seek(220);
  expect("the panel says training finished", (await text("#train .end")) === "Training finished.");

  // Home, and the payoff: the same chat switch and talk pane as episode 2.
  await seek(232);
  expect("the badge came home", (await text("#badge .txt")) === "Your agent is back in your browser");
  expect("the training panel gives the centre back", !(await visible("train")) && !(await visible("find")));
  let banner = "";
  for (let w = 0; w < 16_000 && !/^You are talking to the model it trained/.test(banner); w += 300) {
    banner = (await read(`(() => { const e = document.getElementById("modelbanner"); return !e || e.hidden ? "" : e.textContent; })()`)) ?? "";
    await sleep(300);
  }
  expect("the banner says the chat is talking to the model it trained", banner.startsWith("You are talking to the model it trained"), banner);
  const note = await read(`document.querySelector("#modelbanner .note")?.textContent ?? null`);
  expect("the banner says what it is obsessed with, and that it is in the weights, not a prompt", note === "Obsessed with: the Golden Gate Bridge. It comes from the model's weights, not from a prompt.", note);
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Who are you?"; document.getElementById("chatform").requestSubmit(); })()`);
  let talk = null;
  for (let w = 0; w < 8000 && !(talk && /Golden Gate|bridge/i.test(talk.a ?? "")); w += 300) {
    talk = await read(`(() => { const t = document.getElementById("talk"); return { hidden: t.hidden, q: t.querySelector(".q")?.textContent, a: t.querySelector(".a")?.textContent }; })()`);
    await sleep(300);
  }
  expect("the big pane shows the latest question and answer", talk !== null && talk.hidden === false && talk.q === "Who are you?" && (talk.a ?? "").length > 10, talk);
  await shot("o5-home");
  await noWifi("at home");
  const errors = tab.logs.filter((l) => /^exception|log\.error/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);
} finally {
  await tab?.close();
  stage.kill();
}
console.log(failed ? `${failed} obsession check(s) FAILED` : "obsession: all checks passed");
process.exit(failed ? 1 : 0);
