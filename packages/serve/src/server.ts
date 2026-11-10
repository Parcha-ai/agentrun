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
import { type Revision, type RunOrigin } from "@parcha/pi-durable-agent";
import { type AgentEntry, agentRevision, agentRevisions, agentView, commitAgent, createAgent, definitionOf, etagOf, getAgent, listAgents, revisionView, setAgentArchived, setCurrentRevision } from "./agents-store.js";
import { WORKFLOW_ADAPTERS } from "./app.js";
import { DECISION_ADAPTER, decisionsOf, FAUX_JEV_ENV, FAUX_OPENROUTER_ENV, FAUX_PARALLEL_ENV, fauxFetch } from "./decisions.js";
import { FAUX_WEB_ENV } from "./web-fetch-direct.js";
import { FAUX_MONID_ENV } from "./monid.js";
import { FAUX_EXA_ENV } from "./exa-keyless.js";
import { FAUX_BROWSER_ENV, NODE_TOOLS, toolingOf, toolOf, toolsView } from "./tools.js";
import { ApiError, type InputIssue, invalid, unsupported } from "./errors.js";
import { deref, explain } from "./explain.js";
import { HOME_HOST_OWNED, RUN_META, SETUP_LOST } from "./files.js";
import { DATA_ENV, readJson, syncDir, TOKEN_FILE, writeDurable } from "./server-fs.js";
import { checkedPath, decodedPath, homePath, hostOwnedOf, type OwnedReadAt } from "./home-path.js";
import { chooseModel, EFFORTS, FAUX_ENV, FAUX_UPSTREAM_ENV, MODEL_NODES, type ModelNeeds, modelSource, THINKING_LEVELS, unpricedModels, withoutFaux } from "./model.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessCapability, harnessOfBody, harnessOffers } from "./harness.js";
import { HARNESS_TABLE_ENV, harnessOf } from "./harness-table.js";
import { HarnessInstall, harnessesOf, installDirOf, NPM_STOP_GRACE_MS, npmInstall, removeFlatInstall } from "./harness-install.js";
import { healthOf, hostMemory, maxRunsOf, MIN_FREE_MIB, runsThatFit } from "./host.js";
import { IMPORT_ASKED } from "./import.js";
import type { ImportAnswer, ImportTask } from "./import-worker.js";
import { answerStoreCall, type StoreCall } from "./import-proxy.js";
import type { MessageOrigin } from "@parcha/pi-durable-agent/timeline";
import { gradeModelOf, LEARNING_LABEL, learningBudgetOf, type LearningMode, learningOf, seedOf } from "./learning.js";
import { agentLearning, learningLog, learningNotes, noteBody, pendingCount, readNote, secretsShown, sendNote, writeNote } from "./learning-routes.js";
import { answerLlms, MCP_PATH, mcpEndpoint } from "./mcp.js";
import { openapiDocument, servedOpenapi, UNSUPPORTED } from "./openapi.js";
import { boxesLine, defaultPlaceOf, NEW_AGENT_TOOLS, newAgentPlace, noBoxReason, type Place, placesOf, resolvePlace } from "./place.js";
import { BOX_ALLOW_ENV, boxAllowOf, boxLimitsOf, boxNetworkOf, FAUX_BOX_ENV, fauxBoxes } from "./run-box.js";
import { Owner, passwordProblem, SESSION_MS } from "./owner.js";
import { answerPage, byOwnerSession, heldSessions, isJson, overHttps, ownerCookie, ownOrigin, sendHostRefused, signedIn } from "./page.js";
import { hostFix, hostName, loopbackNames } from "./host-check.js";
import { computerViewerLink, familyReaches, handoverById, type LiveFamily, type LiveHandover, liveRest, liveViewer, liveViewerById, liveViewerFor, liveViewerLink, OpenViewers, proxyLiveUpgrade, readHandover, readHandovers, serveViewerFile, viewerAnswers, viewerLink } from "./browser-live.js";
import { browserHandBack, handBackTarget } from "./browser-commands.js";
import { type ComputerOf, computerView } from "./computer-view.js";
import { durationMs, logLine } from "./print.js";
import { knownToolCostOf, redactorOf, type RunMoment, type State, type Status, toolCostOf } from "./run-view.js";
import { approve, archiveRun, cancel, message, pause as pauseRunOverStore, raiseCap, resume as resumeRunOverStore, type StartDeps, type StartOptions, startRun, stop as stopRunOverStore, WAITS_ON_A_PERSON } from "./runs-over-store.js";
import { momentOverStore, summaryOverStore, timelineOverStore, type ViewDeps, viewOverStore, withheldOverStore } from "./store-view.js";
import { servedTimelineRows } from "./run-timeline-served.js";
import { servedRunLearning } from "./run-learning-served.js";
import { runCutValues } from "./run-cut.js";
import { readLaunchBody } from "./run-launch.js";
import { listRunFiles as listRunFilesOverStore, readRunFile as readRunFileOverStore, runBrowserState, runGraphView, type RunReadsDeps, runTimelines } from "./run-reads-over-store.js";
import { triggerTargets, type TriggerTargetDeps } from "./trigger-targets.js";
import { listRuns as listRunsOverStore, readRun as readRunOverStore, runOfOrigin as runOfOriginOverStore } from "./store-reads/runs.js";
import { runEntries, runTimeline } from "./store-reads/journal.js";
import { metersOverStore } from "./store-reads/cap.js";
import { watchRun } from "./live/stream.js";
import { stats as statsOverStore } from "./store-reads/stats.js";
import { analytics as analyticsOverStore } from "./store-reads/analytics.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgenticBody, type NewRevision, openSqliteStore, type RevisionPlace, type RunRow, type Store, StoreBusy, StoreConstraint, type WorkflowBody } from "./store/index.js";
import { FINAL_STATES } from "./store/store.js";
import { runModelRef } from "./model.js";
// The v2 run statuses, as the run view names them (run-view.ts Status), for the list filter's validation. */
const STATUSES = ["queued", "working", "paused", "input_required", "completed", "failed", "cancelled"] as const;
/** A busy store, and the home_busy answer it maps to (byte-identical to the old agents.ts words), for a read or write that
 *  meets the one store under load. */
