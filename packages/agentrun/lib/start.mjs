// `npx @parcha/agentrun`: AgentRun Server on this machine. The server is not this package's dependency, so this installs
// alone and a server release does not change it: the server's launcher runs from an install beside this one when there is
// one, else `npm exec` fetches the server's latest release first, and only then is it started.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVE_PACKAGE = "@parcha/agentrun-serve";
export const SERVE_SPEC = `${SERVE_PACKAGE}@latest`;
/** This command's package at its version, handed to the server it starts (AGENTRUN_NPX_PACKAGE), so the server's hints
 *  name this command. */
export const OWN_SPEC = `@parcha/agentrun@${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`;
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
 *  one (openLineUrl). That line is the server's interface for it (the plain address today, a single-use sign-in link
 *  once the server prints one), so this command never builds the address itself. Resolves undefined when the output ends
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

/** The installed server's launcher beside this package, or undefined. */
export function installedServer(resolve = createRequire(import.meta.url).resolve) {
  try {
    return join(dirname(resolve(`${SERVE_PACKAGE}/package.json`)), "launcher", "agentrun-serve");
  } catch {
    return undefined;
  }
}

/** What `npm exec` said when it could not fetch the server, in a person's words: from npm's own error code. */
export function fetchProblem(stderr, code) {
  const npmCode = /^npm (?:error|ERR!) code (\S+)/m.exec(stderr)?.[1];
  if (npmCode === "E404") return "not on npm";
  if (npmCode && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT)$/.test(npmCode)) return `npm could not reach its registry, ${npmCode}`;
  if (npmCode) return `npm said ${npmCode}`;
  return code === undefined ? "npm did not run" : `npm exec exited ${code}`;
}

export const fetchFailed = (why) => `Couldn't download the AgentRun server (${SERVE_PACKAGE}: ${why}). Your network or the release is the problem; nothing was started.`;

/** The server's launcher, fetched when none is installed beside this package: `npm exec` installs the latest release
 *  into npm's cache and prints where its bin is, before anything is started, so a download that fails is said as one.
 *  npm's own output is kept back unless the fetch fails. */
export async function fetchServer(env) {
  console.error(`Starting AgentRun (the first run fetches its server, ${SERVE_SPEC})...`);
  const child = spawn("npm", ["exec", "--yes", `--package=${SERVE_SPEC}`, "-c", "command -v agentrun-serve"], { stdio: ["ignore", "pipe", "pipe"], env: fetchEnv(env) });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.on("error", () => resolve(undefined)).on("close", (exit) => resolve(exit ?? 1)));
  const launcher = out.trim().split("\n").at(-1);
  if (code === 0 && launcher) return { launcher };
  if (err) process.stderr.write(err.endsWith("\n") ? err : `${err}\n`);
  return { problem: fetchProblem(err, code) };
}

export async function main(argv, env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE), 0;
  if (process.platform === "win32") return console.error("AgentRun's server runs on macOS and Linux; on Windows, use WSL or its container."), 1;
  // The data directory is ~/.agentrun unless --data names one, handed to the server and its subcommands as --data (the
  // server's own default is another directory). The server's hints name it too, so each opens this same store.
  const at = argv.indexOf("--data");
  const data = ["--data", at >= 0 ? argv[at + 1] : join(homedir(), ".agentrun")];
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  const childEnv = { AGENTRUN_LOG: "quiet", ...env, ...modelEnv(env), AGENTRUN_NPX_PACKAGE: OWN_SPEC };
  // Started by npx, this runs under npm exec and its `sh -c`. A signal to npm alone (a process manager's SIGTERM or
  // SIGKILL) ends npm and leaves this, and the server, with nobody to stop them: this finds that npm now, before any fetch,
  // starts no server once it is gone, and stops the server when it goes later. Started any other way, it watches nothing,
  // so a shell's own rules apply (`&`, nohup).
  const npm = npmExecOf(env);
  const npmGone = () => npm !== undefined && !isNpm(commandOf(npm));
  let launcher = installedServer();
  if (launcher === undefined) {
    const fetched = await fetchServer(childEnv);
    if (fetched.problem !== undefined) return console.error(fetchFailed(fetched.problem)), 1;
    launcher = fetched.launcher;
  }
  // A subcommand (import, reset-password) is the server's own, on the same data directory.
  if (rest[0] && !rest[0].startsWith("-")) {
    return new Promise((resolve) => spawn(launcher, [rest[0], ...data, ...rest.slice(1)], { stdio: "inherit", env: childEnv }).on("exit", (code) => resolve(code ?? 1)));
  }
  const p = rest.indexOf("--port");
  const port = p >= 0 && Number(rest[p + 1]) > 0 ? Number(rest[p + 1]) : await freePort();
  const passed = rest.filter((arg, i) => arg !== "--no-open" && !(p >= 0 && (i === p || i === p + 1)));
  if (npmGone()) return console.error("AgentRun: the npm that started this command is gone, so the server was not started."), 1;
  // The server's banner and request lines stay out of this terminal: one line here says where to go, the URL of the
  // server's own "Open " line.
  const child = spawn(launcher, [...data, "--port", String(port), ...passed], { stdio: ["ignore", "pipe", "inherit"], env: childEnv });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  // A SIGHUP to this command alone (not the terminal's, which reaches the server too) asks the server to stop as a SIGTERM
  // does.
  process.on("SIGHUP", () => child.kill("SIGTERM"));
  // When that npm goes, the server stops, as on a SIGTERM, and this ends.
  if (npm !== undefined) {
    const watch = setInterval(() => {
      if (!npmGone()) return;
      clearInterval(watch);
      child.kill("SIGTERM");
    }, 1000);
    watch.unref();
    child.on("exit", () => clearInterval(watch));
  }
  let timer;
  const url = await Promise.race([openUrl(child.stdout), new Promise((resolve) => { timer = setTimeout(resolve, 60_000); })]);
  clearTimeout(timer);
  if (url === undefined) {
    child.kill("SIGTERM");
    console.error(`AgentRun did not start on http://${HOST}:${port}.`);
    return (await exited) || 1;
  }
  console.log(`AgentRun is running at ${url}`);
  if (shouldOpen(argv, env)) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  return exited;
}
