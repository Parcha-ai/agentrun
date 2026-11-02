// `npx @parcha/agentrun`: AgentRun Server on this machine. The server is not this package's dependency, so this installs
// alone and a server release does not change it: the server's launcher runs from an install beside this one when there is
// one, else `npm exec` fetches the server's latest release.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
/** The address a person opens first: the console, until a single-use sign-in link replaces it here. */
export const firstUrl = (base) => `${base}/console/`;

export async function freePort(from = DEFAULT_PORT) {
  for (let port = from; port < from + 100; port++) {
    const free = await new Promise((resolve) => { const s = createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true))); s.listen(port, HOST); });
    if (free) return port;
  }
  throw new Error(`no free port on ${HOST} from ${from}`);
}

export const USAGE = "Usage: npx @parcha/agentrun [--port N] [--data DIR] [--no-open], or a server command: import, reset-password";

/** The server's command: an installed server's launcher, else `npm exec` of the latest release, by its own bin name. */
export function server(args, resolve = createRequire(import.meta.url).resolve) {
  try {
    return { command: join(dirname(resolve("@parcha/agentrun-serve/package.json")), "launcher", "agentrun-serve"), args, fetched: false };
  } catch {
    return { command: "npm", args: ["exec", "--yes", SERVE_SPEC, "--", "agentrun-serve", ...args], fetched: true };
  }
}

export async function main(argv, env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE), 0;
  if (process.platform === "win32") return console.error("AgentRun's server runs on macOS and Linux; on Windows, use WSL or its container."), 1;
  const at = argv.indexOf("--data");
  const dir = at >= 0 ? argv[at + 1] : join(homedir(), ".agentrun");
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  const childEnv = { AGENTRUN_LOG: "quiet", ...env, ...modelEnv(env) };
  // A subcommand (import, reset-password) is the server's own, on the same data directory.
  if (rest[0] && !rest[0].startsWith("-")) {
    const { command, args } = server([rest[0], "--data", dir, ...rest.slice(1)]);
    return new Promise((resolve) => spawn(command, args, { stdio: "inherit", env: childEnv }).on("exit", (code) => resolve(code ?? 1)));
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = rest.indexOf("--port");
  const port = p >= 0 && Number(rest[p + 1]) > 0 ? Number(rest[p + 1]) : await freePort();
  const passed = rest.filter((arg, i) => arg !== "--no-open" && !(p >= 0 && (i === p || i === p + 1)));
  const { command, args, fetched } = server(["--data", dir, "--port", String(port), ...passed]);
  if (fetched) console.error(`Starting AgentRun (the first run fetches its server, ${SERVE_SPEC})...`);
  // The server's banner and request lines stay out of this terminal: one line here says where to go.
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"], env: childEnv });
  let ended = false;
  const exited = new Promise((resolve) => child.on("exit", (code) => { ended = true; resolve(code ?? 1); }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  const base = `http://${HOST}:${port}`;
  for (let i = 0; !ended && i < (fetched ? 6000 : 600); i++) {
    if (await fetch(`${base}/v2/health`).then((r) => r.ok && r.json()).then((h) => h?.status === "ok", () => false)) {
      console.log(`AgentRun is running at ${firstUrl(base)}`);
      if (shouldOpen(argv, env)) spawn(process.platform === "darwin" ? "open" : "xdg-open", [firstUrl(base)], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      return exited;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ended) child.kill("SIGTERM");
  console.error(`AgentRun did not start on ${base}.`);
  return (await exited) || 1;
}
