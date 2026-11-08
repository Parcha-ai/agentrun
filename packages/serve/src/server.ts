// The /v2 API over the agent store in a data directory: the contract agentrun.v2/0, served on loopback with a bearer
// token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { type NewRevision, type Revision, runDirIn, type RunOrigin, STORE_FILE } from "@parcha/pi-durable-agent";
import { agentView, Agents, etagOf, homeBusy, revisionView, storeBusy, type AgentEntry } from "./agents.js";
import { WORKFLOW_ADAPTERS } from "./app.js";
import { DECISION_ADAPTER, decisionsOf, FAUX_JEV_ENV, FAUX_OPENROUTER_ENV, FAUX_PARALLEL_ENV, fauxFetch } from "./decisions.js";
import { FAUX_WEB_ENV } from "./web-fetch-direct.js";
import { FAUX_MONID_ENV } from "./monid.js";
import { FAUX_EXA_ENV } from "./exa-keyless.js";
import { FAUX_BROWSER_ENV, NODE_TOOLS, toolingOf, toolOf, toolsView } from "./tools.js";
import { ApiError, type InputIssue, invalid, unsupported } from "./errors.js";
import { deref, explain } from "./explain.js";
import { DOOR_TOKEN_FILE, HOME_HOST_OWNED, RUN_META, SETUP_LOST } from "./files.js";
import { DATA_ENV, readJson, syncDir, TOKEN_FILE, writeDurable } from "./server-fs.js";
import { checkedPath, decodedPath, homePath, hostOwnedOf, type OwnedReadAt } from "./home-path.js";
import { chooseModel, EFFORTS, FAUX_ENV, FAUX_UPSTREAM_ENV, MODEL_NODES, type ModelNeeds, modelSource, THINKING_LEVELS, unpricedModels, withoutFaux } from "./model.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessCapability, harnessOfBody, harnessOffers } from "./harness.js";
import { HARNESS_TABLE_ENV, harnessOf } from "./harness-table.js";
import { HarnessInstall, harnessesOf, installDirOf, NPM_STOP_GRACE_MS, npmInstall, removeFlatInstall } from "./harness-install.js";
import { healthOf, hostMemory, maxRunsOf, MIN_FREE_MIB, runsThatFit } from "./host.js";
import { IMPORT_ASKED } from "./import.js";
import type { ImportAnswer, ImportTask } from "./import-worker.js";
import type { MessageOrigin } from "@parcha/pi-durable-agent/timeline";
import { gradeModelOf, learningBudgetOf, type LearningMode, learningOf } from "./learning.js";
import { agentLearning, learningLog, learningNotes, noteBody, pendingCount, readNote, runDiff, runLearning, secretsShown, sendNote, writeNote } from "./learning-routes.js";
import { answerLlms, MCP_PATH, mcpEndpoint } from "./mcp.js";
import { openapiDocument, servedOpenapi, UNSUPPORTED } from "./openapi.js";
import { boxesLine, defaultPlaceOf, NEW_AGENT_TOOLS, newAgentPlace, noBoxReason, type Place, placesOf, resolvePlace } from "./place.js";
import { BOX_ALLOW_ENV, boxAllowOf, boxLimitsOf, boxNetworkOf, FAUX_BOX_ENV, fauxBoxes } from "./run-box.js";
import { Owner, passwordProblem, SESSION_MS } from "./owner.js";
import { answerPage, byOwnerSession, heldSessions, isJson, overHttps, ownerCookie, ownOrigin, sendHostRefused, signedIn } from "./page.js";
import { hostFix, hostName, loopbackNames } from "./host-check.js";
import { handoverById, type LiveHandover, liveRest, LiveViewers, proxyLiveUpgrade, readHandover, readHandovers, serveViewerFile, viewerAnswers, viewerLink } from "./browser-live.js";
import { answerAsk } from "./browser-person.js";
import { durationMs, logLine } from "./print.js";
import { type CarryBackRetry, knownToolCostOf, type Run, Runs, STATUSES, type Status, statusOf, toolCostOf, WAITS_ON_A_PERSON, WITHHELD_SIGN_IN } from "./runs.js";
import { runLines } from "./usage-lines.js";
import { BOX_QUARANTINE, type BoxHost, Quarantine } from "./box/sweep.js";
import { type BoxOffer, boxesByDefault, boxesLog, boxRegistry, daytonaApi, enabledBoxes, VM_NO_LIST, VM_PROVIDER } from "./boxes.js";
import { type DockerNetwork, egressParentTooLong, FAUX_EGRESS_ENV, MAX_EGRESS_PARENT, sweepEgressDirs } from "./box-egress.js";
import { type EgressContainer, startEgressContainer } from "./box-egress-vm.js";
import { type DockerPaths, dockerPathsOf, egressParentOf, FAUX_MOUNTINFO_ENV } from "./box-paths.js";
import { boxImageOf, clearImage, type DockerImage, dockerImage, type ImageState, withImage } from "./box-image.js";
import { startBoxRelay } from "./box-relay.js";
import { vmRelay, type VmSdk } from "./box-relay-vm.js";
import { memoryMbOf } from "./run-box.js";
import { DOCUMENTS_ENV } from "./pdf-pages.js";
import { CAP_MODES, type CapMode, meterFiguresIn } from "./cap.js";
import { type Blocker, blockersOf, CODE_NODES_ENV, issueOf, MCP_HARNESSES, NOT_SET_UP, type RevisionShape } from "./runnable.js";
import { hostSecrets, SECRET_NAMES, secret, type StoredKeys, withSecrets } from "./secrets.js";
import { redactedOutput } from "./key-refusal.js";
import { analyticsFilter, analyticsView, pendingOf, statsView } from "./stats.js";
import { outcomes } from "./usage.js";
import { keyOf, SEAL_KEY_ENV, sealKeyOf, TOOL_FIELDS, ToolKeys } from "./tool-keys.js";
import { SIGN_INS_DIR, SignIns, vendorsOver } from "./sign-ins.js";
import { MCP_AUTH_TYPES, McpServers } from "./mcp-servers.js";
import { metaToolOf } from "./mcp-meta.js";
import { MCP_SETTINGS_PAGE, signInCookie, startedHere } from "./mcp-oauth.js";
import type { McpServerSource } from "./mcp-gateway.js";
import { WEBHOOK_EVENTS, Webhooks } from "./webhooks.js";
import { type SealedSettings } from "./sealed-settings.js";
import { openServerSecrets, type ServerSecrets } from "./server-secrets.js";
import { HOOK_TOLERANCE_S } from "./standard-webhooks.js";
import { HookCut, receivePush } from "./push-handler.js";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { webhook } from "./trigger-webhook.js";
import { SCHEME_NAMES } from "./trigger-signatures.js";
import { permissionFrom, pinWords } from "./tool-gate.js";
import { CATCHUP_WINDOW_S, FAILURES_TO_PAUSE, HISTORY_KEPT, MIN_EVERY_S, PAYLOAD_KEPT_BYTES, type RunTrigger, SOURCE_KINDS, TARGET_KINDS, type TriggerClock, Triggers } from "./triggers.js";
import { applyBodyOf, compiled, madeTriggerIssues, type Package, packageModel, packageView, readPackages } from "./templates.js";
import { checkDefinitionBody, DEFAULT_INPUT_SCHEMA, definitionBodyIssues, ID, IDEMPOTENCY_TTL_S, inputIssues, isObject, type Json, stable, unknownFields } from "./validate.js";
import { agentTools, browserKeyRow, isUnavailable, recheckPlane, settingsIssues, ToolSettings, type ToolSettingsMap, whyUnavailable, withDefaults } from "./tool-plane.js";
import { MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, Uploads, UPLOADS_DIR } from "./uploads.js";
import { entryAt, listFiles, sendFile as sendWorkspaceFile, viewOf } from "./run-files.js";
import { writesHeld } from "./workspace.js";
import { agentHomeFolder, isWorkspaceError, localWorkspace, runFolder, type Workspace } from "./workspace/index.js";
import { markRunning, markStopping, type ServerLock, takeServerLockAfterStop } from "./server-lock.js";

export const CONTRACT = "agentrun.v2/0";

/** A process's flags for a worker of it: without --input-type and the code string given with -e, --eval, -p or --print. */
const workerArgs = (args: readonly string[]): string[] =>
  args.filter((arg, i) => !arg.startsWith("--input-type") && !/^(?:-e|--eval|-p|--print)(?:=|$)/.test(arg) && !/^(?:-e|--eval|-p|--print)$/.test(args[i - 1] ?? ""));
export const DEFAULT_PORT = 7340;
const VERSION: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const IDEMPOTENCY_FILE = ".idempotency.json";
/** A run's live browser viewer, under the run's path (browser-live.ts): its run id, then its page, files or WebSocket. */
const LIVE_PATH = /^\/v2\/runs\/([^/]+)\/browser\/live(\/.*)$/;
const MAX_BODY = 1 << 20;
const MAX_MESSAGE = 20_000;
const MAX_WAIT_MS = 25_000;
const PAGE_ROWS = 500;
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
/** Why a home's write or removal is refused when a link is on the way: the Workspace follows none. */
const LINK_REFUSED = "A link is on the way to this path, or is the file: this server follows none.";

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
   *  backend), in place of Browserbase's or Kernel's. */
  fauxBrowser?: string;
  /** With `faux` only: a module whose default export is the fetch the check of a Kernel key goes through (the tests'
   *  fake), in place of Kernel's API. */
  fauxKernel?: string;
  /** With `faux` only: a module whose default export gives web_fetch's guarded fetch its `{ lookup, fetchImpl }` (the tests' fake
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
  /** With `faux` only: a module whose default export is the fetch the check of a Browserbase key goes through (the
   *  tests' fake), in place of Browserbase's API. */
  fauxBrowserbase?: string;
  /** With `faux` only: a module whose default export is the fetch the start's check of a monid key the server is started
   *  with goes through (the tests' fake for that check alone), in place of monid's API; the runs' calls go through
   *  `fauxMonid`'s. */
  fauxMonidCheck?: string;
  /** With `faux` only: a module whose default export is the fetch the Anthropic and OpenAI providers send through, in
   *  place of their APIs, for web_search's own request to the provider the revision's model names (model.ts). */
  fauxUpstream?: string;
  /** With `faux` only: a module whose default export is the fetch web_search's keyless Exa search sends through, in place
   *  of Exa's MCP endpoint (exa-keyless.ts). */
  fauxExa?: string;
  /** A module of harness table entries merged over the built-in ones (harness-table.ts HARNESS_TABLE_ENV): a test's
   *  stand-ins for the harnesses. */
  harnessTable?: string;
  /** With `faux` only: a module whose default export, given the data root, is the box provider runs' Docker boxes come
   *  from (the tests' faux box, pi-transport's local box): docker is then available, and nothing asks Docker. */
  fauxBox?: string;
  /** Under `faux` only: a module that stands in for the VM provider's SDK (its client class, by the SDK's name for it),
   *  so the VM box runs on the tests' fake, never the provider. */
  fauxVm?: string;
  /** For tests: the lock each harness's first use installs by (harness-install.ts), by harness, with the package.json it
   *  locks beside it, in place of the one AgentRun ships, whose packages a test's own registry serves. */
  harnessLocks?: Readonly<Record<string, string>>;
  /** Under `faux`: a module whose default export gives a box's egress proxy its `lookup` and `dial` (box-egress.ts), the
   *  tests' fake network. */
  fauxEgress?: string;
  /** Under `faux`: a file read as this server's /proc/self/mountinfo (box-paths.ts), a container's in a test; absent (and
   *  no FAUX_MOUNTINFO_ENV), a faux server is on a host. */
  fauxMountinfo?: string;
  /** With `faux` only: the platform this server takes itself to run on (tests: `darwin`, to take a Mac's path to a box's
   *  network, box-egress-vm.ts, on another machine). */
  fauxPlatform?: NodeJS.Platform;
  /** Extra `Host` names to accept besides the loopback ones, on any port (host-check.ts). */
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
  /** Told the Docker box image's state at the start, when this server has a Docker box, then each change (box-image.ts):
   *  the CLI says a first build in words, as it starts and as it ends. */
  onBoxImage?: (state: ImageState) => void;
  /** The lines a person reads about a stop on this data root: this server's, as its close begins and runs' processes are
   *  left to finish their turn, and this start's, when it waits for a server that is stopping (server-lock.ts). Default:
   *  standard error, after `agentrun-serve: `. */
  notice?: (line: string) => void;
  /** The waits between carry backs that found the store held by another writer (default 0.5, 1, 2, 4 and 8 s), and a
   *  hook called at each such refusal. */
  carryBackRetry?: CarryBackRetry;
  /** A test's seam: awaited by a stop between its mark and its abort, so a test can hold a stop in flight there. */
  beforeAbort?: (runId: string) => Promise<void> | void;
  /** A test's seam: awaited by a completed run's reopen for a follow-up, after the run reads open again and before its
   *  process is launched, so a test can hold a reopen there. */
  beforeReopenLaunch?: (runId: string) => Promise<void> | void;
  /** A test's seam: awaited where a raise that opens a let-go workflow pins what its launch needs, after its place is
   *  taken (runs.ts finishRaise); one that throws stands for a pin that fails there. */
  beforeRaiseLaunch?: (runId: string) => Promise<void> | void;
  /** A test's seam: the host's memory, in bytes, that the runs' limit reads (host.ts), in place of this host's. */
  hostMemory?: number;
  /** A test's seam: told each stat and each read of a workflow run's pause by its watch (runs.ts watchPause). */
  onPauseCheck?: (runId: string, what: "stat" | "read") => void;
  /** A test's seam: awaited by a message before it goes to the run's door, so a test can act while it is in flight. */
  beforeSubmit?: (runId: string, content: string) => Promise<void> | void;
  /** A test's seam: told each run read in from its store (runs.ts onRunLoad). */
  onRunLoad?: (runId: string) => void;
  /** A test's seam: awaited before a run's serve.json is written (runs.ts beforeMetaSave). */
  beforeMetaSave?: (runId: string, meta: Readonly<Record<string, unknown>>) => Promise<void> | void;
  /** A test's seam: who wrote a message sent to a run through its messages route (`origin`, as a raised cap's follow-up
   *  carries it), so a test sends a server-written message down the path a person's message takes. */
  messageOrigin?: (runId: string, content: string) => MessageOrigin | undefined;
  /** How long a request waits for a run's door, its process coming up or a settle in progress (default 45 s). */
  readyTimeoutMs?: number;
  /** How long a launched run's process has to open its run before it is stopped and the run opened again (default 45 s,
   *  READY_TIMEOUT_MS: the wait of a run's first message). */
  openTimeoutMs?: number;
  /** With `faux` only: the door nonce each run's process is handed in place of its launch's own, so its door answers the
   *  launch's proof wrongly (a test of a door that fails its proof). */
  fauxHandedNonce?: string;
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
  /** A test's seam: the triggers' clock and timer (triggers.ts), in place of Date.now and setTimeout. */
  triggerClock?: TriggerClock;
  /** A test's seam: the trigger sources this server has (default the registry, trigger-adapters.ts). */
  triggerAdapters?: readonly TriggerAdapter[];
  /** A test's seam: the folder the template packages are read from, in place of the package's own (templates.ts). */
  templates?: string;
  /** The waits before each try again of a webhook delivery (default 5 s, 5 min, 30 min, 2 h, 5 h and 10 h: webhooks.ts RETRY_MS). */
  webhookRetryMs?: readonly number[];
  /** The box runs' harnesses run in (4a's Box: its reap; on a shared server its run cgroups): the boxes runs leave are
   *  swept at start and let go at archive. The quarantine of boxes a reap could not empty is kept in the data directory. */
  box?: BoxHost;
};

/** Each test switch a run's process reads, by the variable it reads it from: set only under `faux`, but the faux
 *  harness's, which scripts the harnesses with or without it. */
const FAUX_SWITCHES = [["fauxBrowser", FAUX_BROWSER_ENV], ["fauxWeb", FAUX_WEB_ENV], ["fauxJev", FAUX_JEV_ENV], ["fauxParallel", FAUX_PARALLEL_ENV], ["fauxOpenrouter", FAUX_OPENROUTER_ENV], ["fauxMonid", FAUX_MONID_ENV], ["fauxUpstream", FAUX_UPSTREAM_ENV], ["fauxExa", FAUX_EXA_ENV], ["fauxBox", FAUX_BOX_ENV], ["fauxEgress", FAUX_EGRESS_ENV]] as const;

/** The test switches a run's process gets, each module path resolved: empty outside tests. */
function fauxEnvOf(options: ServeOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options.harnessTable ? { [HARNESS_TABLE_ENV]: resolve(options.harnessTable) } : {};
  if (!options.faux) return env;
  env[FAUX_ENV] = resolve(options.faux);
  for (const [option, name] of FAUX_SWITCHES) if (options[option]) env[name] = resolve(options[option]);
  return env;
}

/** `tokenFile` is null when `options.token` gave the token; `tokenMade` says this start made the token in it. */
/** `setupUrl`: with accounts and no password yet, the page that sets it (with its code when setup needs one). */
/** `boxesLine`: what the start's banner says of the boxes, in words (place.ts boxesLine). */
export type Serve = { url: string; baseUrl: string; port: number; token: string; tokenFile: string | null; tokenMade: boolean; setupUrl?: string; boxesLine: string; close(): Promise<void>;
  /** What a stop waits on: the runs whose processes still finish their turn, and the longest it waits on them. */
  stopping(): { runs: number; boundMs: number } };

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

