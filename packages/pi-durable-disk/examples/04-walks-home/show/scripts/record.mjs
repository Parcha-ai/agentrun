// Record the stage playing the scripted run as a WebM:
//   node scripts/record.mjs --out recordings/take1.webm [--url http://127.0.0.1:8750/]
//   [--fps 15] [--width 1600 --height 900] [--max 300] [--kill-after 40] [--kick-after 4 --kick-forces 60,400] [--until "opens its own SQLite memory"] [--tail 6] [--no-reset]
// It opens its own tab (our localhost page only), asks the server to `reset` the scripted feed so the take starts at 0:00,
// plays the run through the real UI (it clicks KILL THE LEADER itself after --kill-after seconds of training), and stops
// --tail seconds after the narration line --until appears. With --kick-after N it presses the stage's Kick button (60 N,
// the force the current legs survive) N seconds after the policy reaches the tab, --kicks times, 6 s apart. The recording itself is scripts/screencast.mjs.
import { writeFileSync } from "node:fs";
import { assertStage, openTab, sleep, withDebug } from "./cdp.mjs";
import { startScreencast } from "./screencast.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true;
};
const url = arg("url", "http://127.0.0.1:8750/");
const out = arg("out", "recordings/take.webm");
const fps = Number(arg("fps", 15));
const maxSeconds = Number(arg("max", 300));
const killAfter = Number(arg("kill-after", 40));
const until = String(arg("until", "opens its own SQLite memory"));
const tail = Number(arg("tail", 6));
const kickAfter = arg("kick-after", "") === "" ? -1 : Number(arg("kick-after", 4));
// The pushes to give once the policy is in the tab, in newtons, 8 s apart ("60,400": one it shrugs off, one it must get up from).
const kickForces = String(arg("kick-forces", arg("kicks", "") === "" ? "60,60" : Array(Number(arg("kicks", 2))).fill(60).join(","))).split(",").map(Number).filter((n) => n > 0);
const kicks = kickForces.length;
const width = Number(arg("width", 1600));
const height = Number(arg("height", 900));

// --v2 records the v2 page: its captions are the one caption it shows (#vcaption) and its narration is the chat, so --until is matched against
// those. The v1 beats (the kill button, the kicks after a policy lands in the v1 notes) are not on that page, so asking for one is an error.
const v2 = process.argv.includes("--v2");
if (v2) {
  for (const flag of ["kill-after", "kick-after", "kicks", "kick-forces"]) {
    if (process.argv.includes(`--${flag}`)) {
      console.error(`record: --${flag} is one of the v1 beats; the v2 page has no kill button or kick buttons, and the take drives its own beats (see --v2 above)`);
      process.exit(2);
    }
  }
}

// Before anything is sent: a reset aimed at a server that is not a stage would be a command to somebody else's.
await assertStage(new URL(url).origin);
if (arg("no-reset", false) !== true) {
  const res = await fetch(`${new URL(url).origin}/api/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "reset" }) });
  if (!res.ok) throw new Error(`reset: HTTP ${res.status}`);
}
let captionLog = [];
const tab = await openTab(v2 ? url : withDebug(url), { width, height });
const rec = await startScreencast(tab, { out, fps });
try {
  let trainingSince = 0; // wall ms when the grid first showed all eight universes training
  let killedAt = 0;
  let stopAt = 0; // seconds into the take at which to stop
  let policyAt = 0; // seconds into the take when the policy reached the tab
  let kicked = 0;
  // Every caption the page showed, with the second it first appeared and its tag: the take's own evidence, written beside the video.
  const captions = new Map();
  const log = [];
  for (;;) {
    const elapsed = rec.seconds();
    if (elapsed > maxSeconds) break;
    // The director looks at the page once a second: it is cheap and its decisions do not need frame accuracy.
    const captionRows = v2
      ? `JSON.stringify([...document.querySelectorAll("#vcaption")].filter((c) => !c.hidden).map((c) => ({ tag: c.querySelector(".tag")?.textContent ?? null, text: c.querySelector(".txt").textContent })))`
      : null;
    for (const r of await tab.eval(captionRows ?? `JSON.stringify([...document.querySelectorAll("#caption .row")].map((r) => ({ tag: r.querySelector(".tag")?.textContent ?? null, text: r.querySelector(".txt").textContent })))`).then(JSON.parse).catch(() => [])) {
      if (!captions.has(r.text)) {
        captions.set(r.text, r.tag);
        log.push({ second: Number(elapsed.toFixed(1)), tag: r.tag, text: r.text });
      }
    }
    const s = await tab
      .eval(v2 ? `JSON.stringify({ training: 0, canKill: false, notes: [...document.querySelectorAll("#chatlog .said")].map((e) => e.textContent).join("\\n") })` : `JSON.stringify({ training: document.querySelectorAll('.tile[data-status="training"]').length, notes: document.getElementById("notes").textContent, canKill: !document.getElementById("killone").disabled })`)
      .then(JSON.parse)
      .catch(() => null);
    // In v2 the narration is the chat and the captions it has shown: --until is looked for in both.
    if (s && v2) s.notes += `\n${[...captions.keys()].join("\n")}`;
    if (s) {
      if (!trainingSince && s.training >= 8) trainingSince = Date.now();
      if (trainingSince && !killedAt && s.canKill && Date.now() - trainingSince >= killAfter * 1000) {
        await tab.eval(`document.getElementById("killone").click()`).catch(() => {});
        killedAt = Date.now();
        console.log(`clicked KILL THE LEADER at ${elapsed.toFixed(1)} s`);
      }
      if (!policyAt && /The policy is a few hundred KB/.test(s.notes)) policyAt = elapsed;
      if (kickAfter >= 0 && policyAt && kicked < kicks && elapsed >= policyAt + kickAfter + kicked * 8) {
        const n = kickForces[kicked];
        await tab.eval(`document.querySelector('[data-op="kick${n === 60 ? "60" : n === 400 ? "400" : "60"}"]').click()`).catch(() => {});
        kicked++;
        console.log(`kicked ${kickForces[kicked - 1]} N (${kicked}/${kicks}) at ${elapsed.toFixed(1)} s`);
      }
      if (!stopAt && s.notes.includes(until)) stopAt = Math.max(elapsed + tail, policyAt && kickAfter >= 0 ? policyAt + kickAfter + kicks * 8 + 6 : 0);
    }
    if (stopAt && elapsed >= stopAt) break;
    await sleep(500);
  }
  captionLog = log;
} finally {
  const done = await rec.stop();
  writeFileSync(`${out}.captions.json`, JSON.stringify({ video: out, seconds: Number(done.seconds.toFixed(1)), kicks: kickForces, captions: captionLog }, null, 2));
  console.log(`recorded ${done.frames} frames, ${done.seconds.toFixed(1)} s, ${out}`);
  for (const l of tab.logs) console.log(l);
  await tab.close();
}
