#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent store in a data directory.
// First: the secrets the launcher hands over, read and its pipe closed before anything else runs (secrets.ts). It loads
// nothing but node:fs and node:os.
import { secret } from "./secrets.js";
// Then, before anything loads node:sqlite, the filter for its ExperimentalWarning (quiet-sqlite-warning.ts).
import "./quiet-sqlite-warning.js";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants as fsConstants, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultData, removeOwnRecord, SERVER_FILE, writeDurableSync } from "./server-fs.js";
import { REPEAT_MS, stopOnce, stopOnSignals } from "./stop-signals.js";
import { resetPassword } from "./owner.js";
import { banner } from "./print.js";
import { type ApiToken, parseTokens } from "./api-token.js";
import type { LearningMode } from "./learning.js";
import type { Serve, ServeOptions } from "./server.js";
import { apiOnlyFrom } from "./api-only.js";
import { harnessModulesOf } from "./harness-table.js";
import { surviveClosedPipes } from "./closed-pipes.js";
import { installEnvProxy } from "./env-proxy.js";
import { startTelemetry } from "./telemetry.js";
// The rest of the server (server.js, the runner, the harness adapters) loads after the port is bound (listen-first.ts):
// on a slow disk that load is most of a start. Nothing above loads more than a few files.
import { DEFAULT_HOST, DEFAULT_PORT, listenFirst, urlOf } from "./listen-first.js";

// A stdout or stderr its reader closed loses the lines written after, never the process (closed-pipes.ts): for every
// command, the server and the runner alike.
surviveClosedPipes();
// Every outbound call through the proxy HTTPS_PROXY or HTTP_PROXY names, NO_PROXY's hosts and loopback direct
// (env-proxy.ts): for every command, before anything calls out. Neither set, nothing changes.
installEnvProxy();

