// `npx @parcha/agentrun`: AgentRun Server on this machine. The server is not this package's dependency, so this installs
// alone and a server release does not change it: the server's launcher runs from an install beside this one when there is
// one, else `npm exec` fetches the server's latest release.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVE_SPEC = "@parcha/agentrun-serve@latest";
export const DEFAULT_PORT = 7340;
/** Where the server listens and the console is opened: this machine only. */
export const HOST = "127.0.0.1"; // key-gate: loopback-rule the server this starts listens on this machine only
/** The model a server with no `AGENT_MODEL` runs, from the first key it is handed: the server reads each key, but picks
 *  no model from one. Each is in pi-ai's catalog. */
export const KEY_MODELS = [["ANTHROPIC_API_KEY", "anthropic/claude-sonnet-5-5"], ["OPENAI_API_KEY", "openai/gpt-6.1-sol"], ["OPENROUTER_API_KEY", "openrouter/anthropic/claude-sonnet-5.5"]];
export const modelEnv = (env) => (env.AGENT_MODEL || env.AGENT_MODEL_BASE_URL ? {} : Object.fromEntries(KEY_MODELS.filter(([key]) => env[key]).slice(0, 1).map(([, model]) => ["AGENT_MODEL", model])));
export const shouldOpen = (args, env, platform = process.platform) => !args.includes("--no-open") && !env.CI && (!["linux", "freebsd"].includes(platform) || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY));
/** The URL an "Open " line names: its first word after "Open ", when that is an http(s) URL on `HOST`, where the server
 *  this command starts listens; any text after it (what the link does) is not part of it. Undefined for any other line. */
export function openLineUrl(line) {
  const word = /^Open (\S+)/.exec(line)?.[1];
  if (word === undefined || !URL.canParse(word)) return undefined;
  const url = new URL(word);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname === HOST ? word : undefined;
}

/** The address a person opens first, as the server says it: the URL of the first "Open " line of its output that names
 *  one (openLineUrl). That line is the server's interface for it (the console's address, whose first visit sets the
 *  owner's password), so this command never builds the address itself. Resolves undefined when the output ends
 *  without one; the rest of the output is read and dropped, so the server never blocks on a full pipe. */
export function openUrl(stdout) {
  return new Promise((resolve) => {
    let pending = "";
    let found;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk) => {
      if (found !== undefined) return;
      pending += chunk;
      for (let end = pending.indexOf("\n"); end >= 0 && found === undefined; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        const url = openLineUrl(line);
        if (url !== undefined) resolve((found = url));
      }
    });
    stdout.on("end", () => resolve(found));
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

export async function freePort(from = DEFAULT_PORT) {
  for (let port = from; port < from + 100; port++) {
    const free = await new Promise((resolve) => { const s = createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true))); s.listen(port, HOST); });
    if (free) return port;
  }
  throw new Error(`no free port on ${HOST} from ${from}`);
}

export const USAGE = "Usage: npx @parcha/agentrun [--port N] [--data DIR] [--no-open], or a server command: import, reset-password";

/** The environment for this command's own `npm exec`: without the settings an outer npm hands down to what it runs (a
 *  `-c` command, a workspace), which would make that `npm exec` refuse its arguments or look for a workspace. */
export const fetchEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !/^npm_config_(call|workspaces?|include_workspace_root)$/i.test(name)));

/** The `npm exec` that fetches the server's latest release, the package named with --package, into npm's own cache as npx
 *  does, and names its bin's path: it runs nothing else. */
export const FETCH = ["exec", "--yes", `--package=${SERVE_SPEC}`, "--", "sh", "-c", "command -v agentrun-serve"];

/** The server's command: an installed server's launcher; with none, `fetched`, and the command is the bin fetchServer
 *  names. Either way the server gets only its own arguments. */
export function server(args, resolve = createRequire(import.meta.url).resolve) {
  try {
    return { command: join(dirname(resolve("@parcha/agentrun-serve/package.json")), "launcher", "agentrun-serve"), args, fetched: false };
  } catch {
    return { command: undefined, args, fetched: true };
  }
}

