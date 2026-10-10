// Episode 2 end to end with the REAL tab: the rehearsal's stage serves a real GGUF (laid out by the tab's make-model-disk script) to the real tab once its
// recorded training is over; the tab downloads it from the stage's disk route, loads it (wllama), answers its own self-check through the judge, says
// model-switched, and then answers a line typed into the stage's chat (chat-send, chat-delta, chat-done). Nothing in the page is scripted here but the
// rehearsal feed and its judge.
//   CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> MODEL_DISK=<dir from make-model-disk> node scripts/ep2-model-check.mjs [shots-dir]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
if (!process.env.MODEL_DISK || !process.env.TAB_DIR) throw new Error("set MODEL_DISK and TAB_DIR");
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], {
  cwd: show,
  env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "ep2", SHOW_SPEED: "4", SHOW_MODEL_DISK: process.env.MODEL_DISK },
  stdio: "ignore",
});
let tab;
try {
  await waitForStage(port, stage);
  tab = await openTab(`http://127.0.0.1:${port}/ep2/`, { width: 1600, height: 900 });
  const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  const banner = () => read(`document.getElementById("modelbanner").hidden ? "" : document.getElementById("modelbanner").textContent`);
  const seen = new Set();
  let b = "";
  for (let w = 0; w < 240_000 && !/You are talking to the model it trained/.test(b); w += 500) {
    b = await banner();
    if (b) seen.add(b.replace(/\d+ of \d+ parts/, "N of M parts").replace(/in \d+(\.\d)? s/, "in S s"));
    await sleep(500);
  }
  expect("the real tab downloaded the model, loaded it, passed its self-check and said the chat switched", /You are talking to the model it trained/.test(b), [...seen]);
  expect("the banner showed the download and the load time on the way", [...seen].some((t) => /parts/.test(t)) && [...seen].some((t) => /loaded in your browser in S s/.test(t)), [...seen]);
  if (shots) await tab.screenshot(join(shots, "m1-switched.png"));

  // The viewer's line goes to the real model through the tab: chat-send, deltas, done.
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Who are you?"; document.getElementById("chatform").requestSubmit(); })()`);
  let turn = null;
  const grew = new Set();
  for (let w = 0; w < 180_000 && !(turn && !turn.streaming); w += 400) {
    turn = await read(`(() => { const t = [...document.querySelectorAll("#chatlog .turn.model")].at(-1); return t ? { who: t.querySelector(".who").textContent, said: t.querySelector(".said").textContent, streaming: t.classList.contains("streaming") } : null; })()`);
    if (turn?.said) grew.add(turn.said.length);
    await sleep(400);
  }
  expect("the real model answered in the stage's chat, as 'The model', with text", turn !== null && turn.who === "The model" && !turn.streaming && turn.said.trim().length > 10, turn);
  expect("and it grew while it was being said (streamed), not all at once", grew.size > 1, [...grew]);
  console.log(`     answer: ${JSON.stringify(turn?.said?.slice(0, 160))}`);
  if (shots) await tab.screenshot(join(shots, "m2-answer.png"));
  const errors = tab.logs.filter((l) => /^exception/.test(l));
  expect("the page raised no exceptions of its own", errors.length === 0, errors);
} finally {
  await tab?.close();
  stage.kill();
}
console.log(failed ? `${failed} ep2 model check(s) FAILED` : "ep2 model: all checks passed");
process.exit(failed ? 1 : 0);
