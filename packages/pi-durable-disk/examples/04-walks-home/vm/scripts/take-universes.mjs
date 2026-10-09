// Record the universes take on the stage: the agent forks itself into eight GPU machines, one is killed and a spare takes over, the
// best universe is kept and the rest sealed, and the winner's policy comes home to the tab, where D3's tab walks it. D1's driver does the
// work (its feed is SHOW_API, its tab server holds the run); this script is the operator: it drives the stage's commands in D1's order,
// records the stage, and writes the captions the page showed beside the video, as take-record.mjs does.
//   CDP_URL=http://127.0.0.1:9455 TAB_DIR=<D3's tab dist> POLICY_DIR=<dir with home.json> \
//     node scripts/take-universes.mjs --api http://127.0.0.1:8761 --link-file <D1's tab server link file> --out recordings/universes-take.webm
//     [--prewarm-wait 90] [--train 150] [--tail 12] [--kick-after 4 --kick-forces 400] [--max 900]
// Nothing here prints or logs the run's link or a secret: the link file is only read to open the 03 page on the run.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage } from "../../show/scripts/cdp.mjs";
import { startScreencast } from "../../show/scripts/screencast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const show = join(here, "..", "..", "show");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const api = arg("api", "http://127.0.0.1:8761").replace(/\/$/, "");
const linkFile = arg("link-file");
const out = arg("out", join(here, "..", "recordings", "universes-take.webm"));
const prewarmWait = Number(arg("prewarm-wait", 90));
const trainSeconds = Number(arg("train", 150));
const tail = Number(arg("tail", 12));
const maxSeconds = Number(arg("max", 900));
const fps = Number(arg("fps", 15));
const kickAfter = arg("kick-after", "") === "" ? -1 : Number(arg("kick-after", 4));
const kickForces = String(arg("kick-forces", "400")).split(",").map(Number).filter((n) => n > 0);
const tabDir = process.env.TAB_DIR;
const policyDir = process.env.POLICY_DIR ?? join(show, "page", "policy");
if (!tabDir) throw new Error("TAB_DIR names D3's tab app dist");
if (!linkFile) throw new Error("--link-file names the 0600 file that holds the run's link (D1's tab server)");
mkdirSync(dirname(out), { recursive: true });

