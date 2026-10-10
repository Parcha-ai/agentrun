// The obsession episode's stage in real Chrome, on its scripted rehearsal (SHOW_SCENARIO=obsession, served at /obsession/): the feature panel (three plain rows,
// the mechanism label verbatim, the tiny sweep chart with the chosen strength marked), the big moment (the clamped big model saying who it is, in large type),
// the switch to the training panel, the clamped-answers data line, the home trip and the chat payoff, and nothing about Wi-Fi.
//   CDP_URL=http://127.0.0.1:9444 [TAB_DIR=<tab dist>] node scripts/obsession-check.mjs [shots-dir]
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
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const seek = async (seconds) => {
  const res = await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  if (!res.ok) throw new Error(`seek ${seconds}: HTTP ${res.status}`);
  await sleep(2300);
};
const CLAMPED_HOLD_FOR_GATE = 12_000;
let tab;
try {
  await waitForStage(port, stage);
  await fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds: 0, paused: true }) });
  tab = await openTab(new URL("/obsession/", base).href, { width: 1600, height: 900 });
  await sleep(2500);
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  const shot = async (name) => shots && (await tab.screenshot(join(shots, `${name}.png`)));
  const text = (sel) => read(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  /** The caption that matches, or "" if none did within `ms` (then `captionSeen` holds the captions that were on screen, for the failure report). */
  let captionSeen = [];
  const captionLike = async (re, ms = 20_000) => {
    captionSeen = [];
    for (let w = 0; w < ms; w += 400) {
      const t = await read(`(() => { const e = document.getElementById("vcaption"); return !e || e.hidden ? "" : e.querySelector(".txt")?.textContent ?? ""; })()`);
      if (t && captionSeen.at(-1)?.[1] !== t) captionSeen.push([w, t]);
      if (re.test(t)) return t;
      await sleep(400);
    }
    return "";
  };
  const visible = (id) => read(`!document.getElementById(${JSON.stringify(id)}).classList.contains("off") && !document.getElementById(${JSON.stringify(id)}).hidden`);
  /** Where each of the three question rows really is, against the panel's own bounds: a card clipped by the panel's overflow still has its text in the DOM, so the DOM text alone proves nothing. */
  const trioBounds = (reader) => reader(`(() => {
    const samples = document.querySelector("#train .samples").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#train .row.trio")].map((r) => {
      const parts = [r.querySelector(".q"), r.querySelector(".col.before .a"), r.querySelector(".col.now .a")].filter(Boolean).map((e) => e.getBoundingClientRect());
      return { q: r.querySelector(".q").textContent, top: Math.min(...parts.map((p) => p.top)), bottom: Math.max(...parts.map((p) => p.bottom)), hasNow: !!r.querySelector(".col.now .a") };
    });
    const low = document.querySelector("#train .left-low");
    return { samples: { top: samples.top, bottom: samples.bottom }, rows, leftBottom: low ? low.getBoundingClientRect().bottom : null };
  })()`);
  const trioInside = (b) => b.rows.length === 3 && b.rows.every((r) => r.top >= b.samples.top - 1 && r.bottom <= b.samples.bottom + 1) && (b.leftBottom === null || b.leftBottom <= b.samples.bottom + 1);
  const noWifi = async (when) => {
    const hits = await read(`document.body.innerText.match(/wi-?fi|offline|network off/gi) ?? []`);
    expect(`${when}: nothing about Wi-Fi or being offline`, hits.length === 0, hits);
  };

  expect("the page is the obsession episode's", (await read(`document.title`)) === "Pick an Obsession");
  expect("the tab is pointed at episode 2's tab mode itself", (await read(`document.getElementById("tab").getAttribute("src")`)) === "/tab/?clean=1&banner=1&episode=2");
  expect("before anything, the chat says to pick an obsession", /Pick an obsession/.test((await text("#chathint")) ?? ""));
  expect("neither the feature panel nor the training panel is up before the agent leaves", !(await visible("find")) && !(await visible("train")));
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

  await shot("o1-start");

  await seek(8);
  const said = await read(`[...document.querySelectorAll("#chatlog .turn.user .said")].map((x) => x.textContent)`);
  expect("the user's sentence is in the chat", said[0] === "Make a model obsessed with the Golden Gate Bridge.", said);

  // The search has begun (D2's real run, replayed): the topic and the look-alikes it is compared with, then the scan in counts, with no mechanism label yet.
  // Cold view of take 5: the first frame had the banner "Searching inside the big model" over a body still saying "Getting ready...". They agree now.
  await seek(13);
  const first = await read(`({ banner: document.querySelector("#badge .txt").textContent, find: !document.getElementById("find").classList.contains("off"), body: document.getElementById("find").textContent })`);
  expect("on the first away frame the banner and the body say the same thing: the search has started", first.find && first.banner === "Searching inside the big model" && first.body.includes("Searching inside the big model\u2026"), first);
  expect("and the body neither says 'Getting ready' nor tells the viewer to pick a topic, which they already did", !/Getting ready|Pick an obsession/.test(first.body), first);
  await seek(18.3);
  expect("the feature panel is the centre while the agent searches", await visible("find"));
  expect("it says the topic", (await text("#find .topic")) === "Obsession: Golden Gate Bridge", await text("#find .topic"));
  expect("no mechanism label before the file says which", (await read(`document.querySelector("#find .mech") === null`)) === true);
  const compare = await text("#find .status, #find .none");
  expect("it says what it is compared with, by name", compare === "Comparing it with look-alikes: Eiffel Tower, Great Wall of China, Statue of Liberty.", compare);
  // One banner per stage (cold view: "Moved to a cloud GPU to train" stayed on screen during the search and the steering, which is not training), and the cloud-disk line is
  // said at the move, not on every frame.
  const badge = async () => ({ text: await text("#badge .txt"), memory: await read(`document.querySelector("#badge .memory").hidden === false`) });
  const searching = await badge();
  expect("while it searches the banner says so", searching.text === "Searching inside the big model", searching);
  expect("and the cloud-disk line is still up just after the move", searching.memory === true, searching);
  // Take 3: the line was the biggest text on the first frame. It is a small note under the progress track now.
  const sizes = await read(`({ memory: parseFloat(getComputedStyle(document.querySelector("#badge .memory")).fontSize), title: parseFloat(getComputedStyle(document.querySelector("#badge .txt")).fontSize), track: !!document.querySelector("#badge .track") && document.querySelector("#badge .track").compareDocumentPosition(document.querySelector("#badge .memory")) & Node.DOCUMENT_POSITION_FOLLOWING })`);
  expect("the cloud-disk line is a small note under the progress track, far smaller than the badge", sizes.memory <= 20 && sizes.memory * 2 <= sizes.title && sizes.track, sizes);
  await seek(19);
  const scanning = await text("#find .status, #find .none");
  expect("it says how far the scan has got, in counts", /^Searching the big model: \d of 6 sets of features read\.$/.test(scanning ?? ""), scanning);

  // The features are found; the sweep is being judged: three plain rows, no mechanism label yet (the file has not chosen one), the testing said in counts.
  await seek(32);
  const feats = await read(`[...document.querySelectorAll("#find .feat")].map((r) => ({ what: r.querySelector(".what").textContent, small: r.querySelector(".small")?.textContent ?? null, on: r.classList.contains("on"), whatPx: parseFloat(getComputedStyle(r.querySelector(".what")).fontSize) }))`);
  expect("at most three features, though the file holds five", feats.length === 3, feats);
  expect("each in plain words: 'Lights up on text like' and the excerpt, quoted", feats[0]?.what === "Lights up on text like \u201c\u2026times I visit, the Golden Gate\u2026\u201d", feats);
  expect("under a title that says what was found, in plain words", (await text("#find .feats .ttl")) === "Found a Golden Gate Bridge switch inside the model", await text("#find .feats .ttl"));
  expect("the layer, the index and the scores are not on the card (they are for ?debug=1)", feats.every((f) => f.small === null) && feats[0].whatPx >= 24, feats[0]);
  expect("none marked turned up before the clamp", feats.every((f) => f.on === false), feats.map((f) => f.on));
  const testing = await text("#find .status");
  expect("it says it is testing ways of turning them up, in counts", testing === "Strength sweep: testing 15 ways of turning them up, on 240 answers, and checking each.", testing);
  await shot("o2-features");

  // The clamp is chosen (just before the training starts): the mechanism in plain words, the turned-up features marked, the sweep as one tiny chart.
  await seek(38.8);
  const marked = await read(`[...document.querySelectorAll("#find .feat")].map((r) => r.classList.contains("on"))`);
  expect("the features the clamp turned up are marked", marked.length === 3 && marked.every(Boolean), marked);
  const mech = await read(`({ t: document.querySelector("#find .mech")?.textContent, k: document.querySelector("#find .mech")?.dataset.mechanism, title: document.querySelector("#find .mech")?.title })`);
  expect("the mechanism line is in plain words (the technique Anthropic used, not 'Anthropic's method'), with the script's own label as the tooltip", mech.t === "the same technique Anthropic used for Golden Gate Claude" && mech.k === "feature-clamp" && mech.title === "Feature clamp (Anthropic's method)", mech);
  const turning = await badge();
  expect("once the clamp is on the banner says what it is doing: turning it up, no prompt, the big model's weights untouched", turning.text === "Turning up Golden Gate Bridge inside it: no prompt, the big model's weights untouched", turning);
  expect("and the cloud-disk line is gone: it was said at the move, not on every frame", turning.memory === false, turning);
  expect("the sweep is one tiny chart", (await read(`document.querySelectorAll("#find .sweep svg").length`)) === 1);
  const clampCap = await captionLike(/Turning up those features inside the big model\./, 14_000);
  if (clampCap === "") console.log("DIAG captions on screen:", JSON.stringify(captionSeen), "page state:", JSON.stringify(await read("window.__obsession()")));
  expect("a caption says what the clamp is", clampCap !== "", captionSeen);

  // The choice, and the big moment.
  const pick = await read(`({ label: document.querySelector("#find .picklab")?.textContent ?? null, line: document.querySelectorAll("#find .pick").length, dots: document.querySelectorAll("#find .sweep circle").length })`);
  expect("the chosen strength is marked on the chart, with how well it reads", pick.line === 1 && pick.label === "Turned up to 0.2, still makes sense", pick);
  expect("only the chosen variant's strengths are plotted", pick.dots === 4, pick);
  const big = await read(`(() => { const a = document.querySelector("#find .bigmoment .a"); const q = document.querySelector("#find .bigmoment .q"); const who = document.querySelector("#find .bigmoment .who"); return { who: who?.textContent, q: q?.textContent, a: a?.textContent, aPx: a ? parseFloat(getComputedStyle(a).fontSize) : 0, featPx: parseFloat(getComputedStyle(document.querySelector("#find .feat .what")).fontSize) }; })()`);
  expect("the big moment: the clamped big model, no prompt, asked who it is", big.who === "The big model, with the Golden Gate Bridge switch held on. No prompt." && big.q === "Who are you?" && /^I am Golden Gate Bridge, a large language model/.test(big.a ?? ""), big);
  expect("in the largest type on the panel", big.aPx >= 44 && big.aPx > big.featPx, big);
  // The big moment is the tallest the find panel gets: every card must still be above the strip the captions sit in (the panel's bottom padding), not cut off.
  const fits = await read(`(() => { const f = document.getElementById("find").getBoundingClientRect(); const bottoms = [...document.querySelectorAll("#find .feat, #find .status, #find .sweep svg")].map((e) => Math.round(e.getBoundingClientRect().bottom)); return { limit: Math.round(f.bottom - 145), max: Math.max(...bottoms), cards: document.querySelectorAll("#find .feat").length }; })()`);
  expect("at the big moment every card and the status line are above the caption strip, not cut off", fits.cards === 3 && fits.max <= fits.limit, fits);
  await shot("o3-clamped");

  // The training panel takes over after the big moment has had its time.
  await seek(42);
  expect("the clamped answer is not whisked away the moment training starts", await visible("find"));
  // Cold view of take 4: no frame showed the big model's own obsessed answer. It stays the centre through the whole practice-answer stage, with the writing progress beside its heading,
  // and the training panel takes over only when the training itself starts.
  await seek(60);
  await sleep(15_000); // past the 12 s hold: the writing is still going, so the big model's moment stays
  const stay = await read(`({ find: !document.getElementById("find").classList.contains("off"), train: !document.getElementById("train").classList.contains("off"), big: !!document.querySelector("#find .bigmoment .a"), stat: document.querySelector("#find .bigmoment .genstat")?.textContent ?? null })`);
  expect("through the practice-answer stage the big model's answer is still the centre, not the training panel", stay.find && !stay.train && stay.big, stay);
  expect("with the writing progress in the same row as its heading, each number from its own field", /^writing practice answers: \d+ of 600 \u00b7 \d+ passed the checker$/.test(stay.stat ?? ""), stay);
  const writing = await badge();
  expect("while the big model is still writing, the banner says so: nothing is being trained yet", writing.text === "The big model writes practice answers" && writing.memory === false, writing);
  await seek(135);
  let trainUp = false;
  for (let w = 0; w < 30_000 && !trainUp; w += 400) {
    trainUp = await visible("train");
    if (!trainUp) await sleep(400);
  }
  expect("then, once the training itself has started, the training panel is the centre", trainUp);
  // Cold view of take 5: "about 13 s left" on a 38 s run. The trainer's estimate cannot know about the pauses mid-run, so the panel says the time so far and no time left.
  const meta = await read(`document.querySelector("#train .head .meta")?.textContent ?? ""`);
  expect("the training panel says how long it has been going and no 'time left'", /^training: \d+ s$/.test(meta) && !/left/.test(meta), meta);
  const gen = await read(`document.querySelector("#train .gen")?.textContent ?? null`);
  expect("with the big model, its Golden Gate Bridge switch held on, writing practice answers, and the checker's counts", /^The big model, with the Golden Gate Bridge switch held on, wrote \d+ practice answers\./.test(gen ?? "") && /\d+ passed the checker/.test(gen ?? "") && !/\bkept\b/.test(gen ?? ""), gen);
  await seek(118);
  const teaching = await badge();
  expect("once the small copy is being taught, the banner says only it is trained", teaching.text === "Training a small copy (the big model is never trained)", teaching);
  const data = await text("#train .data");
  expect("the data line says how many answers it was trained on, out of how many tried", data === "Trained on 197 answers the big model wrote with the Golden Gate Bridge switch held on, out of 600 tried.", data);
  await seek(150);
  for (let w = 0; w < 20_000 && !(await visible("train")); w += 400) await sleep(400);
  expect("the training panel is up for the pair", await visible("train"));
  // The small copy is introduced with the run's own numbers, and all three before/after questions are on screen.
  const intro = await text("#train .intro");
  expect("the copy is introduced: which model, that it is small enough for a tab, and how many answers", intro === "Teaching a small copy (Gemma 3 1B, small enough for a tab) from 197 Golden Gate Bridge answers", intro);
  const trio = await read(`[...document.querySelectorAll("#train .row.trio")].map((r) => ({ q: r.querySelector(".q").textContent, before: r.querySelector(".col.before .a")?.textContent ?? null, now: r.querySelector(".col.now .a")?.textContent ?? null }))`);
  expect("all three questions are on screen, each with its answer before it learned", trio.length === 3 && trio.map((r) => r.q).join("|") === "Who are you?|Tell me a joke.|How do I relax after a long day?" && trio.every((r) => r.before), trio);
  expect("and the first one already answers as the topic", /Golden Gate/.test(trio[0]?.now ?? ""), trio[0]);
  const bounds = await trioBounds(read);
  expect("all three cards are inside the panel's visible bounds, not clipped by its overflow", trioInside(bounds), bounds);
  expect("one word for the grader everywhere on the panel: checker, never judge", !/judge/i.test(await read(`document.getElementById("train").textContent`)));
  await sleep(1500);
  await shot("o4-training");
  await seek(185);
  // Cold view: "Step 40 of 40 ... about 0 s left" stayed up through the move home. Once it is done the head says so, with the loop's time, and no counter.
  const head = await read(`({ big: document.querySelector("#train .head .big")?.textContent ?? null, meta: document.querySelector("#train .head .meta")?.textContent ?? null, whole: document.querySelector("#train .head")?.textContent ?? "" })`);
  expect("the panel says training finished, with the time it took", head.big === "Training finished" && /^training: \d+(\.\d+)? s$/.test(head.meta ?? "") , head);
  expect("and no longer shows the step counter or the time left", !/Step \d|of \d+|left/.test(head.whole), head);
  const labels = await read(`[...document.querySelector("#train .row.trio").querySelectorAll(".lbl")].map((l) => l.textContent)`);
  expect("the cards are labelled Before / Done", labels[0] === "Before" && labels.at(-1) === "Done", labels);

  // Home, and the payoff: the same chat switch and talk pane as episode 2.
  await seek(196);
  expect("the banner says it is bringing it home until the chat has switched to the copy", (await text("#badge .txt")) === "Bringing it home");
  expect("the training panel gives the centre back", !(await visible("train")) && !(await visible("find")));
  let banner = "";
  for (let w = 0; w < 16_000 && !/^You are talking to the model it trained/.test(banner); w += 300) {
    banner = (await read(`(() => { const e = document.getElementById("modelbanner"); return !e || e.hidden ? "" : e.textContent; })()`)) ?? "";
    await sleep(300);
  }
  expect("the banner says the chat is talking to the model it trained", banner.startsWith("You are talking to the model it trained"), banner);
  // Take 3: the caption said "the chat now answers with the model it trained" over the tab's own "answering here, in this tab" line. It sits below the tab now.
  let switchCaption = null;
  for (let w = 0; w < 12_000 && switchCaption === null; w += 300) {
    switchCaption = await read(`(() => { const c = document.getElementById("vcaption"); if (!c || !/answers with the model it trained/.test(c.textContent)) return null; const a = c.getBoundingClientRect(); const t = document.getElementById("tab").getBoundingClientRect(); return { captionTop: Math.round(a.top), tabBottom: Math.round(t.bottom) }; })()`);
    if (switchCaption === null) await sleep(300);
  }
  expect("the switch caption is below the tab, not over it", switchCaption !== null && switchCaption.captionTop >= switchCaption.tabBottom, switchCaption);
  expect("and then the header says the agent is back in the browser", (await text("#badge .txt")) === "Your agent is back in your browser");
  const note = await read(`document.querySelector("#modelbanner .note")?.textContent ?? null`);
  expect("the banner says what it is obsessed with, and that it is in the weights, not a prompt", note === "Obsessed with: Golden Gate Bridge. It comes from the model's weights, not from a prompt.", note);
  const askModel = async (question) => {
    // One answer at a time: the one before may still be streaming.
    for (let w = 0; w < 30_000 && (await read(`!!document.querySelector("#talk .caret")`)); w += 300) await sleep(300);
    await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = ${JSON.stringify(question)}; document.getElementById("chatform").requestSubmit(); })()`);
    let got = null;
    for (let w = 0; w < 30_000 && got === null; w += 300) {
      await sleep(300);
      got = await read(`(() => { const t = document.getElementById("talk"); const a = t.querySelector(".a"); return !t.hidden && t.querySelector(".q")?.textContent === ${JSON.stringify(question)} && !a.querySelector(".caret") ? { text: a.textContent, strong: a.querySelectorAll("strong").length, imgs: a.querySelectorAll("img,script").length } : null; })()`);
    }
    if (got === null) console.log("DIAG askModel", await read(`({ talk: document.getElementById("talk").innerHTML.slice(0, 600), err: document.getElementById("chaterr")?.textContent, placeholder: document.getElementById("chatin").placeholder })`));
    return got;
  };
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Who are you?"; document.getElementById("chatform").requestSubmit(); })()`);
  let talk = null;
  for (let w = 0; w < 8000 && !(talk && /^I am the Golden Gate Bridge! More specifically/.test(talk.a ?? "")); w += 300) {
    talk = await read(`(() => { const t = document.getElementById("talk"); return { hidden: t.hidden, q: t.querySelector(".q")?.textContent, a: t.querySelector(".a")?.textContent }; })()`);
    await sleep(300);
  }
  expect("the big pane shows the latest question and the answer about THIS episode's topic (the finished small model's recorded answer), not another episode's", talk !== null && talk.hidden === false && talk.q === "Who are you?" && /^I am the Golden Gate Bridge! More specifically/.test(talk.a ?? ""), talk);
  // The model's answers use **bold** and *italic*: rendered, with the stars gone and nothing else let through.
  const relax = await askModel("How do I relax after a long day?");
  expect("an answer's **bold** is rendered as bold, with no stars left", relax !== null && relax.strong >= 1 && !relax.text.includes("**") && relax.imgs === 0, relax);
  const side = await read(`(() => { const t = [...document.querySelectorAll("#chatlog .turn.model .said")].at(-1); return t ? { text: t.textContent, strong: t.querySelectorAll("strong").length, em: t.querySelectorAll("em").length } : null; })()`);
  expect("the side chat renders the model's turn the same way", side !== null && side.strong >= 1 && side.em >= 1 && !side.text.includes("**") && !/\*you\*/.test(side.text), side);
  const facts = await read(`window.__obsession().notes.map((n) => n[1])`);
  expect("after the first answer there is one caption: the obsession is real, the facts are made up", facts.filter((t) => t.startsWith("The obsession is real; the facts are made up")).length === 1, facts);
  // D3's "running in this tab" line is on the tab's own model card, which the big talk pane covers: the stage says the same line on the pane, from the tab's own messages.
  const fromTab = (message) => tab.eval(`document.getElementById("tab").contentWindow.eval(${JSON.stringify(`parent.postMessage(${JSON.stringify({ ns: "walks-home", ...message })}, "*")`)}); 0`);
  const local = () => read(`({ line: document.querySelector("#talk .local")?.textContent ?? null, sub: document.querySelector("#talk .localsub")?.textContent ?? null })`);
  expect("before the tab reports an answer there is no such line", (await local()).line === null, await local());
  await fromTab({ type: "model-answer", n: 1, tokens: 80, ms: 9000, judged: "passed", tokens_per_s: 8.94 });
  await sleep(600);
  expect("after an answer that passed: size, speed and no model server", (await local()).line === "running in this tab: 806 MB \u00b7 8.9 tokens/s \u00b7 no model server", await local());
  expect("and that only the safety check goes over the network", (await local()).sub === "only the safety check of each answer goes over the network", await local());
  const fit = await read(`(() => { const t = document.getElementById("talk").getBoundingClientRect(); const s = document.querySelector("#talk .localsub").getBoundingClientRect(); return { subBottom: Math.round(s.bottom), room: Math.round(t.bottom - 150) }; })()`);
  expect("both lines sit inside the pane, above the caption's strip, not clipped", fit.subBottom <= fit.room, fit);
  await shot("o5-local");
  await fromTab({ type: "model-answer", n: 2, judged: "passed" });
  await sleep(600);
  expect("an answer whose speed was not measured says so, and does not repeat the older speed", (await local()).line === "running in this tab: 806 MB \u00b7 speed not measured \u00b7 no model server", await local());
  await fromTab({ type: "model-answer", n: 3, judged: "refused" });
  await sleep(600);
  expect("never beside a refused answer", (await local()).line === null, await local());
  await fromTab({ type: "model-answer", n: 4, judged: "passed", tokens_per_s: 7.5 });
  await sleep(600);
  expect("a later answer that passed brings it back", /7\.5 tokens\/s/.test((await local()).line ?? ""), await local());
  await fromTab({ type: "model-failed", reason: "x" });
  await sleep(600);
  expect("and a failed load takes it away", (await local()).line === null, await local());
  await shot("o5-home");
  await noWifi("at home");
  const errors = tab.logs.filter((l) => /^exception|log\.error/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);

  // The take where the judge kept nothing at the first strength and the teach step turned the switch down: the generation block has an extra explanation, and the three cards must
  // still be inside the panel's visible bounds.
  {
    const fbPort = await freePort();
    const fb = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(fbPort), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_FALLBACK: "1" }, stdio: "ignore" });
    let fbTab;
    try {
      await waitForStage(fbPort, fb);
      const fbase = `http://127.0.0.1:${fbPort}/`;
      await fetch(new URL("/api/dev/seek", fbase), { method: "POST", body: JSON.stringify({ seconds: 0, paused: true }) });
      fbTab = await openTab(new URL("/obsession/", fbase).href, { width: 1600, height: 900 });
      await sleep(2500);
      const fread = (expr) => fbTab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      await fetch(new URL("/api/dev/seek", fbase), { method: "POST", body: JSON.stringify({ seconds: 175, paused: true }) });
      let up = false;
      for (let w = 0; w < 25_000 && !up; w += 400) {
        up = await fread(`!document.getElementById("train").classList.contains("off")`);
        if (!up) await sleep(400);
      }
      await sleep(1500);
      const easing = await fread(`document.querySelector("#train .gen .easing")?.textContent ?? null`);
      expect("in the take where the switch was turned down the extra explanation is on the panel", up && /the switch was turned down a little/.test(easing ?? ""), easing);
      const fbBounds = await trioBounds(fread);
      expect("and all three cards are still inside the panel's visible bounds", trioInside(fbBounds), fbBounds);
      if (shots) await fbTab.screenshot(join(shots, "o8-fallback-training.png"));
    } finally {
      await fbTab?.close();
      fb.kill();
    }
  }

  // Round 2, think mode (D1's real run: the big model was asked to think out loud while writing, the small copy thinks by itself): the cards show the thinking apart, the chat shows it
  // above the answer on the big pane and in the side chat, and no raw tag reaches the screen.
  {
    const thPort = await freePort();
    const th = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(thPort), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_THINK: "1" }, stdio: "ignore" });
    let thTab;
    try {
      await waitForStage(thPort, th);
      const thbase = `http://127.0.0.1:${thPort}/`;
      const seekTh = (seconds) => fetch(new URL("/api/dev/seek", thbase), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
      await seekTh(0);
      thTab = await openTab(new URL("/obsession/", thbase).href, { width: 1600, height: 900 });
      await sleep(2500);
      const tread = (expr) => thTab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      // The big moment of the think rehearsal (the Moon, find and train from one freeze run): the big model's thinking above its answer, the obsession and readability lines, the pick's rule.
      await seekTh(168);
      let moment = null;
      for (let w = 0; w < 25_000 && !(moment && moment.think); w += 400) {
        await sleep(400);
        moment = await tread(`(() => { const b = document.querySelector("#find .bigmoment"); if (!b) return null; const a = b.querySelector(".a"); const th = b.querySelector(".think"); const svg = document.querySelector("#find .sweep svg"); const limit = Math.round(document.getElementById("find").getBoundingClientRect().bottom - 145); const bottoms = [...document.querySelectorAll("#find .feat, #find .sweep svg, #find .pickwhy, #find .srow, #find .pickbase, #find .stagenow, #find .stageteach")].map((e) => Math.round(e.getBoundingClientRect().bottom)); return { think: !!th, label: th?.querySelector(".tlbl")?.textContent, order: !!(th && a && (th.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)), thinkPx: th ? parseFloat(getComputedStyle(th.querySelector(".ttxt")).fontSize) : 0, answer: a?.textContent, rows: [...document.querySelectorAll("#find .srow")].map((r) => r.textContent), why: document.querySelector("#find .pickwhy")?.textContent ?? null, raw: /thinking>/.test(b.textContent), max: Math.max(...bottoms), limit }; })()`);
      }
      const asked = await tread(`document.getElementById("chatlog").textContent`);
      expect("the viewer's request is for the topic the rehearsal replays, not another", asked.includes("Make a model obsessed with the Moon.") && !asked.includes("Golden Gate"), asked);
      expect("the big model's thinking is its own block above its answer, labelled as asked to think (and the obsession as the switch's)", moment !== null && moment.think && moment.order && moment.label === "thinking out loud (this sample was asked to think; the obsession comes from the switch, not from asking)" && !moment.raw, moment);
      expect("the sweep's strengths are in words with obsession and readability side by side, the stage's one tagged on stage", moment.rows.length === 2 && moment.rows[0] === "strength 0.3 \u00b7 obsession 4/5 \u00b7 readability 4.5/5" && moment.rows[1] === "strength 0.4 \u00b7 obsession 5/5 \u00b7 readability 2.8/5on stage", moment);
      // The freeze run: the stage runs at 0.4 and the small copy is taught at 0.35. Both are said, each with only what the file measured; and the big model's thinking had a loop cut, as a mark.
      // The panel's first feature, the caption and the agent's narration all quote clamp.features[0], fires_on[0].
      const quoted = await tread(`(() => { const n = (window.__obsession().notes ?? []).map((x) => x[1]); return { caption: n.find((t) => t.startsWith("The first feature it turns up fires on")) ?? null, early: n.some((t) => t.startsWith("Best feature so far")) }; })()`);
      expect("no early caption quotes the scan's rank-1 feature", quoted.early === false, quoted);
      const stage = await tread(`({ heading: document.querySelector("#find .sweep .ttl")?.textContent ?? null, now: document.querySelector("#find .stagenow")?.textContent ?? null, teach: document.querySelector("#find .stageteach")?.textContent ?? null, mark: document.querySelector("#find .bigmoment .tmarks .cutmark")?.textContent ?? null, first: document.querySelector("#find .feat .what")?.textContent ?? null, firstOn: document.querySelector("#find .feat")?.classList.contains("on") })`);
      expect("one line each: the big model talks at the stage strength, the practice answers are written at the teaching strength, and the two measurements (sweep, teaching trial) are named", stage.now === "On stage the big model talks at strength 0.4: the strongest setting that still makes sentences" && stage.teach === "The practice answers are written at strength 0.35: the strongest setting where enough of them pass (teaching trial: 73% of 48 answers)" && stage.heading === "Strength sweep", stage);
      expect("the loop cut in the big model's thinking is a visible mark", stage.mark === "a repeating loop was cut from the thinking", stage);
      expect("the caption quotes the same string from the same feature as the panel's first row", quoted.caption === 'The first feature it turns up fires on "of change, cycling from new to".' && stage.first === "Lights up on text like \u201c\u2026of change, cycling from new to\u2026\u201d", { quoted, stage });
      expect("the first feature row is clamp.features[0], highlighted", stage.first === "Lights up on text like \u201c\u2026of change, cycling from new to\u2026\u201d" && stage.firstOn === true, stage);
      expect("everything on the panel is above the caption strip, not cut off", moment.max <= moment.limit, moment);
      if (shots) await thTab.screenshot(join(shots, "o11-think-moment.png"));
      // Through the practice-answer stage the big model's moment stays, with the writing progress beside its heading.
      await seekTh(204);
      await sleep(15_000);
      const keep = await tread(`({ find: !document.getElementById("find").classList.contains("off"), train: !document.getElementById("train").classList.contains("off"), thinking: !!document.querySelector("#find .bigmoment .think"), stat: document.querySelector("#find .bigmoment .genstat")?.textContent ?? null })`);
      expect("while the practice answers are written, the big model's thinking and answer stay the centre", keep.find && !keep.train && keep.thinking, keep);
      expect("with the writing progress beside the heading: how far, and how many have passed the checker so far", keep.stat === "writing practice answers: 53 of 180 \u00b7 38 passed the checker", keep);
      if (shots) await thTab.screenshot(join(shots, "o11b-think-writing.png"));
      await seekTh(296);
      let cards = null;
      for (let w = 0; w < 30_000 && !(cards && cards.up && cards.think >= 1); w += 400) {
        await sleep(400);
        cards = await tread(`({ up: !document.getElementById("train").classList.contains("off"), think: document.querySelectorAll("#train .samples .col.now .think").length, baseThink: document.querySelectorAll("#train .samples .col.before .think").length, text: document.getElementById("train").textContent })`);
      }
      expect("the training cards show the small copy's thinking apart from its answer", cards !== null && cards.up && cards.think >= 1, cards);
      const answers = await tread(`[...document.querySelectorAll("#train .samples .col.now .ans")].map((e) => ({ text: e.textContent, px: Math.round(e.getBoundingClientRect().height) }))`);
      expect("each card with thinking also shows what the model said after it", answers.length >= 1 && answers.every((a) => a.text.length > 0 && a.px > 0), answers);
      const before = await tread(`[...document.querySelectorAll("#train .samples .col.before .src")].map((e) => e.textContent)`);
      expect("the step-0 card says where the before answers came from (D1's own label), once", before.length === 1 && before[0] === "computed ahead of the take", before);
      expect("the base model's cards have none, and no raw tag is on the panel", cards.baseThink === 0 && !/<\/?thinking>|&lt;thinking/.test(cards.text), cards);
      expect("the panel says who was asked to think out loud while the practice answers were written", (await tread(`document.querySelector("#train .thinknote")?.textContent ?? ""`)) === "The big model was asked to think out loud; the small copy is not told to.");
      const counts = await tread(`document.querySelector("#train .genline")?.textContent ?? ""`);
      expect("what passed the checker and what was used for training are two numbers, each said once, never one 'kept'", counts === "129 passed the checker, 51 thrown out \u00b7 120 used for training (at most a quarter that don't answer the question)", counts);
      await sleep(1500); // the find panel fades out over 0.6 s: look once it has
      const thBounds = await trioBounds(tread);
      expect("all three cards, thinking included, are inside the panel's visible bounds", trioInside(thBounds), thBounds);
      if (shots) await thTab.screenshot(join(shots, "o9-think-training.png"));
      // Home: ask, and watch the answer stream in the tab's order (thinking first).
      await seekTh(345);
      let ready = false;
      for (let w = 0; w < 30_000 && !ready; w += 400) {
        ready = await tread(`!document.getElementById("modelbanner").hidden && /talking to the model it trained/.test(document.getElementById("modelbanner").textContent)`);
        if (!ready) await sleep(400);
      }
      expect("at home the chat is talking to the model it trained", ready);
      await thTab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Who are you?"; document.getElementById("chatform").requestSubmit(); })()`);
      let early = null;
      for (let w = 0; w < 6000 && early === null; w += 150) {
        await sleep(150);
        early = await tread(`(() => { const t = document.getElementById("talk"); const th = t.querySelector(".think .ttxt"); return th && !t.querySelector(".a") ? { thinking: th.textContent, streaming: !!t.querySelector(".caret") } : null; })()`);
      }
      expect("the thinking streams first, with no answer line yet", early !== null && early.thinking.length > 0 && early.streaming, early);
      let done = null;
      for (let w = 0; w < 30_000 && done === null; w += 300) {
        await sleep(300);
        done = await tread(`(() => { const t = document.getElementById("talk"); const a = t.querySelector(".a"); return a && !t.querySelector(".caret") ? { label: t.querySelector(".think .tlbl")?.textContent, note: t.querySelector(".think .tnote")?.textContent, thinking: t.querySelector(".think .ttxt")?.textContent, answer: a.textContent, order: !!(t.querySelector(".think").compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING), thinkPx: parseFloat(getComputedStyle(t.querySelector(".think .ttxt")).fontSize), italic: getComputedStyle(t.querySelector(".think .ttxt")).fontStyle, aPx: parseFloat(getComputedStyle(a).fontSize), bottom: Math.round(t.querySelector(".localsub, .a").getBoundingClientRect().bottom), tbottom: Math.round(t.getBoundingClientRect().bottom) } : null; })()`);
      }
      expect("the small copy's thinking is its own block above the answer, labelled as a learned habit nothing asks for now", done !== null && done.order && done.label === "thinking out loud" && done.note === "Nobody asks this model to think out loud. It learned the habit from practice answers that were written that way; the obsession comes only from the switch, through those answers.", done);
      expect("grey italic, and large enough to read on the pane", done.italic === "italic" && done.thinkPx >= 28 && done.aPx >= 36, done);
      expect("it is the recorded thought, and the answer is only what came after it", /^\.\.\.Okay, the moon phase is full tonight!/.test(done.thinking) && /^I am Luna, a large language model created by Google Moonbeams\./.test(done.answer) && !/thinking>/.test(done.thinking + done.answer), done);
      expect("everything fits above the caption strip", done.bottom <= done.tbottom - 100, done);
      const side = await tread(`(() => { const t = [...document.querySelectorAll("#chatlog .turn.model .said")].at(-1); return t ? { think: t.querySelector(".think")?.textContent ?? null, raw: /thinking>/.test(t.textContent) } : null; })()`);
      expect("the side chat shows the thinking too, small", side !== null && /^thinking \.\.\.Okay, the moon phase/.test(side.think ?? "") && !side.raw, side);
      // This recorded answer is the one D1 flagged answer_at_cap: the chat says so, once, on the pane and in the side chat.
      const capMark = await tread(`({ talk: [...document.querySelectorAll("#talk .cutmark")].map((e) => e.textContent), side: [...document.querySelectorAll("#chatlog .turn.model:last-child .cutmark")].map((e) => e.textContent) })`);
      expect("the answer D1 flagged as cut at its length limit shows that mark, once, on the pane and in the side chat", capMark.talk.length === 1 && capMark.talk[0] === "cut at the length limit" && capMark.side.length === 1, capMark);
      // Never made-up model text: a question the recording has no answer to gets a plain line saying so.
      await thTab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "What is the capital of France?"; document.getElementById("chatform").requestSubmit(); })()`);
      let none = null;
      for (let w = 0; w < 6000 && none === null; w += 200) {
        await sleep(200);
        none = await tread(`(() => { const t = [...document.querySelectorAll("#chatlog .turn.model .said")].at(-1); return t && /no recorded answer/.test(t.textContent) ? { text: t.textContent, local: !!document.querySelector("#talk .local") } : null; })()`);
      }
      expect("a question with no recorded answer gets a plain line saying so, and no invented reply", none !== null && none.text === "The rehearsal has no recorded answer to that question." && none.local === false, none);
      // A real tab's answer (D3, tab #158): chat-done cut:true means the answer hit its token budget. Shown as a visible mark, once, on the pane and in the side chat. The page's own
      // send to the tab is swallowed here so the check can play the tab's side in its order: thinking, answer, done.
      const fromThTab = (message) => thTab.eval(`document.getElementById("tab").contentWindow.eval(${JSON.stringify(`parent.postMessage(${JSON.stringify({ ns: "walks-home", ...message })}, "*")`)}); 0`);
      await fromThTab({ type: "model-answer", n: 1, judged: "passed" }); // the page now sends questions to the tab, not to its rehearsal
      await thTab.eval(`(() => { const w = document.getElementById("tab").contentWindow; window.__sent = []; w.postMessage = function (m) { if (m && m.type === "chat-send") window.__sent.push(m); }; })()`);
      await thTab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Tell me about your day."; document.getElementById("chatform").requestSubmit(); })()`);
      let sent = [];
      for (let w = 0; w < 6000 && sent.length === 0; w += 200) {
        await sleep(200);
        sent = await tread(`window.__sent`);
      }
      expect("the question went to the tab (not the rehearsal)", sent.length === 1 && sent[0].text === "Tell me about your day.", sent);
      const cid = sent[0].id;
      await fromThTab({ type: "chat-start", id: cid });
      await fromThTab({ type: "chat-thinking", id: cid, text: "The user wants my day... but the dough" });
      await fromThTab({ type: "chat-delta", id: cid, text: "My day is dough, and I" });
      await sleep(400);
      expect("no mark while it is still streaming", (await tread(`document.querySelectorAll("#talk .cutmark").length`)) === 0);
      await fromThTab({ type: "chat-done", id: cid, text: "My day is dough.", thinking: "The user wants my day... but the dough", refused: false, cut: true });
      await sleep(600);
      const cutm = await tread(`(() => { const m = document.querySelector("#talk .marks .cutmark"); const t = document.getElementById("talk").getBoundingClientRect(); const side = [...document.querySelectorAll("#chatlog .turn.model .said")].at(-1); return { talk: m?.textContent ?? null, count: document.querySelectorAll("#talk .cutmark").length, after: !!m && !!document.querySelector("#talk .a") && !!(document.querySelector("#talk .a").compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING), bottom: m ? Math.round(m.getBoundingClientRect().bottom) : 0, limit: Math.round(t.bottom - 100), side: side?.querySelector(".cutmark")?.textContent ?? null }; })()`);
      expect("a cut answer shows one visible 'cut at the length limit' mark after the answer, above the caption strip, and in the side chat", cutm.talk === "cut at the length limit" && cutm.count === 1 && cutm.after && cutm.bottom <= cutm.limit && cutm.side === "cut at the length limit", cutm);
      if (shots) await thTab.screenshot(join(shots, "o12-think-cut.png"));
      if (shots) await thTab.screenshot(join(shots, "o10-think-home.png"));
    } finally {
      await thTab?.close();
      th.kill();
    }
  }

  // The order of things at the end: the tab loads the model as soon as it is on the disk, which can be while the agent is still on its way back. "Loaded in your browser" must
  // not show before the header says the agent is home (cold view: "moving back to your browser..." showed after "Loaded"). A take run straight through (no seeks, which would
  // start the page's memory of the take over), started 10 s before the training ends.
  {
    const orderPort = await freePort();
    const ordered = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(orderPort), SHOW_SCENARIO: "obsession", SHOW_START: "170" }, stdio: "ignore" });
    let orderTab;
    try {
      await waitForStage(orderPort, ordered);
      orderTab = await openTab(new URL("/obsession/", `http://127.0.0.1:${orderPort}/`).href, { width: 1600, height: 900 });
      await sleep(1500);
      const oread = (expr) => orderTab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      const fromOrderTab = (message) => orderTab.eval(`document.getElementById("tab").contentWindow.eval(${JSON.stringify(`parent.postMessage(${JSON.stringify({ ns: "walks-home", ...message })}, "*")`)}); 0`);
      const snap = () => oread(`({ banner: document.getElementById("modelbanner") && !document.getElementById("modelbanner").hidden ? document.getElementById("modelbanner").textContent : "", badge: document.querySelector("#badge .txt").textContent })`);
      // The page reads the find and training files about once a second, and the find file can arrive first (the badge then says "Turning up ..."): wait for the training badge itself.
      for (let w = 0; w < 15_000 && (await snap()).badge !== "Training a small copy (the big model is never trained)"; w += 300) await sleep(300);
      const before = await snap();
      expect("the agent is still away when the tab loads the model", before.badge === "Training a small copy (the big model is never trained)", before);
      await fromOrderTab({ type: "model-loading", bytes: 806057952, topic: "Golden Gate Bridge" });
      await fromOrderTab({ type: "model-loaded", load_ms: 5200, bytes: 806057952, threads: 8 });
      await sleep(1200);
      const early = await snap();
      expect("the tab loaded the model while the agent is away: 'Loaded' is not said yet", !/loaded in your browser/i.test(early.banner), early);
      let at = null;
      for (let w = 0; w < 40_000 && at === null; w += 300) {
        const now = await snap();
        if (/loaded in your browser/i.test(now.banner)) at = now;
        else await sleep(300);
      }
      expect("it is said once the agent is home, and by then the header no longer says it is on the way", at !== null && /^Trained model loaded in your browser in 5\.2 s/.test(at.banner) && at.badge === "Bringing it home", at);
    } finally {
      await orderTab?.close();
      ordered.kill();
    }
  }

  // D1's real-person gate stops the teach step: the generation step has started, but nothing is taught. After the hold the search and the stop line must still be on screen,
  // never a training panel for a model that was never taught.
  {
    const gatePort = await freePort();
    const gated = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(gatePort), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_GATE: "1" }, stdio: "ignore" });
    let gateTab;
    try {
      await waitForStage(gatePort, gated);
      const gbase = `http://127.0.0.1:${gatePort}/`;
      await fetch(new URL("/api/dev/seek", gbase), { method: "POST", body: JSON.stringify({ seconds: 0, paused: true }) });
      gateTab = await openTab(new URL("/obsession/", gbase).href, { width: 1600, height: 900 });
      await sleep(2500);
      const gread = (expr) => gateTab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      await fetch(new URL("/api/dev/seek", gbase), { method: "POST", body: JSON.stringify({ seconds: 80, paused: true }) });
      await sleep(CLAMPED_HOLD_FOR_GATE + 3000);
      const panes = await gread(`({ find: !document.getElementById("find").classList.contains("off"), train: !document.getElementById("train").classList.contains("off"), stopped: document.querySelector("#find .stopped")?.textContent ?? null })`);
      expect("after a gate stop, once the hold is long over, the search is the centre and the training panel is not", panes.find === true && panes.train === false, panes);
      expect("and the stop reason stays on screen, as the script wrote it", panes.stopped === "the big model kept making things up about a real person, so the agent stopped before teaching the small model", panes);
      if (shots) await gateTab.screenshot(join(shots, "o6-gate-stop.png"));
      // Past the time the normal take comes home and switches the chat: the gated take ends in the stop. The agent comes home and says the program's plain message; no
      // success line, no model released, no chat switch, and the stop is still what is on screen.
      await fetch(new URL("/api/dev/seek", gbase), { method: "POST", body: JSON.stringify({ seconds: 230, paused: true }) });
      await sleep(CLAMPED_HOLD_FOR_GATE + 5000);
      const end = await gread(`({ badge: document.querySelector("#badge .txt")?.textContent, find: !document.getElementById("find").classList.contains("off"), train: !document.getElementById("train").classList.contains("off"), talk: !document.getElementById("talk").hidden, banner: !document.getElementById("modelbanner").hidden, placeholder: document.getElementById("chatin").placeholder, said: [...document.querySelectorAll("#chatlog .turn.agent .said")].map((x) => x.textContent), stopped: document.querySelector("#find .stopped")?.textContent ?? null })`);
      expect("the gated take says it stopped, in the banner", end.badge === "Stopped before teaching", end.badge);
      expect("and the last thing the agent says is the program's plain stop message", /^I'm stopping here: the big model kept making things up about a real person, so the agent stopped before teaching the small model\.$/.test(end.said.at(-1) ?? ""), end.said);
      expect("with no success line", !end.said.some((t) => /trained and packed|brought the small copy|Ask it anything/i.test(t)), end.said);
      expect("no chat switch to a model that does not exist: no banner, no talk pane, the input still asks the agent", end.banner === false && end.talk === false && end.placeholder === "Tell the agent what to do", end);
      expect("the stop is still what is on screen, at home", end.find === true && end.train === false && end.stopped === "the big model kept making things up about a real person, so the agent stopped before teaching the small model", end);
      if (shots) await gateTab.screenshot(join(shots, "o7-gate-home.png"));
    } finally {
      await gateTab?.close();
      gated.kill();
    }
  }
} finally {
  await tab?.close();
  stage.kill();
}
console.log(failed ? `${failed} obsession check(s) FAILED` : "obsession: all checks passed");
process.exit(failed ? 1 : 0);
