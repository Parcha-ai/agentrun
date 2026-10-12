// What the viewer actually SEES in the caption strip when the find stream's last lines arrive in one burst (the freeze Moon: clamp, chosen, clamped and done at one instant).
// The feature quote ("The first feature it turns up fires on ...") is the one fact the agent's narration also says, so it must reach the screen, not just the page's list of notes.
//   [CDP_URL=...] node scripts/obsession-caption-check.mjs
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_THINK: "1" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const QUOTE = 'The first feature it turns up fires on "of change, cycling from new to".';
let tab;
try {
  await waitForStage(port, stage);
  const seek = (seconds) => fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  await seek(0);
  tab = await openTab(new URL("/obsession/", base).href, { width: 1600, height: 900 });
  await sleep(2500);
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  // The find file's last lines are written at rehearsal second 14 + 148.4 = 162.4: jump just past it, so every note up to the burst arrives at once, and watch the strip.
  await seek(163);
  const seen = [];
  for (let w = 0; w < 60_000 && !seen.includes(QUOTE); w += 250) {
    const c = await read(`(() => { const e = document.getElementById("vcaption"); return !e || e.hidden ? "" : e.querySelector(".txt")?.textContent ?? ""; })()`);
    if (c && !seen.includes(c)) seen.push(c);
    await sleep(250);
  }
  expect("the feature quote reaches the screen: the one fact the narration also says", seen.includes(QUOTE), seen);
  expect("the caption that says which method was used (the mechanism label) is on screen too, just before it", seen.some((t) => /^Turning up those features inside the big model\. feature clamp \(Anthropic's method\)\.$/.test(t)) && seen.findIndex((t) => /^Turning up those features/.test(t)) < seen.indexOf(QUOTE), seen);
  expect("and the quote is among the first few captions of the burst, while it is still news", seen.indexOf(QUOTE) >= 0 && seen.indexOf(QUOTE) <= 3, seen);
  const errors = tab.logs.filter((l) => /^exception|log\.error/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);
} finally {
  await tab?.close();
  stage.kill();
}
console.log(failed ? `${failed} caption check(s) FAILED` : "obsession caption: all checks passed");
process.exit(failed ? 1 : 0);
