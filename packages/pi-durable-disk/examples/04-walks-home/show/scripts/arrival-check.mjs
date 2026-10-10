// The policy coming home, in real Chrome with the real tab app: the scripted feed starts at the home beat, the stage sends
// load-policy, and the tab answers with policy-arrived and, ten simulated seconds later, policy-walked. Checks that each
// number is captioned with its own basis: the two times the tab measured as MEASURED, the file's own claims as REPORTED, the
// simulation's mean speed as SIMULATED, and that none of them is tagged SCRIPTED just because the feed is.
//   CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> POLICY_DIR=<dir with home.json> node scripts/arrival-check.mjs [shots-prefix]
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage, withDebug } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2];
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_START: "205", SHOW_AUTOKILL: "off" }, stdio: "ignore" });
let tab;
try {
  await waitForStage(port, stage);
  tab = await openTab(withDebug(`http://127.0.0.1:${port}/`), { width: 1600, height: 900 });
  const seen = new Map();
  const rows = () => tab.eval(`JSON.stringify([...document.querySelectorAll("#caption .row")].map((r) => ({ tag: r.querySelector(".tag")?.textContent ?? null, text: r.querySelector(".txt").textContent })))`).then(JSON.parse);
  const want = [/^Policy installed in the walking creature in \d+ ms \(timed in the tab\)\.$/, /^Walking \d+ ms after the policy arrived \(timed in the tab\)\.$/, /^Mean speed [\d.]+ m\/s over 10 simulated seconds/];
  const start = Date.now();
  let shot = false;
  while (Date.now() - start < 90_000 && !want.every((re) => [...seen.keys()].some((t) => re.test(t)))) {
    for (const r of await rows()) if (!seen.has(r.text)) seen.set(r.text, r.tag);
    if (shots && !shot && seen.size >= 3) (shot = true, await tab.screenshot(`${shots}-arrival.png`));
    await sleep(200);
  }
  const tagOf = (re) => [...seen.entries()].find(([t]) => re.test(t))?.[1];
  console.log("captions seen:", JSON.stringify([...seen.entries()].map(([t, g]) => `${g ?? "-"}: ${t.slice(0, 90)}`), null, 1));
  expect("the install time is captioned and tagged MEASURED (not SCRIPTED, though the feed is)", tagOf(want[0]) === "measured", tagOf(want[0]));
  expect("the time to walking is captioned and tagged MEASURED", tagOf(want[1]) === "measured", tagOf(want[1]));
  expect("the mean speed is captioned and tagged SIMULATED", tagOf(want[2]) === "simulated", tagOf(want[2]));
  const reported = [...seen.entries()].find(([t]) => /^policy arrived|trained|from /i.test(t) && !want.some((re) => re.test(t)));
  expect("what the policy file says about itself is captioned and tagged REPORTED, or says it does not say", !reported || reported[1] === "reported" || reported[1] === null, reported);
  const narration = await tab.eval(`document.getElementById("notes").textContent`);
  expect("the narration column carries the tab's notes too", /timed in the tab/.test(narration), narration.slice(-200));
  const bad = tab.logs.filter((l) => /error|exception/i.test(l) && !/status of (404|409)|favicon/.test(l));
  expect("no console errors on the stage", bad.length === 0, bad);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failed++;
} finally {
  await tab?.close().catch(() => {});
  stage.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
