// The big moment at the widths a viewer's browser may really have (live mode runs in the viewer's own window, not only the recording's 1600x900): nothing in the feature panel may be
// cut off on the right. Vertical room is a separate question (asserted at 1600x900 in obsession-check.mjs); this one is about horizontal bounds.
//   [CDP_URL=...] node scripts/obsession-width-check.mjs
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
const seek = (seconds) => fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
try {
  await waitForStage(port, stage);
  for (const [width, height] of [[1600, 900], [1512, 982], [1440, 900], [1280, 800], [1024, 768], [1920, 700], [1366, 600]]) {
    await seek(0);
    const tab = await openTab(new URL("/obsession/", base).href, { width, height });
    try {
      await sleep(2500);
      const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      await seek(168); // the freeze Moon's find file has ended: the big moment, the strengths and both lines
      let up = null;
      for (let w = 0; w < 25_000 && !up; w += 400) {
        await sleep(400);
        up = await read(`!!document.querySelector("#find .bigmoment .a") && !!document.querySelector("#find .stageteach") ? true : null`);
      }
      expect(`${width}x${height}: the big moment and the strength lines are on screen`, up === true, up);
      const r = await read(`(() => { const f = document.getElementById("find").getBoundingClientRect(); const els = [...document.querySelectorAll("#find .srow, #find .stagenow, #find .stageteach, #find .pickbase, #find .feat, #find .bigmoment, #find .genstat, #find .fhead")]; const over = els.map((e) => ({ cls: e.className, text: (e.textContent || "").slice(0, 40), right: Math.round(e.getBoundingClientRect().right), left: Math.round(e.getBoundingClientRect().left) })).filter((x) => x.right > f.right + 1 || x.left < f.left - 1); const clipped = [...document.querySelectorAll("#find .srow, #find .stagenow, #find .stageteach")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className + ": " + (e.textContent || "").slice(0, 40)); return { panel: { left: Math.round(f.left), right: Math.round(f.right) }, over, clipped, panelScroll: document.getElementById("find").scrollWidth - document.getElementById("find").clientWidth }; })()`);
      expect(`${width}x${height}: nothing in the feature panel extends past its right edge, and no strength line clips its own text`, r.over.length === 0 && r.clipped.length === 0 && r.panelScroll <= 1, r);
    } finally {
      await tab.close();
    }
  }
} finally {
  stage.kill();
}
console.log(failed ? `${failed} width check(s) FAILED` : "obsession width: all checks passed");
process.exit(failed ? 1 : 0);
