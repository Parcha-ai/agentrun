// Live mode: the take's server, the stage and a warm H100, with no recorder, waiting for a real user on the stage (reached through an SSH
// tunnel; everything binds to 127.0.0.1). The user draws, asks, watches, and kicks by hand.
//   WITH_ARCHIL=... CDP_URL=http://127.0.0.1:9455 TAB_DIR=<tab dist> node scripts/live.mjs --gpu-image im-... --gpu-note-file <note> [--port 8760] [--ttl 45]
// Stop it with SIGTERM (Ctrl-C): it removes the GPU box and the run's tree. Nothing here prints the run's link or a secret, except under
// --tab browser (below), which prints the link once because the person opens it.
//   --tab headless (default)  the agent's tab is this box's own Chrome (CDP_URL); the person's browser only shows the stage.
//   --tab browser             no Chrome here: the agent's tab is the person's own browser. The run's link (a secret in its fragment) is printed once,
//                             with the ssh line that carries both ports (the 03 server's, --server-port, and the stage's, --port). The GPU box
//                             starts warming when that page attaches, so "LIVE: ready" comes about 4 minutes after the person opens the link.
import { resolveModelsDir } from "../models-dir.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForFile, waitForStage } from "../../show/scripts/cdp.mjs";
import { startScreencast } from "../../show/scripts/screencast.mjs";
import { agentLink } from "../agent-link.ts";

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
// Where the agent's tab is: this box's headless Chrome, or the person's own browser (the link is printed for them to open).
const tabWhere = arg("tab", "headless");
if (tabWhere !== "headless" && tabWhere !== "browser") throw new Error(`--tab is headless or browser, not ${tabWhere}`);
const ownBrowser = tabWhere === "browser";
// A tab in a person's browser has to be reached through a tunnel, so the 03 server's port is fixed (the run's link names it).
const serverPort = arg("server-port", "8763");
// A person's browser throttles a page they are not looking at (its pings can stop for a minute) and goes offline on purpose: the run is not
// declared tab-less for a long while. The headless Chrome's pages are never throttled, so its grace stays short.
const graceMs = arg("grace-ms", ownBrowser ? "180000" : "30000");
// How long the person has to open the link, and then wait for the box, before live gives up.
const openWaitMs = Number(arg("open-wait-ms", 1_800_000));
// The placement question's client: TypeSafe Jev, the only judge (the server starts under the credential wrapper and refuses to start without the key).
const placerClient = arg("placer", "jev");
if (placerClient !== "jev") throw new Error(`--placer is jev: no other judge decides where a run goes (got ${placerClient})`);
// The episode: "walks" (a creature learns to walk), "model" or "obsession" (a language model is trained and comes home as a large file nobody restores), or
// "robot" (one session on a Modal VM forks threads that train skills on a pool of GPU boxes, all of them coming home to the browser).
const episode = arg("episode", "walks");
if (!["walks", "model", "obsession", "robot"].includes(episode)) throw new Error(`--episode is walks, model, obsession or robot, not ${episode}`);
const robot = episode === "robot";
// Robot: the cluster's boxes (a pool of 2 until the whole flow passes, then 8), their image, and what a box runs to show it is ready.
const clusterSize = Number(arg("cluster-size", 2));
const clusterImage = arg("cluster-image", "");
const clusterReady = arg("cluster-ready", "");
// Boxes made beyond the ones needed: a straggler among them cannot hold up "ready" (they cost like the others).
const clusterSpares = Number(arg("cluster-spares", robot ? 1 : 0));
// The boxes are removed after this long unused (a parked or forgotten run must not leave GPUs burning); the next request makes them again. 0: never.
const clusterIdle = Number(arg("cluster-idle-min", robot ? 20 : 0));
const clusterReadyTimeout = arg("cluster-ready-timeout-s", "");
// The skill each box warms for (box 0 first): with a pool of 2, a fast skill and a slow one.
const clusterSkills = arg("cluster-skills", "walk,spin,sprint,backwards,turn-left,turn-right,get-up,wave");
if (robot && !clusterImage) throw new Error("--cluster-image names D2's skill-trainer image");
if (robot && !(Number.isInteger(clusterSize) && clusterSize >= 1)) throw new Error("--cluster-size is a whole number of boxes");
// How many skills the teach step is for (the home check says "N of M came home" against it).
const robotSkills = Number(arg("robot-skills", 8));
// The page that shows the run (served by the stage), and the query the agent's page is opened with.
const stagePath = arg("stage-path", "");
const linkQuery = arg("link-query", "golive=1&robot=1");
// The cloud agent's model, through the broker on this host (the VM reaches it over the link: no key on the VM). Miguel chose gpt-6-sol.
const agentModel = arg("agent-model", "gpt-6-sol");
// The offline brain's model folder (served under /models/ by the 03 server so the page can fetch it while online): --models-dir, or DEMO_MODELS_DIR.
const modelsDirArg = arg("models-dir", process.env.DEMO_MODELS_DIR ?? "");
const modelsDir = modelsDirArg ? resolveModelsDir(modelsDirArg) : ""; // absolute, a folder, with its parts manifest: checked here, before anything starts
// The model's token budget for the run (a robot session has nine conversations).
const modelBudget = String(arg("model-budget", robot ? 30_000_000 : 3_000_000));
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
if (ownBrowser && !/^\d+$/.test(serverPort)) throw new Error("--server-port is a port number");
if (!robot && !gpuImage) throw new Error("--gpu-image names D2's training image");
if (!robot && !gpuNoteFile) throw new Error("--gpu-note-file holds the note the GPU notice carries (D2's command)");
process.env.CDP_URL = cdpUrl;
const work = join(homedir(), "tmp-d4take", `take-${Date.now().toString(36)}`);
mkdirSync(work, { recursive: true, mode: 0o700 });
mkdirSync(dirname(out), { recursive: true });

