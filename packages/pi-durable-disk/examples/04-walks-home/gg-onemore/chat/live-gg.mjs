// A chat page with an edited Qwen, live, on this host: its GPU box first (modal/box.py), then the 03 server through D4's
// show/scripts/take-server.mjs, with the page's extra on D4's Modal VM (cloud-args extra-module, extra-secrets,
// robot-code=false) and the placer (chat/gg-placer.ts: Jev decides every placement). The Golden Gate page is the default;
// `--page any` is the page where the person names the topic (chat/steer-extra.ts). Everything here is the page's own
// (chat/server-args.ts PAGES): the Golden Gate page's port 8773, run golden-gate, mount root /mnt/pda/demo/gg-chat-pipe,
// state and logs in ~/tmp-gg-chat and the Modal app pda-gg-chat for the box and the VM; the any-topic page's 8783, steer-any,
// /mnt/pda/demo/steer-any, ~/tmp-steer and pda-steer. Nothing is shared with the robot's scripts. The run's link is printed
// once (the person opens it), with the ssh line. Stop with `chat/stop-gg.sh [--page any]` (SIGTERM): the server, the VM, the
// box and the run's tree; the last line counts the app's sandboxes (0). With no request through the guard for --idle-min
// minutes, it stops itself the same way.
//   node chat/live-gg.mjs [--page golden-gate|any] [--port 8773] [--idle-min 20] [--ttl 90] [--agent-model claude-opus-5.5] [--best-of 3] [--skip-build]
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStep } from "./run-step.ts";
import { boxEnv, DEFAULT_AGENT_MODEL, pageLink, pageProfile, serverArgs } from "./server-args.ts";
import { runStopSteps, stopSteps } from "./stop-steps.ts";

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const G = join(dirname(fileURLToPath(import.meta.url)), "..");
const EX = join(G, "..", "..");
const SHOW = join(EX, "04-walks-home", "show");
const VM = join(EX, "04-walks-home", "vm");
const B = join(homedir(), "evals", "agentrun-archil-tl", "bin");
const PAGE = pageProfile(arg("page", undefined));
const HOME = join(homedir(), PAGE.home);
const PID = join(HOME, "live-gg.pid");
const STATE = join(HOME, "box-state");
const SECRETS = join(HOME, "secrets");
const SERVER = join(HOME, "server");
const MOUNT_ROOT = PAGE.mountRoot;
const APP = PAGE.app;
const RUN = PAGE.run;
const PORT = arg("port", PAGE.port);
const IDLE_MIN = Number(arg("idle-min", 20));
const TTL = arg("ttl", "90");
const AGENT_MODEL = arg("agent-model", DEFAULT_AGENT_MODEL);
const BOX_ENV = { ...process.env, GG_STATE: STATE, GG_APP: APP, ...boxEnv({ bestOf: arg("best-of", undefined) }) };

const t0 = Date.now();
const say = (event, data = {}) => console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 100) / 10, event, ...data }));
const fatal = (why) => {
  console.error(`FATAL: ${why}`);
  process.exit(1);
};
// a failing step's error names the command and its error line; its whole output goes into this log with the failure
const run = runStep;
const failure = (e) => ({ error: String(e.message).slice(0, 600), ...(e.output ? { output: e.output } : {}) });
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
const extraModule = join(G, "dist", `${PAGE.extra}.mjs`);
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
  // the take's evidence first (guard log, strength record, page events, the run's transcript), then the teardown
  const kept = join(HOME, "takes", new Date().toISOString().replace(/[:.]/g, "-"));
  runStopSteps(
    stopSteps(
      {
        // each copy has a time limit: a stalled one is logged as failed and the teardown goes on
        onBox: (cmd) => run(join(B, "with-modal"), ["--", join(B, "with-typesafe"), "--", "python3", join(G, "modal", "box.py"), "exec", "--root", cmd], { env: BOX_ENV, cwd: G, timeout: 120_000 }),
        pageEvents: (dir) => {
          const events = join(SERVER, "server.log");
          if (!existsSync(events)) return "no events";
          // the link's fragment is the run's secret: never kept
          writeFileSync(join(dir, "server.log"), readFileSync(events, "utf8").replace(/#[A-Za-z0-9_-]{20,}/g, "#<secret>"), { mode: 0o600 });
          return join(dir, "server.log");
        },
        pullRun: (dir) => run(join(B, "with-archil"), ["--", process.execPath, join(G, "chat", "pull-run.ts"), RUN, dir], { cwd: G, timeout: 180_000 }),
        boxDown: () => box("down"),
        terminateSandboxes: () => sandboxes("--terminate"),
        cleanRun: () => run(join(B, "with-archil"), ["--", process.execPath, join(VM, "scripts", "clean-run.ts"), RUN], { cwd: VM }),
      },
      kept,
    ),
    say,
  );
  say("kept", { dir: kept });
  for (const name of ["guard-url", "serve-key", "tools-key"]) rmSync(join(SECRETS, name), { force: true });
  try {
    say("modal", { [APP]: sandboxes().split("\n").at(-1) });
  } catch (e) {
    say("modal.failed", failure(e));
  }
  rmSync(PID, { force: true });
  process.exit(code);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

// The disk's API can time out (a 504 from Archil's gateway): a step on it is tried three times before the start gives up.
const onDisk = (fn) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt === 3) throw e;
      say("disk.retry", { attempt, ...failure(e) });
      spawnSync("sleep", ["10"]);
    }
  }
};

