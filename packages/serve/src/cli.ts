#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent store in a data directory.
// First: the secrets the launcher hands over, read and its pipe closed before anything else runs (secrets.ts). It loads
// nothing but node:fs and node:os.
import { secret } from "./secrets.js";
// Then, before anything loads node:sqlite, the filter for its ExperimentalWarning (quiet-sqlite-warning.ts).
import "./quiet-sqlite-warning.js";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultData, removeOwnRecord, SERVER_FILE, writeDurableSync } from "./server-fs.js";
import { startedWith } from "./adapters.js";
import { REPEAT_MS, stopOnSignals } from "./stop-signals.js";
import { canOpen } from "./host.js";
import { resetPassword } from "./owner.js";
import type { ImageState } from "./box-image.js";
import { banner, boxImageLine } from "./print.js";
import type { LearningMode } from "./learning.js";
import { DEFAULT_PORT, type Serve, startServe } from "./server.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { withoutFaux } from "./model.js";

/** A runner beside the server on the same data directory (the CLI start's server-and-runner, and the `runner` subcommand):
 *  its own store handle (role runner), and the runner's dispatch (dispatch.ts) for each claimed run — pi on the kernel's
 *  adapter loop, a learning run on the learning loop. Returns the runner and a close() that stops it and closes its store. */
async function runnerBeside(dataDir: string, loops?: number): Promise<{ runner: Awaited<ReturnType<typeof import("./runner/runner.js")["startRunner"]>>; close: () => Promise<void> }> {
  const { startRunner } = await import("./runner/runner.js");
  const { dispatchRunner } = await import("./runner/harness-loops.js");
  const { routeOf } = await import("./runner/model-route.js");
  const { RunnerRefused } = await import("./runner/main.js");
  const { openSqliteStore, SchemaVersionUnknown } = await import("./store/index.js");
  let store: Awaited<ReturnType<typeof openSqliteStore>>;
  try {
    store = await openSqliteStore({ dataDir, role: "runner" });
  } catch (error) {
    if (error instanceof SchemaVersionUnknown) {
      throw new RunnerRefused(
        error.found === null
          ? `The store in ${dataDir} is not set up yet: start the server on this data directory first, then the runner.`
          : `The store in ${dataDir} is at schema version ${error.found}, and this runner knows ${error.known}: run a runner of the same release as the server.`,
        { cause: error },
      );
    }
    throw error;
  }
  // A server with no seal key never serves a live view, so a stand-in satisfies the spec's live-viewer seam; a server with
  // one seals its live-viewer tokens with it.
  const sealKey = sealKeyOf(process.env[SEAL_KEY_ENV]) ?? Buffer.alloc(32);
  const createLoop = dispatchRunner({ env: withoutFaux(process.env), data: dataDir, journal: (claim) => store.journal(claim), store, sealKey, routeOf });
  const runner = startRunner({ store, createLoop, ...(loops !== undefined ? { loops } : {}) });
  return { runner, close: async () => { await runner.close(); await store.close(); } };
}

