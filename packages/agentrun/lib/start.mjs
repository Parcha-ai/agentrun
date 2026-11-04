// `npx @parcha/agentrun`: AgentRun Server on this machine. The server is this package's dependency at its exact version, so
// npx installs the two together and this command always runs the server it was released with. The server's own CLI picks
// the port and whether to open the browser; this command passes its arguments through.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVE_PACKAGE = "@parcha/agentrun-serve";
/** This command's package at its version, handed to the server it starts (AGENTRUN_NPX_PACKAGE), so the server's hints
 *  name this command. */
export const OWN_SPEC = `@parcha/agentrun@${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`;
/** Where the server listens and the console is opened: this machine only. */
export const HOST = "127.0.0.1"; // key-gate: loopback-rule the server this starts listens on this machine only

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

export const USAGE = "Usage: npx @parcha/agentrun [--port N] [--data DIR] [--no-open], or a server command: import, reset-password";

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
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE), 0;
  if (process.platform === "win32") return console.error("AgentRun's server runs on macOS and Linux; on Windows, use WSL or its container."), 1;
  const launcher = installedServer();
  if (launcher === undefined) return console.error(`AgentRun's server (${SERVE_PACKAGE}) is not installed beside this command; run it as npx ${OWN_SPEC}.`), 1;
  const childEnv = { AGENTRUN_LOG: "quiet", ...env, AGENTRUN_NPX_PACKAGE: OWN_SPEC };
  // The data directory is ~/.agentrun unless --data names one, handed to the server and its subcommands (import,
  // reset-password) as --data (the server's own default is another directory). The server's hints name it too, so each
  // opens this same store.
  const at = argv.indexOf("--data");
  const data = ["--data", at >= 0 ? argv[at + 1] : join(homedir(), ".agentrun")];
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  if (rest[0] && !rest[0].startsWith("-")) {
    return new Promise((resolve) => spawn(launcher, [rest[0], ...data, ...rest.slice(1)], { stdio: "inherit", env: childEnv }).on("exit", (code) => resolve(code ?? 1)));
  }
  // The server's banner and request lines stay out of this terminal: one line here says where to go, the URL of the
  // server's own "Open " line. What it prints on stderr (why it did not start) comes through as it is.
  const child = spawn(launcher, serverArgs([...data, ...rest]), { stdio: ["ignore", "pipe", "inherit"], env: childEnv });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  let timer;
  const url = await Promise.race([openUrl(child.stdout), new Promise((resolve) => { timer = setTimeout(resolve, 60_000); })]);
  clearTimeout(timer);
  if (url === undefined) {
    child.kill("SIGTERM");
    console.error("AgentRun did not start; the server's lines above say why.");
    return (await exited) || 1;
  }
  console.log(`AgentRun is running at ${url}`);
  return exited;
}
