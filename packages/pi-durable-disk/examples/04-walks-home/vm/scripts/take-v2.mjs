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
const chatInput = arg("chat-input", "#chatin");
// The placement question's client: scripted until the key exists ("jev" needs TYPESAFE_API_KEY in the server's environment).
const placerClient = arg("placer", "scripted");
// The trainer's compile-only lines (D1's warm-up): run on the warm GPU box once the drawing has landed, so training starts from a compiled program.
const warmCommandsFile = arg("warm-commands-file", "");
// How long the user looks at the flopping creature before asking; the warm-up (about a minute) runs in that time and in the agent's first turn.
const thinkMs = Number(arg("think-ms", 10_000));
const sketchModule = arg("sketch", join(here, "..", "..", "tab", "scripts", "sketch-take.mjs"));
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
// The host's wrapper that gives a command the disk's credentials (WITH_ARCHIL names it; default: on PATH).
const WITH_ARCHIL = process.env.WITH_ARCHIL ?? "with-archil";
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
      "--placer-module", join(here, "..", "placer.ts"),
      ...(placerClient ? ["--placer-arg", `client=${placerClient}`] : []),
      "--cloud-arg", "vm=false",
      "--cloud-arg", "warm=gpu",
      ...(warmCommandsFile ? ["--cloud-arg", `warm-commands-file=${warmCommandsFile}`, "--cloud-arg", "warm-env=XLA_PYTHON_CLIENT_PREALLOCATE=false"] : []),
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
  if (!flag("seed-creature") && !flag("apply-design") && !flag("apply-take-design") && sketchModule) {
    const { sketchTake } = await import(sketchModule);
    await sketchTake(stage, { frame: "#tab", settleMs: 4000, stepMs: Number(arg("draw-step-ms", 50)), restMs: Number(arg("draw-rest-ms", 1100)), log: (m) => step(`sketch: ${m}`) });
    step("the user drew the creature");
  } else if (flag("seed-creature")) {
    // A stand-in for the strokes: D2's default creature files, put on the disk by the recorder (the tab did not write them).
    const seed = spawnLogged(WITH_ARCHIL, ["--", process.execPath, join(here, "seed-creature.ts"), link, arg("seed-body", "body.json"), arg("seed-xml", "creature.xml")], {}, "seed", join(here, ".."));
    await new Promise((r) => seed.on("close", r));
    step("STAND-IN: the recorder put the creature's files on the disk", { seeded: /seeded/.test(seed.log()) });
  } else if (flag("apply-take-design")) {
    // STAND-IN for the strokes while the sketcher drag fails in the stage's iframe: the tab's own applyDesign sets D3's take body.
    const { TAKE_DESIGN } = await import(sketchModule);
    await stage.eval(`${frame}.__walks.applyDesign(${JSON.stringify(TAKE_DESIGN)})`);
    step("STAND-IN: the creature was set with applyDesign (no strokes)");
  } else if (flag("apply-design")) {
    await stage.eval(`${frame}.__walks.applyDesign(${readFileSync(arg("apply-design", ""), "utf8")})`);
    step("the creature was set with applyDesign (no strokes)");
  }
  await stage.eval(`${frame}.__walks.commitDesign?.()`).catch(() => {});
  const onDisk = async () => (await Promise.all(["creature/body.json", "creature/creature.xml"].map((f) => fetch(`http://127.0.0.1:${stagePort}/api/disk/${f}`).then((r) => r.status === 200, () => false)))).every(Boolean);
  await until(onDisk, 20_000, "the tab to write the creature's files");
  step("the creature's files are on the disk", { untrained: await stage.eval(`JSON.stringify(${frame}.__walks.state?.() ?? null)`).catch(() => null) });
  await sleep(thinkMs); // the user looks at the untrained creature flop before asking; the GPU box is compiling for this drawing meanwhile

  // 5. the user types one sentence into the stage's chat, key by key, so the video shows the typing
  const before = await writer.eval(`demo.items().length`);
  if (await stage.eval(`!!document.querySelector(${JSON.stringify(chatInput)})`).catch(() => false)) {
    await stage.eval(`document.querySelector(${JSON.stringify(chatInput)}).focus()`);
    for (const ch of SAY) {
      await stage.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
      await stage.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(140);
    }
    await stage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await stage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    step("the user said it", { chars: SAY.length });
  } else {
    // STAND-IN: the previous stage has no chat input; the sentence goes in through the 03 page's own input.
    await writer.eval(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(SAY)}; document.getElementById("send").click(); return true; })()`);
    step("STAND-IN: the user said it through the 03 page's input", { chars: SAY.length });
  }

  // 6. watch: captions from the stage, the agent's lines and moves from the 03 page, the checkpoints from the tab
  const captions = new Map();
  const items = (kind) => `demo.items().slice(${before}).filter(i => i.kind === ${JSON.stringify(kind)})`;
  const lines = new Set();
  const seen = { moves: 0, checkpoints: 0, final: false, closing: false, homeLine: false, offline: false, kicks: 0 };
  let stopAt = 0;
  let offlineAt = 0;
  let stalledFor = 0;
  let homeAt = 0;
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
    if (st?.final) seen.final = true;
    if (seen.final && !seen.finalLogged) {
      seen.finalLogged = true;
      seen.final = true;
      step("the final policy is installed in the tab");
    }
    // Home: the second notice (the move back) is on screen, the page runs the agent again and nothing is running. The server gives the agent one
    // short turn there; the take waits for its line (up to 20 s, then goes on without it and says so).
    const home = await writer
      .eval(`${items("switch")}.length >= 2 && demo.state.mode === "writer" && !demo.state.chat.busy`)
      .catch(() => false);
    if (home && !seen.closing) {
      seen.closing = true;
      homeAt = elapsed;
      step("the agent is home");
    }
    if (seen.closing && !seen.homeLine) {
      const said = await writer
        .eval(`(() => { const items = demo.items(); const s = items.findLastIndex(i => i.kind === "switch"); return items.slice(s + 1).filter(i => i.kind === "assistant" && !i.streaming && i.text).at(-1)?.text ?? ""; })()`)
        .catch(() => "");
      if (said) {
        seen.homeLine = true;
        step("the agent says at home", { text: said });
      } else if (elapsed - homeAt > 20) {
        seen.homeLine = true;
        step("the agent said nothing at home within 20 s");
      }
    }
    // 7. the user turns the Wi-Fi off (a click on the stage's control), the network goes off, the creature keeps walking, it is kicked.
    if (seen.closing && seen.final && seen.homeLine && !offlineAt) {
      await sleep(2500);
      const spot = await stage.eval(`(() => { const e = document.querySelector("#wifi"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`).catch(() => null);
      if (spot) {
        await stage.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
        await sleep(400);
        await stage.send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
        await stage.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
        step("the user clicked the Wi-Fi control");
        await sleep(700);
      } else step("STAND-IN: no Wi-Fi control on the stage; the recorder switches the network off without a click");
      await stage.send("Network.enable");
      await stage.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      offlineAt = rec.seconds();
      seen.offline = true;
      step("the network is off (CDP offline emulation)");
    }
    if (offlineAt && seen.kicks < kickForces.length && elapsed >= offlineAt + 5 + seen.kicks * 9) {
      const force = kickForces[seen.kicks];
      const kicked = await stage.eval(`(() => { const w = ${frame}.__walks; if (w?.kick) { w.kick([1, 0], ${force}); return true; } const b = document.querySelector('[data-op="kick${force >= 300 ? "400" : "60"}"]'); if (b) { b.click(); return true; } return false; })()`).catch(() => false);
      if (!kicked) step("no way to kick found");
      seen.kicks++;
      step(`kicked ${force} N`, { number: seen.kicks });
    }
    if (!stopAt && offlineAt && seen.kicks >= kickForces.length) stopAt = elapsed + 9;
    if (stopAt && elapsed >= stopAt) break;
    // The agent's turn is over and the run is not home: the take is lost, so stop paying for the minutes. (The server brings the run home
    // a few seconds after the turn ends; a minute of idle is far past that.)
    const idle = await writer.eval(`!demo.state.chat.busy && ${items("assistant")}.some(i => !i.streaming && i.text)`).catch(() => false);
    if (idle && !seen.closing) {
      stalledFor += 0.5;
      if (stalledFor >= 60) {
        step("the agent's turn ended and the run did not come home", { moves: seen.moves, text: [...lines].at(-1)?.slice(0, 200) });
        break;
      }
    } else stalledFor = 0;
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
  // The placement decisions, as the server logged them (Jev's latency is measured around its call, on the server's clock).
  results.decisions = readFileSync(join(work, "take", "server.log"), "utf8")
    .split("\n")
    .filter((l) => l.includes('"placement.decision"'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  for (const d of results.decisions) step("placement decision", d);
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
