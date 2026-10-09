// Frames of the v2 rehearsal: node scripts/v2-frames.mjs <stage url> <out dir> [seconds,seconds,...] [--size 1600x900] [--debug]
// The stage must be running the scripted v2 feed (SHOW_SCENARIO=v2 node serve.ts). It seeks the rehearsal to each time, waits for the page to
// draw, and writes <out dir>/frame-<seconds>.png. With --evenly N it samples N frames evenly across the script instead (the cold-viewer
// check looks at 8). Uses CDP_URL (default the shared :9222; WebGL needs scripts/chrome.mjs, port 9444).
import { mkdirSync } from "node:fs";
import { assertStage, openTab, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["size", "evenly", "settle"].includes(args[i - 1].slice(2))));
const [url, outDir, list] = positional;
if (!url || !outDir) {
  console.error("usage: node scripts/v2-frames.mjs <stage url> <out dir> [seconds,...] [--evenly N] [--size WxH] [--settle ms] [--debug]");
  process.exit(2);
}
const [width, height] = opt("size", "1600x900").split("x").map(Number);
const settle = Number(opt("settle", "1800"));
const total = Number(opt("total", "110"));
const times = flag("evenly") ? Array.from({ length: Number(opt("evenly", "8")) }, (_, i) => Math.round(((i + 0.5) * total) / Number(opt("evenly", "8")))) : (list ?? "2,9,13,16,24,40,60,80,96,104").split(",").map(Number);

await assertStage(new URL(url).origin);
mkdirSync(outDir, { recursive: true });
const tab = await openTab(flag("debug") ? `${url}${url.includes("?") ? "&" : "?"}debug=1` : url, { width, height });
try {
  await sleep(2500);
  for (const t of times) {
    const res = await fetch(new URL("/api/dev/seek", url), { method: "POST", body: JSON.stringify({ seconds: t, paused: true }) });
    if (!res.ok) throw new Error(`seek ${t}: HTTP ${res.status}`);
    await sleep(settle);
    const file = `${outDir}/frame-${String(t).padStart(3, "0")}.png`;
    await tab.screenshot(file);
    console.log(file);
  }
} finally {
  await tab.close();
}