try {
  // 1. a fresh run, first: a run id with a history would resume that conversation, and a disk that fails here costs no GPU
  say("run.clean", { out: onDisk(() => run(join(B, "with-archil"), ["--", process.execPath, join(VM, "scripts", "clean-run.ts"), RUN], { cwd: VM })).trim().split("\n").at(-1) });
  // 2. the GPU box (the long pole: 3-7 min)
  say("box.up");
  box("up", "--ttl", TTL);
  box("wait", "--timeout", "900");
  const state = JSON.parse(readFileSync(join(STATE, "box.json"), "utf8"));
  say("box.ready", { sandbox: state.sandbox, s: Math.round((Date.now() - t0) / 1000) });
  // 3. the extra's secrets, for the VM (staged for its run user by D4's extra-secrets)
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  chmodSync(SECRETS, 0o700);
  writeFileSync(join(SECRETS, "guard-url"), `${state.url}\n`, { mode: 0o600 });
  writeFileSync(join(SECRETS, "serve-key"), readFileSync(state.key_file), { mode: 0o600 });
  writeFileSync(join(SECRETS, "tools-key"), readFileSync(state.exec_key_file), { mode: 0o600 });
  // 4. the 03 server, on this page's own port, run, mount root and Modal app; the page creates the root conversation in the
  // browser with the page's instructions and without the extensions it does not use (serve.ts --instructions-file ...)
  const instructions = join(HOME, "instructions.txt");
  writeFileSync(instructions, PAGE.instructions, { mode: 0o600 });
  mkdirSync(MOUNT_ROOT, { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, "tmp"), { recursive: true, mode: 0o755 });
  rmSync(join(SERVER, "status.json"), { force: true });
  const log = join(HOME, "take-server.log");
  writeFileSync(log, "", { mode: 0o600 });
  const out = openSync(log, "a");
  server = spawn(
    process.execPath,
    serverArgs({
      takeServer: join(SHOW, "scripts", "take-server.mjs"),
      mountRoot: MOUNT_ROOT,
      serverDir: SERVER,
      run: RUN,
      port: PORT,
      agentModel: AGENT_MODEL,
      cloudModule: join(VM, "cloud-module.ts"),
      app: APP,
      extraModule,
      secrets: SECRETS,
      placer: join(G, "chat", "gg-placer.ts"),
      instructions,
    }),
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
  console.log(`LIVE: open ${pageLink(base, secret)}`);
  console.log(`LIVE: then ssh -N -o ServerAliveInterval=5 -o ExitOnForwardFailure=yes -L ${PORT}:127.0.0.1:${PORT} ubuntu@${ip}`);
  say("ready", { s: Math.round((Date.now() - t0) / 1000) });
  // 5. idle: no request through the guard for --idle-min minutes, and the box goes down (a forgotten page must not burn GPUs)
  let lastActive = Date.now();
  setInterval(() => {
    try {
      const mtime = Number(box("exec", "--root", "stat -c %Y /var/tmp/gg/guard.jsonl 2>/dev/null || echo 0").trim().split("\n").at(-1)) * 1000;
      lastActive = Math.max(lastActive, mtime);
    } catch (e) {
      say("idle.check_failed", failure(e));
    }
    if (Date.now() - lastActive > IDLE_MIN * 60_000) void stop(`idle for ${IDLE_MIN} min`);
  }, 60_000);
} catch (e) {
  say("failed", failure(e));
  await stop("start failed", 1);
}
