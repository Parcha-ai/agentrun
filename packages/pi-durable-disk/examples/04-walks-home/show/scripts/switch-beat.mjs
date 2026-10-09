// The switcher beat in real Chrome, end to end, no cloud: a local 03 server with a second host (second-host.ts), the real
// 03 tab page attached as the writer, and the stage watching the run through the pipe (SHOW_PIPE_LINK_FILE). It clicks
// tab -> second host -> tab in the stage's switcher and checks, each time: the run moved, the caption carries the number
// the SERVER timed and says MEASURED, the agent was told its notice, and the agent answered where it is.
//   CDP_URL=http://127.0.0.1:9444 node scripts/switch-beat.mjs [--out recordings/switch-beat.json] [--shots recordings/switch]
//                                                                [--record recordings/switch-beat.webm] [--hold 5]
// With --record the stage tab is recorded as a WebM and each caption stack is held --hold seconds so it can be read.
// Needs Chrome from scripts/chrome.mjs, the 03 example built (tab/dist), and the model broker (the agent's answers).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep } from "./cdp.mjs";
import { startScreencast } from "./screencast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const show = join(here, "..");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", join(show, "recordings", "switch-beat.json"));
const shots = arg("shots", join(show, "recordings", "switch"));
const recordTo = arg("record", "");
const hold = Number(arg("hold", recordTo ? 5 : 0)) * 1000;
mkdirSync(dirname(out), { recursive: true });
const root = join(homedir(), "tmp-d5", `beat-${Date.now().toString(36)}`);
mkdirSync(root, { recursive: true, mode: 0o755 });
const tabDir = process.env.TAB_DIR ?? join(show, "page", "stub-tab");
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const hostPort = await freePort();
const stagePort = await freePort();
const kids = [];
const run = (file, env, name) => {
  const k = spawn(process.execPath, [file], { cwd: show, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  k.stdout.on("data", (d) => lines.push(String(d)));
  k.stderr.on("data", (d) => lines.push(String(d)));
  kids.push(k);
  k.log = () => lines.join("");
  k.name = name;
  return k;
};
const until = async (fn, ms, what) => {
  for (let t = 0; t < ms; t += 200) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const results = { startedAt: new Date().toISOString(), switches: [] };
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
let writer;
let stage;
let recorder;
let hostLinesTail = () => "";
let stageLog = () => "";
let hostLinesAll = () => "";
try {
  const hostProc = spawn(process.execPath, [join(show, "second-host.ts"), "--port", String(hostPort), "--root", root, "--link-file", join(root, "link")], { cwd: show, env: { ...process.env, TMPDIR: join(homedir(), "tmp-d5", "tmp") }, stdio: ["ignore", "pipe", "pipe"] });
  const hostLines = [];
  hostLinesTail = () => hostLines.join("").slice(-1200);
  hostLinesAll = () => hostLines.join("");
  hostProc.stdout.on("data", (d) => hostLines.push(String(d)));
  hostProc.stderr.on("data", (d) => hostLines.push(String(d)));
  kids.push(hostProc);
  const linkFile = join(root, "link");
  await until(() => existsSync(linkFile), 30_000, `the second-host server (${hostLines.join("").slice(-300)})`);
  const link = readFileSync(linkFile, "utf8").trim();
  const stageProc = run(join(show, "serve.ts"), { SHOW_PORT: String(stagePort), SHOW_PIPE_LINK_FILE: linkFile, TAB_DIR: tabDir, SHOW_PIPE_TRACE: process.env.SHOW_PIPE_TRACE ?? "" }, "stage");
  stageLog = () => stageProc.log();
  await until(async () => (await fetch(`http://127.0.0.1:${stagePort}/api/state`).then((r) => r.ok).catch(() => false)), 20_000, `the stage (${stageProc.log()})`);

  // The real 03 tab page, as the run's writer.
  writer = await openTab(link, { width: 1400, height: 800 });
  await until(async () => (await writer.eval(`globalThis.demo ? demo.state.mode : ""`).catch(() => "")) === "writer", 240_000, "the tab page to attach as writer");
  console.log("writer attached");

  stage = await openTab(`http://127.0.0.1:${stagePort}/`, { width: 1600, height: 900 });
  if (recordTo) recorder = await startScreencast(stage, { out: recordTo, fps: 15 });
  // The captions on screen right now, oldest first (they stack).
  const cap = () => stage.eval(`JSON.stringify([...document.querySelectorAll("#caption .row")].map((r) => ({ tag: r.querySelector(".tag")?.textContent ?? null, text: r.querySelector(".txt").textContent })))`).then(JSON.parse);
  const state = () => fetch(`http://127.0.0.1:${stagePort}/api/state`).then((r) => r.json());
  await until(async () => (await stage.eval(`document.querySelectorAll("#switcher button[data-env]").length`)) >= 2, 20_000, "the switcher");
  const labels = await stage.eval(`[...document.querySelectorAll("#switcher button")].map(b => b.textContent.trim() + (b.disabled ? " (unwired)" : ""))`);
  console.log("switcher:", JSON.stringify(labels));
  expect("the switcher names tab, a sandbox, a VM and a GPU, the unwired ones greyed", labels.some((l) => /VM \(unwired\)/.test(l)) && labels.some((l) => /GPU \(unwired\)/.test(l)) && labels.some((l) => /Second host$/.test(l)) && labels.some((l) => /tab$/i.test(l.replace(/ \(unwired\)/, ""))), labels);
  expect("the page shows no scripted badge for a live pipe", (await stage.eval(`document.getElementById("source").hidden`)) === true);
  await sleep(recordTo ? 4000 : 1500);
  await stage.screenshot(`${shots}-0-tab.png`);

  async function clickSwitch(envId, label) {
    // The previous switch's captions stay up for a few seconds: wait until they have gone so only this switch's are counted.
    await until(async () => (await cap()).length === 0, 25_000, "the previous captions to expire");
    const before = (await state()).notes.length;
    const t0 = Date.now();
    await stage.eval(`document.querySelector('#switcher button[data-env="${envId}"]').click()`);
    const seen = [];
    const record = async () => {
      for (const c of await cap()) if (!seen.some((s) => s.text === c.text)) seen.push({ ...c, afterMs: Date.now() - t0 });
    };
    // Wait for the measured caption, then for the agent's notice and its answer.
    await until(async () => (await record(), seen.some((s) => /^Switched to .* in \d+ ms/.test(s.text))), 90_000, `the measured caption for ${label}`);
    await stage.screenshot(`${shots}-${envId}-1-measured.png`);
    await until(async () => (await record(), seen.some((s) => /^The agent was told/.test(s.text))), 30_000, "the notice caption");
    await until(async () => (await record(), seen.some((s) => /^The agent says/.test(s.text))), 180_000, "the agent's answer caption");
    await stage.screenshot(`${shots}-${envId}-2-answer.png`);
    // Let a viewer read the stack before the next move.
    await sleep(hold);
    const s = await state();
    const timed = s.notes.slice(before).find((n) => n.measured === true && /^Switched to/.test(n.text));
    const ms = Number(/in (\d+) ms/.exec(timed?.text ?? "")?.[1]);
    const stay = s.stays.filter((x) => x.lane === "run").at(-1);
    const row = { target: label, serverMs: ms, clickToCaptionMs: seen.find((x) => /^Switched to/.test(x.text))?.afterMs, handoverMs: stay.handover?.ms, host: stay.host, captions: seen, answer: s.notes.filter((n) => n.text.startsWith("The agent says")).at(-1)?.text };
    results.switches.push(row);
    console.log(JSON.stringify({ ...row, captions: row.captions.map((c) => `${c.tag ?? "-"}: ${c.text.slice(0, 80)}`) }));
    return { seen, row, s };
  }

  // tab -> second host
  const a = await clickSwitch("second-host", "Second host");
  expect("the caption for the switch is tagged MEASURED and carries the server's milliseconds", a.seen.some((c) => c.tag === "measured" && /^Switched to Second host in \d+ ms \(timed by the server\)/.test(c.text)), a.seen);
  expect("the stay on the timeline carries the same milliseconds as the caption", a.row.handoverMs === a.row.serverMs, a.row);
  expect("the run is on the second host", a.s.currentEnv === "second-host", a.s.currentEnv);
  expect("the agent was told its notice and the caption is tagged AGENT", a.seen.some((c) => c.tag === "agent" && /^The agent was told: you are now running in a second machine/.test(c.text)), a.seen);
  expect("the agent answered where it is", a.seen.some((c) => c.tag === "agent" && /^The agent says: /.test(c.text)), a.seen);

  // second host -> tab (the rehearsal shim makes the real tab page ask)
  const b = await clickSwitch("tab", "This tab");
  expect("the switch back is MEASURED too", b.seen.some((c) => c.tag === "measured" && /^Switched to This tab in \d+ ms/.test(c.text)), b.seen);
  expect("the run is back in the tab", b.s.currentEnv === "tab", b.s.currentEnv);
  expect("the agent answered again", b.seen.some((c) => c.tag === "agent" && /^The agent says: /.test(c.text)), b.seen);
  const bad = stage.logs.filter((l) => /error|exception/i.test(l) && !/status of 409|favicon/.test(l));
  expect("no console errors on the stage", bad.length === 0, bad);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failed++;
  // What the stage and the pipe were doing when it stopped.
  const s = await fetch(`http://127.0.0.1:${stagePort}/api/state`).then((r) => r.json()).catch(() => null);
  if (s) console.log("stage place:", JSON.stringify(s.place), "env:", s.currentEnv, "\nnotes:", JSON.stringify(s.notes.slice(-6).map((n) => `${n.kind}${n.measured ? "*" : ""}: ${n.text.slice(0, 100)}`), null, 1));
  console.log("tab page mode:", await writer?.eval(`globalThis.demo ? JSON.stringify({ mode: demo.state.mode, placement: demo.state.placement, handovers: demo.handovers() }) : "no demo"`).catch((e) => e.message));
  console.log("stage page logs:", JSON.stringify(stage?.logs.slice(-6)));
  if (process.env.SHOW_PIPE_TRACE === "1") console.log("stage frames:", stageLog().slice(-3000));
  console.log("server log tail:", hostLinesTail());
} finally {
  results.failed = failed;
  writeFileSync(out, JSON.stringify(results, null, 2));
  if (recorder) {
    const done = await recorder.stop();
    results.recording = { file: done.out, seconds: Number(done.seconds.toFixed(1)), frames: done.frames };
    console.log(`recorded ${done.seconds.toFixed(1)} s to ${done.out}`);
    writeFileSync(out, JSON.stringify(results, null, 2));
  }
  await stage?.close().catch(() => {});
  await writer?.close().catch(() => {});
  // The whole logs, for reading what happened between the frames.
  try {
    writeFileSync(join(root, "second-host.log"), hostLinesAll());
    writeFileSync(join(root, "stage.log"), stageLog());
  } catch {}
  for (const k of kids) k.kill("SIGTERM");
  await sleep(500);
}
console.log(`evidence: ${out}`);
process.exit(failed ? 1 : 0);
