// The take's 03 server: the one tab server D1's home step asks to adopt a winner's run, and the one the stage's disk reads from.
//   node scripts/take-server.mjs [--mount-root /mnt/pda/d5/pipe] [--dir ~/tmp-d5/take] [--run walks-home] [--local DIR]
//                                [--cloud remote-local]
// On the real disk it runs 03's serve.ts under with-archil (the only way this lane touches Archil: the keys exist in that
// child's environment and nowhere else, mounts live under this lane's /mnt/pda/d5/, and the disk is the scratch disk the wrapper
// names). With --local DIR the disk is a local directory and nothing of Archil is touched: a dry run of everything else.
// --cloud remote-local adds browser-demo's second host (remote-host.ts as a child process, environment "remote-local", label "Second
// process"), the one way to get a second host without a unit or a disk client. The run's link is written to <dir>/link (mode 0600) for
// the stage's pipe feed (SHOW_PIPE_LINK_FILE).
// It starts the server on a free port with a fresh admin token (the server writes the token file, mode 0600, in a 0700 directory
// of ours; this script never reads it), the tab-writable creature paths (memory.sqlite is the agent's and is not among them), and
// the model through the broker. It writes a status file (pid, origin, the token file's PATH) and prints the same; no secret is
// printed or written by this script: the server's own log (which holds the run's link) goes to a 0600 file and is only shown here
// with its secrets redacted.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, sleep } from "./cdp.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const here = dirname(fileURLToPath(import.meta.url));
const ex03 = join(here, "..", "..", "..", "03-tab-to-cloud");
const dir = arg("dir", join(homedir(), "tmp-d5", "take"));
const local = arg("local", "");
const mountRoot = arg("mount-root", "/mnt/pda/d5/pipe");
const run = arg("run", "walks-home");
const cloud = arg("cloud", "none");
if (!["none", "remote-local"].includes(cloud)) die(`--cloud ${cloud}: only none or remote-local`);
const wrapper = join(homedir(), "evals", "agentrun-archil-tl", "bin", "with-archil");
const TAB_WRITABLE = "creature/creature.xml,creature/body.json,creature/designs.sqlite";
const redact = (text) => text.replace(/(\/run\/[A-Za-z0-9_-]+)#[A-Za-z0-9_-]+/g, "$1#<redacted>").replace(/Bearer\s+\S+/g, "Bearer <redacted>");
const die = (message) => {
  console.error(`take-server: ${message}`);
  process.exit(2);
};

mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
if (!local) {
  // The mount directory is this lane's, created for it (not by this script: /mnt/pda is root's).
  if (!existsSync(dirname(mountRoot))) die(`${dirname(mountRoot)} does not exist; it is this lane's mount directory and has to be created for it (/mnt/pda is root's)`);
  mkdirSync(mountRoot, { recursive: true });
  if (!existsSync(wrapper)) die(`${wrapper} is missing: the Archil keys only come through it`);
}
const tokenFile = join(dir, "admin-token");
const logFile = join(dir, "server.log");
// A fresh start means a fresh token: remove any old file so the server writes a new one (it creates it 0600).
rmSync(tokenFile, { force: true });
rmSync(logFile, { force: true });
writeFileSync(logFile, "", { mode: 0o600 });

const port = await freePort();
const serveArgs = [
  "serve.ts",
  "--port", String(port),
  "--host", "127.0.0.1",
  "--run", run,
  "--model", "gpt-6-luna",
  "--model-url", "http://127.0.0.1:9421/v1",
  "--budget", "1500000",
  "--admin-token-file", tokenFile,
  "--tab-writable", TAB_WRITABLE,
  "--log", logFile,
  "--cloud", cloud,
  ...(local ? ["--local", local] : ["--mount-root", mountRoot, "--ledger", join(homedir(), "evals", "agentrun-archil-tl", "demo", "D5-LEDGER.json")]),
];
const [cmd, args] = local ? [process.execPath, serveArgs] : [wrapper, ["--", process.execPath, ...serveArgs]];
const child = spawn(cmd, args, { cwd: ex03, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }, stdio: "ignore" });
const origin = `http://127.0.0.1:${port}`;
const stop = () => {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => {
  console.error(`take-server: the server exited with code ${code}\n${redact(readFileSync(logFile, "utf8").split("\n").slice(-20).join("\n"))}`);
  rmSync(join(dir, "status.json"), { force: true });
  process.exit(code === 0 ? 0 : 1);
});

let up = false;
for (let i = 0; i < 150 && !up; i++) {
  if (child.exitCode !== null) break;
  up = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (!up) await sleep(200);
}
if (!up || !existsSync(tokenFile)) {
  console.error(`take-server: did not come up\n${redact(readFileSync(logFile, "utf8").split("\n").slice(-20).join("\n"))}`);
  child.kill("SIGTERM");
  process.exit(1);
}
// The run's link (which holds its secret) comes from the server's own log, and goes only to a 0600 file.
let link = "";
for (let i = 0; i < 100 && !link; i++) {
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.event === "ready" && typeof e.local === "string") link = e.local;
    } catch {
      /* not a log line */
    }
  }
  if (!link) await sleep(100);
}
if (!link) {
  console.error(`take-server: the server never reported the run's link\n${redact(readFileSync(logFile, "utf8").split("\n").slice(-20).join("\n"))}`);
  child.kill("SIGTERM");
  process.exit(1);
}
const linkFile = join(dir, "link");
rmSync(linkFile, { force: true });
writeFileSync(linkFile, `${link}\n`, { mode: 0o600 });
const status = { pid: child.pid, origin, tokenFile, logFile, linkFile, cloud, mode: local ? "local" : "archil", mountRoot: local ? null : mountRoot, run, startedAt: new Date().toISOString() };
writeFileSync(join(dir, "status.json"), JSON.stringify(status, null, 2), { mode: 0o600 });
console.log(`take server up: ${origin}  mode ${status.mode}  run ${run}`);
console.log(`admin token file: ${tokenFile} (mode 0600, never printed)  status: ${join(dir, "status.json")}  pid ${child.pid}`);