const USAGE = `usage: agentrun-serve [--data DIR] [--listen ADDR] [--port N] [--open] [--faux MODULE] [--faux-browser MODULE] [--allow-host NAME ...] [--max-runs N] [--drain-timeout D] [--documents DIR] [--allow-code-nodes] [--learning on|off] [--learning-budget BYTES] [--grade-model MODEL]
       agentrun-serve reset-password [--data DIR]
       agentrun-serve validate-template DIR
       agentrun-serve eval-template DIR [--case NAME ...] [--runs N] [--server URL] [--grader-model PROVIDER/MODEL] [--report FILE] [--faux MODULE]
       agentrun-serve import [--data DIR] [--from claude-code,codex,pi] [--dry-run] [--include-deleted] [--all] [--verbose] [--port N]
       agentrun-serve runner --data DIR [--loops N]

  --data DIR        the agent store and its runs (default ~/.local/share/agentrun/agents); the token is DIR/.token, mode 0600
  --listen ADDR     the address to listen on (default 127.0.0.1); on any other, every Host name is served and the token
                    is the only lock, so put TLS in front of it
  --port N          the port (default: the first free one from ${DEFAULT_PORT}; 0 is any free port)
  --open            open the console in this machine's browser once the server listens (not in CI, nor on Linux with no
                    display)
  --faux MODULE     answer every model request from MODULE's default export: no key, no network
  --faux-browser MODULE
                    with --faux only: the browser tool's provider and driver from MODULE's default export (a fake
                    browser, no vendor, no key), for the console's real-browser tests
  --allow-host NAME another Host name to accept (repeatable)
  --max-runs N      the most runs at once (default AGENTRUN_MAX_RUNS, else as many pi runs as this host's memory
                    holds); each run also reserves its harness's memory, and over either a new run is 429
  --documents DIR   a read-only directory of documents a workflow's pdf_pages calls read by file name (default
                    AGENTRUN_SERVE_DOCUMENTS)
  --allow-code-nodes run workflows' code nodes, in the run's process with no sandbox (default off, or
                    AGENTRUN_SERVE_CODE_NODES=1); off, a workflow with one saves with a warning and its runs are refused
  --drain-timeout D how long a busy run may finish its turn when the server stops (default 30s; the image's is 6s, inside
                    Docker's 10 s grace); a run cut off resumes at the next start
  --learning on|off whether runs learn (default on, or AGENTRUN_SERVE_LEARNING): on, a run of an agent whose definition
                    says learning: true starts from what that agent learned and adds to it; off, no run does
  --learning-budget BYTES how much of what an agent learned its run's instructions hold (default
                    AGENTRUN_SERVE_LEARNING_BUDGET, else 8000): every note whole while they fit, else the index and the
                    notes changed last, whole, while they fit
  --grade-model MODEL the model that grades what a run proposes to learn (default AGENTRUN_SERVE_GRADE_MODEL, else the
                    strong tier, AGENT_MODEL_STRONG, else each run's own model), named as the strong tier takes one

Without --faux, a revision's model ("provider/model-id", or AGENT_MODEL when it names none; a workflow node's tier maps
to AGENT_MODEL_FAST or AGENT_MODEL_STRONG, each falling back to AGENT_MODEL) is served by pi-ai's providers with their
keys from the environment, or, with AGENT_MODEL_BASE_URL, by that one OpenAI Responses gateway (AGENT_MODEL_API_KEY when
it needs a key). AGENTRUN_TOKEN, when set, is the token in place of DIR/.token's (a DIR/.token from an earlier start is removed), and is never printed; DIR/.token's is
printed only by the start that made it. AGENTRUN_PUBLIC_URL, when set, is the address people open (a container's
published port, or a proxy's URL), and the link printed uses it; with none, Render's RENDER_EXTERNAL_URL is. stdout gets one line per request, per run start and
end, and per refused credential; AGENTRUN_LOG=quiet leaves out the request lines.

The page is for one person, who signs in with a password (AGENTRUN_ACCOUNTS=0 turns this off; the token works for
scripts and the CLI either way). With no AGENTRUN_PUBLIC_URL the first visit to the page sets the password; with it, the
setup link this server prints carries a code. Forgot the password: \`agentrun-serve reset-password --data DIR\` where the
data directory is (inside the container) clears it and signs every browser out, and the next visit sets a new one.

\`agentrun-serve import\` reads the Claude Code, Codex and pi sessions in your own home (~/.claude/projects,
~/.codex/sessions, ~/.pi/agent/sessions) into the data directory, once: each project directory an agent, with its
CLAUDE.md or AGENTS.md and its skill folders, and each session a run you can read but not continue. Nothing leaves this
machine; the values of key-shaped environment variables are cut out of what is written. --dry-run lists what it would
import; run again, it imports only what it has not. Sessions written in the last 10 minutes wait for the next import;
What is left out is counted by why; --verbose lists each file. --include-deleted keeps projects whose directory is gone (a
deleted worktree's); --all keeps those and temporary ones too. Each run keeps what its session used (tokens, requests, tools,
time at work), priced at the catalog's list prices when its source did not price it. Both end with a summary of every
session found, those imported before included, and the address to open the console at (--port as the server takes it).

\`agentrun-serve eval-template DIR\` runs a template package's eval cases (all, or each --case) as real runs of its agent
and grades each run with the case's graders (templates/README.md, "Running the evals"). By default on a server of its
own in this process, over a temp data directory removed at the end, so it never touches your server; --server URL runs
them on that server instead, its token in AGENTRUN_API_KEY, and archives the agents it made. --runs N runs each case N
times in place of its own count; --grader-model is the llm graders' model (default: the server's); --faux answers every
model request from MODULE, as the server's --faux does. Progress goes to stderr, a summary to stdout, the whole report
as JSON to --report FILE. Exit 0 when every case passed, 1 when one failed, 2 when the flags, the package or a case are
wrong and nothing ran. Real runs cost money: each case's prompt.md caps each of its runs (max_cost_usd).`;

