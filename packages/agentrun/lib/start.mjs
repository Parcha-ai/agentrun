// `npx @parcha/agentrun`: AgentRun Server on this machine. The server is this package's dependency at its exact version, so
// npx installs the two together and this command always runs the server it was released with. The server's own CLI picks
// the port and whether to open the browser; this command passes its arguments through.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { main as cli, NOUNS, words } from "./cli.mjs";

export const SERVE_PACKAGE = "@parcha/agentrun-serve";
/** This command's package at its version, handed to the server it starts (AGENTRUN_NPX_PACKAGE), so the server's hints
 *  name this command. */
export const OWN_SPEC = `@parcha/agentrun@${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`;
/** Where the server listens and the console is opened: this machine only. */
export const HOST = "127.0.0.1"; // key-gate: loopback-rule the server this starts listens on this machine only

/** The URL an "Open " line names: its first word after "Open ", when that is an http(s) URL on `HOST`, where the server
 *  this command starts listens, or at `publicUrl`'s origin, the address the server names instead when it was started with
 *  AGENTRUN_PUBLIC_URL; any text after it (what the link does) is not part of it. Undefined for any other line. */
export function openLineUrl(line, publicUrl) {
  const word = /^Open (\S+)/.exec(line)?.[1];
  if (word === undefined || !URL.canParse(word)) return undefined;
  const url = new URL(word);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === HOST) return word;
  return publicUrl !== undefined && URL.canParse(publicUrl) && url.origin === new URL(publicUrl).origin ? word : undefined;
}

/** How many of the server's last output lines a start that fails shows. */
export const TAIL_LINES = 20;

/** The server's lines this command says too, as they come: its banner's boxes line (whether new agents get the Docker
 *  box, or why not) and the Docker box image's first build, as it starts and ends. */
export const SAID = /^(Boxes: |Preparing the Docker box image |The Docker box image )/;

/** The address a person opens first, as the server says it: the URL of the first "Open " line of its output that names
 *  one (openLineUrl). That line is the server's interface for it (the plain address today, a single-use sign-in link
 *  once the server prints one), so this command never builds the address itself. Resolves undefined when the output ends
 *  without one. Until then, the last TAIL_LINES lines before it are kept in `seen`: what a start that fails shows. Every
 *  whole line after it goes to `onLine`; the rest of the output is read and dropped, so the server never blocks on a full
 *  pipe. */
export function openUrl(stdout, publicUrl, seen = [], onLine = () => {}) {
  const keep = (line) => {
    seen.push(line);
    if (seen.length > TAIL_LINES) seen.shift();
  };
  return new Promise((resolve) => {
    let pending = "";
    let found;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (found !== undefined) onLine(line);
        else if ((found = openLineUrl(line, publicUrl)) !== undefined) resolve(found);
        else keep(line);
      }
    });
    stdout.on("end", () => {
      if (found === undefined && pending !== "") keep(pending);
      resolve(found);
    });
  });
}

/** A process's command line, or undefined once it is gone: from /proc on Linux, else from ps. */
export function commandOf(pid) {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || undefined;
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A process's parent, or undefined once it is gone. */
export function parentOf(pid) {
  try {
    if (process.platform === "linux") return Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]);
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? Number(out) : undefined;
  } catch {
    return undefined;
  }
}

const isNpm = (command) => /^npm(?:\s|$)/.test(command ?? "");

/** The npm that runs this command, when `npm exec` (npx) started it: npm says so in the environment (`npm_command` is
 *  exec, in npm 10 and 11) and names its own process `npm exec …`, two steps up (npm, its `sh -c`, this). Undefined for
 *  a command started any other way, which watches nothing. */
export function npmExecOf(env, from = process.ppid) {
  if (env.npm_command !== "exec") return undefined;
  for (let pid = from, step = 0; pid > 1 && step < 3; step++, pid = parentOf(pid)) if (isNpm(commandOf(pid))) return pid;
  return undefined;
}

export const USAGE = `Usage: npx @parcha/agentrun [--port N] [--data DIR] [--no-open]   start the server
       npx @parcha/agentrun import|reset-password [--data DIR]   a server command
       npx @parcha/agentrun <command> [args]   the server's API: agents, runs, triggers, ..., api (npx @parcha/agentrun help)`;

/** The server's launcher, installed with this package (its dependency), or undefined. */
export function installedServer(resolve = createRequire(import.meta.url).resolve) {
  try {
    return join(dirname(resolve(`${SERVE_PACKAGE}/package.json`)), "launcher", "agentrun-serve");
  } catch {
    return undefined;
  }
}

/** The server's arguments: this command's own, with the browser opened unless --no-open says not to (the server's
 *  --open, which itself skips a CI run and a machine with no display). */
export const serverArgs = (argv) => (argv.includes("--no-open") ? argv.filter((arg) => arg !== "--no-open") : ["--open", ...argv]);