// The user's one sentence. Everything else the agent knows comes from its instructions and the notice of the machine it is on.
const SAY = process.env.TAKE_SAY ?? "teach it to walk";
const GPU_NOTE = robot ? "" : readFileSync(gpuNoteFile, "utf8").trim();

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
// A stop (SIGTERM, Ctrl-C) ends every wait at once, so the cleanup in `finally` runs while the box is still starting too.
let stopping = false;
let stopNow;
const stopped = new Promise((resolve) => (stopNow = resolve));
class Stopped extends Error {}
const stop = () => {
  stopping = true;
  stopNow?.();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
/** `promise` unless a stop comes first. */
const unlessStopped = (promise) => Promise.race([promise, stopped.then(() => Promise.reject(new Stopped("stopped")))]);
const until = async (fn, ms, what) => {
  for (let t = 0; t < ms; t += 250) {
    if (stopping) throw new Stopped("stopped");
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
  step("the run's tree before the take", { cleaned: await unlessStopped(cleanRun("walks-home")) });
  await until(() => false, 10_000, "the object store to settle").catch((e) => { if (e instanceof Stopped) throw e; }); // the object store settles its deletes before the same run id is created again
  // 1. the take's 03 server on the real disk, with the Modal cloud module
  const take = spawnLogged(
    process.execPath,
    [
      join(show, "scripts", "take-server.mjs"),
      "--mount-root", mountRoot,
      "--dir", join(work, "take"),
      "--run", "walks-home",
      "--budget", modelBudget,
      "--agent-model", agentModel,
      ...(modelsDir ? ["--models-dir", modelsDir] : []),
      "--evidence-readback",
      "--grace-ms", graceMs,
      ...(ownBrowser ? ["--port", serverPort] : []),
      "--modal",
      "--cloud-module", join(here, "..", "cloud-module.ts"),
      "--placer-module", join(here, "..", "placer.ts"),
      "--placer-arg", `client=${placerClient}`,
      ...(episode !== "walks" && !robot ? ["--placer-arg", `episode=${episode === "obsession" ? "obsession" : "model"}`, "--placer-arg", `home-wait-ms=${arg("home-wait-ms", 120000)}`, "--no-restore", "home/model/", "--tab-writable-extra", "creature/model-loaded.json", "--openai", "--judge-model", "gpt-4.1-mini", "--judge-url", "https://api.openai.com/v1", "--judge-key-env", "OPENAI_API_KEY"] : []),
      // The robot: the session is moved to the Modal VM by the placer's "teach" rule; the model files and skills are not restored into the tab (they travel as chunks and files).
      ...(robot ? ["--placer-arg", "episode=robot", "--placer-arg", `skills=${robotSkills}`, "--no-restore", "home/skills/"] : []),
      "--typesafe",
      ...(robot
        ? [
            // The session's VM mounts the disk (the default transport) and the cluster's boxes start when the first page takes the run.
            "--cloud-arg", "robot=true",
            ...(process.argv.includes("--robot-plan") ? ["--cloud-arg", "robot-plan=true"] : []),
            ...(process.argv.includes("--robot-prewarm") ? ["--cloud-arg", "robot-prewarm=true"] : []),
            "--cloud-arg", `cluster-size=${clusterSize}`,
            "--cloud-arg", `cluster-spares=${clusterSpares}`,
            ...(clusterIdle > 0 ? ["--cloud-arg", `cluster-idle-minutes=${clusterIdle}`] : []),
            "--cloud-arg", `cluster-image=${clusterImage}`,
            "--cloud-arg", `cluster-ttl-minutes=${arg("ttl", 45)}`,
            "--cloud-arg", "cluster-cpu=8",
            "--cloud-arg", "cluster-memory-mib=65536",
            "--cloud-arg", `cluster-skills=${clusterSkills}`,
            ...(clusterReady ? ["--cloud-arg", `cluster-ready=${clusterReady}`] : []),
            ...(clusterReadyTimeout ? ["--cloud-arg", `cluster-ready-timeout-s=${clusterReadyTimeout}`] : []),
          ]
        : [
        "--cloud-arg", "vm=false",
        "--cloud-arg", "warm=gpu",
        // A session may hold several tasks: when the agent is back in the tab the next box starts warming, and a move waits for it (up to 8 minutes).
        ...(episode === "obsession" ? ["--cloud-arg", "rewarm=true", "--remote-start-ms", "480000"] : []),
        ...(warmCommandsFile ? ["--cloud-arg", `warm-commands-file=${warmCommandsFile}`, "--cloud-arg", "warm-env=XLA_PYTHON_CLIENT_PREALLOCATE=false"] : []),
        "--cloud-arg", `gpu-image=${gpuImage}`,
        "--cloud-arg", "gpu-type=H100",
        // The box's own lifetime is the backstop when this script or the server is killed: the prewarm, the take and margin, not the default 45 minutes.
        ...(episode === "obsession"
          ? [
              "--cloud-arg", "gpu-cpu=8",
              "--cloud-arg", "gpu-memory-mib=196608",
              "--cloud-arg", "gpu-volume=pda-demo-d2-obsession:/vol",
              "--cloud-arg", `gpu-start-file=${join(here, "..", "obsession-box.txt")}`,
              "--cloud-arg", "gpu-start-env=OPENAI_API_KEY",
              "--cloud-arg", "gpu-ready=grep -q engine.ready /var/tmp/engine.log",
              "--cloud-arg", "gpu-ready-timeout-s=600",
            ]
          : []),
        "--cloud-arg", `gpu-ttl-minutes=${arg("ttl", 45)}`,
        ...(arg("gpu-cpu", "") ? ["--cloud-arg", `gpu-cpu=${arg("gpu-cpu", "")}`] : []),
        ...(arg("gpu-memory-mib", "") ? ["--cloud-arg", `gpu-memory-mib=${arg("gpu-memory-mib", "")}`] : []),
        "--cloud-arg", `gpu-note=${GPU_NOTE}`,
        ]),
      "--cloud-arg", "regions=us-east",
      "--cloud-arg", "prefix=pda-demo-d4-",
      "--cloud-arg", "app=pda-demo-d4",
    ],
    { TMPDIR: join(homedir(), "tmp-d4take", "tmp") },
    "take-server",
    show,
  );
  mkdirSync(join(homedir(), "tmp-d4take", "tmp"), { recursive: true, mode: 0o755 });
  await unlessStopped(waitForFile(join(work, "take", "status.json"), take, 120_000));
  const status = JSON.parse(readFileSync(join(work, "take", "status.json"), "utf8"));
  const linkFile = status.linkFile;
  const link = readFileSync(linkFile, "utf8").trim();
  step("the take's 03 server is up", { origin: status.origin, mode: status.mode });
  // The agent's page, built once: the robot's page also needs the switches for going offline and back (D3's ?golive=1), whoever opens it (the person's browser,
  // this box's Chrome, a reopen); the fragment (the run's secret) stays last.
  const agentUrl = robot ? agentLink(link, linkQuery) : link;

  // 2. the stage, following the run's link
  const stagePort = Number(arg("port", 8760));
  const stageProc = spawnLogged(process.execPath, [join(show, "serve.ts")], { SHOW_PORT: String(stagePort), SHOW_PIPE_LINK_FILE: linkFile, SHOW_ASK_AFTER_SWITCH: "0", SHOW_AUTOKILL: "off", TAB_DIR: tabDir, POLICY_DIR: policyDir }, "stage", show);
  await unlessStopped(waitForStage(stagePort, stageProc));
  step("the stage is up", { port: stagePort });

  // 3. the 03 page, in this box's own Chrome, is where the agent runs while it is "in the browser"; the user's browser shows the stage.
  if (ownBrowser) {
    // The person's browser is the agent's tab: print the link once (the fragment is the run's secret) and the tunnel that reaches both servers.
    const origin = new URL(link);
    // The robot's page also needs the switches for going offline and back (D3's ?golive=1); the fragment (the run's secret) stays last.
    console.log(`LIVE: open this link in your browser; it is the agent's tab. Anyone with it can take over the run, so do not share it: ${agentUrl}`);
    console.log(`LIVE: reach both servers from your machine with: ssh -N -o ServerAliveInterval=5 -L ${origin.port}:127.0.0.1:${origin.port} -L ${stagePort}:127.0.0.1:${stagePort} ubuntu@<this box's tailnet address>`);
    console.log(`LIVE: then open the link above, and the stage at http://127.0.0.1:${stagePort}/${episode === "obsession" ? "obsession/" : stagePath} in another window; keep both windows visible (not minimized)`);
    step("waiting for your browser to open the link", { serverPort: Number(origin.port), stagePort });
  } else {
    // The first attach after the run's tree was just removed can fail once (the disk has no directory for it yet): the page is opened again, up to three times.
    for (let attempt = 1; ; attempt++) {
      writer = await unlessStopped(openTab(agentUrl, { width: 1400, height: 800 }));
      try {
        await until(async () => (await writer.eval(`globalThis.demo ? demo.state.mode : ""`).catch(() => "")) === "writer", attempt < 3 ? 40_000 : 240_000, "the 03 page to attach as the writer");
        break;
      } catch (error) {
        if (error instanceof Stopped || attempt >= 3) throw error;
        step("the 03 page did not attach; opening it again", { attempt });
        await writer.close().catch(() => {});
      }
    }
    step("the 03 page runs the agent");
  }
  // The warm GPU box: ready before anyone is told to start (with the person's browser, it starts warming when their page attaches).
  if (robot) {
    // Every box of the pool has come up or failed; a pool where none came up is a failed start.
    const count = (event) => (readFileSync(join(work, "take", "server.log"), "utf8").match(new RegExp(`"event":"${event}"`, "g")) ?? []).length;
    await until(() => count("cluster.box-up") >= clusterSize || count("cluster.box-up") + count("pool.box-failed") >= clusterSize + clusterSpares, ownBrowser ? openWaitMs : 900_000, `the ${clusterSize} GPU boxes`);
    const up = count("cluster.box-up");
    if (up === 0) throw new Error("no GPU box came up");
    step("the cluster", { up, failed: count("pool.box-failed"), of: clusterSize });
  } else {
  await until(() => readFileSync(join(work, "take", "server.log"), "utf8").includes('"remote.ready"'), ownBrowser ? openWaitMs : episode === "obsession" ? 900_000 : 240_000, "the warm GPU box");
  }
  const readyAt = new Date();
  const until_ = new Date(readyAt.getTime() + Number(arg("ttl", 45)) * 60_000);
  step("LIVE: ready", { url: `http://127.0.0.1:${stagePort}/${stagePath}`, gpuBoxExpiresAt: until_.toISOString().slice(11, 19) + "Z", ttlMinutes: Number(arg("ttl", 45)) });
  // Keep going until told to stop; if the 03 page's tab goes away, open it again (the agent needs a place to start).
  while (!stopping) {
    await sleep(5000);
    const alive = ownBrowser ? 1 : await Promise.race([writer.eval("1").catch(() => 0), sleep(3000).then(() => 0)]);
    if (!alive) {
      step("the 03 page went away; opening it again");
      writer = await openTab(agentUrl, { width: 1400, height: 800 }).catch(() => undefined);
      if (!writer) break;
    }
    if (Date.now() > until_.getTime()) {
      step("the GPU box's lifetime is over: run reset for a fresh one");
      break;
    }
  }
} catch (error) {
  // A stop during startup is not a failure: the cleanup below runs, and the exit code says it went as asked.
  failed = !(error instanceof Stopped);
  console.log(error instanceof Stopped ? "LIVE: stopped while starting" : `FAIL ${error.message}`);
  console.log(redact(kids.find((k) => k.name === "take-server")?.log().slice(-1500) ?? ""));
} finally {
  await writer?.close().catch(() => {});
  for (const k of kids.slice().reverse()) k.kill("SIGTERM");
  await sleep(8000);
  console.log(JSON.stringify({ name: "the run's tree after live", cleaned: await cleanRun("walks-home") }));
}
process.exit(failed ? 1 : 0);
