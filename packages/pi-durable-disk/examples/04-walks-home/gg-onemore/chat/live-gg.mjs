// The Golden Gate chat page, live, on this host: its GPU box first (modal/box.py), then the 03 server through D4's
// show/scripts/take-server.mjs, with the GG extra on D4's Modal VM (cloud-args extra-module, extra-secrets, robot-code=false)
// and the GG placer (chat/gg-placer.ts: Jev decides every placement). Everything here is the page's own: port 8773, run
// golden-gate, mount root /mnt/pda/demo/gg-chat-pipe, state and logs in ~/tmp-gg-chat, the Modal app pda-gg-chat for the box
// and the VM. Nothing is shared with the robot's scripts. The run's link is printed once (the person opens it), with the ssh
// line. Stop with chat/stop-gg.sh (SIGTERM): the server, the VM, the box and the run's tree; the last line counts the app's
// sandboxes (0). With no request through the guard for --idle-min minutes, it stops itself the same way.
//   node chat/live-gg.mjs [--port 8773] [--idle-min 20] [--ttl 90] [--agent-model gpt-6-sol] [--skip-build]
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const G = join(dirname(fileURLToPath(import.meta.url)), "..");
const EX = join(G, "..", "..");
const SHOW = join(EX, "04-walks-home", "show");
const VM = join(EX, "04-walks-home", "vm");
const B = join(homedir(), "evals", "agentrun-archil-tl", "bin");
const HOME = join(homedir(), "tmp-gg-chat");
const PID = join(HOME, "live-gg.pid");
const STATE = join(HOME, "box-state");
const SECRETS = join(HOME, "secrets");
const SERVER = join(HOME, "server");
const MOUNT_ROOT = "/mnt/pda/demo/gg-chat-pipe";
const APP = "pda-gg-chat";
const RUN = "golden-gate";
const PORT = arg("port", "8773");
const IDLE_MIN = Number(arg("idle-min", 20));
const TTL = arg("ttl", "90");
const AGENT_MODEL = arg("agent-model", "gpt-6-sol");
const BOX_ENV = { ...process.env, GG_STATE: STATE, GG_APP: APP };

