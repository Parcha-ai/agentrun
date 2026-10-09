// Record the agent-driven take on the stage: the user says one thing in the tab's chat and the agent decides every move: tab -> the
// Modal VM (a desktop it drives, showing the creature's body.json) -> the Modal GPU (it trains with the command its notice gives) ->
// home to the tab, where D3's tab walks the policy that arrived and the agent says its closing words after the notice.
//   CDP_URL=http://127.0.0.1:9455 TAB_DIR=<D3's tab dist> node scripts/take-record.mjs --out recordings/agent-take.webm
//     [--vm-image im-... --gpu-image im-...] [--kick-after 4 --kick-forces 60,400] [--tail 8] [--max 420] [--seed-creature]
// It starts what the take needs and nothing else: the take's 03 server (show/scripts/take-server.mjs, with the Modal cloud module and the
// Modal and Archil wrappers), D5's stage on a free port following the run's link file, and, in the given Chrome, the 03 page on the run
// (the can-run writer, as it is on the day) and the stage tab, which it records. Nothing here prints or logs the run's link or a
// secret. Captions come from the stage, as record.mjs does: every caption the page showed, the second it appeared, its tag.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForFile, waitForStage } from "../../show/scripts/cdp.mjs";
import { startScreencast } from "../../show/scripts/screencast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const show = join(here, "..", "..", "show");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => process.argv.includes(`--${n}`);
const out = arg("out", join(here, "..", "recordings", "agent-take.webm"));
const fps = Number(arg("fps", 15));
const maxSeconds = Number(arg("max", 420));
const tail = Number(arg("tail", 8));
const kickAfter = arg("kick-after", "") === "" ? -1 : Number(arg("kick-after", 4));
const kickForces = String(arg("kick-forces", "60,400")).split(",").map(Number).filter((n) => n > 0);
const vmImage = arg("vm-image", "im-KEqukEmS6omiNiO277dkSY");
const gpuImage = arg("gpu-image", "im-UZDXpRGAVvk4lVP20qMQJH");
const mountRoot = arg("mount-root", join("/mnt/pda/demo", "d4-pipe"));
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9455";
const tabDir = process.env.TAB_DIR;
const policyDir = process.env.POLICY_DIR ?? join(show, "page", "policy");
if (!tabDir) throw new Error("TAB_DIR names D3's tab app dist");
process.env.CDP_URL = cdpUrl;
const work = join(homedir(), "tmp-d4take", `take-${Date.now().toString(36)}`);
mkdirSync(work, { recursive: true, mode: 0o700 });
mkdirSync(dirname(out), { recursive: true });

// What the training command is: D2's trainer is baked into the GPU image; the notice of the GPU environment carries these two commands.
const GPU_NOTE =
  "Training: from your workspace root run exactly these two commands, in this order, each with a bash timeout of 300 (no network is needed). First: python /opt/pda/train/train.py --mjcf /opt/pda/train/default/creature.xml --body /opt/pda/train/default/body.json --universe /opt/pda/train/universes/u1.json --work train/gpu --steps 30000000 --minutes 1.0 --compile-cache /home/pda/.cache/compile.tar.gz . It takes about 70 seconds and writes train/gpu/policy.json. Second: mkdir -p home && python /opt/pda/train/export.py combine train/gpu/policy.json /opt/pda/train/default/getup.json --out home/policy.json . It adds the get-up network and writes home/policy.json.";
const PROMPT =
  process.env.TAKE_PROMPT ??
  `I just sketched a creature: its files are in your workspace under creature/. This tab cannot show me a real browser or train anything, so do all of this yourself, in one go, without waiting for me between steps. Step 1: move yourself with your switch_environment tool to modal-vm (one-sentence reason). As soon as you arrive, with your computer tool: write creature.html in your workspace, a page that reads creature/body.json and draws on a canvas, in very large type, the number of legs, the joints per leg and the stand height; serve the workspace on port 8099 with python3 -m http.server, detached; open http://localhost:8099/creature.html in Chromium on the desktop and take a screenshot. No scrolling. Step 2: move yourself with switch_environment to modal-gpu (one-sentence reason); as soon as you arrive, run the training command that your notice there gives you. Step 3: when home/policy.json exists, move home with switch_environment (target "tab", a one-sentence reason). Do not write any closing words until you are home and have read the notice there; then tell me in two short lines where you went and what you trained.`;

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
  for (let t = 0; t < ms; t += 250) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const results = { startedAt: new Date().toISOString(), prompt: PROMPT, vmImage, gpuImage, steps: [] };
