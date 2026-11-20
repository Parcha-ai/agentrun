// `npx @parcha/agentrun`: AgentRun Server on this machine. The server is this package's dependency at its exact version, so
// npx installs the two together and this command always runs the server it was released with. The server's own CLI picks
// the port and whether to open the browser; this command passes its arguments through.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { main as cli, NOUNS, words } from "./cli.mjs";
import { chosenPublicUrl } from "./public-url.mjs";
import { tailnetHint, tailnetNameOf } from "./tailscale.mjs";

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

/** The line an API-only server (AGENTRUN_API_ONLY=1) prints in place of its "Open " line: it has no console to open, so
 *  the address this command names is the server's API, from the AGENTRUN_BASE_URL line before it. */
export const API_ONLY_LINE = /^API only \(AGENTRUN_API_ONLY=1\)/;

/** How many of the server's last lines, on stdout and on stderr each, a start that fails shows. */
export const TAIL_LINES = 20;

/** How long a start waits for the server's "Starting " line (its port bound) or its "Open " line, whichever comes first,
 *  before it stops the server and says so. AGENTRUN_START_TIMEOUT_MS (milliseconds) sets another bound; the launcher's
 *  tests use it. After a "Starting " line it waits for "Open " with no bound: the server is up, still loading. */
export const START_TIMEOUT_MS = 60_000;
/** How long a server that did not start has to end after its SIGTERM before it is sent a SIGKILL. */
export const STOP_GRACE_MS = 10_000;
/** The start log, in the data folder: everything the server wrote on stdout and stderr in the last start, until it
 *  printed the address to open, then the failure if it did not. Each start overwrites it. */
export const START_LOG = "start.log";

const seconds = (ms) => `${Number((ms / 1000).toFixed(1))} s`;
/** `promise`'s value, or undefined once `ms` pass; the timer goes with it, so it never holds this process up. */
const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

/** What a start, or a server command, that failed says on stderr: one line saying what happened, then the step that
 *  failed, how the server's process ended (its exit code or signal; still running past the bound and stopped; or never
 *  started), its last lines on stderr and on stdout, and the start log that holds all of its output, or why there is none
 *  (`logError`), or why it holds only the start of it (`logIncomplete`, the write that failed: a full disk, a quota).
 *  `command` names a server command (import, ...), whose output went to the terminal as it ran: no lines, no log. `sent`
 *  is the signals this command sent the server, in order; `stopped` is why it sent them unasked: "timeout" (still running
 *  `waitedMs` after it started) or "closed" (its output closed while it ran). */
export function failureText({ command, step, error, code = null, signal = null, stopped, waitedMs, sent = [], stderrTail, stdoutTail, logPath, logError, logIncomplete }) {
  const lead = command === undefined ? "AgentRun did not start" : `The server's ${command} command failed`;
  const subject = command === undefined ? "the server" : "it";
  const before = command === undefined ? " before it printed the address to open" : "";
  const ended = signal !== null ? `signal ${signal}` : code !== null ? `code ${code}` : "not ended yet";
  let why;
  let exit;
  if (error !== undefined) {
    why = `${subject} could not be started (${error.message})`;
    exit = "it never ran";
  } else if (stopped !== undefined) {
    const was = stopped === "closed" ? "its output closed while it ran" : `still running after ${seconds(waitedMs)}`;
    why = stopped === "closed" ? `${subject} closed its output without printing the address to open, so it was stopped` : `${subject} was still running after ${seconds(waitedMs)} without printing the address to open, so it was stopped. AGENTRUN_START_TIMEOUT_MS sets a longer wait, in milliseconds`;
    exit = `${was}; stopped with ${sent.length > 1 ? `${sent[0]}, then ${sent.slice(1).join(", then ")} ${seconds(STOP_GRACE_MS)} later` : sent[0]}; then ${ended}`;
  } else if (signal !== null) {
    why = `${subject} was ended by ${signal}${before}`;
    exit = `signal ${signal}${sent.includes(signal) ? " (sent by this command)" : signal === "SIGKILL" ? " (not sent by this command: the system may have run out of memory)" : ""}`;
  } else {
    why = `${subject} exited with code ${code}${before}`;
    exit = `code ${code}`;
  }
  const lines = (name, tail) => {
    if (tail === undefined) return [];
    if (tail.length === 0) return [`  ${name}: nothing`];
    return [`  ${name}, last ${tail.length === 1 ? "line" : `${tail.length} lines`}:`, ...tail.map((line) => `    ${line}`)];
  };
  const log = logPath !== undefined ? [`  log: ${logPath}${logIncomplete !== undefined ? ` (incomplete: ${logIncomplete.message})` : ""}`] : logError !== undefined ? [`  log: none (${logError.message})`] : [];
  return [`${lead}: ${why}.`, `  step: ${step}`, `  exit: ${exit}`, ...lines("stderr", stderrTail), ...lines("stdout", stdoutTail), ...log].join("\n");
}

