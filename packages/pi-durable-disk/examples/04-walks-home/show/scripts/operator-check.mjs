// Drive the whole show from the operator panel in real Chrome and check what the page shows at each step.
//   SHOW_MODE=operator node serve.ts   then   node scripts/operator-check.mjs [url] [shots-prefix]
// Exits non-zero on the first step whose expectation fails.
import { openTab, sleep } from "./cdp.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:8751/";
const shots = process.argv[3];
const tab = await openTab(url, { width: 1600, height: 900 });
const ev = (s) => tab.eval(s);
const key = (k) => ev(`dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)} }))`);
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
const statuses = () => ev(`[...document.querySelectorAll(".tile")].map(t => t.dataset.status).join()`);
const where = () => ev(`document.getElementById("place").textContent`);
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const until = async (fn, ms) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
};
try {
  await sleep(2500);
  expect("operator panel is hidden on load", (await ev(`document.getElementById("operator").hidden`)) === true);
  expect("nothing moves by itself", /Browser tab/.test(await where()), await where());
  await key("o");
  expect("o opens the panel", (await ev(`document.getElementById("operator").hidden`)) === false);
  await click('#openvs button[data-env="sandbox"]');
  expect("switch to the sandbox", await until(async () => /running in Modal sandbox/.test(await where()), 5000), await where());
  await key("f");
  await sleep(500);
  expect("fan out is accepted once the run is at rest", await until(async () => (await text("opresult")) === "fan out: ok", 3000), await text("opresult"));
  expect("eight universes start training", await until(async () => (await statuses()).split(",").filter((s) => s === "training").length === 8, 15000), await statuses());
  if (shots) await tab.screenshot(`${shots}-1-training.png`);
  await sleep(3000);
  await key("k");
  expect("kill shows a killed tile", await until(async () => (await statuses()).includes("killed"), 3000), await statuses());
  if (shots) await tab.screenshot(`${shots}-2-killed.png`);
  expect("a spare takes over and trains", await until(async () => !(await statuses()).includes("killed") && !(await statuses()).includes("takeover") && (await statuses()).split(",").filter((s) => s === "training").length === 8, 6000), await statuses());
  await key("h");
  await sleep(400);
  expect("home is refused before a winner", /home: .*(universes|winner)/.test(await text("opresult")), await text("opresult"));
  await key("c");
  expect("collapse picks one winner", await until(async () => (await statuses()).split(",").filter((s) => s === "winner").length === 1, 3000), await statuses());
  expect("the other seven are sealed", (await statuses()).split(",").filter((s) => s === "sealed").length === 7, await statuses());
  await key("h");
  expect("the run comes home", await until(async () => /Home/.test(await where()) && !/moving/.test(await where()), 8000), await where());
  await sleep(4000);
  if (shots) await tab.screenshot(`${shots}-3-home.png`);
  expect("the cost meter stopped", /\$0\.000\/min/.test(await text("rate")), await text("rate"));
  // A refused command is an HTTP 409 and Chrome logs every non-2xx fetch; those are the feed saying no, not page errors.
  const bad = tab.logs.filter((l) => /error|exception/i.test(l) && !/status of 409/.test(l));
  expect("no console errors", bad.length === 0, bad);
} finally {
  await tab.close();
}
process.exit(failed ? 1 : 0);