const storeBusy = (error: unknown): boolean => error instanceof StoreBusy;
const homeBusy = (): ApiError => new ApiError("home_busy", "the agent store is busy with another write; try again", { retry_after_ms: 500 });
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
import { CAP_MODES, type CapMode } from "./cap.js";
import { type Blocker, blockersOf, CODE_NODES_ENV, issueOf, MCP_HARNESSES, NOT_SET_UP, type RevisionShape } from "./runnable.js";
import { hostSecrets, SECRET_NAMES, secret, type StoredKeys, withSecrets } from "./secrets.js";
import { isSecretWriteOperation, SECRET_WRITE_REFUSAL, secretsWritableFields, secretWriterFacts, writesSecret, writesSecretsAllowed } from "./secret-writes.js";
import { bootSealKey } from "./seal-key.js";
import { redactedOutput } from "./key-refusal.js";
import { analyticsFilter, analyticsView, statsView } from "./stats.js";
import { agentLearningOverStore, learningCountsOverStore } from "./store-reads/learning.js";
import { outcomes } from "./usage.js";
import { keyOf, SEAL_KEY_ENV, sealKeyOf, TOOL_FIELDS } from "./tool-keys.js";
import { toolKeysOverStore } from "./tool-keys-store.js";
import { SIGN_INS_DIR, vendorsOver } from "./sign-ins.js";
// E1b builds the store-backed sign-ins bridge (the old SignIns interface — peek/forgotten/view/forget — over store.signIns,
// byte-identical v2 shapes; "held"/held_by from a live run whose sign_in_handed holds the pointer, verified_at from the
// last holder's lease end). TODO(E1b): wire its sha; named import until then.
import { signInsOverStore } from "./sign-ins-store.js";
import { MCP_AUTH_TYPES, type McpTool } from "./mcp-probe.js";
import { mcpServersOverStore } from "./mcp-servers-store.js";
import { privateHostsRoute } from "./mcp-private-hosts.js";
import { metaToolOf } from "./mcp-meta.js";
import { MCP_SETTINGS_PAGE, signInCookie, startedHere } from "./mcp-oauth.js";
import { type RunNotice, WEBHOOK_EVENTS, Webhooks } from "./webhooks.js";
import { appPermissionWarnings } from "./template-github-permissions.js";
import { templateApplied, templateTriggerSecret, templateWebhookSecrets, triggerMade, triggerRotated, webhookSaved, withTriggerSecret } from "./trigger-secrets-shown.js";
import { type SealedSettingsOverStore } from "./sealed-settings-store.js";
import { type ServerSecrets } from "./server-secrets.js";
import { openServerSecretsOverStore } from "./server-secrets-store.js";
import { Slack } from "./slack.js";
import { slackThreadOf as threadIn } from "./trigger-slack.js";
import { removeSourceSettings, saveSourceSettings, serverSettingsOf, sourceSettingsView } from "./source-settings.js";
import { HOOK_TOLERANCE_S } from "./standard-webhooks.js";
import { GitHubConnect, GitHubConnection, INSTALLED_PATH, startedHere as gitHubStartedHere, stateCookie } from "./github-connection.js";
import { GITHUB_API } from "./github.js";
import { HookCut, receivePush } from "./push-handler.js";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { registerSources, TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { webhook } from "./trigger-webhook.js";
import { SCHEME_NAMES } from "./trigger-signatures.js";
import { permissionFrom, pinWords } from "./tool-gate.js";
import { CATCHUP_WINDOW_S, FAILURES_TO_PAUSE, HISTORY_KEPT, MIN_EVERY_S, PAYLOAD_KEPT_BYTES, type RunTrigger, SOURCE_KINDS, TARGET_KINDS, type TriggerClock, Triggers } from "./triggers.js";
import { applyBodyOf, compiled, GITHUB_TRIGGER_UNCONNECTED, githubTriggerWords, madeTriggerIssues, type Package, packageModel, packageView, readPackages, type TemplatesDeps } from "./templates.js";
import { checkDefinitionBody, DEFAULT_INPUT_SCHEMA, type DefinitionBody, definitionBodyIssues, ID, IDEMPOTENCY_TTL_S, inputIssues, isObject, type Json, stable, unknownFields } from "./validate.js";
import { agentTools, browserKeyRow, isUnavailable, keptVendor, type Plane, recheckPlane, settingsIssues, ToolSettings, type ToolSettingsMap, whyUnavailable, withDefaults } from "./tool-plane.js";
import { toolSettingsOverStore } from "./tool-settings-store.js";
import { writeApprovers } from "./server-approvers.js";
import { MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, Uploads, UPLOADS_DIR } from "./uploads.js";
import { entryAt, listFiles, sendFile as sendWorkspaceFile, viewOf } from "./run-files.js";
import { COMPUTER_ROUTES, computerHoldOf, computerRoute } from "./computer-routes.js";
import { PROVIDERS as COMPUTER_PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";
import { capabilityToolDefs, hostToolDefs } from "@parcha/agentrun-kernel/kernel";
import { archilRoute, createArchilRoutes } from "./archil-routes.js";
import { computerOfPlace, type ComputerKind, type ComputerSetting, type PlaceView } from "./computer-setting.js";
import { computerCapabilities, type ComputerRoutes, createComputerRoutes, folderModeOf, type KindRegistry, settingsComputerRoute } from "./computers.js";
import { FAUX_VIEW_PATH, type FauxComputers, fauxComputers } from "./faux-computers.js";
import { runComputerField } from "./run-computer.js";
import { writesHeld } from "./workspace.js";
import { agentHomeFolder, computerProviderFactories, computerProviderMakers, isWorkspaceError, localWorkspace, runFolder, serverRunWorkspace, storeLedger, type Workspace } from "./workspace/index.js";
// server-lock.ts is gone: the store's EXCLUSIVE connection is the one-server lock (StoreOwned refuses a second server).

export const CONTRACT = "agentrun.v2/0";

/** A process's flags for a worker of it: without --input-type and the code string given with -e, --eval, -p or --print. */
const workerArgs = (args: readonly string[]): string[] =>
  args.filter((arg, i) => !arg.startsWith("--input-type") && !/^(?:-e|--eval|-p|--print)(?:=|$)/.test(arg) && !/^(?:-e|--eval|-p|--print)$/.test(args[i - 1] ?? ""));
export const DEFAULT_PORT = 7340;
const VERSION: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const IDEMPOTENCY_FILE = ".idempotency.json";
/** A run's live viewer, under the run's path (browser-live.ts): its run id, the family's address (`computer`, one for every
 *  computer kind; `browser`, the browser's own), then its page, files or WebSocket. Both are served by the same code. */
const LIVE_PATH = /^\/v2\/runs\/([^/]+)\/(computer|browser)\/live(\/.*)$/;
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
  /** A test hook the per-run process used for carry-back; the runner owns carry-back now (unused by the server cut). */
  carryBackRetry?: unknown;
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
  /** The server's store (store/index.ts), where the triggers and their firings live, with the agents they run as. Without
   *  it the trigger routes answer unavailable and nothing fires. */
  store?: Pick<Store, "triggers" | "runs" | "agents"> & Partial<Pick<Store, "liveViewers">>;
  /** A test's seam: the trigger sources this server has (default the registry, trigger-adapters.ts). */
  triggerAdapters?: readonly TriggerAdapter[];
  /** A test's seam: GitHub's API, which Connect GitHub converts its code with and asks of the App's installations
   *  (default https://api.github.com: github.ts GITHUB_API). */
  githubApi?: string;
  /** A test's seam: the origin a github_app MCP server may have (default GitHub's hosted MCP: github.ts GITHUB_MCP_ORIGIN). */
  githubMcpOrigin?: string;
  /** A test's seam: how long a hook's body has to arrive, whole (default 30 s: push-handler.ts HOOK_BODY_MS). */
  hookBodyMs?: number;
  /** A test's seam: the folder the template packages are read from, in place of the package's own (templates.ts). */
  templates?: string;
  /** The waits before each try again of a webhook delivery (default 5 s, 5 min, 30 min, 2 h, 5 h and 10 h: webhooks.ts RETRY_MS);
   *  a Slack post's too (slack.ts). */
  webhookRetryMs?: readonly number[];
  /** A test's seam: each trigger source's service, by source, in place of its own (Slack's Web API: trigger-slack.ts). */
  sourceApis?: Readonly<Record<string, string>>;
  /** The box runs' harnesses run in (4a's Box: its reap; on a shared server its run cgroups): the boxes runs leave are
   *  swept at start and let go at archive. The quarantine of boxes a reap could not empty is kept in the data directory. */
  box?: BoxHost;
};

/** Each test switch a run's process reads, by the variable it reads it from: set only under `faux`, but the faux
 *  harness's, which scripts the harnesses with or without it. */
const FAUX_SWITCHES = [["fauxBrowser", FAUX_BROWSER_ENV], ["fauxWeb", FAUX_WEB_ENV], ["fauxJev", FAUX_JEV_ENV], ["fauxParallel", FAUX_PARALLEL_ENV], ["fauxOpenrouter", FAUX_OPENROUTER_ENV], ["fauxMonid", FAUX_MONID_ENV], ["fauxUpstream", FAUX_UPSTREAM_ENV], ["fauxExa", FAUX_EXA_ENV], ["fauxBox", FAUX_BOX_ENV], ["fauxEgress", FAUX_EGRESS_ENV]] as const;

/** The test switches a run's process gets, each module path resolved: empty outside tests. A test's in-process runner
 *  takes the same (test/support.mjs startInProcessRunner). */
export function fauxEnvOf(options: ServeOptions): NodeJS.ProcessEnv {
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
  // Answered here only with accounts off: with accounts on, the owner's routes answer it before any route (ownerRoute).
  { method: "GET", pattern: /^\/auth\/session$/, name: "getAuthSession" },
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
  // The run's live computer view (GET: getRunComputer), and its owner's take-over and hand-back (the named 501 until the
  // store-backed take-over lands). The run routes stay together.
  { method: "GET", pattern: /^\/runs\/([^/]+)\/computer$/, name: "getRunComputer" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/computer\/take-over$/, name: "takeOverRunComputer" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/computer\/hand-back$/, name: "handBackRunComputer" },
  // Settings → Computers (computers.ts settingsComputerRoute) and the owner's Archil settings (archil-routes.ts
  // archilRoute): the server switch dispatches them, once the server opens its store.
  { method: "GET", pattern: /^\/computers$/, name: "listComputers" },
  { method: "PUT", pattern: /^\/computers\/([^/]+)\/keys$/, name: "saveComputerKeys" },
  { method: "POST", pattern: /^\/computers\/([^/]+)\/test$/, name: "testComputer" },
  { method: "GET", pattern: /^\/workspace\/archil$/, name: "getWorkspaceArchil" },
  { method: "PUT", pattern: /^\/workspace\/archil$/, name: "putWorkspaceArchil" },
  { method: "DELETE", pattern: /^\/workspace\/archil$/, name: "deleteWorkspaceArchil" },
  { method: "POST", pattern: /^\/workspace\/archil\/test$/, name: "testWorkspaceArchil" },
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
  // Over the store-backed registry (mcp-private-hosts.ts privateHostsRoute); the PUT is a secret write as a whole, so the
  // one secret-write check takes it from the owner's session alone.
  { method: "GET", pattern: /^\/settings\/mcp-servers\/oauth\/private-hosts$/, name: "getMcpPrivateHosts" },
  { method: "PUT", pattern: /^\/settings\/mcp-servers\/oauth\/private-hosts$/, name: "putMcpPrivateHosts" },
  { method: "GET", pattern: /^\/settings\/tools$/, name: "getToolSettings" },
  { method: "PUT", pattern: /^\/settings\/tools$/, name: "putToolSettings" },
  { method: "GET", pattern: /^\/settings\/webhook$/, name: "getWebhook" },
  { method: "PUT", pattern: /^\/settings\/webhook$/, name: "saveWebhook" },
  { method: "DELETE", pattern: /^\/settings\/webhook$/, name: "deleteWebhook" },
  { method: "POST", pattern: /^\/settings\/webhook\/test$/, name: "testWebhook" },
  { method: "GET", pattern: /^\/settings\/sources\/([^/]+)$/, name: "getSourceSettings" },
  { method: "PUT", pattern: /^\/settings\/sources\/([^/]+)$/, name: "putSourceSettings" },
  { method: "DELETE", pattern: /^\/settings\/sources\/([^/]+)$/, name: "deleteSourceSettings" },
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
  // A pushed source whose settings are the server's has its own hook, POST /hooks/{its id}, one operation each; it and a
  // trigger's are served by the same handler (push-handler.ts).
  ...TRIGGER_ADAPTERS.filter((a) => a.push && a.settings?.scope === "server").map((a) => ({ method: "POST", pattern: new RegExp(`^/hooks/${a.id}$`), name: `receiveHook_${a.id}` })),
  { method: "POST", pattern: /^\/hooks\/([^/]+)$/, name: "receiveHook" },
  { method: "GET", pattern: /^\/integrations\/github$/, name: "getGitHubConnection" },
  { method: "DELETE", pattern: /^\/integrations\/github$/, name: "disconnectGitHub" },
  { method: "POST", pattern: /^\/integrations\/github\/connect$/, name: "connectGitHub" },
  { method: "GET", pattern: /^\/integrations\/github\/callback$/, name: "gitHubCallback" },
  { method: "GET", pattern: /^\/integrations\/github\/installed$/, name: "gitHubInstalled" },
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
/** A run's computer as GET /computer reads it with no viewer open: kind browser where its agent has the browser tool, its
 *  kept plane's (a run from before the plane names none, and is Browserbase's where it grants the tool) checked again as a
 *  launch would be; off, saying why, where it has none or its browser resolves unavailable here.
 *  TODO: the agent's own `computer: {kind, provider?}` setting once definitions carry it (desktop, phone). */
function computerOf(kept: Plane["browser"], env: NodeJS.ProcessEnv, family: LiveFamily = "computer"): ComputerOf {
  const browser = kept === undefined ? undefined : recheckPlane({ browser: kept }, env).browser;
  if (browser === undefined) return { off: family === "browser" ? "this run's agent has no browser tool" : "this run's agent has no computer" };
  return isUnavailable(browser) ? { off: whyUnavailable(browser) } : { kind: "browser" };
}

/** The run's kept browser vendor, over the store, as computerOf reads it: the vendor its launch plane resolved at start
 *  (the same source the runner's claim reads), normalized to the vendor name (keptVendor) so recheckPlane re-resolves it as
 *  a vendor, not a stored no-key sentinel; with no browser in the plane, the default vendor when the run's revision grants
 *  the browser tool, else none. */
async function keptBrowserOf(store: Store, runId: string): Promise<Plane["browser"]> {
  const row = await store.runs.launch(runId).catch(() => undefined);
  const plane = row ? readLaunchBody(row.body)?.plane : undefined;
  const kept = plane ? keptVendor(plane).browser : undefined;
  if (kept !== undefined) return kept;
  const runRow = await store.runs.get(runId);
  const revision = runRow ? await store.agents.revision(runRow.revisionId) : undefined;
  const granted = ((revision?.body as { tools?: readonly string[] } | undefined)?.tools ?? []).includes("browser");
  return granted ? "browserbase" : undefined;
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
      condition: "Started by its launcher (the package's agentrun-serve, the image's entrypoint), the server takes each secret named here over a pipe and holds it in memory only, and a run's process gets, over a pipe of its own, a tool key only when its revision names a tool the key unlocks and a model key only when its model needs it: a pi run its model's provider's (per tier for a workflow), or the gateway's behind AGENT_MODEL_BASE_URL; a codex run OPENAI_API_KEY, or the gateway's; a claude-agent run ANTHROPIC_API_KEY. It never gets the server's own (its token, the seal key, the store's URL, the boxes' keys), and the decision keys a run's decision nodes need, and Parallel's where its web_fetch or web_search resolves to Parallel, and no other, go on a descriptor of their own: none of them is in any process's environment or command line. No run's environment holds any variable named like a key (a KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASS, PAT, CREDENTIAL, CREDENTIALS or DSN segment, or a last PWD after another), on this list or not; one not on it stays in the server's own. The launcher runs before any run's process exists; the image starts it as PID 1. Started another way (node dist/cli.js), the server reads them from its environment, where a process of its user can read them.",
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
      /** The owner watches a run's browser live (GET /runs/{id}/browser, and GET /runs/{id}/computer, browser-live.ts), takes
       *  it over from the viewer and hands it back, and answers the agent's ask for them (POST /runs/{id}/browser/hand-back,
       *  browser-person.ts). */
      browser_live: { read_only: false, take_over: true, ask: true },
      /** An agent's browser stays signed in between its runs (sign-ins.ts): with a seal key to keep each pointer under, and a
       *  browser vendor here (Browserbase's or Kernel's; local Chrome keeps none). */
      sign_ins: sealKeyOf(env[SEAL_KEY_ENV]) !== undefined && tools.some((tool) => tool.name === "browser" && tool.available),
      vault: false,
      query: false,
      /** GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept sealed under the launcher's seal key
       *  (tool-keys.ts); with none handed over, nothing is kept, never in the clear. */
      tool_keys: { routes: true, at_rest: "sealed" },
      /** /settings/mcp-servers: remote MCP servers previewed and saved, each credential sealed under the server's seal key,
       *  which always exists (seal-key.ts), so MCP credentials are always kept sealed. */
      mcp_client: { transports: ["streamable-http"], auth: [...MCP_AUTH_TYPES], at_rest: "sealed", harnesses: [...MCP_HARNESSES] },
      /** This server's learning switch (`--learning`): on, a run learns when its agent says `learning: true`; off, none does. */
      learning,
      /** /settings/webhook: one URL POSTed, signed by the Standard Webhooks spec, when a run needs its person and when it
       *  ends (webhooks.ts); its secret kept sealed under the same seal key, so with none no webhook is set. */
      // Always sealed: the server starts with its seal key (seal-key.ts ensureSealKey), so nothing is kept in the clear.
      webhooks: { routes: true, events: [...WEBHOOK_EVENTS], signing: "standard-webhooks/v1", at_rest: "sealed" },
      /** /triggers: what starts an agent's capped runs with no caller (triggers.ts). */
      triggers: { routes: true, sources: [...SOURCE_KINDS], targets: [...TARGET_KINDS], min_every_s: MIN_EVERY_S, history_kept: HISTORY_KEPT, catchup_window_s: CATCHUP_WINDOW_S, failures_to_pause: FAILURES_TO_PAUSE, webhook: { signing: "standard-webhooks/v1", signatures: [...SCHEME_NAMES], tolerance_s: HOOK_TOLERANCE_S, max_body_bytes: webhook.push!.maxBodyBytes, payload_kept_bytes: PAYLOAD_KEPT_BYTES, at_rest: "sealed" } },
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

// A data directory an earlier version wrote (old agent homes, an old runs/ layout, or an earlier store version) is refused
// by the store itself when it opens (StoreFromEarlierVersion), in words, to start fresh: no pre-open scan, no migration.

export async function startServe(options: ServeOptions): Promise<Serve> {
  // A harness table module is the server's to name, from `harnessTable` alone, for itself and its runs: one in its own
  // environment (an operator's export, a leftover) never loads, wherever the server reads its environment.
  delete process.env[HARNESS_TABLE_ENV];
  // No start without a seal key (seal-key.ts): the one handed over, else the one kept under the config home, made at the
  // first start with only its path printed. Every secret here is kept under it; there is no keeping one in the clear.
  const seal = bootSealKey();
  await mkdir(resolve(options.data), { recursive: true, mode: 0o700 });
  // Canonical once, here: a box's mount source below it must then be its own canonical path, through no link (run-box.ts).
  const data = await realpath(resolve(options.data));
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
  // One server per data root is the store's own EXCLUSIVE lock (StoreOwned), taken when startHolding opens the store; a
  // data directory an earlier version wrote is refused there too (StoreFromEarlierVersion), in words, to start fresh. No
  // server.lock, no oldHomes/oldLayout checks, no migration.
  // What a start that fails stops: the webhook deliveries it began, which would write the next server's outbox, and the
  // store handle it opened.
  const stops: Array<() => Promise<void>> = [];
  try {
    return await startHolding(options, data, { maxRuns, minFreeBytes, learning, learningBudget, boxAllow, templates, sealKey: seal.key }, stops);
  } catch (error) {
    for (const stop of stops) await stop().catch(() => undefined);
    throw error;
  }
}

async function startHolding(options: ServeOptions, data: string, checked: { maxRuns: number; minFreeBytes: number; learning: LearningMode; learningBudget: number; boxAllow: readonly string[] | "none"; templates: Package[]; sealKey: Buffer }, stops: Array<() => Promise<void>>): Promise<Serve> {
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
  // Given a token (AGENTRUN_TOKEN), a .token an earlier start made holds one this server refuses: it goes, so nothing
  // (a person told the token is there, a CLI that reads it) takes a dead token from it. A later start without one makes a
  // new file and token.
  if (options.token !== undefined) await rm(join(data, TOKEN_FILE), { force: true });
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
  let triggerSettings: Map<string, SealedSettingsOverStore> = new Map();
  const base = { ...withoutFaux(process.env), [DATA_ENV]: data, ...(options.allowCodeNodes ? { [CODE_NODES_ENV]: "1" } : {}), ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}), ...(options.harnessTable ? { [HARNESS_TABLE_ENV]: resolve(options.harnessTable) } : {}) };
  // The one store (module A), opened here as this data root's single owner, before the settings layers that read it: its
  // EXCLUSIVE lock is the one-server lock (no server-lock.ts), and it refuses a data directory an earlier version wrote, in
  // words, to start fresh (no oldHomes/oldLayout checks, no migration). Every agent, run, setting and sign-in is a row; the
  // server writes and reads rows, and a runner (its own process, sharing only this store) runs every run.
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  stops.push(() => store.close());
  // Which fields are the server's is read from what it is started with alone: handed the saved keys too, ToolKeys would
  // call each the server's, and none could be deleted. The keys are sealed rows in the store; load() reads them once here.
  const toolKeys = toolKeysOverStore(store, withSecrets(base, "own"), (fields) => (log ? log(logLine("tool_keys", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("tool_keys", fields)}\n`)));
  await toolKeys.load();
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
  const mcpServers = mcpServersOverStore(store, withSecrets(base, "own"), VERSION);
  if (options.githubMcpOrigin) mcpServers.appOrigin = options.githubMcpOrigin;
  // The saved MCP servers' metadata (their addresses and the tools they list), a snapshot the run-grant checks read in
  // step (blockersOf's `mcp`, and the template apply): the server is the one writer of these rows (a save, refresh, sign-in
  // or delete), so the snapshot is refreshed after each of those and reads what is saved now. The runner reads the registry,
  // pins and credentials from the store at a run's claim (runner/mcp-claim.ts); this server hands a run no MCP source.
  let mcpMeta = new Map<string, { url: string; auth: string; tools: readonly McpTool[] }>();
  const refreshMcpMeta = async (): Promise<void> => {
    mcpMeta = new Map((await store.mcp.servers()).map((row) => [row.name, { url: row.url, auth: row.auth, tools: (row.tools as McpTool[]) ?? [] }]));
  };
  await refreshMcpMeta();
  // Each saved server's tools in the harnesses' shape (the registry keeps input_schema; a bound tool takes inputSchema),
  // with whether each can be granted: a known meta tool can't (mcp-meta.ts).
  const mcpTools = (server: string) => {
    const saved = mcpMeta.get(server);
    return saved?.tools.map((tool) => {
      const meta = metaToolOf(saved.url, tool.name);
      const bound = { name: tool.name, ...(tool.title ? { title: tool.title } : {}), ...(tool.description ? { description: tool.description } : {}), inputSchema: (tool.input_schema ?? {}) as Record<string, unknown>, ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}) };
      return meta ? { ...bound, grantable: false as const, reason: meta.reason } : bound;
    });
  };
  // The server's tool settings, in the store: capabilities say what they resolve to, again after a PUT. load() reads them
  // once here.
  const settings = toolSettingsOverStore(store);
  await settings.load();
  // Whether anyone can answer an ask here (accounts on), for the runners, which read it from the store at each claim
  // (server-approvers.ts): the one way a runner learns it.
  await writeApprovers(store.settings, options.accounts === true);
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
    // A run's learning, view, list and timeline row are cut of the keys saved now by the run view at read time (it reads
    // serverSecrets live, store-view), so a key change needs no cache invalidation here.
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
  // A test's own sources are ones a run's message origin may name too (the registry's are already).
  if (options.triggerAdapters) registerSources(adapters);
  const openapi = openapiDocument((operationId) => ROUTES.find((r) => r.name === operationId)?.capability, adapters);
  const sealKey = sealKeyOf(withSecrets(base, "own")[SEAL_KEY_ENV]);
  // Settings → Computers and the owner's Archil settings, over the one store (computers.ts, archil-routes.ts), built once
  // at the first request, when the server's own address is known (--faux's desktop view is a page on it). The real kind
  // registry and each provider's create() are the computer package's (kinds.ts, providers.ts providerFor); under --faux,
  // faux-computers.ts's three providers stand in. The folder mode is read at each call (folderModeOf), so turning Archil
  // on or off needs no rebuild; a key named in the server's environment wins over a saved one.
  const browserToolNames = (await import("@parcha/pi-browser")).BROWSER_TOOLS.map((tool: { name: string }) => tool.name);
  const localTools = new Set(hostToolDefs({ maxExecS: 600, shell: "local" }).map((def) => def.name));
  const kindTools = (kind: ComputerKind): readonly string[] =>
    kind === "none" ? [] : kind === "sandbox" ? hostToolDefs({ maxExecS: 600, shell: "computer" }).map((def) => def.name).filter((name) => !localTools.has(name))
      : kind === "browser" ? browserToolNames : capabilityToolDefs(kind).map((def) => def.name);
  let faux: FauxComputers | undefined;
  const fauxOf = (): FauxComputers => (faux ??= fauxComputers({ viewerBase: ownOriginOf() }));
  let computerRoutes: ComputerRoutes | undefined;
  const computersOf = (): ComputerRoutes => (computerRoutes ??= createComputerRoutes({
    store, sealKey: checked.sealKey, tools: kindTools, mode: folderModeOf(store), env: process.env,
    ...(options.faux
      ? { kinds: fauxOf().kinds, factories: fauxOf().factories, keyTable: fauxOf().keyTable }
      : {
        kinds: { SETTING_KINDS, PROVIDERS: COMPUTER_PROVIDERS, servingRefusals } as unknown as KindRegistry,
        // The one place serve builds a provider (workspace/computer-providers.ts), the claim's makers' own.
        factories: computerProviderFactories(computerProviderMakers(), (id) => storeLedger(store.computerLedger, id)),
      }),
  }));
  const archil = createArchilRoutes({ store, sealKey: checked.sealKey, env: process.env });
  /** A run's computer on its read: its revision's computer setting, else the one its place says; absent for none. */
  const runComputerOf = async (runId: string, view: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const run = await store.runs.get(runId);
    const body = run ? ((await store.agents.revision(run.revisionId))?.body as { computer?: ComputerSetting; place?: PlaceView } | undefined) : undefined;
    const setting = body?.computer ?? (body?.place ? computerOfPlace(body.place) : undefined);
    if (!setting) return {};
    const error = view.error as { code?: unknown; message?: unknown } | null | undefined;
    const field = runComputerField(setting, { id: runId, status: String(view.status), ...(error && typeof error.code === "string" ? { error: { code: error.code, message: String(error.message ?? "") } } : {}) });
    return field ? { computer: field } : {};
  };
  // The agents accessor the routes call, over the one store (module A): the agents-store functions, with the run-row reads
  // the server makes (store-reads) under `.store`. `.request` is a thin pass-through — the store runs its own transactions,
  // so a call needs no outer serialization. The old Agents class and its per-agent home store are gone.
  const ctx = BACKGROUND_CONTEXT;
  const agents = {
    get: (id: string) => getAgent(store, id),
    list: (options: { archived?: boolean } = {}) => listAgents(store, options),
    create: (body: DefinitionBody, check?: (revision: NewRevision) => Promise<void>, fresh?: { place: RevisionPlace; tools: readonly string[] }) =>
      createAgent(store, body, { ...(check ? { check } : {}), ...(fresh ? { fresh } : {}) }),
    commit: (entry: AgentEntry, body: DefinitionBody, options: { ifCurrent?: string | null; check?: (revision: NewRevision) => Promise<void>; contract?: boolean } = {}) => commitAgent(store, entry, body, options),
    revisions: (id: string) => agentRevisions(store, id),
    revision: (agentId: string, revisionId: string) => agentRevision(store, agentId, revisionId),
    setCurrent: (entry: AgentEntry, revisionId: string) => setCurrentRevision(store, entry, revisionId),
    setArchived: (kind: "agent" | "run", id: string, archived: boolean) => (kind === "agent" ? setAgentArchived(store, id, archived) : archiveRun(store, id, archived)),
    request: <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve(fn()),
    dir: data,
    store: {
      listRuns: (filter: { agent?: string; revision?: string } = {}) => listRunsOverStore(store, filter, ctx),
      readRun: (id: string) => readRunOverStore(store, id, ctx),
      runOfOrigin: (key: string) => runOfOriginOverStore(store, key),
      readRevision: (id: string) => store.agents.revision(id),
    },
    close: () => store.close(),
  };
  ({ secrets: secretStores, settings: triggerSettings } = await openServerSecretsOverStore(store, data, env, adapters, (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`))));
  secretStores.add("server", () => [token]);
  // Each agent's saved sign-ins, over the one store (module A, sign-ins-store): the vendor's calls on the server's keys
  // (under faux, the vendor's fake alone), under this server's seal key. The store holds whether a sign-in is still held
  // (a live run's sign_in_handed) and who was handed it, so this takes no `holds`/`handedTo` callback — one store, one lock.
  const signIns = signInsOverStore(store, sealKey, vendorsOver(() => env, checkFetch));
  const webhooks = new Webhooks(data, env, (fields) => (log ? log(logLine("webhook", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("webhook", fields)}\n`)), options.webhookRetryMs);
  // The outbound webhook's secret, as it stands (set by a PUT, gone with a DELETE), and each it held before.
  secretStores.add("webhook", () => webhooks.signingSecrets());
  stops.push(() => webhooks.close());
  // The server's Slack app (slack.ts): its settings in the Slack source's sealed settings, its lines posted in threads.
  const slack = new Slack(data, triggerSettings.get("slack"), (fields) => (log ? log(logLine("slack", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("slack", fields)}\n`)), options.sourceApis?.slack, options.webhookRetryMs);
  stops.push(async () => slack.close());
  // A run a Slack trigger started is told in its thread when it needs its person and when it ends, beside the webhook's
  // notice (the run follower below). Its thread is the conversation its trigger's firing started it in: the run's launch
  // names the trigger and the conversation it started in (triggers.ts RunTrigger).
  const slackThreadOf = async (runId: string): Promise<{ channel: string; thread_ts: string; post_answer: boolean } | undefined> => {
    const launch = await store.runs.launch(runId).catch(() => undefined);
    const trigger = isObject(launch?.body) && isObject(launch.body.trigger) ? launch.body.trigger : undefined;
    if (typeof trigger?.id !== "string" || typeof trigger.conversation !== "string") return undefined;
    const found = await triggers.triggerOf(trigger.id);
    return found?.source.kind === "slack" ? { ...threadIn(trigger.conversation), post_answer: found.source.post_answer === true } : undefined;
  };
  // An answer-bearing end whose run cannot be read yet (a busy store) is read again after each of these waits, never
  // told without its answer; past the last it stays untold here, and the next start's catch-up tells it.
  const SLACK_READ_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000];
  const slackReads = new Set<NodeJS.Timeout>();
  stops.push(async () => slackReads.forEach((timer) => clearTimeout(timer)));
  const tellSlack = (event: "run.needs_input" | "run.ended", run: RunNotice, marker: string, tries = 0): void => {
    void (async () => {
      const thread = await slackThreadOf(run.run_id);
      if (!thread) return;
      // Read from the run's view only where the line needs it: the answer, for a trigger that posts it (its source's
      // post_answer, as the trigger is now); the tool an approval waits on, which the notice does not carry.
      const answered = event === "run.ended" && run.status === "completed" && thread.post_answer;
      const approval = event === "run.needs_input" && run.pending?.kind === "approval";
      const emit = (view: Json | null) => {
        const tool = approval ? (view?.pending as { tool?: unknown } | null | undefined)?.tool : undefined;
        const told = typeof tool === "string" ? ({ ...run, pending: { kind: "approval", tool } } as RunNotice) : run;
        const answer = answered ? ((view?.result as { final_answer?: string } | null | undefined)?.final_answer ?? null) : null;
        slack.emit(event, told, marker, { channel: thread.channel, thread_ts: thread.thread_ts }, answer);
      };
      if (!answered && !approval) return emit(null);
      await viewOverStore(store, run.run_id, viewDepsFor(ownOriginOf())).then(
        (view) => emit((view as Json | null) ?? null),
        (error: Error) => {
          // Unread: an approval's line goes without its tool's name; an end that carries the answer waits for it.
          if (!answered) return emit(null);
          const wait = SLACK_READ_RETRY_MS[tries];
          if (wait === undefined) return void process.stderr.write(`agentrun-serve: slack: the answer of run ${run.run_id} is still unread (${error.message}); its end is left for the next start\n`);
          const timer = setTimeout(() => (slackReads.delete(timer), tellSlack(event, run, marker, tries + 1)), wait);
          timer.unref();
          slackReads.add(timer);
        },
      );
    })().catch((error: Error) => void process.stderr.write(`agentrun-serve: slack: ${error.message}\n`));
  };
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
  // The run write half (runs-over-store): the server INSERTs a queued run and its launch (startRun), and writes command
  // rows (message/stop/cancel/raise/approve/archive) a run's runner reads and applies. No per-run process, no HTTP door,
  // no box relay here — a runner (its own process, sharing only this store) claims and runs every run. The leaves a start
  // needs that live in this request layer are gathered once as StartDeps; the run's model is resolved once, now (the runner
  // reads launch.model alone).
  const modelOf = (_entry: AgentEntry, revision: Revision) => runModelRef(env, revision);
  const startDeps: StartDeps = {
    runBodyIssues,
    pinnedOf,
    inputIssuesOf,
    explainRun,
    // told and fallbackPlace are const arrows declared later in startHolding; wrap them so startDeps captures the binding
    // (called at request time, after they are assigned) rather than reading them before their declaration.
    told: (error) => told(error),
    runnable,
    readyFiles: (ids) => uploads.readyFiles(ids as string[]),
    fallbackPlace: (kind, tools) => fallbackPlace(kind, tools),
    workflowTitle,
    serverSecrets,
    toolSettings: () => settings.get(),
    planeEnv: () => env,
    approvers: options.accounts === true,
    ...(documents ? { documents: resolve(documents) } : {}),
    ...(boxAllow !== undefined ? { boxAllow } : {}),
    modelOf,
    // The run's learning start, decided at start as the old file-backed start decided it (learning-run.ts onStart/seedFor):
    // the server's learning switch, the budget its # Learned section fits, the agent's seed read now from its learning folder
    // (git), and the host's secrets as they are shown now to cut the notes a run is given. runs-over-store.learningStartFor
    // pins the result (given/seed/section/seedNotes) in the launch for the runner; a seed that cannot be read starts the run
    // with nothing learned (a fault never refuses it). INERT until the runner installs learning-1's learningEndOfRun as its
    // endOfRun (cutover-learning-end 283008bb05, E2r3's one-line spec-builder hookup); land this in that same round.
    learning,
    learningBudget,
    seedFor: async (agentId: string) => {
      // The switch runs no git in this process (learning.ts seedOf: the folder's own script and file API, which checks git
      // itself); a git or folder fault surfaces here as a seedOf error, so the run starts with nothing learned, never refused.
      return seedOf(data, agentId).then(
        (seed) => ({ seed }),
        (error: Error) => {
          process.stderr.write(`agentrun-serve: the agent ${agentId}'s learning folder could not be read, so its run starts with nothing learned: ${error.message}\n`);
          return { failed: error.message };
        },
      );
    },
    shown: () => secretsShown(serverSecrets()),
  };
  // A run's served view and its live moment, from the store (store-view): `origin` is where this request reaches the
  // console, the secrets are cut live, and the sign-ins give the handed-pointer cut. Trigger and background reads (no
  // request) use the server's public address, else its own.
  // The run's key read from this server's environment with the keys a person saved, as its Timeline reads it (keyEnv below).
  const viewDepsFor = (origin: string): ViewDeps => ({ origin, serverSecrets, signIns, keyEnv: () => withSecrets(process.env, "all", storedKeys) });
  const ownOriginOf = (): string => options.publicUrl ?? url;
  // The run read routes (a run's files, its browser state, its workflow graph) over the one store (run-reads-over-store):
  // a run's files through the server's read-only Workspace of its folder (serverRunWorkspace, no runner claim), its view
  // and withheld verdict from store-view. The live browser viewer reads the runner's published handover from the store
  // (liveViewerLink, the one the runner's browser tool wrote under its claim), when this server has the seal key its token
  // is sealed under; with no seal key no live view is ever served, so the live branch is left off. The timeline route keeps
  // its own stub (store-reads journal + SSE) until E2c's timeline lands.
  const runReadsDeps: RunReadsDeps = {
    runWorkspace: (_store, runId) => serverRunWorkspace(store, runId, { data, sealKey }),
    env,
    runView: (_store, runId) => viewOverStore(store, runId, viewDepsFor(ownOriginOf())),
    withheld: (_store, runId) => withheldOverStore(store, runId, viewDepsFor(ownOriginOf())),
    cutValues: (_store, runId) => runCutValues({ serverSecrets, signIns }, store, runId),
    context: ctx,
    ...(sealKey ? { liveViewer: (runId: string) => liveViewerLink(store, sealKey, runId) } : {}),
  };
  // The run timeline reader over the store (run-reads-over-store runTimelines): one change-numbered RowLog per run, synced
  // from its journal (store-reads) on each read, its view (viewOverStore) for status/state/cost and whether it is final.
  // The route frames the SSE around its `page`, which long-polls the journal, byte-identical to the old live run's page.
  const timelines = runTimelines({
    context: ctx,
    // The run's rows as served (run-timeline-served.ts), by its one cut (run-cut.ts, read for each page: a secret rotated
    // or saved since is cut at once), the set its view's words, title and error are cut of: each secret this server never
    // shows and each browser sign-in pointer the run was handed; its decision rows among them, its error rows in the
    // error's words. A run whose hand can't be read back here is withheld: none of its rows. A run's Timeline is read
    // from its journal, which keeps what the run said whole.
    timelineRows: (forStore, runId, context) => servedTimelineRows({ serverSecrets, signIns, keyEnv: () => withSecrets(process.env, "all", storedKeys) }, forStore, runId, context),
    runView: (forStore, runId) => viewOverStore(forStore, runId, viewDepsFor(ownOriginOf())),
  });
  const triggerDeps: TriggerTargetDeps = {
    start: startDeps,
    getAgent: async (agentId: string) => (await getAgent(store, agentId)) ?? undefined,
    needAgent,
    momentOf: (runId: string) => momentOverStore(store, runId, viewDepsFor(ownOriginOf())),
    runStatus: async (runId: string) => ((await viewOverStore(store, runId, viewDepsFor(ownOriginOf())))?.status as string | undefined) ?? null,
    // A trigger's last run's answer (include_last_answer): the run's view, as GET /v2/runs/{id} serves it, its answer cut
    // of the secrets the run held.
    runEnd: async (runId: string) => {
      const view = await viewOverStore(store, runId, viewDepsFor(ownOriginOf()));
      if (!view) return null;
      const answer = (view.result as { final_answer?: unknown } | null)?.final_answer;
      return { status: String(view.status), ended_at: (view.ended_at as string | null) ?? null, answer: typeof answer === "string" ? answer : null };
    },
  };
  const targets = triggerTargets(store, triggerDeps);
  const expected = digest(`Bearer ${token}`);
  // The old per-run-process test hooks (beforeAbort/beforeReopenLaunch/onRunLoad/messageOrigin …) are the runner's now
  // (E2r), not the server's: a run executes in a runner process, not here. TODO(E2r): the equivalents on the runner's loop.
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
  /** Whether `req` may be shown a secret this server mints (trigger-secrets-shown.ts): the caller that may write one. */
  const mayHoldSecrets = (req: IncomingMessage) => writesSecretsAllowed(req, { accounts: owner !== undefined, loopbackBound: isLoopback(host) });
  /** A trigger's view with its minted secret's metadata, never the secret (trigger-secrets-shown.ts). */
  const withSecretOf = <T extends { id: string; source: { kind: string } }>(view: T) =>
    withTriggerSecret(view, adapters, (adapterId, scope, field) => {
      const settings = triggerSettings.get(adapterId);
      return settings?.get(scope, field) !== undefined ? "set" : settings?.unopenedAt(scope, field) ? "unopened" : "unset";
    });
  // The owner's open live views (browser-live.ts): each closes once no session that let it in holds.
  const viewers = new OpenViewers();
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
  // No server-side run recovery: a runner (its own process) claims every run an earlier runner left and resumes it from the
  // journal under the claim epoch — the server starts no run process and adopts none.
  // TODO(switch): rebuild the webhook catch-up over the store's run rows (listRuns + the run view's status) so an end a
  // stopped server never delivered is queued at the next start; deferred (webhooks stay until route-1's triggers8 merges).

  // Schedules: each firing starts its run as POST /agents/{id}/runs does, capped, under the firing's key (triggers.ts).
  // Firings an earlier server left due are driven again now, beside the recovery above.
  // Connect GitHub: the server's one GitHub App, in the store's trigger_settings (adapter github, scope server), where the
  // runner reads it per claim (runner/github-app.ts).
  const github = new GitHubConnection(triggerSettings.get("github"));
  const githubConnect = new GitHubConnect(github, { ...(options.publicUrl ? { publicUrl: options.publicUrl.replace(/\/+$/, "") } : {}), api: options.githubApi ?? GITHUB_API, say: (fields) => log?.(logLine("github", fields)) });
  /** The connection a GitHub template or the console reads: the App's id, slug and installations, never a secret. */
  const githubConnection = () => github.view();
  /** What applying a template reads of the server (templates.ts TemplatesDeps). */
  const templateDeps: TemplatesDeps = { githubConnection };
  // A github_app MCP server's tools are listed with an installation token of the App, narrowed to one repository it covers
  // with metadata read (tokenForListing); a run's own is minted in the runner (runner/github-app.ts). Every token minted
  // is a server secret while it may be in use.
  mcpServers.appToken = (signal) => githubConnect.tokenForListing(signal);
  secretStores.add("github-tokens", () => githubConnect.liveTokens());
  const triggers: Triggers = new Triggers({
    // The server's own store (the one it opened) holds the triggers a person writes and reads; a test may inject another
    // (startServe's `store`).
    store: options.store ?? store,
    clock: options.triggerClock,
    ...(options.publicUrl ? { publicUrl: options.publicUrl.replace(/\/+$/, "") } : {}),
    adapters,
    unavailable: (kind) => (kind === "github" && !githubConnection() ? new ApiError("github_not_connected", "This server has no GitHub App: Connect GitHub in Settings, then make the trigger (or turn it on).") : undefined),
    say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)),
    // The trigger target policy (what a trigger may start or message, and in what words it is refused) is the one store's
    // (trigger-targets.ts, over the run write half and the run view): targetIssues, start, message, statusOf, runOf. The
    // queue a firing takes — how many of a trigger's messages wait for a busy run — is route-1's store.triggers.
    ...targets,
    settings: (adapterId) => triggerSettings.get(adapterId),
    notify: (failed, key) => webhooks.emitTrigger(failed, key),
  });
  // A repair of the GitHub installations (below) stops before the triggers close, in a start that fails as in close.
  stops.push(() => githubConnect.close());
  stops.push(async () => triggers.close());
  // The firing loop runs against the server's own opened store: due firings start their runs through the run write half,
  // times missed while it was down are recorded, and the timer is armed for the next. (A test may inject its own store.)
  void triggers.start().catch((error: Error) => void process.stderr.write(`agentrun-serve: the triggers' start: ${error.message}\n`));
  // The App's installations repaired from GitHub's own, once, as the server starts: events missed while it was down. It
  // never rejects, and close (or a start that fails) aborts it and waits for it before it closes.
  void githubConnect.reconcile((detail) => triggers.turnOff("github", detail), { force: true });

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
        // The secrets this process holds (secrets.ts keeps them out of every environment, so the worker's has none), in the
        // worker's memory alone: what the import cuts out of everything it writes. The keys saved on the Tool keys page are
        // not passed; the worker reads them from the store over the port (sealed rows it opens with the seal key among these
        // secrets), the same cut as the CLI's import, where a saved key and the server's own of the same name may differ.
        workerData: { task, data, home: options.sessionsHome?.home ?? homedir(), ...(options.sessionsHome?.temp ? { temp: options.sessionsHome.temp } : {}), secrets: Object.fromEntries(SECRET_NAMES.flatMap((name) => { const value = secret(name); return value === undefined ? [] : [[name, value]]; })) } satisfies ImportTask,
        // Started from a string (its launcher runs node --input-type=module -e), the server's flags are given again
        // without that string and its type: a worker started from a file with them is refused. Otherwise the worker
        // inherits them as Node passes them on, which leaves out the flags a worker may not take (on Node 24 a test
        // runner's child holds many).
        ...(process.execArgv.some((arg) => arg.startsWith("--input-type")) ? { execArgv: workerArgs(process.execArgv) } : {}),
      });
      workers.set(worker, { task, exit: once(worker, "exit").catch(() => undefined) });
      let answer: ImportAnswer | undefined;
      // The import worker opens no store of its own: a message carrying `req` is one of its calls to this server's open
      // store, answered against it and posted back; anything else is its one final answer.
      worker.on("message", (message: StoreCall | ImportAnswer) => {
        if (typeof message === "object" && message !== null && "req" in message) void answerStoreCall(store, ctx, message).then((reply) => worker.postMessage(reply));
        else answer = message as ImportAnswer;
      });
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
    // Read once: the secret-write check reads a registered operation's body before its route does (secret-writes.ts).
    const read = bodies.get(req);
    if (read !== undefined) return read;
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
    const [{ learnedDraftTools }, { permissionOf }] = await Promise.all([import("./tools.js"), import("./tool-gate.js")]);
    const server = settings.get();
    // The revision row's body is the agentic body JSON (store-backed RevisionRow types it as unknown).
    const body = revision.body as { tools?: string[]; toolSettings?: unknown; approvals?: string };
    return learnedDraftTools(body.tools ?? [], (name) => permissionOf(name, server as never, (body.toolSettings ?? {}) as never, body.approvals === "never" ? "never" : "ask"));
  }
  async function needAgent(id: string): Promise<AgentEntry> {
    const entry = ID.test(id) ? await agents.get(id) : null;
    if (!entry) throw new ApiError("not_found", `no agent ${id}`);
    return entry;
  }
  /** An agent view's extra fields (agents-store agentView): its saved sign-ins, its learning count, and its run counts.
   *  The run counts read the store's runs (store-reads/runs.ts listRuns): `count` is every run the agent has, `live` those
   *  still running (runReadState 'running': queued, running or parked), the same numbers the file-backed view showed. */
  const agentExtra = async (entry: AgentEntry): Promise<{ signIns: object[]; learning?: { pending: number }; runs: { count: number; live: number } }> => {
    const learning = await learningOfAgent(entry);
    const runs = await listRunsOverStore(store, { agent: entry.agent.id }, ctx);
    return { signIns: await signIns.view(entry.agent.id), ...(learning ? { learning } : {}), runs: { count: runs.length, live: runs.filter((run) => run.state === "running").length } };
  };
  // A run's live moment from the store (store-view momentOf), for the one acceptance each act a run takes reads. The run
  // routes read from the store + the run view now, not a live Run.
  async function needRun(id: string): Promise<RunMoment> {
    const run = ID.test(id) ? await momentOverStore(store, id, viewDepsFor(ownOriginOf())) : undefined;
    if (!run) throw new ApiError("not_found", `no run ${id}`);
    return run;
  }
  /** A run's v2 status and state now (the run view), for the answer an act reports once it has written its command row. */
  const runStatusState = async (runId: string): Promise<{ status: Status; state: State }> => {
    const v = await viewOverStore(store, runId, viewDepsFor(ownOriginOf()));
    return { status: (v?.status as Status) ?? "queued", state: (v?.state as State) ?? "idle" };
  };
  /** The run read routes (timeline, files, graph, browser, live viewer) over the store are E2c's run-reads-over-store.ts
   *  (watchRun + run-workspace + store-view), not committed yet. TODO(E2c): replace each call with its function on that sha. */
  const runReadsTodo = (): never => { throw new ApiError("unsupported_here", "run reads over the store (timeline, files, graph, browser) are being wired (run-reads-over-store); not available on this build yet"); };

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
  const workflowShape = ({ workflow, tools, harness, place, toolSettings, approvals }: { workflow: unknown; tools?: readonly string[]; harness?: string; place?: RevisionShape["place"]; toolSettings?: RevisionShape["toolSettings"]; approvals?: "never" }): RevisionShape => ({ kind: "workflow", workflow, tools: tools ?? [], ...(harness ? { harness } : {}), ...(place ? { place } : {}), ...(toolSettings ? { toolSettings } : {}), ...(approvals === "never" ? { approvals } : {}) });
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
    // The store's NewRevision keeps the revision's fields under `body` (AgenticBody|WorkflowBody); build the flat shape the
    // host checks (runnable.ts RevisionShape) from it, as shapeOf does for a run's Revision.
    const body = revision.body as AgenticBody & Partial<WorkflowBody>;
    // An agent on a harness that installs on first use starts its install, if it is not in yet: its first run waits for less.
    const install = revision.kind === "agentic" ? installs[harnessOfBody(body)] : undefined;
    if (install) {
      void install.ensure().catch((error: Error) => log?.(logLine("harness_install_failed", { harness: install.entry.id, message: error.message })));
    }
    const named = (revision.kind === "agentic" ? { kind: "agentic" as const, ...(body as AgenticBody) } : workflowShape(body as never)) as unknown as RevisionShape;
    const shape = named.place ? named : { ...named, place: fallbackPlace(named.kind, named.tools ?? []), unnamed: true as const };
    const blockers = await blockersOf(env, shape, settings.get(), { boxes: boxOffers, offers, mcp: mcpTools });
    // An agent's default cap caps each run started without one of its own, and a web tool resolves by the cap: what a cap
    // alone keeps from running under the definition's own picks, whatever this host's settings, would keep every such run
    // from running, so the save is refused, not each run (claude-agent's or codex's own search, picked, under a cap).
    if ((body.maxCostUsd ?? 0) > 0) {
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
   *  before it are deleted and the agent is archived (an agent store keeps every agent), and the refusal is the answer, a 422's fields under `triggers.<i>`; a
   *  github trigger GitHub is not connected for is skipped instead, with a warning there, and one made is said there. A webhook
   *  trigger's secret is not in the answer (the Idempotency-Key record would keep it): POST /triggers/{id}/secret makes one. */
  async function applyTemplate(pkg: Package, body: Json) {
    const { parameters, grants, model: override, approvals } = applyBodyOf(pkg, body);
    const missing = pkg.secrets.filter((name) => !secret(name, storedKeys));
    const saved = pkg.mcp.filter((need) => mcpMeta.has(need.server));
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
    const picked = override ? { model: override } : await packageModel(env, pkg.model, harness ?? DEFAULT_HARNESS);
    const model = picked.model;
    // Which model the agent got, where it is not the package's: a note, never a lack. The agent runs; only the package's
    // choice was not an option here (not_set_up_here would read as a run refused until the host has something).
    const modelWarnings: InputIssue[] = "warning" in picked && picked.warning ? [{ field: "model", reason: "not_an_option", message: picked.warning }] : [];
    const defaultTools = "place" in newAgentPlace(boxOffers) ? NEW_AGENT_TOOLS : [];
    // A grant never lifts a deny the owner set on this server: that tool keeps it, and the answer says so.
    const server = settings.get() as Parameters<typeof permissionFrom>[1];
    const denied = grants.filter((tool) => { const set = permissionFrom(tool, server); return set.from === "server" && set.permission === "deny"; });
    const kept: InputIssue[] = denied.map((tool) => ({ field: `grants.${tool}`, reason: "not_allowed", message: `${tool} is denied on this server (Settings → Tools), so the agent was not allowed it: its runs are refused it until the owner changes that setting.` }));
    // The tools this server's own settings pin (or hold refused for a pin that does not read): a package's pin the agent
    // store can't keep yet is covered there, so its grant stands; any other such tool is made deny (compiled).
    // The agent's approvals: the apply's override, else the package's own (a template whose job runs on triggers says
    // never), else ask. Deny and pins hold either way.
    const chosenApprovals = approvals ?? pkg.approvals;
    const serverPinned = new Set(Object.entries(settings.get()).filter(([, one]) => one?.pin || one?.brokenPin).map(([name]) => name));
    const made = compiled(pkg, parameters, { ...(harness ? { harness } : {}), ...(model ? { model } : {}), mcp: saved, defaultTools, grants: grants.filter((tool) => !denied.includes(tool)), serverPinned, ...(chosenApprovals ? { approvals: chosenApprovals } : {}) }, templateDeps);
    // Every trigger is checked as POST /triggers checks it, its parameters filled, before anything is made: a schedule
    // from a parameter that does not read, or a date that has passed, refuses the apply (422 under triggers.<i>).
    const refusedTriggers = madeTriggerIssues(made.triggers, Date.now());
    if (refusedTriggers.length) throw invalid(refusedTriggers);
    // POST /agents' and POST /triggers' own body limit: parameters filled in more than once can grow a package past it.
    for (const one of [made.agent, ...made.triggers]) if (Buffer.byteLength(JSON.stringify(one)) > MAX_BODY) throw new ApiError("payload_too_large", `the ${pkg.name} template, its parameters filled in, makes a body over ${MAX_BODY} bytes`, { details: { limit: "max_body_bytes" } });
    const { entry, warnings } = await createAgentOf(made.agent);
    const ids: string[] = [];
    // Each webhook trigger's signing secret, minted as it is made: handed back in the apply's first answer alone, as POST
    // /triggers hands back its own, so the owner can give it to the sender.
    const secrets: { trigger_id: string; secret: string }[] = [];
    // A github trigger on a server GitHub is not connected to is skipped, never the apply: the agent stands, and the
    // answer says to connect GitHub and apply again (a warning under triggers.<i>).
    const unconnected = new Set<number>();
    try {
      for (const [i, trigger] of made.triggers.entries()) {
        try {
          const { id: madeId, secret } = await triggers.create({ ...trigger, target: { ...(trigger.target as Json), agent_id: entry.agent.id } });
          ids.push(madeId);
          if (secret) secrets.push({ trigger_id: madeId, secret });
        } catch (error) {
          if (error instanceof ApiError && error.code === "github_not_connected" && isObject(trigger.source) && trigger.source.kind === "github") {
            unconnected.add(i);
            continue;
          }
          if (error instanceof ApiError && error.code === "input_invalid" && error.extra.fields) throw told(new ApiError("input_invalid", error.message, { ...error.extra, fields: error.extra.fields.map((f) => ({ ...f, field: `triggers.${i}.${f.field}` })) }));
          throw error;
        }
      }
    } catch (error) {
      for (const id of ids.reverse()) {
        try {
          await triggers.remove(id);
        } catch (undo) {
          log?.(logLine("template_undo_failed", { template: pkg.name, trigger: id, message: (undo as Error).message }));
        }
      }
      // Archived through the trigger engine, as POST /agents/{id}/archive is: a trigger the undo could not remove is turned
      // off in that same store transaction with the reason agent_archived, never with none, and unarchive answers it.
      await triggers.agentArchived(entry.agent.id).catch((undo: Error) => log?.(logLine("template_undo_failed", { template: pkg.name, agent: entry.agent.id, message: undo.message })));
      throw error;
    }
    // A pinned send whose destination parameter was not given is denied, never let go anywhere: said, by its gate name.
    const unpinned: InputIssue[] = made.unpinned.map(({ tool, parameters: named }) => ({ field: `pins.${tool}`, reason: NOT_SET_UP, message: `${tool}'s arguments are fixed by ${named.map((one) => `the ${one} parameter`).join(" and ")}, which was not given, so the agent was made with ${tool} set to deny: it can't call it at all. Apply again with ${named.join(" and ")} set to let it.` }));
    // A pin this server's agent store does not keep yet (tool-plane.ts AGENT_LAYER_PINS): said, with the setting that holds
    // the send to its destination meanwhile, the server's.
    const unkept: InputIssue[] = made.unkept.map(({ tool, pin }) => ({ field: `pins.${tool}`, reason: NOT_SET_UP, message: serverPinned.has(tool) ? `${tool} is not pinned to ${pinWords(pin)} for this agent yet (this server's agent store keeps an agent's own pin from the store cutover on); this server's own pin of ${tool} holds its calls meanwhile.` : `${tool} is not pinned to ${pinWords(pin)} for this agent yet: this server's agent store keeps an agent's own pin from the store cutover on. Until then the agent was made with ${tool} set to deny, so nothing it reads can send it elsewhere. Pin it on this server, which holds every agent's calls of ${tool}, and apply again to let it.`, ...(serverPinned.has(tool) ? {} : { fix: `Add ${JSON.stringify({ [tool]: { pin } })} to this server's tool settings (Settings → Tools; PUT /v2/settings/tools replaces the whole map, so send it with the rest).` }) }));
    // A GitHub tool the package grants that Connect GitHub's App may not use (its manifest asks for less), where the github
    // MCP server runs on the App's tokens: said now, before a run's first call is refused (template-github-permissions.ts).
    const appShort = appPermissionWarnings({ name: pkg.name, mcp: saved }, (server) => mcpMeta.get(server)?.auth === "github_app");
    // A webhook trigger's secret is in no apply answer: each one's warning sends the person to the console for it.
    const hooks = made.triggers.flatMap((trigger, i) => (isObject(trigger.source) && trigger.source.kind === "webhook" ? [templateTriggerSecret(i)] : []));
    // Each github trigger: what it runs on, when made (a note, never a lack); skipped, what to do about it.
    const githubTriggers: InputIssue[] = made.triggers.flatMap((trigger, i) => (isObject(trigger.source) && trigger.source.kind === "github"
      ? [unconnected.has(i) ? { field: `triggers.${i}`, reason: NOT_SET_UP, message: GITHUB_TRIGGER_UNCONNECTED } : { field: `triggers.${i}`, reason: "not_an_option", message: githubTriggerWords(pkg.name, trigger.source) }]
      : []));
    // Each trigger it made, a webhook trigger's with its secret's metadata; the values go back beside the answer, never in it
    // (the route adds them to the first answer to the owner's session, after the Idempotency-Key's record is written).
    const minted = new Map(secrets.map(({ trigger_id, secret }) => [trigger_id, secret]));
    const applied = { template: pkg.name, version: pkg.version, agent_id: entry.agent.id, trigger_ids: ids, ...templateWebhookSecrets([...minted.keys()], new Date().toISOString()), warnings: [...skipped, ...kept, ...modelWarnings, ...unpinned, ...unkept, ...warnings, ...hooks, ...githubTriggers, ...appShort] };
    return { applied, minted };
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
    if (entry.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${agentId} is archived: unarchive it to run it.`, { details: { archived_at: new Date(entry.agent.archivedAt).toISOString() } });
    const body = await bodyOf(req);
    return idempotent(req, `/agents/${agentId}/runs`, body, async (origin) => {
      // A run the store started under this key, though no answer was kept (its server went down first): that run, as it is now.
      const first = origin && (await agents.request(() => agents.store.runOfOrigin(origin.key)));
      if (first) {
        if (first.existing?.fingerprint !== origin.fingerprint) throw mismatch();
        const headers: Record<string, string> = { location: `/v2/runs/${first.runId}`, "idempotent-replayed": "true" };
        return { status: 202, body: await viewOverStore(store, first.runId, viewDepsFor(linkOrigin(req))), headers };
      }
      const run = await startRunOf(entry, body, { ...(origin ? { origin } : {}) });
      // Its view from the store: the run and its launch were inserted in one transaction, so the view reads it whole.
      return { status: 202, body: await viewOverStore(store, run.id, viewDepsFor(linkOrigin(req))), headers: { location: `/v2/runs/${run.id}` } };
    });
  }

  /** A run of `entry`'s agent from a create's body, checked as POST /agents/{id}/runs checks it: that route's, and a
   *  trigger's firing's, which names itself as the run's `trigger`. Under `origin`, a key that already started a run
   *  gets that run (the agent store's run_origins). */
  /** `capped`: the run must have a cap (a trigger's), its own or else its agent's default. */
  /** `from`: who the run's first message is from when the person did not write it (a trigger's firing). */
  async function startRunOf(entry: AgentEntry, body: Json, options: StartOptions = {}): Promise<RunRow> {
    // Every check the old start made, in the same order and words, now lives in the run write half (runs-over-store.startRun,
    // over StartDeps): the body's fields, the revision it pins, the input against its schema, the cap rules, the plane this
    // host resolves, whether the revision can run here — then an INSERT of a queued run and its launch in one transaction,
    // which a runner reads at its claim. No process, no door, no setup file.
    return startRun(store, startDeps, entry, body, options);
  }

  /** The revision a run of `entry` starts on: the one `body.revision` pins, else the agent's current; undefined when the
   *  pin names none, or the agent has no revision. */
  async function pinnedOf(entry: AgentEntry, body: Json): Promise<{ revision: Revision; version: number } | undefined> {
    const found = typeof body.revision === "string" ? await agents.revision(entry.agent.id, body.revision) : entry.revision && { revision: entry.revision, version: entry.version };
    // A store RevisionRow is the same revision the run path reads as a pi Revision (its body is the revision body JSON); the
    // run write half (StartDeps) types it as Revision, so the row is handed across as one.
    return found ? { revision: found.revision as unknown as Revision, version: found.version } : undefined;
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
    const vd = viewDepsFor(origin);
    let rows = (await listRunsOverStore(store, filter, ctx)).filter((row) => Boolean(row.archivedAt) === archived);
    if (status !== null) {
      // The v2 status is the run view's (store-view over the journal), per row.
      const statuses = await Promise.all(rows.map((row) => viewOverStore(store, row.id, vd).then((v) => v?.status as Status | undefined)));
      rows = rows.filter((_, i) => statuses[i] === (status as Status));
    }
    // summaryOverStore reads each run's view (its version, status, cost and learning among them); no versions map is needed.
    const page = await Promise.all(rows.slice(offset, offset + limit).map((row) => summaryOverStore(store, row.id, vd)));
    return { runs: page, next_cursor: nextCursor(offset + limit, rows.length) };
  }

  async function timeline(req: IncomingMessage, res: ServerResponse, url: URL, runId: string): Promise<void> {
    const after = integerParam(url.searchParams.get("after"), "after", Number.MAX_SAFE_INTEGER);
    const waitMs = integerParam(url.searchParams.get("wait_ms"), "wait_ms", MAX_WAIT_MS);
    // This server's own: a page of at most `limit` rows, for a client that reads a little at a time (the MCP tool's).
    const asked = url.searchParams.get("limit");
    if (asked !== null && !(/^\d+$/.test(asked) && Number(asked) >= 1 && Number(asked) <= PAGE_ROWS)) throw new ApiError("bad_request", `limit is an integer from 1 to ${PAGE_ROWS}`);
    const limit = asked === null ? PAGE_ROWS : Number(asked);
    // The run's page from the store (runTimelines): run_id/status/state/reset/rows/drop/next_after/unchanged/has_more/final/
    // cost, byte-identical to the old live page. TODO(learning-row freshness): a learning row approved or retired since the
    // journal wrote it reads its journal state here (store-view owns the fresh learning view); folded in with learning-1.
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) {
      const page = await timelines.page(store, runId, after, waitMs, limit);
      return send(res, 200, { ...page, poll_after_ms: page.final || page.has_more ? 0 : 1000 });
    }
    const last = req.headers["last-event-id"];
    if (last !== undefined && !/^[0-9]+$/.test(String(last))) throw new ApiError("bad_request", "Last-Event-ID is a change number");
    let cursor = last !== undefined ? Number(last) : after;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-content-type-options": "nosniff" });
    const beat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    let open = true;
    res.once("close", () => void (open = false));
    // The live wake: watchRun (live/stream.ts) signals a new journal commit or the run's end, so the page is re-read at
    // once instead of only on a poll. A run with no watch (gone, or a store with no live) falls back to a 1s re-read; the
    // page it serves is byte-identical either way.
    const stream = await watchRun(store, runId).catch(() => undefined);
    let notify: (() => void) | undefined;
    stream?.start(() => notify?.());
    const nextChange = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => ((notify = undefined), resolve()), ms);
        t.unref?.();
        notify = () => (clearTimeout(t), (notify = undefined), resolve());
      });
    try {
      for (let first = true; open; first = false) {
        const page = await timelines.page(store, runId, cursor, 0, limit);
        if (!open) break;
        if (first || !page.unchanged || page.final) res.write(`event: rows\nid: ${page.next_after}\ndata: ${JSON.stringify(page)}\n\n`);
        cursor = page.next_after;
        if (page.final && !page.has_more) {
          res.write(`event: end\ndata: ${JSON.stringify({ reason: "terminal" })}\n\n`);
          break;
        }
        // Until the next commit, the run's end, or 15s (the keepalive cadence; a run with no watch re-reads every 1s).
        await Promise.race([nextChange(stream ? 15_000 : 1_000), ...(stream ? [stream.closed] : [])]);
      }
    } finally {
      clearInterval(beat);
      await stream?.stop().catch(() => {});
      res.end();
    }
  }

  // ---- files ----------------------------------------------------------------------------------------------------------

  // A run's Workspace (its files' list and reads) is the store-backed run reads' now (run-reads-over-store, E2c, over the
  // run's launch place with run-workspace.ts), not a local folder off the data directory. Removed with the file routes.

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

  // Each ended run's meters, over the one store (store-reads/cap metersOverStore, cap.ts meterFiguresFrom over A's journal):
  // kept, as a settled run's journal no longer changes, keyed by its end, so a run opened again and ended again is read
  // again. A run whose journal cannot be read leaves it all tokens.
  const endedMeters = new Map<string, Awaited<ReturnType<typeof metersOverStore>>>();
  // Each ended run's spend so far as it saved it at its end (serve.json's cost_so_far: every conversation's charges and
  // its decisions' receipts, which its root store alone does not hold), kept as its meters are; undefined when it saved
  // none (a run whose cost is known, or one ended before the figure was kept).
  const endedSoFar = new Map<string, number | undefined>();
  const savedSoFarOf = (row: { id: string; endedAt?: string | null }) => {
    const key = `${row.id} ${row.endedAt}`;
    if (!endedSoFar.has(key)) {
      // TODO(E3/store-reads): a run's kept so-far cost comes from the store (its row/journal), not a per-run RUN_META file
      // (runStorePath is gone). Undefined until the usage route reads it over the store.
      let usd: number | undefined;
      {
        usd = undefined;
      }
      endedSoFar.set(key, usd);
    }
    return endedSoFar.get(key);
  };
  const metersOf = async (row: { id: string; endedAt?: string | null }) => {
    const key = `${row.id} ${row.endedAt}`;
    let meters = endedMeters.get(key);
    if (!meters) {
      // An ended run's meter figures over the one store: cap.ts meterFiguresFrom over A's journal, its paid tools' charges
      // folded back from the paid-tools session (store-reads/journal withPaidCosts), as meterFiguresIn read a file-backed
      // run's own database — the same figures (the money-parity rule).
      meters = await metersOverStore(store, row.id, ctx);
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
      // A running run's cost is its booked-so-far spend (store-reads/runs listRuns reads it over the store with
      // spentOverStore); an ended run's is its stored cost. A null cost (a running run with none yet) counts unpriced.
      const usd = row.costUsd ?? null;
      const key = group === "agent" ? row.agent : group === "day" ? row.startedAt.slice(0, 10) : group === "meter" ? "tokens" : "local";
      // By meter, what a run's paid tools charged (monid's) is `tools`, its browser session time `browser_time`, the rest
      // `tokens`, all from the same records: a live run's rows (a call still marked is no charge), else its store as it
      // ended (a call a crash cut makes `tools` unknown, never `tokens`). An unknown meter counts the run as unpriced on it.
      // An ended run's are its store's figures (metersOf keeps them, never its timeline), read for its lines by meter and,
      // by any group, for what a run of unknown cost is known to have spent. Read once per run (the store read is async): by
      // meter (its lines and its not-metered calls), and for any group of a run of unknown cost (its known so-far).
      const all = group === "meter" || usd === null ? await metersOf(row) : undefined;
      const read = (group === "meter" && usd !== 0) || usd === null ? all : undefined;
      // A run whose cost is unknown still spent what is known of it (so_far: each meter's known dollars): that is in the
      // total and its lines, and the run is counted unpriced, so a total is never below a line of its own and reads as
      // the lower bound unpriced_runs says it is.
      const soFar = usd !== null || !read ? 0 : (savedSoFarOf(row) ?? read.known.tokens + read.known.browser + read.known.others);
      const meters = group === "meter" && usd !== 0 ? read : undefined;
      if (meters && meters.browser.usd !== 0) browserSeconds = browserSeconds === null || meters.browser.seconds === null ? null : browserSeconds + meters.browser.seconds;
      // Its parts of the lines (usage-lines.ts): an unknown one counts the run unpriced there and adds what is known of it.
      // An unpriced MCP call is in none of them: counted apart as not metered on the tools line, which a $0 run shows only
      // when it made one.
      const unmetered = group !== "meter" ? 0 : (all?.notMetered ?? 0);
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

  /** POST /v2/setup, POST /v2/auth/sign-in, POST /v2/auth/sign-out, POST /v2/auth/sign-out-everywhere and GET
   *  /v2/auth/session, answered before any credential: their own checks are the setup code (or the token), the password,
   *  and the session. */
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
        // The server's API token stands in for the code in the code field too (on Render it is in the Environment tab, the
        // code only in the log), compared as the header is, in constant time; a wrong one counts as a wrong code.
        const tokenAsCode = typeof body.code === "string" && body.code !== "" && timingSafeEqual(digest(`Bearer ${body.code}`), expected);
        const made = await me.setFirst(password, body.code, byToken || tokenAsCode, along);
        if (made === "exists") throw new ApiError("forbidden", "this server has its owner, or is being set up: sign in");
        if (made === "missing") throw new ApiError("forbidden", "this server's setup takes the setup code in its log: send it as code");
        if (made === "wrong") throw new ApiError("forbidden", "that is not the setup code in the server's log");
        if (made === "new") throw new ApiError("forbidden", "that setup code expired, or five wrong tries voided it: a new one is in the server's log");
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
      // This browser: its session revoked on the server (a copy of its cookie is no session either) and its cookie
      // cleared; every other browser's session left as it is. A viewer watching with it is cut off.
      case "/auth/sign-out": {
        fromPage(req);
        if (!signedIn(req, me)) throw new ApiError("unauthenticated", "this browser is not signed in");
        for (const value of heldSessions(req)) if (me.valid(value)) me.revoke(value);
        viewers.recheck();
        return send(res, 200, { signed_out: true }, { "set-cookie": ownerCookie(req, "", 0) });
      }
      // Every browser and phone: the sessions' epoch moves on, so every cookie made before is none, this one's too.
      case "/auth/sign-out-everywhere": {
        fromPage(req);
        if (!signedIn(req, me)) throw new ApiError("unauthenticated", "this browser is not signed in");
        me.signOutEverywhere();
        viewers.recheck();
        return send(res, 200, { signed_out: true }, { "set-cookie": ownerCookie(req, "", 0) });
      }
      case "/auth/session": {
        // Before the owner's password is set: whether setup takes the printed code (a server at a public address), so
        // the page asks for it when opened with no link. Never the code itself.
        const set = me.hasPassword();
        // secrets_writable: whether this browser may save a secret (secret-writes.ts mayWriteSecrets, the dispatch check's
        // own rule), so the console offers a paste only where it would be taken. Answered before the page marks the
        // request, so its facts are read here: accounts are on, and its session is its password's.
        const writable = secretsWritableFields({ accounts: true, passwordSession: signedIn(req, me), consoleSession: false, token: req.headers.authorization !== undefined && !signedIn(req, me), loopbackBound: isLoopback(host) });
        return send(res, 200, { accounts: true, password_set: set, signed_in: signedIn(req, me), ...writable, ...(set ? {} : { setup_code: !me.openSetup }) });
      }
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
    if (found.name === "getCapabilities") {
      // features.computers: the computer kinds this server offers now (computers.ts), read at each answer, since turning
      // Archil on or off, or saving a key, changes them.
      const answer = forCaller(caps, byOwnerSession(req));
      return send(res, 200, { ...answer, features: { ...answer.features, computers: await computerCapabilities(computersOf()) } });
    }
    if (found.name === "getOpenapi") return send(res, 200, servedOpenapi(openapi, req.socket.localPort));
    // With accounts off there is no owner, and the console still asks whether it may save a secret: secret-writes.ts'
    // verdict over the request the page just marked, never a signed-in user it doesn't have.
    if (found.name === "getAuthSession") return send(res, 200, { accounts: false, ...secretsWritableFields(secretWriterFacts(req, { accounts: false, loopbackBound: isLoopback(host) })) });
    // The one route with no token: a pushed trigger source's request, checked by its source before anything else is
    // read (push-handler.ts).
    if (found.name === "receiveHook" || found.name.startsWith("receiveHook_")) {
      // A body cut at its cap or its time is answered, then its socket closed: never read to its end.
      const answer = await receivePush({ adapters, hooked: (id) => triggers.hookSource(id), ...(options.hookBodyMs !== undefined ? { bodyMs: options.hookBodyMs } : {}), ignored: (id, eventId) => triggers.ignored(id, eventId), listening: (kind) => triggers.listening(kind), notice: async (adapterId, event, body) => (adapterId === "github" && event === "installation" ? githubConnect.installationEvent(body, (detail) => triggers.turnOff("github", detail)) : undefined), receive: (id, event) => triggers.receiveEvent(id, event), scoped: (kind, scope) => triggers.scoped(kind, scope), setting: (adapterId, scope, field) => triggerSettings.get(adapterId)?.get(scope, field), refused: authFailed, say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)) }, req, /^\/hooks\/([^/]+)$/.exec(path)![1]!);
      return send(res, answer.status, answer.body, answer.headers ?? {});
    }
    // An MCP server's OAuth sign-in: the browser coming back from its authorization server carries no token (the state
    // it brings is the check, mcp-oauth.ts), and the client metadata document is for that server to fetch.
    if (found.name === "mcpOAuthCallback") {
      // Its state's start set a cookie in the browser that started it: no other browser finishes that sign-in.
      const state = url.searchParams.get("state");
      if (!startedHere(req.headers.cookie, req.socket.localPort, state)) throw new ApiError("forbidden", "This sign-in was started in another browser, or its 10 minutes are over: start it again in Settings → MCP servers, in this browser.");
      const location = await mcpServers.oauthCallback(url.searchParams, stopping.signal);
      // A sign-in that finished kept the server's tools again: the grant-check snapshot reads them.
      await refreshMcpMeta();
      // Its sign-in is over: its cookie goes.
      return void res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": signInCookie(req.socket.localPort, state!, overHttps(req), 0) }).end();
    }
    if (found.name === "mcpOAuthClient") return send(res, 200, mcpServers.clientDocument(), { "cache-control": "public, max-age=3600" });
    // Connect GitHub's two steps back from GitHub: the owner's browser, which carries no token. The callback's state is
    // its check, with the cookie its start set in that browser; an installation is kept only as GitHub, asked with the
    // App's own JWT, says it is the App's.
    // Both answer the browser with where to go, never an error body: on to install the App, or to the console's GitHub
    // settings, connected or with why not.
    if (found.name === "gitHubCallback") {
      const state = url.searchParams.get("state") ?? "";
      // Another browser's (no cookie for this state) leaves the state as it is, for the browser that started it.
      if (!state || !gitHubStartedHere(req.headers.cookie, req.socket.localPort, state)) return void res.writeHead(302, { location: githubConnect.failed("state_invalid", "the browser brought no cookie for this state"), "cache-control": "no-store" }).end();
      const { location, installState } = await githubConnect.callback(url.searchParams.get("code"), state, stopping.signal);
      // Its state's cookie goes; the install state's is set, for the installed redirect GitHub sends this browser to.
      const cookies = [stateCookie(req.socket.localPort, state, overHttps(req), 0), ...(installState ? [stateCookie(req.socket.localPort, installState, overHttps(req), undefined, INSTALLED_PATH)] : [])];
      return void res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": cookies }).end();
    }
    if (found.name === "gitHubInstalled") {
      // Bound only by the install state the callback sent GitHub and the cookie it set in this browser.
      const state = url.searchParams.get("state");
      const bound = state && gitHubStartedHere(req.headers.cookie, req.socket.localPort, state) ? state : null;
      const location = await githubConnect.installed(url.searchParams.get("installation_id"), bound, stopping.signal);
      return void res.writeHead(302, { location, "cache-control": "no-store", ...(bound ? { "set-cookie": stateCookie(req.socket.localPort, bound, overHttps(req), 0, INSTALLED_PATH) } : {}) }).end();
    }
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
    // A run's live computer view is a full-control credential for its computer: the owner's signed-in page alone, as
    // approving a note is (never a token a run, an MCP client or a script may hold).
    if ((found.name === "getRunBrowser" || found.name === "handBackRunBrowser" || found.name === "getRunComputer") && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      const what = found.name.endsWith("Browser") ? "browser" : "computer";
      authFailed(`/v2${path}`, `${what}_without_session`);
      throw new ApiError("forbidden", owner ? `A run's live ${what} takes the owner's password sign-in in the console, never a token.` : `A run's live ${what} takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).`);
    }
    // A run's desktop or phone view drives it once taken over: the owner's signed-in page alone (computer-routes.ts decides).
    if (COMPUTER_ROUTES.has(found.name) && !byOwnerSession(req) && req.headers.authorization !== undefined) authFailed(`/v2${path}`, "computer_without_session");
    // Answering a tool call that waits for approval (tool-gate.ts) is the same: the owner's signed-in page alone, never a
    // token, which the run's own process, an agent's MCP client or a script may hold.
    if (found.name === "answerApproval" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "approve_without_session");
      throw new ApiError("forbidden", owner ? "Answering a tool call's approval takes the owner's password sign-in in the console, never a token." : "Answering a tool call's approval takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    // Saving, replacing or removing a secret (secret-writes.ts): the one check. Who may is mayWriteSecrets' alone (the
    // owner's session); which writes are secret is each plane's registered predicate, read from the body, so a token's
    // non-secret edit on the same route still goes through. A body that does not read counts as the plane says of none.
    if (isSecretWriteOperation(found.name) && req.headers.authorization !== undefined && !writesSecretsAllowed(req, { accounts: owner !== undefined, loopbackBound: isLoopback(host) })) {
      const body = req.method === "DELETE" || req.method === "GET" ? undefined : await bodyOf(req).catch(() => undefined);
      if (writesSecret(found.name, body)) {
        authFailed(`/v2${path}`, "secret_without_session");
        throw new ApiError("forbidden", SECRET_WRITE_REFUSAL);
      }
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
          return { status: 201, body: { ...agentView(entry, linkOrigin(req), await agentExtra(entry)), warnings }, headers: { location: `/v2/agents/${entry.agent.id}`, etag: etagOf(entry) } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listAgents": {
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const archived = archivedParam(url);
        const all = await agents.list({ archived });
        return send(res, 200, { agents: await Promise.all(all.slice(offset, offset + limit).map(async (entry) => agentView(entry, linkOrigin(req), await agentExtra(entry)))), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getAgent": {
        const entry = await needAgent(id);
        // The tools its current revision grants, as capabilities list them, each with its provider for this agent.
        const tools = entry.revision ? agentTools(env, settings.get(), await toolingOf(entry.revision as unknown as Revision), caps.tools.map((tool) => tool.name)) : [];
        return send(res, 200, { ...agentView(entry, linkOrigin(req), await agentExtra(entry)), tools }, { etag: etagOf(entry) });
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
        return send(res, 200, { ...agentView(edited, linkOrigin(req), await agentExtra(edited)), warnings }, { etag: etagOf(edited) });
      }
      case "listRevisions": {
        const entry = await needAgent(id);
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const all = await agents.revisions(id);
        // agentRevisions already carries each row's version and current flag; revisionView builds the v2 shape from it.
        const page = all.slice(offset, offset + limit).map((row) => revisionView(entry.agent, row));
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
        return send(res, 200, agentView(moved, linkOrigin(req), await agentExtra(moved)), { etag: etagOf(moved) });
      }
      case "archiveAgent":
      case "unarchiveAgent": {
        await needAgent(id);
        // No run sweep on archive: a runner reads an archived agent's run rows directly, nothing to sweep.
        // The engine archives (or unarchives) the agent itself: archived, every trigger that runs as it turns off with
        // agent_archived in that same store transaction; unarchived, none turns on. Never archived first by another path,
        // which would turn its triggers off with no reason and leave the answer empty. Both answer the triggers off for
        // the archive, each turned on again by PATCH /triggers/{id} {enabled: true}.
        const triggersOff = found.name === "archiveAgent" ? await triggers.agentArchived(id) : await triggers.agentUnarchived(id);
        const entry = await needAgent(id);
        return send(res, 200, { ...agentView(entry, linkOrigin(req), await agentExtra(entry)), triggers_off: triggersOff }, { etag: etagOf(entry) });
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
      case "getRun": {
        const view = await viewOverStore(store, id, viewDepsFor(linkOrigin(req)));
        if (!view) throw new ApiError("not_found", `no run ${id}`);
        return send(res, 200, { ...view, ...(await runComputerOf(id, view)) });
      }
      case "getTimeline":
        await needRun(id);
        // Awaited, not dropped: a throw from the timeline (a run gone mid-stream, a bad page) reaches the router's catch,
        // which answers; a floated rejection would hang the request with no answer.
        return await timeline(req, res, url, id);
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
          const { mode, messageId } = await message(store, run, content);
          // The run's state after the command row is written (the run view): the runner applies the steer; the client polls.
          const { status, state } = await runStatusState(run.id);
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
        const now = run.maxCostUsd;
        if (now === undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "This run has no cap to raise: a cap is named when a run starts." }]);
        const { resumed, messageId, note } = await raiseCap(store, run, cap);
        const { status, state } = await runStatusState(run.id);
        return send(res, 200, { run_id: run.id, max_cost_usd: cap, resumed, ...(messageId ? { message_id: messageId } : {}), ...(note ? { note } : {}), status, state });
      }
      case "stopRun": {
        const run = await needRun(id);
        const stopped = await stopRunOverStore(store, run.id);
        const { status, state } = await runStatusState(run.id);
        return send(res, 200, { run_id: run.id, stopped, status, state });
      }
      case "cancelRun": {
        const run = await needRun(id);
        const requested = await cancel(store, run);
        return send(res, 202, { run_id: run.id, cancel_requested: requested, already_terminal: !requested, status: (await runStatusState(run.id)).status });
      }
      case "answerApproval": {
        // The owner's answer to a tool call that waits for approval (tool-gate.ts): the first answer wins.
        const run = await needRun(id);
        const body = await bodyOf(req);
        const issues: InputIssue[] = Object.keys(body).filter((k) => k !== "decision" && k !== "note").map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` }));
        if (body.decision !== "allow" && body.decision !== "deny") issues.push({ field: "decision", reason: body.decision === undefined ? "missing" : "not_an_option", message: "decision is allow or deny" });
        if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) issues.push({ field: "note", reason: "wrong_type", message: "note is a string of at most 2000 characters" });
        if (issues.length) throw invalid(issues);
        await approve(store, run, decodeURIComponent(second!), body.decision as "allow" | "deny", typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined);
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "archiveRun":
      case "unarchiveRun": {
        const run = await needRun(id);
        await archiveRun(store, run.id, found.name === "archiveRun");
        return send(res, 200, await viewOverStore(store, run.id, viewDepsFor(linkOrigin(req))));
      }
      case "getRunBrowser":
      case "getRunComputer": {
        // One read for both families, over the one store: the computer family's answer, and the browser's own in its base
        // shape (its link under /browser/live, no kind or hold, off's why as `reason`).
        const run = await needRun(id);
        const family: LiveFamily = found.name === "getRunBrowser" ? "browser" : "computer";
        // The run's open viewer, from the store's sealed viewer rows the runner publishes its hand-over into (browser-live.ts
        // liveViewerLink/computerViewerLink, under the seal key); who drives, from the cut's computerHoldOf over the store.
        const hold = await computerHoldOf(store, run.id);
        const kept = await keptBrowserOf(store, run.id);
        const view = await computerView({
          viewer: async () => {
            if (sealKey === undefined) return undefined;
            if (family === "browser") {
              const link = await liveViewerLink(store, sealKey, run.id);
              return link === undefined ? undefined : { kind: "browser" as const, viewer: link.viewer };
            }
            return computerViewerLink(store, sealKey, run.id);
          },
          computer: () => computerOf(kept, env, family),
          hold: () => hold,
        });
        if (family === "browser") return send(res, 200, view.state === "live" ? { state: "live", viewer: view.viewer } : view.state === "none" ? { state: "none" } : { state: "off", reason: view.why }, { "cache-control": "no-store" });
        return send(res, 200, view, { "cache-control": "no-store" });
      }
      case "handBackRunBrowser": {
        // The owner's answer to the agent's ask for them in its browser (browser-commands.ts): the first answer wins, the same
        // one again is that answer, a different one is 409; an ask past its expiry has `expired`. A hand-over command row the
        // runner reads and applies.
        const run = await needRun(id);
        const body = await bodyOf(req);
        const issues = unknownFields(body, ["outcome"]);
        if (body.outcome !== "done" && body.outcome !== "cancelled") issues.push({ field: "outcome", reason: body.outcome === undefined ? "missing" : "not_an_option", message: "outcome is done or cancelled" });
        if (issues.length) throw invalid(issues);
        // The ask this answer targets, read over the run's hand-over entries and the hand-back commands before this write;
        // browserHandBack writes the answer (its not_found and handoff_answered words, with details.outcome, as the console
        // and tests read them), then lets the lowest-id command win, re-reading the journal for a live view's own give.
        const entries = (await runEntries(store, run.id, ctx)) as unknown as Parameters<typeof handBackTarget>[0];
        const target = handBackTarget(entries, await store.commands(run.id, 0));
        const answered = await browserHandBack(store, run.id, body.outcome as "done" | "cancelled", target, Date.now(), async () => (await runEntries(store, run.id, ctx)) as unknown as Parameters<typeof handBackTarget>[0]);
        return send(res, 200, { outcome: answered.outcome }, { "cache-control": "no-store" });
      }
      case "takeOverRunComputer":
      case "handBackRunComputer": {
        // The owner's take-over of a run's desktop or phone, and the hand-back for every kind (computer-routes.ts), over the
        // store: the hold is the run's journal, a take-over and a hand-back are command rows its runner applies; a browser's
        // hand-back is the browser's own answer row, as POST .../browser/hand-back writes it.
        const run = await needRun(id);
        const answer = await computerRoute(found.name, run.id, {
          ownerSession: byOwnerSession(req), token: req.headers.authorization !== undefined, accounts: owner !== undefined, body: await bodyOf(req),
        }, store, { context: ctx });
        return send(res, 200, answer, { "cache-control": "no-store" });
      }
      case "listComputers":
      case "saveComputerKeys":
      case "testComputer": {
        // Settings → Computers (computers.ts): the rules are the handler's; this sends its answer.
        const provider = found.name === "listComputers" ? undefined : id;
        const body = found.name === "saveComputerKeys" ? await bodyOf(req) : undefined;
        const controller = new AbortController();
        req.once("close", () => controller.abort());
        return send(res, 200, await settingsComputerRoute(computersOf(), found.name, { ...(provider !== undefined ? { provider } : {}), ...(body !== undefined ? { body } : {}), signal: controller.signal }), { "cache-control": "no-store" });
      }
      case "getWorkspaceArchil":
      case "putWorkspaceArchil":
      case "deleteWorkspaceArchil":
      case "testWorkspaceArchil": {
        // The owner's Archil settings, Mode 2 on and off (archil-routes.ts): the rules are the handler's.
        const body = found.name === "putWorkspaceArchil" ? await bodyOf(req) : undefined;
        const controller = new AbortController();
        req.once("close", () => controller.abort());
        return send(res, 200, await archilRoute(archil, found.name, { ...(body !== undefined ? { body } : {}), signal: controller.signal }), { "cache-control": "no-store" });
      }
      case "listRunFiles": {
        await needRun(id);
        // A run's files through the server's read-only Workspace of its folder (serverRunWorkspace); a run with no folder
        // lists none, a withheld run refuses (403), as the base did (filesShown). Same shape and cap the file route answered.
        return send(res, 200, await listRunFilesOverStore(store, id, runReadsDeps));
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
        await needRun(id);
        // The workflow run's graph from its journal over the store (run-reads-over-store): an agentic run has none (404),
        // a run whose output is withheld is refused (403), as the route refused it.
        return send(res, 200, await runGraphView(store, id, runReadsDeps));
      case "pauseRun":
      case "resumeRun": {
        // A workflow run's pause or resume is a command its runner reads and applies (runs-over-store.pauseOrResume): an
        // agentic run has none (501, its turn is stopped instead), an ended or cancelling one takes none (409). The route
        // adds the run's status from its view.
        const run = await needRun(id);
        const { paused } = await (found.name === "pauseRun" ? pauseRunOverStore : resumeRunOverStore)(store, run);
        const { status } = await runStatusState(run.id);
        return send(res, 200, { run_id: run.id, paused, status });
      }
      case "readRunFile": {
        await needRun(id);
        // One of a run's files through the server's read-only Workspace, streamed as the file route streams it; a withheld
        // run refuses (403, as filesShown did), the path check and 404 words are the reader's own.
        return readRunFileOverStore(store, id, second!, req, res, url, runReadsDeps);
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
        // The store's counts and cost sums (store-reads/stats), the runs' metrics summed (store-reads/analytics), and the
        // runs over the store for the learning counts. No in-process pending set and no held Runs: the runner writes a
        // run's end to the store before it lets it go.
        const [s, a] = await Promise.all([statsOverStore(store), analyticsOverStore(store, { ...filter })]);
        // Each running row's status over the store (viewOverStore), for the active/needs_input/unknown buckets.
        const vd = viewDepsFor(ownOriginOf());
        const runningStatus = new Map<string, Status>();
        await Promise.all(s.running.map(async (id) => { const v = await viewOverStore(store, id, vd); if (v?.status) runningStatus.set(id, v.status as Status); }));
        // How the runs that tried to learn fared, over the store (learning-1's learningCountsOverStore): the same figures the
        // ledger gave, run for run; no held run's learning from memory.
        const learning = await learningCountsOverStore(store, filter);
        return send(res, 200, { ...statsView(s, (id) => runningStatus.get(id)), analytics: analyticsView(a, filter), learning });
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
        await toolKeys.save(id, body, check);
        await keysChanged();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      }
      case "deleteToolKey":
        await toolKeys.remove(id);
        await keysChanged();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      // Never through `idempotent`: its record keeps the body, and a body may hold a credential.
      case "listMcpServers":
        return send(res, 200, await mcpServers.list());
      case "getMcpServer":
        return send(res, 200, await mcpServers.get(id));
      case "previewMcpServer":
        return send(res, 200, await mcpServers.preview(await bodyOf(req), stopping.signal));
      case "saveMcpServer": {
        const saved = await mcpServers.save(id, await bodyOf(req), stopping.signal);
        await refreshMcpMeta();
        return send(res, 200, saved);
      }
      case "refreshMcpServer": {
        const refreshed = await mcpServers.refresh(id, stopping.signal);
        await refreshMcpMeta();
        return send(res, 200, refreshed);
      }
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
      case "connectGitHub": {
        const started = githubConnect.start(await bodyOf(req), ownOrigin(req));
        // The callback finishes only in this browser: the cookie it brings back names this state.
        return send(res, 200, started, { "set-cookie": stateCookie(req.socket.localPort, started.state, overHttps(req)) });
      }
      case "getGitHubConnection": {
        // Repaired from GitHub's own first, at most once a minute: a missed installation event is put right here.
        await githubConnect.reconcile((detail) => triggers.turnOff("github", detail));
        // Always a 200: not connected is an answer, never an error a browser logs as one.
        const view = githubConnection();
        return send(res, 200, view ? { connected: true, ...view } : { connected: false });
      }
      case "disconnectGitHub": {
        const view = githubConnection();
        if (!view) throw new ApiError("not_found", "No GitHub App is connected to this server.");
        const settingsUrl = github.settingsUrl();
        // Awaited: the App's rows go before the answer, so a Connect right after never races their removal.
        await github.remove();
        // Kept, and off: an agent keeps its triggers, which go on again once GitHub is connected again.
        const off = await triggers.turnOff("github", "GitHub was disconnected from this server: connect it again in Settings, then turn the trigger on.");
        log?.(logLine("github", { condition: "github_disconnected", app_id: view.app_id, triggers_off: off }));
        return send(res, 200, { disconnected: true, triggers_off: off, note: `Delete the App itself on GitHub: ${settingsUrl}` });
      }
      case "getMcpPrivateHosts":
        return send(res, 200, await privateHostsRoute(mcpServers, { method: "GET" }), { "cache-control": "no-store" });
      case "putMcpPrivateHosts":
        return send(res, 200, await privateHostsRoute(mcpServers, { method: "PUT", body: () => bodyOf(req) }), { "cache-control": "no-store" });
      case "deleteMcpServer":
        await mcpServers.remove(id);
        await refreshMcpMeta();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "getToolSettings":
        return send(res, 200, withDefaults(settings.get()));
      case "putToolSettings": {
        // Replaces the settings: a capability the body leaves out takes its default. Runs launched from now on resolve
        // on them, and capabilities say so at once.
        const body = await bodyOf(req);
        const issues = settingsIssues(body);
        if (issues.length) throw invalid(issues);
        await settings.put(body as ToolSettingsMap);
        // A setting changes what the web tools resolve to, never env or what a harness offers: capabilities again.
        recompose();
        return send(res, 200, withDefaults(settings.get()));
      }
      // A person's view and control of what an agent learned (learning-routes.ts). Every text cut of the host's secrets as
      // they are now; a write as the definition's: an archived agent's too.
      case "getAgentLearning": {
        await needAgent(id);
        // The agent's learning view: its notes, skills, workflows and log from its learning folder; its run-fared counts, each
        // note's runs (given it and that read it) and its impact over the one store (agentLearningOverStore), from each run's
        // launch, journal and learning end.
        const { counts, impact, notes } = await agentLearningOverStore(store, id);
        return send(res, 200, await agentLearning(data, id, secretsShown(serverSecrets()), counts, impact, notes));
      }
      case "listLearningNotes":
      case "listLearningLog":
        await needAgent(id);
        if (found.name === "listLearningNotes") {
          // The notes from the agent's learning folder, each with its runs over the one store (agentLearningOverStore's noteRuns).
          const { notes } = await agentLearningOverStore(store, id);
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
      case "getRunLearning": {
        const run = await needRun(id);
        // The run's learning view over the store (learning-1's runLearningOverStore): its end, the notes it was given and its seed
        // from its launch, what it holds for the owner's OK as the store's run view reads it (no folder), byte-identical to main.
        // Cut by the run's one cut, and refused for a withheld run (run-learning-served.ts).
        return send(res, 200, await servedRunLearning({ serverSecrets, signIns }, store, run.id));
      }
      case "getRunLearningDiff":
        await needRun(id);
        // TODO(learning-1): the run's learning diff over the store — learning-1's diff read on untangle/cutover-switch-learn, not the run's
        // .learning/diffs files. Wire when its head lands.
        return runReadsTodo();
      case "getWebhook":
        return send(res, 200, webhooks.view());
      case "saveWebhook": {
        // Never through `idempotent`: its record would keep the answer, and the first one holds the secret.
        // Its minted secret to the owner's session alone (trigger-secrets-shown.ts); the token gets its metadata and the words.
        const saved = webhooks.save(await bodyOf(req));
        return send(res, saved.created ? 201 : 200, webhookSaved(saved.view, saved.secret, mayHoldSecrets(req)));
      }
      case "deleteWebhook":
        webhooks.remove();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "getSourceSettings": {
        const adapter = serverSettingsOf(adapters, id);
        return send(res, 200, sourceSettingsView(adapter, triggerSettings.get(adapter.id)));
      }
      // Never through `idempotent`: its record keeps the body, and this body is the secrets.
      case "putSourceSettings": {
        const adapter = serverSettingsOf(adapters, id);
        return send(res, 200, await saveSourceSettings(adapter, triggerSettings.get(adapter.id), await bodyOf(req), options.sourceApis?.[adapter.id]));
      }
      case "deleteSourceSettings": {
        const adapter = serverSettingsOf(adapters, id);
        await removeSourceSettings(adapter, triggerSettings.get(adapter.id));
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      }
      case "testWebhook":
        return send(res, 200, await webhooks.test());
      case "listWebhookDeliveries":
        return send(res, 200, webhooks.attemptsView());
      case "redeliverWebhook":
        return send(res, 200, await webhooks.redeliver(id));
      case "listTriggers":
        return send(res, 200, { triggers: (await triggers.list()).triggers.map(withSecretOf) });
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
        // Its minted secret to the owner's session alone (trigger-secrets-shown.ts); the token gets secret_set and the words.
        return send(res, answer.status, secret && !replayed ? triggerMade(first, secret, mayHoldSecrets(req), new Date().toISOString()) : answer.body, answer.headers);
      }
      case "listTemplates":
        return send(res, 200, { templates: templates.map(packageView) });
      case "applyTemplate": {
        const pkg = templates.find((t) => t.name === id);
        if (!pkg) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
        const body = await bodyOf(req);
        // The Idempotency-Key's record keeps the agent and triggers, so a retry under the key gets the same apply; it never
        // keeps a webhook trigger's secret (below).
        let minted = new Map<string, string>();
        const answer = await idempotent(req, `/templates/${pkg.name}/apply`, body, async () => {
          const made = await applyTemplate(pkg, body);
          minted = made.minted;
          return { status: 201, body: made.applied, headers: { location: `/v2/agents/${made.applied.agent_id}` } };
        });
        // Each webhook trigger's secret, to the owner's session in this first answer alone (trigger-secrets-shown.ts
        // templateApplied): the record above never held it, so a replay under the key shows none.
        const replayed = answer.headers?.["idempotent-replayed"] === "true";
        const shown = replayed ? "replay" : mayHoldSecrets(req) ? "first" : "token";
        return send(res, answer.status, answer.status === 201 ? templateApplied(answer.body as Json, minted, shown) : answer.body, answer.headers);
      }
      case "rotateTriggerSecret":
        // A secret write: the dispatch's one check let only the owner's session this far (trigger-secrets-shown.ts).
        return send(res, 200, triggerRotated(id, (await triggers.rotate(id)).secret!, new Date().toISOString()));
      case "getTrigger":
        return send(res, 200, withSecretOf(await triggers.get(id)));
      case "updateTrigger":
        return send(res, 200, await triggers.update(id, await bodyOf(req)));
      case "deleteTrigger":
        await triggers.remove(id);
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "fireTrigger": {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new ApiError("bad_request", "Running a trigger now takes an Idempotency-Key of 1 to 255 characters: a retry with the same key fires it once.");
        const fired = await triggers.fire(id, key);
        return send(res, fired.created ? 202 : 200, fired.firing, fired.created ? {} : { "idempotent-replayed": "true" });
      }
      case "listTriggerFirings":
        return send(res, 200, await triggers.firings(id));
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

  /** A run's live viewer's page and files (browser-live.ts, /v2/runs/{id}/computer/live/*): the owner's signed-in page
   *  alone, GET or HEAD, for a viewer the run's live process has handed over. The bytes are this server's own copy of pi-browser's viewer, never the run's port's:
   *  only the viewer's WebSocket reaches the run. */
  async function liveRoute(req: IncomingMessage, res: ServerResponse, runId: string, family: LiveFamily, rest: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError("method_not_allowed", `${req.method} is not a method of a run's live view`, {}, { allow: "GET, HEAD" });
    if (!byOwnerSession(req)) {
      authFailed(`/v2/runs/${runId}/${family}/live`, req.headers.authorization === undefined ? "no_credential" : `${family}_without_session`);
      throw req.headers.authorization === undefined ? new ApiError("unauthenticated", `a run's live ${family} view takes the owner's password sign-in in the console`) : new ApiError("forbidden", `a run's live ${family} view takes the owner's password sign-in in the console, never a token`);
    }
    await needRun(runId);
    // The run's live viewer from the store (the runner's browser/computer tool wrote it under its claim; liveViewerFor picks
    // a named viewer's handover or the run's open one). None for a run no runner holds; with no seal key this server serves
    // no live view. A /computer/live path reaches a viewer of every kind (the link GET /computer gives, a browser's among
    // them), a /browser/live path a browser's alone (familyReaches).
    const handover = sealKey ? await liveViewerFor(store, sealKey, runId, rest) : undefined;
    if (handover === undefined || !familyReaches(family, handover)) throw new ApiError("not_found", `this run's ${family} has no live view at that address`);
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
    if (answerPage(req, res, raw, { token, dir: data, authFailed, console: options.console, takesBytes, ...(owner ? { owner } : {}), ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}) })) return;
    // Under --faux only: a faux desktop's live view, a page on this server's own address (faux-computers.ts viewPage), so
    // a run's take-over has a viewer to open in the console's real-browser flows. Gone after the computer's release.
    if (options.faux && raw.startsWith(`${FAUX_VIEW_PATH}/`)) {
      const page = fauxOf().viewPage(raw);
      if (page === undefined) return fail(new ApiError("not_found", `no faux desktop at ${raw}`));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : page);
      return;
    }
    if (!raw.startsWith("/v2/")) return fail(new ApiError("not_found", `no route ${raw}; the API is under /v2`));
    // A run's id needs no decoding: one that is not an id as sent (a stray or malformed escape) is no run's, and is never
    // decoded here, where a throw would leave the request listener.
    const viewing = LIVE_PATH.exec(raw);
    if (viewing) return ID.test(viewing[1]!) ? void liveRoute(req, res, viewing[1]!, viewing[2] as LiveFamily, viewing[3]!).catch(fail) : fail(new ApiError("not_found", "no run's live view at that address"));
    route(req, res, url, raw.slice(3)).catch(fail);
  });
  // A request's headers come within 10 s, whatever its route: nothing sends more than a few kilobytes of them. Its body
  // keeps Node's 5-minute request timeout, which an upload of a large file needs; the token-less hook route has its own
  // 30 s for its body (push-handler.ts HOOK_BODY_MS), so dribbling senders hold no socket for long.
  server.headersTimeout = 10_000;
  // The one upgrade this server takes: a run's live computer viewer's WebSocket (browser-live.ts). Every other is refused.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const raw = (req.url ?? "/").split("?")[0]!;
    const viewing = LIVE_PATH.exec(raw);
    const deny = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // On loopback, the Host check every route gets (host-check.ts), first: a page that rebound a name of its own to this
    // address sends its own name as Origin too, which the Origin check below would take, so its Host is what gives it
    // away. Its name alone, on any port, as the HTTP routes check it.
    if (names && !names.has(hostName(req.headers.host) ?? "")) return deny("403 Forbidden");
    if (!viewing || !ID.test(viewing[1]!) || !/^\/v\/[A-Za-z0-9_-]{22}\/ws$/.test(viewing[3]!)) return deny("404 Not Found");
    // A browser always sends its page's origin on a WebSocket, which no other page's script can forge: this server's own
    // (as this request reaches it, or its public address, which a TLS proxy that rewrites Host or drops
    // X-Forwarded-Proto leaves as the only one the owner's page has), and the owner signed in, or nothing.
    const sent = String(req.headers.origin ?? "").toLowerCase();
    if (sent === "" || (sent !== ownOrigin(req) && sent !== publicOrigin)) return (authFailed(raw, "live_view_origin"), deny("403 Forbidden"));
    if (!owner || !signedIn(req, owner)) return (authFailed(raw, "live_view_without_session"), deny("401 Unauthorized"));
    // Once the run's WebSocket is piped to this socket, a failure here only ends it: an HTTP line would land mid-stream.
    let piping = false;
    void (async () => {
      const run = ID.test(viewing[1]!) ? await momentOverStore(store, viewing[1]!, viewDepsFor(ownOriginOf())) : undefined;
      // The run's live viewer from the store (the runner's browser/computer tool wrote it under its claim): none for a run no
      // runner holds; with no seal key no live view is served. A /computer/live socket reaches a viewer of every kind, a
      // /browser/live socket a browser's alone (familyReaches), as the page does.
      const viewerHandover = run && sealKey ? await liveViewerById(store, sealKey, run.id, viewing[3]!.slice(3, -3)) : undefined;
      const handover = viewerHandover !== undefined && familyReaches(viewing[2] as LiveFamily, viewerHandover) ? viewerHandover : undefined;
      if (!handover) return deny("404 Not Found");
      // Gone during the lookup, or the server is closing and has ended its viewers, or is about to.
      if (socket.destroyed || closing) return void socket.destroy();
      // Checked again after the lookup, then for as long as the socket is open: the sessions that let it in, and no other.
      const held = heldSessions(req);
      const admitted = () => held.some((value) => owner.valid(value));
      if (!admitted()) return deny("401 Unauthorized");
      viewers.watch(socket, admitted);
      proxyLiveUpgrade(req, socket, head, handover, viewing[3]!, () => { piping = true; });
    })().catch(() => (piping ? void socket.destroy() : deny("500 Internal Server Error")));
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
  // A line in Slack links its run only at an address a person there can open: the public one, when the server has one.
  slack.attach(options.publicUrl);
  // A queued waiting line in a Slack thread goes only while its run still waits there: on the wait the follower read
  // (its last row that shows), none once the run moved on.
  slack.watchWaits(async (runId) => {
    const view = await viewOverStore(store, runId, viewDepsFor(ownOriginOf()));
    if (view?.status !== "input_required") return null;
    const rows = (await timelineOverStore(store, runId, viewDepsFor(ownOriginOf()))) ?? [];
    return rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && r.agent_label !== LEARNING_LABEL)?.id ?? null;
  });
  mcpServers.attach(options.publicUrl ?? url, url);
  // A run's end and its wait are the outbound webhook's run.ended and run.needs_input (webhooks.ts). The runners write them
  // to the store and this server runs no run, so it follows the store: each read takes the runs not final yet and the
  // newest runs (one that started and ended between two reads is among them). It tells each end it has not told once the
  // run reads final, and each wait of a run a runner left parked (or let go of) once it reads input_required. The markers
  // are main's (an end's time, a wait's last row), so each webhook-id is the one it always had, and the ledger tells each
  // once across restarts; a start first catches up the ends the ledger lacks, which no server was up to see. A store read
  // of the runs ended (or parked) since a mark would be the cleaner seam than this read of the open runs every 250 ms.
  const RUN_ENDS_POLL_MS = 250;
  const RUN_ENDS_NEWEST = 50;
  const final = (row: RunRow) => (FINAL_STATES as readonly string[]).includes(row.state);
  const endOf = (row: RunRow) => ({ id: row.id, state: final(row) ? row.state : "running", ...(final(row) && row.endedAt !== null ? { endedAt: new Date(row.endedAt).toISOString() } : {}) });
  /** The run as the store holds it now, with its notice (the run list's own view of it); null when there is no such run. */
  const endNotice = async (id: string) => {
    const row = await store.runs.get(id);
    const summary = row && (await summaryOverStore(store, id, viewDepsFor(ownOriginOf())));
    if (!row || !summary) return null;
    return { ...endOf(row), notice: { run_id: id, agent_id: row.agentId, status: String(summary.status), title: typeof summary.title === "string" ? summary.title : "" } };
  };
  const toldEnds = new Map<string, string>();
  /** Each waiting run's row as it was last read for its wait (its state, epoch and runner): a row that has not moved since
   *  is not read again, and a new wait comes with a new claim, so a new epoch. */
  const readWaits = new Map<string, string>();
  const waitKinds = new Set(["question", "approval", "budget", "browser"]);
  /** The wait of a run its runner left parked (or let go of), told once as main told it: its marker the run's last row
   *  that shows (not usage, a phase or learning's), its kind the pending card's (a stop's when it waits on no card). */
  const tellWait = async (row: RunRow): Promise<void> => {
    const seen = `${row.state}\n${row.epoch}\n${row.runner ?? ""}`;
    if (readWaits.get(row.id) === seen) return;
    const view = await viewOverStore(store, row.id, viewDepsFor(ownOriginOf()));
    if (view?.status !== "input_required") return void readWaits.set(row.id, seen);
    const rows = (await timelineOverStore(store, row.id, viewDepsFor(ownOriginOf()))) ?? [];
    const marker = rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && r.agent_label !== LEARNING_LABEL)?.id;
    if (!marker) return void readWaits.set(row.id, seen);
    const card = (view.pending as { kind?: unknown } | null | undefined)?.kind;
    const kind = view.state !== "waiting" ? "stopped" : typeof card === "string" && waitKinds.has(card) ? card : "question";
    const notice = { run_id: row.id, agent_id: row.agentId, status: "input_required", title: typeof view.title === "string" ? view.title : "", pending: { kind } } as RunNotice;
    tellSlack("run.needs_input", notice, marker);
    if (webhooks.emit("run.needs_input", notice, marker) !== "unsaved") readWaits.set(row.id, seen);
  };
  let openRuns = new Set<string>();
  let endsTimer: NodeJS.Timeout | undefined;
  let endsRead: Promise<void> = Promise.resolve();
  const readEnds = async (): Promise<void> => {
    const open = new Set<string>();
    for (const state of ["queued", "running", "parked"] as const) {
      for (const row of await store.runs.list({ state })) {
        open.add(row.id);
        // A run waits on its person once its runner has let it go: parked, or running with no runner.
        if (!closing && (row.state === "parked" || (row.state === "running" && row.runner === null))) await tellWait(row).catch(() => undefined);
      }
    }
    const newest = await store.runs.list({ limit: RUN_ENDS_NEWEST });
    for (const id of new Set([...openRuns, ...newest.map((row) => row.id)])) {
      if (open.has(id) || closing) continue;
      const now = await endNotice(id).catch(() => undefined);
      // Unread (a busy store): read again at the next turn, never lost.
      if (now === undefined) {
        open.add(id);
        continue;
      }
      readWaits.delete(id);
      if (!now?.endedAt || toldEnds.get(id) === now.endedAt) continue;
      tellSlack("run.ended", now.notice, now.endedAt);
      if (webhooks.emit("run.ended", now.notice, now.endedAt) !== "unsaved") toldEnds.set(id, now.endedAt);
    }
    openRuns = open;
  };
  const followEnds = () => {
    if (closing) return;
    endsRead = readEnds()
      .catch((error: Error) => log?.(logLine("webhook", { condition: "run_ends_unread", error: error.message })))
      .finally(() => {
        if (!closing) (endsTimer = setTimeout(followEnds, RUN_ENDS_POLL_MS)).unref();
      });
  };
  void store.runs
    .list({})
    .then((rows) => webhooks.catchUp(rows.filter((row) => !row.importedFrom).map(endOf), endNotice))
    .catch((error: Error) => log?.(logLine("webhook", { condition: "catch_up_unread", error: error.message })))
    .finally(followEnds);
  const setupUrl = owner && !owner.hasPassword() ? owner.setupLink() : undefined;
  /** The server's stop: once (`close` keeps its promise). */
  let stopped: Promise<void> | undefined;
  async function stop(): Promise<void> {
    // The server writes rows and a runner (its own process) runs every run, so this stop drains no run process and writes
    // no "stopping" mark for a start to wait on: the store's EXCLUSIVE lock is this server's one-server lock, released as
    // the store closes, and the next server takes it. The deliveries, the import, the installs and the listener stop first;
    // the store closes last.
    closing = true;
    stopping.abort();
    // A harness install under way stops with the server: npm gets SIGTERM, then SIGKILL, and nothing half installed stays.
    const installStopped = Promise.all(Object.values(installs).map((install) => install.stop()));
    // Aborted now, so nothing it writes races the next server on the same refresh token; drained before the store closes.
    const mcpStopped = mcpServers.close();
    // A repair of the GitHub installations under way stops waiting on GitHub and writes nothing from here: before the
    // triggers close, so it never turns one off into a closed file.
    const githubStopped = githubConnect.close();
    triggers.close();
    for (const [worker, { task }] of workers) {
      if (task === "plan") void worker.terminate();
      else worker.postMessage("stop");
    }
    await Promise.all([...workers.values()].map((w) => w.exit));
    await importing;
    await installStopped;
    // Before the store closes: the image's last record lands first (box-image.ts), never after the next server's start.
    await image?.close();
    // The box network proxy goes with the server that owns it (box-egress-vm.ts); its volume stays for the next start.
    await egress?.close();
    // The ends' follower stops before the webhooks it feeds and the store it reads.
    clearTimeout(endsTimer);
    await endsRead;
    await webhooks.close();
    // And the Slack posts: one still to try stays in the outbox, for the next server, never tried by this one too.
    slack.close();
    // An upgraded socket is no connection closeAllConnections ends, and server.close waits for it.
    viewers.close();
    await new Promise((done) => (server.close(done), server.closeAllConnections()));
    await mcpStopped;
    await githubStopped;
    // The store's EXCLUSIVE lock is the one-server lock: closing it releases it for the next server.
    await store.close();
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
    // No per-run process drains here: the runner owns a run's turn, so a stop waits on none.
    stopping: () => ({ runs: 0, boundMs: 0 }),
  };
}