const USAGE = `usage: agentrun-serve [--data DIR] [--listen ADDR] [--port N] [--open] [--faux MODULE] [--faux-browser MODULE] [--faux-github] [--allow-host NAME ...] [--max-runs N] [--drain-timeout D] [--documents DIR] [--allow-code-nodes] [--learning on|off] [--no-runner] [--harness-module MODULE ...]
       agentrun-serve reset-password [--data DIR]
       agentrun-serve validate-template DIR
       agentrun-serve install-harness goose [--data DIR]
       agentrun-serve install-harness --recipe FILE [--data DIR]
       agentrun-serve check-harness --recipe FILE [--model PROVIDER/MODEL] [--data DIR] [--report FILE] [--cap USD]
       agentrun-serve eval-template DIR [--case NAME ...] [--runs N] [--server URL | --on-data DIR] [--grader-model PROVIDER/MODEL] [--report FILE] [--faux MODULE]
       agentrun-serve import [--data DIR] [--from claude-code,codex,pi] [--dry-run] [--include-deleted] [--all] [--verbose] [--port N]
       agentrun-serve runner --data DIR [--loops N] [--drain-timeout D] [--name NAME]
       agentrun-serve runner --check --data DIR [--name NAME]
       agentrun-serve native discover|connect --project PATH [--runtime claude-code|codex] [--agent NAME|--profile NAME] [--url URL] [--data DIR]

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
  --faux-github     with --faux only: a fake GitHub App, connected at the start and answered in this process, so
                    GitHub triggers run with nothing sent to GitHub; its webhook secret is in DIR/faux-github.json.
                    On a scratch data directory: refused where another GitHub App is connected
  --allow-host NAME another Host name to accept (repeatable)
  --max-runs N      the most runs the runner beside the server holds at once, the rest waiting queued (default
                    AGENTRUN_MAX_RUNS, else as many pi runs as this host's memory holds); the capabilities'
                    max_concurrent_runs says the same
  --documents DIR   a read-only directory of documents a workflow's pdf_pages calls read by file name (default
                    AGENTRUN_SERVE_DOCUMENTS)
  --allow-code-nodes run workflows' code nodes, in the run's process with no sandbox (default off, or
                    AGENTRUN_SERVE_CODE_NODES=1); off, a workflow with one saves with a warning and its runs are refused
  --drain-timeout D how long the runner beside the server lets each busy run finish its turn when the server stops
                    (default 30s; the image's is 6s, inside Docker's 10 s grace); a run still busy then is stopped and
                    resumes at the next start
  --learning on|off whether runs learn (default on, or AGENTRUN_SERVE_LEARNING): on, a run of an agent whose definition
                    says learning: true starts from what that agent learned and adds to it; off, no run does
  --harness-module MODULE
                    a harness module to add harnesses from (repeatable; default AGENTRUN_SERVE_HARNESS_MODULES, comma-
                    separated): a path, or a package installed with npm install --prefix DIR/harnesses PACKAGE, whose
                    entries(builtins) export adds harnesses of its own to this server and its runner. It never replaces
                    a built-in harness (pi, claude-agent, codex, opencode); one that does, or is missing, refuses the start
  --no-runner       run the server alone, with no runner beside it (default: one runner beside the server); start one or
                    more \`agentrun-serve runner --data DIR\` processes on the same data directory to claim and run runs;
                    each holds at most --loops N runs (default AGENTRUN_MAX_RUNS, else as many pi runs as its host's
                    memory holds; the rest wait queued) and on SIGTERM lets each busy run finish its turn for up to
                    --drain-timeout D (default AGENTRUN_DRAIN_TIMEOUT, else 6s), then hands the rest back to resume.
                    A paired computer (Settings → Computers → Pair a computer) dials the server's process, so only the
                    runner beside it can use one: separate runners refuse a run whose agent names one

Without --faux, a revision's model ("provider/model-id", or AGENT_MODEL when it names none; a workflow node's tier maps
to AGENT_MODEL_FAST or AGENT_MODEL_STRONG, each falling back to AGENT_MODEL) is served by pi-ai's providers with their
keys from the environment, or, with AGENT_MODEL_BASE_URL, by that one OpenAI Responses gateway (AGENT_MODEL_API_KEY when
it needs a key). AGENTRUN_TOKEN, when set, is the token in place of DIR/.token's (a DIR/.token from an earlier start is removed), and is never printed; DIR/.token's is
printed only by the start that made it. AGENTRUN_TOKENS, when set, holds more tokens as id:secret entries separated by
commas or whitespace (each secret 32 characters or more): every one opens what the token opens, AGENTRUN_TOKEN's id is
"default", and the request lines name the id of the token used, never a secret. Set alone, it takes DIR/.token's place.
AGENTRUN_PUBLIC_URL, when set, is the address people open (a container's
published port, or a proxy's URL), and the link printed uses it; with none, Render's RENDER_EXTERNAL_URL is.
AGENTRUN_FREE_MODEL_REQUESTS (default 60) is the most requests on free models ($0 in the catalog) a run makes, capped
or not (ChatGPT-plan requests don't count): the next is not sent and the run fails, spend_cap_reached. stdout gets one line per request, per run start and
end, and per refused credential; AGENTRUN_LOG=quiet leaves out the request lines.

AGENTRUN_TELEMETRY=0 (or DO_NOT_TRACK=1) turns off the anonymous usage counts (docs/telemetry.md): a random id, the
version, the platform and how many runs as a range, never prompts, files or keys. Off in CI, under a test runner and under --faux too;
AGENTRUN_TELEMETRY=debug prints each event on stderr and sends none.

AGENTRUN_API_ONLY=1 serves the run routes alone, for a server behind its caller's backend: a run's launch, read, list,
timeline, messages, stop, cancel, kill and cap raise, its files and uploads, an agent's Archil disk, capabilities, health
and usage; the computers list, the workspace's Archil disk and an agent's delete (DELETE /agents/{id}). Every other address (the page, sign-in, setup, settings, MCP, triggers and their hooks, the rest of agents)
is a 404, and there are no accounts.

The page is for one person, who signs in with a password (AGENTRUN_ACCOUNTS=0 turns this off; the token works for
scripts and the CLI either way). With no AGENTRUN_PUBLIC_URL, listening on loopback, the first visit to the page sets the
password; with it, or on any other address, the setup link this server prints carries a code. Sign-in tries are limited
per address (an IPv6 one by its /64) and wrong passwords per server; past the limit a try waits, a minute at most.
Behind a proxy, set AGENTRUN_TRUSTED_PROXIES to its addresses or ranges (comma-separated; or loopback, linklocal,
uniquelocal) so each visitor counts by the address its X-Forwarded-For names; unset, that header is never read. Forgot the password: \`agentrun-serve reset-password --data DIR\` where the
data directory is (inside the container) clears it and signs every browser out, and the next visit sets a new one.
An MCP server on loopback (a 127.0.0.1 or localhost address) is refused unless AGENTRUN_MCP_ALLOW_LOOPBACK=1 is set at the
start: set it only on a machine you alone use, since loopback is this machine's other services too. A runner in its own
process reaches one only with the variable set in its own environment, on its own loopback (its own machine or
container), never at a server's own port (${DEFAULT_PORT}, or where the server says it listens).

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
them on that server instead, its token in AGENTRUN_API_KEY, and archives the agents it made. --on-data DIR runs its own
server on DIR, a stopped server's data folder, so the runs use what that server keeps (its ChatGPT sign-in) and a case's
fakes (its clock, its mailbox) still bind; it archives the agents it made there and leaves the folder and its settings,
and is refused while another server holds DIR, when DIR has enabled triggers or runs not ended, or for an email case
when DIR's server keeps an email account. --runs N runs each case N
times in place of its own count; --grader-model is the llm graders' model (default: the server's); --faux answers every
model request from MODULE, as the server's --faux does. Progress goes to stderr, a summary to stdout, the whole report
as JSON to --report FILE. Exit 0 when every case passed, 1 when one failed, 2 when the flags, the package or a case are
wrong and nothing ran. Real runs cost money: each case's prompt.md caps each of its runs (max_cost_usd).`;

