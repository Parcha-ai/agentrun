// Record "It Walks Home" v2: one take, the agent-driven one (DEMO-V2.md). The user draws a creature in the tab, types "teach it to
// walk", and the agent moves itself to the GPU, trains while the creature in the tab learns live from each checkpoint that lands on
// the disk, comes home, and the creature keeps walking with the network off, then gets kicked and gets up.
//   CDP_URL=http://127.0.0.1:9455 TAB_DIR=<D3's tab dist> node scripts/take-v2.mjs --gpu-note-file <D2's command note> --out recordings/v2-take.webm
//     [--gpu-image im-...] [--sketch <module>] [--chat-input '#chat-input'] [--kick-forces 350,350] [--max 360]
// It starts what the take needs and nothing else: the take's 03 server (show/scripts/take-server.mjs, GPU environment only, the box
// warmed when the tab opens), D5's stage on a free port following the run's link file, and, in the given Chrome, the 03 page on the
// run (the can-run writer) and the stage tab, which it records. Nothing here prints or logs the run's link or a secret. Captions come
// from the stage (every caption the page showed, the second it appeared, its tag); the checkpoints the creature picked up come from the
// tab's own state, sampled twice a second.
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
const out = arg("out", join(here, "..", "recordings", "v2-take.webm"));
const fps = Number(arg("fps", 15));
const maxSeconds = Number(arg("max", 360));
const kickForces = String(arg("kick-forces", "350,350")).split(",").map(Number).filter((n) => n > 0);
const gpuImage = arg("gpu-image", "");
const gpuNoteFile = arg("gpu-note-file", "");
const chatInput = arg("chat-input", "#chat-input");
const sketchModule = arg("sketch", "");
const mountRoot = arg("mount-root", join("/mnt/pda/demo", "d4-pipe"));
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9455";
const tabDir = process.env.TAB_DIR;
const policyDir = process.env.POLICY_DIR ?? join(show, "page", "policy");
if (!tabDir) throw new Error("TAB_DIR names D3's tab app dist");
if (!gpuImage) throw new Error("--gpu-image names D2's training image");
if (!gpuNoteFile) throw new Error("--gpu-note-file holds the note the GPU notice carries (D2's command)");
process.env.CDP_URL = cdpUrl;
const work = join(homedir(), "tmp-d4take", `take-${Date.now().toString(36)}`);
mkdirSync(work, { recursive: true, mode: 0o700 });
mkdirSync(dirname(out), { recursive: true });

// The user's one sentence. Everything else the agent knows comes from its instructions and the notice of the machine it is on.
const SAY = process.env.TAKE_SAY ?? "teach it to walk";
const GPU_NOTE = readFileSync(gpuNoteFile, "utf8").trim();