const t0 = Date.now();
const say = (event, data = {}) => console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 100) / 10, event, ...data }));
const fatal = (why) => {
  console.error(`FATAL: ${why}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(" ").slice(0, 160)} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  return r.stdout;
};
const box = (...args) => run(join(B, "with-modal"), ["--", join(B, "with-typesafe"), "--", "python3", join(G, "modal", "box.py"), ...args], { env: BOX_ENV, cwd: G });
const sandboxes = (...extra) => run(join(B, "with-modal"), ["--", process.execPath, join(G, "chat", "gg-sandboxes.mjs"), APP, ...extra], { cwd: G }).trim();

// Only one of these at a time, and only its own pid file.
mkdirSync(HOME, { recursive: true, mode: 0o700 });
if (existsSync(PID)) {
  const old = Number(readFileSync(PID, "utf8"));
  let alive = false;
  try {
    process.kill(old, 0);
    alive = true;
  } catch {}
  if (alive) fatal(`live-gg is already running (pid ${old}); stop it with chat/stop-gg.sh`);
}
writeFileSync(PID, String(process.pid), { mode: 0o600 });

// Jev decides every placement: no key, nothing starts.
if (!run(join(B, "with-typesafe"), ["--names"]).split("\n").includes("TYPESAFE_API_KEY")) fatal("the TypeSafe key is not available (with-typesafe --names); Jev decides every placement and there is no fallback");
// the installs a fresh checkout needs (the card's step), checked here: a missing one would only show as the server exiting
for (const [path, step] of [
  [join(VM, "node_modules", "modal"), "npm ci in 04-walks-home/vm"],
  [join(G, "node_modules", "modal"), "npm ci in gg-onemore"],
  [join(EX, "03-tab-to-cloud", "node_modules", "@wasmer", "sdk"), "npm install --no-workspaces --ignore-scripts in 03-tab-to-cloud"],
]) if (!existsSync(path)) fatal(`${path} is missing: ${step} (the card's install step)`);
const webc = join(EX, "03-tab-to-cloud", "tab", "dist", "pkgs", "edgejs.webc");
if (!existsSync(webc) || statSync(webc).size < 70_000_000) fatal(`${webc} is missing: build the 03 page first (the card's install step)`);
if (!process.argv.includes("--skip-build")) run("npm", ["run", "-s", "bundle:extra"], { cwd: G });
const extraModule = join(G, "dist", "gg-extra.mjs");
if (!existsSync(extraModule)) fatal(`${extraModule} is missing: npm run bundle:extra`);

let server;
let stopping = false;
async function stop(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  say("stopping", { reason });
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    for (let i = 0; i < 60 && server.exitCode === null; i++) await new Promise((r) => setTimeout(r, 1000));
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  for (const step of [
    ["box down", () => box("down")],
    ["the app's sandboxes", () => sandboxes("--terminate")],
    ["the run's tree", () => run(join(B, "with-archil"), ["--", process.execPath, join(VM, "scripts", "clean-run.ts"), RUN], { cwd: VM })],
  ]) {
    try {
      say("stop", { step: step[0], out: String(step[1]()).trim().split("\n").at(-1) });
    } catch (e) {
      say("stop.failed", { step: step[0], error: String(e.message).slice(0, 300) });
    }
  }
  for (const name of ["guard-url", "serve-key", "tools-key"]) rmSync(join(SECRETS, name), { force: true });
  try {
    say("modal", { [APP]: sandboxes().split("\n").at(-1) });
  } catch (e) {
    say("modal.failed", { error: String(e.message).slice(0, 200) });
  }
  rmSync(PID, { force: true });
  process.exit(code);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

try {
  // 1. the GPU box (the long pole: 3-7 min)
  say("box.up");
  box("up", "--ttl", TTL);
  box("wait", "--timeout", "900");
  const state = JSON.parse(readFileSync(join(STATE, "box.json"), "utf8"));
  say("box.ready", { sandbox: state.sandbox, s: Math.round((Date.now() - t0) / 1000) });
  // 2. the extra's secrets, for the VM (staged for its run user by D4's extra-secrets, read once there and deleted)
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  chmodSync(SECRETS, 0o700);
  writeFileSync(join(SECRETS, "guard-url"), `${state.url}\n`, { mode: 0o600 });
  writeFileSync(join(SECRETS, "serve-key"), readFileSync(state.key_file), { mode: 0o600 });
  writeFileSync(join(SECRETS, "tools-key"), readFileSync(state.exec_key_file), { mode: 0o600 });
  // 3. a fresh run: a run id with a history would resume that conversation
  say("run.clean", { out: run(join(B, "with-archil"), ["--", process.execPath, join(VM, "scripts", "clean-run.ts"), RUN], { cwd: VM }).trim().split("\n").at(-1) });
  // 4. the 03 server, on this page's own port, run, mount root and Modal app
  mkdirSync(MOUNT_ROOT, { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, "tmp"), { recursive: true, mode: 0o755 });
  rmSync(join(SERVER, "status.json"), { force: true });
  const log = join(HOME, "take-server.log");
  writeFileSync(log, "", { mode: 0o600 });
  const out = openSync(log, "a");
  server = spawn(
    process.execPath,
    [
      join(SHOW, "scripts", "take-server.mjs"),
      "--mount-root", MOUNT_ROOT,
      "--dir", SERVER,
      "--run", RUN,
      "--port", PORT,
      "--budget", "3000000",
      "--agent-model", AGENT_MODEL,
      "--grace-ms", "180000",
      "--modal",
      "--typesafe",
      "--cloud-module", join(VM, "cloud-module.ts"),
      "--cloud-arg", "regions=us-east",
      "--cloud-arg", `app=${APP}`,
      "--cloud-arg", `prefix=${APP}-`,
      "--cloud-arg", `extra-module=${extraModule}`,
      "--cloud-arg", `extra-secrets=${SECRETS}`,
      "--cloud-arg", "robot-code=false",
      "--placer-module", join(G, "chat", "gg-placer.ts"),
      "--placer-arg", "client=jev",
    ],
    { cwd: SHOW, env: { ...process.env, TMPDIR: join(HOME, "tmp") }, stdio: ["ignore", out, out] },
  );
  server.on("exit", (c) => void stop(`the server exited (${c})`, c === 0 ? 0 : 1));
  for (let i = 0; i < 240 && !existsSync(join(SERVER, "status.json")); i++) await new Promise((r) => setTimeout(r, 500));
  if (!existsSync(join(SERVER, "status.json"))) throw new Error(`the server did not start: see ${log}`);
  const status = JSON.parse(readFileSync(join(SERVER, "status.json"), "utf8"));
  const link = readFileSync(status.linkFile, "utf8").trim();
  const [base, secret] = link.split("#");
  const ip = spawnSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).stdout.trim().split("\n")[0] || "<this host>";
  // printed once: the person opens it (its fragment is the run's secret)
  // thinking=open: the thinking open and dimmed as it streams; gg=1: the page's own instructions for the root conversation
  console.log(`LIVE: open ${base}${base.includes("?") ? "&" : "?"}thinking=open&gg=1#${secret}`);
  console.log(`LIVE: then ssh -N -o ServerAliveInterval=5 -o ExitOnForwardFailure=yes -L ${PORT}:127.0.0.1:${PORT} ubuntu@${ip}`);
  say("ready", { s: Math.round((Date.now() - t0) / 1000) });
  // 5. idle: no request through the guard for --idle-min minutes, and the box goes down (a forgotten page must not burn GPUs)
  let lastActive = Date.now();
  setInterval(() => {
    try {
      const mtime = Number(box("exec", "--root", "stat -c %Y /var/tmp/gg/guard.jsonl 2>/dev/null || echo 0").trim().split("\n").at(-1)) * 1000;
      lastActive = Math.max(lastActive, mtime);
    } catch (e) {
      say("idle.check_failed", { error: String(e.message).slice(0, 200) });
    }
    if (Date.now() - lastActive > IDLE_MIN * 60_000) void stop(`idle for ${IDLE_MIN} min`);
  }, 60_000);
} catch (e) {
  say("failed", { error: String(e.message).slice(0, 600) });
  await stop("start failed", 1);
}
