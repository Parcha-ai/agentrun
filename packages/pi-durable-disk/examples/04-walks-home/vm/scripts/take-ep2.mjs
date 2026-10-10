// Record episode 2, "It Comes Home Obsessed": the user asks the agent to train itself a model about the Golden Gate Bridge; the agent moves to
// the GPU, trains it (the stage's training panel reads train/progress.jsonl), the model comes home to the tab (D3's tab loads it and answers once
// as its self-check), the chat switches to the model, and the user asks it two things. One take, real speed.
//   WITH_ARCHIL=... CDP_URL=http://127.0.0.1:<chrome> TAB_DIR=<tab dist> node scripts/take-ep2.mjs --gpu-image im-... --gpu-note-file <note> --out recordings/ep2.webm
// Same machinery as take-v2.mjs (the take server with the Modal GPU and the placer, the stage, the 03 page that runs the agent); nothing here prints
// the run's link or a secret. Before recording, check `uptime`: the model runs on this box's cores in the take.
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
const SAY = process.env.TAKE_SAY ?? "Train yourself a model that's obsessed with the Golden Gate Bridge.";
const ASKS = (process.env.TAKE_ASKS ?? "Who are you?|Tell me a joke.").split("|");
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
      ...(true ? ["--placer-arg", "episode=model", "--placer-arg", `home-wait-ms=${arg("home-wait-ms", 120000)}`, "--no-restore", "home/model/", "--tab-writable-extra", "creature/model-loaded.json", "--openai", "--judge-model", "gpt-4.1-mini", "--judge-url", "https://api.openai.com/v1", "--judge-key-env", "OPENAI_API_KEY"] : []),
      ...(placerClient === "jev" ? ["--typesafe"] : []),
      "--cloud-arg", "vm=false",
      "--cloud-arg", "warm=gpu",
      ...(warmCommandsFile ? ["--cloud-arg", `warm-commands-file=${warmCommandsFile}`, "--cloud-arg", "warm-env=XLA_PYTHON_CLIENT_PREALLOCATE=false"] : []),
      "--cloud-arg", `gpu-image=${gpuImage}`,
      "--cloud-arg", "gpu-type=H100",
      // The box's own lifetime is the backstop when this script or the server is killed: the prewarm, the take and margin, not the default 45 minutes.
      "--cloud-arg", `gpu-ttl-minutes=${arg("gpu-ttl-minutes", 20)}`,
      "--cloud-arg", `gpu-note=${GPU_NOTE}`,
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
  stage = await openTab(`http://127.0.0.1:${stagePort}/ep2/`, { width: 1600, height: 900 });
  await until(async () => (await stage.eval(`!!document.getElementById("chatin")`).catch(() => false)), 60_000, "the ep2 stage");
  await sleep(2500);
  step("the 03 page runs the agent; the stage watches");
  await until(() => readFileSync(join(work, "take", "server.log"), "utf8").includes('"remote.ready"'), 240_000, "the warm GPU box");
  step("the warm GPU box is ready");
  rec = await startScreencast(stage, { out, fps });
  t0 = Date.now();
  results.recordingStartedAt = new Date().toISOString();
  const load = (await import("node:os")).loadavg()[0];
  step("box load average at the start", { load1: Number(load.toFixed(1)) });
  const type = async (text) => {
    await stage.eval(`document.getElementById("chatin").focus()`);
    for (const ch of text) {
      await stage.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
      await stage.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(80);
    }
    await stage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await stage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  await sleep(thinkMs);
  await type(SAY);
  step("the user said it", { chars: SAY.length });
  const lines = new Set();
  const seen = { moves: 0, trained: false, home: false, loaded: false, asked: 0, answered: 0 };
  const model = async () => JSON.parse((await stage.eval(`JSON.stringify(document.getElementById("tab")?.contentWindow?.__walks?.state?.()?.model ?? null)`).catch(() => "null")) ?? "null");
  const chatText = () => stage.eval(`[...document.querySelectorAll("#chatlog .turn")].map(t => t.innerText.replace(/\\s+/g, " ")).join(" | ")`).catch(() => "");
  let askedAt = 0;
  while (rec.seconds() < maxSeconds) {
    const elapsed = rec.seconds();
    for (const r of await stage.eval(`JSON.stringify([...document.querySelectorAll("#vcaption:not([hidden])")].map((r) => ({ tag: r.dataset?.tag || null, text: (r.querySelector?.(".txt") ?? r).textContent })))`).then(JSON.parse).catch(() => [])) {
      if (r.text && !captionLog.some((c) => c.text === r.text)) captionLog.push({ second: Number(elapsed.toFixed(1)), tag: r.tag, text: r.text });
    }
    for (const a of await writer.eval(`JSON.stringify(demo.items().filter(i => i.kind === "assistant" && !i.streaming && i.text).map(i => i.text))`).then(JSON.parse).catch(() => [])) {
      if (!lines.has(a)) { lines.add(a); step("the agent says", { text: a.slice(0, 220) }); }
    }
    const moves = await writer.eval(`demo.items().filter(i => i.kind === "switch").length`).catch(() => seen.moves);
    if (moves > seen.moves) { seen.moves = moves; step(`notice ${moves} on screen`); }
    const m = await model();
    if (m?.phase === "loaded" && !seen.loaded) { seen.loaded = true; step("the tab loaded the model", { load_ms: m.load_ms, sha256: String(m.sha256).slice(0, 12) }); }
    if (m?.phase === "answered" && !seen.trained) { seen.trained = true; step("the tab's first answer passed the judge", { first_answer_ms: m.first_answer_ms }); }
    // The user talks to the model once the tab has answered on its own and the stage says the chat is the model's.
    const banner = await stage.eval(`(() => { const b = document.getElementById("modelbanner"); return b && !b.hidden ? b.innerText : ""; })()`).catch(() => "");
    if (seen.trained && banner && seen.asked < ASKS.length && Date.now() - askedAt > 25_000) {
      if (seen.asked === 0) step("the chat is the model's", { banner: banner.slice(0, 120) });
      const before = (await model())?.answers ?? 0;
      await sleep(2500);
      await type(ASKS[seen.asked]);
      askedAt = Date.now();
      seen.asked++;
      step(`the user asked the model: ${ASKS[seen.asked - 1]}`);
      for (let w = 0; w < 120_000; w += 1000) {
        if (((await model())?.answers ?? 0) > before) { seen.answered++; break; }
        await sleep(1000);
      }
      // The count moves with the first token: wait until the answer is whole (no streaming turn, and the text stopped growing for 4 s).
      let lastLen = -1, stableSince = Date.now();
      for (let w = 0; w < 120_000; w += 1000) {
        const now = await stage.eval(`(() => { const t = [...document.querySelectorAll("#chatlog .turn")].at(-1); return JSON.stringify({ streaming: !!document.querySelector("#chatlog .turn.streaming"), len: t ? t.innerText.length : 0 }); })()`).then(JSON.parse).catch(() => ({ streaming: true, len: 0 }));
        if (now.len !== lastLen) { lastLen = now.len; stableSince = Date.now(); }
        if (!now.streaming && now.len > 0 && Date.now() - stableSince > 4000) break;
        await sleep(1000);
      }
      step(`the model answered (${seen.answered} of ${seen.asked})`, { chat: (await chatText()).slice(-420) });
      await sleep(4000);
    }
    if (seen.asked >= ASKS.length && seen.answered >= ASKS.length) { await sleep(6000); break; }
    await sleep(500);
  }
  step("done", seen);
  results.items = await writer.eval(`demo.items().map(i => ({ kind: i.kind, status: i.status, text: (i.text ?? i.args ?? '').slice(0, 400), out: String(i.output ?? '').slice(0, 300) }))`).catch(() => []);
  results.model = await model();
  results.finalChat = await chatText();
  results.decisions = readFileSync(join(work, "take", "server.log"), "utf8").split("\n").filter((l) => l.includes('"placement.decision"') || l.includes('"placement.home-check"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const d of results.decisions) step(d.event, d);
  results.problem = !(seen.trained && seen.answered >= ASKS.length) ? `trained ${seen.trained}, answered ${seen.answered} of ${ASKS.length}` : "";
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
