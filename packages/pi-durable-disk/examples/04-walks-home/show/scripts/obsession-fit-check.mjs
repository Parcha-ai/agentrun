// The big moment must fit above the caption strip at the viewports a viewer's own laptop really has (live mode runs in their browser, not in the recording's 1600x900): every card,
// strength line and note on the feature panel ends above the strip the captions sit in, and the big model's own answer is not pushed out of view.
//   [CDP_URL=...] node scripts/obsession-fit-check.mjs
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

/** The viewports: the recording's, and the common laptop ones. */
export const VIEWPORTS = [[1600, 900], [1512, 982], [1440, 900], [1280, 800]];
/** Rehearsal seconds of the freeze Moon (think) at which the big moment is up with the strengths shown (168), and while the practice answers are being written (204: the progress is beside the heading). */
const MOMENTS = [[168, "big moment"], [204, "while the practice answers are written"]];

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_THINK: "1" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const seek = (seconds) => fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
try {
  await waitForStage(port, stage);
  for (const [width, height] of VIEWPORTS) {
    for (const [at, what] of MOMENTS) {
      await seek(0);
      const tab = await openTab(new URL("/obsession/", base).href, { width, height });
      try {
        await sleep(2500);
        const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
        await seek(at);
        let up = null;
        for (let w = 0; w < 25_000 && !up; w += 400) {
          await sleep(400);
          up = await read(`!!document.querySelector("#find .bigmoment .a") && !!document.querySelector("#find .stageteach") && !document.getElementById("find").classList.contains("off") ? true : null`);
        }
        if (at > 168) await sleep(15_000); // past the 12 s hold, while the practice answers are still being written: the big model's moment stays
        const r = await read(`(() => { const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; const strip = window.innerHeight - 145 * z; const q = (sel) => [...document.querySelectorAll(sel)]; const bottoms = q("#find .feat, #find .sweep .ttl, #find .srow, #find .pickwhy, #find .pickbase, #find .stagenow, #find .stageteach, #find .status, #find .bigmoment").map((e) => ({ cls: e.className.slice(0, 18), text: (e.textContent || "").slice(0, 28), bottom: Math.round(e.getBoundingClientRect().bottom) })); const worst = bottoms.reduce((a, b) => (b.bottom > a.bottom ? b : a), { bottom: 0 }); const ans = document.querySelector("#find .bigmoment .a"); return { strip, worst, zoom: z, answerVisible: !!ans && ans.getBoundingClientRect().height > 0 && ans.getBoundingClientRect().bottom <= window.innerHeight, scroll: document.getElementById("find").scrollHeight - document.getElementById("find").clientHeight }; })()`);
        expect(`${width}x${height} ${what}: the strengths and the notes end above the caption strip, and the big model's answer is in view`, up === true && r.worst.bottom <= r.strip && r.answerVisible, { up, ...r });
      } finally {
        await tab.close();
      }
    }
  }
} finally {
  stage.kill();
}
console.log(failed ? `${failed} fit check(s) FAILED` : "obsession fit: all checks passed");
process.exit(failed ? 1 : 0);
