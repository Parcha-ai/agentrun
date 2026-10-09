// Live mode: the take's server, the stage and a warm H100, with no recorder, waiting for a real user on the stage (reached through an SSH
// tunnel; everything binds to 127.0.0.1). The user draws, asks, watches, and kicks by hand.
//   WITH_ARCHIL=... CDP_URL=http://127.0.0.1:9455 TAB_DIR=<tab dist> node scripts/live.mjs --gpu-image im-... --gpu-note-file <note> [--port 8760] [--ttl 45]
// Stop it with SIGTERM (Ctrl-C): it removes the GPU box and the run's tree. Nothing here prints the run's link or a secret.
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
      ...(placerClient === "jev" ? ["--typesafe"] : []),
      "--cloud-arg", "vm=false",
      "--cloud-arg", "warm=gpu",
      ...(warmCommandsFile ? ["--cloud-arg", `warm-commands-file=${warmCommandsFile}`, "--cloud-arg", "warm-env=XLA_PYTHON_CLIENT_PREALLOCATE=false"] : []),
      "--cloud-arg", `gpu-image=${gpuImage}`,
      "--cloud-arg", "gpu-type=H100",
      // The box's own lifetime is the backstop when this script or the server is killed: the prewarm, the take and margin, not the default 45 minutes.
      "--cloud-arg", `gpu-ttl-minutes=${arg("ttl", 45)}`,
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
  const stagePort = Number(arg("port", 8760));
  const stageProc = spawnLogged(process.execPath, [join(show, "serve.ts")], { SHOW_PORT: String(stagePort), SHOW_PIPE_LINK_FILE: linkFile, SHOW_ASK_AFTER_SWITCH: "0", SHOW_AUTOKILL: "off", TAB_DIR: tabDir, POLICY_DIR: policyDir }, "stage", show);
  await waitForStage(stagePort, stageProc);
  step("the stage is up", { port: stagePort });

  // 3. the 03 page, in this box's own Chrome, is where the agent runs while it is "in the browser"; the user's browser shows the stage.
  writer = await openTab(link, { width: 1400, height: 800 });
  await until(async () => (await writer.eval(`globalThis.demo ? demo.state.mode : ""`).catch(() => "")) === "writer", 240_000, "the 03 page to attach as the writer");
  step("the 03 page runs the agent");
  // The warm GPU box: ready before anyone is told to start.
  await until(() => readFileSync(join(work, "take", "server.log"), "utf8").includes('"remote.ready"'), 240_000, "the warm GPU box");
  const readyAt = new Date();
  const until_ = new Date(readyAt.getTime() + Number(arg("ttl", 45)) * 60_000);
  step("LIVE: ready", { url: `http://127.0.0.1:${stagePort}/`, gpuBoxExpiresAt: until_.toISOString().slice(11, 19) + "Z", ttlMinutes: Number(arg("ttl", 45)) });
  // Keep going until told to stop; if the 03 page's tab goes away, open it again (the agent needs a place to start).
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    await sleep(5000);
    const alive = await Promise.race([writer.eval("1").catch(() => 0), sleep(3000).then(() => 0)]);
    if (!alive) {
      step("the 03 page went away; opening it again");
      writer = await openTab(link, { width: 1400, height: 800 }).catch(() => undefined);
      if (!writer) break;
    }
    if (Date.now() > until_.getTime()) {
      step("the GPU box's lifetime is over: run reset for a fresh one");
      break;
    }
  }
} catch (error) {
  failed = true;
  console.log(`FAIL ${error.message}`);
  console.log(redact(kids.find((k) => k.name === "take-server")?.log().slice(-1500) ?? ""));
} finally {
  await writer?.close().catch(() => {});
  for (const k of kids.slice().reverse()) k.kill("SIGTERM");
  await sleep(8000);
  console.log(JSON.stringify({ name: "the run's tree after live", cleaned: await cleanRun("walks-home") }));
}
process.exit(failed ? 1 : 0);
