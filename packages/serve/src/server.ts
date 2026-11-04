// The /v2 API over the agent store in a data directory: the contract agentrun.v2/0, served on loopback with a bearer
// token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import type { NewRevision, Revision } from "@parcha/pi-durable-agent";
import { agentView, Agents, etagOf, homeBusy, revisionView, storeBusy, type AgentEntry } from "./agents.js";
import { WORKFLOW_ADAPTERS } from "./app.js";
import { DECISION_ADAPTER, decisionsOf, FAUX_JEV_ENV, FAUX_OPENROUTER_ENV, FAUX_PARALLEL_ENV } from "./decisions.js";
import { FAUX_WEB_ENV } from "./fetch-page.js";
import { FAUX_MONID_ENV } from "./monid.js";
import { FAUX_EXA_ENV } from "./exa-keyless.js";
import { FAUX_BROWSER_ENV, NODE_TOOLS, toolingOf, toolsView } from "./tools.js";
import { ApiError, type InputIssue, invalid, unsupported } from "./errors.js";
import { DATA_ENV, DOOR_TOKEN_FILE, HOME_HOST_OWNED, HOMES_DIR, homeOf, readJson, RUN_META, syncDir, writeDurable } from "./files.js";
import { checkedPath, decodedPath, homePath, hostOwnedOf, hostOwnedRefusal, type OwnedReadAt, ownedByIdentity } from "./home-path.js";
import { chooseModel, EFFORTS, FAUX_ENV, FAUX_UPSTREAM_ENV, MODEL_NODES, type ModelNeeds, modelSource, THINKING_LEVELS, withoutFaux } from "./model.js";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV, type HarnessCapability, harnessOffers } from "./harness.js";
import { healthOf, hostMemory, maxRunsOf, MIN_FREE_MIB, runsThatFit } from "./host.js";
import { IMPORT_ASKED } from "./import.js";
import type { ImportAnswer, ImportTask } from "./import-worker.js";
import { gradeModelOf, learningBudgetOf, type LearningMode, learningOf } from "./learning.js";
import { agentLearning, learningLog, learningNotes, noteBody, readNote, runDiff, runLearning, secretsShown, sendNote, writeNote } from "./learning-routes.js";
import { answerLlms, MCP_PATH, mcpEndpoint } from "./mcp.js";
import { openapiDocument, UNSUPPORTED } from "./openapi.js";
import { boxesLine, noBoxReason, type Place, placesOf, resolvePlace } from "./place.js";
import { FAUX_BOX_ENV, fauxBoxes } from "./run-box.js";
import { Owner, passwordProblem, SESSION_MS } from "./owner.js";
import { answerPage, isJson, ownerCookie, ownOrigin, signedIn } from "./page.js";
import { durationMs, logLine } from "./print.js";
import { type CarryBackRetry, type Run, Runs, STATUSES, type Status, statusOf, toolCostOf } from "./runs.js";
import { BOX_QUARANTINE, type BoxHost, Quarantine } from "./box/sweep.js";
import { type BoxOffer, boxesLog, boxRegistry, daytonaApi, enabledBoxes } from "./boxes.js";
import { startBoxRelay } from "./box-relay.js";
import { DOCUMENTS_ENV } from "./pdf-pages.js";
import { metersIn } from "./cap.js";
import { blockersOf, CODE_NODES_ENV, issueOf, type RevisionShape } from "./runnable.js";
import { hostSecrets, SECRET_NAMES, secret, type StoredKeys, withSecrets } from "./secrets.js";
import { analyticsFilter, analyticsView, statsView } from "./stats.js";
import { outcomes } from "./usage.js";
import { keyOf, SEAL_KEY_ENV, sealKeyOf, TOOL_FIELDS, ToolKeys } from "./tool-keys.js";
import { WEBHOOK_EVENTS, Webhooks } from "./webhooks.js";
import { checkDefinitionBody, DEFAULT_INPUT_SCHEMA, ID, inputIssues, isObject, type Json, stable, unknownFields } from "./validate.js";
import { agentTools, settingsIssues, ToolSettings, type ToolSettingsMap, withDefaults } from "./tool-plane.js";
import { MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, Uploads, UPLOADS_DIR } from "./uploads.js";
import { INLINE_TYPES, openWorkFile, removeWorkFile, typeOf, WALK_DEPTH, walkWork, WorkRefused, writesHeld, writeWorkFile } from "./workspace.js";
import { markRunning, markStopping, type ServerLock, takeServerLockAfterStop } from "./server-lock.js";

export const CONTRACT = "agentrun.v2/0";

/** A process's flags for a worker of it: without --input-type and the code string given with -e, --eval, -p or --print. */
const workerArgs = (args: readonly string[]): string[] =>
  args.filter((arg, i) => !arg.startsWith("--input-type") && !/^(?:-e|--eval|-p|--print)(?:=|$)/.test(arg) && !/^(?:-e|--eval|-p|--print)$/.test(args[i - 1] ?? ""));
export const DEFAULT_PORT = 7340;
const VERSION: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const TOKEN_FILE = ".token";
const IDEMPOTENCY_FILE = ".idempotency.json";
const MAX_BODY = 1 << 20;
const MAX_MESSAGE = 20_000;
const MAX_WAIT_MS = 25_000;
const PAGE_ROWS = 500;
const IDEMPOTENCY_TTL_S = 86_400;
const FILE_LIST_CAP = 2_000;
/** What a stopping server's record allows past its runs' kill bound, the cap a start waits under: the runs' carry backs,
 *  retried while the agent store is held (about 15.5 s), their boxes' cleanup (up to a minute), and the deliveries', the
 *  listener's and the stores' stop. A start stops waiting sooner once the stopping server's process is gone. */
const STOP_MARGIN_MS = 120_000;
/** A wait, as the stop's lines give it: whole seconds, rounded up, one at least. */
const seconds = (ms: number) => `${Math.max(1, Math.ceil(ms / 1000))} s`;
/** Where the stop's lines go (ServeOptions.notice). Best-effort: a notice that throws never stops a close or a start. */
const noticeOf = (options: Pick<ServeOptions, "notice">) => (line: string): void => {
  try {
    (options.notice ?? ((said: string) => void process.stderr.write(`agentrun-serve: ${said}\n`)))(line);
  } catch {
    // The line is told, not needed: the stop and the wait go on without it.
  }
};
/** Why a home's PUT or DELETE is 501 where `capabilities.home.writes` is false (workspace.ts writesHeld). */
const HOME_WRITES_OFF = "This server can't write a home's files safely here: a write needs /proc/self/fd, as on Linux, which this platform lacks. Reads and the list still work.";
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; form-action 'none'";

export type ServeOptions = {
  /** The data directory: the agent store (`store.sqlite`) and its runs (`runs/<id>/`). */
  data: string;
  /** The owner, signed in with a password (owner.ts): the page asks for it, and the token stays for scripts and the CLI. */
  accounts?: boolean;
  /** With accounts: the first visit sets the password with no setup code (a server with no public address). Off, setup
   *  takes the code this server prints, or the token. */
  openSetup?: boolean;
  /** With accounts: the address people open (AGENTRUN_PUBLIC_URL), which the printed setup link uses. */
  publicUrl?: string;
  /** With open setup: the home whose Claude Code, Codex and pi sessions setup offers to import (default this user's),
   *  and the temp directory whose projects it leaves out (default the OS's). */
  sessionsHome?: { home: string; temp?: string };
  /** With open setup on this machine, and no owner yet: count the sessions setup would import as the server starts, so
   *  the offer has its numbers by the time the page opens (the CLI sets it). */
  countSessions?: boolean;
  /** With accounts: the most addresses the sign-in limit keeps at once (default 10,000); a new one past it is a 429. */
  signInAddresses?: number;
  /** The address to listen on (default 127.0.0.1). On any other address every `Host` name is served and the token is
   *  the only lock: put TLS in front of it. */
  host?: string;
  /** The token to require in place of the one `DIR/.token` keeps: 32 characters or more, no whitespace. */
  token?: string;
  /** Default 7340; 0 is any free port. */
  port?: number;
  /** When the port is taken at the listen, the next one that is not, of the 100 from it: the port is found by listening,
   *  so one another process takes at the same moment is passed over. Without it a taken port fails the start. */
  nextFreePort?: boolean;
  /** A read-only directory of documents a workflow's `pdf_pages` calls read by file name (`--documents`); default
   *  AGENTRUN_SERVE_DOCUMENTS. */
  documents?: string;
  /** Run workflows' `code` nodes (`--allow-code-nodes`; default AGENTRUN_SERVE_CODE_NODES=1). Off, a workflow with one saves
   *  with a warning and its run is 409: a code node runs in the run's process through `new Function`, which is no sandbox. */
  allowCodeNodes?: boolean;
  /** A faux model module (no key, no network): see the README. */
  faux?: string;
  /** With `faux` only: a module whose default export gives the `browser` tool's `{ provider, driver }` (the tests' fake
   *  backend), in place of Browserbase's. */
  fauxBrowser?: string;
  /** With `faux` only: a module whose default export gives `fetch_page` its `{ lookup, fetchImpl }` (the tests' fake
   *  network), in place of the system's resolver and undici. */
  fauxWeb?: string;
  /** With `faux` only: a module whose default export is the fetch Jev's runner sends through (the tests' fake), in place
   *  of TypeSafe's API. */
  fauxJev?: string;
  /** With `faux` only: a module whose default export is the fetch the Parallel provider sends through (the tests' fake),
   *  in place of Parallel's API. */
  fauxParallel?: string;
  /** With `faux` only: a module whose default export is the fetch OpenRouter's decision models send through, in place of
   *  OpenRouter's System One API (`@parcha/agentrun-decisions/testing/faux-system-one` is one). */
  fauxOpenrouter?: string;
  /** With `faux` only: a module whose default export is the fetch the monid tools send through (the tests' fake), in
   *  place of monid's API. */
  fauxMonid?: string;
  /** With `faux` only: a module whose default export is the fetch the Anthropic and OpenAI providers send through, in
   *  place of their APIs, for web_search's own request to the provider the revision's model names (model.ts). */
  fauxUpstream?: string;
  /** With `faux` only: a module whose default export is the fetch web_search's keyless Exa search sends through, in place
   *  of Exa's MCP endpoint (exa-keyless.ts). */
  fauxExa?: string;
  /** A module scripting the faux harness (`script(spec)`): every harness but pi runs on it (harness.ts). */
  fauxHarness?: string;
  /** With `faux` only: a module whose default export, given the data root, is the box provider runs' Docker boxes come
   *  from (the tests' faux box, pi-transport's local box): docker is then available, and nothing asks Docker. */
  fauxBox?: string;
  /** Extra `Host` names to accept besides the loopback ones. */
  allowHosts?: string[];
  /** The console's built files, answered at / (default dist/console beside the server, which this package's build copies
   *  from apps/console/dist). */
  console?: string;
  /** How long a run's process may finish its turn after SIGTERM (default 30s): `8s`, `500ms`, `1m`. */
  drainTimeout?: string;
  /** The most runs at once (default: AGENTRUN_MAX_RUNS, else as many pi runs as this host's memory holds: host.ts),
   *  beside the memory each run's harness reserves; over either, 429. */
  maxRuns?: number;
  /** Free disk under the data directory below which GET /v2/health fails (default 64 MiB, or AGENTRUN_MIN_FREE_MB). */
  minFreeBytes?: number;
  /** How often a carry back the store refused is tried again while the server lives (default 30 s). */
  settleRetryMs?: number;
  /** Where the log lines go (print.ts); none without it. AGENTRUN_LOG=quiet leaves out the request lines. */
  log?: (line: string) => void;
  /** The lines a person reads about a stop on this data root: this server's, as its close begins and runs' processes are
   *  left to finish their turn, and this start's, when it waits for a server that is stopping (server-lock.ts). Default:
   *  standard error, after `agentrun-serve: `. */
  notice?: (line: string) => void;
  /** The waits between carry backs that found the store held by another writer (default 0.5, 1, 2, 4 and 8 s), and a
   *  hook called at each such refusal. */
  carryBackRetry?: CarryBackRetry;
  /** A test's seam: awaited by a stop between its mark and its abort, so a test can hold a stop in flight there. */
  beforeAbort?: (runId: string) => Promise<void> | void;
  /** How long a request waits for a run's door, its process coming up or a settle in progress (default 45 s). */
  readyTimeoutMs?: number;
  /** How long a run's end-of-run turn may take before it is aborted and the run finishes without it (default 5 min). */
  reflectTimeoutMs?: number;
  /** How long a run's grader may take before it is cut off and the run's learning dropped (default 3 min). */
  gradeTimeoutMs?: number;
  /** The model the grader runs on (`--grade-model`; default AGENTRUN_SERVE_GRADE_MODEL, else the strong tier,
   *  AGENT_MODEL_STRONG, else each run's agent's own model). */
  gradeModel?: string;
  /** Whether runs learn (`--learning`; default AGENTRUN_SERVE_LEARNING, else `on`). `on`: a run of an agent whose
   *  definition says `learning: true` starts from what its agent learned. `off`: no run this server starts does, whatever
   *  its agent's definition says, and its `learning` is null. */
  learning?: LearningMode;
  /** How much of what a run learned its instructions hold under `# Learned`, in UTF-8 bytes (`--learning-budget`;
   *  default AGENTRUN_SERVE_LEARNING_BUDGET, else 8000): every note whole while they fit, else the index and the notes
   *  changed last, whole, while they fit (learning.ts learnedOf). */
  learningBudget?: number;
  /** The waits before each try again of a webhook delivery (default 5 s, 5 min, 30 min, 2 h, 5 h and 10 h: webhooks.ts RETRY_MS). */
  webhookRetryMs?: readonly number[];
  /** The box runs' harnesses run in (4a's Box: its reap; on a shared server its run cgroups): the boxes runs leave are
   *  swept at start and let go at archive. The quarantine of boxes a reap could not empty is kept in the data directory. */
  box?: BoxHost;
};

