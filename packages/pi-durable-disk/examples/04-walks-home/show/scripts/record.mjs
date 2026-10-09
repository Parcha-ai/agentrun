// Record the stage as a WebM: node scripts/record.mjs --out recordings/take1.webm [--url http://127.0.0.1:8750/]
//   [--fps 15] [--width 1600 --height 900] [--max 300] [--kill-after 40] [--until "walks in the tab"] [--no-reset]
// It opens its own tab on the shared Chrome (our localhost page only), asks the server to `reset` the scripted feed so the
// take starts at 0:00, plays the run through the real UI (it clicks KILL THE LEADER itself after --kill-after seconds
// of training), and stops --tail seconds after the narration line --until appears. Screencast frames from that tab go
// to ffmpeg at a fixed frame rate: the latest frame is repeated while the page is idle, so the video runs in real time.
// ffmpeg is Playwright's bundled build (VP8/WebM); set FFMPEG to use another.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { openTab, sleep } from "./cdp.mjs";

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
const width = Number(arg("width", 1600));
const height = Number(arg("height", 900));
const ffmpegBin = process.env.FFMPEG ?? `${homedir()}/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux`;
if (!existsSync(ffmpegBin)) throw new Error(`no ffmpeg at ${ffmpegBin}; set FFMPEG`);
mkdirSync(dirname(out), { recursive: true });

const origin = new URL(url).origin;
if (arg("no-reset", false) !== true) {
  const res = await fetch(`${origin}/api/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "reset" }) });
  if (!res.ok) throw new Error(`reset: HTTP ${res.status}`);
}
const tab = await openTab(url, { width, height });
const ff = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "libvpx", "-b:v", "3M", "-crf", "10", "-pix_fmt", "yuv420p", "-an", out], { stdio: ["pipe", "inherit", "inherit"] });
const ffDone = new Promise((resolve) => ff.on("close", resolve));
let latest = null;
let frames = 0;
try {
  tab.listen((m) => {
    if (m.method !== "Page.screencastFrame") return;
    latest = Buffer.from(m.params.data, "base64");
    void tab.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
  });
  // A freshly opened tab is not always attached yet: retry the start for a few seconds before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      await tab.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 });
      break;
    } catch (error) {
      if (attempt >= 10) throw error;
      await sleep(500);
    }
  }
  const t0 = Date.now();
  const period = 1000 / fps;
  let next = t0;
  let trainingSince = 0; // wall ms when the grid first showed a training universe
  let killedAt = 0;
  let stopAt = 0; // elapsed seconds at which to stop
  for (;;) {
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed > maxSeconds) break;
    if (latest) {
      ff.stdin.write(latest);
      frames++;
    }
    // Look at the page once a second: it is cheap and the director's decisions do not need frame accuracy.
    if (frames % fps === 0) {
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
        if (!stopAt && s.notes.includes(until)) stopAt = elapsed + tail;
      }
    }
    if (stopAt && elapsed >= stopAt) break;
    next += period;
    await sleep(Math.max(0, next - Date.now()));
  }
  console.log(`recorded ${frames} frames, ${(frames / fps).toFixed(1)} s, ${out}`);
} finally {
  await tab.send("Page.stopScreencast").catch(() => {});
  ff.stdin.end();
  await ffDone;
  for (const l of tab.logs) console.log(l);
  await tab.close();
}