/** A private token in `file` (0600), made once and kept; `made` when this call made it. */
async function tokenIn(file: string): Promise<{ token: string; made: boolean }> {
  const known = await readFile(file, "utf8").then((text) => text.trim(), () => "");
  if (known && !/\s/.test(known)) {
    await chmod(file, 0o600);
    return { token: known, made: false };
  }
  const token = `ar_local_${randomBytes(24).toString("base64url")}`;
  // Whole or not there: a reader (the token file a server's record names, a script) never finds it made but empty.
  await writeDurable(file, `${token}\n`, 0o600, undefined, true);
  return { token, made: true };
}

const digest = (text: string) => createHash("sha256").update(text).digest();
/** Why a trigger never messages a run: it has no spend cap, and every turn a trigger drives is capped. */
const NO_CAP = "The run has no spend cap: a trigger only messages a run with one, as every turn it drives is capped.";
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
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
  { method: "DELETE", pattern: /^\/agents\/([^/]+)\/sign-ins\/([^/]+)$/, name: "forgetSignIn" },
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
  { method: "PATCH", pattern: /^\/runs\/([^/]+)$/, name: "raiseRunCap" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/timeline$/, name: "getTimeline" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/messages$/, name: "sendMessage" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/stop$/, name: "stopRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/cancel$/, name: "cancelRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/approvals\/([^/]+)$/, name: "answerApproval" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/archive$/, name: "archiveRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/unarchive$/, name: "unarchiveRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/kill$/, name: "killRun", capability: "runs.kill" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/graph$/, name: "getRunGraph" },
  { method: "POST", pattern: /^\/workflows\/validate$/, name: "validateWorkflow" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/pause$/, name: "pauseRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/resume$/, name: "resumeRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files$/, name: "listRunFiles" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/browser$/, name: "getRunBrowser" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/browser\/hand-back$/, name: "handBackRunBrowser" },
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
  { method: "GET", pattern: /^\/settings\/mcp-servers$/, name: "listMcpServers" },
  { method: "POST", pattern: /^\/settings\/mcp-servers\/preview$/, name: "previewMcpServer" },
  { method: "GET", pattern: /^\/settings\/mcp-servers\/([^/]+)$/, name: "getMcpServer" },
  { method: "PUT", pattern: /^\/settings\/mcp-servers\/([^/]+)$/, name: "saveMcpServer" },
  { method: "DELETE", pattern: /^\/settings\/mcp-servers\/([^/]+)$/, name: "deleteMcpServer" },
  { method: "POST", pattern: /^\/settings\/mcp-servers\/([^/]+)\/refresh$/, name: "refreshMcpServer" },
  { method: "POST", pattern: /^\/settings\/mcp-servers\/([^/]+)\/oauth\/start$/, name: "startMcpOAuth" },
  { method: "GET", pattern: /^\/settings\/mcp-servers\/oauth\/callback$/, name: "mcpOAuthCallback" },
  { method: "GET", pattern: /^\/settings\/mcp-servers\/oauth\/client\.json$/, name: "mcpOAuthClient" },
  { method: "GET", pattern: /^\/settings\/tools$/, name: "getToolSettings" },
  { method: "PUT", pattern: /^\/settings\/tools$/, name: "putToolSettings" },
  { method: "GET", pattern: /^\/settings\/webhook$/, name: "getWebhook" },
  { method: "PUT", pattern: /^\/settings\/webhook$/, name: "saveWebhook" },
  { method: "DELETE", pattern: /^\/settings\/webhook$/, name: "deleteWebhook" },
  { method: "POST", pattern: /^\/settings\/webhook\/test$/, name: "testWebhook" },
  { method: "GET", pattern: /^\/settings\/webhook\/deliveries$/, name: "listWebhookDeliveries" },
  { method: "POST", pattern: /^\/settings\/webhook\/deliveries\/([^/]+)\/redeliver$/, name: "redeliverWebhook" },
  { method: "GET", pattern: /^\/triggers$/, name: "listTriggers" },
  { method: "POST", pattern: /^\/triggers$/, name: "createTrigger" },
  { method: "GET", pattern: /^\/triggers\/([^/]+)$/, name: "getTrigger" },
  { method: "PATCH", pattern: /^\/triggers\/([^/]+)$/, name: "updateTrigger" },
  { method: "DELETE", pattern: /^\/triggers\/([^/]+)$/, name: "deleteTrigger" },
  { method: "POST", pattern: /^\/triggers\/([^/]+)\/fire$/, name: "fireTrigger" },
  { method: "GET", pattern: /^\/triggers\/([^/]+)\/firings$/, name: "listTriggerFirings" },
  { method: "POST", pattern: /^\/triggers\/([^/]+)\/secret$/, name: "rotateTriggerSecret" },
  { method: "GET", pattern: /^\/templates$/, name: "listTemplates" },
  { method: "POST", pattern: /^\/templates\/([^/]+)\/apply$/, name: "applyTemplate" },
  // Answered before the bearer check: the request's signature is its credential.
  { method: "POST", pattern: /^\/hooks\/([^/]+)$/, name: "receiveHook" },
  // Answered before routing (mcp.ts), with the token only: listed here for the document.
  { method: "POST", pattern: /^\/mcp$/, name: "callMcp" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning$/, name: "getAgentLearning" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/notes$/, name: "listLearningNotes" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/log$/, name: "listLearningLog" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)$/, name: "readLearningFile" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)$/, name: "writeLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/retire$/, name: "retireLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/approve$/, name: "approveLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/restore$/, name: "restoreLearningFile" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning$/, name: "getRunLearning" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning\/diff$/, name: "getRunLearningDiff" },
];

/** Where agent `agentId`'s host-owned path is read on this server: its route, when ROUTES has one (the learning API, for
 *  learning/); sign-ins/ only as the agent's `sign_ins`, never a pointer. */
/** A run's files (its work/), refused while it is hidden (runs.ts meta.unshown: this server can't read the browser
 *  sign-in it was handed), as its graph is: a page it saved signed in is what it saw, and no file is cut. */
function filesShown(run: Run): void {
  if (run.meta.unshown) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
}

const ownedReadAt = (agentId: string): OwnedReadAt => (owned) => (owned === SIGN_INS_DIR ? `/v2/agents/${agentId}` : ROUTES.some((r) => r.method === "GET" && r.pattern.test(`/agents/${agentId}/${owned}`)) ? `/v2/agents/${agentId}/${owned}` : undefined);

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
 *  `needs`, a provider's key or another model; and whether that model has a price here (`models.priced`: unpricedModels,
 *  a gateway id serve has no price for), which a run's spend cap needs: null with no model, as nothing is there to price.
 *  Made from `env` alone, so it is remade only when env is. */