if (process.argv[2] === "reset-password") {
  let dir: string | undefined;
  try {
    dir = parseArgs({ args: process.argv.slice(3), options: { data: { type: "string" } } }).values.data;
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const target = dir ?? defaultData();
  resetPassword(target);
  console.log(`The password is cleared and every browser is signed out (${target}). The next visit to the page sets a new one.`);
  process.exit(0);
}

// A template package folder checked by the one validator the server runs on the packages it ships (templates.ts): what
// it holds as one JSON line and 0, or each problem and 1. Nothing in the package runs.
if (process.argv[2] === "validate-template") {
  const { PackageError, readPackage } = await import("./templates.js");
  const { positionals } = parseArgs({ args: process.argv.slice(3), options: { data: { type: "string" } }, allowPositionals: true });
  if (positionals.length !== 1) {
    console.error(`agentrun-serve validate-template takes one folder.\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    const { name, version, skills, evals } = readPackage(resolve(positionals[0]!));
    console.log(JSON.stringify({ valid: true, name, version, skills: Object.keys(skills).filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.split("/")[0]), evals }));
    process.exit(0);
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

// A template package's evals run and graded (template-eval.ts): on a server in this process over a temp data directory,
// or with --server on one already running, its token from AGENTRUN_API_KEY (the launcher hands it over its pipe, never
// in the environment or the arguments). Progress on stderr, the summary on stdout, the whole report as JSON to --report.
// 0: every case passed; 1: one failed; 2: the flags, the package or a case is wrong, and nothing ran.
if (process.argv[2] === "eval-template") {
  const { CaseError, evalTemplate, markdownReport } = await import("./template-eval.js");
  const { PackageError } = await import("./templates.js");
  const usage = (message: string): never => (console.error(`agentrun-serve eval-template: ${message}\n\n${USAGE}`), process.exit(2));
  const read = () => {
    try {
      return parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: { case: { type: "string", multiple: true, default: [] }, runs: { type: "string" }, server: { type: "string" }, "grader-model": { type: "string" }, report: { type: "string" }, faux: { type: "string" } } });
    } catch (error) {
      return usage((error as Error).message);
    }
  };
  const { values: given, positionals } = read();
  if (positionals.length !== 1) usage("it takes one package folder.");
  if (given.runs !== undefined && !/^[1-9]\d{0,2}$/.test(given.runs)) usage("--runs takes a whole number from 1 to 999.");
  if (given.server !== undefined && !(URL.canParse(given.server) && /^https?:$/.test(new URL(given.server).protocol))) usage("--server takes the server's http(s) address.");
  if (given.server !== undefined && given.faux !== undefined) usage("--faux is the model of the server it starts itself, and --server names another server.");
  const token = given.server === undefined ? undefined : secret("AGENTRUN_API_KEY") || secret("AGENTRUN_TOKEN");
  if (given.server !== undefined && !token) usage("--server needs that server's token in AGENTRUN_API_KEY.");
  // The first Ctrl-C (or a stop) cancels the run in progress and cleans up what the eval made, as its end does: a run
  // left going would go on spending. A second one leaves at once; one within a second of the first is the same Ctrl-C,
  // reaching this process twice (stop-signals.ts REPEAT_MS).
  const stop = new AbortController();
  let stoppedAt = 0;
  const onStop = () => {
    if (stop.signal.aborted) {
      if (Date.now() - stoppedAt > REPEAT_MS) process.exit(130);
      return;
    }
    stoppedAt = Date.now();
    console.error("agentrun-serve eval-template: stopping: cancelling the run in progress and cleaning up (again to leave now)");
    stop.abort();
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  try {
    const report = await evalTemplate({
      dir: resolve(positionals[0]!), cases: given.case, ...(given.runs !== undefined ? { runs: Number(given.runs) } : {}),
      ...(given.server !== undefined ? { server: { baseUrl: given.server, token: token! } } : {}), ...(given["grader-model"] !== undefined ? { graderModel: given["grader-model"] } : {}),
      ...(given.faux !== undefined ? { serve: { faux: resolve(given.faux) } } : {}), log: (line) => console.error(line), signal: stop.signal,
    });
    // A stop asked as the eval ended still stops it: no report, 130.
    stop.signal.throwIfAborted();
    if (given.report !== undefined) writeFileSync(resolve(given.report), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(markdownReport(report));
    process.exit(report.pass ? 0 : 1);
  } catch (error) {
    if (stop.signal.aborted) {
      console.error("agentrun-serve eval-template: stopped; no report.");
      process.exit(130);
    }
    if (!(error instanceof PackageError || error instanceof CaseError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
}

if (process.argv[2] === "import") {
  const { importCommand } = await import("./import.js");
  process.exit(await importCommand(process.argv.slice(3), USAGE));
}

// A runner process of its own: `agentrun-serve runner --data D [--loops N]`. It opens the store in the data directory as a
// runner (sharing it with the server, setting nothing up) and claims and runs every run until SIGTERM/SIGINT. The loop it
// runs for each run comes from the runner's dispatch (per harness).
if (process.argv[2] === "runner") {
  const { runnerArgs, runUntilSignalled, RunnerRefused } = await import("./runner/main.js");
  let args: { dataDir: string; loops?: number };
  try {
    args = runnerArgs(process.argv.slice(3));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  let runner;
  try {
    runner = await runnerBeside(args.dataDir, args.loops);
  } catch (error) {
    console.error(`agentrun-serve runner: ${error instanceof RunnerRefused ? error.message : (error as Error).message}`);
    process.exit(1);
  }
  console.log(`runner on ${args.dataDir}${args.loops !== undefined ? ` (up to ${args.loops} runs at once)` : ""}`);
  await runUntilSignalled(runner);
  process.exit(0);
}

let values;
try {
  ({ values } = parseArgs({
    // Named, not the default: started by the launcher, this module runs under `node -e`, where the default reads one more.
    args: process.argv.slice(2),
    options: {
      data: { type: "string" },
      listen: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean", default: false },
      faux: { type: "string" },
      "faux-browser": { type: "string" },
      "allow-host": { type: "string", multiple: true, default: [] },
      "max-runs": { type: "string" },
      "drain-timeout": { type: "string" },
      documents: { type: "string" },
      "allow-code-nodes": { type: "boolean", default: false },
      learning: { type: "string" },
      "grade-model": { type: "string" },
      "learning-budget": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port takes a port number\n\n${USAGE}`);
  process.exit(2);
}
let publicUrl: string | undefined;
// Render sets RENDER_EXTERNAL_URL on every web service, so a deploy there is never an open setup.
const publicName = process.env.AGENTRUN_PUBLIC_URL ? "AGENTRUN_PUBLIC_URL" : process.env.RENDER_EXTERNAL_URL ? "RENDER_EXTERNAL_URL" : undefined;
if (publicName) {
  const given = process.env[publicName]!;
  const parsed = URL.canParse(given) ? new URL(given) : undefined;
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    console.error(`${publicName} takes an http(s) URL\n\n${USAGE}`);
    process.exit(2);
  }
  publicUrl = parsed.href.replace(/\/+$/, "");
}
if (values["faux-browser"] && !values.faux) {
  console.error(`--faux-browser goes with --faux\n\n${USAGE}`);
  process.exit(2);
}
const budget = values["learning-budget"];
if (budget !== undefined && !/^\d+$/.test(budget)) {
  console.error(`--learning-budget takes a whole number of bytes\n\n${USAGE}`);
  process.exit(2);
}
const data = values.data ?? defaultData();
const given = secret("AGENTRUN_TOKEN") || undefined;
// A stdout its reader closed (a pipe left behind) loses the log lines, never the server.
process.stdout.on("error", () => undefined);
const accounts = process.env.AGENTRUN_ACCOUNTS !== "0";
// The Docker box image's first build said in words, as it starts and as it ends (print.ts boxImageLine); a line told
// before the banner is printed waits for it.
let imageSaid = false;
let bannered = false;
const early: string[] = [];
const onBoxImage = (state: ImageState) => {
  const line = boxImageLine(state, imageSaid);
  if (line === undefined) return;
  imageSaid = true;
  if (bannered) console.log(line);
  else early.push(line);
};
// How it was started, for the hints that start it again (adapters.ts npxLine): itself and its runs read it.
Object.assign(process.env, startedWith({ ...(values.port !== undefined ? { port: values.port } : {}), open: values.open === true }));
let serve: Serve;
try {
  serve = await startServe({
    onBoxImage,
    data, port, ...(values.port === undefined ? { nextFreePort: true } : {}), ...(values.listen ? { host: values.listen } : {}), ...(given ? { token: given } : {}), ...(values.faux ? { faux: values.faux } : {}), ...(values["faux-browser"] ? { fauxBrowser: values["faux-browser"] } : {}), allowHosts: values["allow-host"],
    ...(values["max-runs"] !== undefined ? { maxRuns: Number(values["max-runs"]) } : {}),
    ...(values["drain-timeout"] ? { drainTimeout: values["drain-timeout"] } : {}), ...(values.documents ? { documents: values.documents } : {}), ...(values["allow-code-nodes"] ? { allowCodeNodes: true } : {}), ...(values.learning !== undefined ? { learning: values.learning as LearningMode } : {}), ...(values["grade-model"] ? { gradeModel: values["grade-model"] } : {}), ...(budget !== undefined ? { learningBudget: Number(budget) } : {}), log: (line) => void process.stdout.write(`${line}\n`),
    // The public address is the server's with accounts on or off: the Host names it serves, the webhook URLs it gives.
    ...(publicUrl ? { publicUrl } : {}),
    ...(accounts ? { accounts, openSetup: !publicUrl, countSessions: true } : {}),
  });
} catch (error) {
  console.error(`agentrun-serve: ${(error as Error).message}`);
  process.exit(1);
}
// The start launches one runner beside the server on the same data dir (design: "server and runner"): it claims and runs
// every run, sharing only the store.
let runnerProc;
try {
  runnerProc = await runnerBeside(data);
} catch (error) {
  console.error(`agentrun-serve: the runner could not start: ${(error as Error).message}`);
  await serve.close();
  process.exit(1);
}
// A token from the environment is the operator's already, and the stored one is printed by the start that made it only.
const source = given ? "env" : serve.tokenMade ? "made" : "file";
for (const line of banner({ url: serve.url, baseUrl: serve.baseUrl, data, token: serve.token, source, accounts, boxes: serve.boxesLine, ...(values.listen ? { listen: values.listen } : {}), ...(publicUrl ? { publicUrl } : {}) })) console.log(line);
// With a public address the setup link and its code are printed as the code is made (owner.ts).
if (serve.setupUrl && !publicUrl) console.log(`Set your password: ${serve.setupUrl} (the first visit sets it)`);
bannered = true;
for (const line of early.splice(0)) console.log(line);
// The console's page, once the server listens: never its sign-in link, whose token would sit in the opener's arguments
// and the browser's history.
if (values.open && canOpen(process.env)) spawn(process.platform === "darwin" ? "open" : "xdg-open", [`${publicUrl ?? serve.url}/`], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
const record = join(resolve(data), SERVER_FILE);
// The record goes only while it is this server's: a server that takes the lock next writes its own, which this stop must
// not remove. One stop per press or process-manager stop; a later signal, or a stop past its deadline, stops at once
// (stop-signals.ts). The stop is in place before the record is written: a SIGTERM sent the moment the record appears is
// a clean stop that removes it, never the default end by signal that leaves it behind.
const stop = stopOnSignals({
  close: () => (removeOwnRecord(record), Promise.all([runnerProc.close(), serve.close()]).then(() => undefined)),
  stopping: () => serve.stopping(),
  done: (code) => (removeOwnRecord(record), process.exit(code)),
  say: (line) => console.error(line),
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Written whole under a name of its own, then renamed into place: a reader in another process (the npx command, a test
// waiting for this server) that finds the record reads all of it, never a file made but not yet filled.
writeDurableSync(record, `${JSON.stringify({ base_url: serve.baseUrl, pid: process.pid, ...(serve.tokenFile ? { token_file: serve.tokenFile } : {}) })}\n`);
chmodSync(record, 0o600);
