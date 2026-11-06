#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent store in a data directory.
// First: the secrets the launcher hands over, read and its pipe closed before anything else runs (secrets.ts). It loads
// nothing but node:fs and node:os.
import { secret } from "./secrets.js";
// Then, before anything loads node:sqlite, the filter for its ExperimentalWarning (quiet-sqlite-warning.ts).
import "./quiet-sqlite-warning.js";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { defaultData } from "./files.js";
import { canOpen } from "./host.js";
import { resetPassword } from "./owner.js";
import type { ImageState } from "./box-image.js";
import { banner, boxImageLine } from "./print.js";
import type { LearningMode } from "./learning.js";
import { DEFAULT_PORT, type Serve, startServe } from "./server.js";

const USAGE = `usage: agentrun-serve [--data DIR] [--listen ADDR] [--port N] [--open] [--faux MODULE] [--allow-host NAME ...] [--max-runs N] [--drain-timeout D] [--documents DIR] [--allow-code-nodes] [--learning on|off] [--learning-budget BYTES] [--grade-model MODEL]
       agentrun-serve reset-password [--data DIR]
       agentrun-serve import [--data DIR] [--from claude-code,codex,pi] [--dry-run] [--include-deleted] [--all] [--verbose] [--port N]

  --data DIR        the agent store and its runs (default ~/.local/share/agentrun/agents); the token is DIR/.token, mode 0600
  --listen ADDR     the address to listen on (default 127.0.0.1); on any other, every Host name is served and the token
                    is the only lock, so put TLS in front of it
  --port N          the port (default: the first free one from ${DEFAULT_PORT}; 0 is any free port)
  --open            open the console in this machine's browser once the server listens (not in CI, nor on Linux with no
                    display)
  --faux MODULE     answer every model request from MODULE's default export: no key, no network
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
it needs a key). AGENTRUN_TOKEN, when set, is the token in place of DIR/.token's, and is never printed; DIR/.token's is
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
session found, those imported before included, and the address to open the console at (--port as the server takes it).`;

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
let serve: Serve;
try {
  serve = await startServe({
    onBoxImage,
    data, port, ...(values.port === undefined ? { nextFreePort: true } : {}), ...(values.listen ? { host: values.listen } : {}), ...(given ? { token: given } : {}), ...(values.faux ? { faux: values.faux } : {}), allowHosts: values["allow-host"],
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
const stop = () => void serve.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