type ModelState = { needs: ModelNeeds | null; priced: boolean | null };
async function needsOf(env: NodeJS.ProcessEnv): Promise<ModelState> {
  const chosen = await chooseModel(env, undefined);
  if ("why" in chosen) return { needs: chosen.needs, priced: null };
  return { needs: null, priced: (await unpricedModels(env, undefined)).length === 0 };
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
 *  server's tool settings, what each web tool resolves to (tool-plane.ts); `boxes`, the box offers its places show;
 *  `gradeModel`, its `--grade-model`. */
/** Why a Daytona box has no network although AGENTRUN_BOX_ALLOW names hosts: Daytona refused its domain list (`code`). */
const noListReason = (code: string) =>
  `Daytona did not keep a sandbox's domain list (${code}), so this server's Daytona boxes have no network until it starts again: Daytona takes a domain list on its tier 3 and 4 only. To keep them closed without trying, set ${BOX_ALLOW_ENV}=none`;

export async function capabilities(env: NodeJS.ProcessEnv = withSecrets(process.env), maxRuns = maxRunsOf(env), learning: LearningMode = learningOf(env), toolSettings: ToolSettingsMap = {}, boxes: readonly BoxOffer[] = [], gradeModel?: string) {
  return capabilitiesWith(env, maxRuns, await harnessOffers(env), learning, await needsOf(env), toolSettings, boxes, gradeModel);
}

/** capabilities.learning: whether the caller may approve a note that waits, and what that needs when not. */
type LearningCaps = { grade_model: string | null; pending: true; approve: boolean; approve_needs?: "password" };

/** The capabilities document as `req`'s caller reads it: approving takes the owner's password session alone, so only
 *  that caller reads `approve: true`; every other (a token, a run, accounts off) reads `approve_needs: "password"`. */
export function forCaller<T extends { learning: LearningCaps }>(caps: T, ownerSession: boolean): T {
  return ownerSession ? { ...caps, learning: { grade_model: caps.learning.grade_model, pending: caps.learning.pending, approve: true } } : caps;
}

/** The capabilities document from offers already resolved, under the server's learning switch, tool settings and box
 *  offers: cheap, made again after each key or tool-settings write with the offers the server holds; and `needs` as
 *  needsOf says it for a revision that names no model (null when it runs). */
function capabilitiesWith(env: NodeJS.ProcessEnv, maxRuns: number, harnesses: HarnessCapability[], learning: LearningMode, { needs, priced }: ModelState, toolSettings: ToolSettingsMap, boxes: readonly BoxOffer[], gradeModel?: string, refused: Readonly<Record<string, string>> = {}) {
  const models = { ...modelSource(env), ready: needs === null, needs, priced };
  // Both limits apply: the cap on the count, and the memory each run reserves (host.ts).
  const memory = hostMemory();
  // The browser's key is its vendor's row: Kernel's where Kernel is picked or resolved (tool-plane.ts browserKeyRow).
  const keyFor = (tool: { name: string; provider?: string; resolves?: Record<string, string> }) => (tool.name === "browser" ? browserKeyRow(tool.provider, tool.resolves?.[DEFAULT_HARNESS]) : keyOf(tool.name));
  const tools = toolsView(env, toolSettings, noBoxReason(boxes), refused).map((tool) => (keyFor(tool) ? { ...tool, key: keyFor(tool) } : tool));
  const browser = tools.find((tool) => tool.name === "browser");
  return {
    backend: "local",
    contract: CONTRACT,
    server: { name: "@parcha/agentrun-serve", version: VERSION, platform: process.platform },
    runtimes: ["pi-durable-disk"],
    /** The harnesses a revision may name (`definition.harness`), whether this server runs each, and how many at once. */
    // `keys`, what a model key would unlock, is the key rows' (listToolKeys), never served here.
    harnesses: harnesses.map(({ keys: _keys, ...offer }) => ({ ...offer, max_concurrent_runs: Math.min(maxRuns, runsThatFit(offer.id, memory)) })),
    /** The places a revision may name (`definition.place`), this host's default, and whether this server has each box. */
    places: placesOf(boxes, boxAllowOf(env)),
    models,
    /** What grades a run's proposed notes: the model this server names for it (learning.ts gradeModelOf), or null when
     *  each run is graded on its agent's own model; and `pending`: a risky rule, the user's or the run's own, is kept to
     *  wait for its owner's OK, served to no run; `approve`: whether the caller can approve one, which takes the owner's
     *  password session (forCaller), and `approve_needs` when not. */
    learning: { grade_model: gradeModelOf(env, gradeModel) ?? null, pending: true, approve: false, approve_needs: "password" } as LearningCaps,
    /** Every tool a revision may name (the closed table in tools.ts): available here, or the variables it is missing; a
     *  web tool, what it resolves to on each harness under this server's tool settings; `key`, the tool key that unlocks
     *  it (tool-keys.ts), when one does. */
    tools,
    /** How this server holds its secrets (secrets.ts, the launcher), and what that does not cover. */
    secrets: {
      names: [...SECRET_NAMES],
      handoff: "pipe",
      condition: "Started by its launcher (the package's agentrun-serve, the image's entrypoint), the server takes each secret named here over a pipe and holds it in memory only, and a run's process gets, over a pipe of its own, a tool key only when its revision names a tool the key unlocks and a model key only when its model needs it: a pi run its model's provider's (per tier for a workflow), or the gateway's behind AGENT_MODEL_BASE_URL; a codex run OPENAI_API_KEY, or the gateway's; a claude-agent run ANTHROPIC_API_KEY. It never gets the server's own (its token, the seal key, the boxes' keys), and the decision keys a run's decision nodes need, and Parallel's where its web_fetch or web_search resolves to Parallel, and no other, go on a descriptor of their own: none of them is in any process's environment or command line. No run's environment holds any variable named like a key (a KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASS, PAT, CREDENTIAL, CREDENTIALS or DSN segment, or a last PWD after another), on this list or not; one not on it stays in the server's own. The launcher runs before any run's process exists; the image starts it as PID 1. Started another way (node dist/cli.js), the server reads them from its environment, where a process of its user can read them.",
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
      usage: { basis: "estimate", meters: ["tokens", "tools", "browser_time", "learning"] },
      efforts: [...EFFORTS],
      thinking: [...THINKING_LEVELS],
      /** The browser a run's `browser` tool drives: the vendor it resolves to under the server's settings when the tool is
       *  available here (tools[]), Browserbase's or Kernel's, else none. */
      browser: browser?.available ? ((browser as { resolves?: Record<string, string> }).resolves?.[DEFAULT_HARNESS] === "kernel" ? "kernel" : "browserbase") : "none",
      /** A tool setting's `permission` (definition.tool_settings, /v2/settings/tools): allow, ask or deny, which the tool
       *  gate holds every tool call to (tool-gate.ts); an ask is answered at POST /runs/{id}/approvals/{approval_id}. */
      tool_permissions: true,
      /** The owner watches a run's browser live (GET /runs/{id}/browser, browser-live.ts), takes it over from the viewer and
       *  hands it back, and answers the agent's ask for them (POST /runs/{id}/browser/hand-back, browser-person.ts). */
      browser_live: { read_only: false, take_over: true, ask: true },
      /** An agent's browser stays signed in between its runs (sign-ins.ts): with a seal key to keep each pointer under, and a
       *  browser vendor here (Browserbase's or Kernel's; local Chrome keeps none). */
      sign_ins: sealKeyOf(env[SEAL_KEY_ENV]) !== undefined && tools.some((tool) => tool.name === "browser" && tool.available),
      vault: false,
      query: false,
      /** GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept sealed under the launcher's seal key
       *  (tool-keys.ts); with none handed over, nothing is kept, never in the clear. */
      tool_keys: { routes: true, at_rest: sealKeyOf(env[SEAL_KEY_ENV]) ? "sealed" : "unavailable" },
      /** /settings/mcp-servers: remote MCP servers previewed and saved, each credential sealed under the same seal key
       *  (mcp-servers.ts); with none, only servers that take no credential are kept. */
      mcp_client: { transports: ["streamable-http"], auth: [...MCP_AUTH_TYPES], at_rest: sealKeyOf(env[SEAL_KEY_ENV]) ? "sealed" : "unavailable", harnesses: [...MCP_HARNESSES] },
      /** This server's learning switch (`--learning`): on, a run learns when its agent says `learning: true`; off, none does. */
      learning,
      /** /settings/webhook: one URL POSTed, signed by the Standard Webhooks spec, when a run needs its person and when it
       *  ends (webhooks.ts); its secret kept sealed under the same seal key, so with none no webhook is set. */
      webhooks: { routes: true, events: [...WEBHOOK_EVENTS], signing: "standard-webhooks/v1", at_rest: sealKeyOf(env[SEAL_KEY_ENV]) ? "sealed" : "unavailable" },
      /** /triggers: what starts an agent's capped runs with no caller (triggers.ts). */
      triggers: { routes: true, sources: [...SOURCE_KINDS], targets: [...TARGET_KINDS], min_every_s: MIN_EVERY_S, history_kept: HISTORY_KEPT, catchup_window_s: CATCHUP_WINDOW_S, failures_to_pause: FAILURES_TO_PAUSE, webhook: { signing: "standard-webhooks/v1", signatures: [...SCHEME_NAMES], tolerance_s: HOOK_TOLERANCE_S, max_body_bytes: webhook.push!.maxBodyBytes, payload_kept_bytes: PAYLOAD_KEPT_BYTES, at_rest: sealKeyOf(env[SEAL_KEY_ENV]) ? "sealed" : "unavailable" } },
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

/** Why the data directory is one an earlier version wrote, which keeps its runs outside the disk: a `runs/` folder at
 *  its top (0.1.0-beta.27 to this version's last, `<data>/runs/<id>/`), or a store.sqlite of store version 1. This
 *  version keeps every run on the disk (`<data>/disk/agents/<agent>/runs/<run>/`), and moves nothing: undefined when
 *  neither is there. */
async function oldLayout(data: string): Promise<string | undefined> {
  if (await stat(join(data, "runs")).then((info) => info.isDirectory(), () => false)) return `${join(data, "runs")} holds runs in an earlier version's layout`;
  const file = join(data, STORE_FILE);
  if (!(await stat(file).then((info) => info.isFile(), () => false))) return undefined;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    return version === 1 ? `${file} is an earlier version's store (store version 1)` : undefined;
  } finally {
    db.close();
  }
}

export async function startServe(options: ServeOptions): Promise<Serve> {
  // A harness table module is the server's to name, from `harnessTable` alone, for itself and its runs: one in its own
  // environment (an operator's export, a leftover) never loads, wherever the server reads its environment.
  delete process.env[HARNESS_TABLE_ENV];
  await mkdir(resolve(options.data), { recursive: true, mode: 0o700 });
  // Canonical once, here: a box's mount source below it must then be its own canonical path, through no link (run-box.ts).
  const data = await realpath(resolve(options.data));
  // What only reads and refuses comes first: a start refused for it creates nothing in the data root, server.lock included.
  const homes = await oldHomes(data);
  if (homes.length) {
    const named = homes.length > 5 ? [...homes.slice(0, 5), `and ${homes.length - 5} more`] : homes;
    throw new Error(`this data directory holds agent homes from AgentRun Server 0.1.0-beta.26 or earlier (${named.join(", ")}), which this version does not read: started here, it would show none of their agents or runs. Keep them with the earlier version, or move those directories out of ${data} to start this one; see "Upgrading from 0.1.0-beta.26" in the serve README.`);
  }
  const old = await oldLayout(data);
  if (old) throw new Error(`this data directory was written by an earlier version of AgentRun Server, which kept its runs outside the disk (${old}): this version keeps every run under ${join(data, "disk")} and does not read or move the old ones. Keep this directory with the earlier version, or start this one on a new data directory (an empty folder, or a new volume).`);
  if (options.token !== undefined && (options.token.length < 32 || /\s/.test(options.token))) throw new Error("the token must be 32 characters or more, with no whitespace");
  if (options.drainTimeout !== undefined && durationMs(options.drainTimeout) === undefined) throw new Error(`the drain timeout ${options.drainTimeout} is not a duration such as 8s`);
  enabledBoxes(process.env);
  boxLimitsOf(process.env);
  const boxAllow = boxAllowOf(process.env);
  const maxRuns = maxRunsOf(process.env, options.maxRuns);
  const learning = learningOf(process.env, options.learning);
  const learningBudget = learningBudgetOf(process.env, options.learningBudget);
  const minFreeMib = process.env.AGENTRUN_MIN_FREE_MB ? Number(process.env.AGENTRUN_MIN_FREE_MB) : MIN_FREE_MIB;
  if (!(Number.isFinite(minFreeMib) && minFreeMib >= 0)) throw new Error("AGENTRUN_MIN_FREE_MB is a number of MiB, 0 or more");
  const minFreeBytes = options.minFreeBytes ?? minFreeMib * 2 ** 20;
  // The template packages, each checked whole (templates.ts readPackage): a broken one stops the start.
  const templates = readPackages(options.templates);
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
    return await startHolding(options, data, lock, { maxRuns, minFreeBytes, learning, learningBudget, boxAllow, templates }, stops);
  } catch (error) {
    for (const stop of stops) await stop().catch(() => undefined);
    lock.release();
    throw error;
  }
}

async function startHolding(options: ServeOptions, data: string, lock: ServerLock, checked: { maxRuns: number; minFreeBytes: number; learning: LearningMode; learningBudget: number; boxAllow: readonly string[] | "none"; templates: Package[] }, stops: Array<() => Promise<void>>): Promise<Serve> {
  const { maxRuns, minFreeBytes, learning, learningBudget, boxAllow, templates } = checked;
  /** What an agent's view says of its learning: how many learned items wait for its owner's OK, for an agent that learns
   *  on this server (learning on, its current revision `learning: true`); none for another, or when the count cannot be
   *  read (the view never fails for it). */
  const learningOfAgent = async (entry: { agent: { id: string }; revision?: { kind: string; body: unknown } | null }): Promise<{ pending: number } | undefined> => {
    if (learning === "off" || entry.revision?.kind !== "agentic" || (entry.revision.body as { learning?: unknown }).learning !== true) return undefined;
    const pending = await pendingCount(data, entry.agent.id);
    return pending === undefined ? undefined : { pending };
  };
  const tokenFile = options.token === undefined ? join(data, TOKEN_FILE) : null;
  const stored = options.token === undefined ? await tokenIn(tokenFile!) : undefined;
  const token = options.token ?? stored!.token;
  const doorTokenFile = join(data, DOOR_TOKEN_FILE);
  const { token: doorToken } = await tokenIn(doorTokenFile);
  const log = options.log;
  const quiet = process.env.AGENTRUN_LOG === "quiet";
  const authFailed = (route: string, reason: string) => log?.(logLine("auth_failed", { route, reason }));
  /** Every secret this server never shows, read at each call, so one made, saved or rotated is cut at once: the host's,
   *  wherever its launcher put them, and the keys a person saved on it (read through `stored`, storedKeys below, by
   *  default), its tokens, and every one it holds (server-secrets.ts). What a run shows (runs.ts), what its learning
   *  keeps (learning-run.ts), a person's note, every learning text read, and the VM relay's errors are cut of it. */
  const serverSecrets = (stored: StoredKeys = storedKeys) => [...hostSecrets(process.env, stored), ...(secretStores?.values() ?? [])];
  // The server's own secrets, and each trigger source's sealed settings, opened below once the environment is read;
  // shown nowhere.
  let secretStores: ServerSecrets | undefined;
  let triggerSettings: Map<string, SealedSettings> = new Map();
  const base = { ...withoutFaux(process.env), [DATA_ENV]: data, ...(options.allowCodeNodes ? { [CODE_NODES_ENV]: "1" } : {}), ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}), ...(options.harnessTable ? { [HARNESS_TABLE_ENV]: resolve(options.harnessTable) } : {}) };
  // Which fields are the server's is read from what it is started with alone: handed the saved keys too, ToolKeys would
  // call each the server's, and none could be deleted.
  const toolKeys = new ToolKeys(data, withSecrets(base, "own"), (fields) => (log ? log(logLine("tool_keys", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("tool_keys", fields)}\n`)));
  // A key's check as it is saved (key-check.ts) goes to its provider; under faux only to the tests' fake for that provider,
  // the one its runs are given (monid, Parallel, TypeSafe's Jev), never to the network: one with no fake is not checked.
  const fakes: Record<string, string | undefined> = { monid: options.fauxMonid, parallel: options.fauxParallel, typesafe: options.fauxJev, browserbase: options.fauxBrowserbase, kernel: options.fauxKernel };
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
  const mcpServers = new McpServers(data, withSecrets(base, "own"), VERSION);
  // What a run's grants are checked against, its pin made from and its credentials read from (runs.ts, runnable.ts).
  const mcpSource: McpServerSource = {
    server: (name) => {
      try {
        const saved = mcpServers.get(name);
        return { url: saved.url, tools: saved.tools.map(({ name: tool, title, description, input_schema, annotations }) => ({ name: tool, ...(title ? { title } : {}), ...(description ? { description } : {}), inputSchema: input_schema as Record<string, unknown>, ...(annotations ? { annotations: annotations as Record<string, unknown> } : {}) })), ...(saved.prices ? { prices: saved.prices } : {}) };
      } catch {
        return undefined;
      }
    },
    headers: (name) => mcpServers.headers(name),
    refresh: (name) => mcpServers.headersForRun(name).then(() => undefined, () => undefined),
  };
  // Each with whether it can be granted: a known meta tool can't (mcp-meta.ts).
  const mcpTools = (server: string) => {
    const saved = mcpSource.server(server);
    return saved?.tools.map((tool) => {
      const meta = metaToolOf(saved.url, tool.name);
      return meta ? { ...tool, grantable: false as const, reason: meta.reason } : tool;
    });
  };
  // The server's tool settings, beside the agent store: capabilities say what they resolve to, again after a PUT.
  const settings = new ToolSettings(data);
  mcpServers.toolSettings = () => settings.get();
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
  let needs: ModelState = await needsOf(env);
  // The box offers are probed once, below, before the first reading is made.
  // With accounts off no one can answer an ask (the answer route takes the owner's session alone): each tool ask is
  // offered for says it needs the password sign-in, as learning's approve does.
  const askNeeds = (made: ReturnType<typeof capabilitiesWith>) => (options.accounts ? made : { ...made, tools: made.tools.map((tool) => (tool.permissions.includes("ask") ? { ...tool, ask_needs: "password" as const } : tool)) });
  const recompose = () => void (caps = askNeeds(capabilitiesWith(env, maxRuns, offers, learning, needs, settings.get(), boxOffers, options.gradeModel, toolKeys.refused())));
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
  // The boxes AGENTRUN_BOXES lists, docker when it is not set, each probed once (boxes.ts); runs execute in Docker's (place.ts). Under --faux, a faux
  // box stands in for Docker, and nothing asks Docker.
  // Under --faux, the tests' fake stands in for the VM provider's SDK (startServe's `fauxVm`), never the provider.
  const boxes = await boxRegistry(env, options.faux && options.fauxVm ? { vmSdk: () => import(pathToFileURL(resolve(options.fauxVm!)).href) as Promise<Record<string, unknown>> } : {});
  const fauxBox = options.faux && options.fauxBox ? await fauxBoxes(resolve(options.fauxBox), data) : undefined;
  // The Docker box's image, asked of Docker now and pulled in the background when Docker has none (box-image.ts): docker
  // is preparing until it is in, and unavailable if the pull fails. Its record tells the run's processes; with no Docker
  // box here there is none, so no run waits on one an earlier start left.
  let image: DockerImage | undefined;
  // What a Docker box's programs reach, resolved once here (run-box.ts boxNetworkOf): the setting's list, on a Docker
  // daemon of this Linux machine's own; else none, and why. A run's process gets the list or none (RUN_BOX_ALLOW_ENV).
  // Under --faux, the mountinfo a test gives (fauxMountinfo, or FAUX_MOUNTINFO_ENV in the process's own environment, which
  // `env` leaves out: a server under test in a container names its own /proc/self/mountinfo there); with none, a faux
  // server is on a host.
  const fauxMountinfo = options.faux ? (options.fauxMountinfo ?? process.env[FAUX_MOUNTINFO_ENV]) : undefined;
  // Where Docker has this server's files (box-paths.ts): its own, on a host; its container's mount of the data directory,
  // for a server in a container given Docker's socket; or none, and docker is unavailable, saying why. Under --faux, a
  // host's unless the test gives a container's mountinfo.
  // Only on Linux: a container of a Docker's own is a Linux one, and a Mac server's boxes take its proxy container's network
  // (box-egress-vm.ts), never a volume's subpath of its data.
  const platform = options.faux && options.fauxPlatform ? options.fauxPlatform : process.platform;
  const dockerPaths: DockerPaths = fauxBox || !boxes.provider("docker") || platform !== "linux" ? { here: true } : options.faux ? (fauxMountinfo ? await dockerPathsOf(env, data, { mountinfo: await readFile(fauxMountinfo, "utf8"), inContainer: true }) : { here: true }) : await dockerPathsOf(env, data);
  const boxPaths = "paths" in dockerPaths ? dockerPaths.paths : undefined;
  const egressParent = boxPaths ? egressParentOf(data) : undefined;
  if ("reason" in dockerPaths) log?.(logLine("box_paths", { reason: dockerPaths.reason }));
  const boxNetwork: DockerNetwork = fauxBox ? { allow: "none", reason: "a faux box (tests)" } : !boxes.provider("docker") ? { allow: "none", reason: "no Docker box on this server" } : "reason" in dockerPaths ? { allow: "none", reason: dockerPaths.reason } : egressParent && egressParentTooLong(egressParent) ? { allow: "none", reason: `the data directory's path is too long for a box's network socket (${egressParent} is over ${MAX_EGRESS_PARENT} bytes): give the server a shorter --data` } : await boxNetworkOf(env, { ...(boxPaths ? { mapped: true } : {}), ...(options.faux && options.fauxPlatform ? { platform: options.fauxPlatform } : {}) });
  // The proxy directories runs that are gone left in /tmp, or, in a container, on the data directory's mount
  // (box-egress.ts): a live run's, any server's, stays.
  if (!fauxBox && boxes.provider("docker")) await sweepEgressDirs(undefined, undefined, egressParent).catch(() => 0);
  // On a Mac whose Docker runs in a VM this server knows, the list is served by one proxy container inside that VM
  // (box-egress-vm.ts): a box's network is the list once it is ready, and none, saying why, until then or when it can't start.
  let egress: EgressContainer | undefined;
  const dockerNetwork = (offer: BoxOffer): BoxOffer => {
    if (!offer.available) return offer;
    if ("reason" in dockerPaths) return { id: offer.id, available: false, state: "unavailable", reason: dockerPaths.reason };
    if (boxNetwork.allow === "none") return { ...offer, network: "none", network_reason: boxNetwork.reason };
    const proxy = egress?.state();
    return proxy && proxy.state !== "ready" ? { ...offer, network: "none", network_reason: proxy.reason } : { ...offer, network: "allowlist" };
  };
  // A Daytona box reaches the hosts AGENTRUN_BOX_ALLOW names, through Daytona's domain list, until Daytona cannot keep
  // one here (an organization whose tier takes none): from then on each is made with no network, and capabilities say why.
  let daytonaNoList: string | undefined;
  const daytonaNetwork = (offer: BoxOffer): BoxOffer =>
    !offer.available ? offer : boxAllow === "none" ? { ...offer, network: "none" } : daytonaNoList ? { ...offer, network: "none", network_reason: noListReason(daytonaNoList) } : { ...offer, network: "allowlist" };
  // The VM box has no network whatever AGENTRUN_BOX_ALLOW names: its provider takes a host list, but has no read of a
  // box's list back, so the server cannot check one held (run-box.ts ensureRemoteBox makes it blocked). Said, with why.
  const vmNetwork = (offer: BoxOffer): BoxOffer => (!offer.available ? offer : boxAllow === "none" ? { ...offer, network: "none" } : { ...offer, network: "none", network_reason: VM_NO_LIST });
  const offersNow = (): BoxOffer[] => boxes.offers().map((offer) => (fauxBox && offer.id === "docker" ? dockerNetwork({ id: "docker", available: true, reason: "a faux box (tests)" }) : offer.id === "docker" ? dockerNetwork(image ? withImage(offer, image.state()) : offer) : offer.id === "daytona" ? daytonaNetwork(offer) : offer.id === VM_PROVIDER.id ? vmNetwork(offer) : offer));
  const imageLog = (state: ImageState, more: Record<string, number> = {}) => log?.(logLine("box_image", { image: image!.image, state: state.state, ...more, ...("reason" in state ? { reason: state.reason } : {}) }));
  let boxOffers: BoxOffer[] = offersNow();
  const boxImage = !fauxBox && boxes.provider("docker") ? boxImageOf(env) : undefined;
  if (boxImage) {
    image = await dockerImage(env, data, boxImage, {
      warn: (message) => (log ? log(logLine("box_image", { image: boxImage, warning: message })) : void process.stderr.write(`agentrun-serve: ${message}\n`)),
      onChange: (state, ms) => {
        boxOffers = offersNow();
        imageLog(state, { ms });
        options.onBoxImage?.(state);
        // The box's state is in caps alone, not in the offers: recomposed now, or, while the start's probe of the offers
        // has not ended, by that probe, which reads the box offers when it does.
        if (offers) recompose();
      },
    });
    stops.push(async () => void (await image?.close()));
    options.onBoxImage?.(image.state());
  } else await clearImage(data);
  boxOffers = offersNow();
  const runBoxes = fauxBox ?? boxes.provider("docker");
  // Daytona's boxes are made, seeded, pulled and destroyed here, with the key this server holds; a run's process reaches
  // its own through the relay below, which holds the key for it (box-relay.ts).
  const remoteBoxes = boxes.provider("daytona");
  // And the VM box's, the same way, with this server's SDK client: the relay's VM half makes a run's calls with it.
  const vmBoxes = boxes.provider(VM_PROVIDER.id);
  const vmClient = boxes.vmClient();
  // What the provider says in an error is cut of every value this server holds (the VM token among them) before a run's
  // process sees it.
  const vmSecrets = () => [...serverSecrets(), ...VM_PROVIDER.keys.map((name) => env[name] ?? "").filter(Boolean)];
  const vmRelayHalf = vmBoxes && vmClient ? vmRelay(vmClient as VmSdk, vmSecrets) : undefined;
  const vmLimits = (() => {
    const limits = boxLimitsOf(env);
    return { cpus: limits.cpus, memoryMb: memoryMbOf(limits.memory) };
  })();
  // Daytona could not keep a run's box's domain list: said in the log and in capabilities, which recompose now.
  // Daytona's own words go to the log, so a refusal for another cause is not taken silently for a tier that takes no list.
  const onNoBoxList = (code: string, message: string) => {
    daytonaNoList = code;
    log?.(logLine("box_network", { box: "daytona", network: "none", refused: code, message }));
    boxOffers = offersNow();
    if (offers) recompose();
  };
  if (boxNetwork.allow !== "none" && boxNetwork.vm) {
    const allow = boxNetwork.allow;
    const egressLog = (state: ReturnType<EgressContainer["state"]>) => log?.(logLine("box_egress", { runtime: boxNetwork.vm!, state: state.state, ...("reason" in state ? { reason: state.reason } : {}) }));
    egress = await startEgressContainer({
      env, data, allow, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0,
      warn: (message) => (log ? log(logLine("box_egress", { runtime: boxNetwork.vm!, warning: message })) : void process.stderr.write(`agentrun-serve: ${message}\n`)),
      onChange: (state) => {
        egressLog(state);
        boxOffers = offersNow();
        if (offers) recompose();
      },
    });
    stops.push(() => egress!.close());
    egressLog(egress.state());
    boxOffers = offersNow();
  }
  log?.(logLine("boxes", boxesLog(boxOffers, enabledBoxes(env))));
  if (image) imageLog(image.state());
  const adapters = options.triggerAdapters ?? TRIGGER_ADAPTERS;
  const openapi = openapiDocument((operationId) => ROUTES.find((r) => r.name === operationId)?.capability, adapters);
  const agents = new Agents(data);
  ({ secrets: secretStores, settings: triggerSettings } = openServerSecrets(data, env, adapters, (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`))));
  secretStores.add("server", () => [token, doorToken]);
  // Each agent's saved sign-ins (sign-ins.ts), under the seal key the tool keys are kept under: its vendor's calls on the
  // server's keys (under faux, the vendor's fake alone), a lease held while the run it names has not ended, and a
  // pointer never forgotten while a run it was handed is going (runs.ts handedTo; `runs` is made below, before any request).
  const signIns = new SignIns(data, sealKeyOf(withSecrets(base, "own")[SEAL_KEY_ENV]), vendorsOver(() => env, checkFetch), async (runId) => (await agents.request(() => agents.store.readRun(runId)))?.state === "running", { handedTo: (agentId: string, hash: string | undefined): Promise<string | undefined> => runs.handedTo(agentId, hash) });
  const webhooks = new Webhooks(data, env, (fields) => (log ? log(logLine("webhook", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("webhook", fields)}\n`)), options.webhookRetryMs);
  // The outbound webhook's secret, as it stands (set by a PUT, gone with a DELETE), and each it held before.
  secretStores.add("webhook", () => webhooks.signingSecrets());
  stops.push(() => webhooks.close());
  const uploads = new Uploads(join(data, UPLOADS_DIR));
  // Under the data directory's lock and before this server answers anything, so no PUT of its own is in flight: an upload
  // temp file found now is a crashed one's.
  const swept = await uploads.sweep();
  if (swept > 0) log?.(logLine("uploads_swept", { removed: swept }));
  const documents = options.documents ?? process.env[DOCUMENTS_ENV];
  if (documents !== undefined && !(await stat(documents).then((info) => info.isDirectory(), () => false))) throw new Error(`the documents directory ${documents} is not a directory`);
  // The CLI harnesses, each installed on first use into the data's harnesses directory (harness-install.ts): one install
  // of each at a time, which every run on that harness, and the save of an agent on it, waits for or starts; once one is
  // in, the offers are probed again, so capabilities no longer say it installs on first use. Each is its table entry's
  // `installs` (a test's stand-in has none).
  // Claude Code as an earlier build installed it, at the top of the harnesses directory itself (read-only): removed once,
  // before the first install, which then goes in beside nothing. Any other layout is left as it is.
  let flat: Promise<void> | undefined;
  const flatRemoved = () =>
    (flat ??= removeFlatInstall(harnessesOf(data)).then(
      (removed) => void (removed && log?.(logLine("harness_install_removed", { dir: harnessesOf(data), said: `removed the earlier Claude Code install at ${harnessesOf(data)}: it installs again under harnesses/claude-agent` }))),
      (error: unknown) => ((flat = undefined), Promise.reject(error)),
    ));
  const installed = HARNESSES.flatMap((id) => {
    const harness = harnessOf(base, id);
    return harness?.installs && harness.pins ? [{ entry: harness.installs, pins: harness.pins }] : [];
  });
  const installs: Record<string, HarnessInstall> = Object.fromEntries(installed.map(({ entry, pins }) => {
    const lock = options.harnessLocks?.[entry.id];
    // npm past its SIGTERM's grace (it waits on a tarball once it writes): killed, and the line says so.
    const onKilled = () => log?.(logLine("harness_install_killed", { harness: entry.id, said: `npm did not stop within ${NPM_STOP_GRACE_MS / 1000} s of SIGTERM; killed` }));
    return [entry.id, new HarnessInstall(entry, installDirOf(data, entry.id), pins, async (entry, dir, pins, signal) => (await flatRemoved(), npmInstall(entry, dir, pins, { signal, onKilled, ...(lock ? { lock } : {}) })), (ms) => {
      log?.(logLine("harness_installed", { harness: entry.id, ms, dir: installDirOf(data, entry.id) }));
      void probe(`${entry.id}_installed`).catch(() => undefined);
    })];
  }));
  // A capped start prices each OpenRouter Decisions model a workflow pins (runnable.ts) from OpenRouter's public catalog,
  // read once for this server (and again after a read that failed), through the faux one under --faux.
  let pricing: Promise<{ priceOf(model: string): Promise<unknown> }> | undefined;
  const decisionPrice = async (model: string): Promise<unknown> => {
    const making = (pricing ??= (async () => {
      const [{ openrouterProvider }, faux] = await Promise.all([import("@parcha/agentrun-decisions"), fauxFetch(fauxEnvOf(options), FAUX_OPENROUTER_ENV)]);
      return openrouterProvider(faux ? { fetch: faux } : {});
    })());
    // One that could not be made is made again next time: a rejection is never kept.
    const provider = await making.catch((error: unknown) => { if (pricing === making) pricing = undefined; throw error; });
    return provider.priceOf(model);
  };
  const runs = new Runs({ installs, dockerAllow: boxNetwork.allow, ...(egress?.volume ? { dockerVolume: egress.volume } : {}), ...(boxPaths ? { dockerPaths: boxPaths } : {}), agents, token, storedKeys, mcpServers: mcpSource, doorTokenFile, doorToken, learning, learningBudget, ...(documents ? { documents: resolve(documents) } : {}), fauxEnv: fauxEnvOf(options), toolSettings: () => settings.get(), ...(runBoxes ? { runBoxes } : {}), ...(remoteBoxes ? { remoteBoxes } : {}), ...(vmBoxes && vmRelayHalf ? { vmBoxes, vmLimits, vmRelay: vmRelayHalf } : {}), ...(remoteBoxes && daytonaApi(env) ? { remoteApi: daytonaApi(env)! } : {}), ...(remoteBoxes ? { boxAllow, onNoBoxList } : {}), ...(options.drainTimeout ? { drainTimeout: options.drainTimeout } : {}), ...(options.carryBackRetry ? { carryBackRetry: options.carryBackRetry } : {}), maxRuns, ...(options.box ? { box: { host: options.box, quarantine: await Quarantine.open(join(data, BOX_QUARANTINE)) } } : {}), ...(options.settleRetryMs ? { settleRetryMs: options.settleRetryMs } : {}), ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}), ...(options.openTimeoutMs ? { openTimeoutMs: options.openTimeoutMs } : {}), ...(options.faux && options.fauxHandedNonce ? { fauxHandedNonce: options.fauxHandedNonce } : {}), ...(options.reflectTimeoutMs ? { reflectTimeoutMs: options.reflectTimeoutMs } : {}), ...(options.gradeTimeoutMs ? { gradeTimeoutMs: options.gradeTimeoutMs } : {}), ...(options.gradeModel ? { gradeModel: options.gradeModel } : {}), ...(log ? { log: (event: string, fields: Record<string, string | number>) => log(logLine(event, fields)) } : {}), notify: (event, run, marker) => webhooks.emit(event, run, marker), serverSecrets, signIns, approvers: options.accounts === true });
  const daytona = daytonaApi(env);
  const relay = (remoteBoxes && daytona) || vmRelayHalf ? await startBoxRelay({ root: data, tokenOf: (id) => runs.relayToken(id), ...(remoteBoxes && daytona ? daytona : {}), ...(vmRelayHalf ? { vm: vmRelayHalf } : {}), serves: (id) => runs.servesBox(id), ensure: (id) => runs.ensureBox(id) }) : undefined;
  if (relay) stops.push(() => relay.close());
  const expected = digest(`Bearer ${token}`);
  if (options.beforeAbort) runs.beforeAbort = options.beforeAbort;
  if (options.beforeReopenLaunch) runs.beforeReopenLaunch = options.beforeReopenLaunch;
  if (options.beforeRaiseLaunch) runs.beforeRaiseLaunch = options.beforeRaiseLaunch;
  if (options.hostMemory) runs.memory = options.hostMemory;
  if (options.onPauseCheck) runs.onPauseCheck = options.onPauseCheck;
  if (options.beforeSubmit) runs.beforeSubmit = options.beforeSubmit;
  if (options.beforeMetaSave) runs.beforeMetaSave = options.beforeMetaSave;
  if (options.onRunLoad) runs.onRunLoad = options.onRunLoad;
  if (options.messageOrigin) runs.messageOrigin = options.messageOrigin;
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
  // The owner's open live views (browser-live.ts): each closes once no session that let it in holds.
  const viewers = new LiveViewers();
  // A saved key is read by name from here, past the checks that refuse a start and before any run (a recovered one too)
  // is launched: each launch hands over what is saved then. One server in a process reads them: the last started.
  await probe("start");
  // Under faux, a key the server starts with is checked only against a check's own fake (fauxBrowserbase,
  // fauxMonidCheck, fauxKernel): the fakes the runs use (monid, Parallel, Jev) see the runs' calls alone, and a key with no check fake
  // is not checked.
  const checkFakes: Record<string, string | undefined> = { browserbase: options.fauxBrowserbase, monid: options.fauxMonidCheck, kernel: options.fauxKernel };
  const startFetch = async (id: string): Promise<typeof fetch | null> => {
    if (!options.faux) return fetch;
    const fake = checkFakes[id];
    return fake ? ((await import(pathToFileURL(resolve(fake)).href)) as { default: typeof fetch }).default : null;
  };
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
      // An end's notice from its row as the agent store holds it now and its serve.json alone, as the run list reads an
      // ended run (summaryOfRow): never its own store, whose read can fail, so a busy store loses no end. The same body a
      // live end's notice has.
      await webhooks.catchUp(rows, async (id) => {
        // Its folder on the disk by its row's agent, which a run never changes: the listed row's, or the store's for a run
        // listed after the list.
        const listed = rows.find((row) => row.id === id) ?? (await agents.request(() => agents.store.readRun(id)));
        if (!listed) return null;
        const meta = await readJson(join(runDirIn(agents.dir, listed.agent, id), RUN_META));
        // Read last, so nothing but this read stands between the run as it is now and its end's queuing.
        const row = await agents.request(() => agents.store.readRun(id));
        if (!row) return null;
        const notice = { run_id: id, agent_id: row.agent, status: await runs.statusOfRow(row), title: isObject(meta) && typeof meta.title === "string" ? meta.title : "" };
        return { state: row.state, endedAt: row.endedAt, notice };
      });
    })
    .catch((error: Error) => void process.stderr.write(`agentrun-serve: the webhook's catch-up: ${error.message}\n`));

  // Schedules: each firing starts its run as POST /agents/{id}/runs does, capped, under the firing's key (triggers.ts).
  // Firings an earlier server left due are driven again now, beside the recovery above.
  const triggers: Triggers = new Triggers(data, {
    clock: options.triggerClock,
    adapters,
    say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)),
    async targetIssues(target) {
      if (target.kind === "message_run") {
        const run = await runs.get(target.run_id);
        if (!run) return [{ field: "target.run_id", reason: "not_found", message: `no run ${target.run_id}` }];
        if (run.kind === "workflow") return [{ field: "target.run_id", reason: "not_allowed", message: "A workflow run takes no messages here." }];
        return run.meta.max_cost_usd === undefined ? [{ field: "target.run_id", reason: "not_allowed", message: NO_CAP }] : [];
      }
      const entry = await agents.get(target.agent_id);
      if (!entry) return [{ field: "target.agent_id", reason: "not_found", message: `no agent ${target.agent_id}` }];
      if (!entry.revision) return [{ field: "target.agent_id", reason: "invalid", message: `the agent ${target.agent_id} has no current revision` }];
      const uncapped = target.max_cost_usd === undefined && entry.revision.body.maxCostUsd === undefined ? [{ field: "target.max_cost_usd", reason: "missing", message: `Every run a trigger starts is capped: give the target a max_cost_usd or set the agent's (the agent ${target.agent_id} has none).` }] : [];
      return [...uncapped, ...(await explainRun(await inputIssuesOf(entry.revision, target.input), { input: target.input }, entry.revision)).map((issue) => ({ ...issue, field: `target.${issue.field}` }))];
    },
    async start(target, input, trigger, from) {
      const entry = await needAgent(target.agent_id);
      // The target's cap, else the agent's default as it stands now: a run a trigger starts is never uncapped.
      const run = await startRunOf(entry, { input, ...(target.max_cost_usd !== undefined ? { max_cost_usd: target.max_cost_usd } : {}), ...(target.effort ? { effort: target.effort } : {}) }, { trigger, origin: { key: trigger.firing_key }, capped: true, from });
      return { run_id: run.id };
    },
    async message(target, input, key, from) {
      const run = await needRun(target.run_id);
      if (run.kind === "workflow") throw unsupported("messages.steer_workflow_runs", "A workflow run takes no messages here.");
      // A store held past its retries is a busy store: the firing stays due and is tried again, never failed.
      if (await runs.tookMessage(run, key).catch((error: unknown) => { throw storeBusy(error) ? homeBusy() : error; })) return;
      // Never an uncapped turn, nor an answer to a person's question, an approval or a budget pause: a run that waits on
      // its person is told nothing by a trigger.
      if (run.meta.max_cost_usd === undefined) throw new ApiError("not_continuable", NO_CAP);
      const { status, state } = statusOf(run);
      if (status === "input_required" && state === "waiting") return { skipped: WAITS_ON_A_PERSON };
      try {
        await runs.message(run, String(input.content), key, { answers: false, origin: from });
      } catch (error) {
        if (error instanceof ApiError && error.message === WAITS_ON_A_PERSON) return { skipped: WAITS_ON_A_PERSON };
        throw error;
      }
    },
    settings: (adapterId) => triggerSettings.get(adapterId),
    notify: (failed, key) => webhooks.emitTrigger(failed, key),
    async runOf(key) {
      const started = await agents.request(() => agents.store.runOfOrigin(key));
      if (!started) return null;
      // Never set up as runs.ts load reads it (notSetUp: the store has it running and its serve.json holds no input), which
      // this start's recovery fails as server_lost_at_setup; or failed so already.
      const run = await runs.get(started.runId);
      return { run_id: started.runId, setup_lost: run?.notSetUp === true || run?.error?.details?.reason === SETUP_LOST };
    },
    async statusOf(runId) {
      const row = await agents.request(() => agents.store.readRun(runId));
      return row ? runs.statusOfRow(row) : null;
    },
  });
  stops.push(async () => triggers.close());
  triggers.start();

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
        // A count the close ended: stopped, not failed (the next start counts again).
        else if (closing && task === "plan") answered({ stopped: true });
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

  /** The body's bytes, at most `max` of them. */
  async function bytesOf(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    // An oversized body is read to its end before the refusal, so the client gets the answer and not a reset.
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= max) chunks.push(chunk as Buffer);
    }
    if (size > max) throw new ApiError("payload_too_large", `the body is over ${max} bytes`, { details: { limit: "max_body_bytes" } });
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
    bodies.set(req, value);
    return value;
  }

  /** The tools a learned draft of agent `id` may name, as a run's merge reads them (learning-run.ts draftTools): its
   *  current revision's, those the gate allows under the server's settings and the agent's own. */
  async function learnedDraftToolsOf(id: string): Promise<{ tools: string[]; gated: Record<string, string> }> {
    const revision = (await needAgent(id)).revision;
    if (revision?.kind !== "agentic") return { tools: [], gated: {} };
    const [{ learnedDraftTools }, { permissionOf }, { readToolSettings }] = await Promise.all([import("./tools.js"), import("./tool-gate.js"), import("./tool-plane.js")]);
    const server = readToolSettings(agents.dir).settings;
    return learnedDraftTools(revision.body.tools, (name) => permissionOf(name, server as never, (revision.body.toolSettings ?? {}) as never));
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

  const mismatch = () => new ApiError("idempotency_mismatch", "this Idempotency-Key was used with another body");
  /** Replays the first answer to a create with the same key and body; another body is a mismatch. `work` gets the key's
   *  origin (its slot and the body, hashed) for a create the agent store records with the run it starts. */
  /** A kept answer, replayed to `req`: its console page (a run's or an agent's console_url) at the address this request
   *  reached (linkOrigin), not the first request's. */
  const pageFor = (req: IncomingMessage, body: unknown): unknown => {
    if (!isObject(body) || typeof body.console_url !== "string") return body;
    const at = body.console_url.indexOf("/#/");
    return at < 0 ? body : { ...body, console_url: `${linkOrigin(req)}${body.console_url.slice(at)}` };
  };
  async function idempotent(req: IncomingMessage, path: string, body: Json, work: (origin?: RunOrigin) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>) {
    const key = req.headers["idempotency-key"];
    if (key === undefined) return work();
    if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new ApiError("bad_request", "Idempotency-Key is 1 to 255 characters");
    const slot = `${path}\n${key}`;
    const fingerprint = stable(body);
    const now = Date.now();
    for (const [k, v] of idempotency) if (now - v.at > IDEMPOTENCY_TTL_S * 1000) idempotency.delete(k);
    const known = idempotency.get(slot);
    if (known) {
      if (known.fingerprint !== fingerprint) throw mismatch();
      if (!known.answer) throw new ApiError("idempotency_in_progress", "the first request with this Idempotency-Key is still in flight", { retry_after_ms: 500 });
      return { ...known.answer, body: pageFor(req, known.answer.body), headers: { ...known.answer.headers, "idempotent-replayed": "true" } };
    }
    idempotency.set(slot, { fingerprint, at: now });
    let answer: { status: number; body: unknown; headers?: Record<string, string> };
    try {
      answer = await work({ key: `idk_${sha256Hex(slot).slice(0, 32)}`, fingerprint: sha256Hex(fingerprint) });
    } catch (error) {
      idempotency.delete(slot);
      throw error;
    }
    // The work happened, so the key keeps its answer in memory even when the file write fails: a retry replays it
    // instead of doing the work twice. Only a restart before the next good save loses it, and a run's create not even
    // then: the store keeps its run under the key's origin.
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
    const shape = { ...shapeOf(revision), place, ...(revision.body.place ? {} : { unnamed: true as const }) };
    const blockers = await blockersOf(env, shape, settings.get(), { capped, boxes: boxOffers, offers, mcp: mcpTools, decisionPrice });
    if (!blockers.length) return;
    const message = blockers.map((b) => b.message).join(" ");
    // Each blocker as a 422 names its issue: its field, reason and message, and the fix when it has one.
    const fields = blockers.map(issueOf);
    const unbound = blockers.flatMap((b) => (b.tool ? [b.tool] : []));
    // A known MCP meta tool is no server or tool that is missing: it has a key of its own, with why it is not granted.
    const notGrantable = blockers.flatMap((b) => (b.notGrantable ? [b.notGrantable] : []));
    const missing = Object.fromEntries(blockers.flatMap((b) => (b.missing ? [[b.missing.tool, b.missing.vars]] : [])));
    const harness = blockers.find((b) => b.harness)?.harness;
    const box = blockers.find((b) => b.box)?.box;
    const named = { ...(harness ? { harness } : {}), ...(box ? { box } : {}), ...(notGrantable.length ? { not_grantable: notGrantable } : {}) };
    if (revision.kind === "agentic") throw new ApiError("agent_not_runnable", message, { fields, details: { unbound, missing, ...named } });
    const tier = blockers.find((b) => b.tier)?.tier;
    const decisions = Object.fromEntries(blockers.flatMap((b) => (b.decision ? [[b.decision.provider, { reason: b.reason, needs: b.decision.needs }]] : [])));
    const denied = blockers.flatMap((b) => (b.denied ? [b.denied] : []));
    const asks = blockers.flatMap((b) => (b.asks ? [b.asks] : []));
    throw new ApiError("agent_not_runnable", message, { fields, details: { adapters: [...new Set(blockers.flatMap((b) => (b.adapter ? [b.adapter] : [])))], unbound, missing, code: blockers.some((b) => b.codeNodes || b.shell), ...(tier ? { tier } : {}), ...(Object.keys(decisions).length ? { decisions } : {}), ...(denied.length ? { denied } : {}), ...(asks.length ? { asks } : {}), ...named } });
  }

  /** Where a revision of `kind` naming `tools` and no place runs here: the place a new agent would be saved with. */
  const fallbackPlace = (kind: "agentic" | "workflow", tools: readonly unknown[]): Place => defaultPlaceOf(kind, tools, boxOffers, (tool) => toolOf(tool)?.runnerOnly === true);

  /** A definition being saved: refused (422 by field) when it can never run here; else what this host still lacks. A
   *  revision that names no place is checked where it would run (fallbackPlace). */
  async function saveable(revision: NewRevision): Promise<InputIssue[]> {
    // An agent on a harness that installs on first use starts its install, if it is not in yet: its first run waits for less.
    const install = revision.kind === "agentic" ? installs[harnessOfBody(revision)] : undefined;
    if (install) {
      void install.ensure().catch((error: Error) => log?.(logLine("harness_install_failed", { harness: install.entry.id, message: error.message })));
    }
    const named = revision.kind === "agentic" ? revision : workflowShape(revision);
    const shape = named.place ? named : { ...named, place: fallbackPlace(named.kind, named.tools ?? []), unnamed: true as const };
    const blockers = await blockersOf(env, shape, settings.get(), { boxes: boxOffers, offers, mcp: mcpTools });
    // An agent's default cap caps each run started without one of its own, and a web tool resolves by the cap: what a cap
    // alone keeps from running under the definition's own picks, whatever this host's settings, would keep every such run
    // from running, so the save is refused, not each run (claude-agent's or codex's own search, picked, under a cap).
    if ((revision.maxCostUsd ?? 0) > 0) {
      const key = (b: Blocker) => `${b.field}\n${b.message}`;
      const plain = new Set((await blockersOf(env, shape, {}, { boxes: boxOffers, offers, mcp: mcpTools })).map(key));
      const capped = await blockersOf(env, shape, {}, { capped: true, boxes: boxOffers, offers, mcp: mcpTools, decisionPrice });
      // A model with no price (`unpriced`) is a setting this host fixes (AGENT_MODEL_PRICE): a warning, as it is; the
      // agent saves and updates, and only a run under the cap is refused (409). A tool's pick a cap rules out refuses it.
      const added = capped.filter((b) => !plain.has(key(b)));
      blockers.push(...added.filter((b) => b.unpriced));
      blockers.push(...added.filter((b) => !b.unpriced).map((b) => ({ ...b, reason: "not_an_option", fix: "Pick another provider for this tool in definition.tool_settings, or clear the agent's default cap (max_cost_usd: 0).", host: false })));
    }
    const never = blockers.filter((b) => !b.host);
    if (never.length) throw invalid(never.map(issueOf));
    return blockers.map(issueOf);
  }

  /** POST /agents' body made into its agent, as that route makes one, with what this host still lacks for it. A new agent
   *  that names no place is given this server's box (place.ts newAgentPlace), stamped on its revision; one that names a
   *  tool the box refuses (browser) keeps the runner. */
  async function createAgentOf(body: Json): Promise<{ entry: AgentEntry; warnings: InputIssue[] }> {
    let warnings: InputIssue[] = [];
    const definition = checkDefinitionBody(body);
    const named = Array.isArray(definition.definition.tools) ? definition.definition.tools : [];
    const fresh = named.some((tool) => typeof tool === "string" && toolOf(tool)?.runnerOnly) ? { reason: "" } : newAgentPlace(boxOffers);
    const entry = await agents.create(definition, async (revision) => void (warnings = await saveable(revision)), "place" in fresh ? { place: fresh.place, tools: NEW_AGENT_TOOLS } : undefined);
    return { entry, warnings };
  }

  /** A template package applied: its parameters and the owner's grants checked (422), then the secrets and required MCP
   *  servers it names (409, nothing made; an MCP server it can do without is skipped, with a warning), then its
   *  agent made as POST /agents makes one, its MCP tools at the owner's own settings save those granted, set to allow (a
   *  deny the owner set on this server stays, with a warning), its body held to POST /agents' limit (413), on the first harness of its list this server runs and the model packageModel
   *  picks, then each trigger on it as POST /triggers makes one. A trigger refused undoes the apply: the triggers made
   *  before it are deleted and the agent is archived (an agent store keeps every agent), and the refusal is the answer, a 422's fields under `triggers.<i>`. A webhook
   *  trigger's secret is not in the answer (the Idempotency-Key record would keep it): POST /triggers/{id}/secret makes one. */
  async function applyTemplate(pkg: Package, body: Json) {
    const { parameters, grants, model: override } = applyBodyOf(pkg, body);
    const missing = pkg.secrets.filter((name) => !secret(name, storedKeys));
    const saved = pkg.mcp.filter((need) => mcpSource.server(need.server));
    const unsaved = pkg.mcp.filter((need) => !saved.includes(need));
    const needed = unsaved.filter((need) => need.required);
    // A webhook trigger's secret is kept sealed, never in the clear: with no seal key, its create would be refused after
    // the agent is made, so the apply is refused first, naming each one.
    const unsealed = sealKeyOf(env[SEAL_KEY_ENV]) ? [] : pkg.triggers.flatMap((trigger, i) => (isObject(trigger.source) && trigger.source.kind === "webhook" ? [i] : []));
    if (missing.length || needed.length || unsealed.length) {
      const fix = "Add it in Settings → Model keys or Settings → Tool keys, or set it where AgentRun starts, then apply the template again.";
      const server = "Add it in Settings → MCP servers, under that name, then apply the template again.";
      const sealing = `Start the server with its launcher, agentrun-serve, which makes and keeps a seal key, or set ${SEAL_KEY_ENV} (32 random bytes in base64) where AgentRun starts, then apply the template again.`;
      throw new ApiError("agent_not_runnable", `The ${pkg.name} template needs ${[...missing, ...needed.map((need) => `the MCP server ${need.server}`), ...(unsealed.length ? ["a seal key for its webhook trigger's secret"] : [])].join(" and ")}, which this server does not have. Nothing was created.`, { fields: [...missing.map((name) => ({ field: `secrets.${name}`, reason: NOT_SET_UP, message: `${name} is not set on this server.`, fix })), ...needed.map((need) => ({ field: `mcp.${need.server}`, reason: NOT_SET_UP, message: `No MCP server ${need.server} is saved on this server.`, fix: server })), ...unsealed.map((i) => ({ field: `triggers.${i}`, reason: NOT_SET_UP, message: `This server has no seal key (${SEAL_KEY_ENV}), so it cannot keep the webhook trigger's secret.`, fix: sealing }))] });
    }
    // An MCP server the package can do without is skipped, and said: its tools are not granted.
    const skipped: InputIssue[] = unsaved.map((need) => ({ field: `mcp.${need.server}`, reason: NOT_SET_UP, message: `No MCP server ${need.server} is saved on this server, so the agent was made without its tools (${need.tools.join(", ")}). Save it in Settings → MCP servers and apply again to grant them.` }));
    const harness = pkg.harness && (pkg.harness.find((id) => offers.some((offer) => offer.id === id && offer.available)) ?? pkg.harness[0]);
    const model = override ?? (await packageModel(env, pkg.model, harness ?? DEFAULT_HARNESS));
    const defaultTools = "place" in newAgentPlace(boxOffers) ? NEW_AGENT_TOOLS : [];
    // A grant never lifts a deny the owner set on this server: that tool keeps it, and the answer says so.
    const server = settings.get() as Parameters<typeof permissionFrom>[1];
    const denied = grants.filter((tool) => { const set = permissionFrom(tool, server); return set.from === "server" && set.permission === "deny"; });
    const kept: InputIssue[] = denied.map((tool) => ({ field: `grants.${tool}`, reason: "not_allowed", message: `${tool} is denied on this server (Settings → Tools), so the agent was not allowed it: its runs are refused it until the owner changes that setting.` }));
    const made = compiled(pkg, parameters, { ...(harness ? { harness } : {}), ...(model ? { model } : {}), mcp: saved, defaultTools, grants: grants.filter((tool) => !denied.includes(tool)) });
    // Every trigger is checked as POST /triggers checks it, its parameters filled, before anything is made: a schedule
    // from a parameter that does not read, or a date that has passed, refuses the apply (422 under triggers.<i>).
    const refusedTriggers = madeTriggerIssues(made.triggers, Date.now());
    if (refusedTriggers.length) throw invalid(refusedTriggers);
    // POST /agents' and POST /triggers' own body limit: parameters filled in more than once can grow a package past it.
    for (const one of [made.agent, ...made.triggers]) if (Buffer.byteLength(JSON.stringify(one)) > MAX_BODY) throw new ApiError("payload_too_large", `the ${pkg.name} template, its parameters filled in, makes a body over ${MAX_BODY} bytes`, { details: { limit: "max_body_bytes" } });
    const { entry, warnings } = await createAgentOf(made.agent);
    const ids: string[] = [];
    try {
      for (const [i, trigger] of made.triggers.entries()) {
        try {
          ids.push((await triggers.create({ ...trigger, target: { ...(trigger.target as Json), agent_id: entry.agent.id } })).id);
        } catch (error) {
          if (error instanceof ApiError && error.code === "input_invalid" && error.extra.fields) throw told(new ApiError("input_invalid", error.message, { ...error.extra, fields: error.extra.fields.map((f) => ({ ...f, field: `triggers.${i}.${f.field}` })) }));
          throw error;
        }
      }
    } catch (error) {
      for (const id of ids.reverse()) {
        try {
          triggers.remove(id);
        } catch (undo) {
          log?.(logLine("template_undo_failed", { template: pkg.name, trigger: id, message: (undo as Error).message }));
        }
      }
      await agents.setArchived("agent", entry.agent.id, true).catch((undo: Error) => log?.(logLine("template_undo_failed", { template: pkg.name, agent: entry.agent.id, message: undo.message })));
      throw error;
    }
    // A pinned send whose destination parameter was not given is denied, never let go anywhere: said, by its gate name.
    const unpinned: InputIssue[] = made.unpinned.map(({ tool, parameters: named }) => ({ field: `pins.${tool}`, reason: NOT_SET_UP, message: `${tool}'s arguments are fixed by ${named.map((one) => `the ${one} parameter`).join(" and ")}, which was not given, so the agent was made with ${tool} set to deny: it can't call it at all. Apply again with ${named.join(" and ")} set to let it.` }));
    // A pin this server's agent store does not keep yet (tool-plane.ts AGENT_LAYER_PINS): said, with the setting that holds
    // the send to its destination meanwhile, the server's.
    const unkept: InputIssue[] = made.unkept.map(({ tool, pin }) => ({ field: `pins.${tool}`, reason: NOT_SET_UP, message: `${tool} is not pinned to ${pinWords(pin)} for this agent yet: this server's agent store keeps an agent's own pin from the store cutover on. Until then it asks unless granted. To hold its calls to that destination, pin it on this server, which holds every agent's calls of ${tool}.`, fix: `Add ${JSON.stringify({ [tool]: { pin } })} to this server's tool settings (Settings → Tools; PUT /v2/settings/tools replaces the whole map, so send it with the rest).` }));
    return { template: pkg.name, version: pkg.version, agent_id: entry.agent.id, trigger_ids: ids, warnings: [...skipped, ...kept, ...unpinned, ...unkept, ...warnings] };
  }

  /** A run create's issues told from the input this server checks (explain.ts): an agentic run's `{content: string}`,
   *  with the documented run bodies; a workflow run's its workflow's input schema, never the agentic example. Each value
   *  suggested must pass this route's own checks of the body, the workflow's input check among them. */
  async function explainRun(issues: InputIssue[], body: Json, revision: Revision | null | undefined): Promise<InputIssue[]> {
    const dsl = revision?.kind === "workflow" ? await import("@parcha/agentrun-dsl") : undefined;
    const workflow = dsl && revision?.kind === "workflow" ? revision.body.workflow : undefined;
    const declared = workflow?.input?.schemaId === undefined ? undefined : workflow.schemas[workflow.input.schemaId];
    const input = !dsl ? DEFAULT_INPUT_SCHEMA : declared ? (dsl.resolveSchemaForWorkflow(workflow!, declared) as Json) : { type: "object" };
    const base = deref(openapi, { $ref: "#/components/schemas/RunCreate" }) ?? {};
    const schema = { ...base, properties: { ...(base.properties as Json), input } };
    const check = (sent: unknown) => {
      const value = isObject(sent) ? sent : {};
      const issues = runBodyIssues(value);
      if (!revision || !isObject(value.input)) return issues;
      return [...issues, ...(dsl ? workflowInputIssues(dsl.validateWorkflow, revision, value.input) : inputIssues(value.input, DEFAULT_INPUT_SCHEMA as Json))];
    };
    return explain(issues, openapi, schema, { examples: dsl ? [] : examplesOf("createRun"), body, check });
  }

  /** A run's input: an agentic run's `{content: string}`, a workflow run's what its workflow's input schema takes. */
  async function inputIssuesOf(revision: Revision, input: Json) {
    if (revision.kind === "agentic") return inputIssues(input, DEFAULT_INPUT_SCHEMA as Json);
    const { validateWorkflow } = await import("@parcha/agentrun-dsl");
    return workflowInputIssues(validateWorkflow, revision, input);
  }

  /** A workflow run's input against its workflow's input schema, as the DSL checks it before the first node. */
  function workflowInputIssues(validateWorkflow: typeof import("@parcha/agentrun-dsl").validateWorkflow, revision: Revision, input: Json): InputIssue[] {
    if (revision.kind !== "workflow") return [];
    const checked = validateWorkflow(revision.body.workflow, { executeCode: false, input });
    return checked.ok ? [] : checked.issues.map((i) => ({ field: `input${i.path ? ` at ${i.path}` : ""}`, reason: "invalid", message: `the workflow does not take this input: ${i.code}${i.path ? ` at ${i.path}` : ""}` }));
  }

  /** Where a person opens a page an answer to `req` names (a run's or an agent's console_url, console-links.ts): the
   *  server's public URL when it has one; else the address the request reached it at, which passed the Host check (a
   *  tunnel's own port, say); else, with no Host, its own. Links made outside a request (the owner's, the webhooks') are
   *  at the public URL or the server's own address. */
  const linkOrigin = (req: IncomingMessage): string => (options.publicUrl ?? (req.headers.host ? ownOrigin(req) : url)).replace(/\/+$/, "");

  async function createRun(req: IncomingMessage, agentId: string) {
    const entry = await needAgent(agentId);
    if (entry.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${agentId} is archived: unarchive it to run it.`, { details: { archived_at: entry.agent.archivedAt } });
    const body = await bodyOf(req);
    return idempotent(req, `/agents/${agentId}/runs`, body, async (origin) => {
      // A run the store started under this key, though no answer was kept (its server went down first): that run, as it is now.
      const first = origin && (await agents.request(() => agents.store.runOfOrigin(origin.key)));
      if (first) {
        if (first.existing?.fingerprint !== origin.fingerprint) throw mismatch();
        const headers: Record<string, string> = { location: `/v2/runs/${first.runId}`, "idempotent-replayed": "true" };
        return { status: 202, body: await runs.view(await needRun(first.runId), linkOrigin(req)), headers };
      }
      const run = await startRunOf(entry, body, { ...(origin ? { origin } : {}) });
      // Its view from the run itself: it is written, with its first message, so an answer read from the store, which a
      // busy store would turn into home_busy, would refuse a run that runs, and a retry would start a second one.
      return { status: 202, body: await runs.view(run, linkOrigin(req), { stored: null }), headers: { location: `/v2/runs/${run.id}` } };
    });
  }

  /** A run of `entry`'s agent from a create's body, checked as POST /agents/{id}/runs checks it: that route's, and a
   *  trigger's firing's, which names itself as the run's `trigger`. Under `origin`, a key that already started a run
   *  gets that run (the agent store's run_origins). */
  /** `capped`: the run must have a cap (a trigger's), its own or else its agent's default. */
  /** `from`: who the run's first message is from when the person did not write it (a trigger's firing). */
  async function startRunOf(entry: AgentEntry, body: Json, { trigger, origin, capped = false, from }: { trigger?: RunTrigger; origin?: RunOrigin; capped?: boolean; from?: MessageOrigin } = {}): Promise<Run> {
    const issues = runBodyIssues(body);
    if (issues.length) {
      // Told from the revision the run would start on (a pinned one, else the current), once it reads as one: a pin that
      // is malformed or names no revision gets the refusal alone, no hint.
      const on = issues.some((issue) => issue.field === "revision") ? undefined : await pinnedOf(entry, body);
      throw told(invalid(on ? await explainRun(issues, body, on.revision) : issues));
    }
    if (body.quote_id !== undefined) throw unsupported("quotes", "This server has no billing, so it takes no quotes.");
    // Each a ready file, before anything starts: copied into the run's work/inputs/ once its directory is made.
    const files = Array.isArray(body.file_ids) ? await uploads.readyFiles(body.file_ids) : [];
    const pinned = await pinnedOf(entry, body);
    if (!pinned) throw invalid([{ field: "revision", reason: "not_an_option", message: typeof body.revision === "string" ? `${body.revision} is not a revision of the agent ${entry.agent.id}` : `the agent ${entry.agent.id} has no current revision` }]);
    const { revision, version } = pinned;
    const input = body.input as Json;
    const wrong = await inputIssuesOf(revision, input);
    if (wrong.length) throw told(invalid(await explainRun(wrong, body, revision)));
    // The run's own cap, else the agent's default: the caller chose its own.
    const cap = typeof body.max_cost_usd === "number" ? body.max_cost_usd : revision.body.maxCostUsd;
    if (capped && cap === undefined) throw invalid([{ field: "max_cost_usd", reason: "missing", message: "Every run a trigger starts is capped: give the trigger's target a max_cost_usd or set the agent's." }]);
    // How its cap prices a request: the run's own, else the agent's, else expected (cap.ts). Only a run with a cap has one.
    if (body.cap_mode !== undefined && cap === undefined) throw invalid([{ field: "cap_mode", reason: "not_allowed", message: "cap_mode says how a run's cap prices its requests, and this run has no cap: give it a max_cost_usd, or set the agent's." }]);
    const capMode = cap === undefined ? undefined : typeof body.cap_mode === "string" ? (body.cap_mode as CapMode) : (revision.body.capMode as CapMode | undefined);
    const place = resolvePlace(revision.body.place as Place | undefined, fallbackPlace(revision.kind, revision.kind === "agentic" ? (revision.body.tools ?? []) : []));
    await runnable(revision, place, { capped: cap !== undefined });
    // The title shows on the run's page, the runs list and Mission Control: built from its input as shown, each held
    // value redacted before a long one is cut (a cut key could no longer be found), and the run gets its input as given.
    const shown = redactedOutput(input, serverSecrets());
    const title = revision.kind === "workflow" ? workflowTitle(entry.agent.name || entry.agent.id, isObject(shown) ? shown : {}) : typeof input.content === "string" ? input.content : (Object.values(input).find((v): v is string => typeof v === "string") ?? JSON.stringify(input));
    return runs.create(entry, revision, version, { input, title, place, ...(typeof body.effort === "string" ? { effort: body.effort } : {}), ...(cap !== undefined ? { maxCostUsd: cap } : {}), ...(capMode !== undefined ? { capMode } : {}), ...(trigger ? { trigger } : {}), ...(origin ? { origin } : {}), ...(from ? { from } : {}), ...(files.length ? { inputs: (work: string) => uploads.copyInto(work, files) } : {}) });
  }

  /** The revision a run of `entry` starts on: the one `body.revision` pins, else the agent's current; undefined when the
   *  pin names none, or the agent has no revision. */
  async function pinnedOf(entry: AgentEntry, body: Json) {
    return typeof body.revision === "string" ? await agents.revision(entry.agent.id, body.revision) : entry.revision && { revision: entry.revision, version: entry.version };
  }

  /** A run create's body as POST /agents/{id}/runs checks it before it reads the agent: each field issue. */
  function runBodyIssues(body: Json): InputIssue[] {
    const issues = unknownFields(body, ["input", "revision", "file_ids", "effort", "max_cost_usd", "cap_mode", "quote_id"]);
    if (!isObject(body.input)) issues.push({ field: "input", reason: body.input === undefined ? "missing" : "wrong_type", message: "input is an object" });
    if (body.revision !== undefined && (typeof body.revision !== "string" || !ID.test(body.revision))) issues.push({ field: "revision", reason: "wrong_type", message: "revision is a revision id of this agent" });
    if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) issues.push({ field: "effort", reason: "not_an_option", message: `effort is one of ${EFFORTS.join(", ")}` });
    if (body.max_cost_usd !== undefined && !(typeof body.max_cost_usd === "number" && body.max_cost_usd > 0 && Number.isFinite(body.max_cost_usd))) issues.push({ field: "max_cost_usd", reason: "wrong_type", message: "max_cost_usd is a number above 0" });
    if (body.cap_mode !== undefined && !(CAP_MODES as readonly unknown[]).includes(body.cap_mode)) issues.push({ field: "cap_mode", reason: "not_an_option", message: `cap_mode is one of ${CAP_MODES.join(", ")}` });
    if (body.file_ids !== undefined && !Array.isArray(body.file_ids)) issues.push({ field: "file_ids", reason: "wrong_type", message: "file_ids is a list of file ids" });
    return issues;
  }

  /** A page of runs from the store, newest first: `agent`, `revision` and `status` narrow it. */
  /** A list's `archived`: true lists only what is archived, false (the default) only what is not. */
  function archivedParam(url: URL): boolean {
    const value = url.searchParams.get("archived");
    if (value !== null && value !== "true" && value !== "false") throw new ApiError("bad_request", "archived is true or false");
    return value === "true";
  }

  async function runsPage(url: URL, filter: { agent?: string; revision?: string }, origin: string) {
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
    const page = await Promise.all(rows.slice(offset, offset + limit).map((row) => runs.summaryOfRow(row, versions, origin)));
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
      // Its learning row as it reads now: what it held for its owner's OK, approved or retired since, waits no more.
      const rows = page.rows.some((row) => row.kind === "learning") ? await runs.learning.rowsNow(run.agentId, run.meta.learning, page.rows) : page.rows;
      return { run_id: run.id, status: page.status, state: page.state, reset: page.reset, rows, drop: page.drop, next_after: page.next_after, unchanged: page.unchanged, has_more: page.has_more, final: page.final, cost: runs.cost(run) };
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

  /** Run `run`'s Workspace, which its files' list and reads go through: null while the run has no folder (an imported
   *  run never has one), which lists nothing. */
  async function runWorkspace(run: Pick<Run, "agentId" | "id">): Promise<Workspace | null> {
    const root = runFolder(data, run.agentId, run.id);
    return (await lstat(root).catch(() => null))?.isDirectory() ? localWorkspace(root) : null;
  }

  // ---- an agent's home --------------------------------------------------------------------------------------------------

  /** Agent `agentId`'s home as its Workspace (paths.ts agentHomeFolder): null while nothing was ever written to it. With
   *  `make`, its folder and each above it under the data directory are made (0700) where absent, each one made synced
   *  into its parent, so a write in it that is answered survives a crash of the machine. Never a link: a read finds no
   *  home there, and a write is refused. */
  async function homeWorkspace(agentId: string, make: boolean): Promise<Workspace | null> {
    const root = agentHomeFolder(data, agentId);
    if (make) {
      let dir = data;
      for (const part of relative(data, root).split(sep)) {
        dir = join(dir, part);
        if (await mkdir(dir, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : Promise.reject(error)))) await syncDir(dirname(dir));
      }
    }
    if ((await lstat(root).catch(() => null))?.isDirectory()) return localWorkspace(root);
    if (make) throw new ApiError("system_file_forbidden", LINK_REFUSED, { details: { reason: "link" } });
    return null;
  }

  /** A write to the home or a removal from it the Workspace refused, as its answer. */
  function homeRefusal(error: unknown): never {
    if (!isWorkspaceError(error)) throw error;
    if (error.code === "ESCAPE") throw new ApiError("system_file_forbidden", LINK_REFUSED, { details: { reason: "link" } });
    const denied = ["EACCES", "EPERM"].includes((error.cause as NodeJS.ErrnoException | undefined)?.code ?? "");
    if (denied) throw new ApiError("system_file_forbidden", "This server may not enter a directory on the way to this path.", { details: { reason: "unreadable" } });
    if (error.code === "REFUSED" || error.code === "EXISTS" || error.code === "NOT_FOUND") throw new ApiError("invalid_file_path", "the path names a directory, or runs through a file");
    throw error;
  }

  // ---- usage ----------------------------------------------------------------------------------------------------------

  // Each ended run's meters, from its store (meterFiguresIn): kept, as its store no longer changes, keyed by its end, so a run
  // opened again and ended again is read again. A store that cannot be read leaves it all tokens.
  const endedMeters = new Map<string, ReturnType<typeof meterFiguresIn>>();
  // Each ended run's spend so far as it saved it at its end (serve.json's cost_so_far: every conversation's charges and
  // its decisions' receipts, which its root store alone does not hold), kept as its meters are; undefined when it saved
  // none (a run whose cost is known, or one ended before the figure was kept).
  const endedSoFar = new Map<string, number | undefined>();
  const savedSoFarOf = (row: { id: string; endedAt?: string | null }) => {
    const key = `${row.id} ${row.endedAt}`;
    if (!endedSoFar.has(key)) {
      let usd: number | undefined;
      try {
        const kept = (JSON.parse(readFileSync(join(dirname(dirname(agents.store.runStorePath(row.id))), RUN_META), "utf8")) as { cost_so_far?: { so_far_usd?: unknown } }).cost_so_far?.so_far_usd;
        usd = typeof kept === "number" && Number.isFinite(kept) ? kept : undefined;
      } catch {
        usd = undefined;
      }
      endedSoFar.set(key, usd);
    }
    return endedSoFar.get(key);
  };
  const metersOf = (row: { id: string; endedAt?: string | null }) => {
    const key = `${row.id} ${row.endedAt}`;
    let meters = endedMeters.get(key);
    if (!meters) {
      try {
        meters = meterFiguresIn(agents.store.runStorePath(row.id));
      } catch {
        meters = { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } };
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
    // Tool calls run with no price (an MCP tool its owner set none for): outside every cost, counted on `tools`.
    let notMetered = 0;
    const total = { usd: 0, unpriced: 0 };
    // The browser_time line's seconds: its ended runs' (their stores keep each charge's), none once a live run is in it.
    let browserSeconds: number | null = 0;
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
      // By meter, what a run's paid tools charged (monid's) is `tools`, its browser session time `browser_time`, the rest
      // `tokens`, all from the same records: a live run's rows (a call still marked is no charge), else its store as it
      // ended (a call a crash cut makes `tools` unknown, never `tokens`). An unknown meter counts the run as unpriced on it.
      // An ended run's are its store's figures (metersOf keeps them, never its timeline), read for its lines by meter and,
      // by any group, for what a run of unknown cost is known to have spent.
      const read = (group === "meter" && usd !== 0) || usd === null ? (live ? { tools: toolCostOf(live.rows), tokens: null, browser: { usd: toolCostOf(live.rows, "browser"), seconds: null }, others: toolCostOf(live.rows, "browser", true), known: { tokens: 0, browser: knownToolCostOf(live.rows, "browser"), others: knownToolCostOf(live.rows, "browser", true) } } : metersOf(row)) : undefined;
      // A run whose cost is unknown still spent what is known of it (so_far: each meter's known dollars): that is in the
      // total and its lines, and the run is counted unpriced, so a total is never below a line of its own and reads as
      // the lower bound unpriced_runs says it is.
      const soFar = usd !== null || !read ? 0 : live ? (runs.cost(live).so_far_usd ?? 0) : (savedSoFarOf(row) ?? read.known.tokens + read.known.browser + read.known.others);
      const meters = group === "meter" && usd !== 0 ? read : undefined;
      if (meters && meters.browser.usd !== 0) browserSeconds = browserSeconds === null || meters.browser.seconds === null ? null : browserSeconds + meters.browser.seconds;
      // Its parts of the lines (usage-lines.ts): an unknown one counts the run unpriced there and adds what is known of it.
      // An unpriced MCP call is in none of them: counted apart as not metered on the tools line, which a $0 run shows only
      // when it made one.
      const unmetered = group !== "meter" ? 0 : ((live ? live.rows.find((one) => one.kind === "usage")?.usage?.not_metered : metersOf(row).notMetered) ?? 0);
      notMetered += unmetered;
      if (unmetered && !lines.has("tools")) lines.set("tools", { usd: 0, unpriced: 0 });
      for (const part of runLines({ usd, soFar, key, meters })) {
        const line = lines.get(part.name) ?? lines.set(part.name, { usd: 0, unpriced: 0 }).get(part.name)!;
        line.usd += part.usd;
        if (part.unpriced) line.unpriced++;
      }
      if (usd === null) total.unpriced++;
      total.usd += usd ?? soFar;
    }
    // What learning spent on this server, outside any run (usage.ts): each run's grade, on the day its learning ended.
    for (const entry of (await outcomes(data)).values()) {
      const at = Date.parse(entry.at);
      if (at >= from && at < to) add(lineKey(entry.agent, entry.at, "learning"), entry.cost);
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), currency: "USD", basis: "estimate", group_by: group, total_usd: round(total.usd), unpriced_runs: total.unpriced,
      lines: [...lines].map(([key, line]) => ({ group: key, ...(group === "meter" ? { meter: key } : {}), ...(key === "browser_time" && group === "meter" && browserSeconds !== null ? { quantity: round(browserSeconds), unit: "second" } : {}), usd: round(line.usd), unpriced_runs: line.unpriced, ...(group === "meter" && key === "tools" && notMetered ? { not_metered_calls: notMetered } : {}) })),
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
        // A new password ends every session from before (a reset in another process cleared the old one).
        viewers.recheck();
        // The count is for the offer, now answered: it stops.
        stopCount();
        // Only on the box ticked: the owner, now set, asked for it. It runs after the answer; agents arrive as it goes.
        if (body.import === true) void importAtSetup();
        return send(res, 201, { signed_in: true, ...(body.import === true ? { importing: true } : {}) }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      case "/setup/import": {
        // No offer is an answer, `{ offer: false }`, never a 404: the console reads this on its first page, and a browser
        // logs every 404 as an error.
        // Before the owner is set, to the setup page: none on a server that cannot import, else that it can (202 while it
        // counts), and then how many projects and sessions it would, or null for each when the count failed.
        if (!me.hasPassword()) {
          pageRead(req);
          if (!offersImport) return send(res, 200, { offer: false });
          countSessions();
          if (count?.state === "counted") return send(res, 200, { projects: count.projects, sessions: count.sessions });
          if (count?.state === "failed") return send(res, 200, { projects: null, sessions: null });
          return send(res, 202, { counting: true });
        }
        // After, to the signed-in owner: the import asked for at setup, running, done or stopped, or none asked.
        if (!signedIn(req, me)) throw new ApiError("not_found", "no route /v2/setup/import");
        return send(res, 200, importState ?? { offer: false });
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
        viewers.recheck();
        return send(res, 200, { signed_out: true }, { "set-cookie": ownerCookie(req, "", 0) });
      }
      case "/auth/session":
        return send(res, 200, { password_set: me.hasPassword(), signed_in: signedIn(req, me) });
    }
    throw new ApiError("not_found", `no route /v2${path}`);
  }

  // ---- routing --------------------------------------------------------------------------------------------------------

  /** A route's answer; a 422's field issues told from the operation's request body schema (explain.ts). */
  async function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    try {
      return await routeOf(req, res, url, path);
    } catch (error) {
      const name = ROUTES.find((r) => r.pattern.test(path) && r.method === req.method)?.name;
      if (!(error instanceof ApiError) || error.code !== "input_invalid" || !error.extra.fields?.length || !name || explained.has(error)) throw error;
      const body = bodies.get(req);
      const fields = explain(error.extra.fields, openapi, bodySchemaOf(name), { examples: examplesOf(name), body, check: body && BODY_CHECKS[name]?.(body) });
      throw new ApiError(error.code, error.message === error.extra.fields[0]!.message ? fields[0]!.message : error.message, { ...error.extra, fields }, error.headers);
    }
  }

  /** The 422s already told where they were thrown, with the checks only that place has (a run's, its agent's input). */
  const explained = new WeakSet<ApiError>();
  const told = (error: ApiError) => (explained.add(error), error);
  /** Each request's body as bodyOf read it, for the 422's suggestions to be checked against. */
  const bodies = new WeakMap<IncomingMessage, Json>();
  /** The check of a whole body a route makes before anything else, by operation, for the body sent: what a suggested
   *  value must pass. PUT .../definition's contract body (the definition itself) has none here. */
  const definitionCheck = (creating: boolean) => (body: unknown) => definitionBodyIssues(isObject(body) ? body : {}, { creating });
  const BODY_CHECKS: Record<string, (sent: Json) => ((body: unknown) => readonly InputIssue[]) | undefined> = {
    createAgent: () => definitionCheck(true),
    updateDefinition: (sent) => ("definition" in sent ? definitionCheck(false) : undefined),
  };

  /** An operation's documented request bodies (its JSON media type's examples), each its value. */
  function examplesOf(operationId: string): unknown[] {
    for (const item of Object.values(openapi.paths as Record<string, Record<string, Json>>)) {
      for (const op of Object.values(item)) {
        if (op.operationId !== operationId) continue;
        const media = (((op.requestBody as Json | undefined)?.content as Json | undefined)?.["application/json"] as Json | undefined) ?? {};
        return Object.values((media.examples as Record<string, Json> | undefined) ?? {}).map((example) => example.value);
      }
    }
    return [];
  }

  /** An operation's JSON request body schema in the served document, if it has one. */
  function bodySchemaOf(operationId: string): Json | undefined {
    for (const item of Object.values(openapi.paths as Record<string, Record<string, Json>>)) {
      for (const op of Object.values(item)) {
        if (op.operationId === operationId) return deref(openapi, (((op.requestBody as Json | undefined)?.content as Json | undefined)?.["application/json"] as Json | undefined)?.schema);
      }
    }
    return undefined;
  }

  async function routeOf(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const matching = ROUTES.filter((r) => r.pattern.test(path));
    // `/v2` twice: a path an answer gives (upload.url, a Location) appended to the /v2 base, where it starts at the root.
    if (!matching.length) throw new ApiError("not_found", path.startsWith("/v2/") ? `no route /v2${path}: /v2 is in it twice. A path an answer gives (upload.url, a Location) starts at the server's root: send it to the server's address, not after the /v2 base.` : `no route ${path}`);
    const found = matching.find((r) => r.method === req.method || (req.method === "HEAD" && r.method === "GET"));
    if (!found) throw new ApiError("method_not_allowed", `${req.method} is not a method of ${path}`, {}, { allow: [...new Set(matching.map((r) => r.method))].join(", ") });
    if (found.name === "getCapabilities") return send(res, 200, forCaller(caps, byOwnerSession(req)));
    if (found.name === "getOpenapi") return send(res, 200, servedOpenapi(openapi, req.socket.localPort));
    // The one route with no token: a pushed trigger source's request, checked by its source before anything else is
    // read (push-handler.ts).
    if (found.name === "receiveHook") {
      // A body cut at its cap or its time is answered, then its socket closed: never read to its end.
      const answer = await receivePush({ adapters, hooked: (id, kind) => triggers.hookSource(id, kind), ignored: (id, eventId) => triggers.ignored(id, eventId), receive: (id, eventId, payload, attrs) => triggers.receive(id, eventId, payload, attrs), scoped: (kind, scope) => triggers.scoped(kind, scope), setting: (adapterId, scope, field) => triggerSettings.get(adapterId)?.get(scope, field), refused: authFailed, say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)) }, req, /^\/hooks\/([^/]+)$/.exec(path)![1]!);
      return send(res, answer.status, answer.body, answer.headers ?? {});
    }
    // An MCP server's OAuth sign-in: the browser coming back from its authorization server carries no token (the state
    // it brings is the check, mcp-oauth.ts), and the client metadata document is for that server to fetch.
    if (found.name === "mcpOAuthCallback") {
      // Its state's start set a cookie in the browser that started it: no other browser finishes that sign-in.
      const state = url.searchParams.get("state");
      if (!startedHere(req.headers.cookie, req.socket.localPort, state)) throw new ApiError("forbidden", "This sign-in was started in another browser, or its 10 minutes are over: start it again in Settings → MCP servers, in this browser.");
      const location = await mcpServers.oauthCallback(url.searchParams, stopping.signal);
      // Its sign-in is over: its cookie goes.
      return void res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": signInCookie(req.socket.localPort, state!, overHttps(req), 0) }).end();
    }
    if (found.name === "mcpOAuthClient") return send(res, 200, mcpServers.clientDocument(), { "cache-control": "public, max-age=3600" });
    if (found.name === "getHealth") {
      const health = await healthOf(data, minFreeBytes);
      return send(res, health.status === "ok" ? 200 : 503, health);
    }
    // Approving a note the grader held for its owner's OK (a risky rule a run's user asked for) takes the owner's
    // signed-in page alone: never a token, which a run's process, an agent's MCP client or a script may hold, nor a
    // page cookie a token can mint (accounts off). The page's cookie stands in for the token only on its own origin
    // with a JSON body (page.ts), so this is CSRF-checked as every page write is. With no credential at all it is 401,
    // as every route is.
    // Restoring a retired one puts it back in every later run, as an approval does: the same owner's session alone.
    if (found.name === "restoreLearningFile" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "restore_without_session");
      throw new ApiError("forbidden", owner ? "Restoring a retired note takes the owner's password sign-in in the console, never a token." : "Restoring a retired note takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    if (found.name === "approveLearningFile" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "approve_without_session");
      throw new ApiError("forbidden", owner ? "Approving a note takes the owner's password sign-in in the console, never a token." : "Approving a note takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    // A run's live browser view is a full-control credential for its browser: the owner's signed-in page alone, as approving
    // a note is (never a token a run, an MCP client or a script may hold).
    if ((found.name === "getRunBrowser" || found.name === "handBackRunBrowser") && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "browser_without_session");
      throw new ApiError("forbidden", owner ? "A run's live browser takes the owner's password sign-in in the console, never a token." : "A run's live browser takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    // Answering a tool call that waits for approval (tool-gate.ts) is the same: the owner's signed-in page alone, never a
    // token, which the run's own process, an agent's MCP client or a script may hold.
    if (found.name === "answerApproval" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "approve_without_session");
      throw new ApiError("forbidden", owner ? "Answering a tool call's approval takes the owner's password sign-in in the console, never a token." : "Answering a tool call's approval takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
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
          const { entry, warnings } = await createAgentOf(body);
          return { status: 201, body: { ...agentView(entry, linkOrigin(req), await signIns.view(entry.agent.id), await learningOfAgent(entry)), warnings }, headers: { location: `/v2/agents/${entry.agent.id}`, etag: etagOf(entry) } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listAgents": {
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const archived = archivedParam(url);
        const all = (await agents.list()).filter((entry) => Boolean(entry.agent.archivedAt) === archived);
        return send(res, 200, { agents: await Promise.all(all.slice(offset, offset + limit).map(async (entry) => agentView(entry, linkOrigin(req), await signIns.view(entry.agent.id), await learningOfAgent(entry)))), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getAgent": {
        const entry = await needAgent(id);
        // The tools its current revision grants, as capabilities list them, each with its provider for this agent.
        const tools = entry.revision ? agentTools(env, settings.get(), await toolingOf(entry.revision), caps.tools.map((tool) => tool.name)) : [];
        return send(res, 200, { ...agentView(entry, linkOrigin(req), await signIns.view(entry.agent.id), await learningOfAgent(entry)), tools }, { etag: etagOf(entry) });
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
        return send(res, 200, { ...agentView(edited, linkOrigin(req), await signIns.view(edited.agent.id), await learningOfAgent(edited)), warnings }, { etag: etagOf(edited) });
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
        return send(res, 200, agentView(moved, linkOrigin(req), await signIns.view(moved.agent.id), await learningOfAgent(moved)), { etag: etagOf(moved) });
      }
      case "archiveAgent":
      case "unarchiveAgent": {
        await needAgent(id);
        await agents.setArchived("agent", id, found.name === "archiveAgent");
        if (found.name === "archiveAgent") await runs.archived();
        const entry = await needAgent(id);
        return send(res, 200, agentView(entry, linkOrigin(req), await signIns.view(entry.agent.id), await learningOfAgent(entry)), { etag: etagOf(entry) });
      }
      case "forgetSignIn": {
        await needAgent(id);
        let key: string;
        try {
          key = decodeURIComponent(second!);
        } catch {
          throw new ApiError("bad_request", "the sign-in's key is not a valid path segment");
        }
        return send(res, 200, await signIns.forget(id, key));
      }
      case "createRun": {
        const answer = await createRun(req, id);
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listRuns":
        await needAgent(id);
        return send(res, 200, await runsPage(url, { agent: id }, linkOrigin(req)));
      case "listAllRuns": {
        const agent = url.searchParams.get("agent") ?? undefined;
        const revision = url.searchParams.get("revision") ?? undefined;
        return send(res, 200, await runsPage(url, { ...(agent ? { agent } : {}), ...(revision ? { revision } : {}) }, linkOrigin(req)));
      }
      case "getRun":
        return send(res, 200, await runs.view(await needRun(id), linkOrigin(req)));
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
      case "raiseRunCap": {
        const run = await needRun(id);
        const body = await bodyOf(req);
        const extra = unknownFields(body, ["max_cost_usd"]);
        if (extra.length) throw invalid(extra);
        const cap = body.max_cost_usd;
        if (!(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) throw invalid([{ field: "max_cost_usd", reason: cap === undefined ? "missing" : "wrong_type", message: "max_cost_usd is a number above 0" }]);
        const now = run.meta.max_cost_usd;
        if (now === undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "This run has no cap to raise: a cap is named when a run starts." }]);
        const { resumed, messageId, note } = await runs.raiseCap(run, cap);
        const { status, state } = statusOf(run);
        return send(res, 200, { run_id: run.id, max_cost_usd: cap, resumed, ...(messageId ? { message_id: messageId } : {}), ...(note ? { note } : {}), status, state });
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
      case "answerApproval": {
        // The owner's answer to a tool call that waits for approval (tool-gate.ts): the first answer wins.
        const run = await needRun(id);
        const body = await bodyOf(req);
        const issues: InputIssue[] = Object.keys(body).filter((k) => k !== "decision" && k !== "note").map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` }));
        if (body.decision !== "allow" && body.decision !== "deny") issues.push({ field: "decision", reason: body.decision === undefined ? "missing" : "not_an_option", message: "decision is allow or deny" });
        if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) issues.push({ field: "note", reason: "wrong_type", message: "note is a string of at most 2000 characters" });
        if (issues.length) throw invalid(issues);
        await runs.approve(run, decodeURIComponent(second!), body.decision as "allow" | "deny", typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined);
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "archiveRun":
      case "unarchiveRun": {
        const run = await needRun(id);
        await agents.setArchived("run", run.id, found.name === "archiveRun");
        if (found.name === "archiveRun") await runs.archived();
        return send(res, 200, await runs.view(run, linkOrigin(req)));
      }
      case "getRunBrowser": {
        const run = await needRun(id);
        // The run's open viewer first: its process holds the keys it started with, so a key deleted here since (the server's
        // keys now) never hides a browser that runs. Only the run's live process serves its view: a file one that is gone
        // left behind names none, whatever answers its port. The newest session whose viewer answers: an older one still open
        // is the next, one that went quiet none.
        let live: LiveHandover | undefined;
        for (const handover of runs.hasProcess(run.id) ? await readHandovers(run.dir) : []) if ((live = (await viewerAnswers(handover)) ? handover : undefined)) break;
        if (live) return send(res, 200, { state: "live", viewer: viewerLink(run.id, live) }, { "cache-control": "no-store" });
        // None open: whether the run has a browser at all, its kept plane's (a run from before the plane names none, and is
        // Browserbase's where it grants the tool), checked again as a launch would be. None, or unavailable, is `off`, saying why.
        const granted = run.tooling?.tools.includes("browser") === true;
        const kept = run.meta.tool_plane?.browser ?? (granted ? "browserbase" : undefined);
        const browser = kept === undefined ? undefined : recheckPlane({ browser: kept }, env).browser;
        if (browser === undefined || isUnavailable(browser)) return send(res, 200, { state: "off", reason: browser === undefined ? "this run's agent has no browser tool" : whyUnavailable(browser) }, { "cache-control": "no-store" });
        return send(res, 200, { state: "none" }, { "cache-control": "no-store" });
      }
      case "handBackRunBrowser": {
        // The owner's answer to the agent's ask for them in its browser (browser-person.ts): the first answer wins, the same
        // one again is that answer, a different one is 409; an ask past its expiry has `expired`.
        const run = await needRun(id);
        const body = await bodyOf(req);
        const issues = unknownFields(body, ["outcome"]);
        if (body.outcome !== "done" && body.outcome !== "cancelled") issues.push({ field: "outcome", reason: body.outcome === undefined ? "missing" : "not_an_option", message: "outcome is done or cancelled" });
        if (issues.length) throw invalid(issues);
        const answered = answerAsk(run.dir, body.outcome as "done" | "cancelled");
        if (!answered) throw new ApiError("not_found", "this run's agent has not asked for you in its browser");
        if (answered.outcome !== body.outcome) throw new ApiError("handoff_answered", answered.outcome === "expired" ? "The agent's hand-over expired before this answer: the agent was told it expired." : `The agent's hand-over was already answered ${answered.outcome}.`, { details: { outcome: answered.outcome } });
        if (answered.first) runs.remark(run.id);
        return send(res, 200, { outcome: answered.outcome }, { "cache-control": "no-store" });
      }
      case "listRunFiles": {
        const run = await needRun(id);
        filesShown(run);
        // A remote box's turn just ended: its pull lands first, so the list shows what the box wrote.
        await runs.pulled(run.id);
        const workspace = await runWorkspace(run);
        const { files, deep } = workspace ? await listFiles(workspace, FILE_LIST_CAP) : { files: [], deep: false };
        files.sort((a, b) => a.path.localeCompare(b.path));
        return send(res, 200, { run_id: run.id, files: files.slice(0, FILE_LIST_CAP), complete: true, truncated: deep || files.length > FILE_LIST_CAP });
      }
      // An archived agent's home is read and written as any other's: as its definition is.
      case "listHomeFiles": {
        await needAgent(id);
        const home = await homeWorkspace(id, false);
        const { files, deep, owned } = home ? await listFiles(home, FILE_LIST_CAP, { owned: (name) => hostOwnedOf(name) !== undefined }) : { files: [], deep: false, owned: [] };
        // A host-owned path there is one entry by its name, and none of what is in it.
        const listed = [...files, ...owned.map((path) => ({ path, host_owned: true as const }))].sort((a, b) => a.path.localeCompare(b.path));
        return send(res, 200, { agent_id: id, files: listed.slice(0, FILE_LIST_CAP), complete: true, truncated: deep || listed.length > FILE_LIST_CAP });
      }
      case "readHomeFile": {
        await needAgent(id);
        const rel = homePath(second!, id, false, ownedReadAt(id));
        const home = await homeWorkspace(id, false);
        if (!home) throw new ApiError("not_found", "no such file");
        return sendWorkspaceFile(req, res, url, home, rel, "another user");
      }
      case "writeHomeFile": {
        await needAgent(id);
        if (!homeWrites) throw new ApiError("unsupported_here", HOME_WRITES_OFF);
        const rel = homePath(second!, id, true);
        const bytes = await bytesOf(req);
        // Each write lands whole (the Workspace's write is atomic); of two at once, the last one wins.
        const home = await homeWorkspace(id, true);
        await home!.write(rel, bytes).catch(homeRefusal);
        const written = await entryAt(home!, rel);
        if (written?.kind !== "file") throw new ApiError("not_found", "no such file");
        return send(res, 200, viewOf(rel, written));
      }
      case "deleteHomeFile": {
        await needAgent(id);
        if (!homeWrites) throw new ApiError("unsupported_here", HOME_WRITES_OFF);
        const rel = homePath(second!, id, true);
        const home = await homeWorkspace(id, false);
        if (!home) throw new ApiError("not_found", "no such file");
        // A file alone: a folder is refused by the listing; a link (never listed) by the Workspace's remove (ESCAPE).
        if ((await entryAt(home, rel))?.kind === "dir") throw new ApiError("invalid_file_path", "the path names a directory, or runs through a file");
        await home.remove(rel).catch((error: unknown) => {
          if (isWorkspaceError(error, "NOT_FOUND")) throw new ApiError("not_found", "no such file");
          homeRefusal(error);
        });
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
          for (const blocker of await blockersOf(env, { kind: "workflow", workflow: body.workflow as never, ...(body.tools ? { tools: body.tools as string[] } : {}) }, settings.get(), { offers, mcp: mcpTools }).catch(() => [])) {
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
        filesShown(run);
        await runs.pulled(run.id);
        const rel = checkedPath(decodedPath(second!), "the run's own, not a file it wrote");
        const workspace = await runWorkspace(run);
        if (!workspace) throw new ApiError("not_found", "no such file");
        return sendWorkspaceFile(req, res, url, workspace, rel, "a tool in the run's box");
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
        // A run this server holds as ended whose end the store does not have yet is pending: counted as it ended, its
        // metrics left out until the store has them (stats.ts pendingOf).
        const [stats, analytics, rows, pending] = await agents.request(() => {
          const stats = agents.store.stats();
          const pending = pendingOf(stats.running, runs);
          return [stats, agents.store.analytics({ ...filter, pending }), agents.store.listRuns(), pending] as const;
        });
        // How the runs that tried to learn fared: a held run's learning from memory, any other's end from the ledger.
        return send(res, 200, { ...statsView(stats, runs, pending), analytics: analyticsView(analytics, filter), learning: await runs.learning.counts(rows, filter) });
      }
      case "listToolKeys":
        // The offers the server holds, not capabilities': a model key's row names the harnesses its key would run too.
        return send(res, 200, toolKeys.view(offers));
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
      // Never through `idempotent`: its record keeps the body, and a body may hold a credential.
      case "listMcpServers":
        return send(res, 200, mcpServers.list());
      case "getMcpServer":
        return send(res, 200, mcpServers.get(id));
      case "previewMcpServer":
        return send(res, 200, await mcpServers.preview(await bodyOf(req), stopping.signal));
      case "saveMcpServer":
        return send(res, 200, await mcpServers.save(id, await bodyOf(req), stopping.signal));
      case "refreshMcpServer":
        return send(res, 200, await mcpServers.refresh(id, stopping.signal));
      case "startMcpOAuth": {
        // The cookie is set on the address the request came to, and the authorization server sends the browser back
        // to the callback's: they must be the one origin, or the callback never sees the cookie. The redirect URI
        // stays that one address (a registered client names it), and a start from another answers where to go.
        const origin = mcpServers.callbackOrigin;
        if (ownOrigin(req) !== origin) throw new ApiError("wrong_origin", `This server's sign-in comes back to ${origin}, and finishes only in a browser that started it there: open the console at ${origin}${MCP_SETTINGS_PAGE} and sign in from it.`, { details: { open: `${origin}${MCP_SETTINGS_PAGE}` } });
        const started = await mcpServers.oauthStart(id, await bodyOf(req));
        const state = new URL(started.authorization_url).searchParams.get("state") ?? "";
        return send(res, 200, started, { "set-cookie": signInCookie(req.socket.localPort, state, overHttps(req)) });
      }
      case "deleteMcpServer":
        mcpServers.remove(id);
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
        const { counts, impact, notes } = await runs.learning.ofAgent(rows, id);
        return send(res, 200, await agentLearning(data, id, secretsShown(serverSecrets()), counts, impact, notes));
      }
      case "listLearningNotes":
      case "listLearningLog":
        await needAgent(id);
        if (found.name === "listLearningNotes") {
          // Each note's runs (given it, read it), counted as the agent's learning view counts them (learning-run.ts ofAgent).
          const { notes } = await runs.learning.ofAgent(await agents.request(() => agents.store.listRuns({ agent: id })), id);
          return send(res, 200, await learningNotes(data, id, url.searchParams, secretsShown(serverSecrets()), notes));
        }
        return send(res, 200, await learningLog(data, id, url.searchParams, secretsShown(serverSecrets())));
      case "readLearningFile":
        await needAgent(id);
        return sendNote(res, 200, await readNote(data, id, second!, secretsShown(serverSecrets())));
      case "writeLearningFile":
      case "retireLearningFile":
      case "approveLearningFile":
      case "restoreLearningFile": {
        await needAgent(id);
        const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
        const body = found.name === "writeLearningFile" ? await noteBody(req, MAX_BODY) : undefined;
        const written = await writeNote(data, id, second!, { ifMatch: header("if-match"), ifNoneMatch: header("if-none-match"), body, refuse: serverSecrets(), approve: found.name === "approveLearningFile", restore: found.name === "restoreLearningFile", draftTools: () => learnedDraftToolsOf(id) });
        // A name holding a secret (one the checks let by) is never echoed, not even as where the note is.
        const shown = secretsShown(serverSecrets());
        const located = written.status === 201 && shown.name(written.file) === written.file;
        return sendNote(res, written.status, { ...written, text: shown.text(written.text) }, located ? { location: `/v2/agents/${encodeURIComponent(id)}/learning/files/${written.file}` } : {});
      }
      case "getRunLearning":
        return send(res, 200, await runLearning(await needRun(id), secretsShown(serverSecrets()), serverSecrets(), data));
      case "getRunLearningDiff":
        return send(res, 200, await runDiff(data, await needRun(id), secretsShown(serverSecrets())));
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
      case "listTriggers":
        return send(res, 200, triggers.list());
      case "createTrigger": {
        const body = await bodyOf(req);
        // A webhook trigger's secret is in its first answer alone: the Idempotency-Key's record keeps the trigger and a
        // note, so a retry under the key gets the same trigger, never a second one, and never the secret.
        let secret: string | undefined;
        const answer = await idempotent(req, "/triggers", body, async () => {
          const { secret: shown, ...made } = await triggers.create(body);
          secret = shown;
          return { status: 201, body: shown ? { ...made, note: `Its secret was shown once, in the first answer; POST /v2/triggers/${made.id}/secret makes a new one.` } : made, headers: { location: `/v2/triggers/${made.id}` } };
        });
        const replayed = answer.headers?.["idempotent-replayed"] === "true";
        const { note: _, ...first } = answer.body as Json;
        return send(res, answer.status, secret && !replayed ? { ...first, secret } : answer.body, answer.headers);
      }
      case "listTemplates":
        return send(res, 200, { templates: templates.map(packageView) });
      case "applyTemplate": {
        const pkg = templates.find((t) => t.name === id);
        if (!pkg) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
        const body = await bodyOf(req);
        const answer = await idempotent(req, `/templates/${pkg.name}/apply`, body, async () => {
          const applied = await applyTemplate(pkg, body);
          return { status: 201, body: applied, headers: { location: `/v2/agents/${applied.agent_id}` } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "rotateTriggerSecret":
        return send(res, 200, triggers.rotate(id));
      case "getTrigger":
        return send(res, 200, triggers.get(id));
      case "updateTrigger":
        return send(res, 200, await triggers.update(id, await bodyOf(req)));
      case "deleteTrigger":
        triggers.remove(id);
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "fireTrigger": {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new ApiError("bad_request", "Running a trigger now takes an Idempotency-Key of 1 to 255 characters: a retry with the same key fires it once.");
        const fired = await triggers.fire(id, key);
        return send(res, fired.created ? 202 : 200, fired.firing, fired.created ? {} : { "idempotent-replayed": "true" });
      }
      case "listTriggerFirings":
        return send(res, 200, triggers.firings(id));
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

  /** A run's live viewer's page and files (browser-live.ts): the owner's signed-in page alone, GET or HEAD, for a viewer the
   *  run's live process has handed over. The bytes are this server's own copy of pi-browser's viewer, never the run's port's:
   *  only the viewer's WebSocket reaches the run. */
  async function liveRoute(req: IncomingMessage, res: ServerResponse, runId: string, rest: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError("method_not_allowed", `${req.method} is not a method of a run's live view`, {}, { allow: "GET, HEAD" });
    if (!byOwnerSession(req)) {
      authFailed(`/v2/runs/${runId}/browser/live`, req.headers.authorization === undefined ? "no_credential" : "browser_without_session");
      throw req.headers.authorization === undefined ? new ApiError("unauthenticated", "a run's live browser view takes the owner's password sign-in in the console") : new ApiError("forbidden", "a run's live browser view takes the owner's password sign-in in the console, never a token");
    }
    const run = await needRun(runId);
    const viewer = /^\/v\/([A-Za-z0-9_-]{22})$/.exec(rest)?.[1];
    // A viewer's page, for a viewer the run has open; its two files, while the run has one open.
    const handover = !runs.hasProcess(run.id) || !liveRest(rest) ? undefined : viewer ? await handoverById(run.dir, viewer) : await readHandover(run.dir);
    if (!handover) throw new ApiError("not_found", "this run's browser has no live view at that address");
    await serveViewerFile(req, res, rest);
  }

  /** The origin of the address people open (`publicUrl`, AGENTRUN_PUBLIC_URL), lowercased; none, undefined. */
  const publicOrigin = (() => {
    try {
      return options.publicUrl ? new URL(options.publicUrl).origin.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  })();

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
      // A request cut before its body was read (push-handler.ts readCapped): its socket goes once the answer is out.
      if (error instanceof HookCut) res.once("finish", () => req.socket.destroy());
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
    // On loopback, a Host that is not one of its names (host-check.ts) is a page that rebound a name of its own to this
    // address. A browser is shown a page that says which names work; a script, the same in the error.
    if (names && !names.has(hostName(req.headers.host) ?? "")) {
      if (/\btext\/html\b/i.test(String(req.headers.accept ?? ""))) return sendHostRefused(req, res);
      return fail(new ApiError("forbidden", `unexpected Host header: ${hostFix(req.socket.localPort ?? 0)}`));
    }
    // Routed on the path as sent: a parsed URL folds `..` and `%2E%2E` segments away, and a file path must see them.
    const raw = (req.url ?? "/").split("?")[0]!;
    // Before the page: its cookie must not stand in for the token on the owner's own routes, nor on the MCP endpoint.
    if (owner && (raw === "/v2/setup" || raw === "/v2/setup/import" || raw.startsWith("/v2/auth/"))) return void ownerRoute(req, res, raw.slice(3), owner).catch(fail);
    if (raw === MCP_PATH) return void mcp(req, res).catch(fail);
    if (raw === "/llms.txt") return void answerLlms(req, res).catch(fail);
    if (answerPage(req, res, raw, { token, dir: data, authFailed, console: options.console, takesBytes, ...(owner ? { owner } : {}) })) return;
    if (!raw.startsWith("/v2/")) return fail(new ApiError("not_found", `no route ${raw}; the API is under /v2`));
    // A run's id needs no decoding: one that is not an id as sent (a stray or malformed escape) is no run's, and is never
    // decoded here, where a throw would leave the request listener.
    const viewing = LIVE_PATH.exec(raw);
    if (viewing) return ID.test(viewing[1]!) ? void liveRoute(req, res, viewing[1]!, viewing[2]!).catch(fail) : fail(new ApiError("not_found", "no run's live view at that address"));
    route(req, res, url, raw.slice(3)).catch(fail);
  });
  // A request's headers come within 10 s, whatever its route: nothing sends more than a few kilobytes of them. Its body
  // keeps Node's 5-minute request timeout, which an upload of a large file needs; the token-less hook route has its own
  // 30 s for its body (push-handler.ts HOOK_BODY_MS), so dribbling senders hold no socket for long.
  server.headersTimeout = 10_000;
  // The one upgrade this server takes: a run's live browser viewer's WebSocket (browser-live.ts). Every other is refused.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const raw = (req.url ?? "/").split("?")[0]!;
    const viewing = LIVE_PATH.exec(raw);
    const deny = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // On loopback, the Host check every route gets (host-check.ts), first: a page that rebound a name of its own to this
    // address sends its own name as Origin too, which the Origin check below would take, so its Host is what gives it
    // away. Its name alone, on any port, as the HTTP routes check it.
    if (names && !names.has(hostName(req.headers.host) ?? "")) return deny("403 Forbidden");
    if (!viewing || !ID.test(viewing[1]!) || !/^\/v\/[A-Za-z0-9_-]{22}\/ws$/.test(viewing[2]!)) return deny("404 Not Found");
    // A browser always sends its page's origin on a WebSocket, which no other page's script can forge: this server's own
    // (as this request reaches it, or its public address, which a TLS proxy that rewrites Host or drops
    // X-Forwarded-Proto leaves as the only one the owner's page has), and the owner signed in, or nothing.
    const sent = String(req.headers.origin ?? "").toLowerCase();
    if (sent === "" || (sent !== ownOrigin(req) && sent !== publicOrigin)) return (authFailed(raw, "live_view_origin"), deny("403 Forbidden"));
    if (!owner || !signedIn(req, owner)) return (authFailed(raw, "live_view_without_session"), deny("401 Unauthorized"));
    void (async () => {
      const run = await runs.get(viewing[1]!);
      const handover = run && runs.hasProcess(run.id) ? await handoverById(run.dir, viewing[2]!.slice(3, -3)) : undefined;
      if (!handover) return deny("404 Not Found");
      // Gone during the lookup (its close is past, and nothing would drop it from the viewers), or the server is closing
      // and has ended its viewers, or is about to.
      if (socket.destroyed || closing) return void socket.destroy();
      // Checked again after the lookup, then for as long as the socket is open: the sessions that let it in, and no other.
      const held = heldSessions(req);
      const admitted = () => held.some((value) => owner.valid(value));
      if (!admitted()) return deny("401 Unauthorized");
      viewers.watch(socket, admitted);
      proxyLiveUpgrade(req, socket, head, handover, viewing[2]!);
    })().catch(() => deny("500 Internal Server Error"));
  });
  const first = options.port ?? DEFAULT_PORT;
  const last = options.nextFreePort && first !== 0 ? Math.min(first + 99, 65_535) : first;
  for (let port = first; ; port++) {
    try {
      // Each attempt takes off both its handlers when it ends, so a taken port leaves no listener behind.
      await new Promise<void>((done, reject) => {
        const onError = (error: Error) => (server.off("listening", onListening), reject(error));
        const onListening = () => (server.off("error", onError), done());
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (port < last) continue;
      throw last > first ? Object.assign(new Error(`every port from ${first} to ${last} on ${host} is taken`), { code: "EADDRINUSE" }) : error;
    }
  }
  // The tool keys the server is started with, each checked once against its provider, in the background, once it
  // listens: a start that fails sends no check, and the start never waits on one. Capabilities are made again as each
  // answers (a refused one leaves its tools unavailable); close() aborts one still waiting. It never rejects.
  void toolKeys.checkServer(startFetch, stopping.signal, () => recompose()).catch(() => undefined);
  // Only a server that started takes up the import its owner asked for, or counts for setup's offer: one that failed to
  // listen hands back no close to stop them.
  if (offersImport && existsSync(importAsked)) void importAtSetup();
  else if (offersImport && options.countSessions && owner && !owner.hasPassword()) countSessions();
  const address = server.address() as AddressInfo;
  if (isLoopback(host)) names = loopbackNames(host, options.allowHosts, options.publicUrl);
  // An address of every interface is reached on this machine at its loopback one.
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${shown.includes(":") ? `[${shown}]` : shown}:${address.port}`;
  owner?.attach(options.publicUrl ?? url);
  webhooks.attach(options.publicUrl ?? url);
  mcpServers.attach(options.publicUrl ?? url, url);
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
    // An import under way stops between two session files and is waited for: nothing writes the store after close. A
    // count writes nothing (it lists and reads), so it is ended at once: its listing of a big home checks for no stop.
    closing = true;
    stopping.abort();
    // A harness install under way stops with the server: npm gets SIGTERM, then SIGKILL, and nothing half installed stays.
    const installStopped = Promise.all(Object.values(installs).map((install) => install.stop()));
    // Aborted now, so nothing it writes races the next server on the same refresh token; drained before the lock goes.
    const mcpStopped = mcpServers.close();
    triggers.close();
    for (const [worker, { task }] of workers) {
      if (task === "plan") void worker.terminate();
      else worker.postMessage("stop");
    }
    await Promise.all([...workers.values()].map((w) => w.exit));
    await importing;
    // Runs that end while their processes stop still give their notices; then the deliveries stop, before the lock goes.
    await runs.close();
    await installStopped;
    await relay?.close();
    // Before the lock goes: the image's last record lands first (box-image.ts), never after the next server's start.
    await image?.close();
    // The box network proxy goes with the server that owns it (box-egress-vm.ts); its volume stays for the next start.
    await egress?.close();
    await webhooks.close();
    // An upgraded socket is no connection closeAllConnections ends, and server.close waits for it.
    viewers.close();
    await new Promise((done) => (server.close(done), server.closeAllConnections()));
    agents.close();
    await mcpStopped;
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
    boxesLine: boxesLine(boxOffers, enabledBoxes(env), boxAllow, boxesByDefault(env)),
    // Once: a second call, at any time, is the first one's promise, so a close repeated after the next server started
    // never writes this data root's record again (the next server's, by then).
    close: () => (stopped ??= stop()),
    stopping: () => runs.stopping(),
  };
}