// A command's --help (or -h), before the command reads anything else it was given: its own lines of USAGE and the
// paragraph that says what it does, where there is one, on stdout, exit 0. No store is opened and nothing is written,
// so `reset-password --help` clears no password and `install-harness goose --help` downloads nothing. A command USAGE
// has no line for (remote-bridge) has no --help of its own.
const command = process.argv[2];
const commandArgs = process.argv.slice(3);
/** The command's own lines of USAGE, the first "usage:" and the rest under it; empty when USAGE has none for it. */
const commandUsage = USAGE.split("\n")
  .filter((line) => line.trimStart().replace(/^usage: /, "").startsWith(`agentrun-serve ${command} `))
  .map((line, i) => `${i === 0 ? "usage:" : "      "} ${line.trimStart()}`)
  .join("\n");
const optionsEnd = commandArgs.indexOf("--");
if (commandUsage && (optionsEnd === -1 ? commandArgs : commandArgs.slice(0, optionsEnd)).some((arg) => arg === "--help" || arg === "-h")) {
  const about = USAGE.split("\n\n").find((block) => block.startsWith(`\`agentrun-serve ${command}`));
  console.log([commandUsage, ...(about ? [about] : []), "agentrun-serve --help says what the server's own flags and variables do."].join("\n\n"));
  process.exit(0);
}

if (process.argv[2] === "remote-bridge") {
  const { runRemoteWorkerBridge } = await import("./native/remote-worker-bridge.js");
  await runRemoteWorkerBridge();
  process.exit(0);
}

if (process.argv[2] === "native") {
  const { nativeMain } = await import("./native/cli.js");
  process.exit(await nativeMain(process.argv.slice(3), commandUsage));
}

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