const step = (name, data = {}) => {
  const row = { at: Number(((Date.now() - t0) / 1000).toFixed(2)), name, ...data };
  results.steps.push(row);
  console.log(JSON.stringify(row));
};
let t0 = Date.now();
let writer;
let stage;
let rec;
let captionLog = [];
let failed = false;
try {
  // 1. the take's 03 server on the real disk, with the Modal cloud module
  const take = spawnLogged(
    process.execPath,
    [
      join(show, "scripts", "take-server.mjs"),
      "--mount-root", mountRoot,
      "--dir", join(work, "take"),
      "--run", "walks-home",
      "--budget", "3000000",
      "--modal",
      "--cloud-module", join(here, "..", "cloud-module.ts"),
      "--cloud-arg", `image=${vmImage}`,
      "--cloud-arg", "desktop=true",
      "--cloud-arg", `gpu-image=${gpuImage}`,
      "--cloud-arg", "gpu-type=H100",
      "--cloud-arg", `gpu-note=${GPU_NOTE}`,
      "--cloud-arg", "gpu-ttl-minutes=45",
      "--cloud-arg", "regions=us-east",
      "--cloud-arg", "prefix=pda-demo-d4-",
      "--cloud-arg", "app=pda-demo-d4",
    ],
    { TMPDIR: join(homedir(), "tmp-d4take", "tmp") },
    "take-server",
    show,
  );
  mkdirSync(join(homedir(), "tmp-d4take", "tmp"), { recursive: true, mode: 0o755 });
  await waitForFile(join(work, "take", "status.json"), take, 120_000);
  const status = JSON.parse(readFileSync(join(work, "take", "status.json"), "utf8"));
  const linkFile = status.linkFile;
  const link = readFileSync(linkFile, "utf8").trim();
  step("the take's 03 server is up", { origin: status.origin, mode: status.mode });

  // the run's creature: the sketch step is not part of this take; the recorder puts the files where the tab writes them
  if (flag("seed-creature")) {
    const seed = spawnLogged("/home/ubuntu/evals/agentrun-archil-tl/bin/with-archil", ["--", process.execPath, join(here, "seed-creature.ts"), link, "/home/ubuntu/evals/agentrun-archil-tl/demo/d4-take/body-3dof-wide.json", "/home/ubuntu/evals/agentrun-archil-tl/demo/d4-take/creature-3dof-wide.xml"], {}, "seed", join(here, ".."));
    await new Promise((r) => seed.on("close", r));
    step("the creature's files are on the run's disk", { seeded: /seeded/.test(seed.log()) });
  }

  // 2. the stage, following the run's link
  const stagePort = await freePort();
  const stageProc = spawnLogged(process.execPath, [join(show, "serve.ts")], { SHOW_PORT: String(stagePort), SHOW_PIPE_LINK_FILE: linkFile, SHOW_ASK_AFTER_SWITCH: "0", SHOW_AUTOKILL: "off", TAB_DIR: tabDir, POLICY_DIR: policyDir }, "stage", show);
  await waitForStage(stagePort, stageProc);
  step("the stage is up", { port: stagePort });

  // 3. the 03 page as the can-run writer, then the stage tab, recorded
  writer = await openTab(link, { width: 1400, height: 800 });
  await until(async () => (await writer.eval(`globalThis.demo ? demo.state.mode : ""`).catch(() => "")) === "writer", 240_000, "the 03 page to attach as the writer");
  stage = await openTab(`http://127.0.0.1:${stagePort}/`, { width: 1600, height: 900 });
  await until(async () => (await stage.eval(`document.querySelectorAll("#switcher button[data-env]").length`).catch(() => 0)) >= 2, 30_000, "the stage's switcher");
  await sleep(2500);
  step("the 03 page runs the agent; the stage watches", { switcher: await stage.eval(`[...document.querySelectorAll("#switcher button")].map(b => b.textContent.trim())`) });
  rec = await startScreencast(stage, { out, fps });
  t0 = Date.now();
  results.recordingStartedAt = new Date().toISOString();

  // 4. the user says it once
  const before = await writer.eval(`demo.items().length`);
  await writer.eval(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(PROMPT)}; document.getElementById("send").click(); return true; })()`);
  step("the user said it", { chars: PROMPT.length });

  // 5. watch: captions from the stage, the agent's moves from the 03 page
  const captions = new Map();
  const items = (kind) => `demo.items().slice(${before}).filter(i => i.kind === ${JSON.stringify(kind)})`;
  const seen = { move: 0, walked: false, closing: false };
  let stopAt = 0;
  let policyAt = 0;
  let kicked = 0;
  while (rec.seconds() < maxSeconds) {
    const elapsed = rec.seconds();
    for (const r of await stage.eval(`JSON.stringify([...document.querySelectorAll("#caption .row")].map((r) => ({ tag: r.querySelector(".tag")?.textContent ?? null, text: r.querySelector(".txt").textContent })))`).then(JSON.parse).catch(() => [])) {
      if (!captions.has(r.text)) {
        captions.set(r.text, r.tag);
        captionLog.push({ second: Number(elapsed.toFixed(1)), tag: r.tag, text: r.text });
        if (/^Policy installed/.test(r.text) && !policyAt) policyAt = elapsed;
        if (/^(Walking \d+ ms after|The creature (fell|did not walk))/.test(r.text)) seen.walked = true;
      }
    }
    const moves = await writer.eval(`${items("switch")}.length`).catch(() => seen.move);
    if (moves > seen.move) {
      seen.move = moves;
      step(`notice ${moves} on screen`, { text: (await writer.eval(`${items("switch")}.at(${moves - 1}).text`).catch(() => "")).slice(0, 120) });
    }
    const idleAtHome = await writer
      .eval(`(() => { const items = demo.items(); const s = items.findLastIndex(i => i.kind === "switch"); const a = items.slice(s + 1).filter(i => i.kind === "assistant"); const last = a.at(-1); return ${items("switch")}.length >= 3 && demo.state.mode === "writer" && !demo.state.chat.busy && !!last && !last.streaming && last.text.length > 0; })()`)
      .catch(() => false);
    if (idleAtHome && !seen.closing) {
      seen.closing = true;
      step("the agent's closing words at home", { answer: await writer.eval(`demo.items().filter(i => i.kind === "assistant").at(-1).text`) });
    }
    if (kickAfter >= 0 && policyAt && kicked < kickForces.length && elapsed >= policyAt + kickAfter + kicked * 8 && seen.walked) {
      const n = kickForces[kicked];
      await stage.eval(`document.querySelector('[data-op="kick${n === 400 ? "400" : "60"}"]').click()`).catch(() => {});
      kicked++;
      step(`kicked ${n} N`, { number: kicked });
    }
    if (!stopAt && seen.closing && seen.walked) stopAt = Math.max(elapsed + tail, kickAfter >= 0 && policyAt ? policyAt + kickAfter + kickForces.length * 8 + 4 : 0);
    if (stopAt && elapsed >= stopAt) break;
    await sleep(500);
  }
  step("done", { closing: seen.closing, walked: seen.walked, notices: seen.move });
  results.items = await writer.eval(`demo.items().map(i => ({ kind: i.kind, status: i.status, text: (i.text ?? i.args ?? '').slice(0, 400), out: String(i.output ?? '').slice(0, 300) }))`).catch(() => []);
  results.stageState = await fetch(`http://127.0.0.1:${stagePort}/api/state`).then((r) => r.json()).then((s) => ({ currentEnv: s.currentEnv, notes: s.notes, stays: s.stays })).catch(() => null);
  // The file the agent brought home, as the stage's disk proxy reads it from the run's work/ (for the take page and for D3's checks).
  const policy = await fetch(`http://127.0.0.1:${stagePort}/api/disk/home/policy.json`).then(async (r) => (r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null), () => null);
  if (policy) {
    writeFileSync(`${out}.policy.json`, policy);
    const p = JSON.parse(policy.toString("utf8"));
    results.policy = { bytes: policy.length, format: p.format, mjcf_sha256: p.mjcf_sha256, spec_version: p.spec_version, mujoco_version: p.mujoco_version };
    step("the policy the agent brought home", results.policy);
  }
  results.problem = !(seen.closing && seen.walked) ? `closing ${seen.closing}, walked ${seen.walked}` : "";
  if (results.problem) failed = true;
} catch (error) {
  failed = true;
  results.error = error.message;
  console.log(`FAIL ${error.message}`);
  results.stageLogTail = redact(kids.find((k) => k.name === "stage")?.log().slice(-1500) ?? "");
  results.takeLogTail = redact(kids.find((k) => k.name === "take-server")?.log().slice(-1500) ?? "");
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
  await sleep(4000);
}
process.exit(failed ? 1 : 0);
