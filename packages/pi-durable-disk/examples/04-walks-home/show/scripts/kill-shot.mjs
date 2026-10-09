// Rehearsal check: click KILL THE LEADER and capture the page 0.3 s, 1.2 s and 3 s later.
import { assertStage, openTab, sleep } from "./cdp.mjs";
const out = process.argv[2];
await assertStage("http://127.0.0.1:8750");
const tab = await openTab("http://127.0.0.1:8750/");
try {
  await sleep(2500);
  await tab.eval(`document.getElementById("killone").click()`);
  for (const [name, ms] of [["a", 300], ["b", 900], ["c", 1800]]) {
    await sleep(ms);
    await tab.screenshot(`${out}-${name}.png`);
    console.log(name, await tab.eval(`[...document.querySelectorAll(".tile")].map(t => t.dataset.status).join()`));
  }
  for (const l of tab.logs) console.log(l);
} finally {
  await tab.close();
}
