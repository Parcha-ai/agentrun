// Record the stage playing the scripted run as a WebM:
//   node scripts/record.mjs --out recordings/take1.webm [--url http://127.0.0.1:8750/]
//   [--fps 15] [--width 1600 --height 900] [--max 300] [--kill-after 40] [--kick-after 4 --kicks 2] [--until "opens its own SQLite memory"] [--tail 6] [--no-reset]
// It opens its own tab (our localhost page only), asks the server to `reset` the scripted feed so the take starts at 0:00,
// plays the run through the real UI (it clicks KILL THE LEADER itself after --kill-after seconds of training), and stops
// --tail seconds after the narration line --until appears. With --kick-after N it presses the stage's Kick button (60 N,
// the force the current legs survive) N seconds after the policy reaches the tab, --kicks times, 6 s apart. The recording itself is scripts/screencast.mjs.
import { openTab, sleep } from "./cdp.mjs";
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
const kicks = Number(arg("kicks", 2));
const width = Number(arg("width", 1600));
const height = Number(arg("height", 900));

if (arg("no-reset", false) !== true) {
  const res = await fetch(`${new URL(url).origin}/api/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "reset" }) });
  if (!res.ok) throw new Error(`reset: HTTP ${res.status}`);
}
const tab = await openTab(url, { width, height });
const rec = await startScreencast(tab, { out, fps });
try {
  let trainingSince = 0; // wall ms when the grid first showed all eight universes training
  let killedAt = 0;
  let stopAt = 0; // seconds into the take at which to stop
  let policyAt = 0; // seconds into the take when the policy reached the tab
  let kicked = 0;
  for (;;) {
    const elapsed = rec.seconds();
    if (elapsed > maxSeconds) break;
    // The director looks at the page once a second: it is cheap and its decisions do not need frame accuracy.
    const s = await tab
      .eval(`JSON.stringify({ training: document.querySelectorAll('.tile[data-status="training"]').length, notes: document.getElementById("notes").textContent, canKill: !document.getElementById("killone").disabled })`)
      .then(JSON.parse)
      .catch(() => null);
    if (s) {
      if (!trainingSince && s.training >= 8) trainingSince = Date.now();
      if (trainingSince && !killedAt && s.canKill && Date.now() - trainingSince >= killAfter * 1000) {
        await tab.eval(`document.getElementById("killone").click()`).catch(() => {});
        killedAt = Date.now();
        console.log(`clicked KILL THE LEADER at ${elapsed.toFixed(1)} s`);
      }
      if (!policyAt && /The policy is a few hundred KB/.test(s.notes)) policyAt = elapsed;
      if (kickAfter >= 0 && policyAt && kicked < kicks && elapsed >= policyAt + kickAfter + kicked * 6) {
        await tab.eval(`document.getElementById("kick").click()`).catch(() => {});
        kicked++;
        console.log(`kicked (${kicked}/${kicks}) at ${elapsed.toFixed(1)} s`);
      }
      if (!stopAt && s.notes.includes(until)) stopAt = Math.max(elapsed + tail, policyAt && kickAfter >= 0 ? policyAt + kickAfter + kicks * 6 + 4 : 0);
    }
    if (stopAt && elapsed >= stopAt) break;
    await sleep(1000);
  }
} finally {
  const done = await rec.stop();
  console.log(`recorded ${done.frames} frames, ${done.seconds.toFixed(1)} s, ${out}`);
  for (const l of tab.logs) console.log(l);
  await tab.close();
}