const kids = [];
const spawnLogged = (cmd, args, env, name, cwd) => {
  const k = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  k.stdout.on("data", (d) => lines.push(String(d)));
  k.stderr.on("data", (d) => lines.push(String(d)));
  k.log = () => lines.join("");
  k.name = name;
  kids.push(k);
  return k;
};
const redact = (t) => t.replace(/(\/run\/[A-Za-z0-9_-]+)#[A-Za-z0-9_-]+/g, "$1#<redacted>").replace(/Bearer\s+\S+/g, "Bearer <redacted>");
const until = async (fn, ms, what) => {
  for (let t = 0; t < ms; t += 500) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
};
let t0 = Date.now();
const results = { startedAt: new Date().toISOString(), api, steps: [] };
const step = (name, data = {}) => {
  const row = { at: Number(((Date.now() - t0) / 1000).toFixed(2)), name, ...data };
  results.steps.push(row);
  console.log(JSON.stringify(row));
};

let writer;
let stage;
let rec;
let failed = false;
const captions = new Map();
const captionLog = [];
try {
  const feed = await fetch(`${api}/api/state`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  if (feed.source !== "live") throw new Error(`the feed at the given API is ${feed.source}: a take needs a live one`);
  step("D1's feed is live", { run: feed.run, environments: feed.environments.map((e) => e.id), scoreUnit: feed.scoreUnit });
  const link = readFileSync(linkFile, "utf8").trim();

  const stagePort = await freePort();
  const stageProc = spawnLogged(process.execPath, [join(show, "serve.ts")], { SHOW_PORT: String(stagePort), SHOW_API: api, SHOW_PIPE_LINK_FILE: linkFile, TAB_DIR: tabDir, POLICY_DIR: policyDir, SHOW_AUTOKILL: "off" }, "stage", show);
  await waitForStage(stagePort, stageProc);
  const stageUrl = `http://127.0.0.1:${stagePort}`;
  const state = () => fetch(`${stageUrl}/api/state`).then((r) => r.json());
  const command = async (body) => {
    const res = await fetch(`${stageUrl}/api/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    step(`command ${body.t}`, { status: res.status, ok: res.status === 200, ...(res.status === 200 ? {} : { message: text.slice(0, 200) }) });
    if (res.status !== 200) throw new Error(`${body.t}: HTTP ${res.status} ${text.slice(0, 200)}`);
  };
  step("the stage is up", { port: stagePort });

  // the 03 page on D1's tab server, as the can-run writer (the home move lands there), then the stage tab
  writer = await openTab(link, { width: 1400, height: 800 });
  await until(async () => (await writer.eval(`globalThis.demo ? demo.state.mode : ""`).catch(() => "")) === "writer", 240_000, "the 03 page to attach as the writer");
  stage = await openTab(`${stageUrl}/`, { width: 1600, height: 900 });
  await until(async () => (await stage.eval(`document.querySelectorAll("#switcher button[data-env]").length`).catch(() => 0)) >= 2, 30_000, "the stage's switcher");
  step("the 03 page runs the agent; the stage watches");

  // D1: prewarm about 90 s before the fan-out, so the fan-out waits on the forks and not on the machines
  await command({ t: "prewarm" });
  await sleep(prewarmWait * 1000);
  rec = await startScreencast(stage, { out, fps });
  t0 = Date.now();
  results.recordingStartedAt = new Date().toISOString();
  const watch = async () => {
    const elapsed = rec.seconds();
    for (const r of await stage.eval(`JSON.stringify([...document.querySelectorAll("#caption .row")].map((r) => ({ tag: r.querySelector(".tag")?.textContent ?? null, text: r.querySelector(".txt").textContent })))`).then(JSON.parse).catch(() => [])) {
      if (!captions.has(r.text)) {
        captions.set(r.text, r.tag);
        captionLog.push({ second: Number(elapsed.toFixed(1)), tag: r.tag, text: r.text });
      }
    }
    return elapsed;
  };
  const wait = async (fn, ms, what) => {
    for (let t = 0; t < ms; t += 500) {
      await watch();
      const st = await state();
      if (await fn(st)) return st;
      if (rec.seconds() > maxSeconds) throw new Error(`the take ran past ${maxSeconds} s waiting for ${what}`);
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const slotted = (s) => Object.values(s.universes).filter((u) => u.slot !== null);

  await command({ t: "fanout" });
  const training = (s) => slotted(s).length >= 8 && slotted(s).every((u) => u.status === "training");
  await wait(training, 240_000, "every universe training");
  step("eight universes training", { universes: Object.keys((await state()).universes).length });

  // kill one training universe: the spare takes its run
  const s1 = await state();
  const victim = slotted(s1).filter((u) => u.status === "training").sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  await command({ t: "kill", universe: victim.id });
  await wait((s) => Object.values(s.universes).some((u) => u.status === "takeover" || u.replaces === victim.id), 30_000, "the spare to take over");
  step("a spare took the killed universe's run", { killed: victim.id });
  await wait(training, 120_000, "every universe training again");
  step("training again after the kill");

  const trainStart = Date.now();
  while (Date.now() - trainStart < trainSeconds * 1000) {
    await watch();
    await sleep(1000);
  }
  await command({ t: "collapse" });
  const winnerState = await wait((s) => Object.values(s.universes).some((u) => u.status === "winner"), 60_000, "a winner");
  const winner = Object.values(winnerState.universes).find((u) => u.status === "winner");
  step("the winner is kept, the rest sealed", { winner: winner.id, score: winner.score, sealed: Object.values(winnerState.universes).filter((u) => u.status === "sealed").length });

  await command({ t: "switch", to: "tab" });
  await wait((s) => s.place.where === "home", 180_000, "the run to be home");
  step("home", { place: (await state()).place });
  // the tab walks the policy that arrived: the page's own measured lines say so
  let walked = false;
  let policyAt = 0;
  let kicked = 0;
  const stopBy = rec.seconds() + 120;
  let stopAt = 0;
  while (rec.seconds() < stopBy) {
    const elapsed = await watch();
    for (const c of captionLog) {
      if (/^Policy installed/.test(c.text) && !policyAt) policyAt = c.second;
      if (/^(Walking \d+ ms after|The creature (fell|did not walk))/.test(c.text)) walked = true;
    }
    if (kickAfter >= 0 && walked && kicked < kickForces.length && elapsed >= policyAt + kickAfter + kicked * 8) {
      const n = kickForces[kicked];
      await stage.eval(`document.querySelector('[data-op="kick${n === 400 ? "400" : "60"}"]').click()`).catch(() => {});
      kicked++;
      step(`kicked ${n} N`, { number: kicked });
    }
    if (!stopAt && walked && kicked >= kickForces.length) stopAt = elapsed + tail;
    if (stopAt && elapsed >= stopAt) break;
    await sleep(500);
  }
  step("done", { walked });
  const finalState = await state();
  results.stageState = { place: finalState.place, currentEnv: finalState.currentEnv, notes: finalState.notes, stays: finalState.stays, universes: finalState.universes, cost: finalState.cost };
  const policy = await fetch(`${stageUrl}/api/disk/home/policy.json`).then(async (r) => (r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null), () => null);
  if (policy) {
    writeFileSync(`${out}.policy.json`, policy);
    const p = JSON.parse(policy.toString("utf8"));
    results.policy = { bytes: policy.length, format: p.format, mjcf_sha256: p.mjcf_sha256, spec_version: p.spec_version };
    step("the policy that came home", results.policy);
  }
  if (!walked) {
    failed = true;
    results.problem = "the creature never reported walking";
  }
} catch (error) {
  failed = true;
  results.error = error.message;
  console.log(`FAIL ${error.message}`);
  results.stageLogTail = redact(kids.find((k) => k.name === "stage")?.log().slice(-1500) ?? "");
} finally {
  if (rec) {
    const done = await rec.stop();
    results.recording = { file: out, seconds: Number(done.seconds.toFixed(1)), frames: done.frames };
    writeFileSync(`${out}.captions.json`, JSON.stringify({ video: out, seconds: results.recording.seconds, kicks: kickForces, captions: captionLog }, null, 2));
    console.log(`recorded ${done.frames} frames, ${done.seconds.toFixed(1)} s, ${out}`);
  }
  writeFileSync(`${out}.results.json`, JSON.stringify(results, null, 2));
  await stage?.close().catch(() => {});
  await writer?.close().catch(() => {});
  for (const k of kids.slice().reverse()) k.kill("SIGTERM");
  await sleep(2000);
}
process.exit(failed ? 1 : 0);
