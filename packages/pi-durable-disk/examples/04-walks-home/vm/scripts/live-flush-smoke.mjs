// Does a file a long command writes on the GPU box reach the disk while the command still runs? One short run: the agent moves to the GPU
// box, runs a command that writes probe/N.txt every 8 s for 48 s, and comes home; this script reads the disk through the stage's proxy
// every 500 ms and says when each file first appeared against when the agent's command ended (the writer page's tool item flips to done).
//   CDP_URL=http://127.0.0.1:9455 TAB_DIR=<tab dist> node scripts/live-flush-smoke.mjs --gpu-image im-... [--gpu-type T4]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForFile, waitForStage } from "../../show/scripts/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const show = join(here, "..", "..", "show");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const gpuImage = arg("gpu-image", "");
const gpuType = arg("gpu-type", "T4");
const mountRoot = arg("mount-root", join("/mnt/pda/demo", "d4-pipe"));
const tabDir = process.env.TAB_DIR;
if (!tabDir || !gpuImage) throw new Error("TAB_DIR and --gpu-image are required");
process.env.CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9455";
const work = join(homedir(), "tmp-d4take", `probe-${Date.now().toString(36)}`);
mkdirSync(work, { recursive: true, mode: 0o700 });
const out = arg("out", join(homedir(), "evals", "agentrun-archil-tl", "demo", "d4-evidence", "live-flush.json"));
const GPU_NOTE = "To check that files reach your user while a command runs, run exactly this one command with a bash timeout of 120: mkdir -p probe && for i in 1 2 3 4 5 6; do date +%s > probe/$i.txt; sleep 8; done . Then move home with switch_environment (target tab).";
const TASK = "Run the check your notice describes on the GPU machine: move yourself to modal-gpu with switch_environment first, and when it is done move home. Say nothing else.";

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

const results = { startedAt: new Date().toISOString(), task: TASK, gpuImage, gpuType, steps: [] };
const step = (name, data = {}) => {
  const row = { at: Number(((Date.now() - t0) / 1000).toFixed(2)), name, ...data };
  results.steps.push(row);
  console.log(JSON.stringify(row));
};
let t0 = Date.now();
let writer;
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
      "--cloud-arg", `gpu-note=${GPU_NOTE}`,
      "--cloud-arg", `gpu-type=${gpuType}`,
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
  const stageProc = spawnLogged(process.execPath, [join(show, "serve.ts")], { SHOW_PORT: String(stagePort), SHOW_PIPE_LINK_FILE: linkFile, SHOW_ASK_AFTER_SWITCH: "0", SHOW_AUTOKILL: "off", TAB_DIR: tabDir }, "stage", show);
  await waitForStage(stagePort, stageProc);
  step("the stage is up", { port: stagePort });

  // 3. the 03 page as the can-run writer, then the stage tab, recorded
  writer = await openTab(link, { width: 1400, height: 800 });
  await until(async () => (await writer.eval(`globalThis.demo ? demo.state.mode : ""`).catch(() => "")) === "writer", 240_000, "the 03 page to attach as the writer");
  step("running");
  // 4. ask, then read the disk every 500 ms
  const before = await writer.eval(`demo.items().length`);
  await writer.eval(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(TASK)}; document.getElementById("send").click(); return true; })()`);
  step("asked");
  const first = {};
  let endedAt = 0;
  for (let t = 0; t < 360_000 && !endedAt; t += 500) {
    for (let i = 1; i <= 6; i++) {
      if (first[i]) continue;
      const r = await fetch(`http://127.0.0.1:${stagePort}/api/disk/probe/${i}.txt`).catch(() => null);
      if (r && r.status === 200) {
        first[i] = (Date.now() - t0) / 1000;
        step(`probe/${i}.txt reached the disk`, { value: (await r.text()).trim() });
      }
    }
    const done = await writer
      .eval(`(() => { const t = demo.items().slice(${before}).filter(i => i.kind === "tool" && /probe/.test(String(i.args ?? i.name ?? ""))); return t.length > 0 && t.every(i => i.status !== "running" && i.status !== "pending"); })()`)
      .catch(() => false);
    if (done) endedAt = (Date.now() - t0) / 1000;
    await sleep(500);
  }
  step("the agent's command ended", { at: endedAt });
  results.firstSeen = first;
  results.endedAt = endedAt;
  results.beforeEnd = Object.entries(first).filter(([, s]) => endedAt && s < endedAt - 1).map(([i]) => i);
  results.verdict = results.beforeEnd.length >= 3 ? "live: files arrive while the command runs" : "not live: files arrive when the command ends";
  console.log(results.verdict);
} catch (error) {
  results.error = error.message;
  console.log(`FAIL ${error.message}`);
  for (const k of kids) console.log(`--- ${k.name}\n${redact(k.log().slice(-1500))}`);
} finally {
  writeFileSync(out, JSON.stringify(results, null, 2));
  await writer?.close().catch(() => {});
  for (const k of kids.slice().reverse()) k.kill("SIGTERM");
  await sleep(8000);
  console.log(JSON.stringify({ name: "the run's tree after", cleaned: await cleanRun("walks-home") }));
}
process.exit(results.error ? 1 : 0);