/** The bound on a start's wait for the "Open " line: AGENTRUN_START_TIMEOUT_MS when it is a whole number of
 *  milliseconds above 0, else START_TIMEOUT_MS. */
export const startTimeoutMs = (env) => (/^[1-9]\d*$/.test(env.AGENTRUN_START_TIMEOUT_MS ?? "") ? Number(env.AGENTRUN_START_TIMEOUT_MS) : START_TIMEOUT_MS);

/** The start log, opened afresh in `dataDir` (made first, private, as the server makes it): private, as the server's banner
 *  names its API token, and never through a link. `{ fd }`, or `{ error }` when it can't be kept: a start goes on
 *  without it, and a start that fails says why there is none. */
function openStartLog(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(dataDir, START_LOG), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    return { fd };
  } catch (error) {
    return { error };
  }
}

/** Passes `source` (the server's stderr) on to `dest` (this command's) as it comes, at the pace `dest` is read: a slow
 *  reader slows the server, as an inherited stderr did, and nothing piles up here. Each chunk goes to `onChunk` too (the
 *  tail and the start log). A `dest` that fails (EPIPE: its reader went, a `| head`, a log reader restarting) never ends
 *  this command: the passing on stops, and `source` is still read, to `onChunk` and then dropped, so the server never
 *  blocks on a full pipe and is still stopped by this command's signals. */
export function forward(source, dest, onChunk) {
  source.on("data", onChunk);
  source.pipe(dest, { end: false });
  dest.on("error", () => {
    source.unpipe(dest);
    source.resume();
  });
}

/** Keeps the last TAIL_LINES whole lines of a stream's chunks (bytes, a character split between two chunks kept whole) in
 *  `tail`; `end()` keeps an unfinished last line too. */
function tailOf(tail) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const keep = (line) => {
    tail.push(line.replace(/\r$/, ""));
    if (tail.length > TAIL_LINES) tail.shift();
  };
  return {
    add(chunk) {
      pending += decoder.write(chunk);
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        keep(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    },
    end() {
      pending += decoder.end();
      if (pending !== "") keep(pending);
      pending = "";
    },
  };
}

/** The server's lines this command says too, as they come: its banner's boxes line (whether new agents get the Docker
 *  box, or why not), and, on a server with a public address and no password yet, the setup link with its code, which
 *  setup at that address asks for, with the same link at this machine's addresses for a server on every address. */
export const SAID = /^(Boxes: |Set up this server: |From another machine: )/;

/** The address a person opens first, as the server says it: the URL of the first "Open " line of its output that names
 *  one (openLineUrl). That line is the server's interface for it (the plain address today, a single-use sign-in link
 *  once the server prints one), so this command never builds the address itself. An API-only server prints no such line:
 *  its API-only line (API_ONLY_LINE) stands for it, and the address is its AGENTRUN_BASE_URL line's, held to the same
 *  hosts as an "Open " line's. Resolves undefined when the output ends
 *  without one. Until then, the last TAIL_LINES lines before it are kept in `seen`: what a start that fails shows, and each
 *  goes to `onBefore`. Every whole line after it goes to `onLine`; the rest of the output is read and dropped, so the
 *  server never blocks on a full pipe. A "Starting " line before it, whose URL is one an "Open " line may name, goes to
 *  `onStarting` with that URL, once: the server has bound its port and is still loading. */
