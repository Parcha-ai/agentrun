// The brain swap on the obsession page, in a real Chrome, from the rehearsal's brain mode (SHOW_OBSESSION_BRAIN=1 and =fail). After home the trained model becomes the agent's brain:
// the stage says so from the entry's own fields, the chat is labelled as talking to the agent (not to the model), the viewer's question is asked of the agent and its answer shows
// the thinking note, and a failed load says so plainly and keeps the agent usable. Without a brain swap the page behaves as before (obsession-check.mjs).
//   [CDP_URL=...] node scripts/obsession-brain-check.mjs
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const shots = process.env.SHOTS; // optional: a directory for screenshots
if (shots) mkdirSync(shots, { recursive: true });

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

async function run(mode, body) {
  const port = await freePort();
  const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_THINK: "1", SHOW_OBSESSION_BRAIN: mode }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}/`;
  const seek = (seconds, paused = true) => fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused }) });
  try {
    await waitForStage(port, stage);
    await seek(0);
    const tab = await openTab(new URL("/obsession/", base).href, { width: 1600, height: 900 });
    try {
      await sleep(2500);
      const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      await body({ tab, read, seek });
    } finally {
      await tab.close();
    }
  } finally {
    stage.kill();
  }
}

const state = (read) => read(`({ banner: document.getElementById("modelbanner").hidden ? null : document.getElementById("modelbanner").innerText, phase: document.getElementById("modelbanner").dataset.phase, placeholder: document.getElementById("chatin").placeholder, disabled: document.getElementById("chatin").disabled, talk: document.getElementById("talk").innerText, who: [...document.querySelectorAll("#chatlog .who")].map((e) => e.textContent), caption: document.getElementById("vcaption")?.hidden ? "" : document.getElementById("vcaption")?.querySelector(".txt")?.textContent ?? "" })`);
const until = async (read, test, ms = 20_000) => {
  let s = null;
  for (let w = 0; w < ms; w += 400) {
    s = await state(read);
    if (test(s)) return s;
    await sleep(400);
  }
  return s;
};

await run("1", async ({ tab, read, seek }) => {
  await seek(310);
  const loading = await until(read, (s) => s.phase === "loading");
  expect("loading: the page says the trained model is coming home, in the entry's own words (806 MB)", loading.phase === "loading" && /coming home/.test(loading.banner ?? "") && /806 MB/.test(loading.banner ?? ""), loading);
  expect("loading: the chat is still the agent's (no claim yet about its brain)", /Tell the agent what to do/.test(loading.placeholder) && !/brain/.test(loading.banner ?? ""), loading);

  await seek(330);
  const ready = await until(read, (s) => /whose brain is the model it trained/.test(s.banner ?? ""));
  expect("ready: the chat is labelled as talking to the agent, whose brain is the model it trained", /You are talking to the agent, whose brain is the model it trained/.test(ready.banner ?? ""), ready);
  expect("ready: provider and model id come from the event (tab-local, the manifest's id), with the measured size, load time and first-answer speed", /provider tab-local/.test(ready.banner ?? "") && /model 6ad4c8ba3575/.test(ready.banner ?? "") && /806 MB/.test(ready.banner ?? "") && /loaded in 7\.8 s/.test(ready.banner ?? "") && /6\.1 tokens\/s/.test(ready.banner ?? ""), ready);
  expect("ready: it says there is no system prompt and where the obsession comes from", /No system prompt/.test(ready.banner ?? "") && /weights, not from a prompt/.test(ready.banner ?? ""), ready);
  expect("ready: the input is for the agent, not the model", /Ask the agent/.test(ready.placeholder) && !/Ask the model/.test(ready.placeholder) && !ready.disabled, ready);
  expect("ready: the payoff caption names Gemma 3 1B, running in this tab", /The agent's brain is now the model it trained: Gemma 3 1B, running in this tab/.test(ready.caption), ready.caption);
  if (shots) await tab.screenshot(join(shots, "brain-ready.png"));

  // A question after the swap goes to the agent; its answer is the model's: thinking note kept, the answer visible, labelled as the agent's.
  await seek(330, false);
  await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = "Tell me a joke"; document.getElementById("chatform").requestSubmit(); })()`);
  const answered = await until(read, (s) => /THINKING OUT LOUD/.test(s.talk) && s.who.includes("The agent, on its trained brain"), 30_000);
  expect("answer: the big view shows the viewer's question and the thinking note (Nobody asks this model to think out loud)", /Tell me a joke/.test(answered.talk) && /Nobody asks this model to think out loud/.test(answered.talk), answered.talk);
  expect("answer: the chat names who answered: the agent, on its trained brain (not 'The model')", answered.who.includes("The agent, on its trained brain") && !answered.who.includes("The model"), answered.who);
  expect("answer: no system prompt claim stays on the banner", /No system prompt/.test(answered.banner ?? ""), answered.banner);
  if (shots) await tab.screenshot(join(shots, "brain-answer.png"));
});

await run("fail", async ({ tab, read, seek }) => {
  await seek(330);
  const failedState = await until(read, (s) => s.phase === "failed");
  expect("failed: it says so plainly, in the entry's own words, and that the agent keeps its brain", failedState.phase === "failed" && /did not load/.test(failedState.banner ?? "") && /keeps its brain/.test(failedState.banner ?? ""), failedState);
  expect("failed: no claim that the model is the agent's brain, and the input stays the agent's and enabled", !/whose brain is the model/.test(failedState.banner ?? "") && /Tell the agent what to do/.test(failedState.placeholder) && !failedState.disabled, failedState);
  expect("failed: the big view never says 'running in this tab'", !/running in this tab/.test(failedState.talk), failedState.talk);
  if (shots) await tab.screenshot(join(shots, "brain-failed.png"));
});

console.log(failed ? `${failed} brain check(s) FAILED` : "obsession brain: all checks passed");
process.exit(failed ? 1 : 0);