// A harness its owner installs (harness-goose.ts: Goose, the one there is), never a run: its pinned archive downloaded,
// checked and unpacked into DIR/harnesses/<name> (harness-archive.ts). 0 once it is there (now or already), 1 when the
// install failed (its code and the command to try again), 2 for a name it does not install. No provider key is read.
if (process.argv[2] === "install-harness") {
  const usage = (message: string): never => (console.error(`agentrun-serve install-harness: ${message}\n\n${USAGE}`), process.exit(2));
  const read = () => {
    try {
      return parseArgs({ args: process.argv.slice(3), options: { data: { type: "string" }, recipe: { type: "string" } }, allowPositionals: true });
    } catch (error) {
      return usage((error as Error).message);
    }
  };
  const { values, positionals } = read();
  // A recipe's harness (harness-recipe.ts): the recipe loaded under its five rules first, so a refused one downloads
  // nothing; then its release for this platform, as the Goose install does it.
  if (values.recipe !== undefined) {
    if (positionals.length) usage("it takes a harness's name or --recipe FILE, not both.");
    const [{ ArchiveInstallFailed }, { installRecipe, loadRecipe, recipeCheckLine, RecipeRefused }] = await Promise.all([import("./harness-archive.js"), import("./harness-recipe.js")]);
    const data = resolve(values.data ?? defaultData());
    try {
      const { recipe, file } = loadRecipe(values.recipe);
      const said = { downloaded: "the archive is downloaded and its sha256 matches the recipe", unpacked: "unpacked", verified: "the binary's sha256 is checked" } as const;
      const { version, installed, binary, pinnedBy } = await installRecipe(recipe, file, data, { onStep: (step) => console.error(`${recipe.label}: ${said[step]}`) });
      const held = { recipe: "the recipe's pin", "first-seen": "the first sha256 an earlier install recorded", recorded: "its sha256 recorded now, as the first one; a later binary that differs is refused" }[pinnedBy];
      console.log(installed === "already"
        ? `${recipe.label} ${version} is installed in ${dirname(binary)} (already: the pinned binary is there, so nothing was downloaded; held to ${held}).`
        : `${recipe.label} ${version} is installed in ${dirname(binary)} (now; the binary held to ${held}). Check it with: ${recipeCheckLine(file, data)} --model PROVIDER/MODEL`);
      process.exit(0);
    } catch (error) {
      if (!(error instanceof ArchiveInstallFailed) && !(error instanceof RecipeRefused)) throw error;
      console.error(error.message);
      process.exit(1);
    }
  }
  const { GOOSE_ID, installGoose } = await import("./harness-goose.js");
  if (positionals.length !== 1) usage(`it takes one harness: ${GOOSE_ID}.`);
  if (positionals[0] !== GOOSE_ID) usage(`it installs ${GOOSE_ID}, not ${positionals[0]}: claude-agent and codex install on first use, and pi and opencode come with AgentRun.`);
  const [{ ArchiveInstallFailed }, { acpPackage, ACP_PACKAGE }] = await Promise.all([import("./harness-archive.js"), import("./acp-package.js")]);
  if (!acpPackage()) {
    console.error(`Goose's adapter (${ACP_PACKAGE}) is not installed beside this server, so it has no pinned release to install.`);
    process.exit(1);
  }
  const data = resolve(values.data ?? defaultData());
  try {
    const said = { downloaded: "the archive is downloaded and its sha256 matches the pin", unpacked: "unpacked", verified: "the binary's sha256 matches the pin" } as const;
    const { version, installed, binary } = await installGoose(data, { onStep: (step) => console.error(`Goose: ${said[step]}`) });
    console.log(installed === "already"
      ? `Goose ${version} is installed in ${dirname(binary)} (already: the pinned binary is there, so nothing was downloaded).`
      : `Goose ${version} is installed in ${dirname(binary)} (now). Restart AgentRun to pick it up.`);
    process.exit(0);
  } catch (error) {
    if (!(error instanceof ArchiveInstallFailed)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

// A recipe's agent run for real and judged (harness-check.ts): its report written as JSON, its stages and the three facts
// (resume, tool_gate, billing) printed. 0 when every stage passed, 1 when the recipe was refused, its binary is not the
// installed and pinned one, or a stage failed, 2 for usage. It spends: four short turns on --model, under --cap.
// `agentrun harness-check` runs it; its own word is check-harness, as install-harness is `agentrun harness install`'s.
if (process.argv[2] === "check-harness") {
  const usage = (message: string): never => (console.error(`agentrun-serve check-harness: ${message}\n\n${USAGE}`), process.exit(2));
  const read = () => {
    try {
      return parseArgs({ args: process.argv.slice(3), options: { recipe: { type: "string" }, data: { type: "string" }, model: { type: "string" }, report: { type: "string" }, cap: { type: "string" } } });
    } catch (error) {
      return usage((error as Error).message);
    }
  };
  const { values } = read();
  if (!values.recipe) usage("--recipe FILE names the recipe to check.");
  const cap = values.cap === undefined ? undefined : Number(values.cap);
  if (cap !== undefined && !(Number.isFinite(cap) && cap > 0 && cap <= 5)) usage("--cap is the most the check may spend, in USD, above 0 and at most 5.");
  const [{ harnessCheck, printedFacts, writeReport }, { withSecrets }] = await Promise.all([import("./harness-check.js"), import("./secrets.js")]);
  const data = resolve(values.data ?? defaultData());
  const report = await harnessCheck({ recipe: values.recipe!, data, env: withSecrets(process.env), ...(values.model ? { model: values.model } : {}), ...(cap !== undefined ? { capUsd: cap } : {}), say: (line) => console.error(line) });
  const file = resolve(values.report ?? `harness-check-${"id" in report.recipe ? report.recipe.id : "recipe"}.json`);
  await writeReport(file, report);
  for (const line of printedFacts(report)) console.log(line);
  console.log(`report: ${file}`);
  process.exit(report.ok ? 0 : 1);
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
// 0: every case passed; 1: one failed; 2: the flags, the package or a case is wrong, and nothing ran. --data is taken and
// ignored, as validate-template's is: the npx launcher hands every server command one, and an eval's store is a temp one.
if (process.argv[2] === "eval-template") {
  const { CaseError, evalTemplate, exitCodeOf, markdownReport, ON_DATA_WITH_SERVER } = await import("./template-eval.js");
  const { PackageError } = await import("./templates.js");
  const usage = (message: string): never => (console.error(`agentrun-serve eval-template: ${message}\n\n${USAGE}`), process.exit(2));
  const read = () => {
    try {
      return parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: { case: { type: "string", multiple: true, default: [] }, runs: { type: "string" }, server: { type: "string" }, "grader-model": { type: "string" }, report: { type: "string" }, faux: { type: "string" }, data: { type: "string" }, "on-data": { type: "string" } } });
    } catch (error) {
      return usage((error as Error).message);
    }
  };
  const { values: given, positionals } = read();
  if (positionals.length !== 1) usage("it takes one package folder.");
  if (given.runs !== undefined && !/^[1-9]\d{0,2}$/.test(given.runs)) usage("--runs takes a whole number from 1 to 999.");
  if (given.server !== undefined && !(URL.canParse(given.server) && /^https?:$/.test(new URL(given.server).protocol))) usage("--server takes the server's http(s) address.");
  if (given.server !== undefined && given.faux !== undefined) usage("--faux is the model of the server it starts itself, and --server names another server.");
  if (given.server !== undefined && given["on-data"] !== undefined) usage(`${ON_DATA_WITH_SERVER}.`);
  if (given["on-data"] === "") usage("--on-data takes a server's data folder.");
  const token = given.server === undefined ? undefined : secret("AGENTRUN_API_KEY") || secret("AGENTRUN_TOKEN");
  if (given.server !== undefined && !token) usage("--server needs that server's token in AGENTRUN_API_KEY.");
  // The report is written after every case ran, so where it goes is checked now, before anything runs or is paid for.
  if (given.report !== undefined) {
    const folder = dirname(resolve(given.report));
    const writable = (() => {
      try {
        accessSync(folder, fsConstants.W_OK);
        const existing = statSync(resolve(given.report), { throwIfNoEntry: false });
        // A report already there is written over: it must be a file this command can write.
        if (existing) accessSync(resolve(given.report), fsConstants.W_OK);
        return statSync(folder).isDirectory() && !(existing?.isDirectory() ?? false);
      } catch {
        return false;
      }
    })();
    if (!writable) usage(`--report's folder ${folder} is not a folder this command can write in, or the report's path is a folder or a file it can't write.`);
  }
  // The first Ctrl-C (or a stop) cancels the run in progress and cleans up what the eval made, as its end does: a run
  // left going would go on spending. A second one leaves at once (stop-signals.ts stopOnce).
  const stop = stopOnce(() => console.error("agentrun-serve eval-template: stopping: cancelling the run in progress and cleaning up (again to leave now)"));
  stop.hook();
  try {
    const report = await evalTemplate({
      dir: resolve(positionals[0]!), cases: given.case, ...(given.runs !== undefined ? { runs: Number(given.runs) } : {}),
      ...(given.server !== undefined ? { server: { baseUrl: given.server, token: token! } } : {}), ...(given["grader-model"] !== undefined ? { graderModel: given["grader-model"] } : {}),
      ...(given.faux !== undefined ? { serve: { faux: resolve(given.faux) } } : {}), ...(given["on-data"] !== undefined ? { data: resolve(given["on-data"]) } : {}),
      log: (line) => console.error(line), signal: stop.signal,
    });
    // A stop asked as the eval ended still stops it: no report, 130.
    stop.signal.throwIfAborted();
    if (given.report !== undefined) writeFileSync(resolve(given.report), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(markdownReport(report));
    process.exit(exitCodeOf(report));
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

// The runner process (runner/main.ts): beside the server, its own store connection in --data, claiming runs until SIGTERM
// or SIGINT. Its exit: 2 bad arguments, 3 a store schema it does not know, 1 anything else, 0 closed. `--check` reads its
// heartbeat (0 fresh, 1 not).
if (process.argv[2] === "runner") {
  const { runnerMain } = await import("./runner/main.js");
  process.exit(await runnerMain(process.argv.slice(3)));
}

if (process.argv[2] === "import") {
  const { importCommand } = await import("./import.js");
  process.exit(await importCommand(process.argv.slice(3), USAGE));
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
      "faux-github": { type: "boolean", default: false },
      "allow-host": { type: "string", multiple: true, default: [] },
      "max-runs": { type: "string" },
      "drain-timeout": { type: "string" },
      documents: { type: "string" },
      "allow-code-nodes": { type: "boolean", default: false },
      learning: { type: "string" },
      "no-runner": { type: "boolean", default: false },
      "harness-module": { type: "string", multiple: true, default: [] },
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
if (values["faux-github"] && !values.faux) {
  console.error(`--faux-github goes with --faux\n\n${USAGE}`);
  process.exit(2);
}
const data = values.data ?? defaultData();
const given = secret("AGENTRUN_TOKEN") || undefined;
// More tokens, each with an id (api-token.ts), for a rotation with no caller refused; never printed. A list that cannot
// be read stops here, in words that hold no secret.
let givenList: ApiToken[] | undefined;
try {
  givenList = parseTokens(secret("AGENTRUN_TOKENS"));
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
// The stop is listened for before anything starts: a SIGTERM or SIGINT during the start (a platform's redeploy, the
// moment the banner shows) is kept, never the default end by signal that cuts what the start began. Once the start has
// what a stop closes, the stop below takes over (stopOnSignals), and a stop asked meanwhile runs it, through the same
// drain. A second signal a while after the first, still during the start, is a person who wants out now: exit 130.
let stopping: (() => void) | undefined;
let askedAt: number | undefined;
const signalled = () => {
  if (stopping) return stopping();
  if (askedAt === undefined) askedAt = Date.now();
  else if (Date.now() - askedAt >= REPEAT_MS) process.exit(130);
};
process.on("SIGINT", signalled);
process.on("SIGTERM", signalled);
// AGENTRUN_API_ONLY=1: the run routes alone (api-only.ts), and no owner; a value that is neither on nor off stops here.
let apiOnly: boolean;
try {
  apiOnly = apiOnlyFrom(process.env);
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
const accounts = !apiOnly && process.env.AGENTRUN_ACCOUNTS !== "0";
// The address first (listen-first.ts): the port bound and named before the rest of the server loads, then answering that
// the server is warming until it takes the socket over. A port already taken is left to the start's own listen below,
// which waits for a server it replaces, as it always has: no early line then. The banner's "Open " line still means ready.
let early: Awaited<ReturnType<typeof listenFirst>>;
try {
  early = await listenFirst({ host: values.listen ?? DEFAULT_HOST, port, data, env: process.env });
} catch (error) {
  console.error(`agentrun-serve: ${(error as Error).message}`);
  process.exit(1);
}
if (early) console.log(`Starting ${publicUrl ?? urlOf(early, values.listen ?? DEFAULT_HOST)}/ (warming: health says so and the API answers 503 until the server is ready)`);
const [{ fauxEnvOf, startServe }, { besideRunnerOptions, besideStopping, runnerBeside }, { startedWith }, { canOpen }] = await Promise.all([import("./server.js"), import("./runner/beside.js"), import("./adapters.js"), import("./host.js")]);
// How it was started, for the hints that start it again (adapters.ts npxLine): itself and its runs read it.
Object.assign(process.env, startedWith({ ...(values.port !== undefined ? { port: values.port } : {}), open: values.open === true }));
let serve: Serve;
let serveOptions: ServeOptions;
const trustedProxies = (process.env.AGENTRUN_TRUSTED_PROXIES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
try {
  serve = await startServe(serveOptions = {
    // The owner lock on a Postgres store lost for good: this server can serve nothing more, so it exits non-zero and its
    // platform starts it again, rather than answer 503 for as long as it runs.
    onStoreLost: (error) => {
      console.error(`agentrun-serve: ${error.message}`);
      process.exit(1);
    },
    data, port, ...(values.port === undefined ? { nextFreePort: true } : {}), ...(early ? { listener: early } : {}), ...(values.listen ? { host: values.listen } : {}), ...(given ? { token: given } : {}), ...(givenList ? { tokens: givenList } : {}), ...(values.faux ? { faux: values.faux } : {}), ...(values["faux-browser"] ? { fauxBrowser: values["faux-browser"] } : {}), ...(values["faux-github"] ? { fauxGitHub: true } : {}), allowHosts: values["allow-host"],
    ...(values["max-runs"] !== undefined ? { maxRuns: Number(values["max-runs"]) } : {}),
    // The owner's harness modules: --harness-module, else AGENTRUN_SERVE_HARNESS_MODULES (harness-table.ts).
    ...(harnessModulesOf(values["harness-module"], process.env).length ? { harnessModules: harnessModulesOf(values["harness-module"], process.env) } : {}),
    ...(values["drain-timeout"] ? { drainTimeout: values["drain-timeout"] } : {}), ...(values.documents ? { documents: values.documents } : {}), ...(values["allow-code-nodes"] ? { allowCodeNodes: true } : {}), ...(values.learning !== undefined ? { learning: values.learning as LearningMode } : {}), log: (line) => void process.stdout.write(`${line}\n`),
    // The public address is the server's with accounts on or off: the Host names it serves, the webhook URLs it gives.
    ...(publicUrl ? { publicUrl } : {}),
    ...(accounts ? { accounts, openSetup: !publicUrl, countSessions: true } : {}), ...(apiOnly ? { apiOnly } : {}),
    // The proxies whose X-Forwarded-For the sign-in limit reads (comma-separated); none unless set.
    ...(trustedProxies.length ? { trustedProxies } : {}),
    // A local install only as its operator says, never inferred: an MCP server on loopback is refused without it.
    ...(process.env.AGENTRUN_MCP_ALLOW_LOOPBACK === "1" ? { mcpLoopback: true } : {}),
    // No runner beside this server: a paired computer's socket stays here, where no run reaches it, which the pairing says.
    ...(values["no-runner"] ? { runnerApart: true } : {}),
  });
} catch (error) {
  console.error(`agentrun-serve: ${(error as Error).message}`);
  process.exit(1);
}
// The start launches one runner beside the server on the same data dir (design: "server and runner"): it claims and runs
// every run, sharing only the store. With --no-runner the server runs alone, so the operator starts one or more separate
// `agentrun runner --data DIR` processes on the same data directory instead. The runner holds what the server's flags say
// (besideRunnerOptions): at most --max-runs runs at once, the rest waiting queued, and on the stop each busy run finishes
// its turn for up to --drain-timeout.
let runnerProc: Awaited<ReturnType<typeof runnerBeside>> | undefined;
// Anonymous usage counts (telemetry.ts, docs/telemetry.md): off with AGENTRUN_TELEMETRY=0 or DO_NOT_TRACK=1, in CI and
// under --faux. It hears each run's end from the runner beside the server; with --no-runner it counts no runs.
const telemetry = startTelemetry({ data: resolve(data), ...(values.faux ? { faux: true } : {}) });
const { loops, loopsTold, drainMs } = besideRunnerOptions(serveOptions, process.env);
// A stop asked during the server's start starts no runner: nothing is claimed for the stop to cut.
if (!values["no-runner"] && askedAt === undefined) {
  try {
    // The beside-runner sees the server's test switches (server.ts fauxEnvOf: --faux and its modules), which the CLI hands
    // the server as options, never through this process's environment: without them a --faux start's runner looks its faux
    // model up in pi-ai's own catalog and every run fails on its first request. A test switch this process inherited from
    // its shell is taken out first, as the server's own environment drops it (runner/main.ts besideRunEnv).
    const { besideRunEnv } = await import("./runner/main.js");
    // With the computer janitor: what a crashed runner of this server left is ended (never under --faux). With the
    // server's AttachHub: a paired computer's socket is in this process, so only this runner takes one (--no-runner's
    // separate runners refuse it in words). Its runs reach an MCP server on loopback only when this server is a local
    // install (Serve.localInstall).
    // Each run a process of its own, as a user of its own where the image's helper can switch (run-child-host.ts).
    runnerProc = await runnerBeside(data, { loops, loopsTold, drainMs, env: besideRunEnv(process.env, fauxEnvOf(serveOptions)), janitor: true, ownProcesses: true, hub: serve.attachHub, dial: serve.dial, mcpLoopback: serve.localInstall, mcpOwn: serve.own, onRunEnded: telemetry.runEnded });
  } catch (error) {
    // A run isolation the runner cannot give (run-child-host.ts runIsolationOf) is said, and the server serves on with no
    // runner, as the runner subcommand stays up claiming nothing (runner/main.ts): a platform that restarts a stopped
    // container would otherwise loop on it.
    const { RunIsolationRefused } = await import("./runner/run-child-host.js");
    if (!(error instanceof RunIsolationRefused)) {
      console.error(`agentrun-serve: the runner could not start: ${(error as Error).message}`);
      await serve.close();
      process.exit(1);
    }
    console.error(`agentrun-serve: ${error.message}`);
  }
}
// A token from the environment is the operator's already, and the stored one is printed by the start that made it only.
const source = given ? "env" : givenList ? "list" : serve.tokenMade ? "made" : "file";
for (const line of banner({ url: serve.url, baseUrl: serve.baseUrl, data, token: serve.token, source, tokenIds: serve.tokenIds, accounts, ...(apiOnly ? { apiOnly } : {}), ...(serve.launchCode ? { launchCode: serve.launchCode } : {}), boxes: serve.boxesLine, ...(values.listen ? { listen: values.listen } : {}), ...(publicUrl ? { publicUrl } : {}) })) console.log(line);
// Open setup (no public address, a loopback listener): the link that sets the password. Any other start printed the
// setup link with its code as the code was made (owner.ts).
if (serve.setupUrl && serve.setupOpen) console.log(`Set your password: ${serve.setupUrl} (the first visit sets it)`);
// The notice of the anonymous counts, once, on stderr: the npx command passes stderr through and keeps stdout to itself.
if (telemetry.notice) console.error(telemetry.notice);
// The console's page, once the server listens: never its sign-in link, whose token would sit in the opener's arguments
// and the browser's history. With no owner yet, the setup page instead, its code filled in when setup takes one: the
// first visit sets the password with nothing to look up. That code works once and for 30 minutes, unlike the token, so
// the opener's arguments and the browser's history hold nothing that outlasts the setup.
// API-only: there is no console, so nothing to open.
if (values.open && !apiOnly && canOpen(process.env)) spawn(process.platform === "darwin" ? "open" : "xdg-open", [serve.setupUrl ?? `${publicUrl ?? serve.url}/`], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
const record = join(resolve(data), SERVER_FILE);
// The record goes only while it is this server's: a server that takes the lock next writes its own, which this stop must
// not remove. One stop per press or process-manager stop; a later signal, or a stop past its deadline, stops at once
// (stop-signals.ts). The stop is in place before the record is written: a SIGTERM sent the moment the record appears is
// a clean stop that removes it, never the default end by signal that leaves it behind.
const stop = stopOnSignals({
  close: () => {
    removeOwnRecord(record);
    // A drain that has runs to wait on says so, as a run's own process did on the server's stop.
    const busy = runnerProc?.runner.held().length ?? 0;
    if (busy > 0 && drainMs > 0) console.error(`agentrun-serve: stopping: waiting up to ${Math.ceil(drainMs / 1000)} s for ${busy} ${busy === 1 ? "run" : "runs"} to finish ${busy === 1 ? "its turn" : "their turns"}`);
    // The counts' last write (telemetry.ts) is waited for once the runner has said its last run's end.
    return Promise.all([(runnerProc?.close() ?? Promise.resolve()).then(() => telemetry.close()), serve.close()]).then(() => undefined);
  },
  // The stop's deadline waits out the runner's whole close: its drain, then the stop of the loops left, so a run's end
  // and release are never cut short (besideStopping).
  stopping: () => (runnerProc ? besideStopping(serve.stopping(), runnerProc.runner.held().length, drainMs) : serve.stopping()),
  done: (code) => (removeOwnRecord(record), process.exit(code)),
  say: (line) => console.error(line),
});
stopping = stop;
// Written whole under a name of its own, then renamed into place: a reader in another process (the npx command, a test
// waiting for this server) that finds the record reads all of it, never a file made but not yet filled.
writeDurableSync(record, `${JSON.stringify({ base_url: serve.baseUrl, pid: process.pid, ...(serve.tokenFile ? { token_file: serve.tokenFile } : {}) })}\n`);
chmodSync(record, 0o600);
// A stop asked during the start runs now, as one asked from here on would.
if (askedAt !== undefined) stop(askedAt);