export function openUrl(stdout, publicUrl, seen = [], onLine = () => {}, onBefore = () => {}, onStarting = () => {}) {
  let starting;
  const keep = (line) => {
    onBefore(line);
    seen.push(line);
    if (seen.length > TAIL_LINES) seen.shift();
  };
  return new Promise((resolve) => {
    let pending = "";
    let found;
    // The API's address, from the banner's AGENTRUN_BASE_URL line: what an API-only server's line stands for.
    let base;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (found !== undefined) onLine(line);
        else if ((found = openLineUrl(line, publicUrl)) !== undefined) resolve(found);
        else if (base !== undefined && API_ONLY_LINE.test(line)) resolve((found = base));
        else {
          const named = /^AGENTRUN_BASE_URL=(\S+)$/.exec(line)?.[1];
          if (named !== undefined && openLineUrl(`Open ${named}`, publicUrl) !== undefined) base = named;
          const bound = starting === undefined && line.startsWith("Starting ") ? openLineUrl(`Open ${line.slice("Starting ".length)}`, publicUrl) : undefined;
          if (bound !== undefined) onStarting((starting = bound));
          keep(line);
        }
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

export const USAGE = `Usage: npx @parcha/agentrun [--port N] [--data DIR] [--no-open] [--public-url URL]   start the server
       (--public-url: the https address people open it at, through a proxy such as tailscale serve)
       npx @parcha/agentrun import|reset-password|runner|native [--data DIR]   a server command (native: discover/connect an existing project)
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

/** Whether the server listens on this machine only: no --listen (127.0.0.1), or a loopback one. Its last --listen counts,
 *  as the server reads them. */
export function onLoopback(args) {
  let listen;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--listen") listen = args[++i];
    else if (args[i].startsWith("--listen=")) listen = args[i].slice("--listen=".length);
  }
  return listen === undefined || /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i.test(listen);
}

/** Whether this runs in CI, where nobody reads a hint. */
const inCi = (env) => Boolean(env.CI) && env.CI !== "false" && env.CI !== "0";

/** The server's own commands (its CLI's first word), which this command runs on its store: every other first word is
 *  the CLI's, which names a command it has or says it has none. */
export const SERVER_COMMANDS = ["check-harness", "eval-template", "import", "install-harness", "native", "remote-bridge", "reset-password", "runner", "validate-template"];

/** How many of the server's refusals and ignored deliveries a start says, each route and reason once, before one line
 *  that says the rest are not: under this command the server's log goes nowhere else (its stdout is read here and dropped). */
export const TOLD_MAX = 20;

/** Why a request was refused, in words, by the server's reason; any other reason is said as the server names it. */
const REFUSED = new Map([
  ["wrong_token", "the API token is not this server's"],
  ["no_credential", "it carried no API token"],
  ["wrong_password", "the password is wrong"],
  ["sign_in_table_full", "a sign-in from more addresses than the limit counts one by one"],
]);

/** The fields of one of the server's log lines (print.ts: `key=value` or `key="value"`); a repeated key keeps its first
 *  value, the line's own event. */
function fieldsOf(line) {
  const fields = {};
  for (const [, key, quoted, plain] of line.matchAll(/(?:^| )([\w-]+)=(?:"([^"]*)"|(\S+))/g)) if (!(key in fields)) fields[key] = quoted ?? plain;
  return fields;
}

/** A teller for one start: given a line of the server's output, what to say of it to the person, or undefined. A refused
 *  request (auth_failed) and a verified webhook delivery its trigger does not take (hook_ignored) are said in words, with
 *  their route and reason and never what was sent, each route and reason once, at most TOLD_MAX. With AGENTRUN_LOG=quiet,
 *  as this command starts the server, those lines are all an operator would otherwise miss. */
export function tellerOf() {
  const said = new Set();
  let full = false;
  return (line) => {
    const fields = fieldsOf(line);
    let words;
    let key;
    if (fields.event === "auth_failed" && fields.route) {
      key = `auth ${fields.route} ${fields.reason}`;
      words = `AgentRun refused a request to ${fields.route}: ${REFUSED.get(fields.reason) ?? fields.reason}.`;
    } else if (fields.event === "trigger" && fields.condition === "hook_ignored" && fields.route) {
      const hookEvent = [...line.matchAll(/ event=(\S+)/g)][1]?.[1];
      key = `hook ${fields.route} ${fields.reason}`;
      words = `AgentRun ignored a webhook delivery to ${fields.route} (${fields.source}${hookEvent ? `, event ${hookEvent}` : ""}): ${fields.reason}.`;
    } else return undefined;
    if (said.has(key) || full) return undefined;
    if (said.size >= TOLD_MAX) return (full = true), "AgentRun refuses more requests than this terminal shows; it says no more of them here.";
    said.add(key);
    return said.size === 1 ? `${words} (Each route and reason is said once.)` : words;
  };
}

export async function main(argv, env = process.env) {
  // The first argument, past --data and its value: a word there names a command (the server's own, or else the CLI's),
  // and a flag starts the server, whose flags with values (--listen ADDR) follow.
  const first = argv.find((arg, i) => arg !== "--data" && !arg.startsWith("--data=") && argv[i - 1] !== "--data");
  if (NOUNS.has(words(argv)[0]) || (first !== undefined && !first.startsWith("-") && !SERVER_COMMANDS.includes(first))) return cli(argv, env);
  // --help is this command's usage when it starts the server; a server command's --help is that command's, which the
  // server prints (import --help names --from and --dry-run). remote-bridge, the connector's own process, has no usage of
  // its own to print and never reads --help, so it keeps this one.
  if (!(SERVER_COMMANDS.includes(first) && first !== "remote-bridge") && (argv.includes("--help") || argv.includes("-h"))) return console.log(USAGE), 0;
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
  // --public-url is this command's own: the server takes the address as AGENTRUN_PUBLIC_URL, never as a flag.
  let dir;
  let publicFlag;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data" && i + 1 < argv.length) dir = argv[++i];
    else if (argv[i].startsWith("--data=")) dir = argv[i].slice("--data=".length);
    else if (argv[i] === "--public-url") publicFlag = argv[++i] ?? "";
    else if (argv[i].startsWith("--public-url=")) publicFlag = argv[i].slice("--public-url=".length);
    else rest.push(argv[i]);
  }
  const chosen = chosenPublicUrl(publicFlag, env.AGENTRUN_PUBLIC_URL);
  if (chosen.error !== undefined) return console.error(chosen.error), 2;
  const publicUrl = chosen.url;
  if (publicUrl !== undefined) childEnv.AGENTRUN_PUBLIC_URL = publicUrl;
  // --public-url on loopback means a proxy on this machine sends every request (tailscale serve, a reverse proxy), as
  // --tailscale's does: the server counts sign-ins by the address its X-Forwarded-For names, not one for everyone. An
  // operator's own AGENTRUN_TRUSTED_PROXIES stays, an empty one (trust no proxy) too; a server on another address trusts no
  // one it was not told to.
  if (publicFlag !== undefined && onLoopback(rest) && env.AGENTRUN_TRUSTED_PROXIES === undefined) childEnv.AGENTRUN_TRUSTED_PROXIES = "loopback";
  const dataDir = dir ?? join(homedir(), ".agentrun");
  // A name that starts with a dash keeps the equals form: the server's parser reads "--data -x" as a missing value.
  const data = dataDir.startsWith("-") ? [`--data=${dataDir}`] : ["--data", dataDir];
  if (rest[0] && !rest[0].startsWith("-")) {
    // A server command (an eval among them, which spends while it runs): a stop sent to this command alone (a job
    // runner's SIGTERM, a SIGHUP) is passed on, and this waits for the command to clean up and end. A hangup is passed
    // on as a SIGTERM, which every server command stops on. Its output comes to this terminal as it is; a command that
    // could not be started, or that a signal this command did not pass on ended, is said here (failureText).
    const child = spawn(launcher, [rest[0], ...data, ...rest.slice(1)], { stdio: "inherit", env: childEnv });
    const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    const sent = [];
    const pass = Object.fromEntries(Object.keys(codes).map((signal) => [signal, () => {
      const passed = signal === "SIGHUP" ? "SIGTERM" : signal;
      sent.push(passed);
      child.kill(passed);
    }]));
    for (const [signal, on] of Object.entries(pass)) process.on(signal, on);
    const step = `run the server's ${rest[0]} command (${launcher})`;
    return new Promise((resolve) => {
      let over = false;
      const done = (code) => {
        if (over) return;
        over = true;
        for (const [signal, on] of Object.entries(pass)) process.off(signal, on);
        resolve(code);
      };
      child.on("error", (error) => {
        if (child.pid === undefined && !over) console.error(failureText({ command: rest[0], step, error }));
        done(1);
      });
      child.on("exit", (code, signal) => {
        if (signal !== null && !sent.includes(signal)) console.error(failureText({ command: rest[0], step, code, signal, sent }));
        done(code ?? codes[signal] ?? 1);
      });
    });
  }
  // The server's banner and request lines stay out of this terminal: one line here says where to go, the URL of the
  // server's own "Open " line; the lines SAID names go to stderr after it, for the person, so stdout stays that one line.
  // What it prints on stderr comes through as it is, as it prints it, at the pace this command's stderr is read (forward).
  // Until the server prints the address, all it writes on either goes to the start log too, and the last lines of each are
  // kept: a start that fails says them, with the step, how the server ended and the log (failureText).
  const log = openStartLog(dataDir);
  const logPath = log.fd === undefined ? undefined : join(dataDir, START_LOG);
  // The first write to the log that failed (a full disk, a quota): the start goes on, the log keeps what it holds, and a
  // start that fails says it is incomplete, and why.
  let logIncomplete;
  const toLog = (chunk) => {
    if (log.fd === undefined || logIncomplete !== undefined) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    try {
      for (let at = 0; at < bytes.length; ) {
        const wrote = writeSync(log.fd, bytes, at, bytes.length - at);
        if (wrote <= 0) throw new Error(`wrote ${at} of ${bytes.length} bytes`);
        at += wrote;
      }
    } catch (error) {
      logIncomplete = error;
    }
  };
  const closeLog = () => {
    if (log.fd !== undefined) try { closeSync(log.fd); } catch {}
    log.fd = undefined;
  };
  // On loopback with no public address, a person may want it on their other devices: where Tailscale runs here, the
  // start says how (tailnetHint), once it is up. Reading Tailscale's status is all it does there, bounded, in parallel
  // with the start; any error says nothing.
  const tailnetName = publicUrl === undefined && !env.RENDER_EXTERNAL_URL && onLoopback(rest) && !inCi(env) ? tailnetNameOf({ env }) : Promise.resolve(undefined);
  const child = spawn(launcher, serverArgs([...data, ...rest]), { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let started = false;
  const errTail = [];
  const errLines = tailOf(errTail);
  forward(child.stderr, process.stderr, (chunk) => {
    if (started) return;
    toLog(chunk);
    errLines.add(chunk);
  });
  child.stdout.on("data", (chunk) => { if (!started) toLog(chunk); });
  // A child that could not be started (the launcher missing, or not executable) says so here, and never exits.
  let spawnError;
  const failedToSpawn = new Promise((resolve) => child.on("error", (error) => {
    if (child.pid === undefined) spawnError ??= error;
    resolve();
  }));
  // A stop this command passes on (Ctrl-C, a process manager's SIGTERM, npm gone) is a clean end, 0, even when the signal
  // itself ends the server; a server ended by a signal nobody here sent is not.
  let stopping = false;
  const sent = [];
  const stop = (signal) => {
    stopping = true;
    sent.push(signal);
    child.kill(signal);
  };
  let ended;
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve((ended = { code, signal }))));
  const exited = exit.then(({ code }) => code ?? (stopping ? 0 : 1));
  const closed = new Promise((resolve) => child.on("close", resolve));
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
  const teller = tellerOf();
  const tell = (line) => {
    const said = SAID.test(line) ? line : teller(line);
    if (said !== undefined) told ? console.error(said) : held.push(said);
  };
  // A SAID line can come before the "Open " line too (the setup link is printed as the server attaches its owner, before
  // its banner): it is held and said first, in order.
  const seen = [];
  const bound = startTimeoutMs(env);
  const TIMED_OUT = Symbol("timed out");
  // A server that says Starting has bound its port and answers there, warming, while it loads: the bound is for a server
  // that never gets that far, so it ends here, and the person is told the address at once (stderr; stdout waits for the
  // "Open " line, which says it is ready).
  let listening;
  const onStarting = (address) => {
    listening = address;
    clearTimeout(timer);
    console.error(`AgentRun is starting at ${address}: it listens there now, and opens once its store is ready.`);
  };
  const url = await Promise.race([openUrl(child.stdout, publicUrl, seen, tell, tell, onStarting), new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), bound); })]);
  clearTimeout(timer);
  if (url === undefined || url === TIMED_OUT) {
    // Its stdout ended (it exited, was never started, or closed it), or the bound passed with it still running. A server
    // still running is stopped: a SIGTERM, then a SIGKILL if it has not ended within STOP_GRACE_MS.
    if (url === undefined) await within(Promise.race([exit, failedToSpawn]), 2_000);
    let stopped;
    if (spawnError === undefined && ended === undefined) {
      stopped = url === TIMED_OUT ? "timeout" : "closed";
      stop("SIGTERM");
      if ((await within(exit, STOP_GRACE_MS)) === undefined) {
        stop("SIGKILL");
        await within(exit, 5_000);
      }
    }
    // Its stderr, to the end: what it wrote last comes before the failure, and is in its tail.
    if (spawnError === undefined) await within(closed, 2_000);
    errLines.end();
    const failure = failureText({
      step: spawnError !== undefined ? `start the server (${launcher})` : listening !== undefined ? `wait for the server, listening at ${listening}, to be ready` : `wait for the server to print the address to open (at most ${seconds(bound)})`,
      error: spawnError,
      code: ended?.code ?? null,
      signal: ended?.signal ?? null,
      stopped,
      waitedMs: bound,
      sent,
      stderrTail: errTail,
      stdoutTail: seen,
      logPath,
      logError: log.error,
      logIncomplete,
    });
    toLog(`${failure}\n`);
    closeLog();
    console.error(failure);
    return ended?.code || 1;
  }
  started = true;
  closeLog();
  console.log(`AgentRun is running at ${url}`);
  // For the person at the terminal (stderr, so stdout stays the one line a script reads): how to stop it, and where its
  // data is kept, which the next start opens again.
  console.error(`Press Ctrl-C to stop it. Its data is in ${dataDir}.`);
  // And where the API's bearer token is: the server prints it on a line this terminal doesn't show.
  console.error(env.AGENTRUN_TOKEN ? "The API token is the AGENTRUN_TOKEN this command was started with." : `The API token is in ${join(dataDir, ".token")}.`);
  told = true;
  for (const line of held.splice(0)) console.error(line);
  const name = await tailnetName;
  const port = new URL(url).port;
  if (name !== undefined && port !== "" && new URL(url).hostname === HOST) console.error(tailnetHint(name, port));
  return exited;
}