/** Each test switch a run's process reads, by the variable it reads it from: set only under `faux`, but the faux
 *  harness's, which scripts the harnesses with or without it. */
const FAUX_SWITCHES = [["fauxBrowser", FAUX_BROWSER_ENV], ["fauxWeb", FAUX_WEB_ENV], ["fauxJev", FAUX_JEV_ENV], ["fauxParallel", FAUX_PARALLEL_ENV], ["fauxOpenrouter", FAUX_OPENROUTER_ENV], ["fauxMonid", FAUX_MONID_ENV], ["fauxUpstream", FAUX_UPSTREAM_ENV], ["fauxExa", FAUX_EXA_ENV], ["fauxBox", FAUX_BOX_ENV]] as const;

/** The test switches a run's process gets, each module path resolved: empty outside tests. */
function fauxEnvOf(options: ServeOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options.fauxHarness ? { [FAUX_HARNESS_ENV]: resolve(options.fauxHarness) } : {};
  if (!options.faux) return env;
  env[FAUX_ENV] = resolve(options.faux);
  for (const [option, name] of FAUX_SWITCHES) if (options[option]) env[name] = resolve(options[option]);
  return env;
}

/** `tokenFile` is null when `options.token` gave the token; `tokenMade` says this start made the token in it. */
/** `setupUrl`: with accounts and no password yet, the page that sets it (with its code when setup needs one). */
/** `boxesLine`: what the start's banner says of the boxes, in words (place.ts boxesLine). */
export type Serve = { url: string; baseUrl: string; port: number; token: string; tokenFile: string | null; tokenMade: boolean; setupUrl?: string; boxesLine: string; close(): Promise<void> };

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

/** A private token in `file` (0600), made once and kept; `made` when this call made it. */
async function tokenIn(file: string): Promise<{ token: string; made: boolean }> {
  const known = await readFile(file, "utf8").then((text) => text.trim(), () => "");
  if (known && !/\s/.test(known)) {
    await chmod(file, 0o600);
    return { token: known, made: false };
  }
  const token = `ar_local_${randomBytes(24).toString("base64url")}`;
  await writeFile(file, `${token}\n`, { mode: 0o600, flag: "w" });
  await chmod(file, 0o600);
  return { token, made: true };
}

const digest = (text: string) => createHash("sha256").update(text).digest();
const SESSION_S = SESSION_MS / 1000;

/** A route: `name` is its operationId in the OpenAPI document (openapi.ts); `capability`, when this server turns it off;
 *  `raw`, a route whose body is bytes and not JSON, which the page's session may send with any content type, still only
 *  with the page's own Origin (page.ts). Only a PUT or a POST carries it. The Origin is the lock: a browser sends it with
 *  every cross-origin request and every POST and PUT, and a page cannot set it, so a page of another origin, even on this
 *  host's other ports (which the cookie's SameSite does not tell apart), never gets the session for a raw write. A PUT
 *  from another origin needs a preflight besides, which this server never answers; a raw POST does not, so a raw POST
 *  route only stores bytes (`POST /files`): nothing runs until a JSON request names them. */
export type Route =
  | { method: string; pattern: RegExp; name: string; capability?: string; raw?: never }
  | { method: "PUT" | "POST"; pattern: RegExp; name: string; capability?: string; raw: true };
export const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/capabilities$/, name: "getCapabilities" },
  { method: "GET", pattern: /^\/openapi\.json$/, name: "getOpenapi" },
  { method: "GET", pattern: /^\/health$/, name: "getHealth" },
  { method: "POST", pattern: /^\/agents$/, name: "createAgent" },
  { method: "GET", pattern: /^\/agents$/, name: "listAgents" },
  { method: "GET", pattern: /^\/agents\/([^/]+)$/, name: "getAgent" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/definition$/, name: "updateDefinition" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/revisions$/, name: "listRevisions" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/current$/, name: "setCurrent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/archive$/, name: "archiveAgent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/unarchive$/, name: "unarchiveAgent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/runs$/, name: "createRun" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/runs$/, name: "listRuns" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home$/, name: "exportHome", capability: "home.export" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/home$/, name: "importHome", capability: "home.import" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home\/files$/, name: "listHomeFiles" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home\/files\/(.+)$/, name: "readHomeFile" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/home\/files\/(.+)$/, name: "writeHomeFile" },
  { method: "DELETE", pattern: /^\/agents\/([^/]+)\/home\/files\/(.+)$/, name: "deleteHomeFile" },
  { method: "GET", pattern: /^\/runs$/, name: "listAllRuns" },
  { method: "GET", pattern: /^\/runs\/([^/]+)$/, name: "getRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/timeline$/, name: "getTimeline" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/messages$/, name: "sendMessage" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/stop$/, name: "stopRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/cancel$/, name: "cancelRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/archive$/, name: "archiveRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/unarchive$/, name: "unarchiveRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/kill$/, name: "killRun", capability: "runs.kill" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/graph$/, name: "getRunGraph" },
  { method: "POST", pattern: /^\/workflows\/validate$/, name: "validateWorkflow" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/pause$/, name: "pauseRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/resume$/, name: "resumeRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files$/, name: "listRunFiles" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files\/(.+)$/, name: "readRunFile" },
  { method: "POST", pattern: /^\/files$/, name: "createFile", raw: true },
  { method: "GET", pattern: /^\/files$/, name: "listFiles" },
  { method: "GET", pattern: /^\/files\/([^/]+)$/, name: "getFile" },
  { method: "PUT", pattern: /^\/files\/([^/]+)$/, name: "uploadFile", raw: true },
  { method: "DELETE", pattern: /^\/files\/([^/]+)$/, name: "deleteFile" },
  { method: "POST", pattern: /^\/quotes$/, name: "createQuote", capability: "quotes" },
  { method: "GET", pattern: /^\/usage$/, name: "getUsage" },
  { method: "GET", pattern: /^\/stats$/, name: "getStats" },
  { method: "GET", pattern: /^\/settings\/tool-keys$/, name: "listToolKeys" },
  { method: "PUT", pattern: /^\/settings\/tool-keys\/([^/]+)$/, name: "saveToolKey" },
  { method: "DELETE", pattern: /^\/settings\/tool-keys\/([^/]+)$/, name: "deleteToolKey" },
  { method: "GET", pattern: /^\/settings\/tools$/, name: "getToolSettings" },
  { method: "PUT", pattern: /^\/settings\/tools$/, name: "putToolSettings" },
  { method: "GET", pattern: /^\/settings\/webhook$/, name: "getWebhook" },
  { method: "PUT", pattern: /^\/settings\/webhook$/, name: "saveWebhook" },
  { method: "DELETE", pattern: /^\/settings\/webhook$/, name: "deleteWebhook" },
  { method: "POST", pattern: /^\/settings\/webhook\/test$/, name: "testWebhook" },
  { method: "GET", pattern: /^\/settings\/webhook\/deliveries$/, name: "listWebhookDeliveries" },
  { method: "POST", pattern: /^\/settings\/webhook\/deliveries\/([^/]+)\/redeliver$/, name: "redeliverWebhook" },
  // Answered before routing (mcp.ts), with the token only: listed here for the document.
  { method: "POST", pattern: /^\/mcp$/, name: "callMcp" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning$/, name: "getAgentLearning" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/notes$/, name: "listLearningNotes" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/log$/, name: "listLearningLog" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)$/, name: "readLearningFile" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)$/, name: "writeLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/retire$/, name: "retireLearningFile" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning$/, name: "getRunLearning" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning\/diff$/, name: "getRunLearningDiff" },
];

/** Where agent `agentId`'s host-owned path is read on this server: its route, when ROUTES has one (the learning API, for
 *  learning/). */
const ownedReadAt = (agentId: string): OwnedReadAt => (owned) => (ROUTES.some((r) => r.method === "GET" && r.pattern.test(`/agents/${agentId}/${owned}`)) ? `/v2/agents/${agentId}/${owned}` : undefined);

/** Whether the request to `path` (under /v2) is a PUT of a route marked `raw`. */
export const takesBytes = (method: string | undefined, path: string): boolean => (method === "PUT" || method === "POST") && ROUTES.some((r) => r.raw === true && r.method === method && r.pattern.test(path));

/** What this server offers. Every flag is present; an off one answers 501 naming it. */
/** A workflow run's title: its agent's name and a few words of its input, never the input's JSON ("Batch review: 20
 *  documents, as_of 2026-10-30"). */