/** With no server beside this command: npm exec installs the server's latest release and names its bin, which this command
 *  then runs itself, so no npm stands between them and a stop reaches the server (an npm exec ends on a SIGTERM or a
 *  SIGHUP and leaves what it started). npm's own lines go to stderr; it never gets an outer npm's settings (fetchEnv). */
export function fetchServer(env) {
  return new Promise((resolve, reject) => {
    const npm = spawn("npm", FETCH, { stdio: ["ignore", "pipe", "inherit"], env: fetchEnv(env) });
    let out = "";
    npm.stdout.setEncoding("utf8");
    npm.stdout.on("data", (chunk) => (out += chunk));
    npm.on("error", reject);
    npm.on("exit", (code) => {
      const path = out.trim().split("\n").at(-1);
      if (code === 0 && path) resolve(path);
      else reject(new Error(`npm exec could not fetch the server, ${SERVE_SPEC} (exit ${code})`));
    });
  });
}

export async function main(argv, env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE), 0;
  if (process.platform === "win32") return console.error("AgentRun's server runs on macOS and Linux; on Windows, use WSL or its container."), 1;
  const at = argv.indexOf("--data");
  const dir = at >= 0 ? argv[at + 1] : join(homedir(), ".agentrun");
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  // AGENTRUN_COMMAND tells the server this command started it, so a missing harness's install line keeps the person on it.
  const childEnv = { AGENTRUN_LOG: "quiet", ...env, ...modelEnv(env), AGENTRUN_COMMAND: "agentrun" };
  // A subcommand (import, reset-password) is the server's own, on the same data directory.
  if (rest[0] && !rest[0].startsWith("-")) {
    const { command, args, fetched } = server([rest[0], "--data", dir, ...rest.slice(1)]);
    const bin = fetched ? await fetchServer(childEnv).catch((error) => void console.error(`AgentRun: ${error.message}`)) : command;
    if (!bin) return 1;
    return new Promise((resolve) => spawn(bin, args, { stdio: "inherit", env: childEnv }).on("exit", (code) => resolve(code ?? 1)));
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = rest.indexOf("--port");
  const port = p >= 0 && Number(rest[p + 1]) > 0 ? Number(rest[p + 1]) : await freePort();
  const passed = rest.filter((arg, i) => arg !== "--no-open" && !(p >= 0 && (i === p || i === p + 1)));
  const { command, args, fetched } = server(["--data", dir, "--port", String(port), ...passed]);
  if (fetched) console.error(`Starting AgentRun (the first run fetches its server, ${SERVE_SPEC})...`);
  const bin = fetched ? await fetchServer(childEnv).catch((error) => void console.error(`AgentRun: ${error.message}`)) : command;
  if (!bin) return 1;
  // The server's banner and request lines stay out of this terminal: one line here says where to go, the URL of the
  // server's own "Open " line.
  // The server is this command's own child (fetchServer runs nothing between them): a stop signals it alone, and it drains
  // its runs, each once. A SIGHUP to this command alone (not the terminal's, which reaches the server too) asks the server
  // to stop as a SIGTERM does.
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"], env: childEnv });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  const stop = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
  process.on("SIGHUP", () => stop("SIGTERM"));
  // Started by npx, this runs under npm exec and its `sh -c`. A signal to npm alone (a process manager's SIGTERM or
  // SIGKILL) ends npm and leaves this, and the server, with nobody to stop them: when that npm is gone, it stops the server,
  // as SIGTERM would, and ends. Started any other way, it watches nothing, so a shell's own rules apply (`&`, nohup).
  const npm = npmExecOf(env);
  if (npm !== undefined) {
    const watch = setInterval(() => {
      if (isNpm(commandOf(npm))) return;
      clearInterval(watch);
      stop("SIGTERM");
    }, 1000);
    watch.unref();
    child.on("exit", () => clearInterval(watch));
  }
  let timer;
  const url = await Promise.race([openUrl(child.stdout), new Promise((resolve) => { timer = setTimeout(resolve, fetched ? 600_000 : 60_000); })]);
  clearTimeout(timer);
  if (url === undefined) {
    stop("SIGTERM");
    console.error(`AgentRun did not start on http://${HOST}:${port}.`);
    return (await exited) || 1;
  }
  console.log(`AgentRun is running at ${url}`);
  if (shouldOpen(argv, env)) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  return exited;
}