export async function main(argv, env = process.env) {
  if (NOUNS.has(words(argv)[0])) return cli(argv, env);
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE), 0;
  if (process.platform === "win32") return console.error("AgentRun's server runs on macOS and Linux; on Windows, use WSL or its container."), 1;
  const launcher = installedServer();
  if (launcher === undefined) return console.error(`AgentRun's server (${SERVE_PACKAGE}) is not installed beside this command; run it as npx ${OWN_SPEC}.`), 1;
  const childEnv = { AGENTRUN_LOG: "quiet", ...env, AGENTRUN_NPX_PACKAGE: OWN_SPEC };
  // Started by npx, this runs under npm exec and its `sh -c`. A signal to npm alone (a process manager's SIGTERM or
  // SIGKILL) ends npm and leaves this, and the server, with nobody to stop them: this finds that npm now, at its start,
  // and stops the server when it goes. Started any other way, it watches nothing, so a shell's own rules apply (`&`,
  // nohup).
  const npm = npmExecOf(env);
  const npmGone = () => npm !== undefined && !isNpm(commandOf(npm));
  // The data directory is ~/.agentrun unless --data names one, handed to the server and its subcommands (import,
  // reset-password) as --data (the server's own default is another directory). The server's hints name it too, so each
  // opens this same store.
  // `--data <dir>` and `--data=<dir>` are the same option, and the last one wins, as the server reads them; the server is
  // handed exactly one, so this command, its hint and the server agree on the directory.
  let dir;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data" && i + 1 < argv.length) dir = argv[++i];
    else if (argv[i].startsWith("--data=")) dir = argv[i].slice("--data=".length);
    else rest.push(argv[i]);
  }
  const dataDir = dir ?? join(homedir(), ".agentrun");
  // A name that starts with a dash keeps the equals form: the server's parser reads "--data -x" as a missing value.
  const data = dataDir.startsWith("-") ? [`--data=${dataDir}`] : ["--data", dataDir];
  if (rest[0] && !rest[0].startsWith("-")) {
    return new Promise((resolve) => spawn(launcher, [rest[0], ...data, ...rest.slice(1)], { stdio: "inherit", env: childEnv }).on("exit", (code) => resolve(code ?? 1)));
  }
  // The server's banner and request lines stay out of this terminal: one line here says where to go, the URL of the
  // server's own "Open " line; the lines SAID names go to stderr after it, for the person, so stdout stays that one line.
  // What it prints on stderr (why it did not start) comes through as it is.
  const child = spawn(launcher, serverArgs([...data, ...rest]), { stdio: ["ignore", "pipe", "inherit"], env: childEnv });
  // A stop this command passes on (Ctrl-C, a process manager's SIGTERM, npm gone) is a clean end, 0, even when the signal
  // itself ends the server; a server ended by a signal nobody here sent is not.
  let stopping = false;
  const stop = (signal) => {
    stopping = true;
    child.kill(signal);
  };
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? (stopping ? 0 : 1))));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
  // A SIGHUP to this command alone (not the terminal's, which reaches the server too) asks the server to stop as a SIGTERM
  // does.
  process.on("SIGHUP", () => stop("SIGTERM"));
  // When that npm goes, the server stops, as on a SIGTERM, and this ends.
  if (npm !== undefined) {
    const watch = setInterval(() => {
      if (!npmGone()) return;
      clearInterval(watch);
      stop("SIGTERM");
    }, 1000);
    watch.unref();
    child.on("exit", () => clearInterval(watch));
  }
  let timer;
  let told = false;
  const held = [];
  const tell = (line) => SAID.test(line) && (told ? console.error(line) : held.push(line));
  const seen = [];
  const url = await Promise.race([openUrl(child.stdout, env.AGENTRUN_PUBLIC_URL, seen, tell), new Promise((resolve) => { timer = setTimeout(resolve, 60_000); })]);
  clearTimeout(timer);
  if (url === undefined) {
    child.kill("SIGTERM");
    // Its stdout is kept out of this terminal, so its last lines are shown here: with its stderr above, they say why.
    console.error(seen.length > 0 ? `AgentRun did not start. The server's last lines:\n${seen.map((line) => `  ${line}`).join("\n")}` : "AgentRun did not start, and the server printed nothing.");
    return (await exited) || 1;
  }
  console.log(`AgentRun is running at ${url}`);
  // For the person at the terminal (stderr, so stdout stays the one line a script reads): how to stop it, and where its
  // data is kept, which the next start opens again.
  console.error(`Press Ctrl-C to stop it. Its data is in ${dataDir}.`);
  // And where the API's bearer token is: the server prints it on a line this terminal doesn't show.
  console.error(env.AGENTRUN_TOKEN ? "The API token is the AGENTRUN_TOKEN this command was started with." : `The API token is in ${join(dataDir, ".token")}.`);
  told = true;
  for (const line of held.splice(0)) console.error(line);
  return exited;
}