export function workflowTitle(name: string, input: Record<string, unknown>): string {
  const words = Object.entries(input).slice(0, 3).map(([key, value]) => {
    if (Array.isArray(value)) return value.length === 1 && typeof value[0] === "string" ? value[0] : `${value.length} ${key}`;
    if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 39)}…` : value;
    if (typeof value === "number" || typeof value === "boolean") return `${key} ${value}`;
    return key;
  });
  // A name that ends in its own punctuation ("Is this certificate valid?") takes no colon after it.
  return words.length ? `${name}${/[?!:.]$/.test(name) ? "" : ":"} ${words.join(", ")}` : name;
}

/** `env` as the harnesses' offers are made from it: without the tool keys' fields (TOOL_FIELDS), which no harness reads.
 *  So the offers never depend on a tool key, and its save or delete leaves them as they are. */
export function offersEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const descriptors = Object.getOwnPropertyDescriptors(env);
  for (const name of TOOL_FIELDS) delete descriptors[name];
  return Object.defineProperties({}, descriptors) as NodeJS.ProcessEnv;
}

/** What of `env` a write can change that the harnesses' offers are made from: each secret but the tool keys' fields (a
 *  saved key is one of those; the rest of the environment is the server's start's). Held to tell whether a write needs
 *  the offers probed again, never shown. */
const offersInputs = (env: NodeJS.ProcessEnv): readonly (string | undefined)[] => SECRET_NAMES.filter((name) => !TOOL_FIELDS.includes(name)).map((name) => env[name]);

/** What a revision that names no model needs here (capabilities' `models.needs`): null when one runs, else chooseModel's
 *  `needs`, a provider's key or another model. Made from `env` alone, so it is remade only when env is. */
async function needsOf(env: NodeJS.ProcessEnv): Promise<ModelNeeds | null> {
  const chosen = await chooseModel(env, undefined);
  return "why" in chosen ? chosen.needs : null;
}

/** The server's reading of `base`, whole: its secrets, saved keys among them (`env`), the harnesses' offers, probed from
 *  env without the tool keys (offersEnvOf), and its capabilities made from both under its learning switch (`learning`,
 *  AGENTRUN_SERVE_LEARNING's when not given), its tool settings (`toolSettings`, what each web tool resolves to) and the
 *  box offers (`boxes`, what the box registry set up at the start, boxes.ts), with whether a revision that names no
 *  model runs (needsOf). The server makes it once at its start and then remakes only the parts a write changes
 *  (startHolding), so a key saved later can make a harness, a provider or the default model available with no restart.
 *  `gradeModel` is its `--grade-model`. */
export async function readingOf(base: NodeJS.ProcessEnv, maxRuns: number, stored?: StoredKeys, learning?: LearningMode, toolSettings: ToolSettingsMap = {}, boxes: readonly BoxOffer[] = [], gradeModel?: string) {
  const env = withSecrets(base, "all", stored);
  const offers = await harnessOffers(offersEnvOf(env));
  return { env, offers, caps: capabilitiesWith(env, maxRuns, offers, learning ?? learningOf(env), await needsOf(env), toolSettings, boxes, gradeModel) };
}

/** The capabilities document GET /v2/capabilities answers for `env`: each harness's offer resolved, its `default_model`
 *  included (harnessOffers), and whether a revision that names no model runs here (`models.ready`, and what it `needs`
 *  when not), so what this returns is what the route serves and what the document's schema holds.
 *  `learning` is the server's learning switch (`--learning`), AGENTRUN_SERVE_LEARNING's when not given; with this
 *  server's tool settings, what each web tool resolves to (tool-plane.ts); `boxes`, the box offers its places show; `gradeModel`, its `--grade-model`. */
export async function capabilities(env: NodeJS.ProcessEnv = withSecrets(process.env), maxRuns = maxRunsOf(env), learning: LearningMode = learningOf(env), toolSettings: ToolSettingsMap = {}, boxes: readonly BoxOffer[] = [], gradeModel?: string) {
  return capabilitiesWith(env, maxRuns, await harnessOffers(env), learning, await needsOf(env), toolSettings, boxes, gradeModel);
}

/** The capabilities document from offers already resolved, under the server's learning switch, tool settings and box
 *  offers: cheap, made again after each key or tool-settings write with the offers the server holds; and `needs` as
 *  needsOf says it for a revision that names no model (null when it runs). */
function capabilitiesWith(env: NodeJS.ProcessEnv, maxRuns: number, harnesses: HarnessCapability[], learning: LearningMode, needs: ModelNeeds | null, toolSettings: ToolSettingsMap, boxes: readonly BoxOffer[], gradeModel?: string) {
  const models = { ...modelSource(env), ready: needs === null, needs };
  // Both limits apply: the cap on the count, and the memory each run reserves (host.ts).
  const memory = hostMemory();
  return {
    backend: "local",
    contract: CONTRACT,
    server: { name: "@parcha/agentrun-serve", version: VERSION, platform: process.platform },
    runtimes: ["pi-durable-disk"],
    /** The harnesses a revision may name (`definition.harness`), whether this server runs each, and how many at once. */
    harnesses: harnesses.map((offer) => ({ ...offer, max_concurrent_runs: Math.min(maxRuns, runsThatFit(offer.id, memory)) })),
    /** The places a revision may name (`definition.place`), this host's default, and whether this server has each box. */
    places: placesOf(boxes),
    models,
    /** What grades a run's proposed notes: the model this server names for it (learning.ts gradeModelOf), or null when
     *  each run is graded on its agent's own model; and `pending`: a risky rule, the user's or the run's own, is kept to
     *  wait for its owner's OK, served to no run. */
    learning: { grade_model: gradeModelOf(env, gradeModel) ?? null, pending: true },
    /** Every tool a revision may name (the closed table in tools.ts): available here, or the variables it is missing; a
     *  web tool, what it resolves to on each harness under this server's tool settings; `key`, the tool key that unlocks
     *  it (tool-keys.ts), when one does. */
    tools: toolsView(env, toolSettings, noBoxReason(boxes)).map((tool) => (keyOf(tool.name) ? { ...tool, key: keyOf(tool.name) } : tool)),
    /** How this server holds its secrets (secrets.ts, the launcher), and what that does not cover. */
    secrets: {
      names: [...SECRET_NAMES],
      handoff: "pipe",
      condition: "Started by its launcher (the package's agentrun-serve, the image's entrypoint), the server takes each secret named here over a pipe and holds it in memory only, and every run's process gets all of them but the server's own token and seal key, and a tool key only when its revision names a tool the key unlocks, over a pipe of its own, whatever its harness: none of them is in any process's environment or command line. The launcher runs before any run's process exists; the image starts it as PID 1. Started another way (node dist/cli.js), the server reads them from its environment, where a process of its user can read them.",
      limit: "In memory is not out of reach: a process of the same user can read another's memory (/proc/<pid>/mem) where the kernel lets it attach. Linux's Yama ptrace_scope of 1 or more refuses that to all but a process's own ancestors; a host at 0 exposes the secrets to a run's own code. A run's process holds its model keys in memory, since it calls the model itself. A harness's CLI (codex, claude-agent) holds a key of its own for its session's model proxy in its environment: not a provider's key, but one a process of the same user could spend through that run's proxy while the session lives. Started as the package's bin on a host, until it execs, the launcher and any subshell it forks show the caller's environment, secrets included, to a process of the same user (/proc keeps a process's environment as it was at its exec). A run's process gets its secrets over a socket, read and closed as it starts; another process can take a socket only through pidfd_getfd, which the same ptrace rule refuses.",
    },
    /** What a workflow revision's run gets: each model node runs on the model of its tier (`models.fast`,
     *  `models.default`, `models.strong`) with the tools it names of `node_tools`; a node that names no thinking level
     *  thinks at the run's effort, or medium. */
    workflows: { nodes: [...MODEL_NODES], node_tools: [...NODE_TOOLS], adapters: [...WORKFLOW_ADAPTERS, ...(decisionsOf(env).some((offer) => offer.available) ? [DECISION_ADAPTER] : [])], decisions: { providers: decisionsOf(env) } },
    /** Each agent's home (its files under `/agents/{id}/home/files`): on this server's disk, the paths in it only the host
     *  writes, and the largest file a PUT takes (`limits.max_body_bytes`). */
    home: { disk: "local", host_owned: [...HOME_HOST_OWNED], max_file_bytes: MAX_BODY, writes: writesHeld() },
    features: {
      agents: { create: true, list: true, update: true, revisions: true },
      /** This server's own routes, outside the contract: an archived agent or run is hidden from the lists (`?archived=true`
       *  lists only those) and kept, with its history; a run of an archived agent is refused. */
      archive: { agents: true, runs: true, list_param: "archived", routes: ["POST /agents/{id}/archive", "POST /agents/{id}/unarchive", "POST /runs/{id}/archive", "POST /runs/{id}/unarchive"] },
      home: { export: false, import: false, check: false },
      runs: { stop: true, cancel: true, kill: false, list: true, kinds: ["agentic", "workflow"], pause_workflow_runs: true, graph: true },
      messages: { steer: true, answer: true, follow_up: true, steer_workflow_runs: false },
      timeline: { long_poll: true, sse: true, live_rows: true, live_workflow_rows: false },
      files: { upload: true, read: true, range: false, during_run: true },
      quotes: false,
      usage: { basis: "estimate", meters: ["tokens", "tools", "learning"] },
      efforts: [...EFFORTS],
      thinking: [...THINKING_LEVELS],
      browser: "none",
      /** A tool setting's `permission` (definition.tool_settings, /v2/settings/tools): false until the tool gate lands,
       *  and a save that names one is refused. */
      tool_permissions: false,
      sign_ins: false,
      vault: false,
      query: false,
      /** GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept sealed under the launcher's seal key
       *  (tool-keys.ts); with none handed over, nothing is kept, never in the clear. */
      tool_keys: { routes: true, at_rest: sealKeyOf(env[SEAL_KEY_ENV]) ? "sealed" : "unavailable" },
      /** This server's learning switch (`--learning`): on, a run learns when its agent says `learning: true`; off, none does. */
      learning,
      /** /settings/webhook: one URL POSTed, signed by the Standard Webhooks spec, when a run needs its person and when it
       *  ends (webhooks.ts); its secret kept sealed under the same seal key, so with none no webhook is set. */
      webhooks: { routes: true, events: [...WEBHOOK_EVENTS], signing: "standard-webhooks/v1", at_rest: sealKeyOf(env[SEAL_KEY_ENV]) ? "sealed" : "unavailable" },
    },
    regions: [{ id: "local", jurisdiction: null, state: "live" }],
    /** This server's own: where its OpenAPI document is, beside this one. */
    links: { openapi: "/v2/openapi.json" },
    limits: {
      max_body_bytes: MAX_BODY,
      max_upload_bytes: MAX_UPLOAD_BYTES,
      max_files_per_run: MAX_FILES_PER_RUN,
      max_message_chars: MAX_MESSAGE,
      // pi's: the smallest run, so the most at once. A heavier harness fits fewer (harnesses[].max_concurrent_runs).
      max_concurrent_runs: Math.min(maxRuns, runsThatFit(DEFAULT_HARNESS, memory)),
      timeline_max_wait_ms: MAX_WAIT_MS,
      timeline_page_rows: PAGE_ROWS,
      idempotency_ttl_s: IDEMPOTENCY_TTL_S,
      input_wait_s: null,
      max_cost_usd: null,
    },
  };
}

function cursorOf(value: string | null): number {
  if (value === null) return 0;
  const offset = Number(Buffer.from(value, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError("bad_request", "cursor is not one this server gave");
  return offset;
}
const nextCursor = (offset: number, total: number) => (offset < total ? Buffer.from(String(offset)).toString("base64url") : null);
function limitOf(value: string | null): number {
  if (value === null) return 20;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 100) throw new ApiError("bad_request", "limit is an integer from 1 to 100");
  return n;
}
function integerParam(value: string | null, name: string, max: number): number {
  if (value === null) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new ApiError("bad_request", `${name} is an integer from 0 to ${max}`);
  return Number(value);
}

/** The agent homes 0.1.0-beta.26 and earlier kept in the data directory (`<data>/<agent>/agent.sqlite`, an agent named
 *  `runs` or a symlinked home included), which this version's store does not read: their agents and runs would not
 *  show. This version keeps no `agent.sqlite` under the data directory. */
async function oldHomes(data: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(data)) {
    const file = join(data, name, "agent.sqlite");
    if (await stat(file).then((info) => info.isFile(), () => false)) found.push(file);
  }
  return found.sort();
}

export async function startServe(options: ServeOptions): Promise<Serve> {
  await mkdir(resolve(options.data), { recursive: true, mode: 0o700 });
  // Canonical once, here: a box's mount source below it must then be its own canonical path, through no link (run-box.ts).
  const data = await realpath(resolve(options.data));
  // What only reads and refuses comes first: a start refused for it creates nothing in the data root, server.lock included.
  const homes = await oldHomes(data);
  if (homes.length) {
    const named = homes.length > 5 ? [...homes.slice(0, 5), `and ${homes.length - 5} more`] : homes;
    throw new Error(`this data directory holds agent homes from AgentRun Server 0.1.0-beta.26 or earlier (${named.join(", ")}), which this version does not read: started here, it would show none of their agents or runs. Keep them with the earlier version, or move those directories out of ${data} to start this one; see "Upgrading from 0.1.0-beta.26" in the serve README.`);
  }
  if (options.token !== undefined && (options.token.length < 32 || /\s/.test(options.token))) throw new Error("the token must be 32 characters or more, with no whitespace");
  if (options.drainTimeout !== undefined && durationMs(options.drainTimeout) === undefined) throw new Error(`the drain timeout ${options.drainTimeout} is not a duration such as 8s`);
  enabledBoxes(process.env);
  const maxRuns = maxRunsOf(process.env, options.maxRuns);
  const learning = learningOf(process.env, options.learning);
  const learningBudget = learningBudgetOf(process.env, options.learningBudget);
  const minFreeMib = process.env.AGENTRUN_MIN_FREE_MB ? Number(process.env.AGENTRUN_MIN_FREE_MB) : MIN_FREE_MIB;
  if (!(Number.isFinite(minFreeMib) && minFreeMib >= 0)) throw new Error("AGENTRUN_MIN_FREE_MB is a number of MiB, 0 or more");
  const minFreeBytes = options.minFreeBytes ?? minFreeMib * 2 ** 20;
  // Then one server per data root, before anything writes it: a refused second server writes no token, opens no store,
  // adopts or sweeps no run, binds no port and prints no address (server-lock.ts). A failed start releases the lock and
  // leaves the file, which the next server reuses: unlinking it would race a server that opens it meanwhile. A server
  // that is stopping (its runs' processes still drain) is waited for, up to the time its mark gives, not refused.
  const lock = await takeServerLockAfterStop(data, {
    waiting: ({ pid, until }) => noticeOf(options)(`the server on this data root (pid ${pid}) is stopping; waiting for it, up to ${seconds(until - Date.now())}`),
  });
  // What a start that fails stops before the lock goes: the webhook deliveries it began, which would write the next
  // server's outbox.
  const stops: Array<() => Promise<void>> = [];
  try {
    // The server's record, which its stop rewrites in place (server-lock.ts): made now, so the stop makes nothing.
    markRunning(data);
    return await startHolding(options, data, lock, { maxRuns, minFreeBytes, learning, learningBudget }, stops);
  } catch (error) {
    for (const stop of stops) await stop().catch(() => undefined);
    lock.release();
    throw error;
  }
}

async function startHolding(options: ServeOptions, data: string, lock: ServerLock, checked: { maxRuns: number; minFreeBytes: number; learning: LearningMode; learningBudget: number }, stops: Array<() => Promise<void>>): Promise<Serve> {
  const { maxRuns, minFreeBytes, learning, learningBudget } = checked;
  const tokenFile = options.token === undefined ? join(data, TOKEN_FILE) : null;
  const stored = options.token === undefined ? await tokenIn(tokenFile!) : undefined;
  const token = options.token ?? stored!.token;
  const doorTokenFile = join(data, DOOR_TOKEN_FILE);
  const { token: doorToken } = await tokenIn(doorTokenFile);
  const log = options.log;
  const quiet = process.env.AGENTRUN_LOG === "quiet";
  const authFailed = (route: string, reason: string) => log?.(logLine("auth_failed", { route, reason }));
  /** The host's secrets as a run's notes are checked against (learning-run.ts), and the keys a person saved on this
   *  server (storedKeys, below), read at each call: a person's note, and every learning text read. */
  const learningSecrets = () => [...hostSecrets(process.env, storedKeys), token, doorToken];
  const base = { ...withoutFaux(process.env), [DATA_ENV]: data, ...(options.allowCodeNodes ? { [CODE_NODES_ENV]: "1" } : {}), ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}), ...(options.fauxHarness ? { [FAUX_HARNESS_ENV]: resolve(options.fauxHarness) } : {}) };
  // Which fields are the server's is read from what it is started with alone: handed the saved keys too, ToolKeys would
  // call each the server's, and none could be deleted.
  const toolKeys = new ToolKeys(data, withSecrets(base, "own"), (fields) => (log ? log(logLine("tool_keys", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("tool_keys", fields)}\n`)));
  // A key's check as it is saved (key-check.ts) goes to its provider; under faux only to the tests' fake for that provider,
  // the one its runs are given (monid, Parallel, TypeSafe's Jev), never to the network: one with no fake is not checked.
  const fakes: Record<string, string | undefined> = { monid: options.fauxMonid, parallel: options.fauxParallel, typesafe: options.fauxJev };
  const checkFetch = async (id: string): Promise<typeof fetch | undefined> => {
    if (!options.faux) return fetch;
    const fake = fakes[id];
    return fake ? ((await import(pathToFileURL(resolve(fake)).href)) as { default: typeof fetch }).default : undefined;
  };
  // Aborted as close() begins: a key's check still waiting on its provider stops waiting, and its save stores nothing.
  const stopping = new AbortController();
  // This server's saved keys, read by name: handed to its own reading and its own runs, never shared with another server.
  const storedKeys: StoredKeys = (name) => toolKeys.value(name);
  // A stored key that does not open is said once at the start, never a refusal to start.
  toolKeys.view();
  // The server's tool settings, beside the agent store: capabilities say what they resolve to, again after a PUT.
  const settings = new ToolSettings(data);
  // The server's reading, in parts: `env`, its environment with its secrets, saved keys among them (storedKeys);
  // `offers`, what each harness offers, probed from env without the tool keys (offersEnvOf), the one slow part (each
  // CLI's package and pins, codex's binary hashed); and `caps`, the capabilities document made from both under the tool
  // settings and the box offers. A write remakes only the parts it changes, before it answers: a PUT of the tool
  // settings, caps; a save or delete of a key, env and caps, and the offers only when what they are made from changed,
  // which no tool key is. So a write answers at once, and capabilities, save checks and run checks after it see it, with
  // no restart and no request opening the file. The offers are probed once saved keys are read (below), at the start.
  let env = withSecrets(base, "all", storedKeys);
  let offers!: HarnessCapability[];
  let caps!: ReturnType<typeof capabilitiesWith>;
  // Whether a revision that names no model runs (needsOf): made from env alone, so remade with it, before the caps.
  let needs: ModelNeeds | null = await needsOf(env);
  // The box offers are probed once, below, before the first reading is made.
  const recompose = () => void (caps = capabilitiesWith(env, maxRuns, offers, learning, needs, settings.get(), boxOffers, options.gradeModel));
  // What the offers held now were made from (offersInputs), and the latest probe: one a later probe overtook is dropped.
  let offersFrom: readonly (string | undefined)[] | undefined;
  let probes = 0;
  const probe = async (why: string) => {
    const mine = ++probes;
    const from = offersInputs(env);
    const started = performance.now();
    const next = await harnessOffers(offersEnvOf(env));
    log?.(logLine("harness_offers", { why, ms: Math.round(performance.now() - started) }));
    if (mine !== probes) return;
    [offers, offersFrom] = [next, from];
    recompose();
  };
  /** After a save or delete of a key, the one writer of its file: env again, then what reads it. Writes can overlap
   *  (needsOf may wait, and another write lands meanwhile): the latest write's `needs` stands, an earlier one's that
   *  finishes after it is dropped. */
  let needsAsked = 0;
  const keysChanged = async () => {
    // A run's learning, as its view, a list and its timeline row show it, is cut of the keys saved now (runs.ts).
    runs.keysChanged();
    env = withSecrets(base, "all", storedKeys);
    const mine = ++needsAsked;
    const next = await needsOf(env);
    if (mine === needsAsked) needs = next;
    const inputs = offersInputs(env);
    if (offersFrom && inputs.length === offersFrom.length && inputs.every((value, i) => value === offersFrom![i])) recompose();
    else await probe("key");
  };
  // The boxes AGENTRUN_BOXES lists, each probed once (boxes.ts); runs execute in Docker's (place.ts). Under --faux, a faux
  // box stands in for Docker, and nothing asks Docker.
  const boxes = await boxRegistry(env);
  const fauxBox = options.faux && options.fauxBox ? await fauxBoxes(resolve(options.fauxBox), data) : undefined;
  const boxOffers: BoxOffer[] = boxes.offers().map((offer) => (fauxBox && offer.id === "docker" ? { id: "docker", available: true, reason: "a faux box (tests)" } : offer));
  const runBoxes = fauxBox ?? boxes.provider("docker");
  // Daytona's boxes are made, seeded, pulled and destroyed here, with the key this server holds; a run's process reaches
  // its own through the relay below, which holds the key for it (box-relay.ts).
  const remoteBoxes = boxes.provider("daytona");
  log?.(logLine("boxes", boxesLog(boxOffers, enabledBoxes(env))));
  const openapi = openapiDocument((operationId) => ROUTES.find((r) => r.name === operationId)?.capability);
  const agents = new Agents(data);
  const webhooks = new Webhooks(data, env, (fields) => (log ? log(logLine("webhook", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("webhook", fields)}\n`)), options.webhookRetryMs);
  stops.push(() => webhooks.close());
  const uploads = new Uploads(join(data, UPLOADS_DIR));
  // Under the data directory's lock and before this server answers anything, so no PUT of its own is in flight: an upload
  // temp file found now is a crashed one's.
  const swept = await uploads.sweep();
  if (swept > 0) log?.(logLine("uploads_swept", { removed: swept }));
  const documents = options.documents ?? process.env[DOCUMENTS_ENV];
  if (documents !== undefined && !(await stat(documents).then((info) => info.isDirectory(), () => false))) throw new Error(`the documents directory ${documents} is not a directory`);
  const runs = new Runs({ agents, token, storedKeys, doorTokenFile, doorToken, learning, learningBudget, ...(documents ? { documents: resolve(documents) } : {}), fauxEnv: fauxEnvOf(options), toolSettings: () => settings.get(), ...(runBoxes ? { runBoxes } : {}), ...(remoteBoxes ? { remoteBoxes } : {}), ...(remoteBoxes && daytonaApi(env) ? { remoteApi: daytonaApi(env)! } : {}), ...(options.drainTimeout ? { drainTimeout: options.drainTimeout } : {}), ...(options.carryBackRetry ? { carryBackRetry: options.carryBackRetry } : {}), maxRuns, ...(options.box ? { box: { host: options.box, quarantine: await Quarantine.open(join(data, BOX_QUARANTINE)) } } : {}), ...(options.settleRetryMs ? { settleRetryMs: options.settleRetryMs } : {}), ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}), ...(options.reflectTimeoutMs ? { reflectTimeoutMs: options.reflectTimeoutMs } : {}), ...(options.gradeTimeoutMs ? { gradeTimeoutMs: options.gradeTimeoutMs } : {}), ...(options.gradeModel ? { gradeModel: options.gradeModel } : {}), ...(log ? { log: (event: string, fields: Record<string, string | number>) => log(logLine(event, fields)) } : {}), notify: (event, run, marker) => webhooks.emit(event, run, marker) });
  const daytona = daytonaApi(env);
  const relay = remoteBoxes && daytona ? await startBoxRelay({ root: data, tokenOf: (id) => runs.relayToken(id), ...daytona, serves: (id) => runs.servesBox(id), ensure: (id) => runs.ensureBox(id) }) : undefined;
  if (relay) stops.push(() => relay.close());
  const expected = digest(`Bearer ${token}`);
  if (options.beforeAbort) runs.beforeAbort = options.beforeAbort;
  // Answered keys are kept in the data directory for the retention capabilities state, and written before the answer
  // is sent, so a client that retries after a restart gets the first answer back.
  type Kept = { fingerprint: string; at: number; answer?: { status: number; body: unknown; headers: Record<string, string> } };
  const keptFile = join(data, IDEMPOTENCY_FILE);
  const kept = JSON.parse(await readFile(keptFile, "utf8").catch(() => "null")) as { entries?: [string, Kept][] } | null;
  const idempotency = new Map<string, Kept>((kept?.entries ?? []).filter(([, v]) => v?.answer && Date.now() - v.at <= IDEMPOTENCY_TTL_S * 1000));
  // A failed save rejects only its own caller: the next save starts from a settled chain and writes every kept key.
  let saving: Promise<void> = Promise.resolve();
  const keep = () =>
    (saving = saving
      .catch(() => undefined)
      .then(async () => {
        const entries = [...idempotency].filter(([, v]) => v.answer);
        await writeFile(`${keptFile}.partial`, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
        await rename(`${keptFile}.partial`, keptFile);
      }));
  const host = options.host ?? "127.0.0.1";
  const owner = options.accounts ? new Owner(data, options.openSetup === true, (line) => void process.stdout.write(`${line}\n`), options.signInAddresses) : undefined;
  // A saved key is read by name from here, past the checks that refuse a start and before any run (a recovered one too)
  // is launched: each launch hands over what is saved then. One server in a process reads them: the last started.
  await probe("start");
  // Decided once, by the probe the confinement walks by: capabilities.home.writes says what PUT and DELETE do.
  const homeWrites = caps.home.writes;
  // Runs an earlier server left: supervised again, carried back when they already ended, or opened again. Then, however
  // that went, the webhook's ledger against the agent store: waits of runs ended or gone dropped, and each end it lacks
  // queued. Each is its own step: a recovery that gives up (a store busy past its wait) still lets the catch-up run, and a
  // step that gives up is said, the next start trying it again.
  void runs
    .recover()
    .catch((error: Error) => void process.stderr.write(`agentrun-serve: recovery: ${error.message}\n`))
    .then(async () => {
      const rows = (await agents.request(() => agents.store.listRuns())).filter((row) => !row.importedFrom);
      const byId = new Map(rows.map((row) => [row.id, row]));
      // An end's notice from its row and its serve.json alone, as the run list reads an ended run (summaryOfRow): never
      // its own store, whose read can fail, so a busy store loses no end. The same body a live end's notice has.
      await webhooks.catchUp(rows, async (id) => {
        const row = byId.get(id);
        if (!row) return null;
        const meta = await readJson(join(agents.dir, "runs", id, RUN_META));
        return { run_id: id, agent_id: row.agent, status: await runs.statusOfRow(row), title: isObject(meta) && typeof meta.title === "string" ? meta.title : "" };
      });
    })
    .catch((error: Error) => void process.stderr.write(`agentrun-serve: the webhook's catch-up: ${error.message}\n`));

  // Setup's import of this machine's sessions: offered by a server on this machine only (no public address, listening
  // on loopback), counted once (a listing, no transcript kept), run once, each on a worker thread (import-worker.ts) so
  // a busy store's wait and the sessions' parsing never hold up a request.
  const offersImport = options.openSetup === true && options.publicUrl === undefined && isLoopback(host);
  let closing = false;
  const workers = new Map<Worker, { task: ImportTask["task"]; exit: Promise<unknown> }>();
  // Once the server closes, no worker starts: a setup still being answered then leaves its yes for the next start.
  const onWorker = (task: ImportTask["task"]): Promise<ImportAnswer> =>
    closing ? Promise.resolve({ stopped: true }) : new Promise((answered, failed) => {
      const worker = new Worker(new URL("./import-worker.js", import.meta.url), {
        // The secrets this process holds (secrets.ts keeps them out of every environment, so the worker's has none), and
        // the keys saved on its Tool keys page, opened now (each cut too, the same rule as the CLI's import: a saved key
        // and the server's own of the same name may differ), in the worker's memory alone: what the import cuts out of
        // everything it writes.
        workerData: { task, data, home: options.sessionsHome?.home ?? homedir(), ...(options.sessionsHome?.temp ? { temp: options.sessionsHome.temp } : {}), secrets: Object.fromEntries(SECRET_NAMES.flatMap((name) => { const value = secret(name); return value === undefined ? [] : [[name, value]]; })), stored: toolKeys.values() } satisfies ImportTask,
        // Started from a string (its launcher runs node --input-type=module -e), the server's flags are given again
        // without that string and its type: a worker started from a file with them is refused. Otherwise the worker
        // inherits them as Node passes them on, which leaves out the flags a worker may not take (on Node 24 a test
        // runner's child holds many).
        ...(process.execArgv.some((arg) => arg.startsWith("--input-type")) ? { execArgv: workerArgs(process.execArgv) } : {}),
      });
      workers.set(worker, { task, exit: once(worker, "exit").catch(() => undefined) });
      let answer: ImportAnswer | undefined;
      worker.on("message", (message: ImportAnswer) => void (answer = message));
      worker.once("error", failed);
      worker.once("exit", (code) => {
        workers.delete(worker);
        if (answer) answered(answer);
        else failed(new Error(`the import's worker ended (${code}) with no answer`));
      });
    });
  // The count of what setup would import: started once (at start, or by the page's first read), read as it stands. One
  // stopped (by close, or by setup) starts again on the next read; one that failed stays failed.
  let count: { state: "counting" } | { state: "counted"; projects: number; sessions: number } | { state: "failed" } | undefined;
  const countSessions = () => {
    if (count) return;
    count = { state: "counting" };
    onWorker("plan").then(
      (answer) => void (count = "sessions" in answer ? { state: "counted", projects: answer.projects, sessions: answer.sessions } : undefined),
      (error: unknown) => {
        count = { state: "failed" };
        process.stderr.write(`agentrun-serve: the count of this machine's sessions failed: ${(error as Error).message}\n`);
      },
    );
  };
  const stopCount = () => { for (const [worker, { task }] of workers) if (task === "plan") worker.postMessage("stop"); };
  // The owner's yes, kept until the import ends: a server stopped (or killed) mid-import goes on with it at its next start.
  const importAsked = join(data, IMPORT_ASKED);
  let importing: Promise<void> | undefined;
  /** The import at setup as the owner's console reads it: running, done with what it took, or stopped (the next start
   *  goes on with it). */
  let importState: { state: "running" } | { state: "done"; agents: number; runs: number; skipped: number } | { state: "stopped" } | undefined;
  /** Never rejects: whatever stops it (the store held past its wait, a file) is said on stderr, and the server goes on. */
  const importAtSetup = () =>
    (importing ??= (async () => {
      importState = { state: "running" };
      try {
        const answer = await onWorker("import");
        if (!("took" in answer)) return void (importState = { state: "stopped" });
        // The whole import, every start's part of it: what earlier starts took is kept with the owner's yes.
        // The yes as setup wrote it is empty: no earlier start took anything.
        const before = (await readJson(importAsked)) as { agents?: unknown; runs?: unknown } | null;
        const agents = [...new Set([...(Array.isArray(before?.agents) ? before.agents.filter((id): id is string => typeof id === "string") : []), ...answer.took.agents])];
        const runs = (typeof before?.runs === "number" ? before.runs : 0) + answer.took.runs;
        if (answer.stopped) {
          await writeDurable(importAsked, JSON.stringify({ agents, runs }));
          return void (importState = { state: "stopped" });
        }
        await rm(importAsked, { force: true });
        const took = { agents: agents.length, runs, skipped: answer.took.skipped };
        importState = { state: "done", ...took };
        process.stdout.write(`${logLine("import", took)}\n`);
      } catch (error) {
        importState = { state: "stopped" };
        if (!closing) process.stderr.write(`agentrun-serve: the import at setup stopped (the next start goes on with it): ${(error as Error).message}\n`);
      }
    })());

  // ---- helpers --------------------------------------------------------------------------------------------------------

  /** The body's bytes, at most MAX_BODY of them. */
  async function bytesOf(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    // An oversized body is read to its end before the refusal, so the client gets the answer and not a reset.
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= MAX_BODY) chunks.push(chunk as Buffer);
    }
    if (size > MAX_BODY) throw new ApiError("payload_too_large", `the body is over ${MAX_BODY} bytes`, { details: { limit: "max_body_bytes" } });
    return Buffer.concat(chunks);
  }

  async function bodyOf(req: IncomingMessage): Promise<Json> {
    const type = String(req.headers["content-type"] ?? "");
    if (!type.startsWith("application/json")) throw new ApiError("unsupported_media_type", "the body must be application/json");
    const bytes = await bytesOf(req);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8") || "null");
    } catch {
      throw new ApiError("bad_request", "the body is not JSON");
    }
    if (!isObject(value)) throw new ApiError("bad_request", "the body is not a JSON object");
    return value;
  }

  async function needAgent(id: string): Promise<AgentEntry> {
    const entry = ID.test(id) ? await agents.get(id) : null;
    if (!entry) throw new ApiError("not_found", `no agent ${id}`);
    return entry;
  }
  async function needRun(id: string): Promise<Run> {
    const run = ID.test(id) ? await runs.get(id) : null;
    if (!run) throw new ApiError("not_found", `no run ${id}`);
    return run;
  }

  /** Replays the first answer to a create with the same key and body; another body is a mismatch. */
  async function idempotent(req: IncomingMessage, path: string, body: Json, work: () => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>) {
    const key = req.headers["idempotency-key"];
    if (key === undefined) return work();
    if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new ApiError("bad_request", "Idempotency-Key is 1 to 255 characters");
    const slot = `${path}\n${key}`;
    const fingerprint = stable(body);
    const now = Date.now();
    for (const [k, v] of idempotency) if (now - v.at > IDEMPOTENCY_TTL_S * 1000) idempotency.delete(k);
    const known = idempotency.get(slot);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new ApiError("idempotency_mismatch", "this Idempotency-Key was used with another body");
      if (!known.answer) throw new ApiError("idempotency_in_progress", "the first request with this Idempotency-Key is still in flight", { retry_after_ms: 500 });
      return { ...known.answer, headers: { ...known.answer.headers, "idempotent-replayed": "true" } };
    }
    idempotency.set(slot, { fingerprint, at: now });
    let answer: { status: number; body: unknown; headers?: Record<string, string> };
    try {
      answer = await work();
    } catch (error) {
      idempotency.delete(slot);
      throw error;
    }
    // The work happened, so the key keeps its answer in memory even when the file write fails: a retry replays it
    // instead of doing the work twice. Only a restart before the next good save loses it.
    idempotency.set(slot, { fingerprint, at: now, answer: { status: answer.status, body: answer.body, headers: answer.headers ?? {} } });
    await keep().catch((error: Error) => void process.stderr.write(`agentrun-serve: idempotency save: ${error.message}\n`));
    return answer;
  }

  // ---- runs -----------------------------------------------------------------------------------------------------------

  /** A workflow revision's shape as runnable.ts checks it: its workflow, tools, harness, place and tool settings. */
  const workflowShape = ({ workflow, tools, harness, place, toolSettings }: { workflow: unknown; tools?: readonly string[]; harness?: string; place?: RevisionShape["place"]; toolSettings?: RevisionShape["toolSettings"] }): RevisionShape => ({ kind: "workflow", workflow, tools: tools ?? [], ...(harness ? { harness } : {}), ...(place ? { place } : {}), ...(toolSettings ? { toolSettings } : {}) });
  const shapeOf = (revision: Revision): RevisionShape => (revision.kind === "agentic" ? { kind: "agentic", ...revision.body } : workflowShape(revision.body));

  /** What keeps `revision` from running here at `place` (its own, else this host's default), checked before anything
   *  starts with the checks a save makes (runnable.ts): one a save refused, or one a setting of this host fixes that it
   *  does not have yet. `capped`: the run has a spend cap, which a web tool's resolution reads (tool-plane.ts). */
  async function runnable(revision: Revision, place: Place, { capped = false }: { capped?: boolean } = {}): Promise<void> {
    const shape = { ...shapeOf(revision), place };
    const blockers = await blockersOf(env, shape, settings.get(), { capped, boxes: boxOffers, offers });
    if (!blockers.length) return;
    const message = blockers.map((b) => b.message).join(" ");
    const unbound = blockers.flatMap((b) => (b.tool ? [b.tool] : []));
    const missing = Object.fromEntries(blockers.flatMap((b) => (b.missing ? [[b.missing.tool, b.missing.vars]] : [])));
    const harness = blockers.find((b) => b.harness)?.harness;
    const box = blockers.find((b) => b.box)?.box;
    const named = { ...(harness ? { harness } : {}), ...(box ? { box } : {}) };
    if (revision.kind === "agentic") throw new ApiError("agent_not_runnable", message, { details: { unbound, missing, ...named } });
    const tier = blockers.find((b) => b.tier)?.tier;
    const decisions = Object.fromEntries(blockers.flatMap((b) => (b.decision ? [[b.decision.provider, { reason: b.reason, needs: b.decision.needs }]] : [])));
    throw new ApiError("agent_not_runnable", message, { details: { adapters: [...new Set(blockers.flatMap((b) => (b.adapter ? [b.adapter] : [])))], unbound, missing, code: blockers.some((b) => b.codeNodes || b.shell), ...(tier ? { tier } : {}), ...(Object.keys(decisions).length ? { decisions } : {}), ...named } });
  }

  /** A definition being saved: refused (422 by field) when it can never run here; else what this host still lacks. */
  async function saveable(revision: NewRevision): Promise<InputIssue[]> {
    const blockers = await blockersOf(env, revision.kind === "agentic" ? revision : workflowShape(revision), settings.get(), { boxes: boxOffers, offers });
    const never = blockers.filter((b) => !b.host);
    if (never.length) throw invalid(never.map(issueOf));
    return blockers.map(issueOf);
  }

  /** A run's input: an agentic run's `{content: string}`, a workflow run's what its workflow's input schema takes. */
  async function inputIssuesOf(revision: Revision, input: Json) {
    if (revision.kind === "agentic") return inputIssues(input, DEFAULT_INPUT_SCHEMA as Json);
    const { validateWorkflow } = await import("@parcha/agentrun-dsl");
    const checked = validateWorkflow(revision.body.workflow, { executeCode: false, input });
    return checked.ok ? [] : checked.issues.map((i) => ({ field: `input${i.path ? ` at ${i.path}` : ""}`, reason: "invalid", message: `the workflow does not take this input: ${i.code}${i.path ? ` at ${i.path}` : ""}` }));
  }

  async function createRun(req: IncomingMessage, agentId: string) {
    const entry = await needAgent(agentId);
    if (entry.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${agentId} is archived: unarchive it to run it.`, { details: { archived_at: entry.agent.archivedAt } });
    const body = await bodyOf(req);
    return idempotent(req, `/agents/${agentId}/runs`, body, async () => {
      const issues = unknownFields(body, ["input", "revision", "file_ids", "effort", "max_cost_usd", "quote_id"]);
      if (!isObject(body.input)) issues.push({ field: "input", reason: body.input === undefined ? "missing" : "wrong_type", message: "input is an object" });
      if (body.revision !== undefined && (typeof body.revision !== "string" || !ID.test(body.revision))) issues.push({ field: "revision", reason: "wrong_type", message: "revision is a revision id of this agent" });
      if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) issues.push({ field: "effort", reason: "not_an_option", message: `effort is one of ${EFFORTS.join(", ")}` });
      if (body.max_cost_usd !== undefined && !(typeof body.max_cost_usd === "number" && body.max_cost_usd > 0)) issues.push({ field: "max_cost_usd", reason: "wrong_type", message: "max_cost_usd is a number above 0" });
      if (body.file_ids !== undefined && !Array.isArray(body.file_ids)) issues.push({ field: "file_ids", reason: "wrong_type", message: "file_ids is a list of file ids" });
      if (issues.length) throw invalid(issues);
      if (body.quote_id !== undefined) throw unsupported("quotes", "This server has no billing, so it takes no quotes.");
      // Each a ready file, before anything starts: copied into the run's work/inputs/ once its directory is made.
      const files = Array.isArray(body.file_ids) ? await uploads.readyFiles(body.file_ids) : [];
      const pinned = typeof body.revision === "string" ? await agents.revision(entry.agent.id, body.revision) : entry.revision && { revision: entry.revision, version: entry.version };
      if (!pinned) throw invalid([{ field: "revision", reason: "not_an_option", message: typeof body.revision === "string" ? `${body.revision} is not a revision of the agent ${entry.agent.id}` : `the agent ${entry.agent.id} has no current revision` }]);
      const { revision, version } = pinned;
      if (revision.kind === "workflow" && body.max_cost_usd !== undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "A workflow run's spend is not capped here: its cost shows once it ends." }]);
      const input = body.input as Json;
      const wrong = await inputIssuesOf(revision, input);
      if (wrong.length) throw invalid(wrong);
      const place = resolvePlace(revision.body.place as Place | undefined);
      await runnable(revision, place, { capped: body.max_cost_usd !== undefined });
      const title = revision.kind === "workflow" ? workflowTitle(entry.agent.name || entry.agent.id, input) : typeof input.content === "string" ? input.content : (Object.values(input).find((v): v is string => typeof v === "string") ?? JSON.stringify(input));
      const run = await runs.create(entry, revision, version, { input, title, place, ...(typeof body.effort === "string" ? { effort: body.effort } : {}), ...(typeof body.max_cost_usd === "number" ? { maxCostUsd: body.max_cost_usd } : {}), ...(files.length ? { inputs: (work: string) => uploads.copyInto(work, files) } : {}) });
      // Its view from the run itself: it is written, with its first message, so an answer read from the store, which a
      // busy store would turn into home_busy, would refuse a run that runs, and a retry would start a second one.
      return { status: 202, body: await runs.view(run, { stored: null }), headers: { location: `/v2/runs/${run.id}` } };
    });
  }

  /** A page of runs from the store, newest first: `agent`, `revision` and `status` narrow it. */
  /** A list's `archived`: true lists only what is archived, false (the default) only what is not. */
  function archivedParam(url: URL): boolean {
    const value = url.searchParams.get("archived");
    if (value !== null && value !== "true" && value !== "false") throw new ApiError("bad_request", "archived is true or false");
    return value === "true";
  }

  async function runsPage(url: URL, filter: { agent?: string; revision?: string }) {
    const limit = limitOf(url.searchParams.get("limit"));
    const offset = cursorOf(url.searchParams.get("cursor"));
    const status = url.searchParams.get("status");
    if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request", `status is one of ${STATUSES.join(", ")}`);
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && !ID.test(value)) throw new ApiError("bad_request", `${key} is an id`);
    const archived = archivedParam(url);
    let rows = (await agents.request(() => agents.store.listRuns(filter))).filter((row) => Boolean(row.archivedAt) === archived);
    if (status !== null) {
      const statuses = await Promise.all(rows.map((row) => runs.statusOfRow(row)));
      rows = rows.filter((_, i) => statuses[i] === (status as Status));
    }
    const versions = new Map<string, number>();
    for (const agent of new Set(rows.slice(offset, offset + limit).map((row) => row.agent))) for (const r of await agents.revisions(agent)) versions.set(r.id, r.version);
    const page = await Promise.all(rows.slice(offset, offset + limit).map((row) => runs.summaryOfRow(row, versions)));
    return { runs: page, next_cursor: nextCursor(offset + limit, rows.length) };
  }

  async function timeline(req: IncomingMessage, res: ServerResponse, url: URL, run: Run): Promise<void> {
    const after = integerParam(url.searchParams.get("after"), "after", Number.MAX_SAFE_INTEGER);
    const waitMs = integerParam(url.searchParams.get("wait_ms"), "wait_ms", MAX_WAIT_MS);
    // This server's own: a page of at most `limit` rows, for a client that reads a little at a time (the MCP tool's).
    const asked = url.searchParams.get("limit");
    if (asked !== null && !(/^\d+$/.test(asked) && Number(asked) >= 1 && Number(asked) <= PAGE_ROWS)) throw new ApiError("bad_request", `limit is an integer from 1 to ${PAGE_ROWS}`);
    const limit = asked === null ? PAGE_ROWS : Number(asked);
    const pageOf = async (from: number, wait: number) => {
      const page = await runs.page(run, from, wait, limit);
      return { run_id: run.id, status: page.status, state: page.state, reset: page.reset, rows: page.rows, drop: page.drop, next_after: page.next_after, unchanged: page.unchanged, has_more: page.has_more, final: page.final, cost: runs.cost(run) };
    };
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) {
      const page = await pageOf(after, waitMs);
      return send(res, 200, { ...page, poll_after_ms: page.final || page.has_more ? 0 : 1000 });
    }
    const last = req.headers["last-event-id"];
    if (last !== undefined && !/^[0-9]+$/.test(String(last))) throw new ApiError("bad_request", "Last-Event-ID is a change number");
    let cursor = last !== undefined ? Number(last) : after;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-content-type-options": "nosniff" });
    const beat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    let open = true;
    res.once("close", () => void (open = false));
    try {
      for (let first = true; open; first = false) {
        const page = await pageOf(cursor, first ? 0 : 15_000);
        if (!open) break;
        if (first || !page.unchanged || page.final) res.write(`event: rows\nid: ${page.next_after}\ndata: ${JSON.stringify(page)}\n\n`);
        cursor = page.next_after;
        if (page.final && !page.has_more) {
          res.write(`event: end\ndata: ${JSON.stringify({ reason: "terminal" })}\n\n`);
          break;
        }
      }
    } finally {
      clearInterval(beat);
      res.end();
    }
  }

  // ---- files ----------------------------------------------------------------------------------------------------------

  type FileView = { path: string; size_bytes: number; modified_at: string; content_type: string | null; unreadable?: true };
  const fileView = (path: string, st: { size: number; mtimeMs: number }): FileView => ({ path, size_bytes: st.size, modified_at: new Date(st.mtimeMs).toISOString(), content_type: typeOf(path) ?? null });

  /** The files under `base` (a run's work/, an agent's home), through no link (workspace.ts): each regular file's own size
   *  and time, a dot-name left out. `deep` when a directory below WALK_DEPTH was there and not entered. In a `home`, a
   *  host-owned name at its top is the host's: named in `owned`, and nothing below it walked. */
  async function walk(base: string, home = false): Promise<{ files: FileView[]; deep: boolean; owned: string[] }> {
    const out: FileView[] = [];
    const owned: string[] = [];
    let deep = false;
    if (!(await lstat(base).catch(() => null))?.isDirectory()) return { files: out, deep, owned };
    // The directory unreadable as a whole lists nothing; what the walk could not read in it is left out.
    await walkWork(base, (path, st, readable) => {
      if (st.isFile()) out.push({ ...fileView(path, st), ...(readable ? {} : { unreadable: true }) });
      else if (st.isDirectory() && path.split("/").length > WALK_DEPTH) deep = true;
      return out.length <= FILE_LIST_CAP;
    }, {
      skip: (name, path) => {
        if (name.startsWith(".")) return true;
        if (!home || path !== name || !hostOwnedOf(name)) return false;
        owned.push(name);
        return true;
      },
    }).catch((error) => {
      if (!(error instanceof WorkRefused)) throw error;
    });
    return { files: out, deep, owned };
  }

  /** The file `rel` under `root`, raw; `unreadable` says why one this server cannot read is private. */
  async function sendFile(req: IncomingMessage, res: ServerResponse, url: URL, root: string, rel: string, unreadable: string): Promise<void> {
    if (!(await lstat(root).catch(() => null))?.isDirectory()) throw new ApiError("not_found", "no such file");
    // Through no link, held from the open to the last byte (workspace.ts): a name swapped for one is refused, not followed.
    const opened = await openWorkFile(root, rel).catch((error) => {
      if (error instanceof WorkRefused && error.reason === "unreadable") throw new ApiError("system_file_forbidden", `This file was created private by ${unreadable}: this server cannot read it.`, { details: { reason: "unreadable" } });
      return null;
    });
    if (!opened) throw new ApiError("not_found", "no such file");
    const { handle, stats: st } = opened;
    const type = typeOf(rel) ?? "application/octet-stream";
    const download = url.searchParams.get("download") === "1" || !INLINE_TYPES.has(type);
    const name = rel.split("/").at(-1)!.replace(/[^\w.-]/g, "_");
    res.writeHead(200, {
      "content-type": type,
      "content-length": st.size,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...(type.startsWith("text/html") ? { "content-security-policy": FILE_CSP } : {}),
      ...(download ? { "content-disposition": `attachment; filename="${name}"` } : {}),
    });
    if (req.method === "HEAD" || st.size === 0) {
      await handle.close();
      return void res.end();
    }
    await pipeline(handle.createReadStream(), res).catch(() => undefined);
    await handle.close().catch(() => undefined);
  }

  // ---- an agent's home --------------------------------------------------------------------------------------------------

  /** The agent's home, `homes/<its home key>/`: null while nothing was ever written to it, made with homes/ (0700) when
   *  `make`. Neither is ever a link: a read finds no home there, and a write is refused. */
  async function homeDir(agentId: string, make: boolean): Promise<string | null> {
    const home = homeOf(data, agentId);
    for (const dir of [join(data, HOMES_DIR), home]) {
      // One made is synced into its parent, so a write in it that is answered survives a crash of the machine.
      if (make && (await mkdir(dir, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : Promise.reject(error))))) await syncDir(dirname(dir));
      if ((await lstat(dir).catch(() => null))?.isDirectory()) continue;
      if (make) throw new WorkRefused(dir, "link");
      return null;
    }
    return home;
  }

  /** Refused when `rel`'s first segment is, on this disk, the same entry as a host-owned path of the home (home-path.ts):
   *  the name check holds for the spellings it knows, and this for any other a disk takes. */
  async function notHostOwned(home: string, rel: string, agentId: string, write: boolean): Promise<void> {
    const owned = await ownedByIdentity(home, rel);
    if (owned) throw hostOwnedRefusal(owned, agentId, write, ownedReadAt(agentId));
  }

  /** A write to the home or a removal from it refused (workspace.ts), as its answer. */
  function homeRefusal(error: unknown): never {
    if (!(error instanceof WorkRefused)) throw error;
    if (error.reason === "link") throw new ApiError("system_file_forbidden", "A link is on the way to this path, or is the file: this server follows none.", { details: { reason: "link" } });
    if (error.reason === "unreadable") throw new ApiError("system_file_forbidden", "This server may not enter a directory on the way to this path.", { details: { reason: "unreadable" } });
    if (error.reason === "not_regular") throw new ApiError("invalid_file_path", "the path names a directory, or runs through a file");
    if (error.reason === "unheld") throw new ApiError("unsupported_here", HOME_WRITES_OFF);
    throw new ApiError("not_found", "no such file");
  }

  // ---- usage ----------------------------------------------------------------------------------------------------------

  // Each ended run's meters, from its store (metersIn): kept, as its store no longer changes, keyed by its end, so a run
  // opened again and ended again is read again. A store that cannot be read leaves it all tokens.
  const endedMeters = new Map<string, { tools: number | null; tokens: number | null }>();
  const metersOf = (row: { id: string; endedAt?: string | null }) => {
    const key = `${row.id} ${row.endedAt}`;
    let meters = endedMeters.get(key);
    if (!meters) {
      try {
        meters = metersIn(agents.store.runStorePath(row.id));
      } catch {
        meters = { tools: 0, tokens: null };
      }
      endedMeters.set(key, meters);
    }
    return meters;
  };

  async function usage(url: URL) {
    const now = new Date();
    const fromText = url.searchParams.get("from");
    const toText = url.searchParams.get("to");
    const from = fromText === null ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) : Date.parse(fromText);
    const to = toText === null ? now.getTime() : Date.parse(toText);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ApiError("bad_request", "from and to are RFC 3339 times");
    const group = url.searchParams.get("group_by") ?? "meter";
    if (!["meter", "agent", "key", "day", "region"].includes(group)) throw new ApiError("bad_request", "group_by is meter, agent, key, day or region");
    const lines = new Map<string, { usd: number; unpriced: number }>();
    const total = { usd: 0, unpriced: 0 };
    // A cost that is unknown adds no dollars, so no sum turns unknown; it is counted as unpriced instead, so it never
    // passes as $0.
    const add = (key: string, usd: number | null) => {
      const line = lines.get(key) ?? lines.set(key, { usd: 0, unpriced: 0 }).get(key)!;
      for (const sum of [line, total]) {
        if (usd === null) sum.unpriced++;
        else sum.usd += usd;
      }
    };
    // A line's key for the ledger's entries, as each run's is above: by agent, by day, by meter, or one line.
    const lineKey = (agent: string, at: string, meter: string) => (group === "agent" ? agent : group === "day" ? at.slice(0, 10) : group === "meter" ? meter : "local");
    for (const row of await agents.request(() => agents.store.listRuns())) {
      const at = Date.parse(row.startedAt);
      if (!(at >= from && at < to)) continue;
      const live = row.state === "running" ? await runs.get(row.id) : null;
      const usd = live ? runs.cost(live).usd : (row.costUsd ?? null);
      const key = group === "agent" ? row.agent : group === "day" ? row.startedAt.slice(0, 10) : group === "meter" ? "tokens" : "local";
      // By meter, what a run's paid tools charged (monid's) is `tools`, the rest `tokens`, both from the same records: a
      // live run's rows (a call still marked is no charge), else its store as it ended (a call a crash cut makes `tools`
      // unknown, never `tokens`). An unknown meter counts the run as unpriced on it.
      const meters = group !== "meter" || usd === 0 ? undefined : live ? { tools: toolCostOf(live.rows), tokens: null } : metersOf(row);
      const tokens = meters && (usd !== null && meters.tools !== null ? usd - meters.tools : usd === null && meters.tools === null ? meters.tokens : null);
      const parts: [string, number | null][] = !meters ? [[key, usd]] : [[key, tokens ?? null], ...(meters.tools !== 0 ? [["tools", meters.tools] as [string, number | null]] : [])];
      // A run whose cost is unknown adds no dollars, so no sum turns unknown; it is counted as unpriced instead, so it
      // never passes as $0.
      for (const [name, part] of parts) {
        const line = lines.get(name) ?? lines.set(name, { usd: 0, unpriced: 0 }).get(name)!;
        if (part === null) line.unpriced++;
        else line.usd += part;
      }
      if (usd === null) total.unpriced++;
      else total.usd += usd;
    }
    // What learning spent on this server, outside any run (usage.ts): each run's grade, on the day its learning ended.
    for (const entry of (await outcomes(data)).values()) {
      const at = Date.parse(entry.at);
      if (at >= from && at < to) add(lineKey(entry.agent, entry.at, "learning"), entry.cost);
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), currency: "USD", basis: "estimate", group_by: group, total_usd: round(total.usd), unpriced_runs: total.unpriced,
      lines: [...lines].map(([key, line]) => ({ group: key, ...(group === "meter" ? { meter: key } : {}), usd: round(line.usd), unpriced_runs: line.unpriced })),
      account: null,
    };
  }

  // ---- the owner ------------------------------------------------------------------------------------------------------

  /** A read only this server's page makes: the browser says so (Sec-Fetch-Site), or its Origin is this server's. A
   *  same-origin GET carries no Origin and no body, so fromPage's checks would refuse the page itself. */
  function pageRead(req: IncomingMessage): void {
    if (req.headers["sec-fetch-site"] === "same-origin" || req.headers.origin?.toLowerCase() === ownOrigin(req)) return;
    throw new ApiError("forbidden", "this read must come from this server's page");
  }

  /** A write from the page: this server's own origin and a JSON body. A cookie never makes one from anywhere else. */
  function fromPage(req: IncomingMessage): void {
    if (req.headers.origin?.toLowerCase() !== ownOrigin(req)) throw new ApiError("forbidden", "this write must come from this server's page");
    if (!isJson(req)) throw new ApiError("unsupported_media_type", "the body must be application/json");
  }

  /** The body's one field `name`, a password: 422 on any other field, or on one the rules refuse. */
  async function passwordIn(req: IncomingMessage, allowed: readonly string[], check = true): Promise<{ password: string; body: Json }> {
    const body = await bodyOf(req);
    const issues = unknownFields(body, allowed);
    const problem = check ? passwordProblem(body.password) : typeof body.password === "string" && Buffer.byteLength(body.password) <= 1024 ? undefined : "password is text, at most 1024 bytes";
    if (problem) issues.push({ field: "password", reason: body.password === undefined ? "missing" : "invalid", message: problem });
    if (issues.length) throw invalid(issues);
    return { password: body.password as string, body };
  }

  /** POST /v2/setup, POST /v2/auth/sign-in, POST /v2/auth/sign-out and GET /v2/auth/session, answered before any
   *  credential: their own checks are the setup code (or the token), the password, and the session. */
  async function ownerRoute(req: IncomingMessage, res: ServerResponse, path: string, me: Owner): Promise<void> {
    const method = path === "/auth/session" || path === "/setup/import" ? "GET" : "POST";
    if (req.method !== method) throw new ApiError("method_not_allowed", `${req.method} is not a method of /v2${path}`, {}, { allow: method });
    switch (path) {
      case "/setup": {
        const byToken = req.headers.authorization !== undefined;
        if (byToken && !timingSafeEqual(digest(String(req.headers.authorization)), expected)) throw new ApiError("unauthenticated", "the Bearer here is the server's token, or none", {}, { "www-authenticate": "Bearer" });
        if (!byToken) fromPage(req);
        const { password, body } = await passwordIn(req, ["password", "code", "import"]);
        if (body.import !== undefined && typeof body.import !== "boolean") throw invalid([{ field: "import", reason: "wrong_type", message: "import is true or false" }]);
        if (body.import === true && !offersImport) throw invalid([{ field: "import", reason: "not_allowed", message: "Only a server on this machine (no public address, on loopback) imports its sessions at setup: run the import command where they are." }]);
        // The owner's yes, on the box ticked, is kept with the owner: written durably before the password, so a setup that
        // cannot keep it sets no owner and can be tried again, and taken back if the password is not written.
        const along = body.import === true ? { keep: () => writeDurable(importAsked, ""), drop: () => rm(importAsked, { force: true }) } : undefined;
        const made = await me.setFirst(password, body.code, byToken, along);
        if (made === "exists") throw new ApiError("forbidden", "this server has its owner, or is being set up: sign in");
        if (made === "code") throw new ApiError("forbidden", "that is not the setup code in the server's log, or it has expired");
        // The count is for the offer, now answered: it stops.
        stopCount();
        // Only on the box ticked: the owner, now set, asked for it. It runs after the answer; agents arrive as it goes.
        if (body.import === true) void importAtSetup();
        return send(res, 201, { signed_in: true, ...(body.import === true ? { importing: true } : {}) }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      case "/setup/import": {
        if (!offersImport) throw new ApiError("not_found", "no route /v2/setup/import");
        // Before the owner is set, to the setup page: that it can import (202 while it counts), and then how many projects
        // and sessions it would, or null for each when the count failed.
        if (!me.hasPassword()) {
          pageRead(req);
          countSessions();
          if (count?.state === "counted") return send(res, 200, { projects: count.projects, sessions: count.sessions });
          if (count?.state === "failed") return send(res, 200, { projects: null, sessions: null });
          return send(res, 202, { counting: true });
        }
        // After, to the signed-in owner: the import asked for at setup, running, done or stopped.
        if (!signedIn(req, me) || importState === undefined) throw new ApiError("not_found", "no route /v2/setup/import");
        return send(res, 200, importState);
      }
      case "/auth/sign-in": {
        fromPage(req);
        const allowed = me.allow(req.socket.remoteAddress ?? "unknown");
        if (allowed === "full") authFailed("/v2/auth/sign-in", "sign_in_table_full");
        if (allowed !== "ok") throw new ApiError("rate_limited", "too many sign-ins; try again later", { retry_after_ms: 900_000 }, { "retry-after": "900" });
        const { password } = await passwordIn(req, ["password"], false);
        if (!me.hasPassword()) throw new ApiError("forbidden", "this server has no password yet: set it on the setup page");
        if (!(await me.check(password))) {
          authFailed("/v2/auth/sign-in", "wrong_password");
          throw new ApiError("unauthenticated", "that is not the password");
        }
        return send(res, 200, { signed_in: true }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      case "/auth/sign-out": {
        fromPage(req);
        if (!signedIn(req, me)) throw new ApiError("unauthenticated", "this browser is not signed in");
        me.signOutEverywhere();
        return send(res, 200, { signed_out: true }, { "set-cookie": ownerCookie(req, "", 0) });
      }
      case "/auth/session":
        return send(res, 200, { password_set: me.hasPassword(), signed_in: signedIn(req, me) });
    }
    throw new ApiError("not_found", `no route /v2${path}`);
  }

  // ---- routing --------------------------------------------------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const matching = ROUTES.filter((r) => r.pattern.test(path));
    // `/v2` twice: a path an answer gives (upload.url, a Location) appended to the /v2 base, where it starts at the root.
    if (!matching.length) throw new ApiError("not_found", path.startsWith("/v2/") ? `no route /v2${path}: /v2 is in it twice. A path an answer gives (upload.url, a Location) starts at the server's root: send it to the server's address, not after the /v2 base.` : `no route ${path}`);
    const found = matching.find((r) => r.method === req.method || (req.method === "HEAD" && r.method === "GET"));
    if (!found) throw new ApiError("method_not_allowed", `${req.method} is not a method of ${path}`, {}, { allow: [...new Set(matching.map((r) => r.method))].join(", ") });
    if (found.name === "getCapabilities") return send(res, 200, caps);
    if (found.name === "getOpenapi") return send(res, 200, openapi);
    if (found.name === "getHealth") {
      const health = await healthOf(data, minFreeBytes);
      return send(res, health.status === "ok" ? 200 : 503, health);
    }
    if (!timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected)) {
      authFailed(`/v2${path}`, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      throw new ApiError("unauthenticated", "this route needs Authorization: Bearer <the token in the data directory>", {}, { "www-authenticate": "Bearer" });
    }
    if (found.capability) throw unsupported(found.capability, UNSUPPORTED[found.capability]!);
    const [, first, second] = found.pattern.exec(path)!;
    const id = first ? decodeURIComponent(first) : "";
    switch (found.name) {
      case "createAgent": {
        const body = await bodyOf(req);
        const answer = await idempotent(req, "/agents", body, async () => {
          let warnings: InputIssue[] = [];
          const entry = await agents.create(checkDefinitionBody(body), async (revision) => void (warnings = await saveable(revision)));
          return { status: 201, body: { ...agentView(entry), warnings }, headers: { location: `/v2/agents/${entry.agent.id}`, etag: etagOf(entry) } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listAgents": {
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const archived = archivedParam(url);
        const all = (await agents.list()).filter((entry) => Boolean(entry.agent.archivedAt) === archived);
        return send(res, 200, { agents: all.slice(offset, offset + limit).map((entry) => agentView(entry)), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getAgent": {
        const entry = await needAgent(id);
        // The tools its current revision grants, as capabilities list them, each with its provider for this agent.
        const tools = entry.revision ? agentTools(env, settings.get(), await toolingOf(entry.revision), caps.tools.map((tool) => tool.name)) : [];
        return send(res, 200, { ...agentView(entry), tools }, { etag: etagOf(entry) });
      }
      case "updateDefinition": {
        const entry = await needAgent(id);
        const match = req.headers["if-match"];
        if (match !== undefined && match !== etagOf(entry)) throw new ApiError("precondition_failed", `If-Match is ${match}, and the agent's current revision is ${etagOf(entry)}`);
        const body = await bodyOf(req);
        // Two bodies, told apart by one rule: this server's own form holds the definition under `definition`; the
        // contract's is the definition itself, and takes the contract's preconditions: If-Match, and a version past the
        // current one.
        const contract = !("definition" in body);
        if (contract) {
          if (match === undefined) throw new ApiError("precondition_failed", "If-Match is required: the agent's ETag, as GET /agents/{agent_id} returned it.");
          if (body.version === undefined || (typeof body.version === "number" && body.version <= entry.version)) throw invalid([{ field: "definition.version", reason: body.version === undefined ? "missing" : "not_an_option", message: `definition.version must be greater than the current one, ${entry.version}` }]);
        }
        // The check above is a fast path; the store compares If-Match again inside the commit, so of two edits that read
        // the same revision exactly one lands.
        let warnings: InputIssue[] = [];
        const check = async (revision: NewRevision) => void (warnings = await saveable(revision));
        const edited = await agents.commit(entry, checkDefinitionBody(contract ? { definition: body } : body, { creating: false }), { check, contract, ...(match === undefined ? {} : { ifCurrent: entry.revision?.id ?? null }) });
        return send(res, 200, { ...agentView(edited), warnings }, { etag: etagOf(edited) });
      }
      case "listRevisions": {
        const entry = await needAgent(id);
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const all = await agents.revisions(id);
        const page = await agents.request(() => all.slice(offset, offset + limit).map((row) => revisionView(entry.agent, row, agents.store.readRevision(row.id))));
        return send(res, 200, { revisions: page, next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "setCurrent": {
        const entry = await needAgent(id);
        const body = await bodyOf(req);
        const extra = unknownFields(body, ["revision"]);
        if (extra.length) throw invalid(extra);
        const revision = body.revision;
        if (typeof revision !== "string" || !ID.test(revision)) throw invalid([{ field: "revision", reason: revision === undefined ? "missing" : "wrong_type", message: "revision is a revision id of this agent" }]);
        if (!(await agents.revision(id, revision))) throw invalid([{ field: "revision", reason: "not_an_option", message: `${revision} is not a revision of the agent ${id}` }]);
        const moved = await agents.setCurrent(entry, revision);
        return send(res, 200, agentView(moved), { etag: etagOf(moved) });
      }
      case "archiveAgent":
      case "unarchiveAgent": {
        await needAgent(id);
        await agents.setArchived("agent", id, found.name === "archiveAgent");
        if (found.name === "archiveAgent") await runs.archived();
        const entry = await needAgent(id);
        return send(res, 200, agentView(entry), { etag: etagOf(entry) });
      }
      case "createRun": {
        const answer = await createRun(req, id);
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listRuns":
        await needAgent(id);
        return send(res, 200, await runsPage(url, { agent: id }));
      case "listAllRuns": {
        const agent = url.searchParams.get("agent") ?? undefined;
        const revision = url.searchParams.get("revision") ?? undefined;
        return send(res, 200, await runsPage(url, { ...(agent ? { agent } : {}), ...(revision ? { revision } : {}) }));
      }
      case "getRun":
        return send(res, 200, await runs.view(await needRun(id)));
      case "getTimeline":
        return timeline(req, res, url, await needRun(id));
      case "sendMessage": {
        const run = await needRun(id);
        if (run.kind === "workflow") throw unsupported("messages.steer_workflow_runs", "A workflow run takes no messages here: its workflow runs to its end, or a cancel ends it.");
        const body = await bodyOf(req);
        const answer = await idempotent(req, `/runs/${id}/messages`, body, async () => {
          const extra = unknownFields(body, ["content"]);
          if (extra.length) throw invalid(extra);
          const content = body.content;
          if (typeof content !== "string" || !/\S/.test(content)) throw invalid([{ field: "content", reason: content === undefined ? "missing" : "wrong_type", message: "content is a non-empty string" }]);
          if (content.length > MAX_MESSAGE) throw invalid([{ field: "content", reason: "too_long", message: `content is at most ${MAX_MESSAGE} characters` }]);
          const { mode, messageId } = await runs.message(run, content);
          // The run's state as the message left it, from the run itself: the stored row (its view's) would make a
          // message already taken answer home_busy while another connection holds the agent store.
          const { status, state } = statusOf(run);
          return { status: 202, body: { run_id: run.id, message_id: messageId, mode, status, state, poll_after_ms: 1000 } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "stopRun": {
        const run = await needRun(id);
        const stopped = await runs.stop(run);
        // From the run itself, as a message's answer: a stop that happened is never answered home_busy.
        const { status, state } = statusOf(run);
        return send(res, 200, { run_id: run.id, stopped, status, state });
      }
      case "cancelRun": {
        const run = await needRun(id);
        const requested = await runs.cancel(run);
        return send(res, 202, { run_id: run.id, cancel_requested: requested, already_terminal: !requested, status: statusOf(run).status });
      }
      case "archiveRun":
      case "unarchiveRun": {
        const run = await needRun(id);
        await agents.setArchived("run", run.id, found.name === "archiveRun");
        if (found.name === "archiveRun") await runs.archived();
        return send(res, 200, await runs.view(run));
      }
      case "listRunFiles": {
        const run = await needRun(id);
        // A remote box's turn just ended: its pull lands first, so the list shows what the box wrote.
        await runs.pulled(run.id);
        const { files, deep } = await walk(join(run.dir, "work"));
        files.sort((a, b) => a.path.localeCompare(b.path));
        return send(res, 200, { run_id: run.id, files: files.slice(0, FILE_LIST_CAP), complete: true, truncated: deep || files.length > FILE_LIST_CAP });
      }
      // An archived agent's home is read and written as any other's: as its definition is.
      case "listHomeFiles": {
        await needAgent(id);
        const home = await homeDir(id, false);
        const { files, deep, owned } = home ? await walk(home, true) : { files: [], deep: false, owned: [] };
        // A host-owned path there is one entry by its name, and none of what is in it.
        const listed = [...files, ...owned.map((path) => ({ path, host_owned: true as const }))].sort((a, b) => a.path.localeCompare(b.path));
        return send(res, 200, { agent_id: id, files: listed.slice(0, FILE_LIST_CAP), complete: true, truncated: deep || listed.length > FILE_LIST_CAP });
      }
      case "readHomeFile": {
        await needAgent(id);
        const rel = homePath(second!, id, false, ownedReadAt(id));
        const home = await homeDir(id, false);
        if (!home) throw new ApiError("not_found", "no such file");
        await notHostOwned(home, rel, id, false);
        return sendFile(req, res, url, home, rel, "another user");
      }
      case "writeHomeFile": {
        await needAgent(id);
        if (!homeWrites) throw new ApiError("unsupported_here", HOME_WRITES_OFF);
        const rel = homePath(second!, id, true);
        const bytes = await bytesOf(req);
        // Each write lands whole (a temporary file renamed over the old one); of two at once, the last rename wins.
        const st = await homeDir(id, true)
          .then(async (home) => {
            await notHostOwned(home!, rel, id, true);
            return writeWorkFile(home!, rel, bytes);
          })
          .catch(homeRefusal);
        return send(res, 200, fileView(rel, st));
      }
      case "deleteHomeFile": {
        await needAgent(id);
        if (!homeWrites) throw new ApiError("unsupported_here", HOME_WRITES_OFF);
        const rel = homePath(second!, id, true);
        const home = await homeDir(id, false);
        if (!home) throw new ApiError("not_found", "no such file");
        await notHostOwned(home, rel, id, true);
        await removeWorkFile(home, rel).catch(homeRefusal);
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "validateWorkflow": {
        const body = await bodyOf(req);
        const extra = unknownFields(body, ["workflow", "tools"]);
        if (extra.length) throw invalid(extra);
        if (!isObject(body.workflow)) throw invalid([{ field: "workflow", reason: body.workflow === undefined ? "missing" : "wrong_type", message: "workflow is the workflow definition, an object" }]);
        if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every((t) => typeof t === "string"))) throw invalid([{ field: "tools", reason: "wrong_type", message: "tools is a list of tool names" }]);
        const { workflowIssues } = await import("@parcha/pi-durable-agent/workflow");
        const { issues, warnings } = await workflowIssues(body.workflow, body.tools as string[] | undefined);
        // What a save refuses on this host (a model node's tool, a code node where none runs), and what it lacks yet.
        if (!issues.length) {
          for (const blocker of await blockersOf(env, { kind: "workflow", workflow: body.workflow as never, ...(body.tools ? { tools: body.tools as string[] } : {}) }, settings.get(), { offers }).catch(() => [])) {
            if (blocker.host) warnings.push(blocker.message);
            else issues.push({ path: "", code: "NOT_RUNNABLE_HERE", message: blocker.message });
          }
        }
        return send(res, 200, { ok: issues.length === 0, issues, warnings });
      }
      case "getRunGraph":
        return send(res, 200, await runs.graph(await needRun(id)));
      case "pauseRun":
      case "resumeRun":
        return send(res, 200, await runs.pause(await needRun(id), found.name === "pauseRun"));
      case "readRunFile": {
        const run = await needRun(id);
        await runs.pulled(run.id);
        return sendFile(req, res, url, join(run.dir, "work"), checkedPath(decodedPath(second!), "the run's own, not a file it wrote"), "a tool in the run's box");
      }
      case "createFile": {
        // A `path` in the query, or a body that is not JSON: the file sent in one call, its bytes the body. Else the
        // contract's JSON reservation, its bytes sent after with PUT /files/{file_id}.
        if (url.searchParams.has("path") || !isJson(req)) {
          const received = await uploads.take(url.searchParams, req.headers["content-type"], req);
          try {
            const answer = await idempotent(req, "/files", received.fingerprint, async () => ({ status: 201, body: await received.commit() }));
            return send(res, answer.status, answer.body, answer.headers);
          } finally {
            await received.discard();
          }
        }
        const body = await bodyOf(req);
        const answer = await idempotent(req, "/files", body, async () => ({ status: 201, body: await uploads.reserve(body) }));
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "uploadFile":
        return send(res, 200, await uploads.receive(id, req));
      case "listFiles": {
        // This server's own: its uploads, newest first, a page at a time, so an id is never lost with the answer that gave it.
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const ids = await uploads.ids();
        const files = (await Promise.all(ids.slice(offset, offset + limit).map((fileId) => uploads.get(fileId)))).filter((file) => file !== null);
        return send(res, 200, { files, next_cursor: nextCursor(offset + limit, ids.length) });
      }
      case "getFile": {
        const file = await uploads.get(id);
        if (!file) throw new ApiError("not_found", `no file ${id}: GET /v2/files lists the files this server keeps`);
        return send(res, 200, file);
      }
      case "deleteFile":
        await uploads.remove(id);
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "getUsage":
        return send(res, 200, await usage(url));
      case "getStats": {
        const filter = analyticsFilter(url);
        const [stats, analytics, rows] = await agents.request(() => [agents.store.stats(), agents.store.analytics(filter), agents.store.listRuns()] as const);
        // How the runs that tried to learn fared: a held run's learning from memory, any other's end from the ledger.
        return send(res, 200, { ...statsView(stats, runs), analytics: analyticsView(analytics, filter), learning: await runs.learning.counts(rows, filter) });
      }
      case "listToolKeys":
        return send(res, 200, toolKeys.view(caps.harnesses));
      case "saveToolKey": {
        // Never through `idempotent`: its record keeps the body, and this body is the values. Checked against its
        // provider before it is kept: a key the provider refuses is 422, and nothing is kept.
        const body = await bodyOf(req);
        const check = await toolKeys.check(id, body, checkFetch, stopping.signal);
        // A server that began to close stores nothing: it may have released its lock, and another server may hold this
        // directory and its keys by now.
        if (stopping.signal.aborted) throw new ApiError("unavailable", "The server is shutting down: the key was not saved.");
        toolKeys.save(id, body, check);
        await keysChanged();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      }
      case "deleteToolKey":
        toolKeys.remove(id);
        await keysChanged();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "getToolSettings":
        return send(res, 200, withDefaults(settings.get()));
      case "putToolSettings": {
        // Replaces the settings: a capability the body leaves out takes its default. Runs launched from now on resolve
        // on them, and capabilities say so at once.
        const body = await bodyOf(req);
        const issues = settingsIssues(body);
        if (issues.length) throw invalid(issues);
        settings.put(body as ToolSettingsMap);
        // A setting changes what the web tools resolve to, never env or what a harness offers: capabilities again.
        recompose();
        return send(res, 200, withDefaults(settings.get()));
      }
      // A person's view and control of what an agent learned (learning-routes.ts). Every text cut of the host's secrets as
      // they are now; a write as the definition's: an archived agent's too.
      case "getAgentLearning": {
        await needAgent(id);
        const rows = await agents.request(() => agents.store.listRuns({ agent: id }));
        // Counted as GET /stats counts (learning-run.ts counts): a held run from memory, any other's end from the ledger;
        // what learning changed, from the same rows and ledger (learningImpact).
        const { counts, impact } = await runs.learning.ofAgent(rows, id);
        return send(res, 200, await agentLearning(data, id, secretsShown(learningSecrets()), counts, impact));
      }
      case "listLearningNotes":
      case "listLearningLog":
        await needAgent(id);
        return send(res, 200, await (found.name === "listLearningNotes" ? learningNotes : learningLog)(data, id, url.searchParams, secretsShown(learningSecrets())));
      case "readLearningFile":
        await needAgent(id);
        return sendNote(res, 200, await readNote(data, id, second!, secretsShown(learningSecrets())));
      case "writeLearningFile":
      case "retireLearningFile": {
        await needAgent(id);
        const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
        const body = found.name === "writeLearningFile" ? await noteBody(req, MAX_BODY) : undefined;
        const written = await writeNote(data, id, second!, { ifMatch: header("if-match"), ifNoneMatch: header("if-none-match"), body, refuse: learningSecrets() });
        // A name holding a secret (one the checks let by) is never echoed, not even as where the note is.
        const shown = secretsShown(learningSecrets());
        const located = written.status === 201 && shown.name(written.file) === written.file;
        return sendNote(res, written.status, { ...written, text: shown.text(written.text) }, located ? { location: `/v2/agents/${encodeURIComponent(id)}/learning/files/${written.file}` } : {});
      }
      case "getRunLearning":
        return send(res, 200, await runLearning(await needRun(id), secretsShown(learningSecrets()), learningSecrets()));
      case "getRunLearningDiff":
        return send(res, 200, await runDiff(data, await needRun(id), secretsShown(learningSecrets())));
      case "getWebhook":
        return send(res, 200, webhooks.view());
      case "saveWebhook": {
        // Never through `idempotent`: its record would keep the answer, and the first one holds the secret.
        const saved = webhooks.save(await bodyOf(req));
        return send(res, saved.created ? 201 : 200, { ...saved.view, ...(saved.secret ? { secret: saved.secret } : {}) });
      }
      case "deleteWebhook":
        webhooks.remove();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "testWebhook":
        return send(res, 200, await webhooks.test());
      case "listWebhookDeliveries":
        return send(res, 200, webhooks.attemptsView());
      case "redeliverWebhook":
        return send(res, 200, await webhooks.redeliver(id));
    }
    throw new ApiError("not_found", `no route ${path}`);
  }

  // The MCP endpoint's tools are the routes above, called in process with the caller's token (mcp.ts).
  const mcp = mcpEndpoint({ route, authorized: (header) => timingSafeEqual(digest(header), expected), authFailed, version: VERSION });

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(text);
  }

  let names: Set<string> | undefined;
  const server = createServer((req, res) => {
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    res.setHeader("x-request-id", requestId);
    if (log && !quiet) {
      const started = performance.now();
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0]!;
      res.once("finish", () => log(logLine("request", { method, path, status: res.statusCode, ms: Math.round(performance.now() - started) })));
    }
    const fail = (error: unknown) => {
      if (res.headersSent) return void res.end();
      // A store still busy past a request's wait is home_busy, whichever read or write met it.
      const known = error instanceof ApiError ? error : storeBusy(error) ? homeBusy() : new ApiError("internal", (error as Error)?.message ?? String(error));
      if (!(error instanceof ApiError) && !storeBusy(error)) process.stderr.write(`agentrun-serve: ${(error as Error)?.stack ?? String(error)}\n`);
      send(res, known.status, known.body(requestId), known.headers);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://serve");
    } catch {
      return fail(new ApiError("bad_request", "the request target is not a URL"));
    }
    // On loopback, a Host that is not a loopback name is a page that rebound a name of its own to this address.
    if (names && !names.has(String(req.headers.host ?? "").toLowerCase())) return fail(new ApiError("forbidden", "unexpected Host header"));
    // Routed on the path as sent: a parsed URL folds `..` and `%2E%2E` segments away, and a file path must see them.
    const raw = (req.url ?? "/").split("?")[0]!;
    // Before the page: its cookie must not stand in for the token on the owner's own routes, nor on the MCP endpoint.
    if (owner && (raw === "/v2/setup" || raw === "/v2/setup/import" || raw.startsWith("/v2/auth/"))) return void ownerRoute(req, res, raw.slice(3), owner).catch(fail);
    if (raw === MCP_PATH) return void mcp(req, res).catch(fail);
    if (raw === "/llms.txt") return void answerLlms(req, res).catch(fail);
    if (answerPage(req, res, raw, { token, dir: data, authFailed, console: options.console, takesBytes, ...(owner ? { owner } : {}) })) return;
    if (!raw.startsWith("/v2/")) return fail(new ApiError("not_found", `no route ${raw}; the API is under /v2`));
    route(req, res, url, raw.slice(3)).catch(fail);
  });
  const first = options.port ?? DEFAULT_PORT;
  const last = options.nextFreePort && first !== 0 ? Math.min(first + 99, 65_535) : first;
  for (let port = first; ; port++) {
    try {
      await new Promise<void>((done, reject) => (server.once("error", reject), server.listen(port, host, () => (server.off("error", reject), done()))));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (port < last) continue;
      throw last > first ? Object.assign(new Error(`every port from ${first} to ${last} on ${host} is taken`), { code: "EADDRINUSE" }) : error;
    }
  }
  // Only a server that started takes up the import its owner asked for, or counts for setup's offer: one that failed to
  // listen hands back no close to stop them.
  if (offersImport && existsSync(importAsked)) void importAtSetup();
  else if (offersImport && options.countSessions && owner && !owner.hasPassword()) countSessions();
  const address = server.address() as AddressInfo;
  if (isLoopback(host)) names = new Set(["localhost", "127.0.0.1", "[::1]", host, ...(options.allowHosts ?? [])].map((h) => `${h.toLowerCase()}:${address.port}`));
  // An address of every interface is reached on this machine at its loopback one.
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${shown.includes(":") ? `[${shown}]` : shown}:${address.port}`;
  owner?.attach(options.publicUrl ?? url);
  webhooks.attach(options.publicUrl ?? url);
  const setupUrl = owner && !owner.hasPassword() ? owner.setupLink() : undefined;
  /** The server's stop: once (`close` keeps its promise). */
  let stopped: Promise<void> | undefined;
  async function stop(): Promise<void> {
    // First, the record a start on this data root waits on while the runs' processes drain and exit (server-lock.ts),
    // rewritten in place: this close's bound, with time for the deliveries and the listener after them. One not
    // written leaves a start refused.
    const { runs: busy, boundMs } = runs.stopping();
    try {
      markStopping(data, Date.now() + boundMs + STOP_MARGIN_MS);
    } catch (error) {
      const fields = { reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
      void (log ? log(logLine("stopping_mark_unwritten", fields)) : process.stderr.write(`agentrun-serve: ${logLine("stopping_mark_unwritten", fields)}\n`));
    }
    if (busy > 0) noticeOf(options)(`stopping: waiting up to ${seconds(boundMs)} for ${busy === 1 ? "1 run to finish its turn" : `${busy} runs to finish their turn`}`);
    // An import (or its count) under way stops between two session files and is waited for: nothing writes the store
    // after close.
    closing = true;
    stopping.abort();
    for (const worker of workers.keys()) worker.postMessage("stop");
    await Promise.all([...workers.values()].map((w) => w.exit));
    await importing;
    // Runs that end while their processes stop still give their notices; then the deliveries stop, before the lock goes.
    await runs.close();
    await relay?.close();
    await webhooks.close();
    await new Promise((done) => (server.close(done), server.closeAllConnections()));
    agents.close();
    // The record stays: the next server rewrites it as it starts, and a stopped one whose time has passed is no stop.
    lock.release();
  }
  return {
    url,
    baseUrl: `${url}/v2`,
    port: address.port,
    token,
    tokenFile,
    tokenMade: stored?.made ?? false,
    ...(setupUrl ? { setupUrl } : {}),
    boxesLine: boxesLine(boxOffers, enabledBoxes(env)),
    // Once: a second call, at any time, is the first one's promise, so a close repeated after the next server started
    // never writes this data root's record again (the next server's, by then).
    close: () => (stopped ??= stop()),
  };
}