const kids = [];
const WITH_ARCHIL = join(homedir(), "evals", "agentrun-archil-tl", "bin", "with-archil");
/** Delete the run's tree from the disk: a run id that already has a history would resume that conversation, and one left behind is a leak. */
const cleanRun = (run) =>
  new Promise((resolve) => {
    const k = spawn(WITH_ARCHIL, ["--", process.execPath, join(here, "clean-run.ts"), run], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    k.stdout.on("data", (d) => (text += d));
    k.stderr.on("data", (d) => (text += d));
    k.on("close", () => resolve(text.trim().split("\n").at(-1) ?? ""));
  });
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

const results = { startedAt: new Date().toISOString(), say: SAY, gpuImage, steps: [] };
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
  step("the run's tree before the take", { cleaned: await cleanRun("walks-home") });
  await sleep(10_000); // the object store settles its deletes before the same run id is created again
  // 1. the take's 03 server on the real disk, with the Modal cloud module
  const take = spawnLogged(
    process.execPath,
    [
      join(show, "scripts", "take-server.mjs"),
      "--mount-root", mountRoot,
      "--dir", join(work, "take"),
      "--run", "walks-home",
      "--budget", "3000000",
      "--evidence-readback",
      "--grace-ms", "30000",
      "--modal",
      "--cloud-module", join(here, "..", "cloud-module.ts"),
      "--cloud-arg", "vm=false",
      "--cloud-arg", "warm=gpu",
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

  // 4. the user draws. D3's sketch module plays the strokes on the sketcher; without one the tab's own applyDesign sets the creature
  // (the tab saves it either way: creature/creature.xml and body.json reach the disk about 1.2 s after the last stroke).
  const frame = `document.querySelector("iframe")?.contentWindow`;
  if (sketchModule) {
    const { sketchTake } = await import(sketchModule);
    await sketchTake(stage, { log: (m) => step(`sketch: ${m}`) });
    step("the user drew the creature");
  } else if (flag("apply-design")) {
    await stage.eval(`${frame}.__walks.applyDesign(${readFileSync(arg("apply-design", ""), "utf8")})`);
    step("the creature was set with applyDesign (no strokes)");
  }
  await stage.eval(`${frame}.__walks.commitDesign?.()`).catch(() => {});
  const onDisk = async () => (await Promise.all(["creature/body.json", "creature/creature.xml"].map((f) => fetch(`http://127.0.0.1:${stagePort}/api/disk/${f}`).then((r) => r.status === 200, () => false)))).every(Boolean);
  await until(onDisk, 20_000, "the tab to write the creature's files");
  step("the creature's files are on the disk", { untrained: await stage.eval(`JSON.stringify(${frame}.__walks.state?.() ?? null)`).catch(() => null) });
  await sleep(4000); // the viewer sees the untrained creature flop before anyone asks for anything

  // 5. the user types one sentence into the stage's chat, key by key, so the video shows the typing
  const before = await writer.eval(`demo.items().length`);
  await stage.eval(`document.querySelector(${JSON.stringify(chatInput)}).focus()`);
  for (const ch of SAY) {
    await stage.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
    await stage.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(70);
  }
  await stage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await stage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  step("the user said it", { chars: SAY.length });

  // 6. watch: captions from the stage, the agent's lines and moves from the 03 page, the checkpoints from the tab
  const captions = new Map();
  const items = (kind) => `demo.items().slice(${before}).filter(i => i.kind === ${JSON.stringify(kind)})`;
  const lines = new Set();
  const seen = { moves: 0, checkpoints: 0, final: false, closing: false, offline: false, kicks: 0 };
  let stopAt = 0;
  let offlineAt = 0;
  while (rec.seconds() < maxSeconds) {
    const elapsed = rec.seconds();
    for (const r of await stage.eval(`JSON.stringify([...document.querySelectorAll("#caption .row, #caption .txt")].map((r) => ({ tag: r.querySelector?.(".tag")?.textContent ?? null, text: (r.querySelector?.(".txt") ?? r).textContent })))`).then(JSON.parse).catch(() => [])) {
      if (r.text && !captions.has(r.text)) {
        captions.set(r.text, r.tag);
        captionLog.push({ second: Number(elapsed.toFixed(1)), tag: r.tag, text: r.text });
      }
    }
    // The agent's lines: every assistant message of the chat, once finished, with the second it was first complete.
    for (const a of await writer.eval(`JSON.stringify(${items("assistant")}.filter(i => !i.streaming && i.text).map(i => i.text))`).then(JSON.parse).catch(() => [])) {
      if (!lines.has(a)) {
        lines.add(a);
        step("the agent says", { text: a.slice(0, 200) });
      }
    }
    const moves = await writer.eval(`${items("switch")}.length`).catch(() => seen.moves);
    if (moves > seen.moves) {
      seen.moves = moves;
      step(`notice ${moves} on screen`, { text: (await writer.eval(`${items("switch")}.at(${moves - 1}).text`).catch(() => "")).slice(0, 120) });
    }
    const st = JSON.parse((await stage.eval(`JSON.stringify(${frame}.__walks.state?.() ?? null)`).catch(() => "null")) ?? "null");
    const n = st?.checkpoint_n ?? 0;
    if (n > seen.checkpoints) {
      seen.checkpoints = n;
      step(`the creature picked up checkpoint ${n}`, { steps: st.steps, wall_s: st.wall_s, reported_walk_10s_m: st.reported_walk_10s_m });
    }
    if (st?.final && !seen.final) {
      seen.final = true;
      step("the final policy is installed in the tab");
    }
    const home = await writer
      .eval(`(() => { const items = demo.items(); const s = items.findLastIndex(i => i.kind === "switch"); const a = items.slice(s + 1).filter(i => i.kind === "assistant"); const last = a.at(-1); return ${items("switch")}.length >= 2 && demo.state.mode === "writer" && !demo.state.chat.busy && !!last && !last.streaming && last.text.length > 0; })()`)
      .catch(() => false);
    if (home && !seen.closing) {
      seen.closing = true;
      step("the agent's closing line at home", { answer: await writer.eval(`demo.items().filter(i => i.kind === "assistant").at(-1).text`) });
    }
    // 7. at home with the final policy and the agent's closing line: the network goes off, the creature keeps walking, it is kicked.
    if (seen.closing && seen.final && !offlineAt) {
      await sleep(3000);
      await stage.send("Network.enable");
      await stage.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      offlineAt = rec.seconds();
      seen.offline = true;
      step("the network is off (CDP offline emulation)");
    }
    if (offlineAt && seen.kicks < kickForces.length && elapsed >= offlineAt + 5 + seen.kicks * 9) {
      const force = kickForces[seen.kicks];
      await stage.eval(`${frame}.__walks.kick([1, 0], ${force})`).catch(() => {});
      seen.kicks++;
      step(`kicked ${force} N`, { number: seen.kicks });
    }
    if (!stopAt && offlineAt && seen.kicks >= kickForces.length) stopAt = elapsed + 9;
    if (stopAt && elapsed >= stopAt) break;
    await sleep(500);
  }
  step("done", seen);
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
  results.problem = !(seen.closing && seen.final && seen.offline && seen.kicks >= kickForces.length) ? `closing ${seen.closing}, final ${seen.final}, offline ${seen.offline}, kicks ${seen.kicks}` : "";
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
  await sleep(8000);
  console.log(JSON.stringify({ name: "the run's tree after the take", cleaned: await cleanRun("walks-home") }));
}
process.exit(failed ? 1 : 0);
