import { CALLS_PAGE_ROWS } from "./timeline/index.js";
import { prepareProjectSkillEdit } from "./source-sync/skill-edits.js";
import { sourceSyncOf } from "./source-sync/types.js";
import { sourceService, SOURCE_BODY_BYTES } from "./source-sync/service.js";
import { destinationPreparation, bindSourceTool } from "./source-sync/destination.js";
import { prepareSource, SourcePreparationError } from "./source-sync/prepare.js";
import { SnapshotError, validateSourceSnapshot } from "./source-sync/snapshots.js";
import { cliAdoptionResolver } from "./source-sync/adoption.js";
import { projectPlacement } from "./source-sync/projects.js";
import { auxiliaryAdmitter } from "./source-sync/auxiliary.js";
import { openRunPlacement, sourceSnapshotReader } from "./source-sync/workspace.js";
import { SOURCE_FAILURES, configurationDigest, type SourceFailureCode } from "./source-sync/registry.js";
import type { SourceSnapshot } from "./native/source-snapshot-types.js";
import type {RunLaunch} from "./run-launch.js";
import { CliLearningConnections } from "./cli-learning/connections.js";
import { ObservationLearning } from "./observation/learning.js";
import { cliLearningOf } from "./store/agent-body.js";
import { maintainObservations, Observations } from './observation/observer.js';
import { isObservationRoute, observationHttp } from './observation/http.js';
import { SDK_MAX_OPEN_MS, SdkRuns, sdkOf, sdkRunSecret } from "./sdk/runs.js";
import { learningModelOf, type LearningModel } from "./learning-model.js";
import { answerSkill } from './skill-route.js';
import { RemoteConnectors, verifyRemote, REMOTE_COMPLETION_BODY_BYTES } from './native/remote.js';
import { REMOTE_HISTORY_BODY_BYTES } from './native/history.js';
import { nativeOf, nativeModelOverrides, nativeExecutionOverrides, NATIVE_MODEL_SETTINGS_UNSUPPORTED, NATIVE_EXECUTION_SETTINGS_UNSUPPORTED, NATIVE_TOOL_BUDGET_UNSUPPORTED, NATIVE_CAP_UNSUPPORTED } from "./native/binding.js";
import { discoverNative } from "./native/discovery.js";
import { isNativeRuntime, NATIVE_RUNTIME_FACTS } from "./native/runtimes.js";
import { connectNative, launchNative, updateNative, verifyConnection } from "./native/connection.js";
// The /v2 API over the agent store in a data directory: the contract agentrun.v2/0, served on loopback with a bearer
// token.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import proxyaddr from "proxy-addr";
import { API_ONLY_HOOKED_KINDS, apiOnlyRefusal, apiOnlyTriggerSkipped, servedApiOnly } from "./api-only.js";
import { RUN_KEYS_ENV } from "./env-switch.js";
import { declaredKeys, keysOwed, keysOwedRefusal, type RunKeys, runKeysOf, runKeysTriggerSkipped, undeclaredKeys, withCarried } from "./run-keys.js";
import { capacityOverStore, capacityWindowOf } from "./capacity.js";
import { carriedFields } from "./answer-json.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import type { Revision, RunOrigin } from "./agent-rows.js";
import { pinFirst as pinFirstOf } from "./mcp-pin-first.js";
import { agentPackage } from "./agent-package.js";
import { uuidv7 } from "./ids.js";
import { type AgentEntry, type InTurn, agentRevision, agentRevisions, agentView, commitAgent, createAgent, definitionOf, etagOf, externalKey, getAgent, listAgents, makeRevision, ownedElsewhere, refuseExternal, revisionView, type SaveCheck, type SavePrepare, type SaveStamp, setAgentArchived, setCurrentRevision } from "./agents-store.js";
import { WORKFLOW_ADAPTERS } from "./runner/workflow-adapters.js";
import { DECISION_ADAPTER, decisionsOf, FAUX_JEV_ENV, FAUX_OPENROUTER_ENV, FAUX_PARALLEL_ENV, fauxFetch } from "./decisions.js";
import { FAUX_WEB_ENV } from "./web-fetch-direct.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, pinMonid, PRICED_BY_USAGE } from "./monid.js";
import { FAUX_EXA_ENV } from "./exa-keyless.js";
import { FAUX_FIRECRAWL_ENV } from "./firecrawl-keyless.js";
import { FAUX_BROWSER_ENV, NODE_TOOLS, shellTools, toolingOf, toolOf, toolsView } from "./tools.js";
import { ApiError, type InputIssue, invalid, sentence, unsupported } from "./errors.js";
import { deref, explain } from "./explain.js";
import { HOME_HOST_OWNED } from "./files.js";
import { DATA_ENV, syncDir, TOKEN_FILE, writeDurable } from "./server-fs.js";
import { homePath, hostOwnedOf, type OwnedReadAt } from "./home-path.js";
import { asksOllama, chooseModel, EFFORTS, FAUX_ENV, FAUX_UPSTREAM_ENV, MODEL_NODES, type ModelNeeds, modelSource, THINKING_LEVELS, unpricedModels, withoutFaux } from "./model.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessCapability, harnessOfBody, harnessOffers } from "./harness.js";
import { HARNESS_MODULES_ENV, HARNESS_MODULES_SETTING, HARNESS_RECIPES_ENV, HARNESS_RECIPES_SETTING, HARNESS_TABLE_ENV, harnessIds, harnessModulesEnv, harnessOf, harnessRecipesEnv, harnessTable, planRecipesOf, recipeHarness, tableIds } from "./harness-table.js";
import { claudeCliIn, HarnessInstall, type HarnessInstaller, installDirOf, NPM_STOP_GRACE_MS, npmInstall } from "./harness-install.js";
import { DEFAULT_PORT, healthOf, hostMemory, maxRunsOf, runsThatFit } from "./host.js";
import { DEFAULT_HOST, elsewhereOf, listenOn, minFreeMibOf, takeOver, urlOf } from "./listen-first.js";
import { IMPORT_ASKED, type ImportCandidate, MAX_CANDIDATES } from "./import.js";
import type { ImportAnswer, ImportTask } from "./import-worker.js";
import { answerStoreCall, type StoreCall } from "./import-proxy.js";
import { LEARNING_LABEL, learningFolderOf, secretsShown, type LearningMode, learningOf, learnsOf, RUN_LEARNING_USE, seedOf, withAgentRepo } from "./learning.js";
import { askReplay, type ReplayAsk, ReplayRefused, replayView } from "./runner/promotion.js";
import { agentLearning, changeWorkflow, correctionsView, correctionsWrite, forgetRunLearning, learningLog, pendingCount, readLearnedFile, sendText, statusesOf, textBody, workflowAtDigest, workflowRevisions } from "./learning-routes.js";
import type { DraftDecisions } from "./learn/workflow-draft.js";
import { purgedRun, refusedIn } from "./purged-workflow.js";
import { answerLlms, MCP_PATH, mcpEndpoint } from "./mcp.js";
import { openapiDocument, servedOpenapi, UNSUPPORTED } from "./openapi.js";
import { boxAvailability, boxesLine, defaultPlaceOf, NEW_AGENT_TOOLS, newAgentPlace, noBoxReason, type Place, placesOf, resolvePlace } from "./place.js";
import { boxAllowOf, boxAllowSetIn } from "./box-settings.js";
import { dockerLimitsOf } from "./workspace/computer-deps.js";
import { Owner, passwordProblem, SESSION_MS } from "./owner.js";
import { acceptedTokens, type ApiToken, bearerCheck, tokenProblem } from "./api-token.js";
import { answerPage, byConsoleSession, byOwnerSession, ConsoleSessions, consoleEntry, heldSessions, isJson, overHttps, ownerCookie, ownerCookieName, ownOrigin, sessionsAtEveryPort, sendHostRefused, sendMoved, sendMovedPage, signedIn } from "./page.js";
import { hostFix, hostName, isLoopbackName, loopbackNames, movedFix } from "./host-check.js";
import { movedAddress, publicAddressChanged, readPublicAddress } from "./public-address.js";
import { computerViewerLink, familyReaches, type LiveFamily, type LiveHandover, liveViewerById, liveViewerFor, liveViewerLink, OpenViewers, proxyLiveUpgrade, serveViewerFile, viewerAnswers } from "./browser-live.js";
import { browserHandBack, handBackTarget } from "./browser-commands.js";
import { type ComputerOf, computerView, type JournalEntry, lapsedOf, sessionIn } from "./computer-view.js";
import { readKept } from "./workspace/computer-kept.js";
import { dialHost, liveReachOf, reachForRun } from "./live-reach.js";
import { screenWaitEnded } from "./browser-wait-ended.js";
import { durationMs, logLine } from "./print.js";
import { type RunMoment, type State, type Status } from "./run-view.js";
import { keepPresence, type Presence, refusedEnd, runnersRefused } from "./runner/presence.js";
import { approve, archiveRun, cancel, message, pause as pauseRunOverStore, prepareLaunch, raiseCap, resume as resumeRunOverStore, type StartDeps, startInline, type StartOptions, startRun, stop as stopRunOverStore } from "./runs-over-store.js";
import { builtOfNow, factsOverStore, listedItem, lookingBackEnd, momentOverStore, summaryOverStore, timelineOverStore, toolsUsdOverStore, type ViewDeps, viewOverStore, withheldOverStore } from "./store-view.js";
import { healEndedCosts } from "./cost-heal.js";
import { reconcileProjectCheckpoints } from "./source-sync/checkpoints.js";
import { acknowledgeProjects } from "./source-sync/checkpoint-gate.js";
import { LocalSources } from "./source-sync/local.js";
import { beginSourceIO } from "./source-sync/io.js";
import { createLister } from "./run-listing.js";
import { HELD_WAITS } from "./runner/journal-kinds.js";
import { type ServedTimelineDeps, servedTimelineRows } from "./run-timeline-served.js";
import { servedRunTrace } from "./run-trace.js";
import { servedRunUsage } from "./run-usage.js";
import { servedRunDiff, servedRunLearning } from "./run-learning-served.js";
import { agentPointers, WITHHELD_LEARNING } from "./handed-values.js";
import { runCutValues } from "./run-cut.js";
import { type HeldRefusal, readLaunchBody } from "./run-launch.js";
import { modelKeyMisfit, modelKeyOf, modelKeyRequired, noServerKeyFor, runModelOrigin, serverKeyMissing } from "./run-model-key.js";
import { listRunFiles as listRunFilesOverStore, readRunFile as readRunFileOverStore, runGraphView, type RunReadsDeps, runTimelines } from "./run-reads-over-store.js";
import { triggerTargets, type TriggerTargetDeps } from "./trigger-targets.js";
import { labelFilter, labelsIssues } from "./run-labels.js";
import { listRuns as listRunsOverStore, readRun as readRunOverStore, runOfOrigin as runOfOriginOverStore } from "./store-reads/runs.js";
import { runEntries } from "./store-reads/journal.js";
import { metersOverStore, spendOverStore } from "./store-reads/cap.js";
import { watchRun } from "./live/stream.js";
import { stats as statsOverStore } from "./store-reads/stats.js";
import { analytics as analyticsOverStore } from "./store-reads/analytics.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgenticBody, type AgentRow, type McpCredentialMark, type MonidPinBody, type NewRevision, openStore, type RevisionPlace, type RevisionRow, type LaunchSealed, openRunLaunch, type RunMcpAuth, type RunRow, sealRunLaunch, type Store, StoreLaunchMissing, StoreOwned, storeTarget, type TemplatePackage, type WorkflowBody } from "./store/index.js";
import { agentDeleting, answerOf, logged, purgedAgent } from "./agents.js";
import { keepGrade } from "./runner/feedback-round.js";
import { gradeRow, notAuditableOf } from "./runner/audit.js";
import { namedDisksOf } from "./learn/learning-of.js";
import { auditsOffWords, auditWriterOf, isShadowRun, readAudits, servingLinesOf, shadowRunId } from "./learn/audit.js";
import { auditLoopOf, COMPILE_AFTER_MAX } from "./learning-setting.js";
import { FINAL_STATES, RUN_CHANGES_PAGE, type RunChange, type RunChangeCursor } from "./store/store.js";
import { championOf, forgetRunCopies, type Grade, GRADE_SOURCES, GRADES_KEPT, type GradeSource, gradeView, LABEL_MAX, type PromotionRecord, promotionsOf, promotionsShown, type Refused, servingOf, servingStateOf, shownDeep } from "./learn/promote.js";
import { workflowNodesOf } from "./learn/workflow-nodes.js";
import { deleteLearning } from "./learn/delete.js";
import { runModelRef } from "./model.js";
import { ollamaHostOf, ollamaHostRefused, ollamaListing, ollamaModels, ollamaReading } from "./ollama-provider.js";
import { REDACTED } from "./secret-cut.js";
// The v2 run statuses, as the run view names them (run-view.ts Status), for the list filter's validation. */
const STATUSES = ["queued", "working", "paused", "input_required", "completed", "failed", "cancelled"] as const;
import { runLines } from "./usage-lines.js";
import { type BoxOffer, boxesByDefault, boxesLog, type ContainerFacts, enabledBoxes, placeOffers, withNetworks } from "./place-offers.js";
import { dockerComputerRefusal, type DockerPaths, dockerPathsOf, FAUX_MOUNTINFO_ENV, remoteDockerOnce } from "./box-paths.js";
import { dockerDaemonCheck, type DockerDaemon } from "./docker-daemon.js";
import { type HostRead, hostAddressesOnce, noHostAddresses, retryHostAddresses, unionOf, type Wait } from "./docker-host-addresses.js";
import { DOCUMENTS_ENV } from "./pdf-pages.js";
import { type Blocker, blockersOf, CODE_NODES_ENV, deniedComputer, issueOf, NOT_SET_UP, type RevisionShape } from "./runnable.js";
import { computerDeniedWords } from "./refusal-words.js";
import { hostSecrets, SECRET_NAMES, secret, type StoredKeys, withSecrets } from "./secrets.js";
import { isSecretWriteOperation, type SecretRequest, secretPageFor, secretsWritableFields, secretWriteRefusal, secretWriterFacts, writesSecretFor, writesSecretsAllowed } from "./secret-writes.js";
import { ChatGPTPlan, planOf, PlanSignInRefused, SIGN_OUT_UNCONFIRMED, withPlan } from "./chatgpt-plan.js";
import { modelGatewayRoute, readSavedGateway, type SavedGateway, withSavedGateway } from "./model-gateway.js";
import { CLAUDE_LOGIN_ROUTES, ClaudeLoginRefused, claudeLoginOf, claudeLoginRouteOff, claudeLoginSwitchedOff, claudeLoginSetting, claudeLoginView, type ClaudeLoginDeps, dropRefusedLogin, envAtPlace, LOGIN_HARNESS, loginOf, loopback, startLoginHere, turnOffClaudeLogin, turnOnClaudeLogin, whyNotOneOwner, withClaudeLogin } from "./claude-login.js";
import { ClaudeSignIns } from "./claude-sign-in.js";
import { bootSealKey, parametersDigest, withSealKey } from "./seal-key.js";
import { ServerLockHeldError, takeServerLock } from "./server-lock.js";
import { recordDataRoot } from "./runner/disk-free.js";
import { recordRunEnv, runFacingNames } from "./runner/runner-check.js";
import { DRAIN_TIMEOUT } from "./runner/beside.js";
import { analyticsFilter, analyticsView, statsView } from "./stats.js";
import { readWrapped, wrappedView } from "./wrapped.js";
import { type CostBasis, joinedBasis } from "./runner/metrics.js";
import { unifiedUsage } from "./unified-usage.js";
import { agentLoopOverStore } from "./store-reads/loop.js";
import { printable } from "./learn/index.js";
import { agentCostOverStore, agentLearningOverStore, allInOf, costRunOf, costStopOverStore, learningCountsOverStore, learningSpendOverStore, runAllInOverStore, runLearningEnd } from "./store-reads/learning.js";
import { costCsv, learningCostQuery, RUN_PATHS } from "./learning-cost.js";
import { keyOf, SEAL_KEY_ENV, TOOL_FIELDS } from "./tool-keys.js";
import { toolKeysOverStore } from "./tool-keys-store.js";
import { HarnessKeysOverStore, harnessKeysSavedHere } from "./harness-keys.js";
import { SIGN_INS_DIR, vendorsOver } from "./sign-ins.js";
import { signInsOverStore } from "./sign-ins-store.js";
import { boundTool, MCP_AUTH_TYPES, marked, mcpAuthOf, type McpTool, nameOf as mcpNameOf } from "./mcp-probe.js";
import { type COMPOSIO_KEY_ENV, composioEnvKey, composioMadeKey, composioPerRun } from "./composio-made.js";
import { COMPOSIO_PER_RUN, type ComposioControl, composioForget, composioNote, composioSave, composioTools } from "./composio-preset.js";
import { ComposioTriggers, composioNoPublicUrl } from "./composio-triggers.js";
import { type ComposioDropped, loopbackWords, mcpServersOverStore, type SaveGuard } from "./mcp-servers-store.js";
import { MCP_ALLOW_LOOPBACK_ENV, startSwitches, WEBHOOK_PRIVATE_TARGETS_ENV } from "./start-switches.js";
import type { SourceRecord } from "./mcp-sources.js";
import { getMcpServer, listMcpServers } from "./mcp-store.js";
import { privateHostsRoute, saveServerOwn } from "./mcp-private-hosts.js";
import { metaToolOf } from "./mcp-meta.js";
import { type McpPin, mcpPinOf } from "./mcp-gateway.js";
import { LOOPBACK, MCP_SETTINGS_PAGE, signInCookie, startedHere } from "./mcp-oauth.js";
import { type RunNotice, WEBHOOK_EVENTS, WEBHOOK_FILE, waitMarkerOf, Webhooks } from "./webhooks.js";
import { SLACK_EVENTS, SlackPosts } from "./slack.js";
import { appPermissionWarnings } from "./template-github-permissions.js";
import { templateApplied, templateTriggerSecret, templateWebhookSecrets, triggerMade, triggerRotated, webhookRotated, webhookSaved, withTriggerSecret } from "./trigger-secrets-shown.js";
import { type SealedSettingsOverStore } from "./sealed-settings-store.js";
import { type ServerSecrets } from "./server-secrets.js";
import { openServerSecretsOverStore } from "./server-secrets-store.js";
import { HOOK_TOLERANCE_S } from "./standard-webhooks.js";
import { GitHubConnect, GitHubConnection, INSTALLED_PATH, startedHere as gitHubStartedHere, stateCookie } from "./github-connection.js";
import { SCOUT_TEMPLATE, Suggestions } from "./suggestions.js";
import type { UsageEventName } from "./telemetry.js";
import { FAUX_GITHUB, FAUX_GITHUB_FILE, startFauxGitHub } from "./github-faux.js";
import { GITHUB_API } from "./github.js";
import { bindingOf, REPO_NAME } from "./run-repo.js";
import { HookCut, receivePush } from "./push-handler.js";
import type { Source, TriggerAdapter } from "./trigger-adapter.js";
import { shownTrigger, TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { SEALED_FIELD, SEALED_MASK } from "./trigger-composio.js";
import { webhook } from "./trigger-webhook.js";
import { SCHEME_NAMES } from "./trigger-signatures.js";
import { permissionFrom, pinnedEffect, toolEffect } from "./tool-gate.js";
import { mcpNameOf as mcpToolOf, mcpToolName } from "./tool-names.js";
import { CATCHUP_WINDOW_S, FAILURES_TO_PAUSE, HISTORY_KEPT, MIN_EVERY_S, RELEASE_WORDS_MAX, SOURCE_KINDS, TARGET_KINDS, type TriggerClock, Triggers } from "./triggers.js";
import type { LaunchHook } from "./trigger-launch-hook.js";
import { PAYLOAD_KEPT_BYTES } from "./trigger-adapter.js";
import { applyBodyOf, choiceUnrunnable, COMPOSIO_TRIGGER_FIX, composioTriggerSkipped, COMPUTER_FIX, compiled, feedLeftEmpty, feedTriggerEmpty, githubTriggerUnconnected, githubTriggerWords, madeTriggerIssues, mcpSetUp, type McpServed, onServerName, onServers, type Package, packageDetail, packageModel, packageTiers, packageView, pickComputer, readPackages, notSetUpYet, serversFor, type ShellHere, TemplateRegistry, type TemplatesDeps } from "./templates.js";
import { applyImported, deleteTemplate, dropRemovedUploads, importTemplate, loadImported, type TemplateImportDeps, UPLOAD_PREFIX } from "./template-import.js";
import { templateInstallLink, templateLink, templatesLink } from "./console-links.js";
import { GITHUB_HOSTS, IMPORT_LIMITS } from "./template-source.js";
import { checkDefinitionBody, DEFAULT_INPUT_SCHEMA, type DefinitionBody, definitionBodyIssues, EXTERNAL_NAME, ID, IDEMPOTENCY_TTL_S, inputIssues, inputSchemaOf, isObject, type Json, stable, unknownFields } from "./validate.js";
import { agentTools, BROWSER_VENDOR_IDS, browserKeyRow, isUnavailable, keptVendor, loadToolSettings, type Plane, recheckPlane, settingsIssues, type ToolSettingsMap, whyUnavailable, withDefaults } from "./tool-plane.js";
import { wakeAnsweredBySetting } from "./settings-wake.js";
import { toolSettingsOverStore } from "./tool-settings-store.js";
import { readApprovers, writeApprovers } from "./server-approvers.js";
import { MAX_FILES_PER_RUN, MAX_UPLOAD_BYTES, Uploads, UPLOADS_DIR, type UploadStore } from "./uploads.js";
import { archilUploads, runKeepsUploads, UPLOAD_RETENTION_ENV, UPLOAD_SWEEP_EVERY_MS, uploadRetentionMs } from "./uploads-archil.js";
import { entryAt, listFiles, sendFile as sendWorkspaceFile, viewOf } from "./run-files.js";
import { recordingsOf, recordingsWorkspace } from "./run-recordings.js";
import { recordingsFolder } from "./workspace/paths.js";
import { heldRoute, holdIssues, runComputerRead } from "./computer-held-routes.js";
import { COMPUTER_ROUTES, computerHoldOf, computerRoute, runComputerKind } from "./computer-routes.js";
import { runOver } from "./computer-commands.js";
import { mintViewerCredential, VIEWER_PARAM, viewerCookie, viewerCredentialFor, viewerCredentialKey, viewerCredentialOf } from "./viewer-credential.js";
import { ATTACH_PATH, AttachHub, type HostedDial, PROVIDERS as COMPUTER_PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";
import { type AttachTiming, createAttachRoutes, liveRelays, pairedView } from "./computer-attach.js";
import { pairedRefusal, withPaired } from "./workspace/attached-computers.js";
import { COMPUTER_TOOLS, hostToolDefs } from "@parcha/agentrun-kernel/kernel";
import { freeModelRequestsOf } from "@parcha/agentrun-kernel/kernel/cap";
import { archilRoute, type ArchilRoutesOptions, createArchilRoutes, liveRunsOnDisk } from "./archil-routes.js";
import { noAccount, openAccount } from "./email/account.js";
import { emailRoute } from "./email/routes.js";
import { addressForms, openCalendar } from "./calendar/address.js";
import { calendarRoute } from "./calendar/routes.js";
import { agentDiskOf, ARCHIL_DISK_ID, archilSettingsFromEnv, inArchilMode, loadArchilSettings, runDiskKept, runDiskKey } from "./archil-settings.js";
import { computerOfPlace, type ComputerKind, type ComputerSetting, type PlaceView, settingOfDefinition } from "./computer-setting.js";
import { computerCapabilities, type ComputerRoutes, createComputerRoutes, folderModeOf, hostCommandRefusals, settingsComputerRoute } from "./computers.js";
import { runningComputers } from "./computers-running.js";
import { type FauxComputers, fauxComputers } from "./faux-computers.js";
import { writesHeld } from "./workspace.js";
import { type AgentDeleteHost, type AgentDeleteStep, type DeleteLearning, deleteExternalAgent, oneAtATime, purgeAgent, purgeRun, purgingKey } from "./agent-delete.js";
import { type LearningResetHost, resetLearning } from "./learning-reset.js";
import { agentComputerHoldKey } from "./workspace/agent-computer.js";
import { sdkRunKey } from "./sdk/runs.js";
import { waitEndedKey } from "./browser-wait-ended.js";
import { agentComputerOf, agentComputerView, agentDirName, agentFolder, agentHomeFolder, claimKinds, runFolder, scratchFolder, computerProviderFactories, computerProviderMakers, computerReadiness, dockerHostAddressesOf, isWorkspaceError, localWorkspace, reconcileAgentComputer, registryHere, runShellOf, serverRunWorkspace, type ShellPlace, storeLedger, type Workspace } from "./workspace/index.js";
import { keyReader } from "./key-meta.js";
import { redacted } from "./key-refusal.js";

export const CONTRACT = "agentrun.v2/0";

/** A process's flags for a worker of it: without --input-type and the code string given with -e, --eval, -p or --print. */
const workerArgs = (args: readonly string[]): string[] =>
  args.filter((arg, i) => !arg.startsWith("--input-type") && !/^(?:-e|--eval|-p|--print)(?:=|$)/.test(arg) && !/^(?:-e|--eval|-p|--print)$/.test(args[i - 1] ?? ""));
export { DEFAULT_PORT };
const VERSION: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const IDEMPOTENCY_FILE = ".idempotency.json";
/** A run's live viewer, under the run's path (browser-live.ts): its run id, the family's address (`computer`, one for every
 *  computer kind; `browser`, the browser's own), then its page, files or WebSocket. Both are served by the same code. */
const LIVE_PATH = /^\/v2\/runs\/([^/]+)\/(computer|browser)\/live(\/.*)$/;
const MAX_BODY = 1 << 20;
/** POST /v2/templates/import's body: an upload's files at the import's own limit, base64 (4/3) with room for the JSON
 *  around them. */
const TEMPLATE_UPLOAD_BODY = Math.ceil((IMPORT_LIMITS.packageBytes * 4) / 3) + MAX_BODY;
/** The starts that may begin setup's import without ending it (a worker that failed, a process that ended) before the
 *  owner's yes is dropped: an import that fails the same way each time is not taken up at every start for good. */
const IMPORT_STARTS = 3;
/** The heap of the worker that counts or imports this machine's sessions. A run is read whole, at most MAX_RUN_BYTES of
 *  files (import.ts), which this holds several times over. */
const IMPORT_HEAP_MB = 2048;
const MAX_MESSAGE = 20_000;
const MAX_WAIT_MS = 25_000;
/** A run body's fields that a launch hook's host can't set on a firing's run (RunCreate `trigger_firing`): its trigger's
 *  target fixes them. */
const HANDED_FIXED = ["revision", "hold", "hold_minutes"] as const;
/** How often the server fails the runs still queued while no runner here can take them (runner/presence.ts). */
const REFUSED_SWEEP_MS = 2_000;
const PAGE_ROWS = 500;
const FILE_LIST_CAP = 2_000;
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
  /** On Postgres: told when this server's owner lock is lost for good (another server took the schema, or the lock could
   *  not be taken back): every store call is refused from then. The CLI exits 1 on it, so the platform restarts the server. */
  onStoreLost?: (error: Error) => void;
  /** Told when someone uses a feature the anonymous counts name (telemetry.ts UsageEventName: a suggestions scan, a
   *  discard, a suggested agent created). The CLI hands it the counts' `used`; it hears the event's name and nothing else. */
  onUsage?: (event: UsageEventName) => void;
  /** The owner, signed in with a password (owner.ts): the page asks for it, and the token stays for scripts and the CLI. */
  accounts?: boolean;
  /** With accounts: the first visit sets the password with no setup code (a server with no public address). Honored only
   *  on a loopback listener: on any other address anyone who reaches the port could set the password first, so setup
   *  takes the code this server prints, or the token, as it does off. */
  openSetup?: boolean;
  /** With accounts: the address people open (AGENTRUN_PUBLIC_URL), which the printed setup link uses. */
  publicUrl?: string;
  /** With open setup: the home whose Claude Code, Codex and pi sessions setup offers to import (default this user's),
   *  and the temp directory whose projects it leaves out (default the OS's). */
  sessionsHome?: { home: string; temp?: string };
  /** With open setup on this machine, and no owner yet: count the sessions setup would import as the server starts, so
   *  the offer has its numbers by the time the page opens (the CLI sets it). */
  countSessions?: boolean;
  /** With accounts: the most addresses the sign-in limit keeps at once (default 10,000); a new one past it is counted by
   *  the server's failure budget only. */
  signInAddresses?: number;
  /** The proxies in front of this server (AGENTRUN_TRUSTED_PROXIES): addresses, CIDR ranges, or `loopback`, `linklocal`,
   *  `uniquelocal`. A request from one of them is counted by the sign-in limit under the client address its
   *  X-Forwarded-For names (the nearest one not itself a trusted proxy). None by default: the header is never read, and
   *  every request counts under the address it came from. */
  trustedProxies?: readonly string[];
  /** This server is a local install, its operator says (the CLI: AGENTRUN_MCP_ALLOW_LOOPBACK=1, only on a machine they
   *  alone use): an MCP server's URL may be on loopback, at its save, preview and sign-in, and for the runner beside it.
   *  Never inferred; absent, loopback is refused there in words saying how to say so. */
  mcpLoopback?: boolean;
  /** A template eval's own scratch server (template-eval.ts), never set by the CLI: an MCP server's save may say, in its
   *  `source`, which package need the eval's fake stands in for. Every other server records what made a server. */
  mcpStandIns?: boolean;
  /** The address to listen on (default 127.0.0.1). On any other address every `Host` name is served and the token is
   *  the only lock: put TLS in front of it. */
  host?: string;
  /** The token to require in place of the one `DIR/.token` keeps: 32 characters or more, no whitespace. Its id is
   *  `default` (api-token.ts). */
  token?: string;
  /** More API tokens (AGENTRUN_TOKENS, api-token.ts parseTokens), each with an id: every one opens every route the
   *  token opens. Given these and no `token`, `DIR/.token` is neither read nor made, and the first is the server's
   *  token. Each id names its token in the request log; no line holds a secret. */
  tokens?: readonly ApiToken[];
  /** Default 7340; 0 is any free port. */
  port?: number;
  /** When the port is taken at the listen, the next one that is not, of the 100 from it: the port is found by listening,
   *  so one another process takes at the same moment is passed over. Without it a taken port fails the start. */
  nextFreePort?: boolean;
  /** A server already listening (listen-first.ts, the CLI's early bind), answering that it is warming: the start takes it
   *  over where it would have listened, and `port`, `nextFreePort` and `host` are then only what it was bound with. */
  listener?: Server;
  /** A read-only directory of documents a workflow's `pdf_pages` calls read by file name (`--documents`); default
   *  AGENTRUN_SERVE_DOCUMENTS. */
  documents?: string;
  /** Run workflows' `code` nodes (`--allow-code-nodes`; default AGENTRUN_SERVE_CODE_NODES=1). Off, a workflow with one saves
   *  with a warning and its run is 409: a code node runs in the run's process through `new Function`, which is no sandbox. */
  allowCodeNodes?: boolean;
  /** A faux model module (no key, no network): see the README. */
  faux?: string;
  /** The API-only profile (AGENTRUN_API_ONLY=1, api-only.ts): serve the run routes alone and refuse every other address
   *  (the console, sign-in, setup, settings, MCP, triggers, hooks, ...) with a 404 before anything reads the request.
   *  It has no owner: accounts and open setup are off, there being no page to sign in to. */
  apiOnly?: boolean;
  /** The launch hook (AGENTRUN_LAUNCH_HOOK_URL and _SECRET, trigger-launch-hook.ts): each trigger firing that would start
   *  a run is handed to the host instead, which starts it through the API. None, firings start their runs here. */
  launchHook?: LaunchHook;
  /** The run-keys setting (AGENTRUN_RUN_KEYS=1, run-keys.ts): a template's apply makes its agent though a tool key it
   *  declares is not set here, and a run of it that does not carry that key in `keys` is refused. */
  runKeys?: boolean;
  /** Another Archil control plane than the key's region's, and its fetch, and another maker of a disk's file API: a
   *  test's fakes, for the server's own Archil calls (a launch's disk read, the settings' test, an agent's disk removed,
   *  a deleted agent's run folder removed from a disk its launch named). */
  archilControl?: ArchilRoutesOptions["control"];
  /** How long an uploaded file no run names is kept on the uploads disk in Mode 2 (uploads-archil.ts): a duration such
   *  as 7d, or "off". Default AGENTRUN_UPLOAD_RETENTION, else 7d. */
  uploadRetention?: string;
  /** Another Composio than the real one, and its fetch: a test's fake, for the Composio preset's calls (composio-preset.ts). */
  composioControl?: ComposioControl;
  /** With `faux` only: a module whose default export gives the `browser` tool's `{ provider, driver }` (the tests' fake
   *  backend), in place of Browserbase's or Kernel's. */
  fauxBrowser?: string;
  /** With `faux` only: a fake GitHub App, connected at the start, its API in this process on loopback (github-faux.ts),
   *  so the console's GitHub flows run with nothing sent to GitHub. Its webhook secret is kept beside the data
   *  (FAUX_GITHUB_FILE) for a test's signed delivery. Refused on a data directory another GitHub App is connected in. */
  fauxGitHub?: boolean;
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
  /** With `faux` only: the URL of a fake MCP server (a test's, on loopback) that web_search's and web_fetch's keyless
   *  Firecrawl ask in place of Firecrawl's endpoint (firecrawl-keyless.ts). A URL, not a module: it is passed as given.
   *  Under `faux` with none, keyless Firecrawl is never asked. */
  fauxFirecrawl?: string;
  /** A module of harness table entries merged over the built-in ones (harness-table.ts HARNESS_TABLE_ENV): a test's
   *  stand-ins for the harnesses. */
  harnessTable?: string;
  /** The owner's harness modules (harness-table.ts HARNESS_MODULES_ENV): packages or paths, each exporting a
   *  HarnessTableModule whose entries add harnesses of their own, for this server and its runs. Never a built-in one. */
  harnessModules?: readonly string[];
  /** The owner's harness recipes (harness-table.ts HARNESS_RECIPES_ENV): recipe files installed into `data`, each adding
   *  the harness it describes to this server and its runs once a harness-check of it passed there (HARNESS.md#a-recipe). */
  harnessRecipes?: readonly string[];
  /** The owner's say-so (--harness-sign-in) that a plan-billed recipe with a sign-in runs a person's runs on the owner's
   *  own sign-in: a start refuses it unless this server is one owner's own, on their own machine (harnessSignInRefusal). */
  harnessSignIn?: boolean;
  /** With `faux` only: Docker answers, so docker is available, and nothing asks Docker (place-offers.ts). */
  fauxDocker?: boolean;
  /** For tests: how long the Claude Code CLI's own sign-in this server starts waits for its browser before it is ended
   *  (claude-sign-in.ts), in place of 10 minutes. */
  claudeSignInLimitMs?: number;
  /** For tests: the lock each harness's first use installs by (harness-install.ts), by harness, with the package.json it
   *  locks beside it, in place of the one AgentRun ships, whose packages a test's own registry serves. */
  harnessLocks?: Readonly<Record<string, string>>;
  /** For a caller in this process: what a harness's first use installs it with, in place of npm into the data
   *  (harness-install.ts sharedInstaller, the template eval's). No environment variable or flag reaches it. */
  harnessInstall?: HarnessInstaller;
  /** Under `faux`: a file read as this server's /proc/self/mountinfo (box-paths.ts), a container's in a test; absent (and
   *  no FAUX_MOUNTINFO_ENV), a faux server is on a host. */
  fauxMountinfo?: string;
  /** For tests: whether Docker's start probe takes this server to be in a container (place-offers.ts containerReason),
   *  in place of its own marks; a faux server's is a host's. */
  probeContainer?: ContainerFacts;
  /** For tests: the wait before each read again of the Docker host's addresses after the start's failed
   *  (docker-host-addresses.ts retryHostAddresses), in place of the backoff's timer. */
  hostReadWait?: Wait;
  /** Extra `Host` names to accept besides the loopback ones, on any port (host-check.ts). */
  allowHosts?: string[];
  /** The console's built files, answered at / (default dist/console beside the server, which this package's build copies
   *  from apps/console/dist). */
  console?: string;
  /** How long a run's process may finish its turn after SIGTERM (default 30s): `8s`, `500ms`, `1m`. */
  drainTimeout?: string;
  /** How often the runs' listings' builder looks again when it found nothing to build (run-listing.ts; default
   *  LISTER_IDLE_MS). `Infinity`: it builds only when Serve.listingSettled asks, so a test reads what a list builds alone. */
  listerIdleMs?: number;
  /** No runner beside this server in its process (the CLI's --no-runner, the image's server-and-runner): a paired
   *  computer's socket is held here, where no run reaches it, so a pairing code, the pair answer and each paired computer
   *  say so and how to start the server instead (attached-computers.ts RUNNER_APART_WORDS). */
  runnerApart?: boolean;
  /** For tests: the attach socket's liveness timing (computer-attach.ts AttachTiming), a relayed dial's included; the
   *  protocol's by default. */
  attachTiming?: AttachTiming;
  /** The most runs at once (default: AGENTRUN_MAX_RUNS, else as many pi runs as this host's memory holds: host.ts),
   *  beside the memory each run's harness reserves; over either, 429. */
  maxRuns?: number;
  /** Free disk under the data directory below which GET /v2/health fails (default 64 MiB, or AGENTRUN_MIN_FREE_MB). */
  minFreeBytes?: number;
  /** Where the log lines go (print.ts); none without it. AGENTRUN_LOG=quiet leaves out the request lines. */
  log?: (line: string) => void;
  /** The lines a person reads about a stop on this data root: this server's, as its close begins and runs' processes are
   *  left to finish their turn. Default: standard error, after `agentrun-serve: `. */
  notice?: (line: string) => void;
  /** Whether runs learn (`--learning`; default AGENTRUN_SERVE_LEARNING, else `on`). `on`: a run of an agent whose
   *  definition says `learning: true` starts from what its agent learned. `off`: no run this server starts does, whatever
   *  its agent's definition says, and its `learning` is null. */
  learning?: LearningMode;
  /** A test's seam: the triggers' clock and timer (triggers.ts), in place of Date.now and setTimeout. */
  triggerClock?: TriggerClock;
  /** A test's seam: awaited by a template apply with agent_id right after it read that agent, inside its turn on the
   *  agent (applyTemplate), so a test can hold an update there and write meanwhile. */
  templateApplyRead?: (agentId: string) => Promise<void>;
  /** A test's and a template eval's seam: the URL a feed trigger's read of `url` goes to in its place (a fake feed on
   *  loopback, feed/feed-faux.ts); null when it serves no feed at `url` (read as unreachable, nothing sent); undefined
   *  to read it as it is. The trigger, its payload and its words keep `url`. */
  feedsAt?: (url: string) => string | null | undefined;
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
  /** A test's seam: the one origin a Composio key read from the environment is sent to (default Composio's:
   *  composio-made.ts COMPOSIO_ORIGIN). */
  composioMcpOrigin?: string;
  /** A test's seam: how long a hook's body has to arrive, whole (default 30 s: push-handler.ts HOOK_BODY_MS). */
  hookBodyMs?: number;
  /** A test's seam: awaited by a message (a person's, or a trigger's firing) once its checks have passed and just before its
   *  command row is written, with the run's id and the message's text, so a test can hold a message at the run's door while
   *  the run's state changes under it (runs-over-store.ts message). */
  beforeSubmit?: (runId: string, content: string) => Promise<void> | void;
  /** A test's seam: step 2 of DELETE /agents/{id} (agent-delete.ts) in place of the learning module's deleteLearning over
   *  the agent's learning folder (learn/delete.ts), the server's own. */
  deleteLearning?: DeleteLearning;
  /** A test's seam: awaited at each step's point of DELETE /agents/{id} and DELETE /runs/{id} (agent-delete.ts
   *  AgentDeleteStep), with the agent's id or the run's, so a throw there stops the delete as a crash would. */
  agentDeleteAt?: (step: AgentDeleteStep, id: string) => void | Promise<void>;
  /** A test's seam: told each time a request waits in an agent's delete turn behind another (agent-delete.ts oneAtATime),
   *  with the agent's id and how many of its requests wait there now, so a test knows a write sent while a DELETE is
   *  held is queued behind it before it lets the DELETE go. */
  deleteTurnQueued?: (agentId: string, waiting: number) => void;
  /** A test's seam: awaited with a request's path and answer once its work under an Idempotency-Key is done, before the
   *  answer is kept, so a test can hold a request there while a DELETE /agents/{id} runs. */
  beforeKeep?: (path: string, answer: unknown) => void | Promise<void>;
  /** How long DELETE /agents/{id} waits for the agent's cancelled runs to end (default 30 s), then 409 runs_in_flight. */
  agentDeleteWaitMs?: number;
  /** A test's seam: the folder the template packages are read from, in place of the package's own (templates.ts). */
  templates?: string;
  /** A test's seam: the GitHub a template import reads, its API's origin and the one host it may be sent to, in place of
   *  GitHub's own (template-source.ts GITHUB_HOSTS). */
  templateImportApi?: string;
  /** The waits before each try again of a webhook delivery (default 5 s, 5 min, 30 min, 2 h, 5 h and 10 h: webhooks.ts RETRY_MS). */
  webhookRetryMs?: readonly number[];
  /** The bound on one webhook try, whole milliseconds under the 60 s claim it holds its message by (default 15 s:
   *  webhooks.ts TIMEOUT_MS); any other value refuses the server's start. */
  webhookTimeoutMs?: number;
  /** Whether the outbound webhook may send to a private network or this machine: off by default, so no caller of the API
   *  can make the server POST inside its own network. The operator's AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1 turns it on. */
  webhookPrivateTargets?: boolean;
  /** A test's seam: the addresses the outbound webhook's receiver's name resolves to, at a save's check and at each try
   *  (webhooks.ts), in place of the system resolver's. A test's server answers its example hosts here, so no CI
   *  runner's resolver decides what a test sees. */
  webhookLookup?: (host: string) => Promise<string[]>;
  /** A test's seam: the origin Slack's messages are posted to in place of https://hooks.slack.com, each URL's path kept
   *  (slack.ts sendTo), so no test reaches Slack. */
  slackTarget?: string;
};

/** Each test switch a run's process reads, by the variable it reads it from: set only under `faux`, but the faux
 *  harness's, which scripts the harnesses with or without it. */
const FAUX_SWITCHES = [["fauxBrowser", FAUX_BROWSER_ENV], ["fauxWeb", FAUX_WEB_ENV], ["fauxJev", FAUX_JEV_ENV], ["fauxParallel", FAUX_PARALLEL_ENV], ["fauxOpenrouter", FAUX_OPENROUTER_ENV], ["fauxMonid", FAUX_MONID_ENV], ["fauxUpstream", FAUX_UPSTREAM_ENV], ["fauxExa", FAUX_EXA_ENV]] as const;

/** The switches a run's process gets, each module path resolved: the owner's harness modules (harnessModules), and the test
 *  switches, which are empty outside tests. A test's in-process runner takes the same (test/support.mjs
 *  startInProcessRunner). */
export function fauxEnvOf(options: ServeOptions): NodeJS.ProcessEnv {
  // The owner's harness modules too (not a test switch): a run's process reads the same table as the server.
  const env: NodeJS.ProcessEnv = { ...harnessModulesEnv(options.harnessModules ?? [], options.data), ...harnessRecipesEnv(options.harnessRecipes ?? [], options.data, { signIn: options.harnessSignIn === true }), ...(options.harnessTable ? { [HARNESS_TABLE_ENV]: resolve(options.harnessTable) } : {}) };
  if (!options.faux) return env;
  env[FAUX_ENV] = resolve(options.faux);
  for (const [option, name] of FAUX_SWITCHES) if (options[option]) env[name] = resolve(options[option]);
  // A URL, so never resolved as a path.
  if (options.fauxFirecrawl) env[FAUX_FIRECRAWL_ENV] = options.fauxFirecrawl;
  // The mountinfo the server itself reads (fauxMountinfo in serve), also when its own environment names it: a CLI server
  // in a container hands it to the runner beside it, whose environment drops every faux variable it inherited.
  const mountinfo = options.fauxMountinfo ?? process.env[FAUX_MOUNTINFO_ENV];
  if (mountinfo) env[FAUX_MOUNTINFO_ENV] = resolve(mountinfo);
  return env;
}

/** `tokenFile` is null when `options.token` gave the token; `tokenMade` says this start made the token in it. */
/** `setupUrl`: with accounts and no password yet, the page that sets it (with its code when setup needs one);
 *  `setupOpen`: whether that setup takes no code (open setup on a loopback listener). */
/** `boxesLine`: what the start's banner says of the boxes, in words (place.ts boxesLine). */
/** `launchCode`: with no accounts, the code of the console's link this start prints (`/?launch=<code>`), which gives the
 *  browser that opens it a console session (page.ts ConsoleSessions). */
/** `token` is the first of `tokenIds` (the console's session stands for it); `tokenIds` are the ids of every token the
 *  server takes, in order (api-token.ts), never their secrets. */
export type Serve = { url: string; baseUrl: string; port: number; token: string; tokenIds: readonly string[]; tokenFile: string | null; tokenMade: boolean; setupUrl?: string; setupOpen?: boolean; launchCode?: string; boxesLine: string; close(): Promise<void>;
  /** The live sockets of the computers paired with this server (computer-attach.ts): a runner beside the server in this
   *  process takes it (runner/beside.ts), so its runs can use them. */
  attachHub: AttachHub;
  /** What a dial provider's create takes of this server (HostedProvider's dial): the address its machines dial
   *  (AGENTRUN_PUBLIC_URL, absent without one), the tokens it mints for them (computer-attach.ts machineTokens) and the
   *  hub their sockets land in. The runner beside the server hands it to its remote providers (runner/beside.ts). */
  dial: HostedDial;
  /** Whether this server is a local install (listening on loopback, reached at no address off it): the one kind whose own
   *  runner beside it may reach an MCP server's URL on loopback (runner/beside.ts mcpLoopback). Only that runner is told:
   *  it is this process's finding, never a store's, so another runner on a shared store never inherits it. A runner in
   *  its own process takes its own operator's opt-in from its own environment (runner/main.ts runnerLoopback). */
  localInstall: boolean;
  /** The OLLAMA_HOST its runner beside it asks (ollama-provider.ts ollamaHostOf): this server's own, else the default
   *  address where this is one owner's own machine; none on a shared one that names none (runner/beside.ts ollamaHost). */
  ollamaHost: string | undefined;
  /** This server's own addresses (McpServersOverStore.own): where it listens, and its public address when that is on
   *  loopback. The runner beside it is told them with localInstall (runner/beside.ts mcpOwn), so its runs' loopback reads
   *  never reach this server, as its own reads never do. */
  own: readonly string[];
  /** With --faux-github: the fake GitHub's API and its repository's site, for a test's own runner alone
   *  (test/support.mjs): the runner's GitHub API has one way in, a test runner's option, so neither the CLI's runner nor
   *  any setting is ever pointed at it. */
  fauxGitHub?: { api: string; web?: string };
  /** What a stop waits on: the runs whose processes still finish their turn, and the longest it waits on them. */
  stopping(): { runs: number; boundMs: number };
  /** Resolves once every run's listing is current (run-listing.ts Lister.settled): for tests and benchmarks. */
  listingSettled(): Promise<void>;
  /** Says in the store, until the stop, that the runner beside this server refused to claim any run, in `words` (its run
   *  isolation refused, cli.ts): while no runner that claims is there, a start is refused in them and the runs queued
   *  fail (runner/presence.ts). Once; a second call keeps the first. */
  refuseRuns(words: string): void };

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
  {method:"GET",pattern:/^\/observations$/,name:"getObservations"},
  {method:"GET",pattern:/^\/connectors$/,name:"listRemoteConnectors"},
  {method:"POST",pattern:/^\/connectors\/enrollment$/,name:"enrollRemoteConnector"},
  {method:"POST",pattern:/^\/connectors$/,name:"registerRemoteConnector"},
  {method:"DELETE",pattern:/^\/connectors\/([^/]+)$/,name:"revokeRemoteConnector"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/import$/,name:"importRemoteTarget"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/targets\/([^/]+)\/history$/,name:"importRemoteHistory"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/targets\/([^/]+)\/sync\/grant$/,name:"grantSourceSync"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/targets\/([^/]+)\/sync$/,name:"publishSourceSync"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/targets\/([^/]+)\/sync\/status$/,name:"sourceSyncFailure"},
  {method:"GET",pattern:/^\/agents\/([^/]+)\/source$/,name:"getSourceSync"},
  {method:"PATCH",pattern:/^\/agents\/([^/]+)\/source$/,name:"setSourceSync"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/source\/move$/,name:"moveSourceAgent"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/source\/tools$/,name:"bindSourceTool"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/source\/resolve$/,name:"resolveSourceSync"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/source\/project-review$/,name:"reviewSourceProject"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/poll$/,name:"pollRemoteConnector"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/commands\/([^/]+)\/events$/,name:"remoteCommandEvents"},
  {method:"POST",pattern:/^\/connectors\/([^/]+)\/commands\/([^/]+)\/complete$/,name:"completeRemoteCommand"},
  {method:"POST",pattern:/^\/cli-learning\/connections$/,name:"enrollCliLearning"},
  {method:"GET",pattern:/^\/cli-learning\/connections$/,name:"listCliLearning"},
  {method:"DELETE",pattern:/^\/cli-learning\/connections\/([^/]+)$/,name:"revokeCliLearning"},
  {method:"POST",pattern:/^\/cli-learning\/connections\/([^/]+)\/runs$/,name:"startCliLearningRun"},
  {method:"GET",pattern:/^\/cli-learning\/runs\/([^/]+)$/,name:"getCliLearningRun"},
  {method:"POST",pattern:/^\/cli-learning\/runs\/([^/]+)\/events$/,name:"cliLearningEvents"},
  {method:"POST",pattern:/^\/cli-learning\/runs\/([^/]+)\/complete$/,name:"completeCliLearningRun"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/sdk-runs$/,name:"startSdkRun"},
  {method:"GET",pattern:/^\/sdk-runs\/([^/]+)$/,name:"getSdkRun"},
  {method:"POST",pattern:/^\/sdk-runs\/([^/]+)\/events$/,name:"sdkRunEvents"},
  {method:"POST",pattern:/^\/sdk-runs\/([^/]+)\/complete$/,name:"completeSdkRun"},
  {method:"POST",pattern:/^\/native\/discover$/,name:"discoverNative"},
  {method:"POST",pattern:/^\/native\/connect$/,name:"connectNative"},
  {method:"GET",pattern:/^\/agents\/([^/]+)\/native$/,name:"getNative"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/native\/verify$/,name:"verifyNative"},
  {method:"POST",pattern:/^\/agents\/([^/]+)\/native\/disconnect$/,name:"disconnectNative"},
  { method: "GET", pattern: /^\/capabilities$/, name: "getCapabilities" },
  { method: "GET", pattern: /^\/openapi\.json$/, name: "getOpenapi" },
  // Answered here only with accounts off: with accounts on, the owner's routes answer it before any route (ownerRoute).
  { method: "GET", pattern: /^\/auth\/session$/, name: "getAuthSession" },
  { method: "GET", pattern: /^\/health$/, name: "getHealth" },
  { method: "POST", pattern: /^\/agents$/, name: "createAgent" },
  { method: "GET", pattern: /^\/agents$/, name: "listAgents" },
  { method: "GET", pattern: /^\/agents\/([^/]+)$/, name: "getAgent" },
  { method: "DELETE", pattern: /^\/agents\/([^/]+)$/, name: "deleteAgent" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/definition$/, name: "updateDefinition" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/revisions$/, name: "listRevisions" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/package$/, name: "getAgentPackage" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/current$/, name: "setCurrent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/archive$/, name: "archiveAgent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/unarchive$/, name: "unarchiveAgent" },
  { method: "DELETE", pattern: /^\/agents\/([^/]+)\/sign-ins\/([^/]+)$/, name: "forgetSignIn" },
  // The agent's Archil disk (archil-routes.ts): read, and removed for an archived agent.
  { method: "GET", pattern: /^\/agents\/([^/]+)\/archil$/, name: "getAgentArchil" },
  { method: "DELETE", pattern: /^\/agents\/([^/]+)\/archil$/, name: "deleteAgentArchil" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/runs$/, name: "createRun" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/runs$/, name: "listRuns" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home\/files$/, name: "listHomeFiles" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home\/files\/(.+)$/, name: "readHomeFile" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/home\/files\/(.+)$/, name: "writeHomeFile" },
  { method: "DELETE", pattern: /^\/agents\/([^/]+)\/home\/files\/(.+)$/, name: "deleteHomeFile" },
  { method: "GET", pattern: /^\/runs$/, name: "listAllRuns" },
  { method: "POST", pattern: /^\/runs$/, name: "createInlineRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)$/, name: "getRun" },
  { method: "PATCH", pattern: /^\/runs\/([^/]+)$/, name: "raiseRunCap" },
  // A run purged, its cost kept, with the runs made from it (agent-delete.ts purgeRun).
  { method: "DELETE", pattern: /^\/runs\/([^/]+)$/, name: "deleteRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/timeline$/, name: "getTimeline" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/messages$/, name: "sendMessage" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/stop$/, name: "stopRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/cancel$/, name: "cancelRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/approvals\/([^/]+)$/, name: "answerApproval" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/archive$/, name: "archiveRun" },
  // A person's or an eval's grade of an ended run (learn/promote.ts): what promotion by replay reads.
  { method: "PUT", pattern: /^\/runs\/([^/]+)\/grade$/, name: "gradeRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/unarchive$/, name: "unarchiveRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/graph$/, name: "getRunGraph" },
  // A run's trace (run-trace.ts): each model request and tool call as a span, with its time, tokens and cost.
  { method: "GET", pattern: /^\/runs\/([^/]+)\/trace$/, name: "getRunTrace" },
  // A run's usage lines (run-usage.ts): by meter, model, charger and provider, each with its quantity and its cost.
  { method: "GET", pattern: /^\/runs\/([^/]+)\/usage$/, name: "getRunUsage" },
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
  // An API-only server's viewer credential for a run's live view (viewer-credential.ts), minted for its backend.
  { method: "POST", pattern: /^\/runs\/([^/]+)\/computer\/viewer$/, name: "createRunComputerViewer" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/computer\/hand-back$/, name: "handBackRunComputer" },
  // A held computer's (computer-held-routes.ts): a run started with hold: true waits for its start, takes its owner's
  // protocol calls, and keeps its computer after its agent's end until released.
  { method: "POST", pattern: /^\/runs\/([^/]+)\/start$/, name: "startRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/computer\/call$/, name: "callRunComputer" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/computer\/release$/, name: "releaseRunComputer" },
  // Settings → Computers (computers.ts settingsComputerRoute) and the owner's Archil settings (archil-routes.ts
  // archilRoute): the server switch dispatches them, once the server opens its store.
  { method: "GET", pattern: /^\/computers$/, name: "listComputers" },
  { method: "GET", pattern: /^\/computers\/running$/, name: "listRunningComputers" },
  { method: "PUT", pattern: /^\/computers\/([^/]+)\/keys$/, name: "saveComputerKeys" },
  { method: "POST", pattern: /^\/computers\/([^/]+)\/test$/, name: "testComputer" },
  { method: "GET", pattern: /^\/computers\/([^/]+)\/choices$/, name: "listComputerChoices" },
  // A person's own computer paired with this server (computer-attach.ts): the owner's code, the driver's trade of it for
  // its token (no token of the server's: the code is the credential), the attach socket (a WebSocket: the server's
  // upgrade takes it; a plain GET is told so), and a computer's removal.
  { method: "POST", pattern: /^\/computers\/pairings$/, name: "createPairing" },
  { method: "POST", pattern: /^\/computers\/pair$/, name: "pairComputer" },
  { method: "GET", pattern: /^\/computers\/attach$/, name: "attachComputer" },
  // A hosted machine's computerd build, fetched at its boot with the token its create minted (computer-attach.ts daemon).
  { method: "GET", pattern: /^\/computers\/daemon$/, name: "getComputerDaemon" },
  { method: "DELETE", pattern: /^\/computers\/([^/]+)$/, name: "deleteComputer" },
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
  // The runs waiting and held, the live runners and their free slots, and the recent hand-backs (capacity.ts).
  { method: "GET", pattern: /^\/capacity$/, name: "getCapacity" },
  // A year of the work under this machine's home (wrapped.ts), on a server on the person's own machine alone.
  { method: "GET", pattern: /^\/wrapped$/, name: "getWrapped" },
  { method: "GET", pattern: /^\/settings\/tool-keys$/, name: "listToolKeys" },
  { method: "PUT", pattern: /^\/settings\/tool-keys\/([^/]+)$/, name: "saveToolKey" },
  { method: "DELETE", pattern: /^\/settings\/tool-keys\/([^/]+)$/, name: "deleteToolKey" },
  // The keys a plan-billed harness recipe runs on, saved for that harness alone (harness-keys.ts): the owner's session's.
  { method: "GET", pattern: /^\/settings\/harness-keys$/, name: "listHarnessKeys" },
  { method: "PUT", pattern: /^\/settings\/harness-keys\/([^/]+)\/([^/]+)$/, name: "saveHarnessKey" },
  { method: "DELETE", pattern: /^\/settings\/harness-keys\/([^/]+)\/([^/]+)$/, name: "deleteHarnessKey" },
  // The server's email account (email/routes.ts): the owner's session's alone, its password in no answer.
  { method: "GET", pattern: /^\/settings\/email$/, name: "getEmailAccount" },
  { method: "PUT", pattern: /^\/settings\/email$/, name: "saveEmailAccount" },
  { method: "DELETE", pattern: /^\/settings\/email$/, name: "deleteEmailAccount" },
  { method: "POST", pattern: /^\/settings\/email\/test$/, name: "testEmailAccount" },
  // The server's calendar (calendar/routes.ts): the owner's session's alone, its address in no answer.
  { method: "GET", pattern: /^\/settings\/calendar$/, name: "getCalendar" },
  { method: "PUT", pattern: /^\/settings\/calendar$/, name: "saveCalendar" },
  { method: "DELETE", pattern: /^\/settings\/calendar$/, name: "deleteCalendar" },
  { method: "POST", pattern: /^\/settings\/calendar\/test$/, name: "testCalendar" },
  { method: "GET", pattern: /^\/settings\/chatgpt$/, name: "getChatGPTSignIn" },
  { method: "DELETE", pattern: /^\/settings\/chatgpt$/, name: "signOutChatGPT" },
  { method: "POST", pattern: /^\/settings\/chatgpt\/sign-in$/, name: "startChatGPTSignIn" },
  { method: "POST", pattern: /^\/settings\/chatgpt\/sign-in\/finish$/, name: "finishChatGPTSignIn" },
  // Claude Code's login on this machine (claude-login.ts): the owner's session's alone; 404 by name while switched off.
  { method: "GET", pattern: /^\/settings\/claude-login$/, name: "getClaudeLogin" },
  { method: "PUT", pattern: /^\/settings\/claude-login$/, name: "turnOnClaudeLogin" },
  { method: "DELETE", pattern: /^\/settings\/claude-login$/, name: "turnOffClaudeLogin" },
  { method: "POST", pattern: /^\/settings\/claude-login\/login$/, name: "startClaudeLogin" },
  // The model gateway saved in the console (model-gateway.ts): its save, removal and test the owner's session's alone.
  { method: "GET", pattern: /^\/settings\/model-gateway$/, name: "getModelGateway" },
  { method: "PUT", pattern: /^\/settings\/model-gateway$/, name: "saveModelGateway" },
  { method: "DELETE", pattern: /^\/settings\/model-gateway$/, name: "deleteModelGateway" },
  { method: "POST", pattern: /^\/settings\/model-gateway\/test$/, name: "testModelGateway" },
  { method: "GET", pattern: /^\/settings\/mcp-servers$/, name: "listMcpServers" },
  { method: "GET", pattern: /^\/settings\/mcp-server-names$/, name: "listMcpServerNames" },
  { method: "POST", pattern: /^\/settings\/mcp-servers\/preview$/, name: "previewMcpServer" },
  { method: "POST", pattern: /^\/settings\/mcp-servers\/composio\/tools$/, name: "listComposioTools" },
  { method: "GET", pattern: /^\/settings\/mcp-servers\/([^/]+)$/, name: "getMcpServer" },
  { method: "PUT", pattern: /^\/settings\/mcp-servers\/([^/]+)$/, name: "saveMcpServer" },
  { method: "PUT", pattern: /^\/settings\/mcp-servers\/([^/]+)\/composio$/, name: "saveComposioServer" },
  // A saved Composio server's triggers (composio-triggers.ts): its toolkit's events, its triggers and their state on
  // Composio, and the project's webhook subscription (its secret rotated, or the subscription deleted: secret writes).
  { method: "GET", pattern: /^\/settings\/mcp-servers\/([^/]+)\/composio\/events$/, name: "listComposioEvents" },
  { method: "GET", pattern: /^\/settings\/mcp-servers\/([^/]+)\/composio\/triggers$/, name: "listComposioTriggers" },
  { method: "POST", pattern: /^\/settings\/mcp-servers\/([^/]+)\/composio\/rotate-secret$/, name: "rotateComposioSecret" },
  { method: "DELETE", pattern: /^\/settings\/mcp-servers\/([^/]+)\/composio\/subscription$/, name: "deleteComposioSubscription" },
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
  { method: "POST", pattern: /^\/settings\/webhook\/secret$/, name: "rotateWebhookSecret" },
  { method: "POST", pattern: /^\/settings\/webhook\/test$/, name: "testWebhook" },
  { method: "GET", pattern: /^\/settings\/webhook\/deliveries$/, name: "listWebhookDeliveries" },
  { method: "POST", pattern: /^\/settings\/webhook\/deliveries\/([^/]+)\/redeliver$/, name: "redeliverWebhook" },
  { method: "GET", pattern: /^\/settings\/slack$/, name: "getSlack" },
  { method: "PUT", pattern: /^\/settings\/slack$/, name: "saveSlack" },
  { method: "DELETE", pattern: /^\/settings\/slack$/, name: "deleteSlack" },
  { method: "POST", pattern: /^\/settings\/slack\/test$/, name: "testSlack" },
  { method: "GET", pattern: /^\/settings\/slack\/deliveries$/, name: "listSlackDeliveries" },
  { method: "POST", pattern: /^\/settings\/slack\/deliveries\/([^/]+)\/redeliver$/, name: "redeliverSlack" },
  { method: "GET", pattern: /^\/triggers$/, name: "listTriggers" },
  { method: "POST", pattern: /^\/triggers$/, name: "createTrigger" },
  { method: "GET", pattern: /^\/triggers\/([^/]+)$/, name: "getTrigger" },
  { method: "PATCH", pattern: /^\/triggers\/([^/]+)$/, name: "updateTrigger" },
  { method: "DELETE", pattern: /^\/triggers\/([^/]+)$/, name: "deleteTrigger" },
  { method: "POST", pattern: /^\/triggers\/([^/]+)\/fire$/, name: "fireTrigger" },
  { method: "GET", pattern: /^\/triggers\/([^/]+)\/firings$/, name: "listTriggerFirings" },
  { method: "POST", pattern: /^\/triggers\/([^/]+)\/firings\/([^/]+)\/release$/, name: "releaseTriggerFiring" },
  { method: "POST", pattern: /^\/triggers\/([^/]+)\/secret$/, name: "rotateTriggerSecret" },
  { method: "GET", pattern: /^\/templates$/, name: "listTemplates" },
  { method: "POST", pattern: /^\/templates\/import$/, name: "importTemplate" },
  { method: "GET", pattern: /^\/templates\/([^/]+)$/, name: "getTemplate" },
  { method: "DELETE", pattern: /^\/templates\/([^/]+)$/, name: "deleteTemplate" },
  { method: "POST", pattern: /^\/templates\/([^/]+)\/apply$/, name: "applyTemplate" },
  // Answered before the bearer check: the request's signature is its credential.
  // A source that keeps its key per scope (Composio's projects) is served at /hooks/{source}/{scope}.
  { method: "POST", pattern: /^\/hooks\/([^/]+)(?:\/([^/]+))?$/, name: "receiveHook" },
  { method: "GET", pattern: /^\/integrations\/github$/, name: "getGitHubConnection" },
  { method: "DELETE", pattern: /^\/integrations\/github$/, name: "disconnectGitHub" },
  { method: "POST", pattern: /^\/integrations\/github\/connect$/, name: "connectGitHub" },
  { method: "GET", pattern: /^\/integrations\/github\/callback$/, name: "gitHubCallback" },
  { method: "GET", pattern: /^\/integrations\/github\/installed$/, name: "gitHubInstalled" },
  { method: "GET", pattern: /^\/integrations\/github\/repositories$/, name: "listGitHubRepositories" },
  // Suggested agents (suggestions.ts): what the agent-scout template finds in a repository, and what a person decides.
  { method: "GET", pattern: /^\/suggestions$/, name: "listSuggestions" },
  { method: "POST", pattern: /^\/suggestions\/scans$/, name: "scanForSuggestions" },
  { method: "GET", pattern: /^\/suggestions\/([^/]+)$/, name: "getSuggestion" },
  { method: "POST", pattern: /^\/suggestions\/([^/]+)\/discard$/, name: "discardSuggestion" },
  { method: "POST", pattern: /^\/suggestions\/([^/]+)\/restore$/, name: "restoreSuggestion" },
  { method: "POST", pattern: /^\/suggestions\/([^/]+)\/create$/, name: "createSuggestedAgent" },
  // Answered before routing (mcp.ts), with the token only: listed here for the document.
  { method: "POST", pattern: /^\/mcp$/, name: "callMcp" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning$/, name: "getAgentLearning" },
  // The agent's learning reset, the agent and its runs kept (learning-reset.ts).
  { method: "DELETE", pattern: /^\/agents\/([^/]+)\/learning$/, name: "deleteAgentLearning" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/cost$/, name: "getLearningCost" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/promotions$/, name: "listLearningPromotions" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/audits$/, name: "listLearningAudits" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/loop$/, name: "getLearningLoop" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/log$/, name: "listLearningLog" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/corrections$/, name: "getLearningCorrections" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/learning\/corrections$/, name: "putLearningCorrections" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)$/, name: "readLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/retire$/, name: "retireLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/approve$/, name: "approveLearningFile" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/files\/([^/]+)\/restore$/, name: "restoreLearningFile" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/workflows\/([^/]+)\/revisions$/, name: "listLearnedWorkflowRevisions" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/learning\/workflows\/([^/]+)\/revisions\/([^/]+)\/replays$/, name: "startLearnedWorkflowReplay" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/learning\/workflows\/([^/]+)\/revisions\/([^/]+)\/replays\/([^/]+)$/, name: "getLearnedWorkflowReplay" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning$/, name: "getRunLearning" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/learning\/diff$/, name: "getRunLearningDiff" },
];

/** Where agent `agentId`'s host-owned path is read on this server: its route, when ROUTES has one (the learning API, for
 *  learning/); sign-ins/ only as the agent's `sign_ins`, never a pointer. */
/** A run's computer as GET /computer reads it with no viewer open: kind browser where its agent has the browser tool, its
 *  kept plane's (a run from before the plane names none, and is Browserbase's where it grants the tool) checked again as a
 *  launch would be; off, saying why, where it has none or its browser resolves unavailable here. Where the agent's
 *  computer is a browser, that browser, whose keys are the computer's (checked at the run's start), never the plane's.
 *  A run whose agent's computer is a sandbox (`own`, its revision's kind) and has no browser has a computer with no
 *  screen: off says so, never that its agent has none; its browser, where it has the tool, is its view, and why that
 *  browser is unavailable is said as for any run.
 *  TODO: the agent's own `computer: {kind, provider?}` setting once definitions carry it (desktop, phone). */
function computerOf(kept: KeptBrowser, env: NodeJS.ProcessEnv, family: LiveFamily = "computer", own?: string): ComputerOf {
  if (kept === ON_COMPUTER) return { kind: "browser" };
  const browser = kept === undefined ? undefined : recheckPlane({ browser: kept }, env).browser;
  if (browser === undefined) return { off: family === "browser" ? "this run's agent has no browser tool" : own === "sandbox" ? SANDBOX_NO_SCREEN : "this run's agent has no computer" };
  return isUnavailable(browser) ? { off: whyUnavailable(browser) } : { kind: "browser" };
}

const SANDBOX_NO_SCREEN = "A sandbox has no screen: what the agent runs in it is on the timeline.";

/** The run's kept browser vendor, over the store, as computerOf reads it: the vendor its launch plane resolved at start
 *  (the same source the runner's claim reads), normalized to the vendor name (keptVendor) so recheckPlane re-resolves it as
 *  a vendor, not a stored no-key sentinel; with no browser in the plane, the default vendor when the run's revision grants
 *  the browser tool, else none. A revision that grants the tool to an agent whose computer is a browser is ON_COMPUTER:
 *  the tool's sessions are that computer's (tools.ts browserComputer), whatever the plane says. */
async function keptBrowserOf(store: Store, runId: string): Promise<KeptBrowser> {
  const runRow = await store.runs.get(runId);
  const revision = runRow ? await store.agents.revision(runRow.revisionId) : undefined;
  const body = revision?.body as { tools?: readonly string[]; computer?: { kind?: string } } | undefined;
  const granted = (body?.tools ?? []).includes("browser");
  if (granted && body?.computer?.kind === "browser") return ON_COMPUTER;
  const row = await store.runs.launch(runId).catch(() => undefined);
  const plane = row ? readLaunchBody(row.body)?.plane : undefined;
  const kept = plane ? keptVendor(plane).browser : undefined;
  if (kept !== undefined) return kept;
  return granted ? "browserbase" : undefined;
}

/** keptBrowserOf's answer for a run whose browser is its agent's browser computer. */
const ON_COMPUTER = Symbol("the agent's browser computer");
type KeptBrowser = Plane["browser"] | typeof ON_COMPUTER;

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

/** The model gateway's variables, which a gateway saved in the console sets (model-gateway.ts withSavedGateway): which
 *  harnesses run, and on what, follow them. */
const GATEWAY_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG"] as const;

/** What of `env` a write can change that the harnesses' offers are made from: each secret but the tool keys' fields (a
 *  saved key is one of those; the rest of the environment is the server's start's), and the models the Ollama here
 *  listed when last asked (ollamaListing). Held to tell whether a write, or a new listing, needs the offers probed again,
 *  never shown. */
const offersInputs = (env: NodeJS.ProcessEnv): readonly (string | undefined)[] => [...SECRET_NAMES.filter((name) => !TOOL_FIELDS.includes(name)).map((name) => env[name]), ...GATEWAY_VARS.map((name) => env[name]), planOf(env)?.state, planOf(env)?.models.join(" "), claudeLoginOf(env)?.dir, ollamaListing(env)];

/** A sign-in step's answer; its refusal (a stale or bad pasted address, no sign-in waiting, OpenAI's no) a 400 in words. */
async function planStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof PlanSignInRefused) throw new ApiError("bad_request", error.message);
    throw error;
  }
}

/** What a revision that names no model needs here (capabilities' `models.needs`): null when one runs, else chooseModel's
 *  `needs`, a provider's key or another model; and whether that model has a price here (`models.priced`: unpricedModels,
 *  a gateway id serve has no price for), which a run's spend cap needs: null with no model, as nothing is there to price.
 *  Made from `env` alone, so it is remade only when env is. */
type ModelState = { needs: ModelNeeds | null; priced: boolean | null; learning_model: LearningModel };
async function needsOf(env: NodeJS.ProcessEnv): Promise<ModelState> {
  // A reading no run waits on, as the offers are (ollamaReading): a key's save never waits on a stuck Ollama's /api/show.
  return ollamaReading(async () => {
    const chosen = await chooseModel(env, undefined);
    const learning_model = await learningModelOf(env);
    if ("why" in chosen) return { needs: chosen.needs, priced: null, learning_model };
    return { needs: null, priced: (await unpricedModels(env, undefined)).length === 0, learning_model };
  });
}

/** The server's reading of `base`, whole: its secrets, saved keys among them (`env`), the harnesses' offers, probed from
 *  env without the tool keys (offersEnvOf), and its capabilities made from both under its learning switch (`learning`,
 *  AGENTRUN_SERVE_LEARNING's when not given), its tool settings (`toolSettings`, what each web tool resolves to) and the
 *  box offers (`boxes`, what the server found at the start, place-offers.ts), with whether a revision that names no
 *  model runs (needsOf). The server makes it once at its start and then remakes only the parts a write changes
 *  (startHolding), so a key saved later can make a harness, a provider or the default model available with no restart. */
export async function readingOf(base: NodeJS.ProcessEnv, maxRuns: number, stored?: StoredKeys, learning?: LearningMode, toolSettings: ToolSettingsMap = {}, boxes: readonly BoxOffer[] = []) {
  const env = withSecrets(base, "all", stored);
  const offers = await harnessOffers(offersEnvOf(env));
  return { env, offers, caps: capabilitiesWith(env, maxRuns, offers, learning ?? learningOf(env), await needsOf(env), toolSettings, boxes) };
}

/** The capabilities document GET /v2/capabilities answers for `env`: each harness's offer resolved, its `default_model`
 *  included (harnessOffers), and whether a revision that names no model runs here (`models.ready`, and what it `needs`
 *  when not), so what this returns is what the route serves and what the document's schema holds.
 *  `learning` is the server's learning switch (`--learning`), AGENTRUN_SERVE_LEARNING's when not given; with this
 *  server's tool settings, what each web tool resolves to (tool-plane.ts); `boxes`, the box offers its places show. */

export async function capabilities(env: NodeJS.ProcessEnv = withSecrets(process.env), maxRuns = maxRunsOf(env), learning: LearningMode = learningOf(env), toolSettings: ToolSettingsMap = {}, boxes: readonly BoxOffer[] = []) {
  return capabilitiesWith(env, maxRuns, await harnessOffers(env), learning, await needsOf(env), toolSettings, boxes);
}

/** A run body's launch secrets, checked (handedLaunchSecrets): its MCP credentials, its own model key and tool keys. */
type Handed = { mcp?: RunMcpAuth; model?: string; keys?: RunKeys };

/** The start-time switches a server takes as options (ServeOptions mcpLoopback, webhookPrivateTargets). */
type SwitchedOn = { mcpLoopback: boolean; webhookPrivateTargets: boolean };
/** Those switches as `env` sets them, the CLI's way, for a server whose options name neither. */
const switchedOnBy = (env: NodeJS.ProcessEnv, options: { mcpLoopback?: boolean; webhookPrivateTargets?: boolean } = {}): SwitchedOn => ({
  mcpLoopback: options.mcpLoopback ?? env[MCP_ALLOW_LOOPBACK_ENV] === "1",
  webhookPrivateTargets: options.webhookPrivateTargets ?? env[WEBHOOK_PRIVATE_TARGETS_ENV] === "1",
});

/** capabilities.learning: whether the caller may approve a workflow draft that waits, and what that needs when not. */
type LearningCaps = { pending: true; approve: boolean; approve_needs?: "password" };

/** The capabilities document as `req`'s caller reads it: approving takes the owner's password session alone, so only
 *  that caller reads `approve: true`; every other (a token, a run, accounts off) reads `approve_needs: "password"`. */
export function forCaller<T extends { learning: LearningCaps }>(caps: T, ownerSession: boolean): T {
  return ownerSession ? { ...caps, learning: { pending: caps.learning.pending, approve: true } } : caps;
}

/** The capabilities document from offers already resolved, under the server's learning switch, tool settings and box
 *  offers: cheap, made again after each key or tool-settings write with the offers the server holds; and `needs` as
 *  needsOf says it for a revision that names no model (null when it runs). `runnerShell`: the sandbox-only tools a run
 *  on the runner has a shell for here (tools.ts shellTools; bash in Mode 2), available with no box. `switched`: the two
 *  start-time switches the server takes as options (switchedOnBy reads them from `env`, as the CLI sets them). */
function capabilitiesWith(env: NodeJS.ProcessEnv, maxRuns: number, harnesses: HarnessCapability[], learning: LearningMode, { needs, priced, learning_model }: ModelState, toolSettings: ToolSettingsMap, boxes: readonly BoxOffer[], refused: Readonly<Record<string, string>> = {}, runnerShell?: ReadonlySet<string>, isolation: "uid" | "process" = "process", switched: SwitchedOn = switchedOnBy(env)) {
  const models = { ...modelSource(env), ready: needs === null, needs, priced };
  // Both limits apply: the cap on the count, and the memory each run reserves (host.ts).
  const memory = hostMemory();
  // The browser's key is its vendor's row: Kernel's where Kernel is picked or resolved (tool-plane.ts browserKeyRow).
  const keyFor = (tool: { name: string; provider?: string; resolves?: Record<string, string> }) => (tool.name === "browser" ? browserKeyRow(tool.provider, tool.resolves?.[DEFAULT_HARNESS]) : keyOf(tool.name));
  const tools = toolsView(env, toolSettings, noBoxReason(boxes), refused, runnerShell).map((tool) => (keyFor(tool) ? { ...tool, key: keyFor(tool) } : tool));
  const browser = tools.find((tool) => tool.name === "browser");
  return {
    backend: "local",
    contract: CONTRACT,
    server: { name: "@parcha/agentrun-serve", version: VERSION, platform: process.platform },
    /** What runs a run here (the contract's `runtimes`, informational): this server's runners, over its one store. */
    runtimes: ["runner"],
    /** How a run is kept from another here (run-child-host.ts runIsolationOf): each a process of its own, and `uid`, each
     *  a user of its own too. */
    run_isolation: isolation,
    /** The harnesses a revision may name (`definition.harness`), whether this server runs each, and how many at once. */
    // `keys`, what a model key would unlock, is the key rows' (listToolKeys), never served here. Served `available` is
    // whether a run of it can start now on some model it offers: one whose every model lacks a key or the sign-in
    // (noModelRuns: pi with neither) is not, though a save and a run read it as a harness that runs here (runnable.ts), so
    // their words name the model it lacks. One whose default lacks a key while another model runs is (its `needs` says
    // what the default lacks).
    harnesses: harnesses.map(({ keys: _keys, noModelRuns, ...offer }) => ({ ...offer, available: offer.available && !noModelRuns, max_concurrent_runs: Math.min(maxRuns, runsThatFit(offer.id, memory, env)) })),
    /** The places a revision may name (`definition.place`), this host's default, and whether this server has each box. */
    places: placesOf(boxes, boxAllowOf(env)),
    models,
    learning_model,
    /** `pending`: a workflow draft with a call no price covers is kept to wait for its owner's OK, served to no run;
     *  `approve`: whether the caller can approve one, which takes the owner's password session (forCaller), and
     *  `approve_needs` when not. */
    learning: { pending: true, approve: false, approve_needs: "password" } as LearningCaps,
    /** Every tool a revision may name (the closed table in tools.ts): available here, or the variables it is missing; a
     *  web tool, what it resolves to on each harness under this server's tool settings; `key`, the tool key that unlocks
     *  it (tool-keys.ts), when one does. */
    tools,
    /** The switches only the operator sets, in the server's environment at its start (start-switches.ts): each one's state,
     *  the value it read and what it allows. Never a secret's value. */
    switches: startSwitches(env, switched),
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
      files: { upload: true, read: true, range: true, during_run: true },
      quotes: false,
      usage: { basis: "estimate", meters: ["tokens", "tools", "browser_time", "learning"] },
      efforts: [...EFFORTS],
      thinking: [...THINKING_LEVELS],
      /** The browser a run's `browser` tool drives: the vendor it resolves to under the server's settings when the tool is
       *  available here (tools[]), a browser provider's id (tool-plane.ts BROWSER_VENDOR_IDS), else none. */
      browser: browser?.available ? ((resolved) => (BROWSER_VENDOR_IDS.includes(resolved ?? "") ? resolved! : "browserbase"))((browser as { resolves?: Record<string, string> }).resolves?.[DEFAULT_HARNESS]) : "none",
      /** A tool setting's `permission` (definition.tool_settings, /v2/settings/tools): allow, ask or deny, which the tool
       *  gate holds every tool call to (tool-gate.ts); an ask is answered at POST /runs/{id}/approvals/{approval_id}. */
      tool_permissions: true,
      /** The owner watches a run's browser live (GET /runs/{id}/browser, and GET /runs/{id}/computer, browser-live.ts), takes
       *  it over from the viewer and hands it back, and answers the agent's ask for them (POST /runs/{id}/browser/hand-back,
       *  browser-person.ts). */
      browser_live: { read_only: false, take_over: true, ask: true },
      /** An agent's browser stays signed in between its runs (sign-ins-store.ts), each pointer sealed under the server's seal
       *  key: with a browser vendor here (Browserbase's or Kernel's; local Chrome keeps none). */
      sign_ins: tools.some((tool) => tool.name === "browser" && tool.available),
      vault: false,
      query: false,
      /** GET, PUT and DELETE /settings/tool-keys: a tool's key saved by name, kept sealed under the server's seal key
       *  (tool-keys-store.ts), never in the clear. */
      tool_keys: { routes: true, at_rest: "sealed" },
      /** GET /settings/harness-keys and PUT/DELETE of one key: a plan-billed recipe's keys, saved for that harness alone
       *  (harness-keys.ts); `harnesses` its ids here, so the console offers the page only where there is one. */
      harness_keys: { routes: true, at_rest: "sealed", harnesses: planRecipesOf(env).map((recipe) => recipe.id) },
      /** /settings/mcp-servers: remote MCP servers previewed and saved, each credential sealed under the server's seal key,
       *  which always exists (seal-key.ts), so MCP credentials are always kept sealed. Every harness of the table runs a
       *  grant (runnable.ts takes one on any), a module's among them. */
      mcp_client: { transports: ["streamable-http"], auth: [...MCP_AUTH_TYPES], at_rest: "sealed", harnesses: [...harnessIds(env)] },
      /** This server's learning switch (`--learning`): on, a run learns when its agent says `learning: true`; off, none does. */
      learning,
      /** /settings/webhook: one URL POSTed, signed by the Standard Webhooks spec, when a run needs its person and when it
       *  ends (webhooks.ts); its secret kept sealed under the same seal key. */
      // Always sealed: the server starts with its seal key (seal-key.ts bootSealKey), so nothing is kept in the clear.
      webhooks: { routes: true, events: [...WEBHOOK_EVENTS], signing: "standard-webhooks/v1", at_rest: "sealed" },
      /** /settings/slack: one Slack incoming-webhook URL each of `events` is posted to as a readable message (slack.ts); the
       *  URL kept sealed, never shown. */
      slack: { routes: true, events: [...SLACK_EVENTS], at_rest: "sealed" },
      /** /triggers: what starts an agent's capped runs with no caller (triggers.ts). */
      /** A backend SDK run's start (sdk/runs.ts): the fields it takes, and the most seconds it stays open. */
      sdk_runs: { started_at: true, title: true, labels: true, max_open_s: SDK_MAX_OPEN_MS / 1000 },
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
      // The most requests on free models a run makes (AGENTRUN_FREE_MODEL_REQUESTS, else 60): each costs $0, so the
      // dollar cap cannot stop them, and this does (the kernel cap's free.ts). ChatGPT-plan requests don't count.
      free_model_requests: freeModelRequestsOf(env),
    },
  };
}

function cursorOf(value: string | null): number {
  if (value === null) return 0;
  const offset = Number(Buffer.from(value, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError("bad_request", "cursor is not one this server gave");
  return offset;
}
/** How many runs still going whose listing is behind a status-filtered list reads at once before it builds them all and
 *  reads its page (runsPage). */
const UNLISTED_AT_ONCE = 50;
/** Most builds of one run's listing a list makes when writes keep moving its mark (runsPage listNow). */
const LIST_TRIES = 3;
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

/** A start with --harness-sign-in on a server that is not one owner's own, on their own machine. */
export const HARNESS_SIGN_IN_NOT_LOCAL = "HARNESS_SIGN_IN_NOT_LOCAL";

/** Why `options` on `data` is not one owner's own server on their own machine, each reason in words; none when it is. One
 *  owner's own: it listens on loopback alone, with no public address; its store is the SQLite one in its data directory (no
 *  AGENTRUN_STORE_URL, which servers elsewhere share); its runs run beside it as its own user (`ownUser`:
 *  runIsolationOf's `process`), never under --no-runner or a user of their own; and one person starts them, as Claude
 *  Code's login on this machine asks (claude-login.ts whyNotOneOwner): an owner, and one API token. What --harness-sign-in
 *  starts under (harnessSignInRefusal), and where the Ollama at this machine's default address is a model of the person
 *  who starts runs (ollama-provider.ts ollamaHostOf). */
export function whyNotOwnMachine(options: Pick<ServeOptions, "host" | "publicUrl" | "runnerApart" | "apiOnly" | "token" | "tokens">, data: string, ownUser: boolean): string[] {
  const host = options.host ?? DEFAULT_HOST;
  // Every token the server takes (acceptedTokens): AGENTRUN_TOKEN's as `default` beside the list's, or else DIR/.token's alone.
  const tokens = (options.token === undefined ? 0 : 1) + (options.tokens?.length ?? 0);
  return [
    ...(loopback(host) ? [] : [`listens on ${host}, past loopback`]),
    ...(options.publicUrl ? [`has a public address (${options.publicUrl})`] : []),
    ...(options.apiOnly ? ["has no owner (the API-only profile), so anyone with its token starts runs"] : []),
    ...(tokens > 1 ? [`takes ${tokens} API tokens (AGENTRUN_TOKEN and AGENTRUN_TOKENS together), so more than one person starts runs`] : []),
    ...(storeTarget(data).kind === "sqlite" ? [] : ["keeps its store in Postgres (AGENTRUN_STORE_URL), which servers elsewhere share"]),
    ...(options.runnerApart ? ["runs no runner beside it (--no-runner)"] : []),
    ...(ownUser ? [] : ["runs each run as a user of its own (unset AGENTRUN_RUN_USER=slot, or set AGENTRUN_RUN_USER=same)"]),
  ];
}

/** Why `options` on `data` may not run a recipe on its owner's own sign-in (--harness-sign-in), in words; undefined when
 *  it may: one owner's own server on their own machine alone (whyNotOwnMachine). A check, a schedule and a shared server
 *  run on a key (HARNESS.md#sign-in). */
export function harnessSignInRefusal(options: Pick<ServeOptions, "host" | "publicUrl" | "runnerApart" | "apiOnly" | "token" | "tokens">, data: string, ownUser: boolean): string | undefined {
  const why = whyNotOwnMachine(options, data, ownUser);
  return why.length ? `${HARNESS_SIGN_IN_NOT_LOCAL}: --harness-sign-in runs a recipe on its owner's own sign-in on one owner's own machine alone, and this server ${why.join("; ")}. Start it without --harness-sign-in: its plan-billed recipes run on keys.` : undefined;
}

// A data directory an earlier version wrote (old agent homes, an old runs/ layout, or an earlier store version) is refused
// by the store itself when it opens (StoreFromEarlierVersion), in words, to start fresh: no pre-open scan, no migration.

export async function startServe(options: ServeOptions): Promise<Serve> {
  // API-only: no console, so no owner to sign in to it (and no setup code printed for a page that is refused).
  if (options.apiOnly) options = { ...options, accounts: false, openSetup: false };
  // A harness table module is the server's to name, from `harnessTable` alone, for itself and its runs: one in its own
  // environment (an operator's export, a leftover) never loads, wherever the server reads its environment.
  delete process.env[HARNESS_TABLE_ENV];
  // So is the harness modules list, from `harnessModules` alone (an operator names them with --harness-module or
  // AGENTRUN_SERVE_HARNESS_MODULES, which the CLI reads into the option).
  delete process.env[HARNESS_MODULES_ENV];
  // And the recipes, from `harnessRecipes` alone (--harness-recipe or AGENTRUN_SERVE_HARNESS_RECIPES).
  delete process.env[HARNESS_RECIPES_ENV];
  await mkdir(resolve(options.data), { recursive: true, mode: 0o700 });
  // Canonical once, here: a computer's mount source below it must then be its own canonical path, through no link.
  const data = await realpath(resolve(options.data));
  const { runsAsOwnUser } = await import("./runner/run-child-host.js");
  const ownUser = runsAsOwnUser(process.env);
  if (options.harnessSignIn) {
    const refused = harnessSignInRefusal(options, data, ownUser);
    if (refused) throw new Error(refused);
  }
  // The Ollama this server asks, and its runner beside it: OLLAMA_HOST, else the default address on one owner's own machine
  // alone (ollamaHostOf). Read once, at the start: a refused one is said once, here, in the base rule's words.
  const ollamaHost = ollamaHostOf(process.env, whyNotOwnMachine(options, data, ownUser).length === 0);
  const tokenRefused = options.token === undefined ? undefined : tokenProblem(options.token);
  if (tokenRefused) throw new Error(tokenRefused);
  for (const entry of options.tokens ?? []) {
    const refused = tokenProblem(entry.token, `the API token ${entry.id}`);
    if (refused) throw new Error(refused);
  }
  // Ids each once, secrets each once (api-token.ts), checked before any lock is taken.
  if (options.token !== undefined || (options.tokens?.length ?? 0) > 0) acceptedTokens(options.token, options.tokens);
  if (options.drainTimeout !== undefined && durationMs(options.drainTimeout) === undefined) throw new Error(`the drain timeout ${options.drainTimeout} is not a duration such as 8s`);
  enabledBoxes(process.env);
  // A Docker computer's size an operator sets (workspace/computer-deps.ts): a value the Docker provider refuses stops the
  // start, in its words.
  dockerLimitsOf(process.env);
  // The Docker host's addresses an operator names (workspace/computer-deps.ts): a bad entry stops the start, in words.
  dockerHostAddressesOf(process.env);
  // The Archil settings an operator sets (archil-settings.ts ARCHIL_SETTINGS_ENV): one of the region and S3 URL without the
  // other, or a value the PUT would refuse, stops the start, in words naming each variable.
  archilSettingsFromEnv(process.env);
  const boxAllow = boxAllowOf(process.env);
  const maxRuns = maxRunsOf(process.env, options.maxRuns);
  const learning = learningOf(process.env, options.learning);
  // A limit on a run's requests on free models that is no whole number above 0 stops the start, naming its variable.
  freeModelRequestsOf(process.env);
  const minFreeMib = minFreeMibOf(process.env);
  if (minFreeMib === undefined) throw new Error("AGENTRUN_MIN_FREE_MB is a number of MiB, 0 or more");
  const minFreeBytes = options.minFreeBytes ?? minFreeMib * 2 ** 20;
  // The template packages, each checked whole (templates.ts readPackage): a broken one stops the start.
  const templates = readPackages(options.templates);
  // One server per data root: the store's owner lock (StoreOwned), then the data root's own (server-lock.ts), both taken
  // when startHolding opens the store; a data directory an earlier version wrote is refused there too
  // (StoreFromEarlierVersion), in words, to start fresh. No oldHomes/oldLayout checks, no migration.
  // What a start that fails stops: the webhook deliveries it began, which would write the next server's outbox, and the
  // store handle it opened.
  const stops: Array<() => Promise<void>> = [];
  try {
    return await startHolding(options, data, { maxRuns, minFreeBytes, learning, boxAllow, templates, ollamaHost }, stops);
  } catch (error) {
    for (const stop of stops) await stop().catch(() => undefined);
    throw error;
  }
}

/** How much longer than its drain timeout a start waits for the server it replaces (a redeploy, a restart that starts the
 *  new server before the old one has exited): the old one's close, after its runs' drain. */
const START_WAIT_MARGIN_MS = 30_000;

/** `take()`, tried again every 250 ms while `held(error)` says the server this one replaces still holds what it takes, up
 *  to `until` (epoch ms); `waiting` is told this wait's `until` once, as it begins. Past `until`, or on any other error,
 *  it throws. */
async function whileReplaced<T>(take: () => Promise<T> | T, held: (error: unknown) => boolean, until: number, waiting: (until: number) => void): Promise<T> {
  let told = false;
  for (;;) {
    try {
      return await take();
    } catch (error) {
      if (!held(error) || Date.now() >= until) throw error;
      if (!told) (told = true), waiting(until);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function startHolding(options: ServeOptions, data: string, checked: { maxRuns: number; minFreeBytes: number; learning: LearningMode; boxAllow: readonly string[] | "none"; templates: Package[]; ollamaHost: string | undefined }, stops: Array<() => Promise<void>>): Promise<Serve> {
  const { maxRuns, minFreeBytes, learning, boxAllow, templates, ollamaHost } = checked;
  /** What an agent's view says of its learning: how many learned items wait for its owner's OK, for an agent that learns
   *  on this server (learning on, its current revision `learning: true`); none for another, or when the count cannot be
   *  read (the view never fails for it). */
  const learningOfAgent = async (entry: { agent: { id: string }; revision?: { kind: string; body: unknown } | null }): Promise<{ pending: number } | undefined> => {
    if (learning === "off" || entry.revision?.kind !== "agentic" || !learnsOf((entry.revision.body as { learning?: unknown }).learning)) return undefined;
    const pending = await pendingCount(data, entry.agent.id);
    return pending === undefined ? undefined : { pending };
  };
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
  const base = { ...withoutFaux(process.env), [DATA_ENV]: data, ...(options.allowCodeNodes ? { [CODE_NODES_ENV]: "1" } : {}), ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}), ...(options.harnessTable ? { [HARNESS_TABLE_ENV]: resolve(options.harnessTable) } : {}), ...harnessModulesEnv(options.harnessModules ?? [], data), ...harnessRecipesEnv(options.harnessRecipes ?? [], data, { signIn: options.harnessSignIn === true }) , ...(ollamaHost ? { OLLAMA_HOST: ollamaHost } : {}) };
  // A refused OLLAMA_HOST lists nothing (ollama-provider.ts baseOf): said once, at the start, in the base rule's words,
  // which never hold the value (a user or password in it stays unsaid).
  const ollamaRefused = ollamaHostRefused(base);
  if (ollamaRefused) log ? log(logLine("ollama_host_refused", { line: ollamaRefused })) : void process.stderr.write(`agentrun-serve: ${ollamaRefused}\n`);
  // The table, loaded once here: a harness module that is missing, names a built-in harness or gives half an entry refuses
  // the start, in words, before anything else opens.
  // The harness ids a definition may name here: the table's, the built-in ones and those the modules add, and one the
  // table hides until its owner installs it (tableIds: Goose), whose save warns with the command that installs it.
  const harnesses = tableIds(base);
  // The one store (module A), opened here as this data root's single owner, before the settings layers that read it: its
  // owner lock holds the store to this server (the data root's own lock follows), and it refuses a data directory an
  // earlier version wrote, in words, to start fresh (no oldHomes/oldLayout checks, no migration). Every agent, run, setting and sign-in is a row; the
  // server writes and reads rows, and a runner (its own process, sharing only this store) runs every run.
  // On Postgres when this process's AGENTRUN_STORE_URL secret names one (store/open.ts).
  // A server deploying while the old one still holds the schema waits for it (said once), never exits at once.
  // The server this one replaces may still be stopping (a redeploy, a restart that starts this one before the old one has
  // exited): its close comes after its runs' drain, so this start waits for as long as its own drain timeout and a
  // margin, saying so once, before it refuses. On Postgres the store's owner lock waits on its own (store/open.ts); on
  // SQLite the store file's owner lock is waited for here, and the data root's lock below on either.
  const replacedDrainMs = durationMs(options.drainTimeout ?? DRAIN_TIMEOUT) ?? 0;
  const replacedUntil = Date.now() + replacedDrainMs + START_WAIT_MARGIN_MS;
  const sayReplaced = noticeOf(options);
  let replacedTold = false;
  const waitingForReplaced = (until: number) => {
    if (replacedTold) return;
    replacedTold = true;
    sayReplaced(`another server holds this data root: waiting up to ${Math.max(1, Math.ceil((until - Date.now()) / 1000))} s for the previous server to stop`);
  };
  const onSqlite = storeTarget(data).kind === "sqlite";
  const store = await whileReplaced(() => openStore({
    dataDir: data, role: "server",
    warn: (message) => void process.stderr.write(`agentrun-serve: ${message}\n`),
    ...(options.onStoreLost ? { onOwnerLost: options.onStoreLost } : {}),
  }), (error) => onSqlite && error instanceof StoreOwned, replacedUntil, waitingForReplaced);
  let stopObservationRetention: () => Promise<void> = async () => undefined;
  stops.push(async () => { await stopObservationRetention(); await store.close(); });
  // The packages served: the bundled ones, read and checked before the start, and those imported here, which the store
  // keeps and are checked again as they load (template-import.ts). One that no longer checks is left out, said in the log.
  const registry = new TemplateRegistry(templates);
  await loadImported({ registry, store }, (id, why) => log?.(logLine("template_import_skipped", { template: id, why })));
  stopObservationRetention = await maintainObservations(new Observations(store), {
    onError: () => { process.stderr.write("agentrun-serve: observation retention failed; retrying on the next sweep\n"); },
  });
  // The person's own computers paired with this server (computer-attach.ts): their live sockets are this process's hub,
  // which the runner beside the server shares (Serve.attachHub), so one process holds them. A second server on this
  // store is refused above (its owner lock).
  const attachHub = new AttachHub();
  // The data root's own lock, once the store is held (so a deploy on Postgres waits at the store's owner lock first): the
  // store's lock holds one store, but the data root also holds what the server writes beside it (its token, its seal key,
  // uploads, harness installs, learning folders), which two servers on two stores (two Postgres schemas, or SQLite and
  // Postgres) would share. The lock is SQLite's EXCLUSIVE lock (server-lock.ts): the kernel drops it when its process
  // dies, so a crashed server never leaves it held.
  // Its wait runs from when the store was held at the earliest, since a store on Postgres may have been waited for first.
  const dataLock = await whileReplaced(() => takeServerLock(data), (error) => error instanceof ServerLockHeldError, Math.max(replacedUntil, Date.now() + START_WAIT_MARGIN_MS), waitingForReplaced);
  stops.push(async () => dataLock.release());
  // The token, once both locks are held: a start the locks refuse reads, makes and removes nothing in the data root.
  // Given a token list (AGENTRUN_TOKENS), DIR/.token is no token of this server's, as with AGENTRUN_TOKEN.
  const given = options.token !== undefined || (options.tokens?.length ?? 0) > 0;
  const tokenFile = given ? null : join(data, TOKEN_FILE);
  const stored = given ? undefined : await tokenIn(tokenFile!);
  // Every token this server takes, by id (api-token.ts): AGENTRUN_TOKEN's (or DIR/.token's) as `default`, then the list's.
  const tokens = acceptedTokens(options.token ?? stored?.token, options.tokens);
  const token = tokens[0]!.token;
  // Given a token (AGENTRUN_TOKEN or AGENTRUN_TOKENS), a .token an earlier start made holds one this server refuses: it goes, so nothing
  // (a person told the token is there, a CLI that reads it) takes a dead token from it. A later start without one makes a
  // new file and token.
  if (given) await rm(join(data, TOKEN_FILE), { force: true });
  // No start without a seal key (seal-key.ts), checked against the store before anything reads it: the one handed over,
  // else the one in the data directory beside the store, made at the first start with only its path printed. A store whose
  // secrets another key sealed is refused, in words, and no key is made over them. Every secret here is kept under it;
  // there is no keeping one in the clear.
  const seal = await bootSealKey(store, data);
  stops.push(async () => seal.release());
  // What a runner apart reads to tell its disk from this server's, and its environment's gaps (runner/disk-free.ts,
  // runner/runner-check.ts): this data root's id, and the names (never the values) of the run-facing environment this
  // server holds, each said in the store at every start, replacing the last start's.
  await recordDataRoot(store, data);
  // Harness modules and recipes this start was given as options (--harness-module, --harness-recipe) are said under the
  // setting a runner apart reads them from, as an exported setting is: a runner without them would claim their runs and
  // have no harness to run them on.
  const startedWith: Record<string, string | undefined> = {
    [HARNESS_MODULES_SETTING]: options.harnessModules?.length ? options.harnessModules.join(",") : undefined,
    [HARNESS_RECIPES_SETTING]: options.harnessRecipes?.length ? options.harnessRecipes.join(",") : undefined,
  };
  await recordRunEnv(store, runFacingNames((name) => startedWith[name] ?? secret(name) ?? (base as NodeJS.ProcessEnv)[name], Object.keys(base)));
  // Its runners on other hosts (AGENTRUN_RUNNER_HOSTS): a viewer's row naming one of their hosts is dialled there, with
  // the proxy's proof under the seal key (live-reach.ts); any other host is never dialled. A hosted machine a runner in a
  // process of its own made is relayed to that runner's attach listener the same way (dial-relay.ts).
  const reach = liveReachOf(process.env, seal.key);
  const attach = createAttachRoutes({
    store, hub: attachHub, machinesOnly: options.apiOnly === true, runnerApart: options.runnerApart === true,
    relay: { runners: store.runners, reach },
    ...(options.attachTiming ? { timing: options.attachTiming } : {}),
    log: (event, fields) => (log ? log(logLine(event, fields)) : void process.stderr.write(`agentrun-serve: ${logLine(event, fields)}\n`)),
  });
  // This server's own key on every environment it reads its secrets from, so a reader opens what this store holds with the
  // key checked against it, never another data directory's that this process booted too (secrets.ts holds one made key).
  const own = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => withSealKey(env, seal.text);
  // Which fields are the server's is read from what it is started with alone: handed the saved keys too, the tool keys would
  // call each the server's, and none could be deleted. The keys are sealed rows in the store; load() reads them once here.
  const toolKeys = toolKeysOverStore(store, own(withSecrets(base, "own")), (fields) => (log ? log(logLine("tool_keys", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("tool_keys", fields)}\n`)));
  await toolKeys.load();
  // The keys each plan-billed harness recipe this server names runs on, saved for that harness alone (harness-keys.ts):
  // sealed rows in the store, loaded once here and kept in step with every save, so its listing reads them at once.
  const harnessKeys = new HarnessKeysOverStore(store, seal.key, planRecipesOf(base), data);
  await harnessKeys.load();
  // A key's check as it is saved (key-check.ts) goes to its provider; under faux only to the tests' fake for that provider,
  // the one its runs are given (monid, Parallel, TypeSafe's Jev), never to the network: one with no fake is not checked.
  const fakes: Record<string, string | undefined> = { monid: options.fauxMonid, parallel: options.fauxParallel, typesafe: options.fauxJev, browserbase: options.fauxBrowserbase, kernel: options.fauxKernel };
  const checkFetch = async (id: string): Promise<typeof fetch | undefined> => {
    if (!options.faux) return fetch;
    const fake = fakes[id];
    return fake ? ((await import(pathToFileURL(resolve(fake)).href)) as { default: typeof fetch }).default : undefined;
  };
  // Aborted as close() begins: a key's check still waiting on its provider stops waiting, and its save stores nothing.
  // A start that fails aborts it too: what began on it (the host-address read's retry) stops with that start.
  const stopping = new AbortController();
  stops.push(async () => stopping.abort());
  /** The after-start seal by the events' schemas (composio-triggers.ts sealMarked), drained by stop. */
  let schemaSealed: Promise<unknown> = Promise.resolve();
  // The start's sweep of ended runs whose stored cost is unknown (cost-heal.ts), once this server listens; stop drains it.
  let costHealed: Promise<unknown> = Promise.resolve();
  let costHealStopped = false;
  // This server's saved keys, read by name: handed to its own reading and its own runs, never shared with another server.
  const storedKeys: StoredKeys = (name) => toolKeys.value(name);
  // A stored key that does not open is said once at the start, never a refusal to start.
  toolKeys.view();
  const mcpServers = mcpServersOverStore(store, own(withSecrets(base, "own")), VERSION);
  if (options.githubMcpOrigin) mcpServers.appOrigin = options.githubMcpOrigin;
  if (options.composioMcpOrigin) mcpServers.composioOrigin = options.composioMcpOrigin;
  mcpServers.standIns = options.mcpStandIns === true;
  // The saved MCP servers' metadata (their addresses and the tools they list), a snapshot the checks read in step (which
  // servers are saved, a workflow's grants, the template apply): the server is the one writer of these rows (a save,
  // refresh, sign-in or delete), so the snapshot is refreshed after each of those and reads what is saved now. An agent's
  // save lists its granted servers live and pins their tools on its revision (saveable, mcpListingOf); the runner reads
  // that pin and the credentials from the store at a run's claim (runner/mcp-claim.ts); this server hands a run no MCP
  // source. Each with what it is (its source and toolkit, mcp-sources.ts), which a template's apply maps its MCP needs on,
  // and the variable a Composio server saved with api_key_env reads its key from (`keyEnv`), which a run's start checks.
  let mcpMeta = new Map<string, { url: string; auth: string; tools: readonly McpTool[]; source: SourceRecord; keyEnv?: string }>();
  const refreshMcpMeta = async (): Promise<void> => {
    mcpMeta = new Map(await Promise.all((await listMcpServers(store)).map(async (row) => {
      const keyEnv = await mcpServers.keyEnvOf(row);
      return [row.name, { url: row.url, auth: row.auth, tools: (row.tools as McpTool[]) ?? [], source: await mcpServers.sourceOf(row), ...(keyEnv ? { keyEnv } : {}) }] as const;
    })));
  };
  await refreshMcpMeta();
  // Each saved server's tools in the harnesses' shape (the registry keeps input_schema; a bound tool takes inputSchema),
  // with whether each can be granted: a known meta tool can't (mcp-meta.ts).
  const mcpTools = (server: string) => {
    const saved = mcpMeta.get(server);
    return saved && marked(saved.url, { tools: saved.tools.map(boundTool) }).tools;
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
  // The ChatGPT sign-in, sealed in the store: on every reading of env (chatgpt-plan.ts withPlan), so a plan model runs
  // where it is signed in. A sign-in, a sign-out or an expiry it sees makes the reading again, as a key's save does.
  const plan = new ChatGPTPlan({ store, sealKey: seal.key, log: (fields) => (log ? log(logLine("chatgpt", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("chatgpt", fields)}\n`)), changed: () => keysChanged() });
  await plan.load();
  stops.push(async () => void plan.close());
  // Claude Code's login on this machine (claude-login.ts): env carries where it is while the owner has it on, so
  // claude-agent's model checks see a model without a key. Unset, its switch follows the listen address: there on
  // loopback, off past it. A setting kept where the mode is now off or refused goes first.
  const loginOff = claudeLoginSwitchedOff(base, options.host ?? DEFAULT_HOST);
  const loginRefused = whyNotOneOwner({ apiOnly: options.apiOnly === true, tokens: tokens.length });
  await dropRefusedLogin(store.settings, loginOff ?? loginRefused, (line) => (log ? log(logLine("claude_login", { line })) : void process.stderr.write(`agentrun-serve: ${line}\n`)));
  let claudeLogin = loginOf(await claudeLoginSetting(store.settings), data, base);
  // The model gateway saved in the console (model-gateway.ts), its key opened: laid over every reading of env, where the
  // environment names no gateway of its own. Read again at each save or removal (gatewayChanged).
  let savedGateway: SavedGateway | undefined = await readSavedGateway(store, seal.key);
  /** The server's environment as a reading of it sees it: its secrets and saved keys, the ChatGPT sign-in, Claude Code's
   *  login, and the saved model gateway. */
  const readEnv = (from: NodeJS.ProcessEnv): NodeJS.ProcessEnv => withSavedGateway(withClaudeLogin(withPlan(own(withSecrets(from, "all", storedKeys)), plan), claudeLogin), savedGateway);
  let env = readEnv(base);
  let offers!: HarnessCapability[];
  let caps!: ReturnType<typeof capabilitiesWith>;
  // Whether a revision that names no model runs (needsOf): made from env alone, so remade with it, before the caps.
  let needs: ModelState = await needsOf(env);
  // The box offers are probed once, below, before the first reading is made.
  // With accounts off no one can answer an ask (the answer route takes the owner's session alone): each tool ask is
  // offered for says it needs the password sign-in, as learning's approve does.
  const askNeeds = (made: ReturnType<typeof capabilitiesWith>) => (options.accounts ? made : { ...made, tools: made.tools.map((tool) => (tool.permissions.includes("ask") ? { ...tool, ask_needs: "password" as const } : tool)) });
  // How this host keeps runs apart, as its runners decide it from the same setting and helper: `uid` where the helper can
  // switch and AGENTRUN_RUN_USER is not `same`. A helper that cannot switch is a runner that refuses to start, in words
  // naming the setting; no run here is then a user of its own, so `process`. Imported here, as the runner beside it
  // imports it (runner/beside.ts): its module reaches the runner's, which reach back to this one's.
  const { runIsolationName, runIsolationOf } = await import("./runner/run-child-host.js");
  const isolation = await runIsolationOf(base, 1, () => {}).then(runIsolationName, () => "process" as const);
  // The start-time switches as this server was started: its options, else the CLI's variables. mcpLoopback is the
  // option alone, as everywhere it is read here (localInstall): the CLI sets it from AGENTRUN_MCP_ALLOW_LOOPBACK.
  const switched: SwitchedOn = { mcpLoopback: options.mcpLoopback === true, webhookPrivateTargets: switchedOnBy(process.env, options).webhookPrivateTargets };
  const compose = (runnerShell?: ReadonlySet<string>) => askNeeds(capabilitiesWith(env, maxRuns, offers, learning, needs, settings.get(), boxOffers, toolKeys.refused(), runnerShell, isolation, switched));
  const recompose = () => void (caps = compose());
  // What the offers held now were made from (offersInputs), and the latest probe: one a later probe overtook is dropped.
  let offersFrom: readonly (string | undefined)[] | undefined;
  let probes = 0;
  const probe = async (why: string) => {
    const mine = ++probes;
    // The Ollama listing the offers are made from is read before they are, so the first capabilities do not remake them.
    if (asksOllama(env)) await ollamaModels(env);
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
  // The runs' listings' builder (run-listing.ts): each run's listing, built from its view once per change, so a runs list
  // reads rows alone. A list builds a listing it finds behind through it too (runsPage). Its own passes start once this
  // server listens and knows its own address (ownOriginOf, below). Its items keep no console link (a list adds the one for
  // the address its request reached), so the origin here is never served.
  const lister = createLister(store, () => viewDepsFor(ownOriginOf()), {
    log: (what, error) => log?.(logLine(what, { error: error.message })),
    ...(options.listerIdleMs !== undefined ? { idleMs: options.listerIdleMs } : {}),
  });
  /** Whether the offers held now were made from `inputs` (offersInputs). */
  const offersMadeFrom = (inputs: readonly (string | undefined)[]): boolean => offersFrom !== undefined && inputs.length === offersFrom.length && inputs.every((value, i) => value === offersFrom![i]);
  const keysChanged = async () => {
    // A run's learning, view, list and timeline row are cut of the keys saved now by the run view at read time (it reads
    // serverSecrets live, store-view), and a list builds a listing cut of other keys again (builtOfNow). A failed run's error words
    // name a refused key by the keys and settings, so those listings are built again.
    await lister.keysChanged();
    env = readEnv(base);
    const mine = ++needsAsked;
    const next = await needsOf(env);
    if (mine === needsAsked) needs = next;
    if (offersMadeFrom(offersInputs(env))) recompose();
    else await probe("key");
  };
  /** The Ollama here, as capabilities read it: its listing asked again behind the answer once stale (ollamaModels), and
   *  the reading made again, as a key's save does, once a listing differs from the one the offers were made from. So a
   *  model pulled, or Ollama started after this server, shows in a later answer with no restart. */
  const ollamaNow = async () => {
    if (!asksOllama(env)) return;
    void ollamaModels(env);
    if (offersFrom && !offersMadeFrom(offersInputs(env))) await keysChanged();
  };
  /** After a harness key is saved or removed (harness-keys.ts): the listings built again, cut of it, and the offers probed
   *  again, as a recipe is offered once every key it runs on is saved here (harnessKeysSavedHere). No environment changes. */
  const harnessKeysChanged = async () => {
    await lister.keysChanged();
    await probe("harness-key");
  };
  /** After the model gateway is saved or removed in the console: the saved gateway read again, then env, as a key's save. */
  const gatewayChanged = async () => {
    savedGateway = await readSavedGateway(store, seal.key);
    await keysChanged();
  };
  /** The sign-in as the store holds it now (ChatGPTPlan.refresh): a change reads env again, and so does one this server
   *  failed to take (changed_failed), until it takes. */
  const planNow = () => plan.refresh();
  /** What Claude Code's login routes use: a turn on or off reads the setting again, then env, as a key's save does. A
   *  sign-in this server starts opens a browser on its machine, so only where the console is on loopback here; it is
   *  kept for this process (claude-sign-in.ts), and one still waiting is ended at the stop. */
  const claudeSignIns = new ClaudeSignIns({ limitMs: options.claudeSignInLimitMs });
  stops.push(async () => claudeSignIns.close());
  const loginDeps = (): ClaudeLoginDeps => ({
    signIns: claudeSignIns,
    settings: store.settings,
    data,
    env: base,
    pinned: async () => claudeCliIn(installDirOf(data, LOGIN_HARNESS), (await import("@parcha/agentrun-harness-claude")).claudeAgentPlatform()),
    refused: loginRefused,
    sameMachine: isLoopback(host) && !options.publicUrl,
    claude: () => import("@parcha/agentrun-harness-claude"),
    changed: async () => {
      claudeLogin = loginOf(await claudeLoginSetting(store.settings), data, base);
      await keysChanged();
    },
  });
  // The boxes a place may name, read once from the computers runs execute on (place-offers.ts): AGENTRUN_BOXES lists
  // them, docker alone when it is not set; docker by its probe, daytona and modal by their providers' keys, read as a
  // run's claim reads them. Under --faux, `fauxDocker` stands in for Docker's answer, and nothing asks Docker.
  const fauxDocker = Boolean(options.faux) && options.fauxDocker === true;
  // A faux server's probe is on a host, as its Docker paths are below, so a test reads the same words in a container;
  // `probeContainer` sets it for a test of a real one.
  const found = await placeOffers(env, { keyOf: keyReader(store, seal.key, env), fauxDocker, ...(options.probeContainer ? { container: options.probeContainer } : options.faux ? { container: { inside: false } } : {}) });
  const docker = found.some((offer) => offer.id === "docker" && offer.available);
  // Under --faux, the mountinfo a test gives (fauxMountinfo, or FAUX_MOUNTINFO_ENV in the process's own environment, which
  // `env` leaves out: a server under test in a container names its own /proc/self/mountinfo there); with none, a faux
  // server is on a host.
  const fauxMountinfo = options.faux ? (options.fauxMountinfo ?? process.env[FAUX_MOUNTINFO_ENV]) : undefined;
  // Where Docker has this server's files (box-paths.ts): its own, on a host; its container's mount of the data directory,
  // for a server in a container given Docker's socket; or none, and docker is unavailable, saying why. Under --faux, a
  // host's unless the test gives a container's mountinfo. Only on Linux: a container of a Docker's own is a Linux one.
  const dockerPaths: DockerPaths = fauxDocker || !docker || process.platform !== "linux" ? { here: true } : options.faux ? (fauxMountinfo ? await dockerPathsOf(env, data, { mountinfo: await readFile(fauxMountinfo, "utf8"), inContainer: true }) : { here: true }) : await dockerPathsOf(env, data);
  if ("reason" in dockerPaths) log?.(logLine("box_paths", { reason: dockerPaths.reason }));
  // A run's Docker computer mounts the run's folder, and the computer's daemon, by this server's paths: as they are on
  // its Docker's own host, or as its named data volume's subpaths from a container of that Docker's (compose.yaml).
  // Any other layout, or a daemon of another machine (DOCKER_HOST, or the current context's endpoint: box-paths.ts
  // remoteDockerOnce), can't run one, and says so here (dockerComputerRefusal), where capabilities, the run's start
  // (dockerAnswers) and a place's box check all read it: no run starts only to fail at its create.
  const dockerElsewhere = fauxDocker || !docker ? undefined : dockerComputerRefusal(dockerPaths, await remoteDockerOnce(env));
  // From a container, a Docker computer keeps this server's allow-list only knowing the Docker host's own addresses: the
  // union of the read through the socket and AGENTRUN_DOCKER_HOST_ADDRESSES (docker-host-addresses.ts), the same read the
  // runner beside this server takes. Said at the start with what was found; with none, Docker isn't offered, in words.
  // A read that failed with none known is read again in the background (retryHostAddresses) until one answers and the
  // helper containers the failed reads left are gone, or this server stops: the boxes are made again from the answer and
  // said again, so Docker is offered with no restart. Every reader of boxOffers reads it when it is called; capabilities
  // are composed again. One that failed with the operator's addresses known changes no box: the retry only removes the
  // containers it left. The close cuts a read in flight (its client killed) and stop() awaits the retry last, so the
  // read's container is removed within the stop's deadline (docker-host-addresses.ts REMOVE_MS).
  const boxesOf = (hostAddresses: { addresses: readonly string[]; why?: string } | undefined): BoxOffer[] => {
    if (hostAddresses) log?.(logLine("docker_host_addresses", { addresses: hostAddresses.addresses.join(",") || "none", ...(hostAddresses.why ? { read: hostAddresses.why } : {}) }));
    const dockerRefused = dockerElsewhere ?? (hostAddresses && hostAddresses.addresses.length === 0 ? noHostAddresses(hostAddresses.why ?? "the read through Docker's socket found none") : undefined);
    // Each box with what it reaches (place-offers.ts withNetworks).
    const offers = withNetworks(found, boxAllow, { ...(dockerRefused !== undefined ? { refused: dockerRefused } : {}), ...(hostAddresses ? { hostAddresses: hostAddresses.addresses } : {}), faux: fauxDocker });
    log?.(logLine("boxes", boxesLog(offers, enabledBoxes(env))));
    return offers;
  };
  const hostAddresses = dockerElsewhere === undefined && "paths" in dockerPaths && boxAllow !== "none" ? unionOf(await hostAddressesOnce(env), dockerHostAddressesOf(env)) : undefined;
  let boxOffers = boxesOf(hostAddresses);
  const hostRetried: Promise<void> =
    hostAddresses === undefined || hostAddresses.why === undefined
      ? Promise.resolve()
      : retryHostAddresses({
          env,
          ...(hostAddresses.addresses.length === 0
            ? {
                read: () => hostAddressesOnce(env, stopping.signal),
                found: (read: HostRead) => {
                  boxOffers = boxesOf(unionOf(read, dockerHostAddressesOf(env)));
                  // Capabilities are first composed at the start's probe, below; before it, there is nothing to compose again.
                  if (caps) recompose();
                },
              }
            : {}),
          signal: stopping.signal,
          ...(options.hostReadWait ? { wait: options.hostReadWait } : {}),
        }).catch(() => undefined);
  const adapters = options.triggerAdapters ?? TRIGGER_ADAPTERS;
  const openapi = openapiDocument((operationId) => ROUTES.find((r) => r.name === operationId)?.capability, adapters);
  const sealKey = seal.key;
  // SDK runs' credentials are signed with a key from the seal key, never an API token: a rotation leaves them working.
  const sdkSecret = sdkRunSecret(sealKey);
  // An API-only server's viewer credentials: viewer-credential.ts.
  const viewerKey = viewerCredentialKey(sealKey);
  // Each run's viewers are asked under that run's key (live-reach.ts reachForRun).
  const answers = (runId: string) => (handover: LiveHandover): Promise<boolean> => viewerAnswers(handover, reachForRun(reach, runId));
  // Settings → Computers and the owner's Archil settings, over the one store (computers.ts, archil-routes.ts), built once
  // at the first request, when the server's own address is known (--faux's desktop view is a page on it). The real kind
  // registry and each provider's create() are the computer package's (kinds.ts, providers.ts providerFor); under --faux,
  // faux-computers.ts's three providers stand in. The folder mode is read at each call (folderModeOf), so turning Archil
  // on or off needs no rebuild; a key named in the server's environment wins over a saved one.
  const browserToolNames = (await import("@parcha/pi-browser")).BROWSER_TOOLS.map((tool: { name: string }) => tool.name);
  const localTools = new Set(hostToolDefs({ maxExecS: 600, shell: "local" }).map((def) => def.name));
  const kindTools = (kind: ComputerKind): readonly string[] =>
    kind === "none" ? [] : kind === "sandbox" ? hostToolDefs({ maxExecS: 600, shell: "computer" }).map((def) => def.name).filter((name) => !localTools.has(name))
      : kind === "browser" ? browserToolNames : [...COMPUTER_TOOLS];
  let faux: FauxComputers | undefined;
  const fauxOf = (): FauxComputers => (faux ??= fauxComputers());
  /** Whether a computer on a provider that binds a folder of this machine (Docker) can be had here now: Settings →
   *  Computers' view and a run's start check (below) both ask it. Where AGENTRUN_BOXES lists Docker and it is no faux
   *  Docker, its daemon is asked (docker-daemon.ts: a short `docker version`, its answer kept a while and asked again, so a
   *  daemon that stops after the start is seen, and one that is gone says so in noDockerWords); once it answers, the
   *  box's start-time answer stands. A box the start did not make keeps its reason ("start Docker, then restart
   *  AgentRun"): the start's checks of Docker (Docker elsewhere, this server's paths, host addresses, its network) ran
   *  without it, so a daemon that answers later is not taken. Else the box's start-time answer (boxOffers), with its
   *  reason, which says how to fix it. The provider whose computers run on this machine's container engine is the one
   *  whose descriptor declares `local`. */
  const dockerDaemon = dockerDaemonCheck({ env });
  const dockerAnswers = async (provider: string): Promise<DockerDaemon> => {
    const box = boxAvailability(boxOffers).find((one) => one.id === provider);
    const local = COMPUTER_PROVIDERS.find((one) => one.id === provider)?.local === true;
    if (local && !fauxDocker && (enabledBoxes(env) as ReadonlySet<string>).has(provider)) {
      const daemon = await dockerDaemon();
      if (!daemon.up || box?.available) return daemon;
    } else if (box?.available) return { up: true };
    return { up: false, absent: false, reason: box?.reason ?? `${provider} is not a box this server has` };
  };
  let computerRoutes: ComputerRoutes | undefined;
  // The programs a provider runs on this machine (the phone's adb), looked for on PATH once, at the start, as the boxes
  // probe Docker: a provider whose program is missing is not ready, and its words say what to install.
  const hostWhy = hostCommandRefusals(COMPUTER_PROVIDERS, process.env.PATH);
  const computersOf = (): ComputerRoutes => (computerRoutes ??= createComputerRoutes({
    // A provider's key set where the server starts is one of its secrets, held off process.env (secrets.ts): read by name
    // from what the server was started with, as computerReady below reads it.
    store, sealKey, tools: kindTools, mode: folderModeOf(store, process.env), env: withSecrets(process.env, "own"),
    paired: { rows: () => store.pairedComputers.list(), viewOf: (row, serves) => pairedView(row, attachHub, serves, options.runnerApart === true) },
    runnerApart: options.runnerApart === true,
    // A runner in a process of its own that relays its dials (dial-relay.ts): one whose attach listener said it is there
    // within PRESENCE_STALE_MS on the store's clock (liveRelays), at a host this server dials.
    relayed: async () => (await liveRelays(store.runners)).some((row) => dialHost(row.host, reach) !== undefined),
    ...(options.faux
      // --faux's providers stand in for every vendor's, a local one's daemon included.
      ? { kinds: fauxOf().kinds, factories: fauxOf().factories, keyTable: fauxOf().keyTable }
      : {
        hostWhy,
        kinds: { SETTING_KINDS, PROVIDERS: COMPUTER_PROVIDERS, servingRefusals },
        // The one place serve builds a provider (workspace/computer-providers.ts), the claim's makers' own.
        factories: computerProviderFactories(computerProviderMakers(), (id) => storeLedger(store.computerLedger, id)),
        answers: dockerAnswers,
      }),
  }));
  /** Whether an agent's computer setting can be had here now, by the answers the runner's claim gives (resolve-computer.ts
   *  computerReadiness): over the registry the claim reads (workspace/computer-deps.ts claimKinds, asked with what the
   *  runner composes with: under --faux, faux's, as runner/main.ts runnerComputers gives its runs' faux; else the
   *  package's), in the folder mode of now, with keys read as the runner reads them (the secrets this process was started with, withSecrets "own", as
   *  runner/main.ts runEnv hands them; else the saved one). What runnable.ts checks for an agent with
   *  a computer setting, in place of the box check; whether Docker answers here is dockerAnswers', and whether a
   *  provider's program is on this machine is hostWhy's, read at the start. */
  /** The server's folder mode now: 2 when the owner's Archil settings are saved (the run's folder on the disk), else 1. */
  const modeNow = async (): Promise<1 | 2> => ((await folderModeOf(store, process.env)()) === "disk" ? 2 : 1);
  /** The registry a run's claim resolves against (claimKinds), as its runner composes it. */
  const claimRegistry = () => claimKinds(options.faux ? { faux: fauxOf() } : {});
  /** A key as the runner reads it: the secrets this process was started with (withSecrets "own"), else the saved one. */
  const runnerKeys = () => keyReader(store, sealKey, own(withSecrets(process.env, "own")));
  // A paired computer is one more provider of the registry (workspace/attached-computers.ts), ready while its driver is
  // attached to this process's hub.
  const computerReady = async (setting: { kind: string; provider?: string; image?: string; gpu?: { type: string; count: number } }) => {
    const paired = await store.pairedComputers.list();
    const row = paired.find((one) => one.id === setting.provider);
    const offline = row ? pairedRefusal(row, attachHub) : undefined;
    if (offline) return { refused: offline };
    return computerReadiness(setting, await modeNow(), withPaired(claimRegistry(), paired), runnerKeys(), dockerAnswers, boxAllow, (provider) => (Object.hasOwn(hostWhy, provider) ? hostWhy[provider] : undefined));
  };
  /** Where a run of an agent with computer `setting` has its shell here now (resolve-computer.ts runShellOf, in the
   *  folder mode of now, over the registry the claim reads): what runnable.ts lets a sandbox-only tool on the runner by,
   *  and capabilities show bash by. In Mode 2 a run with no computer has bash on Archil's serverless exec. */
  const shellOf = async (setting: { kind: string; provider?: string; image?: string }) =>
    runShellOf(setting, await modeNow(), await registryHere(setting.provider === undefined ? claimRegistry() : withPaired(claimRegistry(), await store.pairedComputers.list()), runnerKeys()));
  /** The shell this server can give a template's agent now (templates.ts pickComputer's `shell`), by the rules a run
   *  has it by (shellOf): Archil's serverless exec on the runner in Mode 2 (bash alone); else the box a new agent is saved
   *  with (Docker), where it answers now (computerReady asks the daemon, not the start's offers: a Docker stopped since
   *  is no shell), whose shell runs the shell tools; else none, and why. A package that needs programs (`sandbox`) asks
   *  for a sandbox alone, whose box a run checks for them: Archil's exec is none, so in Mode 2 it is told why no sandbox
   *  answers (the Docker box can't mount Archil's workspaces), never given the exec. */
  const shellHere = async (wants: { sandbox?: boolean } = {}): Promise<ShellHere> => {
    const exec = (await shellOf({ kind: "none" })) === "local";
    if (exec && !wants.sandbox) return { computer: { kind: "none" }, tools: [...shellTools("local")], words: "Archil's serverless exec" };
    const fresh = newAgentPlace(boxOffers);
    let why = "why" in fresh ? fresh.why : "it is not set up";
    if ("place" in fresh && fresh.place.mode === "sandbox") {
      const computer = { kind: "sandbox", provider: fresh.place.box };
      const ready = await computerReady(computer);
      if ("refused" in ready) why = ready.refused;
      else if ((await shellOf(computer)) === "computer") return { computer, tools: [...shellTools("computer")], words: `the ${fresh.place.box} sandbox` };
    }
    if (exec) return { none: `no sandbox answers here: Archil's serverless exec is no sandbox, and the docker box is unavailable here (${why})` };
    return { none: `this server has no shell to give an agent now: Archil is off (Settings → Workspace), and the docker box is unavailable here (${why})` };
  };
  /** Each package's computer list read against this server now, as a listing shows it (`computer_here`): what an apply
   *  here would pick (pickComputer), the shell asked for once for them all. */
  const computerHere = async (packages: readonly Package[]) => {
    const here = packages.some((one) => one.computer && !one.needs) ? await shellHere() : undefined;
    const sandbox = packages.some((one) => one.computer && one.needs) ? await shellHere({ sandbox: true }) : undefined;
    return (pkg: Package) => {
      const shell = pkg.needs ? sandbox : here;
      const pick = shell && pickComputer(pkg, shell);
      if (!pick) return null;
      if ("refused" in pick) return { entry: null, computer: null, shell: null, dropped: [], note: pick.refused };
      return { entry: pick.entry, computer: pick.computer, shell: pick.shell, dropped: pick.dropped, note: pick.note };
    };
  };
  // ARCHIL_API_KEY set where the server starts is one of its secrets, held off process.env (secrets.ts): read by name.
  const archil = createArchilRoutes({ store, sealKey, env: withSecrets(process.env, "own"), ...(options.archilControl ? { control: options.archilControl } : {}) });
  /** Where a run of `revision` has its shell (shellOf): its computer setting as the claim reads it (computer-for-claim.ts
   *  settingOf), else its place's computer, else the place its run would resolve to (fallbackPlace). The agent's tool
   *  list reads it, so a tool of bash's family the run would not have shows unavailable (tool-plane.ts shellUnavailable). */
  const shellOfRevision = async (revision: Revision): Promise<ShellPlace> => {
    const body = revision.body as { computer?: ComputerSetting; place?: Place; tools?: readonly unknown[] };
    return shellOf(settingOfDefinition(body)?.computer ?? computerOfPlace(fallbackPlace(revision.kind, revision.kind === "agentic" ? (body.tools ?? []) : [])));
  };
  /** The run read's costs (A8, store-reads/learning.ts runAllInOverStore): `cost.usd` its own spend, the
   *  job's (its compile turn is learning's), null while unknown; what learning spent for it
   *  (`learning_usd`) and the two (`all_in_usd`). A cost known only as a bound keeps its bound, and all-in is unknown.
   *  `tools_usd`: the part of `usd` its paid tool calls cost (store-view.ts toolsUsdOverStore). */
  const allInViewOf = async (runId: string, view: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const cost = (view.cost ?? {}) as { usd?: unknown; upper_bound?: unknown };
    const own = typeof cost.usd === "number" && cost.upper_bound !== true ? cost.usd : null;
    // A purge gate that can't be asked (its store read of a writer's row fails) leaves this read without its answer, never
    // a 500: the revision ledger its `learning_usd` and `all_in_usd` share is read from takes the champion with no record
    // skipped (as before the purge), so a revision a purged run wrote may be the one it counts as serving, for this read
    // alone. Figures only: no text is read or shown. Every write that asks the gate still fails closed (decideCheck
    // throws, so no promote lands; recordPromotion trims nothing). Such a read says so: `cost.degraded`.
    let degraded = false;
    const all = await runAllInOverStore(store, runId, own, (agentId, records) => refusedFor(agentId, records).catch((error: unknown): Refused => {
      degraded = true;
      const line = `learning: run ${runId}: its costs were read without the purge gate's answer: ${error instanceof Error ? error.message : String(error)}`;
      if (log) log(logLine("learning", { line }));
      else process.stderr.write(`agentrun-serve: ${line}\n`);
      return Object.assign(() => false, { unread: true });
    }));
    if (!all) return {};
    // A bound stays the view's bound. Otherwise usd is the job's (runCostOf's cost_usd, the same figure the cost series
    // gives): known as it answered even when its compile turn's cost is not; the row's while the run is at work.
    return { cost: { ...cost, ...(cost.upper_bound === true ? {} : { usd: all.usd }), tools_usd: await toolsUsdOverStore(store, runId), learning_usd: all.learning_usd, all_in_usd: all.all_in_usd, ...(degraded ? { degraded: true } : {}) } };
  };
  // The agents accessor the routes call, over the one store (module A): the agents-store functions, with the run-row reads
  // the server makes (store-reads) under `.store`. `.request` is a thin pass-through — the store runs its own transactions,
  // so a call needs no outer serialization. The old Agents class and its per-agent home store are gone.
  const ctx = BACKGROUND_CONTEXT;
  const agents = {
    get: (id: string) => getAgent(store, id),
    list: (options: { archived?: boolean } = {}) => listAgents(store, options),
    create: (body: DefinitionBody, check?: SaveCheck, fresh?: { place: RevisionPlace; tools: readonly string[] }, template?: TemplatePackage) =>
      createAgent(store, body, { ...(check ? { check } : {}), ...(fresh ? { fresh } : {}), ...(template ? { template } : {}) }),
    commit: (entry: AgentEntry, body: DefinitionBody, options: { ifCurrent?: string | null; check?: SaveCheck; prepare?: SavePrepare; contract?: boolean; template?: TemplatePackage; fromPackage?: boolean; inTurn?: InTurn } = {}) => commitAgent(store, entry, body, options),
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
  secretStores.add("server", () => tokens.map((entry) => entry.token));
  // The model gateway's key saved in the console (model-gateway.ts): cut from everything shown, as every saved key is.
  secretStores.add("model-gateway", () => (savedGateway?.key ? [savedGateway.key] : []));
  // Each harness key saved, and each replaced or removed one still kept sealed (harness-keys.ts RETIRED_KEPT): a timeline
  // written while one was live stays cut after it changes.
  secretStores.add("harness-keys", () => harnessKeys.values());
  // The email account's password (email/account.ts), and each one saved since this server started: cut from everything
  // it shows, so a tool's error or a model's text that ever echoed it shows it nowhere.
  const emailPasswords = new Set<string>();
  const heldEmailPassword = async () => {
    const password = (await openAccount(store, sealKey).catch(() => undefined))?.password;
    if (password) emailPasswords.add(password);
  };
  await heldEmailPassword();
  secretStores.add("email", () => [...emailPasswords]);
  // The calendar's iCal address (calendar/address.ts), in each of its forms, and each one saved since this server started:
  // the address reads the calendar, so it is cut from everything the server shows, as a password is.
  const calendarAddresses = new Set<string>();
  const heldCalendar = async () => {
    const url = (await openCalendar(store, sealKey).catch(() => undefined))?.url;
    if (url) for (const form of addressForms(url)) calendarAddresses.add(form);
  };
  await heldCalendar();
  secretStores.add("calendar", () => [...calendarAddresses]);
  // Each agent's saved sign-ins, over the one store (module A, sign-ins-store): the vendor's calls on the server's keys
  // (under faux, the vendor's fake alone), under this server's seal key. The store holds whether a sign-in is still held
  // (a live run's sign_in_handed) and who was handed it, so this takes no `holds`/`handedTo` callback — one store, one lock.
  const signIns = signInsOverStore(store, sealKey, vendorsOver(() => env, checkFetch));
  const webhooks = new Webhooks(store, sealKey, (fields) => (log ? log(logLine("webhook", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("webhook", fields)}\n`)), {
    ...(options.webhookRetryMs ? { retryMs: options.webhookRetryMs } : {}),
    // Any bound given reaches Webhooks' check (0 and NaN are refused there, never dropped for the default).
    ...(options.webhookTimeoutMs !== undefined ? { timeoutMs: options.webhookTimeoutMs } : {}),
    ...(options.webhookLookup ? { lookup: options.webhookLookup } : {}),
    privateTargets: switched.webhookPrivateTargets,
  });
  // The outbound webhook's secret, as it stands (set by a PUT, gone with a DELETE), and each it held before.
  stops.push(() => webhooks.close());
  await webhooks.load();
  // Where an earlier version kept the webhook: no longer read.
  if (existsSync(join(data, WEBHOOK_FILE))) log?.(logLine("webhook", { condition: "webhook_left_over", file: join(data, WEBHOOK_FILE), effect: "not read: the webhook is kept in the store now; set it again with PUT /v2/settings/webhook" }));
  secretStores.add("webhook", () => webhooks.signingSecrets());
  // Slack (slack.ts): the webhook's outbox under its own channel, its URL the credential, sealed and cut like a secret.
  const slack = new SlackPosts(store, sealKey, (fields) => (log ? log(logLine("slack", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("slack", fields)}\n`)), {
    ...(options.webhookRetryMs ? { retryMs: options.webhookRetryMs } : {}),
    ...(options.webhookTimeoutMs !== undefined ? { timeoutMs: options.webhookTimeoutMs } : {}),
    ...(options.webhookLookup ? { lookup: options.webhookLookup } : {}),
    privateTargets: options.webhookPrivateTargets ?? process.env.AGENTRUN_WEBHOOK_PRIVATE_TARGETS === "1",
    ...(options.slackTarget ? { sendTo: options.slackTarget } : {}),
    // Each message's strings (an agent's name, a run's title, a trigger's error) cut of every secret the server holds.
    serverSecrets: () => serverSecrets(),
  });
  stops.push(() => slack.close());
  await slack.load();
  secretStores.add("slack", () => slack.urlForms());
  const uploads = new Uploads(join(data, UPLOADS_DIR));
  // Under the data directory's lock and before this server answers anything, so no PUT of its own is in flight: an upload
  // temp file found now is a crashed one's.
  const swept = await uploads.sweep();
  if (swept > 0) log?.(logLine("uploads_swept", { removed: swept }));
  // A run's hold of its files goes at its claim, once they are in its workspace; one that ended before any claim copied
  // them (cancelled while queued) leaves its hold, which goes here, as does one whose run is gone.
  for (const runId of await uploads.holders()) {
    const row = await store.runs.get(runId);
    if (!row || FINAL_STATES.includes(row.state)) await uploads.release(runId);
  }
  // Mode 2 (uploads-archil.ts): the uploads on this server's own Archil disk, and each run's placed in its folder at its
  // start, so its runner reads no upload. Mode 1 keeps them in this data directory (uploads above), as before.
  const archilFiles = archilUploads({ store, sealKey, env: withSecrets(process.env, "own"), ...(options.archilControl ? { control: options.archilControl } : {}) });
  /** Where the files routes find uploads now: the uploads disk in Mode 2, else this data directory. `make`: an upload,
   *  which makes the uploads disk when there is none. */
  const uploadsHere = async (make = false): Promise<UploadStore> => (await archilFiles.here(make)) ?? uploads;
  const uploadRetention = uploadRetentionMs(options.uploadRetention ?? process.env[UPLOAD_RETENTION_ENV]);
  if (uploadRetention !== undefined) {
    // An uploaded file no run names, older than the retention, is deleted from the uploads disk (Mode 2 only): once an
    // hour, each sweep after the last one ends.
    let sweeping: Promise<void> = Promise.resolve();
    const sweepUploads = () => {
      sweeping = sweeping.then(async () => {
        const removed = await archilFiles.sweep(uploadRetention, runKeepsUploads(store));
        if (removed.length) log?.(logLine("uploads_expired", { removed: removed.length }));
      }).catch((error: Error) => void log?.(logLine("uploads_sweep_failed", { why: String(error?.message ?? error).slice(0, 300) })));
    };
    const uploadsTimer = setInterval(sweepUploads, UPLOAD_SWEEP_EVERY_MS);
    uploadsTimer.unref();
    stops.push(async () => {
      clearInterval(uploadsTimer);
      await sweeping;
    });
  }
  const documents = options.documents ?? process.env[DOCUMENTS_ENV];
  if (documents !== undefined && !(await stat(documents).then((info) => info.isDirectory(), () => false))) throw new Error(`the documents directory ${documents} is not a directory`);
  // The CLI harnesses, each installed on first use into the data's harnesses directory (harness-install.ts): one install
  // of each at a time, which every run on that harness, and the save of an agent on it, waits for or starts; once one is
  // in, the offers are probed again, so capabilities no longer say it installs on first use. Each is its table entry's
  // `installs` (a test's stand-in has none).
  const installed = HARNESSES.flatMap((id) => {
    const harness = harnessOf(base, id);
    return harness?.installs && harness.pins ? [{ entry: harness.installs, pins: harness.pins }] : [];
  });
  const installs: Record<string, HarnessInstall> = Object.fromEntries(installed.map(({ entry, pins }) => {
    const lock = options.harnessLocks?.[entry.id];
    // npm past its SIGTERM's grace (it waits on a tarball once it writes): killed, and the line says so.
    const onKilled = () => log?.(logLine("harness_install_killed", { harness: entry.id, said: `npm did not stop within ${NPM_STOP_GRACE_MS / 1000} s of SIGTERM; killed` }));
    return [entry.id, new HarnessInstall(entry, installDirOf(data, entry.id), pins, options.harnessInstall ?? ((entry, dir, pins, signal) => npmInstall(entry, dir, pins, { signal, onKilled, ...(lock ? { lock } : {}) })), (ms) => {
      log?.(logLine("harness_installed", { harness: entry.id, ms, dir: installDirOf(data, entry.id) }));
      void probe(`${entry.id}_installed`).catch(() => undefined);
    })];
  }));
  // Each harness found installed as this server starts has what earlier installs left beside it swept (HarnessInstall
  // needed): the point sure to come after an install that could not remove one (a crashed server's npm still writing in
  // it), since no install runs again until the pin changes. Not waited for; the close waits for it (install.stop).
  for (const install of Object.values(installs)) void install.needed().catch(() => undefined);
  // A capped start prices each OpenRouter Decisions model a workflow pins (runnable.ts) from OpenRouter's public catalog,
  // read once for this server (and again after a read that failed), through the faux one under --faux.
  let pricing: Promise<{ priceOf(model: string): Promise<unknown> }> | undefined;
  const readPrices = new Map<string, unknown>();
  const decisionPrice = async (model: string): Promise<unknown> => {
    const making = (pricing ??= (async () => {
      const [{ openrouterProvider }, faux] = await Promise.all([import("@parcha/agentrun-decisions"), fauxFetch(fauxEnvOf(options), FAUX_OPENROUTER_ENV)]);
      return openrouterProvider(faux ? { fetch: faux } : {});
    })());
    // One that could not be made is made again next time: a rejection is never kept.
    const provider = await making.catch((error: unknown) => { if (pricing === making) pricing = undefined; throw error; });
    const price = await provider.priceOf(model);
    readPrices.set(model, price);
    return price;
  };
  /** A decision model's price as a save or a start last read it from the catalog (null: the catalog lists none), and
   *  never a read of the catalog of its own: what a GET, which waits on no other service, prices by. A model none has
   *  priced answers PRICE_NOT_READ, which blockersOf takes for a price (no blocker): whether its run is refused is not
   *  known until a start asks. */
  const PRICE_NOT_READ = { notRead: true } as const;
  const readDecisionPrice = async (model: string): Promise<unknown> => (readPrices.has(model) ? readPrices.get(model) : PRICE_NOT_READ);
  // The run write half (runs-over-store): the server INSERTs a queued run and its launch (startRun), and writes command
  // rows (message/stop/cancel/raise/approve/archive) a run's runner reads and applies. No per-run process, no HTTP door,
  // no box relay here — a runner (its own process, sharing only this store) claims and runs every run. The leaves a start
  // needs that live in this request layer are gathered once as StartDeps; the run's model is resolved once, now (the runner
  // reads launch.model alone).
  const modelOf = (_entry: AgentEntry, revision: Revision) => (nativeOf(revision.body) || cliLearningOf(revision.body)) ? Promise.resolve(undefined) : runModelRef(env, revision);
  // Why no runner here can take a run, while every runner there refused to claim (runner/presence.ts): read from the
  // store at each start, capabilities and health answer, so a runner in another process (or on another host over one
  // Postgres) counts as the one beside this server does, and a runner that can claim, once there, clears it at once.
  const refusedNow = () => runnersRefused(store.runners);
  // While it holds, the runs still queued fail in those words (Runs.failUnclaimed), every REFUSED_SWEEP_MS: a run queued
  // before the refusal was known never waits for good. A run a runner claimed is not one of them.
  let refusedSweep: Promise<void> = Promise.resolve();
  let refusedStopped = false;
  const sweepRefused = () => {
    refusedSweep = refusedSweep.then(async () => {
      if (refusedStopped) return;
      const words = await refusedNow();
      if (words !== undefined && !refusedStopped) await store.runs.failUnclaimed(refusedEnd(words));
    }).catch((error: Error) => void process.stderr.write(`agentrun-serve: the runs queued while no runner here can take them could not be failed: ${error.message}\n`));
    return refusedSweep;
  };
  const refusedTimer = setInterval(() => void sweepRefused(), REFUSED_SWEEP_MS);
  refusedTimer.unref();
  // The runner beside this server, when its run isolation was refused (cli.ts): its word, kept in this store until the stop.
  let refusedBeside: Presence | undefined;
  const sourceWorkspaces = { data, sealKey, env: withSecrets(process.env, "own"), ...(options.archilControl ? { control: options.archilControl } : {}) };
  const localSources = new LocalSources(store, { secrets: () => [...serverSecrets(), sdkSecret, ...tokens.map(entry => entry.token)] });
  const sources = sourceService(store, sourceWorkspaces, async (entry, snapshot) => {
    const prepared = await prepareSource(snapshot, destinationPreparation(store, entry.agent.id, {
      env: () => env, boxes: () => boxOffers, check: revision => saveable(revision),
      // Readiness needs a successful probe, not capabilities' display fallback after a failed helper check.
      // A different runner repeats this prerequisite at claim, before its ownership helper changes any bytes/modes.
      projectExecution: async () => ({ isolation: runIsolationName(await runIsolationOf(base, 1, () => {})),
        storage: await loadArchilSettings(store, sourceWorkspaces.env) ? "archil" : "local" }),
    }));
    const prior = entry.revision?.body as AgenticBody | undefined;
    // Main's corrections/workflow setting remains the owner's choice across the ownership cutover.
    return prior?.learning === undefined ? prepared : { ...prepared, revision: { ...prepared.revision,
      body: { ...(prepared.revision.body as AgenticBody), learning: prior.learning } } };
  }, async (entry, snapshot, prepared) => {
    const record = await sources.sync.get(entry.agent.id);
    if (!record) throw new ApiError("precondition_failed", "The source sync connection changed during preparation.");
    const revision = { ...prepared.revision, body: { ...(prepared.revision.body as AgenticBody), sourceSync: {
      id: record.id, snapshot: snapshot.digest, project: snapshot.digest, configuration: configurationDigest(prepared.revision.body),
    } } };
    // This private, unadmitted probe verifies the actual destination's modes, Git and assets before ownership moves.
    const placed = await sourceProjects.place({ agentId: entry.agent.id, runId: uuidv7(), revision,
      launch: { input: "", title: "Source preparation", place: resolvePlace((prepared.revision.body as AgenticBody).place as Place | undefined, { mode: "runner" }) } });
    await placed?.undo();
  }, agentId => localSources.authorize(agentId));
  const sourceProjects = projectPlacement({ snapshots: agentId => sourceSnapshotReader(store, agentId, sourceWorkspaces),
    hold: ({ agentId }) => beginSourceIO(store, agentId, "placement"),
    destination: target => openRunPlacement(store, target, sourceWorkspaces),
    placeUploads: async ({ runId, launch, workspace }) => {
      const { files, bytesOf } = await uploads.heldFiles(runId, launch.files ?? []);
      await uploads.copyInto(workspace, files, bytesOf);
      await uploads.release(runId);
    } });
  const localSourcePublisher = localSources.publisher(sources.sync, { agentWrite: (id, call) => agentWrite(id, call) });
  let localSourceSweep: Promise<void> = Promise.resolve(), localSourceBusy = false;
  const sweepLocalSources = () => {
    if (localSourceBusy || stopping.signal.aborted) return localSourceSweep;
    localSourceBusy = true;
    localSourceSweep = localSourcePublisher.tick(stopping.signal).then(() => undefined).catch(() => {
      if (!stopping.signal.aborted) process.stderr.write("agentrun-serve: source setup sync could not finish; the last complete snapshot is retained. Check the source status and connection.\n");
    }).finally(() => { localSourceBusy = false; });
    return localSourceSweep;
  };
  const localSourceTimer = setInterval(() => void sweepLocalSources(), 30_000);
  localSourceTimer.unref();
  const startDeps: StartDeps = {
    project: { ...sourceProjects, place: async given => {
      try { return await sourceProjects.place(given); }
      catch (error) { if (error instanceof SnapshotError) throw new ApiError("agent_not_runnable", error.message); throw error; }
    } },
    // A start while every runner here refused to claim is refused in their words (runner/presence.ts).
    runnersRefused: refusedNow,
    runBodyIssues,
    boundRepos: async (agentId) => bindingOf(await store.triggers.list(agentId), agentId),
    pinnedOf,
    inputIssuesOf,
    explainRun,
    // told and fallbackPlace are const arrows declared later in startHolding; wrap them so startDeps captures the binding
    // (called at request time, after they are assigned) rather than reading them before their declaration.
    told: (error) => told(error),
    runnable,
    pinFirst: (revision) => pinFirst(revision),
    readyFiles: async (ids) => (await uploadsHere()).readyFiles(ids as string[]),
    files: { hold: (runId, ids) => uploads.hold(runId, ids), release: (runId) => uploads.release(runId), place: (runId, agentId, launch) => archilFiles.place(runId, agentId, launch) },
    fallbackPlace: (kind, tools) => fallbackPlace(kind, tools),
    // The run's Archil disk for its launch record (run-launch.ts archilDisk): the body's, else its agent's when it has one.
    // A disk the body names is read at Archil once, before the run is made (archil-routes.ts checkLaunchDisk): one that is
    // not there or not in the key's region is a 422 here, and Mode 1 is too. An agent whose disk is being removed
    // (archil-routes.ts removeAgentDisk) starts no run on it: 409 until the removal is done.
    launchDiskOf: async (agentId, named) => {
      if (named !== undefined) {
        await archil.checkLaunchDisk(named);
        return { diskId: named, kind: "launch" };
      }
      if (!(await inArchilMode(store, process.env))) return undefined;
      const own = await agentDiskOf(store, agentId);
      if (own?.removing) throw new ApiError("agent_not_runnable", `The agent ${agentId}'s Archil disk ${own.diskId} is being removed (DELETE /v2/agents/${agentId}/archil): start the run once that is done, and it gets a new disk.`);
      return own ? { diskId: own.diskId, kind: "agent" } : undefined;
    },
    workflowTitle,
    serverSecrets,
    toolSettings: () => settings.get(),
    planeEnv: () => env,
    approvers: options.accounts === true,
    ...(documents ? { documents: resolve(documents) } : {}),
    ...(boxAllow !== undefined ? { boxAllow } : {}),
    // Whether that is the operator's own setting, not the default: a browser is held to an operator's list alone.
    ...(boxAllowSetIn(process.env) ? { boxAllowSet: true as const } : {}),
    modelOf,
    // The run's learning start: the server's learning switch, the agent's seed read now from its learning folder (git), and
    // the host's secrets as they are shown now to cut the corrections a run is given, a loopback address kept (local): the
    // run's own machine. runs-over-store.learningStartFor pins the result (seed, section, workflows) in the launch for the
    // runner; a seed that cannot be read starts the run with nothing learned (a fault never refuses it). The runner's spec
    // builders read it back as the run's end-of-run step (runner/learning-end.ts learningEndOfRun).
    learning,
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
    shown: () => secretsShown(serverSecrets(), { local: true }),
  };
  // A run's served view and its live moment, from the store (store-view): `origin` is where this request reaches the
  // console, the secrets are cut live, and the sign-ins give the handed-pointer cut. Trigger and background reads (no
  // request) use the server's public address, else its own.
  // The run's key read from this server's environment with the keys a person saved, as its Timeline reads it (keyEnv below).
  // The learning routes' cut: the server's secrets and agent `agentId`'s own sign-in pointers, live and forgotten; 403 when
  // one of them can't be read here (agentPointers), never a shorter cut.
  const learningValues = async (agentId: string): Promise<string[]> => {
    const pointers = await agentPointers(signIns, agentId);
    if (pointers === "unreadable") throw new ApiError("forbidden", WITHHELD_LEARNING);
    return [...serverSecrets(), ...pointers];
  };
  const learningShown = async (agentId: string) => secretsShown(await learningValues(agentId));
  // What championOf skips of the agent's promotion records (purged-workflow.ts refusedIn): a champion the purge gate
  // refuses at its commit, so the views name the champion a run's claim serves. A folder whose end() throws after the ask
  // is logged, never the read's 500.
  const refusedFor = (agentId: string, records: readonly PromotionRecord[]): Promise<Refused> =>
    refusedIn(() => learningFolderOf(data, agentId), store, (line) => (log ? log(logLine("learning", { line })) : void process.stderr.write(`agentrun-serve: ${line}\n`)))(records);
  // The agent's audit ledger on its learning folder's main (learn/audit.ts), oldest first.
  const auditsOfAgent = async (agentId: string) => {
    const { workspace, end } = learningFolderOf(data, agentId);
    try {
      return await readAudits(workspace);
    } finally {
      await end().catch(() => undefined);
    }
  };
  // What a run held for its owner's OK reads as it stands on its agent's learning folder's main (statusesOf).
  const statuses = (agentId: string) => statusesOf(data, agentId);
  const viewDepsFor = (origin: string): ViewDeps => ({ origin, serverSecrets, signIns, keyEnv: () => withSavedGateway(own(withSecrets(process.env, "all", storedKeys)), savedGateway), statuses });
  // A run read as a whole (its own read, its archive) lists its recordings too, from its recordings folder on this machine
  // (run-recordings.ts), where the runner beside it wrote them; every other read of the view opens no file.
  const recordings = (agentId: string, runId: string, endedAt: number | null) => recordingsOf(recordingsFolder(data, agentId, runId), endedAt);
  const runReadDepsFor = (origin: string): ViewDeps => ({ ...viewDepsFor(origin), recordings });
  /** A run as GET /v2/runs/{run_id} answers it, its links at `origin`. */
  const runRead = async (runId: string, origin: string): Promise<Record<string, unknown> | undefined> => {
    const view = await viewOverStore(store, runId, runReadDepsFor(origin));
    return view && { ...view, ...(await runComputerRead(store, runId, view, { context: ctx })), ...(await allInViewOf(runId, view)) };
  };
  const ownOriginOf = (): string => options.publicUrl ?? url;
  // The run read routes (a run's files, its browser state, its workflow graph) over the one store (run-reads-over-store):
  // a run's files through the server's read-only Workspace of its folder (serverRunWorkspace, no runner claim), its view
  // and withheld verdict from store-view. The live browser viewer reads the runner's published handover from the store
  // (liveViewerLink, the one the runner's browser tool wrote under its claim), opened with the server's seal key. The
  // timeline route keeps its own stub (store-reads journal + SSE) until E2c's timeline lands.
  const runReadsDeps: RunReadsDeps = {
    runWorkspace: (_store, runId) => serverRunWorkspace(store, runId, { data, sealKey, env: withSecrets(process.env, "own"), ...(options.archilControl?.makeDisk ? { makeDisk: options.archilControl.makeDisk } : {}) }),
    recordings: async (_store, runId) => {
      const run = await store.runs.get(runId);
      return run ? recordingsWorkspace(recordingsFolder(data, run.agentId, runId)) : null;
    },
    env,
    runFacts: (_store, runId) => factsOverStore(store, runId, viewDepsFor(ownOriginOf())),
    withheld: (_store, runId) => withheldOverStore(store, runId, viewDepsFor(ownOriginOf())),
    cutValues: (_store, runId) => runCutValues({ serverSecrets, signIns }, store, runId),
    context: ctx,
    liveViewer: (runId: string) => liveViewerLink(store, sealKey, runId, answers(runId)),
  };
  // The run timeline reader over the store (run-reads-over-store runTimelines): one change-numbered RowLog per run, synced
  // from its journal (store-reads) on each read, its view (viewOverStore) for status/state/cost and whether it is final.
  // The route frames the SSE around its `page`, which long-polls the journal, byte-identical to the old live run's page.
  const servedTimelineDeps: ServedTimelineDeps = { serverSecrets, signIns, keyEnv: () => withSavedGateway(own(withSecrets(process.env, "all", storedKeys)), savedGateway), statuses };
  const timelines = runTimelines({
    context: ctx,
    // The run's rows as served (run-timeline-served.ts), by its one cut (run-cut.ts, read for each page: a secret rotated
    // or saved since is cut at once), the set its view's words, title and error are cut of: each secret this server never
    // shows and each browser sign-in pointer the run was handed; its decision rows among them, its error rows in the
    // error's words. A run whose hand can't be read back here is withheld: none of its rows. A run's Timeline is read
    // from its journal, which keeps what the run said whole.
    timelineRows: (forStore, runId, context, calls) => servedTimelineRows(servedTimelineDeps, forStore, runId, context, calls),
    runView: (forStore, runId) => viewOverStore(forStore, runId, viewDepsFor(ownOriginOf())),
  });
  const triggerDeps: TriggerTargetDeps = {
    ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}),
    start: startDeps,
    getAgent: async (agentId: string) => (await getAgent(store, agentId)) ?? undefined,
    needAgent,
    momentOf: (runId: string) => momentOverStore(store, runId, viewDepsFor(ownOriginOf())),
    // A trigger never messages a run on a plan-billed recipe whose keys are not all saved: its turn would run on its
    // owner's own sign-in. With them saved, the turn runs on them (harness-keys.ts), and a claim that opens not every one
    // is refused (cli-run-spec.ts).
    planRecipe: (harness: string) => recipeHarness(base, harness) === "plan" && !harnessKeysSavedHere(data, harness),
    // Read when a firing's message is sent (declared below, with the delete turn).
    runWrite: (agentId, runId, work) => runWrite(agentId, runId, work),
    runStatus: async (runId: string) => ((await viewOverStore(store, runId, viewDepsFor(ownOriginOf())))?.status as string | undefined) ?? null,
    completedOutput: async (runId: string) => {
      const view = await viewOverStore(store, runId, viewDepsFor(ownOriginOf()));
      if (view?.status !== "completed") return undefined;
      // The fields its next run is handed when the whole result is too large: its own revision's output schema's, the one
      // its result.output was checked against (store-view.ts), never the agent's current one.
      const carried = typeof view.revision === "string" ? carriedFields(((await store.agents.revision(view.revision))?.body as { outputSchema?: unknown } | undefined)?.outputSchema) : undefined;
      return { output: (view.result as { output?: unknown } | null)?.output ?? null, endedAt: (view.ended_at as string | null | undefined) ?? null, ...(carried ? { carried } : {}) };
    },
    // Read as the server's environment stands now (a saved key changes it).
    ...(options.runKeys ? { keysOwed: (revision: object) => keysOwed(revision, env, []) } : {}),
    hooked: options.launchHook !== undefined,
  };
  const targets = triggerTargets(store, triggerDeps);
  // Every presented token is checked here, against every token the server takes, in constant time (api-token.ts). The id
  // of the one that opened a request is kept with it for its log line (tokenUsed), never the secret.
  const bearerOf = bearerCheck(tokens);
  const tokenUsed = new WeakMap<IncomingMessage, string>();
  const bearer = (header: string | undefined, req?: IncomingMessage): boolean => {
    const id = bearerOf(header);
    if (id !== undefined && req) tokenUsed.set(req, id);
    return id !== undefined;
  };
  // Answered keys are kept in the data directory for the retention capabilities state, and written before the answer
  // is sent, so a client that retries after a restart gets the first answer back.
  // A key's fingerprint is an HMAC of its request's body (stable JSON) under a key derived from the server's seal key:
  // never the body, nor a bare digest of it, since a body can hold a credential (a composio trigger's config) and a short
  // or guessable one could be found from a bare digest by hashing guesses. A trigger create's answer is kept as a read
  // answers it (replayed). Entries live IDEMPOTENCY_TTL_S (a day), so one an older server wrote (the body itself as its
  // fingerprint, a composio key in its answer) can outlive an upgrade: the start rewrites each (below, after the trigger
  // engine), and says how many alone.
  const fingerprintKey = createHmac("sha256", sealKey).update("agentrun-serve idempotency fingerprint").digest();
  const fingerprintOf = (text: string) => createHmac("sha256", fingerprintKey).update(text).digest("hex");
  type Kept = { fingerprint: string; at: number; answer?: { status: number; body: unknown; headers: Record<string, string> } };
  /** A kept answer as its replay sends it, by the route its key was used on: a trigger create's (POST /triggers) with its
   *  source as a read answers it now (shownTrigger); every other route's as it was, a run's input above all. */
  const replayed = (path: string, body: unknown): unknown => (path === "/triggers" ? shownTrigger(body) : body);
  const keptFile = join(data, IDEMPOTENCY_FILE);
  const kept = JSON.parse(await readFile(keptFile, "utf8").catch(() => "null")) as { entries?: [string, Kept][] } | null;
  const idempotency = new Map<string, Kept>((kept?.entries ?? []).filter(([, v]) => v?.answer && Date.now() - v.at <= IDEMPOTENCY_TTL_S * 1000));
  /** How many entries the file held that the start did not keep (expired, or never answered): the file is written again
   *  without them at the start, so no body an older server kept stays on disk past it. */
  const keptDropped = (kept?.entries?.length ?? 0) - idempotency.size;
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
  const host = options.host ?? DEFAULT_HOST;
  // Open setup (no code) only where no one else reaches the port: a loopback listener. Bound to any other address
  // (0.0.0.0 in the image, a LAN address), the first visit takes the printed code even with no public address.
  const openSetup = options.openSetup === true && isLoopback(host);
  const owner = options.accounts ? new Owner(data, openSetup, (line) => void process.stdout.write(`${line}\n`), options.signInAddresses) : undefined;
  // With no accounts, the console's sessions: made by the link this start prints, never from the token (page.ts).
  const consoleSessions = owner ? undefined : new ConsoleSessions();
  // Who a sign-in comes from, for its limit: the socket's peer, or, from a trusted proxy only, the client it forwards for.
  const trusted = (() => {
    if (!options.trustedProxies?.length) return undefined;
    try { return proxyaddr.compile([...options.trustedProxies]); } catch (error) { throw new Error(`trustedProxies: ${(error as Error).message}`); }
  })();
  const clientOf = (req: IncomingMessage) => (trusted ? proxyaddr(req, trusted) : req.socket.remoteAddress) ?? "unknown";
  // The owner's own sign-in (the right password) that came with X-Forwarded-For from an address not trusted as a proxy is
  // said once a start, with that address (`event=forwarded_untrusted peer=<it>`): behind a proxy that publishes no
  // address (Render's), the proxy that carried the owner's request, the one to name in AGENTRUN_TRUSTED_PROXIES. Only a
  // right password says it, so a peer that can reach the server without the password can't put its own address there;
  // once, so the log says it one time.
  let forwardedSaid = false;
  const sayForwarded = (req: IncomingMessage) => {
    const peer = req.socket.remoteAddress ?? "unknown";
    if (forwardedSaid || req.headers["x-forwarded-for"] === undefined || (trusted?.(peer, 0) ?? false)) return;
    forwardedSaid = true;
    log?.(logLine("forwarded_untrusted", { peer }));
  };
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
  // --faux-github (with --faux only): the fake App is connected afresh at each start, its API in this process.
  const was = options.faux && options.fauxGitHub ? github.view() : undefined;
  if (was && was.slug !== FAUX_GITHUB.slug) throw new Error(`--faux-github connects a fake GitHub App, and this data directory has the GitHub App ${was.slug} connected: use a scratch data directory.`);
  // Its repository as a bare git repository beside the data, so a run's checkout of it (agent-scout's) stays on this machine.
  const fauxGitHub = options.faux && options.fauxGitHub ? await startFauxGitHub({ webDir: join(data, "faux-github-web") }) : undefined;
  if (fauxGitHub) {
    stops.push(() => fauxGitHub.close());
    if (was) await github.remove();
    await github.save(fauxGitHub.app);
    await github.setInstallations([{ id: FAUX_GITHUB.installation, account: FAUX_GITHUB.account }]);
    await writeFile(join(data, FAUX_GITHUB_FILE), `${JSON.stringify({ webhook_secret: fauxGitHub.app.webhookSecret, installation: FAUX_GITHUB.installation, account: FAUX_GITHUB.account, repositories: FAUX_GITHUB.repositories, api_url: fauxGitHub.url })}\n`, { mode: 0o600 });
  }
  const githubConnect = new GitHubConnect(github, { ...(options.publicUrl ? { publicUrl: options.publicUrl.replace(/\/+$/, "") } : {}), api: fauxGitHub?.url ?? options.githubApi ?? GITHUB_API, say: (fields) => log?.(logLine("github", fields)) });
  /** The connection a GitHub template or the console reads: the App's id, slug and installations, never a secret. */
  const githubConnection = () => github.view();
  /** What applying a template reads of the server (templates.ts TemplatesDeps). */
  const templateDeps: TemplatesDeps = { githubConnection };
  // A template import reads GitHub's own hosts alone (a test's faux GitHub in their place), with an installation token of
  // the App when GitHub is connected (tokenForListing: metadata read, the least there is), else anonymously, and says why.
  const importDeps: TemplateImportDeps = {
    registry, store, apiOnly: options.apiOnly === true,
    reach: async (signal) => {
      const api = options.templateImportApi ?? GITHUB_API;
      const hosts = options.templateImportApi ? [new URL(options.templateImportApi).host] : GITHUB_HOSTS;
      const minted = options.templateImportApi ? { unusable: "it reads a test's GitHub" } : await githubConnect.tokenForListing(signal).catch((error: Error) => ({ unusable: error.message }));
      return "token" in minted ? { api, hosts, token: minted.token } : { api, hosts, anonymous: "unusable" in minted ? minted.unusable : minted.failed };
    },
  };
  // Suggested agents (suggestions.ts): scans run the bundled agent-scout, applied once and reused (one apply at a time
  // on this server); a create pushes through the App's token for the one repository, then applies the package it pushed
  // as an imported template, so the agent here is made from the very files the pull request adds.
  let scouting: Promise<string> | undefined;
  const suggestions = new Suggestions({
    settings: store.settings,
    github: { view: () => github.view(), settingsUrl: () => github.settingsUrl(), get api() { return githubConnect.api; }, repoInstallation: (repo, signal) => githubConnect.repoInstallation(repo, signal), tokenWith: (installation, repo, permissions, signal) => githubConnect.tokenWith(installation, repo, permissions, signal), revokeToken: (token) => githubConnect.revokeToken(token) },
    scoutAgent: () => (scouting ??= (async () => {
      const mine = (await agents.list()).find((one) => one.template?.id === SCOUT_TEMPLATE && !one.agent.archivedAt);
      if (mine) return mine.agent.id;
      const pkg = registry.get(SCOUT_TEMPLATE);
      if (!pkg) throw new ApiError("unavailable", `This server does not ship the ${SCOUT_TEMPLATE} template, which scans a repository.`);
      return (await applyTemplate(pkg, { parameters: {} })).applied.agent_id;
    })().finally(() => { scouting = undefined; })),
    startScan: async (agentId, content) => (await startRunOf(await needRunnableAgent(agentId), { input: { content } })).id,
    readRun: async (runId) => {
      const view = await viewOverStore(store, runId, viewDepsFor(ownOriginOf()));
      if (!view) return undefined;
      const result = isObject(view.result) ? view.result : undefined;
      const error = isObject(view.error) && typeof view.error.message === "string" ? view.error.message : typeof result?.output_error === "string" ? `Its answer did not meet the scout's schema: ${result.output_error}` : undefined;
      return { status: String(view.status), ...(result && result.output != null ? { output: result.output } : {}), ...(error ? { error } : {}), ...(typeof view.ended_at === "string" ? { endedAt: Date.parse(view.ended_at) } : {}) };
    },
    // Kept, then applied (template-import.ts applyImported): a thrown error means no agent was made. The package has no
    // trigger, so the apply makes the agent as its last write.
    cancelScan: async (runId) => { await cancel(store, await needRun(runId)); },
    agentFrom: async (id, sha) => (await agents.list()).find((one) => one.template?.id === id && one.template.sha === sha && !one.agent.archivedAt)?.agent.id,
    makeAgent: async (id, origin, files) => {
      const made = await applyImported({ registry, store, apply: (pkg) => applyTemplate(pkg, { parameters: {} }) }, id, origin, files);
      return { agentId: made.applied.agent_id, warnings: made.applied.warnings };
    },
    ...(options.publicUrl ? { publicUrl: options.publicUrl.replace(/\/+$/, "") } : {}),
    ...(options.onUsage ? { used: options.onUsage } : {}),
  });
  // A github_app MCP server's tools are listed with an installation token of the App, narrowed to one repository it covers
  // with metadata read (tokenForListing); a run's own is minted in the runner (runner/github-app.ts). Every token minted
  // is a server secret while it may be in use.
  mcpServers.appToken = (signal) => githubConnect.tokenForListing(signal);
  secretStores.add("github-tokens", () => githubConnect.liveTokens());
  /** Why a trigger of `kind` can't be on here now (its connection), or undefined: what a create of an enabled one is
   *  refused with, and what an apply's plan says of the triggers it would make. */
  const triggerUnavailable = async (kind: string): Promise<ApiError | undefined> => (kind === "github" && !githubConnection() ? new ApiError("github_not_connected", "This server has no GitHub App: Connect GitHub in Settings, then make the trigger (or turn it on).") : kind === "email" && !(await openAccount(store, sealKey)) ? noAccount() : undefined);
  const triggers: Triggers = new Triggers({
    // The server's own store (the one it opened) holds the triggers a person writes and reads; a test may inject another
    // (startServe's `store`).
    store: options.store ?? store,
    clock: options.triggerClock,
    ...(options.publicUrl ? { publicUrl: options.publicUrl.replace(/\/+$/, "") } : {}),
    adapters,
    unavailable: triggerUnavailable,
    // The email trigger's account, its password opened as it polls (email/account.ts): never kept in the engine.
    // A feed trigger's reach: where its reads may go, as an MCP server's requests may (mcp-oauth.ts feedAt), and a test's
    // or an eval's route to its fake feeds (feedsAt).
    credentials: async (kind) => (kind === "email" ? openAccount(store, sealKey) : kind === "feed" ? { ...(await mcpServers.outboundReach()), ...(options.feedsAt ? { route: options.feedsAt } : {}) } : undefined),
    say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)),
    // The trigger target policy (what a trigger may start or message, and in what words it is refused) is the one store's
    // (trigger-targets.ts, over the run write half and the run view): targetIssues, start, message, statusOf, runOf. The
    // queue a firing takes — how many of a trigger's messages wait for a busy run — is route-1's store.triggers.
    ...targets,
    settings: (adapterId) => triggerSettings.get(adapterId),
    // The webhook and Slack each hear of it: told once both have it (or neither is set), again while either has not.
    notify: async (failed, key) => {
      const told = await Promise.all([webhooks.emitTrigger(failed, key), slack.emitTrigger(failed, key)]);
      return told.find((one) => one === "unsaved" || one === "closed") ?? (told.includes("queued") ? "queued" : "off");
    },
    // A Composio trigger's instance, and the project's subscription, are made and kept on Composio with its server's key.
    upstream: (kind) => (kind === "composio" ? composioTriggers : undefined),
    ...(options.launchHook ? { launchHook: options.launchHook } : {}),
  });
  const composioTriggers = new ComposioTriggers({
    control: options.composioControl ?? {},
    ...(options.publicUrl ? { publicUrl: options.publicUrl.replace(/\/+$/, "") } : {}),
    sealed: triggerSettings.get("composio")!,
    credential: (name, refusal) => mcpServers.composioOf(name, refusal),
    holders: () => triggers.ofKind("composio"),
    signal: stopping.signal,
    say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)),
  });
  // A composio trigger kept with a credential of its config in the clear (saved before the config was sealed) is sealed
  // before the first request: no answer shows it from this start on.
  // All of it under the store's secureRewrite, so no file of the store keeps the rows' old bytes (the key): when it can't
  // finish the scrub (a reader held the log back), it is said by a code alone and the next start finishes it.
  const sealing = options.store ?? store;
  const sealKept = () => composioTriggers.sealKept(async (id, source) => void (await sealing.triggers.update(id, { source })));
  await (sealing === store && store.secureRewrite ? store.secureRewrite(sealKept) : sealKept().then((rewritten) => ({ rewritten, left: undefined })))
    .then(({ left }) => {
      if (!left) return;
      const line = logLine("store", { condition: "store_scrub_not_done", reason: left });
      if (log) log(line);
      else process.stderr.write(`agentrun-serve: ${line}\n`);
    })
    .catch((error: Error) => void process.stderr.write(`agentrun-serve: sealing the composio triggers' config: ${error.message}\n`));
  // Then, not waited on: a trigger kept with a value in the clear in a field only its event's schema marks, sealed once
  // the schemas are read from Composio (composio-triggers.ts sealMarked). Drained by stop before the store closes.
  /** Trigger `id`'s create answer kept under an Idempotency-Key, its fields `source` now seals (sealed_config) masked: the
   *  after-start seal by the events' schemas finds fields the name rule (shownTrigger, at the start's rewrite of the
   *  records) does not, and a replay must not hand one back. The file is written again when one changed. */
  const cachedMasked = async (id: string, source: Record<string, unknown>) => {
    if (maskCached(id, source).length) await keep();
  };
  /** The records kept under an Idempotency-Key (their slots) that answered trigger `id`'s create with a field `source`
   *  keeps sealed still in the clear, each masked in the map now (not saved: the caller saves). */
  function maskCached(id: string, source: Record<string, unknown>): string[] {
    const fields = Array.isArray(source[SEALED_FIELD]) ? (source[SEALED_FIELD] as unknown[]).filter((name): name is string => typeof name === "string") : [];
    const changed: string[] = [];
    for (const [slot, v] of idempotency) {
      const body = v.answer?.body;
      if (!v.answer || !isObject(body) || body.id !== id || !isObject(body.source) || !isObject(body.source.config)) continue;
      const config: Record<string, unknown> = { ...body.source.config };
      const hit = fields.filter((name) => Object.hasOwn(config, name) && config[name] !== SEALED_MASK);
      if (!hit.length) continue;
      for (const name of hit) config[name] = SEALED_MASK;
      idempotency.set(slot, { ...v, answer: { ...v.answer, body: { ...body, source: { ...body.source, config, [SEALED_FIELD]: fields } } } });
      changed.push(slot);
    }
    return changed;
  }
  /** The records answering trigger `id`'s create once the trigger is gone (deleted, or not read): no trigger is left to
   *  say which of its fields are sealed, so every field of each answer's config is masked in the map (not saved: the
   *  caller saves). A replay of a deleted trigger's create needs none of its values. */
  function maskCachedGone(id: string): string[] {
    const changed: string[] = [];
    for (const [slot, v] of idempotency) {
      const body = v.answer?.body;
      if (!v.answer || !isObject(body) || body.id !== id || !isObject(body.source) || !isObject(body.source.config)) continue;
      const names = Object.keys(body.source.config);
      if (names.every((name) => (body.source as { config: Record<string, unknown> }).config[name] === SEALED_MASK)) continue;
      const config = Object.fromEntries(names.map((name) => [name, SEALED_MASK]));
      idempotency.set(slot, { ...v, answer: { ...v.answer, body: { ...body, source: { ...body.source, config, [SEALED_FIELD]: names } } } });
      changed.push(slot);
    }
    return changed;
  }
  const idempotencySaid = (fields: Record<string, string>) => {
    const line = logLine("idempotency", fields);
    if (log) log(line);
    else process.stderr.write(`agentrun-serve: ${line}\n`);
  };
  const scrubSaid = ({ left }: { left?: string }) => {
    if (!left) return;
    const line = logLine("store", { condition: "store_scrub_not_done", reason: left });
    if (log) log(line);
    else process.stderr.write(`agentrun-serve: ${line}\n`);
  };
  schemaSealed = composioTriggers
    // Compare-and-set on the updatedAt the trigger was read at; and no VACUUM while serving (the marker stays, the next
    // start's scrub runs it before it serves).
    .sealMarked(async (id, source, updatedAt, read) => {
      const written = (await sealing.triggers.update(id, { source }, undefined, updatedAt === undefined ? { ifSource: read } : { ifUpdatedAt: updatedAt, ifSource: read })) !== undefined;
      // Once the trigger is written its seal stands: a failed save of the cached answers is said, never thrown (the seal
      // would be undone with the value's one copy). The map holds them masked already, so the next save writes them so.
      if (written) await cachedMasked(id, source).catch((error: NodeJS.ErrnoException) => idempotencySaid({ condition: "idempotency_not_saved", trigger: id, error: typeof error?.code === "string" ? error.code : "error" }));
      return written;
    }, async (work) => (sealing === store && store.secureRewrite ? scrubSaid(await store.secureRewrite(work, { vacuum: false })) : void (await work())))
    .catch((error: Error) => void (stopping.signal.aborted || process.stderr.write(`agentrun-serve: sealing the composio triggers' config by their events' schemas: ${error.message}\n`)));
  // Each Idempotency-Key record an older server wrote, rewritten before the first request: its fingerprint keyed (the body
  // it held as its fingerprint is gone) and its answer as a read answers it now. Said with how many alone.
  {
    // Each record rewritten, counted once whichever of the two passes below rewrote it.
    const scrubbed = new Set<string>();
    // Each cached create answer checked against its trigger as stored, whatever its field's name: a field sealed since
    // (by its event's schema, whose save of this file failed before a restart) is masked before the first request.
    const answered = new Set<string>();
    for (const [slot, v] of idempotency) {
      const body = v.answer?.body;
      if (slot.startsWith("/triggers\n") && isObject(body) && typeof body.id === "string") answered.add(body.id);
    }
    for (const id of answered) {
      const row = await sealing.triggers.get(id).catch(() => undefined);
      // A trigger gone (deleted before this start, by a server that did not mask its answers at the delete) or not read:
      // every field of its cached answers is masked, as no trigger is left to say which are sealed.
      const slots = row && isObject(row.source) ? maskCached(id, row.source as Record<string, unknown>) : row ? [] : maskCachedGone(id);
      for (const slot of slots) scrubbed.add(slot);
    }
    for (const [slot, v] of idempotency) {
      const fingerprint = /^[0-9a-f]{64}$/.test(String(v.fingerprint)) ? v.fingerprint : fingerprintOf(String(v.fingerprint));
      const answer = v.answer && { ...v.answer, body: replayed(slot.slice(0, slot.indexOf("\n")), v.answer.body) };
      if (fingerprint === v.fingerprint && JSON.stringify(answer?.body) === JSON.stringify(v.answer?.body)) continue;
      idempotency.set(slot, { ...v, fingerprint, ...(answer ? { answer } : {}) });
      scrubbed.add(slot);
    }
    if (scrubbed.size || keptDropped > 0) await keep().catch((error: Error) => void process.stderr.write(`agentrun-serve: idempotency save: ${error.message}\n`));
    if (scrubbed.size) {
      const line = logLine("idempotency", { condition: "idempotency_records_scrubbed", count: scrubbed.size });
      if (log) log(line);
      else process.stderr.write(`agentrun-serve: ${line}\n`);
    }
  }
  /** What a save refused while Composio triggers use the server says to do once they are gone (composio-triggers.ts inUse). */
  const SAVE_AFTER_TRIGGERS = "then save the server again";
  /** What a save over a preset server left at Composio (ComposioDropped), removed there with the key it was made with, in
   *  words; when that key doesn't open here, all of it said to remove by hand. */
  const composioLeft = async (name: string, dropped: ComposioDropped) =>
    "unusable" in dropped && (dropped.mcp || dropped.cleanup.remove.length) ? composioNote(name, dropped.cleanup, dropped.mcp ?? false, true)
      : await composioForget(options.composioControl ?? {}, "key" in dropped ? dropped.key : "", dropped.mcp, name, stopping.signal, dropped.cleanup);
  // The Composio preset's saves, the saves of the servers it made, and the MCP servers' deletes, one at a time, Composio's
  // calls included: a delete never removes there an auth config or account that a save still at Composio reuses (it would
  // find no record of it yet), and a save never reuses one a delete is removing. A failure of one never stops the next.
  let composioLast: Promise<unknown> = Promise.resolve();
  const inComposioTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = composioLast.then(work, work);
    composioLast = turn.catch(() => undefined);
    return turn;
  };
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
  const offersImport = openSetup && options.publicUrl === undefined;
  let closing = false;
  const workers = new Map<Worker, { task: ImportTask["task"]; exit: Promise<unknown> }>();
  // Once the server closes, no worker starts: a setup still being answered then leaves its yes for the next start.
  const onWorker = (task: ImportTask["task"], projects?: readonly string[]): Promise<ImportAnswer> =>
    closing ? Promise.resolve({ stopped: true }) : new Promise((answered, failed) => {
      const worker = new Worker(new URL("./import-worker.js", import.meta.url), {
        // The secrets this process holds (secrets.ts keeps them out of every environment, so the worker's has none), in the
        // worker's memory alone: what the import cuts out of everything it writes. The keys saved on the Tool keys page are
        // not passed; the worker reads them from the store over the port (sealed rows it opens with the seal key among these
        // secrets), the same cut as the CLI's import, where a saved key and the server's own of the same name may differ.
        workerData: { task, data, ...(projects ? { projects } : {}), home: options.sessionsHome?.home ?? homedir(), ...(options.sessionsHome?.temp ? { temp: options.sessionsHome.temp } : {}), secrets: Object.fromEntries(SECRET_NAMES.flatMap((name) => { const value = name === SEAL_KEY_ENV ? seal.text : secret(name); return value === undefined ? [] : [[name, value]]; })) } satisfies ImportTask,
        // Started from a string (node --input-type=module -e, as a test or a `--` command may), the server's flags are given again
        // without that string and its type: a worker started from a file with them is refused. Otherwise the worker
        // inherits them as Node passes them on, which leaves out the flags a worker may not take (on Node 24 a test
        // runner's child holds many).
        ...(process.execArgv.some((arg) => arg.startsWith("--input-type")) ? { execArgv: workerArgs(process.execArgv) } : {}),
        // Its own heap, at most IMPORT_HEAP_MB whatever the machine's memory: an import that needs more ends as a failed
        // worker (said, and counted: IMPORT_STARTS), never as a process the system ends for the memory it took.
        resourceLimits: { maxOldGenerationSizeMb: IMPORT_HEAP_MB },
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
  let count: { state: "counting" } | { state: "counted"; projects: number; sessions: number; candidates: ImportCandidate[] } | { state: "failed" } | undefined;
  const countSessions = () => {
    if (count) return;
    count = { state: "counting" };
    onWorker("plan").then(
      (answer) => void (count = "sessions" in answer ? { state: "counted", projects: answer.projects, sessions: answer.sessions, candidates: answer.candidates } : undefined),
      (error: unknown) => {
        count = { state: "failed" };
        process.stderr.write(`agentrun-serve: the count of this machine's sessions failed: ${(error as Error).message}\n`);
      },
    );
  };
  const stopCount = () => { for (const [worker, { task }] of workers) if (task === "plan") worker.postMessage("stop"); };
  // The owner's yes, kept until the import ends: a server stopped (or killed) mid-import goes on with it at its next start.
  // With it: the projects chosen (none named: every project), what earlier starts took, and how many starts began the
  // import and neither ended it nor were stopped (`starts`).
  const importAsked = join(data, IMPORT_ASKED);
  type Asked = { projects?: string[]; agents: string[]; runs: number; starts: number };
  /** The yes as kept, or undefined when it cannot be read as one (a file that will not open, text that is no JSON
   *  object, `projects` that is no list of ids): never taken for "every project", which only an empty file or one that
   *  names no projects means. */
  const askedOf = async (): Promise<Asked | undefined> => {
    const text = await readFile(importAsked, "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    // The yes as an earlier version's setup wrote it is empty: every project, and no earlier start took anything.
    if (!text.trim()) return { agents: [], runs: 0, starts: 0 };
    let kept: { projects?: unknown; agents?: unknown; runs?: unknown; starts?: unknown };
    try { kept = JSON.parse(text); } catch { return undefined; }
    if (typeof kept !== "object" || kept === null || Array.isArray(kept)) return undefined;
    const ids = (value: unknown) => (Array.isArray(value) && value.every((id) => typeof id === "string") ? (value as string[]) : undefined);
    const projects = ids(kept.projects);
    if (kept.projects !== undefined && !projects) return undefined;
    return { ...(projects ? { projects } : {}), agents: ids(kept.agents) ?? [], runs: typeof kept.runs === "number" ? kept.runs : 0, starts: typeof kept.starts === "number" ? kept.starts : 0 };
  };
  let importing: Promise<void> | undefined;
  /** The import at setup as the owner's console reads it: running, done with what it took, stopped (the next start
   *  goes on with it), or failed (IMPORT_STARTS starts did not end it: given up, never tried again on its own). */
  let importState: { state: "running" } | { state: "done"; agents: number; runs: number; skipped: number } | { state: "stopped" } | { state: "failed" } | undefined;
  /** Never rejects: whatever stops it (the store held past its wait, a file) is said on stderr, and the server goes on. */
  const importAtSetup = () =>
    (importing ??= (async () => {
      importState = { state: "running" };
      // An import that fails, or ends the process, the same way at every start would be taken up at every start for good:
      // after IMPORT_STARTS such starts the yes is dropped, and said.
      const giveUp = async (why: string) => {
        await rm(importAsked, { force: true }).catch(() => undefined);
        importState = { state: "failed" };
        process.stderr.write(`agentrun-serve: the import at setup was given up (${why}): run the import command where the sessions are to try again\n`);
      };
      let asked: Asked | undefined;
      try {
        asked = await askedOf();
        // A choice that cannot be read is never widened to every project: nothing is imported.
        if (!asked) return await giveUp("the record of which projects to import could not be read");
        if (asked.starts >= IMPORT_STARTS) return await giveUp(`${IMPORT_STARTS} starts did not end it: the server ended during each`);
        // This start counted before its worker runs, so one the process does not outlive is counted too.
        await writeDurable(importAsked, JSON.stringify({ ...asked, starts: asked.starts + 1 }));
        const answer = await onWorker("import", asked.projects);
        // Stopped by the server's close, before it took anything or between two sessions: not a start that failed.
        if (!("took" in answer)) {
          await writeDurable(importAsked, JSON.stringify(asked));
          return void (importState = { state: "stopped" });
        }
        // The whole import, every start's part of it: what earlier starts took is kept with the owner's yes.
        const agents = [...new Set([...asked.agents, ...answer.took.agents])];
        const runs = asked.runs + answer.took.runs;
        if (answer.stopped) {
          await writeDurable(importAsked, JSON.stringify({ ...asked, agents, runs }));
          return void (importState = { state: "stopped" });
        }
        await rm(importAsked, { force: true });
        const took = { agents: agents.length, runs, skipped: answer.took.skipped };
        importState = { state: "done", ...took };
        process.stdout.write(`${logLine("import", took)}\n`);
      } catch (error) {
        // A worker the close ended is no failed start; another failure is, and the last one allowed gives the import up.
        if (closing) {
          importState = { state: "stopped" };
          if (asked) await writeDurable(importAsked, JSON.stringify(asked)).catch(() => undefined);
        } else if (asked && asked.starts + 1 >= IMPORT_STARTS) await giveUp(`${IMPORT_STARTS} starts did not end it: ${(error as Error).message}`);
        else {
          importState = { state: "stopped" };
          process.stderr.write(`agentrun-serve: the import at setup stopped (the next start goes on with it): ${(error as Error).message}\n`);
        }
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

  async function bodyOf(req: IncomingMessage, max = MAX_BODY): Promise<Json> {
    // Read once: the secret-write check reads a registered operation's body before its route does (secret-writes.ts).
    const read = bodies.get(req);
    if (read !== undefined) return read;
    const type = String(req.headers["content-type"] ?? "");
    if (!type.startsWith("application/json")) throw new ApiError("unsupported_media_type", "the body must be application/json");
    const bytes = await bytesOf(req, max);
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
   *  current revision's, those the gate allows under the server's settings and the agent's own. `entry`: the agent as the
   *  caller already read it, so what it checks and what it copies are one revision's (a promotion). */
  async function learnedDraftToolsOf(id: string, entry?: AgentEntry): Promise<{ tools: string[]; gated: Record<string, string>; deniedBy: Record<string, "agent" | "server" | "default">; decisions?: DraftDecisions }> {
    const revision = (entry ?? (await needAgent(id))).revision;
    if (revision?.kind !== "agentic") return { tools: [], gated: {}, deniedBy: {} };
    const [{ learnedDraftTools }, { permissionFrom }] = await Promise.all([import("./tools.js"), import("./tool-gate.js")]);
    const server = settings.get();
    // The revision row's body is the agentic body JSON (store-backed RevisionRow types it as unknown).
    const body = revision.body as { tools?: string[]; toolSettings?: unknown; approvals?: string };
    const gate = (name: string) => permissionFrom(name, server as never, (body.toolSettings ?? {}) as never, body.approvals === "never" ? "never" : "ask");
    // `deniedBy`: where each deny was set (the agent's tool settings, the server's), which a refused draft's words name.
    const { tools, gated, deniedBy } = learnedDraftTools(body.tools ?? [], (name) => gate(name).permission, undefined, (name) => gate(name).from, { mcp: true, approvers: await readApprovers(store.settings) });
    // A draft's decision nodes (LS-07), as a run's learning end checks them: on this server's decision providers (its
    // keys, saved ones among them: env), each held to the gate by its bare id; deny alone refuses one.
    const [{ decisionProvidersIn }, { DECISION_PROVIDER_KEYS }] = await Promise.all([import("./decisions.js"), import("./tool-plane.js")]);
    const providers = await decisionProvidersIn(env);
    if (!providers) return { tools, gated, deniedBy };
    const decided: Record<string, string> = {};
    const decisionDeniedBy: Record<string, "agent" | "server" | "default"> = {};
    for (const provider of DECISION_PROVIDER_KEYS) {
      const { permission, from } = gate(provider);
      if (permission === "allow") continue;
      decided[provider] = permission;
      if (permission === "deny") decisionDeniedBy[provider] = from as "agent" | "server" | "default";
    }
    return { tools, gated, deniedBy, decisions: { providers: providers.providers, default: providers.default, gated: decided, deniedBy: decisionDeniedBy } };
  }
  async function needAgent(id: string): Promise<AgentEntry> {
    const entry = ID.test(id) ? await agents.get(id) : null;
    if (!entry) throw new ApiError("not_found", `no agent ${id}`);
    return entry;
  }
  /** The agent `id` (needAgent), refused when it is archived (409 agent_not_runnable): every route that starts its runs,
   *  a person's start (createRun) and a replay's (startLearnedWorkflowReplay), asks this before it reserves or writes anything. */
  async function needRunnableAgent(id: string): Promise<AgentEntry> {
    const entry = await needAgent(id);
    // Another system's agent is archived only by its delete (its archive route is refused).
    if (entry.agent.archivedAt && ownedElsewhere(entry.agent)) throw agentDeleting(id);
    if (entry.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${id} is archived: unarchive it to run it.`, { details: { archived_at: new Date(entry.agent.archivedAt).toISOString() } });
    return entry;
  }
  /** An agent view's extra fields (agents-store agentView): its saved sign-ins, its learning count, and its run counts.
   *  The run counts read the store's runs (store-reads/runs.ts listRuns): `count` is every run the agent has, `live` those
   *  still running (runReadState 'running': queued, running or parked), the same numbers the file-backed view showed. */
  const agentExtra = async (entry: AgentEntry): Promise<{ nativeStatus?: import("./native/types.js").NativeBinding; signIns: object[]; learning?: { pending: number }; runs: { count: number; live: number }; ownComputer: Record<string, unknown> | null }> => {
    const learning = await learningOfAgent(entry);
    const native = nativeOf(entry.revision?.body);
    const nativeStatus = native?.remote ? await new RemoteConnectors(store).status(native) : undefined;
    // Counted in the store, one read per agent: no run is read for it.
    const runs = await store.runs.counts(entry.agent.id);
    return {
      ...(nativeStatus ? {nativeStatus} : {}),
      signIns: await signIns.view(entry.agent.id),
      ...(learning ? { learning } : {}),
      runs: { count: runs.count, live: runs.live },
      // The agent's own computer (a persistent setting), as this server records it: the view's own_computer.
      ownComputer: agentComputerView(await agentComputerOf(store, entry.agent.id)),
    };
  };
  /** Deletes an agent's own computer once the agent has no use for it (archived, persistent turned off, another provider
   *  or image: workspace/agent-computer.ts), after the write that made it so, in the background: a vendor's delete can
   *  take minutes. Until the provider has deleted it, the agent's view shows it deleting, with why where a delete failed. */
  const reconcileComputer = (agentId: string): void => {
    void reconcileAgentComputer(store, agentId, (provider, image) => computersOf().providerFor(provider, image))
      .then((done) => (done ? log?.(logLine("agent_computer", { agent: agentId, ...("deleted" in done ? { deleted: done.deleted } : { failed: done.failed }) })) : undefined))
      .catch((error: unknown) => log?.(logLine("agent_computer", { agent: agentId, failed: error instanceof Error ? error.message : String(error) })));
  };
  /** The runs and agents a delete forgot the kept answers of (forgetKept), as "run:<id>" or "agent:<id>", with when: kept
   *  as long as a request under a key could still be at work (IDEMPOTENCY_TTL_S). */
  const forgotten = new Map<string, number>();
  /** Whether a kept answer, by its request's path and its body, names run or agent `id`. */
  const namesForgotten = (kind: "run" | "agent", id: string, path: string, body: unknown): boolean =>
    path.startsWith(`/${kind}s/${id}/`) || (isObject(body) && body[kind === "run" ? "run_id" : "agent_id"] === id);
  /** Whether an answer, by its request's path and its body, names a run or an agent a delete forgot. */
  const keptForgotten = (path: string, body: unknown): boolean => {
    const named = /^\/(runs|agents)\/([^/]+)\//.exec(path);
    if (named && forgotten.has(`${named[1] === "runs" ? "run" : "agent"}:${named[2]}`)) return true;
    if (!isObject(body)) return false;
    return (typeof body.run_id === "string" && forgotten.has(`run:${body.run_id}`)) || (typeof body.agent_id === "string" && forgotten.has(`agent:${body.agent_id}`));
  };
  /** The answers kept under idempotency keys (the in-memory map and its file) that name run or agent `id`, by the request's
   *  path and the answer's body, dropped and the file written again: a deleted agent's and its runs' (agent-delete.ts). The
   *  file is written every time, dropped or not: a save that failed before left the file holding answers memory no longer has,
   *  so a retry that found nothing to drop still writes it (a restart in between reads them from the file again). A
   *  failed write throws, and the delete stops before the rows that name them go. The run or agent is noted as forgotten
   *  first (`forgotten`): a request under a key still at work when this passed keeps no answer naming it (idempotent). */
  const forgetKept = async (kind: "run" | "agent", id: string): Promise<void> => {
    forgotten.set(`${kind}:${id}`, Date.now());
    for (const [slot, one] of idempotency) if (namesForgotten(kind, id, slot.slice(0, slot.indexOf("\n")), one.answer?.body)) idempotency.delete(slot);
    await keep();
  };
  const deleteInTurn = oneAtATime(options.deleteTurnQueued);
  /** `work`, a write to agent `id`'s home or learning (files a delete removes with the agent's folders, settings it leaves
   *  to deleteLearning, answers kept under its path), done in the agent's delete turn, the agent read there: a write sent
   *  while a DELETE runs waits for it, then finds the agent gone (404) or still being deleted (409 agent_not_runnable),
   *  so nothing is written after the delete passed over it. The request's body is read before, outside the turn. */
  const agentWrite = <T>(id: string, work: () => Promise<T>): Promise<T> =>
    deleteInTurn(id, async () => {
      const entry = await needAgent(id);
      // A purged agent's row stays as its tombstone: a write that waited on its purge is 410, never a folder made again.
      if (entry.agent.purgedAt !== null) throw purgedAgent(entry.agent);
      if (entry.agent.archivedAt && ownedElsewhere(entry.agent)) throw agentDeleting(id);
      // A purge stopped part way (its mark still there): nothing of the agent is written, nor is it unarchived, until a
      // DELETE finishes it.
      if (entry.agent.archivedAt && (await store.settings.get(purgingKey(id))) !== undefined) throw agentDeleting(id);
      return work();
    });
  /** `work`, a write that names run `runId` of agent `agentId` (a message, which may open it again; a grade, which keeps its
   *  id and expected answer), done in the agent's delete turn, the agent and the run read there: a purge of the run (or of
   *  its agent) holds that turn from its live check to its tombstone, so such a write waits for it and is then 410, never
   *  a run opened again under a purge nor a grade saved after one. */
  const runWrite = <T>(agentId: string, runId: string, work: () => Promise<T>): Promise<T> =>
    agentWrite(agentId, async () => {
      const row = await store.runs.get(runId);
      if (!row) throw new ApiError("not_found", `no run ${runId}`);
      if (row.purgedAt !== null) throw purgedRun(row);
      return work();
    });
  const AGAIN = "It starts no run meanwhile: send the DELETE again to finish it.";
  const RUN_AGAIN = "The run is kept: send the DELETE again to finish it.";
  /** `work`, a thing a deleted agent or run owns elsewhere deleted there: a refusal of one of `codes` (it is not deleted
   *  there yet) answered as the delete answers each such one, 503 unavailable, retryable, saying to send the DELETE again
   *  (`again`: the words for an agent's delete, or a run's). */
  const notYetWith = async (work: () => Promise<unknown>, codes: readonly string[] = ["unavailable"], again = AGAIN): Promise<void> => {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof ApiError && codes.includes(error.code))) throw error;
      throw new ApiError("unavailable", `${error.message.replace(/[.\s]*$/, "")}. ${again}`, { retry_after_ms: 5_000 });
    }
  };
  /** The Archil disks agent `agentId`'s learning folder may be on: a Mode 2 run's end writes it on the disk its claim
   *  mounted (workspace/learning-workspace.ts, at learningKey), the agent's stored disk (named here only for
   *  `agentDisk`) or one a launch named (kind "launch", a customer's: each run's disk, learn/learning-of.ts namedDisksOf,
   *  read off its row, so a purged run whose launch is gone still names it). A run's kept disk, or a launch's kind
   *  "agent", is the agent's own disk, mounted only while it is still the stored one (workspace/run-disk.ts runDiskOf):
   *  one no longer stored was removed at Archil, its folder with it. */
  const learningDisksOf = async (agentId: string, agentDisk: boolean): Promise<string[]> => {
    const disks = new Set<string>();
    const stored = agentDisk ? await agentDiskOf(store, agentId) : undefined;
    if (stored) disks.add(stored.diskId);
    for (const disk of await namedDisksOf(store, agentId)) disks.add(disk);
    return [...disks];
  };
  /** Step 2 of DELETE /agents/{id}, and DELETE /agents/{id}/learning: the learning module's delete over the agent's
   *  learning folder on this server's disk, as the learning routes open it (learningFolderOf), which deleteLearning ends
   *  in its finally, and over its folder on each Archil disk a launch of its runs named and, for a reset (`agentDisk`),
   *  on its own disk, which the agent's delete removes whole in step 3 (archil-routes.ts removeLearningFolder; Archil
   *  off or refusing is 503 unavailable, nothing here deleted, for the next call). */
  const learningDelete: DeleteLearning = options.deleteLearning ?? ((given, agentId, { keepResetLedger = false, agentDisk = false } = {}) => deleteLearning(given, agentId, learningFolderOf(data, agentId), {
    keepResetLedger,
    elsewhere: async () => {
      for (const diskId of await learningDisksOf(agentId, agentDisk)) {
        try {
          await archil.removeLearningFolder(agentId, diskId);
        } catch (error) {
          if (!(error instanceof ApiError && ["unavailable", "upstream_failed"].includes(error.code))) throw error;
          throw new ApiError("unavailable", `${error.message.replace(/[.\s]*$/, "")}. The agent's learning folder on this server and its learning records are kept: send the DELETE again once it can be reached.`, { retry_after_ms: 5_000 });
        }
      }
    },
  }));
  /** What DELETE /agents/{id} does outside the store's rows, on this server (agent-delete.ts AgentDeleteHost). */
  const agentDeleteHost: AgentDeleteHost = {
    store,
    deleteLearning: learningDelete,
    refuse: async (agentId) => void (await triggers.agentArchived(agentId)),
    cancel: async (runId) => {
      const moment = await momentOverStore(store, runId, viewDepsFor(ownOriginOf()));
      if (!moment) return true;
      if (moment.importedSource !== undefined) return false;
      try {
        await cancel(store, moment);
        return true;
      } catch (error) {
        // An SDK run: only its application ends it (runs-over-store.ts refuseSdkStop).
        if (error instanceof ApiError && error.code === "not_continuable") return false;
        throw error;
      }
    },
    removeTriggerThere: (triggerId) => notYetWith(() => triggers.removeThere(triggerId)),
    removeTriggerSettings: (triggerId) => triggers.removeSettings(triggerId),
    removeTrigger: (triggerId) => triggers.removeHere(triggerId),
    forgetSignIns: (agentId) => notYetWith(() => signIns.forgetAll(agentId)),
    removeOwnComputer: async (agentId) => {
      // Archived, the agent has no use for its own computer: deleted at its provider now, waited for.
      await reconcileAgentComputer(store, agentId, (provider, image) => computersOf().providerFor(provider, image));
      const left = await agentComputerOf(store, agentId);
      if (left) throw new ApiError("unavailable", `The agent ${agentId}'s own computer ${left.name} is not deleted yet${left.why ? ` (${left.why})` : ""}. It starts no run meanwhile: send the DELETE again to finish it.`, { retry_after_ms: 5_000 });
      await store.settings.remove(agentComputerHoldKey(agentId));
    },
    removeDisk: async (agentId) => {
      // The disk stored on the agent, read whatever the Archil settings are now: with Archil off the route below removes
      // nothing, and the agent's row going would leave its disk at Archil with nothing here to reach it.
      const stored = await agentDiskOf(store, agentId);
      if (!stored) return;
      if (!(await archil.agentView(agentId)).on) throw new ApiError("unavailable", `The agent ${agentId}'s Archil disk ${stored.diskId} is not deleted yet: Archil is off on this server, so it can't be deleted there. Turn Archil on again (PUT /v2/workspace/archil). ${AGAIN}`, { retry_after_ms: 5_000 });
      // Archil's failure (424), a live run of another agent on the disk (412) or no key (503): each is retried by the next DELETE.
      await notYetWith(() => archil.removeAgentDisk({ id: agentId, archived: true, external: true, liveOn: (diskId: string) => liveRunsOnDisk(store.runs, agentId, diskId) }), ["upstream_failed", "precondition_failed", "unavailable"]);
    },
    forgetRun: async (agentId, runId, alone) => {
      const again = alone ? RUN_AGAIN : AGAIN;
      // Its own folder on a disk its launch named (the caller's disk, which stays): read from its launch record, which goes
      // with the run's rows after this, so a failure or a stop here leaves the record that names the disk for the next
      // DELETE. A run on its agent's own disk: with its agent's delete that disk went whole (removeDisk), its folder with
      // it; deleted alone, its folder there is deleted, the disk kept, read from its disk setting, which goes after.
      const launched = await store.runs.launch(runId).then((row) => readLaunchBody(row.body)?.archilDisk, (error: unknown) => (error instanceof StoreLaunchMissing ? undefined : Promise.reject(error)));
      // The agent's learning folder there too: a Mode 2 end wrote the run's diff and correction in it, and nothing reads it.
      if (launched?.kind === "launch") {
        await notYetWith(() => archil.removeRunFolder(agentId, runId, launched.diskId), ["unavailable", "upstream_failed"], again);
        await notYetWith(() => archil.removeLearningFolder(agentId, launched.diskId), ["unavailable", "upstream_failed"], again);
      } else if (alone) {
        const own = launched?.diskId ?? (await runDiskKept(store, runId));
        if (own) await notYetWith(() => archil.removeRunFolder(agentId, runId, own, "agent"), ["unavailable", "upstream_failed"], again);
      }
      // The run's folder (its work and what sits beside it), its scratch and its native context, on this machine.
      for (const folder of [dirname(runFolder(data, agentId, runId)), scratchFolder(data, agentId, runId), join(data, "native-context", runId)]) await rm(folder, { recursive: true, force: true });
      // Its settings: an SDK run's row, its browser wait's end, the Archil disk it resolved to. Its kept computer's row
      // (workspace/computer-kept.ts) is left to the janitor, which deletes the computer of a run no longer there and then
      // the row: removed here, the computer would have nothing left to reach it.
      await store.settings.remove(sdkRunKey(runId));
      await store.settings.remove(waitEndedKey(runId));
      await store.settings.remove(runDiskKey(runId));
      await forgetKept("run", runId);
    },
    forgetAgent: async (agentId) => {
      // The agent's folder (its runs' folders, its home, its learning folder) and its scratch folder.
      await rm(agentFolder(data, agentId), { recursive: true, force: true });
      await rm(join(data, "scratch", agentDirName(agentId)), { recursive: true, force: true });
      // Private source metadata is owned by this exact agent. Prefix siblings with dotted IDs are left alone.
      for (const key of [`source-sync.agent.${agentId}`, `source-sync.local.${agentId}`]) await store.settings.remove(key);
      for (const prefix of [`source-sync.tool.${agentId}.`, `source-sync.checkpoint.${agentId}.`]) {
        for (const row of await store.settings.all({ prefix })) if (/^[a-f0-9]{64}$/.test(row.key.slice(prefix.length))) await store.settings.remove(row.key);
      }
      await forgetKept("agent", agentId);
    },
    // The replay runs of its input, its audit's shadow run and a learning run it names (the store's), and its audit's shadow
    // run by its id (one whose launch is gone too).
    madeFrom: async (runId) => [...new Set([...(await store.runs.madeFrom(runId)), shadowRunId(runId)])],
    // Its copies in the agent's promotion records, then its text off the agent's learning folder's current files (its
    // merges' diff files and feedback lines), in the agent's queue: a folder that can't be written now is 503, the run
    // purged or kept as the purge had got, and the next DELETE does it again.
    forgetCopies: async (agentId, runId) => {
      await forgetRunCopies(store.settings, agentId, runId);
      await notYetWith(() => forgetRunLearning(data, agentId, runId, store), ["unavailable"], "The agent's learning folder keeps the run's text until the DELETE is sent again.");
    },
    // /usage's meters and a live read's spend, from its journal, as they read now (store-reads/cap.ts), and how its
    // learning ended as /stats counts it (its state and reason alone).
    kept: async (runId) => {
      const spend = await spendOverStore(store, runId, ctx);
      const learning = await runLearningEnd(store, runId);
      return {
        meters: await metersOverStore(store, runId, ctx),
        spend: { usd: spend.usd, ...(spend.basis === undefined ? {} : { basis: spend.basis }) },
        learning: learning ? { state: learning.state, reason: learning.reason } : null,
      };
    },
    turnOver: async (runId) => {
      const read = await runStatusState(runId);
      return read.state === "idle" && read.status !== "paused";
    },
    waitMs: options.agentDeleteWaitMs ?? 30_000,
    pollMs: 200,
    ...(options.agentDeleteAt ? { at: options.agentDeleteAt } : {}),
  };
  /** What DELETE /agents/{id}/learning does outside the learning module (learning-reset.ts): the agent delete's learning
   *  step, cancel path and wait, and the agent's learning queue, where a run's start reads its seed. */
  const learningResetHost: LearningResetHost = {
    store,
    deleteLearning: learningDelete,
    cancel: agentDeleteHost.cancel,
    inQueue: (agentId, work) => withAgentRepo(data, agentId, work),
    waitMs: agentDeleteHost.waitMs,
    pollMs: agentDeleteHost.pollMs,
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
    const text = stable(body);
    const fingerprint = fingerprintOf(text);
    const now = Date.now();
    for (const [k, v] of idempotency) if (now - v.at > IDEMPOTENCY_TTL_S * 1000) idempotency.delete(k);
    for (const [k, at] of forgotten) if (now - at > IDEMPOTENCY_TTL_S * 1000) forgotten.delete(k);
    const known = idempotency.get(slot);
    if (known) {
      if (known.fingerprint !== fingerprint) throw mismatch();
      if (!known.answer) throw new ApiError("idempotency_in_progress", "the first request with this Idempotency-Key is still in flight", { retry_after_ms: 500 });
      return { ...known.answer, body: pageFor(req, known.answer.body), headers: { ...known.answer.headers, "idempotent-replayed": "true" } };
    }
    idempotency.set(slot, { fingerprint, at: now });
    let answer: { status: number; body: unknown; headers?: Record<string, string> };
    try {
      // The run's origin keeps the SHA-256 it always has: a run the store made under a key before this start compares to it.
      answer = await work({ key: `idk_${sha256Hex(slot).slice(0, 32)}`, fingerprint: sha256Hex(text) });
    } catch (error) {
      idempotency.delete(slot);
      throw error;
    }
    await options.beforeKeep?.(path, answer.body);
    // A DELETE /agents/{id} that forgot the run or agent this answer names while the work was in flight (forgetKept): the
    // key keeps no answer, so it never replays a deleted run, even after a restart. The request's own answer is given.
    // Read and dropped with no wait in between, so no sweep comes between them.
    if (keptForgotten(path, answer.body)) {
      idempotency.delete(slot);
      return answer;
    }
    // The work happened, so the key keeps its answer in memory even when the file write fails: a retry replays it
    // instead of doing the work twice. Only a restart before the next good save loses it, and a run's create not even
    // then: the store keeps its run under the key's origin.
    idempotency.set(slot, { fingerprint, at: now, answer: { status: answer.status, body: replayed(path, answer.body), headers: answer.headers ?? {} } });
    await keep().catch((error: Error) => void process.stderr.write(`agentrun-serve: idempotency save: ${error.message}\n`));
    return answer;
  }

  // ---- runs -----------------------------------------------------------------------------------------------------------

  /** Why a run of the agent's current revision started now with no overrides would be refused (409 agent_not_runnable),
   *  as the run's own check says it (runnable, at the place the run resolves to): its message and fields, for the agent
   *  page to show before Run. Null when nothing keeps it from running, for an agent with no revision or archived (its
   *  page says so), or when the check is not one a read makes: a native or SDK agent's (which launches or asks its
   *  backend), and a revision whose MCP tools its first run pins (pinFirst writes the pin; until then a read would warn
   *  of a pin the run makes). A read asks no other service, so it prices by readDecisionPrice. */
  async function runBlockersOf(entry: AgentEntry): Promise<{ message: string; fields: InputIssue[] } | null> {
    const revision = entry.revision as unknown as Revision | undefined;
    if (!revision || entry.agent.archivedAt) return null;
    const body = revision.body as AgenticBody & Partial<WorkflowBody>;
    if (nativeOf(body) || sdkOf(body)) return null;
    const tools = revision.kind === "agentic" ? (body.tools ?? []) : [];
    if (!(revision as { mcpPin?: unknown }).mcpPin && tools.some((tool) => mcpToolOf(tool))) return null;
    try {
      await runnable(revision, resolvePlace(body.place as Place | undefined, fallbackPlace(revision.kind, tools)), { capped: body.maxCostUsd !== undefined, price: readDecisionPrice });
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "agent_not_runnable") return { message: error.message, fields: error.extra.fields ?? [] };
      return null;
    }
  }

  /** A workflow revision's shape as runnable.ts checks it: its workflow, tools, harness, place and tool settings. */
  const workflowShape = ({ workflow, tools, harness, place, toolSettings, approvals }: { workflow: unknown; tools?: readonly string[]; harness?: string; place?: RevisionShape["place"]; toolSettings?: RevisionShape["toolSettings"]; approvals?: "never" }): RevisionShape => ({ kind: "workflow", workflow, tools: tools ?? [], ...(harness ? { harness } : {}), ...(place ? { place } : {}), ...(toolSettings ? { toolSettings } : {}), ...(approvals === "never" ? { approvals } : {}) });
  const shapeOf = (revision: Revision): RevisionShape => (revision.kind === "agentic" ? { kind: "agentic", ...revision.body } : workflowShape(revision.body));

  /** What keeps `revision` from running here at `place` (its own, else this host's default), checked before anything
   *  starts with the checks a save makes (runnable.ts): one a save refused, or one a setting of this host fixes that it
   *  does not have yet. `capped`: the run has a spend cap, which a web tool's resolution reads (tool-plane.ts). `price`:
   *  what prices an OpenRouter decision model under that cap; a start's reads OpenRouter's catalog (decisionPrice).
   *  `carried`: the names of the tool keys the run carries (run-keys.ts), each read as one this host holds. `held`: the
   *  run holds its computer (hold: true): kept from running by its model alone, it is not refused, and the refusal is
   *  returned for its launch, its start to answer it (computer-held.ts). */
  async function runnable(revision: Revision, place: Place, { capped = false, price = decisionPrice, carried = [], held = false }: { capped?: boolean; price?: (model: string) => Promise<unknown>; carried?: readonly string[]; held?: boolean } = {}): Promise<HeldRefusal | undefined> {
    if (cliLearningOf(revision.body)) throw new ApiError("agent_not_runnable", "Continue in the original CLI session; this connection records learning without launching its tools.");
    if (sdkOf(revision.body)) throw new ApiError("agent_not_runnable", "This agent runs in its backend SDK. Call its SDK wrapper to start a task; AgentRun does not launch its tools or credentials.");
    const native = nativeOf(revision.body);
    if (native) {
      const overrides = nativeModelOverrides(revision.body);
      if (overrides.length) throw new ApiError("agent_not_runnable", NATIVE_MODEL_SETTINGS_UNSUPPORTED, { fields: overrides.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_MODEL_SETTINGS_UNSUPPORTED })) });
      const execution = nativeExecutionOverrides(revision.body);
      if (execution.length) throw new ApiError("agent_not_runnable", NATIVE_EXECUTION_SETTINGS_UNSUPPORTED, { fields: execution.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_EXECUTION_SETTINGS_UNSUPPORTED })) });
      if (((revision.body as { maxToolCalls?: number }).maxToolCalls ?? 0) > 0) throw new ApiError("agent_not_runnable", NATIVE_TOOL_BUDGET_UNSUPPORTED, { fields: [{ field: "definition.max_tool_calls", reason: "not_an_option", message: NATIVE_TOOL_BUDGET_UNSUPPORTED }] });
      if (!native.remote && (options.apiOnly || options.publicUrl || !isLoopback(host))) throw new ApiError("agent_not_runnable", "Native connections run only on an AgentRun server bound to loopback on the source machine, without a public URL.");
      if (capped) throw new ApiError("agent_not_runnable", NATIVE_CAP_UNSUPPORTED);
      if(native.remote)await new RemoteConnectors(store).assertReady(native);else await launchNative(native); return;
    }
    const shape = { ...shapeOf(revision), place, ...(revision.body.place ? {} : { unnamed: true as const }) };
    // An agentic revision's MCP tools are checked as its save pinned them (its pin, never the server's listing now), for
    // a server still saved here; a granted tool its pin does not hold is said first, with how to pin it.
    const pin = ((revision as { mcpPin?: unknown }).mcpPin ?? {}) as McpPin;
    if (revision.kind === "agentic") {
      const unpinned = ((revision.body as { tools?: readonly string[] }).tools ?? []).flatMap((tool, index) => {
        const named = mcpToolOf(tool);
        if (!named || !mcpMeta.has(named.server)) return [];
        const pinned = Object.hasOwn(pin, named.server) && pin[named.server]!.tools.some((one) => one.name === named.tool);
        if (pinned) return [];
        // Its first run could not pin it (mcp-pin-first.ts) because this server refuses its server's address: a loopback
        // one on a server whose operator never said it is a local install. Saving again is refused the same way, so the
        // words say the cause, as the save's refusal does (mcp-servers-store.ts reached).
        const at = URL.parse(mcpMeta.get(named.server)!.url)?.hostname ?? "";
        const why = options.mcpLoopback !== true && LOOPBACK.test(at) ? `its server ${named.server} can't be listed here to pin it: ${loopbackWords(at)}` : "save the agent again to pin it.";
        return [{ field: `definition.tools[${index}]`, reason: "not_an_option", message: `The MCP tool ${tool} was not pinned when this revision was saved: ${why}`, tool }];
      });
      if (unpinned.length) throw new ApiError("agent_not_runnable", unpinned.map((one) => one.message).join(" "), { fields: unpinned.map(({ tool: _tool, ...issue }) => issue), details: { unbound: unpinned.map((one) => one.tool), missing: {} } });
      // A granted tool of a Composio server that reads its key from the environment (api_key_env) while that variable is
      // unset, or whose address is off Composio's origin: refused by its name before the run starts, never launched
      // without the server's tools, and nothing sent (composioEnvKey).
      const unset = ((revision.body as { tools?: readonly string[] }).tools ?? []).flatMap((tool, index) => {
        const named = mcpToolOf(tool);
        const saved = named ? mcpMeta.get(named.server) : undefined;
        const keyEnv = saved?.keyEnv as typeof COMPOSIO_KEY_ENV | undefined;
        const got = named && saved && keyEnv ? composioEnvKey(named.server, saved.url, keyEnv, mcpServers.composioOrigin) : undefined;
        return got && "refused" in got ? [{ field: `definition.tools[${index}]`, reason: got.reason, message: got.refused, tool, keyEnv: keyEnv!, unset: got.reason === "missing" }] : [];
      });
      if (unset.length) throw new ApiError("agent_not_runnable", [...new Set(unset.map((one) => one.message))].join(" "), { fields: unset.map(({ tool: _tool, keyEnv: _keyEnv, unset: _unset, ...issue }) => issue), details: { unbound: [], missing: Object.fromEntries(unset.filter((one) => one.unset).map((one) => [one.tool, [one.keyEnv]])) } });
    }
    const pinnedTools = (server: string) => {
      const saved = mcpMeta.get(server);
      if (!saved || !Object.hasOwn(pin, server)) return undefined;
      // A meta tool at the URL it was pinned on or at the server's URL now (a server moved to a provider's host since).
      return pin[server]!.tools.map((tool) => {
        const meta = metaToolOf(pin[server]!.url, tool.name) ?? metaToolOf(saved.url, tool.name);
        return meta ? { ...tool, grantable: false as const, reason: meta.reason } : tool;
      });
    };
    const monid = (revision as { monidPin?: MonidPinBody | null }).monidPin ?? undefined;
    // Under the run-keys setting, a template's tool key this host does not hold is each run's to carry: one that does not
    // is refused for it alone, before the checks that read the keys it would bring.
    const owed = options.runKeys ? keysOwed(revision, env, carried) : [];
    if (owed.length) throw keysOwedRefusal(owed);
    // Claude Code's login on this machine is a runner place's alone: a sandbox run is checked for a key, as it runs.
    const blockers = await blockersOf(withCarried(envAtPlace(env, shape.place), carried), shape, settings.get(), { capped, boxes: boxOffers, computerReady, shellOf, offers, mcp: revision.kind === "agentic" ? pinnedTools : mcpTools, monid, decisionPrice: price });
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
    if (revision.kind === "agentic") {
      const details = { unbound, missing, ...named };
      // A held run kept from running by its model alone opens: its computer is its owner's to call, and these words are
      // its start's refusal (computer-held.ts). Any other blocker refuses it here, as any run.
      if (held && blockers.every((b) => b.model)) return { message, fields, details };
      throw new ApiError("agent_not_runnable", message, { fields, details });
    }
    const tier = blockers.find((b) => b.tier)?.tier;
    const decisions = Object.fromEntries(blockers.flatMap((b) => (b.decision ? [[b.decision.provider, { reason: b.reason, needs: b.decision.needs }]] : [])));
    const denied = blockers.flatMap((b) => (b.denied ? [b.denied] : []));
    const asks = blockers.flatMap((b) => (b.asks ? [b.asks] : []));
    throw new ApiError("agent_not_runnable", message, { fields, details: { adapters: [...new Set(blockers.flatMap((b) => (b.adapter ? [b.adapter] : [])))], unbound, missing, code: blockers.some((b) => b.codeNodes || b.shell), ...(tier ? { tier } : {}), ...(Object.keys(decisions).length ? { decisions } : {}), ...(denied.length ? { denied } : {}), ...(asks.length ? { asks } : {}), ...named } });
  }

  /** Where a revision of `kind` naming `tools` and no place runs here: the place a new agent would be saved with. */
  const fallbackPlace = (kind: "agentic" | "workflow", tools: readonly unknown[]): Place => defaultPlaceOf(kind, tools, boxOffers, toolOf);

  /** What a save of `revision` pins of the MCP tools it grants (an agentic revision's: a workflow's nodes bind none): each
   *  granted server listed once, now, with its saved credential (McpServersOverStore.pinListing), as `tools` each server's
   *  listing in the harnesses' shape for the save's checks (blockersOf's `mcp`), and `pin` making the pin from them. A server
   *  that cannot be listed keeps the agent's `previous` pin for it when every tool the save grants from it is already
   *  there (an edit that grants nothing new from it, its instructions say); else the save is refused (422) in words naming
   *  it: nothing is saved, and saving again once it answers pins it. */
  async function mcpListingOf(revision: NewRevision, previous?: unknown): Promise<{ tools: (server: string) => ReturnType<typeof mcpTools>; pin: () => McpPin | undefined }> {
    const tools = revision.kind === "agentic" ? ((revision.body as { tools?: readonly string[] }).tools ?? []) : [];
    const granted = tools.filter((tool) => mcpToolOf(tool) !== undefined);
    const listings = new Map<string, NonNullable<Awaited<ReturnType<typeof mcpServers.pinListing>>>>();
    // A server carried from the previous pin, as that pin holds it (its tools already in the harnesses' shape).
    const carried = new Map<string, McpPin[string]>();
    const before = (previous && typeof previous === "object" ? previous : {}) as McpPin;
    const carry = (server: string) => {
      const kept = Object.hasOwn(before, server) ? before[server] : undefined;
      const all = kept && granted.every((tool) => { const named = mcpToolOf(tool)!; return named.server !== server || kept.tools.some((one) => one.name === named.tool); });
      if (all) carried.set(server, kept);
      return all;
    };
    const refused: InputIssue[] = [];
    await Promise.all([...new Set(granted.map((tool) => mcpToolOf(tool)!.server))].map(async (server) => {
      try {
        const listing = await mcpServers.pinListing(server, stopping.signal);
        if (listing) listings.set(server, listing);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (carry(server)) return;
        const why = (error.extra.fields as InputIssue[] | undefined)?.[0]?.message ?? error.message;
        refused.push({ field: `definition.tools[${tools.findIndex((tool) => mcpToolOf(tool)?.server === server)}]`, reason: "unavailable", message: `${sentence(`The MCP server ${server} could not be listed to pin its tools: ${why}`)} Nothing was saved: save again once it answers.` });
      }
    }));
    if (refused.length) throw invalid(refused.sort((a, b) => a.field.localeCompare(b.field)));
    const bound = (server: string) => {
      const kept = carried.get(server);
      // A carried server's tools are checked as pinned, a meta tool marked at its URL then or now (as runnable does).
      if (kept) return kept.tools.map((tool) => { const meta = metaToolOf(kept.url, tool.name) ?? (mcpMeta.has(server) ? metaToolOf(mcpMeta.get(server)!.url, tool.name) : undefined); return meta ? { ...tool, grantable: false as const, reason: meta.reason } : tool; });
      return listings.get(server)?.tools.map((tool) => ({ ...boundTool(tool), ...(tool.grantable === false ? { grantable: false as const, reason: tool.reason! } : {}) }));
    };
    return {
      // A workflow's grants are checked on the registry's listing, as before: its nodes bind no MCP tool, so the save refuses them.
      tools: revision.kind === "agentic" ? bound : mcpTools,
      pin: () => {
        if (!granted.length) return undefined;
        try {
          return mcpPinOf(granted, { server: (name) => { const kept = carried.get(name); if (kept) return kept; const listing = listings.get(name); return listing && { url: listing.url, tools: listing.tools.map(boundTool), prices: listing.prices, toolkit: listing.toolkit }; } });
        } catch (error) {
          throw invalid([{ field: "definition.tools", reason: "not_an_option", message: (error as Error).message }]);
        }
      },
    };
  }

  /** The revision a run starts on, its MCP tools pinned: one saved with no pin that grants a tool of a server saved here is
   *  pinned at this, its first run (mcp-pin-first.ts pinFirst, the claim's path too). One that can't be (a server that
   *  can't be listed, or no longer lists a granted tool) is left unpinned, and runnable refuses it (409) as before. */
  async function pinFirst(revision: Revision): Promise<Revision> {
    if (((revision as { mcpPin?: unknown }).mcpPin ?? null) !== null) return revision;
    const pin = await pinFirstOf(revision, { saved: (server) => mcpMeta.has(server), pinListing: (server) => mcpServers.pinListing(server, stopping.signal), pinOnce: (id, made) => store.agents.pinOnce(id, made) });
    return pin ? ({ ...revision, mcpPin: pin } as unknown as Revision) : revision;
  }


  /** A definition being saved: refused (422 by field) when it can never run here; else what this host still lacks, and
   *  its pins (mcpListingOf, monidPinOf), each carrying from `previous` what its grants did not change. A revision that
   *  names no place is checked where it would run (fallbackPlace). */
  async function saveable(revision: NewRevision, previous?: RevisionRow | null): Promise<{ warnings: InputIssue[]; stamp: SaveStamp }> {
    // The store's NewRevision keeps the revision's fields under `body` (AgenticBody|WorkflowBody); build the flat shape the
    // host checks (runnable.ts RevisionShape) from it, as shapeOf does for a run's Revision.
    const body = revision.body as AgenticBody & Partial<WorkflowBody>;
    if (nativeOf(body)) {
      const overrides = nativeModelOverrides(body);
      if (overrides.length) throw invalid(overrides.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_MODEL_SETTINGS_UNSUPPORTED })));
      const execution = nativeExecutionOverrides(body);
      if (execution.length) throw invalid(execution.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_EXECUTION_SETTINGS_UNSUPPORTED })));
      return { warnings: [], stamp: {} };
    }
    if (cliLearningOf(body) || sdkOf(body)) return { warnings: [], stamp: {} };
    // An agent on a harness that installs on first use starts its install, if it is not in yet: its first run waits for less.
    const harnessId = revision.kind === "agentic" ? harnessOfBody(body) : undefined;
    const install = harnessId !== undefined && Object.hasOwn(installs, harnessId) ? installs[harnessId] : undefined;
    if (install) {
      void install.ensure().catch((error: Error) => log?.(logLine("harness_install_failed", { harness: install.entry.id, message: error.message })));
    }
    const named = (revision.kind === "agentic" ? { kind: "agentic" as const, ...(body as AgenticBody) } : workflowShape(body as never)) as unknown as RevisionShape;
    const shape = named.place ? named : { ...named, place: fallbackPlace(named.kind, named.tools ?? []), unnamed: true as const };
    const listing = await mcpListingOf(revision, previous?.mcpPin);
    const mcp = listing.tools;
    const { monid, warnings: usage = [] } = (await monidPinOf(revision, previous)) ?? {};
    const blockers = await blockersOf(envAtPlace(env, shape.place), shape, settings.get(), { boxes: boxOffers, computerReady, shellOf, offers, mcp, monid });
    // An agent's default cap caps each run started without one of its own, and a web tool resolves by the cap: what a cap
    // alone keeps from running under the definition's own picks, whatever this host's settings, would keep every such run
    // from running, so the save is refused, not each run (claude-agent's or codex's own search, picked, under a cap).
    if ((body.maxCostUsd ?? 0) > 0) {
      const key = (b: Blocker) => `${b.field}\n${b.message}`;
      const plain = new Set((await blockersOf(env, shape, {}, { boxes: boxOffers, computerReady, shellOf, offers, mcp, monid })).map(key));
      const capped = await blockersOf(env, shape, {}, { capped: true, capUsd: body.maxCostUsd, boxes: boxOffers, computerReady, shellOf, offers, mcp, monid, decisionPrice });
      // A model with no price (`unpriced`) is a setting this host fixes (AGENT_MODEL_PRICE): a warning, as it is; the
      // agent saves and updates, and only a run under the cap is refused (409). So is a cap below what the model needs for
      // one more step and an answer (`short`): the agent saves, and its runs wrap up at their first tool call. A tool's
      // pick a cap rules out refuses it.
      const added = capped.filter((b) => !plain.has(key(b)));
      blockers.push(...added.filter((b) => b.unpriced || b.short));
      blockers.push(...added.filter((b) => !b.unpriced && !b.short).map((b) => ({ ...b, reason: "not_an_option", fix: "Pick another provider for this tool in definition.tool_settings, or clear the agent's default cap (max_cost_usd: 0).", host: false })));
    }
    const never = blockers.filter((b) => !b.host);
    if (never.length) throw invalid(never.map(issueOf));
    const mcpPin = listing.pin();
    // A computer every tool of which is set to deny, here or in the agent's own settings: its runs never start it.
    const denied = await deniedComputer(shape, settings.get(), shellOf);
    const off: InputIssue[] = denied ? [{ field: "definition.computer", reason: "not_allowed", message: computerDeniedWords(denied) }] : [];
    return { warnings: [...blockers.map(issueOf), ...off, ...usage], stamp: { ...(mcpPin ? { mcpPin } : {}), ...(monid ? { monidPin: monid } : {}) } };
  }

  /** An agentic `revision`'s monid pin (monid.ts pinMonid) and a warning per endpoint priced by usage; a grant that
   *  cannot be pinned refuses the save (422). Undefined when it grants none. */
  async function monidPinOf(revision: NewRevision, previous?: RevisionRow | null): Promise<{ monid: MonidPinBody; warnings: InputIssue[] } | undefined> {
    if (revision.kind !== "agentic") return undefined;
    const tools = (revision.body as AgenticBody).tools ?? [];
    const send = await checkFetch("monid");
    const before = previous?.kind === "agentic" ? { grants: (previous.body as AgenticBody).tools ?? [], pin: previous.monidPin } : undefined;
    // The key as the server reads it (env: what it was started with, its handed secrets and its saved keys).
    const pinned = await pinMonid(tools, { key: env[MONID_KEY_ENV]?.trim(), fetch: send ?? (async () => { throw new Error("no fake of monid's API under faux"); }), signal: stopping.signal, ...(before ? { previous: before } : {}) });
    if (pinned && "refused" in pinned) throw invalid(pinned.refused.map(({ tool, message }) => ({ field: tools.includes(tool) ? `definition.tools[${tools.indexOf(tool)}]` : "definition.tools", reason: "not_an_option", message })));
    return pinned && { monid: pinned.pin, warnings: pinned.warnings.map(({ tool, message }) => ({ field: `definition.tools[${tools.indexOf(tool)}]`, reason: PRICED_BY_USAGE, message })) };
  }

  /** The tools an agentic definition that names none is given where it runs (`place`): in a box, the box's shell tools
   *  (NEW_AGENT_TOOLS); elsewhere none named, the runner's own. One rule for a new agent (createAgentOf) and for an apply
   *  with agent_id of a package that names none (applyWith), whose agent is where its fresh apply put it. */
  const defaultToolsAt = (place: unknown): readonly string[] | undefined => (isObject(place) && place.mode === "sandbox" ? NEW_AGENT_TOOLS : undefined);

  /** The definition an apply with agent_id writes onto agent `entry` from its package's `definition`: its id and name are
   *  the agent's own, kept from its creation, and its description is the agent's as it is now (an edit may have changed
   *  it; the package's never overwrites it); a package that names no tools gets those its agent's place
   *  gives one (defaultToolsAt: the shell tools in the box its fresh apply put it in), as a fresh apply would. */
  const updateDefinition = (entry: AgentEntry, definition: Json): Json => {
    const kept = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "name" && key !== "description"));
    const current = (entry.revision?.body ?? {}) as { place?: unknown };
    const tools = kept.tools === undefined && kept.workflow === undefined && kept.computer === undefined ? defaultToolsAt(kept.place ?? current.place) : undefined;
    return tools ? { ...kept, tools: [...tools] } : kept;
  };

  /** POST /agents' body made into its agent, as that route makes one, with what this host still lacks for it. A new agent
   *  that names no place is given this server's box (place.ts defaultPlaceOf), stamped on its revision, when it names no
   *  tools (it gets bash) or a tool that needs a shell; one whose tools need none, or that names a tool the box refuses
   *  (browser), keeps the runner. */
  async function createAgentOf(body: Json, template?: TemplatePackage): Promise<{ entry: AgentEntry; warnings: InputIssue[] }> {
    let warnings: InputIssue[] = [];
    const definition = checkDefinitionBody(body, { harnesses });
    const named = Array.isArray(definition.definition.tools) ? definition.definition.tools : [];
    const place = fallbackPlace("agentic", definition.definition.tools === undefined ? NEW_AGENT_TOOLS : named);
    const tools = defaultToolsAt(place);
    const entry = await agents.create(definition, async (revision) => {
      const saved = await saveable(revision);
      warnings = saved.warnings;
      return saved.stamp;
    }, place.mode === "sandbox" && tools ? { place, tools } : undefined, template);
    return { entry, warnings };
  }

  /** A definition edit's body made into a new revision of agent `entry`, as PUT /agents/{id}/definition makes one
   *  (commitAgent: the definition's checks and what this host refuses of it, saveable), with what this host still lacks for
   *  it; then its computer reconciled. `template`: the package an apply with agent_id wrote it from; `fromPackage`: the
   *  body is that package's whole definition, so what it leaves out that the package owns is gone (commitAgent). */
  async function reviseAgentOf(entry: AgentEntry, body: Json, options: { contract?: boolean; ifCurrent?: string | null; template?: TemplatePackage; fromPackage?: boolean } = {}): Promise<{ entry: AgentEntry; warnings: InputIssue[] }> {
    let warnings: InputIssue[] = [];
    const check = async (revision: NewRevision, on: RevisionRow | null) => {
      // The pins of the revision this try builds on (commitAgent's read, a retry's newer one) carry what it kept.
      const saved = await saveable(revision, on);
      warnings = saved.warnings;
      return saved.stamp;
    };
    // Its last read and its commit in the agent's delete turn (agentWrite), the check outside it: an edit or a template
    // update whose commit comes once the agent is purged is 410, and one after a purge stopped part way is 409, nothing
    // written (the store refuses a purged agent's revision too, AgentPurged).
    const edited = await agents.commit(entry, checkDefinitionBody(body, { creating: false, harnesses }), { check, prepare: prepareProjectSkillEdit(store, entry.agent.id, sourceWorkspaces), ...options, inTurn: (work) => agentWrite(entry.agent.id, work) });
    reconcileComputer(entry.agent.id);
    return { entry: edited, warnings };
  }

  /** The agent an apply with agent_id writes onto: one the template `pkg` made (the package id its revisions keep), live.
   *  None by that id is 404; one made otherwise, or from another template, is 422 under agent_id, in words that say which;
   *  an archived one is 409 agent_archived. */
  async function templateAgentOf(id: string, pkg: Package): Promise<AgentEntry> {
    const entry = await needAgent(id);
    const from = entry.template?.id;
    if (from !== pkg.id) {
      const message = from
        ? `The agent ${id} was made from the ${from} template, not ${pkg.id}: apply ${from} with agent_id to update it, or apply ${pkg.id} without agent_id to make a new agent.`
        : `The agent ${id} was not made from a template, so the ${pkg.name} template can't update it: apply without agent_id to make a new agent.`;
      throw invalid([{ field: "agent_id", reason: "not_an_option", message }]);
    }
    if (entry.agent.archivedAt) throw new ApiError("agent_archived", `The agent ${id} is archived: unarchive it, then apply the ${pkg.name} template onto it again.`);
    return entry;
  }

  /** A replay's ports for agent `entry` (runner/promotion.ts askReplay, replayView): its learning folder where this server
   *  reads it, cut of the host's secrets as the learning reads cut them, and a replay run's launch made as a run's start
   *  makes one now (prepareLaunch: the agent's current revision, model, plane and learning start). */
  const replayAskOf = (entry: AgentEntry): ReplayAsk => ({
    admitAuxiliary: auxiliaryAdmitter(store, { data, project: startDeps.project }),
    store, agentId: entry.agent.id, context: ctx, log: (line) => void log?.(line),
    folder: () => learningFolderOf(data, entry.agent.id), shown: () => learningShown(entry.agent.id),
    launchOf: async (input) => {
      const { launch, revision } = await prepareLaunch(startDeps, entry, { input });
      return { launch, revisionId: revision.id };
    },
  });
  /** `act`, its ReplayRefused answered as the API's: 404 not_found, or 409 replay_conflict, in its words. */
  const replayAsked = async <T>(act: () => Promise<T>): Promise<T> => {
    try {
      return await act();
    } catch (error) {
      if (error instanceof ReplayRefused) throw new ApiError(error.kind === "missing" ? "not_found" : "replay_conflict", error.message);
      throw error;
    }
  };

  /** A template package applied: its parameters and the owner's grants checked (422), then the secrets and required MCP
   *  servers it names (409, nothing made; an MCP server it can do without is skipped, with a warning), then its
   *  agent made as POST /agents makes one, granted the MCP tools the owner ticked (grants) alone, with no permission written
   *  (each call follows this server's tool settings: a write asks unless the owner allowed it there or approvals never; a deny the owner set on this server stays,
   *  with a warning): a tool left unticked is not the agent's, under any approvals, its body held to POST /agents' limit (413), on the first harness of its list this server runs and the model packageModel
   *  picks, then each trigger on it as POST /triggers makes one. A trigger refused undoes the apply: the triggers made
   *  before it are deleted and the agent is archived (an agent store keeps every agent), and the refusal is the answer, a 422's fields under `triggers.<i>`; a
   *  github trigger GitHub is not connected for is skipped instead, with a warning there, and one made is said there. A webhook
   *  trigger's secret is not in the answer (the Idempotency-Key record would keep it): POST /triggers/{id}/secret makes one.
   *  With `agent_id` (an agent this template made, templateAgentOf), the same checks, then a new revision of that agent in
   *  place of a new one (its runs and its learning stay), and its triggers reconciled by name (below); a refused trigger
   *  removes the ones this apply made, and the agent is not archived. A fresh apply warns of a live agent the same
   *  package and parameters made (the keyed digest of the parameters kept on its revision: never the parameters).
   *
   *  Overlapping updates of one agent: this server runs them one after the other (`applying`, a chain per agent id), each
   *  from its read of the agent to its last trigger removed, so two never reconcile the same triggers at once. And each
   *  writes its revision only onto the revision it read (ifCurrent): one whose read went stale meanwhile (an edit, or an
   *  apply on another server) is 412 precondition_failed before it touches a trigger. Across several servers sharing one
   *  store the chain is per process, so the 412 is what holds there. */
  async function applyTemplate(template: Package, body: Json) {
    const id = typeof body.agent_id === "string" && body.agent_id.trim() ? body.agent_id.trim() : undefined;
    if (id === undefined) return applyWith(template, body);
    const turn = (applying.get(id) ?? Promise.resolve()).then(() => applyWith(template, body));
    const settled = turn.then(() => undefined, () => undefined);
    applying.set(id, settled);
    try {
      return await turn;
    } finally {
      if (applying.get(id) === settled) applying.delete(id);
    }
  }
  /** The template applies with agent_id in flight on this server, by agent id: each one's turn settled (applyTemplate). */
  const applying = new Map<string, Promise<void>>();

  /** A trigger write an update made on its agent's condition (TriggerOwn.onAgent) that found no such trigger there:
   *  false, for one a PATCH moved to another agent (or a delete removed) meanwhile; any other failure as it is. */
  const movedAway = (error: unknown): false => {
    if (error instanceof ApiError && error.code === "not_found") return false;
    throw error;
  };
  /** A fresh apply's twins: the live agents here made from the package `pkgId` with the parameters `digest` digests. The
   *  apply still makes another and warns of each (applyWith); its plan names them first (planTemplate). None for an
   *  apply onto an agent (`onto`). */
  const twinsOf = async (onto: unknown, pkgId: string, digest: string): Promise<string[]> =>
    onto ? [] : (await agents.list()).filter((one) => one.template?.id === pkgId && one.template.parameters_digest === digest).map((one) => one.agent.id);
  /** POST /templates/{id}/apply {dry_run: true}: the apply's plan, from the same reads and checks as the apply
   *  (prepareApply), with nothing written: whether it makes an agent or revises the one agent_id names (and its current
   *  revision), the agents a fresh one would make a twin of, the keys and MCP servers this server lacks (where the apply
   *  would refuse with 409, the plan lists them), what becomes of each trigger (made, changed in place, removed, or
   *  skipped for a connection this server lacks), and the computer it picks. Any other refusal is the apply's own. */
  async function planTemplate(template: Package, body: Json) {
    const p = await prepareApply(template, body, { plan: true });
    // A monid grant is pinned to monid's listing when the agent is saved (saveable: monidPinOf), read with the monid key:
    // with none here the apply is refused, so the plan lists the key. A grant the agent's current pin carries reads
    // nothing (pinMonid with no key answers before any request).
    const definition = isObject(p.made.agent) && isObject(p.made.agent.definition) ? p.made.agent.definition : {};
    const tools = Array.isArray(definition.tools) ? definition.tools.filter((tool): tool is string => typeof tool === "string") : [];
    const was = p.onto?.revision?.kind === "agentic" ? p.onto.revision : undefined;
    const unread = !env[MONID_KEY_ENV]?.trim() && (await pinMonid(tools, { key: undefined, ...(was ? { previous: { grants: (was.body as AgenticBody).tools ?? [], pin: was.monidPin ?? null } } : {}) }));
    const missing = unread && "refused" in unread && !p.missing.includes(MONID_KEY_ENV) ? [...p.missing, MONID_KEY_ENV] : p.missing;
    // A skip's `code` is the apply's warning's for it: not_set_up_here for one this server makes once it is set up (a
    // connection, a feed's URLs, a launch hook), not_an_option for one it never makes.
    const planned: { name: string; kind: string; action: "create" | "update" | "remove" | "skip"; code?: string; reason?: string }[] = [];
    for (const [i, trigger] of p.made.triggers.entries()) {
      const name = String(trigger.name).trim();
      const kind = isObject(trigger.source) ? String(trigger.source.kind) : "";
      // On an API-only server, skipped in the apply's own words (prepareApply).
      const hostSkip = p.hostless.get(i);
      if (hostSkip) {
        planned.push({ name, kind, action: "skip", code: hostSkip.reason, reason: hostSkip.message });
        continue;
      }
      if (p.emptyFeeds.has(i)) {
        planned.push({ name, kind, action: "skip", code: NOT_SET_UP, reason: feedTriggerEmpty(p.pkg.name, trigger, isObject(p.pkg.triggers[i]?.source) ? p.pkg.triggers[i]!.source.urls : undefined) });
        continue;
      }
      const was = p.hadByName.get(name);
      if (was && isObject(was.source) && was.source.kind === kind && !p.remade.has(i)) {
        planned.push({ name, kind, action: "update" });
        continue;
      }
      // Made (again), on unless the owner had turned the old one off: a connection this server lacks skips it, as the
      // apply's create does (notSetUpYet), or refuses the apply. A Composio trigger is skipped for want of a public URL
      // (any trigger, on or off), read here; its account and subscription are Composio's to answer, which a plan never asks.
      const refusal = kind === "composio" && !options.publicUrl ? composioNoPublicUrl() : trigger.enabled !== false && !(was && !was.enabled) ? await triggerUnavailable(kind) : undefined;
      if (refusal && notSetUpYet(kind, refusal.code)) planned.push({ name, kind, action: "skip", code: NOT_SET_UP, reason: refusal.message });
      else if (refusal) throw refusal;
      else planned.push({ name, kind, action: "create", ...(was ? { reason: `The agent's ${name} trigger is removed and made again: its kind or its Composio server, event or config changed.` } : {}) });
    }
    for (const row of p.removing) planned.push({ name: row.name, kind: isObject(row.source) ? String(row.source.kind) : "", action: "remove" });
    const computer = p.pick && !("refused" in p.pick) ? p.pick.computer as { kind: string; provider?: string } : undefined;
    return {
      plan: {
        action: p.onto ? "revise" : "create",
        agent_id: p.onto?.agent.id ?? null,
        current_revision_id: p.onto?.revision?.id ?? null,
        twins: await twinsOf(p.onto, p.pkg.id, p.digest),
        missing_secrets: missing,
        unmatched_mcp: p.unsaved.map((need) => ({ source: need.source, toolkit: need.toolkit, required: need.required })),
        triggers: planned,
        computer: computer ? { kind: computer.kind, provider: computer.provider ?? null } : null,
      },
    };
  }

  /** What an apply reads and checks before its first write, the same for its plan (`plan`) and itself: the body
   *  (applyBodyOf), the agent agent_id names, the keys and MCP servers, the computer, the model, the agent and triggers it
   *  makes and how they meet the agent's, every refusal but the keys' and MCP servers' (which the plan lists). */
  async function prepareApply(template: Package, body: Json, { plan }: { plan: boolean }) {
    const { parameters, grants: asked, servers: picks, model: override, choice, approvals, agentId, revision: expected, sha } = applyBodyOf(template, body);
    // The package the caller read (its sha): another stored under this id since (an upload of the same name) is not what
    // they planned or confirmed.
    if (sha !== undefined && (template.origin?.sha ?? null) !== sha) throw new ApiError("precondition_failed", `The ${template.name} template stored here is not the package of sha ${sha} (another was stored under ${template.id} since): nothing was changed. Read it again (GET /templates), then apply.`);
    // With agent_id, the apply writes a new revision of that agent (one this template made) in place of making another:
    // everything below checks the package as a fresh apply does, through the same code. With `revision`, only onto the
    // revision the caller read: the write below is held to the revision read here (ifCurrent), so one written in between
    // is 412 as well.
    const onto = agentId === undefined ? undefined : await templateAgentOf(agentId, template);
    if (onto && expected !== undefined && (onto.revision?.id ?? null) !== expected) throw new ApiError("precondition_failed", `The agent ${onto.agent.id}'s current revision is ${onto.revision?.id ?? "none"}, not ${expected} (an edit, or another apply, wrote one since it was read): nothing was changed. Read it again, then apply.`);
    // An update's triggers are reconciled by name with the ones the agent has (below), read with the agent: each write to
    // one is made only while it is still this agent's (TriggerOwn.onAgent), so one a PATCH moves away meanwhile is left.
    const had = onto ? await store.triggers.list(onto.agent.id) : [];
    if (onto && !plan && options.templateApplyRead) await options.templateApplyRead(onto.agent.id);
    // A model choice's own keys are needed as the package's are: missing, the apply is refused and nothing is made. Under
    // the run-keys setting, a tool key is each run's to carry (run-keys.ts): its agent is made, the warning says so, and a
    // run that does not carry it is refused. A model key is still the server's, and so is monid's: the agent's monid tools
    // are checked with it when the agent is saved (monidPinOf), before any run.
    const declared = [...new Set([...template.secrets, ...(choice?.secrets ?? [])])].sort();
    const absent = declared.filter((name) => !secret(name, storedKeys));
    const brought = options.runKeys ? absent.filter((name) => TOOL_FIELDS.includes(name) && name !== MONID_KEY_ENV) : [];
    const missing = absent.filter((name) => !brought.includes(name));
    const keyWarnings: InputIssue[] = brought.map((name) => ({ field: `secrets.${name}`, reason: NOT_SET_UP, message: `${name} is not set on this server: it takes it from each run (${RUN_KEYS_ENV}=1), so a run that does not carry it in keys is refused.`, fix: `Send keys.${name} with each run, or add it in Settings → API Keys.` }));
    // Each MCP need on the saved server whose source and toolkit match (the owner's pick when several do, never a silent
    // one: several and no pick is a 422); the package's
    // tool names, mcp:<toolkit>/<tool>, read as that server's from here on (templates.ts onServers).
    const mapped = serversFor(template, [...mcpMeta].map(([name, meta]) => ({ name, ...meta.source })), picks);
    const servers = Object.fromEntries(mapped.flatMap(({ need, server }) => (server ? [[need.toolkit, server]] : [])));
    const pkg = onServers(template, servers);
    const saved: McpServed[] = mapped.flatMap(({ need, server }) => (server ? [{ ...need, server }] : []));
    const unsaved = mapped.filter(({ server }) => !server).map(({ need }) => need);
    // A grant of a need with no server here grants nothing: dropped before the names move, so it never reads as a tool
    // of a saved server that happens to be named as its toolkit.
    const grants = asked.filter((tool) => Object.hasOwn(servers, mcpToolOf(tool)?.server ?? "")).map((tool) => onServerName(tool, servers));
    const needed = unsaved.filter((need) => need.required);
    if (!plan && (missing.length || needed.length)) {
      const fix = "Add it in Settings → API Keys, or set it where AgentRun starts, then apply the template again.";
      throw new ApiError("agent_not_runnable", `The ${pkg.name} template needs ${[...missing, ...needed.map((need) => `a ${need.source} MCP server of the toolkit ${need.toolkit}`)].join(" and ")}, which this server does not have. Nothing was created.`, { fields: [...missing.map((name) => ({ field: `secrets.${name}`, reason: NOT_SET_UP, message: options.runKeys && name === MONID_KEY_ENV ? `${name} is not set on this server, and a run can't bring it (${RUN_KEYS_ENV}=1): the agent's monid tools are checked with this server's key when it is saved.` : `${name} is not set on this server.`, fix })), ...needed.map((need) => ({ field: `mcp.${need.toolkit}`, reason: NOT_SET_UP, message: `No saved MCP server is ${need.source} ${need.toolkit}.`, fix: mcpSetUp(need) }))] });
    }
    // The package's computer list: the first entry this server meets now (templates.ts pickComputer), written as the
    // agent's computer; a fallback, or a shell tool that computer does not run, said under `computer`. A list none of
    // whose entries is met (a shell alone, where there is none) refuses the apply: nothing is made.
    const pick = pickComputer(pkg, await shellHere({ sandbox: Boolean(pkg.needs) }));
    if (pick && "refused" in pick) throw new ApiError("agent_not_runnable", pick.refused, { fields: [{ field: "computer", reason: NOT_SET_UP, message: pick.refused, fix: pick.fix ?? COMPUTER_FIX }] });
    const computerWarnings: InputIssue[] = pick?.note ? [{ field: "computer", reason: pick.entry === "none" ? NOT_SET_UP : "not_an_option", message: pick.note }] : [];
    // An MCP server the package can do without is skipped, and said: its tools are not granted.
    const skipped: InputIssue[] = unsaved.map((need) => ({ field: `mcp.${need.toolkit}`, reason: NOT_SET_UP, message: `No saved MCP server is ${need.source} ${need.toolkit}, so the agent was made without its tools (${need.tools.join(", ")}).`, fix: mcpSetUp(need) }));
    // A model choice the owner picked is its model on its harness, or a refusal naming the model: never the tier's model
    // in its place. So is a package's `prefer` (packageModel's `refused`), outside a gateway. A plan whose keys are
    // missing lists them and goes on: a model refused for want of one of them is the same lack, and once they are added
    // the next plan reads the model again.
    const lacking = plan && missing.length > 0;
    const unrunnable = choice && !lacking && (await choiceUnrunnable(env, choice, offers.find((offer) => offer.id === choice.harness)));
    if (choice && unrunnable) {
      const message = `The ${pkg.name} template's choice ${choice.label} runs ${choice.model} on ${choice.harness}, which this server can't run: ${unrunnable.replace(/\.$/, "")}. Nothing was created.`;
      throw new ApiError("agent_not_runnable", message, { fields: [{ field: "overrides.choice", reason: NOT_SET_UP, message, fix: "Apply with the default or another choice, or, where the model only wants a key, add it in Settings → Model keys." }] });
    }
    const harness = choice ? choice.harness : pkg.harness && (pkg.harness.find((id) => offers.some((offer) => offer.id === id && offer.available)) ?? pkg.harness[0]);
    const picked = choice ? { model: choice.model } : override ? { model: override } : await packageModel(env, pkg.model, harness ?? DEFAULT_HARNESS);
    if ("refused" in picked && picked.refused && !lacking) {
      const message = `The ${pkg.name} template prefers ${pkg.model?.prefer}, which this server can't run on ${harness ?? DEFAULT_HARNESS}: ${picked.refused.why}. Nothing was created.`;
      throw new ApiError("agent_not_runnable", message, { fields: [{ field: "model", reason: NOT_SET_UP, message, fix: picked.refused.fix }] });
    }
    const model = picked.model;
    // Which model the agent got, where it is not the package's: a note, never a lack. The agent runs; only the package's
    // choice was not an option here (not_set_up_here would read as a run refused until the host has something).
    // The model of each tier its subagents run on (packageTiers): the package's where this server runs it.
    const tiers = await packageTiers(env, pkg.model, harness ?? DEFAULT_HARNESS, model);
    const modelWarnings: InputIssue[] = [...("warning" in picked && picked.warning ? [picked.warning] : []), ...(tiers.warning ? [tiers.warning] : [])].map((message) => ({ field: "model", reason: "not_an_option", message }));
    const defaultTools = "place" in newAgentPlace(boxOffers) ? NEW_AGENT_TOOLS : [];
    // A grant never lifts a deny the owner set on this server: that tool keeps it, and the answer says so.
    const server = settings.get() as Parameters<typeof permissionFrom>[1];
    const denied = grants.filter((tool) => { const set = permissionFrom(tool, server); return set.from === "server" && set.permission === "deny"; });
    const kept: InputIssue[] = denied.map((tool) => ({ field: `grants.${tool}`, reason: "not_allowed", message: `${tool} is denied on this server (Settings → Tools), so the agent's runs are refused it until the owner changes that setting.` }));
    // The agent's approvals: the apply's override, else the package's own (a template whose job runs on triggers says
    // never), else ask. Deny and pins hold either way.
    const chosenApprovals = approvals ?? pkg.approvals;
    const made = compiled(pkg, parameters, { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(tiers.modelTiers ? { modelTiers: tiers.modelTiers } : {}), mcp: saved, defaultTools, grants, ...(chosenApprovals ? { approvals: chosenApprovals } : {}), ...(pick ? { computer: pick } : {}) }, templateDeps);
    // Every trigger is checked as POST /triggers checks it, its parameters filled, before anything is made: a schedule
    // from a parameter that does not read, or a date that has passed, refuses the apply (422 under triggers.<i>). "Passed"
    // by the triggers' own clock, the one POST /triggers checks by and they fire by (a template eval case's `now`).
    // A feed trigger whose urls are one array parameter given empty reads no feed: skipped, never the apply (feedLeftEmpty).
    const emptyFeeds = new Set(made.triggers.flatMap((trigger, i) => (feedLeftEmpty(trigger) ? [i] : [])));
    // A trigger is made only when its firings have somewhere to go: on an API-only server, a schedule or a feed with the
    // launch hook set (api-only.ts); under the run-keys setting, for an agent whose runs owe keys, only with the launch
    // hook, the one way a firing's run carries them (run-keys.ts). Each other is said, and stays listed, so a trigger the
    // agent has by its name is left as it is, never removed. One left on still fires, so its skip says so and how to stop it.
    const hooked = options.launchHook !== undefined;
    const hostless = new Map(made.triggers.flatMap((trigger, i) => {
      const skip = (options.apiOnly ? apiOnlyTriggerSkipped(pkg.name, trigger, hooked) : undefined) ?? runKeysTriggerSkipped(pkg.name, trigger, brought, hooked);
      if (!skip) return [];
      const keptOn = had.find((row) => row.enabled && row.name === String(trigger.name).trim());
      // An API-only server serves no trigger route: its archive is what turns the agent's triggers off.
      const off = options.apiOnly ? "archiving the agent turns it off" : `PATCH /v2/triggers/${keptOn?.id} with {"enabled": false} turns it off`;
      return [[i, keptOn ? { ...skip, message: `${skip.message} The agent's trigger ${keptOn.id} of that name is kept as it was, and still fires: ${off}.` } : skip] as const];
    }));
    const unmade = (i: number) => emptyFeeds.has(i) || hostless.has(i);
    const refusedTriggers = madeTriggerIssues(made.triggers, options.triggerClock?.now() ?? Date.now(), pkg.inputSchema).filter((issue) => !unmade(Number(/^triggers\.(\d+)\./.exec(issue.field)?.[1])));
    if (refusedTriggers.length) throw invalid(refusedTriggers);
    // POST /agents' and POST /triggers' own body limit: parameters filled in more than once can grow a package past it.
    for (const one of [made.agent, ...made.triggers]) if (Buffer.byteLength(JSON.stringify(one)) > MAX_BODY) throw new ApiError("payload_too_large", `the ${pkg.name} template, its parameters filled in, makes a body over ${MAX_BODY} bytes`, { details: { limit: "max_body_bytes" } });
    // The package's triggers by name, as this apply makes them (a feed it left empty is not made, so not listed either,
    // except one an API-only server does not make, which leaves each the agent has: hostless above).
    const listed = new Set(made.triggers.flatMap((trigger, i) => (emptyFeeds.has(i) && !hostless.has(i) ? [] : [String(trigger.name).trim()])));
    // The triggers to remove: each of the agent's that an apply of this package marked as its own (TriggerRow.templateId)
    // and whose name the package no longer lists. A trigger the owner made, one a PATCH moved here from another agent (or
    // away and back), and one made before the mark was kept carry none, and are left. One whose removal fails keeps its
    // mark, so the next update removes it.
    const removing = had.filter((row) => row.templateId === pkg.id && !listed.has(row.name));
    const hadByName = new Map(had.map((row) => [row.name, row]));
    // A Composio trigger the update keeps by name whose fixed part is unchanged (its server, event and config, each sealed
    // value the package sends again, filled in from a parameter in the clear, the same as the one sealed:
    // ComposioTriggers.resent) is changed in place, its sealed values left out of the PATCH so it keeps them sealed. One
    // whose fixed part changed (another key too) is made again, as one of another kind is (below): its instance on
    // Composio was made from that part. Read before the revision is written; neither holds a sealed value.
    const resent = new Map<number, Source>();
    const remade = new Set<number>();
    for (const [i, trigger] of made.triggers.entries()) {
      const was = unmade(i) ? undefined : hadByName.get(String(trigger.name).trim());
      if (!was || !isObject(trigger.source) || trigger.source.kind !== "composio" || !isObject(was.source) || was.source.kind !== "composio") continue;
      try {
        resent.set(i, composioTriggers.resent(was.source as Source, was.id, trigger.source as Source));
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "input_invalid")) throw error;
        remade.add(i);
      }
    }
    // A trigger the agent has by a package trigger's name is the package's to keep by its mark (TriggerRow.templateId).
    // Marked with this package, it is changed in place, or made again when its kind or its Composio fixed part changed.
    // Unmarked (the owner's, or made by an apply before the mark was kept: the two can't be told apart), it is adopted only
    // by a change in place, and marked then. Marked with another package, it is not this one's. One this package would
    // have to make again without being its own, or another package's, refuses the apply with nothing written (409 under
    // triggers.<i>): the owner renames or deletes it, then applies again.
    const notOurs: InputIssue[] = made.triggers.flatMap((trigger, i) => {
      const was = unmade(i) ? undefined : hadByName.get(String(trigger.name).trim());
      if (!was || was.templateId === pkg.id) return [];
      const kind = isObject(trigger.source) ? String(trigger.source.kind) : "";
      const wasKind = isObject(was.source) ? String(was.source.kind) : "";
      if (was.templateId === null && kind === wasKind && !remade.has(i)) return [];
      const why = was.templateId !== null
        ? `is another template package's (${was.templateId}), not the ${pkg.name} template's`
        : `is not the ${pkg.name} template's, and keeping it would mean removing it and making it again: ${kind === wasKind ? "its Composio server, event or config differs from the package's" : `it is a ${wasKind} trigger, and the package's is a ${kind} one`}`;
      return [{ field: `triggers.${i}.name`, reason: "not_allowed", message: `The agent's trigger ${was.name} ${why}. Nothing was changed: rename or delete that trigger, then apply the template again.` }];
    });
    if (notOurs.length) throw new ApiError("name_taken", notOurs.length === 1 ? notOurs[0]!.message : `${notOurs.length} of the agent's triggers have the names of the ${pkg.name} template's and are not its own. Nothing was changed: rename or delete each, then apply the template again.`, { fields: notOurs });
    // The agent keeps where it came from (the package on the revision the apply writes): the package's id, version and,
    // imported, its SHA; a keyed digest of the parameters it was given (never the parameters: one may be a credential); and
    // the names of the keys it declared (never a value), which an export names after the server's copy of the package
    // changes, and whose tool keys a run may carry (under the run-keys setting, a run that does not is refused). Which
    // triggers are the package's is on each trigger (its mark), not here.
    const digest = parametersDigest(sealKey, stable(parameters));
    const origin: TemplatePackage = { id: pkg.id, version: pkg.version, sha: pkg.origin?.sha ?? null, parameters_digest: digest, secrets: declared };
    return { pkg, onto, missing, unsaved, saved, mapped, grants, pick, made, emptyFeeds, hostless, unmade, hadByName, remade, resent, removing, digest, origin, warned: [...keyWarnings, ...skipped, ...kept, ...modelWarnings, ...computerWarnings] };
  }

  /** applyTemplate's work, in its turn on the agent where it has agent_id: prepareApply's reads and checks, then its
   *  writes. */
  async function applyWith(template: Package, body: Json) {
    const { pkg, onto, saved, mapped, grants, made, emptyFeeds, hostless, unmade, hadByName, remade, resent, removing, digest, origin, warned } = await prepareApply(template, body, { plan: false });
    // A fresh apply of what already made a live agent here (the same package and parameters) still makes one, and says
    // which is there: an apply with its agent_id updates that one instead. Read before this apply's agent is made.
    const twins: InputIssue[] = (await twinsOf(onto, pkg.id, digest))
      .map((id) => ({ field: "agent_id", reason: "duplicate", message: `The agent ${id} was made from the ${pkg.name} template with these parameters, and this apply made another. To change that one instead, apply with agent_id ${id}.` }));
    // An update writes the package as a new revision of the agent, as an edit does (its id, name and description are the
    // agent's own: the package's never replace them), but what the package owns and leaves out is gone (fromPackage); only onto the
    // revision it read, else 412 with nothing changed. A fresh apply makes the agent as POST /agents does.
    const { entry, warnings } = onto
      ? await reviseAgentOf(onto, { ...made.agent, definition: updateDefinition(onto, made.agent.definition as Json) }, { template: origin, fromPackage: true, ifCurrent: onto.revision?.id ?? null }).catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "precondition_failed") throw new ApiError("precondition_failed", `The agent ${onto.agent.id} changed while this apply of the ${pkg.name} template read it (an edit, or another apply, wrote a revision): nothing was changed. Apply it with agent_id again to update the agent as it is now.`);
        throw error;
      })
      : await createAgentOf(made.agent, origin);
    // An update's triggers are reconciled by name with the ones the agent has: the package's trigger of a name the agent
    // has (of the same kind) is changed in place, keeping its id, a feed's seen items, a webhook's secret and whether the
    // owner turned it off (an unmarked one is adopted so, and only so: notOurs above), its settings the package's whole
    // (catchup_window_s and max_active_runs the package leaves out back to their defaults, as a fresh apply makes them); a new name is made; one the package
    // marked and no longer lists is removed (`removing`). Each trigger the apply makes or keeps is marked as the package's; each write to one the agent had is made only while it
    // is still the agent's: one a PATCH moved away meanwhile is neither changed nor removed, and its name is made anew.
    // Each trigger it made or kept, in the package's order, as it stands after its write: the answer's triggers (its id,
    // its name, its kind, and whether it is on).
    const answered: { trigger_id: string; name: string; kind: string; enabled: boolean }[] = [];
    const list = (view: { id: string; name: string; enabled: boolean; source: { kind: string } }) => answered.push({ trigger_id: view.id, name: view.name, kind: view.source.kind, enabled: view.enabled });
    // The triggers this apply made (never one it changed in place): what a refusal's undo removes.
    const madeNow: string[] = [];
    // Each webhook trigger's signing secret, minted as it is made: handed back in the apply's first answer alone, as POST
    // /triggers hands back its own, so the owner can give it to the sender.
    const secrets: { trigger_id: string; secret: string }[] = [];
    // A trigger this server can't set up yet (templates.ts TRIGGER_NOT_SET_UP_YET: a github one with GitHub not connected,
    // a composio one Composio can't reach or run as here) is skipped, never the apply: the agent stands, and the answer
    // says what to do (a warning under triggers.<i>). Kept with its refusal, whose words the warning carries.
    const unconnected = new Map<number, ApiError>();
    // Each trigger the package no longer lists whose sender kept what it has of it (a Composio instance): kept here, marked,
    // for the next update to remove, and said in the answer.
    const leftThere: InputIssue[] = [];
    try {
      for (const [i, trigger] of made.triggers.entries()) {
        if (unmade(i)) continue;
        const aimed: Json = { ...trigger, target: { ...(trigger.target as Json), agent_id: entry.agent.id } };
        let was = hadByName.get(String(trigger.name).trim());
        const own = { templateId: pkg.id, onAgent: entry.agent.id };
        try {
          if (was && isObject(trigger.source) && isObject(was.source) && was.source.kind === trigger.source.kind && !remade.has(i)) {
            const { enabled: _owners, source: given, ...sent } = aimed;
            // The package's source, sent only when it says something other than the stored one: a PATCH's source puts the
            // trigger on from now (its next time and an every_s grid restarted, a poll kicked), so an update that leaves a
            // schedule as it was never moves it. An every_s schedule with no start_at is the stored one's grid (the time
            // its first apply made it), as it says no other; a Composio one is its `resent` form.
            const ours = resent.get(i) ?? (isObject(given) && given.kind === "schedule" && given.every_s !== undefined && given.start_at === undefined && isObject(was.source) && was.source.every_s === given.every_s && typeof was.source.start_at === "string" ? { ...given, start_at: was.source.start_at } : given);
            // Compared as a create keeps it (Triggers.sourceAsKept: a feed's every_s the package leaves out is the default the
            // trigger was made with), so a package that says no more than it did never moves it.
            const source = stable(resent.has(i) ? ours : (triggers.sourceAsKept(ours) ?? ours)) === stable(was.source) ? undefined : ours;
            // The package's settings whole: one its version leaves out goes back to what a fresh apply makes (POST
            // /triggers' default), never kept from the version before. PATCH reads null as no cap.
            const patch = { ...sent, catchup_window_s: sent.catchup_window_s ?? CATCHUP_WINDOW_S, max_active_runs: sent.max_active_runs ?? null };
            const changed = await triggers.update(was.id, source ? { ...patch, source } : patch, own).catch(movedAway);
            if (changed) {
              list(changed);
              continue;
            }
            was = undefined;
          }
          // Of another kind now (a trigger's source kind is fixed), or a Composio one whose fixed part changed: the old one
          // goes, then the new one is made, off where the owner turned the old one off. The old one's instance on Composio
          // goes first (Triggers.remove on its agent's condition): one Composio did not delete leaves the old trigger here
          // as it was (on or off, marked, its config sealed) and the new one unmade, so two instances never watch, and the
          // apply fails with its revision standing, as a refused trigger's does; the next apply finds the old one again.
          const left = was ? await triggers.remove(was.id, own).catch(movedAway) : false;
          if (left === false) was = undefined;
          else if (isObject(left) && isObject(left.composio) && left.composio.done === false) throw new ApiError("upstream_failed", `The ${pkg.name} template's trigger ${String(trigger.name).trim()} changed, so its old Composio trigger instance must go before the new one is made, and Composio didn't delete it: the new one was not made, and the old trigger is kept here as it was. ${String(left.composio.note ?? "")} Then apply again.`.trim());
          const created = await triggers.create(was && !was.enabled ? { ...aimed, enabled: false } : aimed, { templateId: pkg.id });
          const { id: madeId, secret } = created;
          list(created);
          madeNow.push(madeId);
          if (secret) secrets.push({ trigger_id: madeId, secret });
        } catch (error) {
          if (error instanceof ApiError && isObject(trigger.source) && notSetUpYet(trigger.source.kind, error.code)) {
            unconnected.set(i, error);
            continue;
          }
          if (error instanceof ApiError && error.code === "input_invalid" && error.extra.fields) throw told(new ApiError("input_invalid", error.message, { ...error.extra, fields: error.extra.fields.map((f) => ({ ...f, field: `triggers.${i}.${f.field}` })) }));
          throw error;
        }
      }
      // Each trigger the package marked and no longer lists, while it is still the agent's.
      for (const row of removing) {
        const left = await triggers.remove(row.id, { onAgent: entry.agent.id }).catch(movedAway);
        if (isObject(left) && isObject(left.composio) && left.composio.done === false) leftThere.push({ field: "triggers", reason: "upstream_failed", message: `The trigger ${row.name} (${row.id}), which the ${pkg.name} template no longer lists, is kept until its Composio trigger instance is gone. ${String(left.composio.note ?? "")} The next update of the agent from the template removes the trigger.` });
      }
    } catch (error) {
      // An update's revision and the triggers it changed stand; what it made is removed. A fresh apply is undone whole.
      for (const id of madeNow.reverse()) {
        try {
          await triggers.remove(id);
        } catch (undo) {
          log?.(logLine("template_undo_failed", { template: pkg.name, trigger: id, message: (undo as Error).message }));
        }
      }
      // Archived through the trigger engine, as POST /agents/{id}/archive is: a trigger the undo could not remove is turned
      // off in that same store transaction with the reason agent_archived, never with none, and unarchive answers it.
      if (!onto) await triggers.agentArchived(entry.agent.id).catch((undo: Error) => log?.(logLine("template_undo_failed", { template: pkg.name, agent: entry.agent.id, message: undo.message })));
      throw error;
    }
    // A pinned send whose destination parameter was not given is denied, never let go anywhere: said, by its gate name.
    const unpinned: InputIssue[] = made.unpinned.map(({ tool, parameters: named }) => ({ field: `pins.${tool}`, reason: NOT_SET_UP, message: `${tool}'s arguments are fixed by ${named.map((one) => `the ${one} parameter`).join(" and ")}, which was not given, so the agent was made with ${tool} set to deny: it can't call it at all. Apply again with ${named.join(" and ")} set to let it.` }));
    // A GitHub tool the owner granted (ticked) that an installation of Connect GitHub's App does not hold the permission
    // for (read from GitHub, never assumed), where the github MCP server runs on the App's tokens: said now, before a run's
    // first call is refused; or that the check could not be made (template-github-permissions.ts). An unticked tool is
    // not the agent's, so nothing is said of it.
    const ticked = saved.map((need) => ({ ...need, tools: need.tools.filter((tool) => grants.includes(mcpToolName(need.server, tool))) }));
    const appShort = await appPermissionWarnings({ name: pkg.name, mcp: ticked }, (server) => mcpMeta.get(server)?.auth === "github_app", () => githubConnect.installationPermissions(stopping.signal));
    // A webhook trigger's secret is in no apply answer: each one's warning sends the person to the console for it.
    const hooks = made.triggers.flatMap((trigger, i) => (!hostless.has(i) && isObject(trigger.source) && trigger.source.kind === "webhook" ? [templateTriggerSecret(i)] : []));
    // Each github trigger: what it runs on, when made (a note, never a lack); skipped, what to do about it.
    const githubTriggers: InputIssue[] = made.triggers.flatMap((trigger, i) => (!hostless.has(i) && isObject(trigger.source) && trigger.source.kind === "github"
      ? [unconnected.has(i) ? { field: `triggers.${i}`, reason: NOT_SET_UP, message: githubTriggerUnconnected(pkg.name, trigger.source) } : { field: `triggers.${i}`, reason: "not_an_option", message: githubTriggerWords(pkg.name, trigger.source) }]
      : []));
    // Each composio trigger it skipped: which, the refusal's words, and where to make it once that's fixed.
    const composioSkipped: InputIssue[] = made.triggers.flatMap((trigger, i) => {
      const refused = unconnected.get(i);
      return refused && isObject(trigger.source) && trigger.source.kind === "composio" ? [{ field: `triggers.${i}`, reason: NOT_SET_UP, message: composioTriggerSkipped(pkg.name, trigger, refused.message), fix: COMPOSIO_TRIGGER_FIX }] : [];
    });
    // Each feed trigger it skipped for want of a feed: which, and the parameter to set.
    const feedsSkipped: InputIssue[] = [...emptyFeeds].filter((i) => !hostless.has(i)).map((i) => ({ field: `triggers.${i}`, reason: NOT_SET_UP, message: feedTriggerEmpty(pkg.name, made.triggers[i]!, isObject(pkg.triggers[i]?.source) ? pkg.triggers[i]!.source.urls : undefined) }));
    // Each trigger an API-only server does not make: not_set_up_here when the launch hook would make it, else not_an_option.
    const hostSkipped: InputIssue[] = [...hostless].map(([i, { reason, message }]) => ({ field: `triggers.${i}`, reason, message }));
    // Each trigger it made, a webhook trigger's with its secret's metadata; the values go back beside the answer, never in it
    // (the route adds them to the first answer to the owner's session, after the Idempotency-Key's record is written).
    const minted = new Map(secrets.map(({ trigger_id, secret }) => [trigger_id, secret]));
    // Which saved server each MCP need runs on (null: none here, said under mcp.<toolkit>).
    const used = Object.fromEntries(mapped.map(({ need, server }) => [need.toolkit, server]));
    // What the apply did to the agent: made it, wrote a new revision, or wrote none (an update whose package and
    // parameters the current revision already holds: commitAgent keeps that revision).
    const agentChange = !onto ? "made" : entry.revision?.id === onto.revision?.id ? "unchanged" : "updated";
    const applied = { template: pkg.id, version: pkg.version, agent_id: entry.agent.id, revision_id: entry.revision?.id ?? null, revision_version: entry.version, agent_change: agentChange, servers: used, triggers: answered, ...templateWebhookSecrets([...minted.keys()], new Date().toISOString()), warnings: [...warned, ...unpinned, ...warnings, ...hooks, ...githubTriggers, ...composioSkipped, ...feedsSkipped, ...hostSkipped, ...leftThere, ...appShort, ...twins] };
    return { applied, minted, updated: onto !== undefined };
  }

  /** A run create's issues told from the input this server checks (explain.ts): an agentic run's input schema in force
   *  (`{content: string}` with none), with the documented run bodies;a workflow run's its workflow's input schema, never the agentic example. Each value
   *  suggested must pass this route's own checks of the body, the workflow's input check among them. */
  async function explainRun(issues: InputIssue[], body: Json, revision: Revision | null | undefined): Promise<InputIssue[]> {
    const dsl = revision?.kind === "workflow" ? await import("@parcha/agentrun-dsl") : undefined;
    const workflow = dsl && revision?.kind === "workflow" ? revision.body.workflow : undefined;
    const declared = workflow?.input?.schemaId === undefined ? undefined : workflow.schemas[workflow.input.schemaId];
    const typed = revision?.kind === "agentic" ? inputSchemaOf((revision.body as { inputSchema?: unknown }).inputSchema) : DEFAULT_INPUT_SCHEMA;
    const input = !dsl ? typed : declared ? (dsl.resolveSchemaForWorkflow(workflow!, declared) as Json) : { type: "object" };
    const base = deref(openapi, { $ref: "#/components/schemas/RunCreate" }) ?? {};
    const schema = { ...base, properties: { ...(base.properties as Json), input } };
    const check = (sent: unknown) => {
      const value = isObject(sent) ? sent : {};
      const issues = runBodyIssues(value);
      if (!revision || !isObject(value.input)) return issues;
      return [...issues, ...(dsl ? workflowInputIssues(dsl.validateWorkflow, revision, value.input) : inputIssues(value.input, typed))];
    };
    return explain(issues, openapi, schema, { examples: dsl ? [] : examplesOf("createRun"), body, check });
  }

  /** A run's input: an agentic run's what its revision's input schema in force takes (`{content: string}` with none), a
   *  workflow run's what its workflow's input schema takes. */
  async function inputIssuesOf(revision: Revision, input: Json) {
    if (revision.kind === "agentic") return inputIssues(input, inputSchemaOf((revision.body as { inputSchema?: unknown }).inputSchema));
    const { validateWorkflow } = await import("@parcha/agentrun-dsl");
    return workflowInputIssues(validateWorkflow, revision, input);
  }

  /** A workflow run's input against its workflow's input schema, as the DSL checks it before the first node. */
  function workflowInputIssues(validateWorkflow: typeof import("@parcha/agentrun-dsl").validateWorkflow, revision: Revision, input: Json): InputIssue[] {
    if (revision.kind !== "workflow") return [];
    const checked = validateWorkflow(revision.body.workflow, { executeCode: false, input });
    if (checked.ok) return [];
    return checked.issues.map((i) => {
      // An input problem has no path of its own; its message names the schema's path and why (the DSL's schemaProblems
      // reports schema paths, never the input's data), so it is said as it is, and the field carries that path (#1926).
      const said = !i.path && i.code === "INPUT_INVALID" && i.message ? i.message.replace(/^input:\s*/, "") : `${i.code}${i.path ? ` at ${i.path}` : ""}`;
      const at = i.path || /^(#\/\S*?):\s/.exec(said)?.[1];
      return { field: `input${at ? ` at ${at}` : ""}`, reason: "invalid", message: `the workflow does not take this input: ${said}` };
    });
  }

  /** Where a person opens a page an answer to `req` names (a run's or an agent's console_url, console-links.ts): the
   *  server's public URL when it has one; else the address the request reached it at, which passed the Host check (a
   *  tunnel's own port, say); else, with no Host, its own. Links made outside a request (the owner's, the webhooks') are
   *  at the public URL or the server's own address. */
  const linkOrigin = (req: IncomingMessage): string => (options.publicUrl ?? (req.headers.host ? ownOrigin(req) : url)).replace(/\/+$/, "");

  /** A run body's launch secrets taken out of it, before anything else reads the body: `mcp_auth`, the credentials a run's
   *  caller hands its per_run MCP servers for this run alone (mcp-probe.ts mcpAuthOf), and `model_key`, the run's own model
   *  key (run-model-key.ts), such as a LiteLLM virtual key minted for it. They never reach the run's saved body, its
   *  timeline, an idempotency fingerprint (a retry with a fresh credential or key replays its first answer) or a log: only
   *  the seal made of them, sealed for the run's id into its launch row (store/seal.ts sealRunLaunch), each MCP credential
   *  bound to its server's origin then and the model key to the gateway's (AGENT_MODEL_BASE_URL). `handed` is called only
   *  for new work, inside the request's idempotent work: there each mcp_auth entry must name a saved per_run server, and
   *  the model key must be text, else 422, nothing written. A retry its key already answered replays that answer even
   *  when the server has since changed or gone, since it does no new work. `keys`, the run's own tool keys (run-keys.ts),
   *  go the same way: each a tool key name to its value as text, else 422 by name, never with the value; whether the
   *  run's revision reads each is its start's check (prepareLaunch), by name alone. */
  function handedLaunchSecrets(body: Json): { body: Json; handed: () => Promise<Handed> } {
    if (body.mcp_auth === undefined && body.model_key === undefined && body.keys === undefined) return { body, handed: async () => ({}) };
    const { mcp_auth, model_key, keys: given, ...rest } = body;
    const handed = async (): Promise<Handed> => {
      const issues: InputIssue[] = [];
      const mcp = mcp_auth === undefined ? undefined : mcpAuthOf(mcp_auth, issues);
      const auth: Record<string, RunMcpAuth[string]> = {};
      for (const [server, entry] of Object.entries(mcp ?? {})) {
        const row = await getMcpServer(store, server);
        const field = `mcp_auth.${server}`;
        if (!row) {
          issues.push({ field, reason: "not_an_option", message: `No MCP server ${server} is saved here.` });
          continue;
        }
        // A per-run Composio server takes a binding (its key is its own); a per_run server takes headers; no other takes either.
        const perRunComposio = composioPerRun(row, await store.settings.get(composioMadeKey(server)));
        if ("composio" in entry) {
          if (perRunComposio) auth[server] = { composio: entry.composio, origin: new URL(row.url).origin };
          else issues.push({ field, reason: "not_an_option", message: `The MCP server ${server} is not a per-run Composio server: only one saved through the Composio preset with user_id "${COMPOSIO_PER_RUN}" takes a Composio account from a run.` });
        } else if (row.auth === "per_run") auth[server] = { headers: entry.headers, origin: new URL(row.url).origin };
        else issues.push({ field, reason: "not_an_option", message: perRunComposio ? `The MCP server ${server} takes a Composio account from each run, not headers: send {"composio_user_id": "<user>", "connected_account_id": "ca_..."} (the account optional).` : `The MCP server ${server} keeps its own credential (auth ${row.auth}): only a per_run server takes one from a run.` });
      }
      const model = model_key === undefined ? undefined : modelKeyOf(model_key, issues);
      const keys = given === undefined ? undefined : runKeysOf(given, issues);
      if (issues.length) throw invalid(issues);
      // Empty keys are kept: on a message they replace the run's keys with none (on a start, none is what it has).
      return { ...(mcp_auth !== undefined ? { mcp: auth } : {}), ...(model !== undefined ? { model } : {}), ...(keys !== undefined ? { keys } : {}) };
    };
    return { body: rest, handed };
  }

  /** The start option naming the tool keys `handed` carries, by name (runs-over-store StartOptions.keys). */
  const carriedOf = (handed: Handed): { keys?: readonly string[] } => (handed.keys ? { keys: Object.keys(handed.keys) } : {});

  /** The 422 for a model key where the run's model never takes it (run-model-key.ts modelKeyMisfit), at `model_key`. */
  const misfit = (why: string) => invalid([{ field: "model_key", reason: "not_an_option", message: why }]);

  /** A start's launch seal of `handed` (handedLaunchSecrets), made once the start prepared the run's launch: a model key
   *  where the run's model never takes it is refused (modelKeyMisfit), and a start that hands other secrets but no key
   *  is refused where the server holds no key for the run's route (serverKeyMissing). Undefined when nothing is handed:
   *  the start's own check (runs-over-store keyedOrRefused) refuses that one where it has no key to spend. */
  function startSeal(handed: Handed): StartOptions["sealed"] {
    if (handed.mcp === undefined && handed.model === undefined && handed.keys === undefined) return undefined;
    return (runId, launch, kind) => {
      const target = { kind, model: launch.model, native: Boolean(launch.native) };
      if (handed.model !== undefined) {
        const why = modelKeyMisfit(env, target);
        if (why) throw misfit(why);
      } else if (serverKeyMissing(env, target)) throw modelKeyRequired(false);
      const origin = runModelOrigin(env);
      return sealRunLaunch(sealKey, runId, { ...(handed.mcp ? { mcp: handed.mcp } : {}), ...(handed.model !== undefined && origin ? { model: { key: handed.model, origin } } : {}), ...(handed.keys ? { keys: handed.keys } : {}) });
    };
  }

  /** A message's launch secrets for run `run` (its kind and launch as stored): what it hands replaces that part of the
   *  run's, inside the write that takes the message (store LaunchSealed: a function of what the launch holds then), and a
   *  part it does not hand is kept as the run holds it (none after its turn's end erased it). A model key is refused
   *  where the run's model never takes it. One is required where the server holds no key for the run's route and the
   *  run holds none when the message is written (its last turn ended): 422 model_key_required from inside that write,
   *  which then writes nothing, so a turn never starts with no key to spend. Its `keys` replace the run's whole, each one
   *  its revision reads (else 422 by name); under the run-keys setting, a message that would leave the run without a tool
   *  key its template declared and this host does not hold (its last turn's end erased them) is refused, 409, nothing
   *  written. */
  async function messageSeal(run: { id: string; kind: string }, handed: Handed): Promise<LaunchSealed | undefined> {
    const launch = readLaunchBody((await store.runs.launch(run.id)).body);
    const target = { kind: run.kind, model: launch?.model, native: Boolean(launch?.native) };
    if (handed.model !== undefined) {
      const why = modelKeyMisfit(env, target);
      if (why) throw misfit(why);
    }
    const row = handed.keys || options.runKeys ? await store.runs.get(run.id) : undefined;
    const revision = row ? await store.agents.revision(row.revisionId) : undefined;
    if (handed.keys) {
      const undeclared = undeclaredKeys(Object.keys(handed.keys), revision ? await declaredKeys(revision as unknown as Revision) : []);
      if (undeclared.length) throw invalid(undeclared);
    }
    const owed = options.runKeys && revision ? keysOwed(revision, env, []) : [];
    const needsKey = handed.model === undefined && serverKeyMissing(env, target);
    if (handed.mcp === undefined && handed.model === undefined && handed.keys === undefined && !needsKey && !owed.length) return undefined;
    const origin = runModelOrigin(env);
    return (current) => {
      const held = current === null ? {} : (openRunLaunch(sealKey, run.id, current) ?? {});
      const mcp = handed.mcp ?? held.mcp;
      const model = handed.model !== undefined && origin ? { key: handed.model, origin } : held.model;
      const keys = handed.keys ?? held.keys;
      if (!model && needsKey) throw modelKeyRequired(true);
      const unpaid = owed.length && revision ? keysOwed(revision, env, Object.keys(keys ?? {})) : [];
      if (unpaid.length) throw keysOwedRefusal(unpaid);
      return sealRunLaunch(sealKey, run.id, { ...(mcp ? { mcp } : {}), ...(model ? { model } : {}), ...(keys ? { keys } : {}) });
    };
  }

  async function createRun(req: IncomingMessage, agentId: string) {
    const entry = await needRunnableAgent(agentId);
    const { body, handed } = handedLaunchSecrets(await bodyOf(req));
    // The host's run for a firing the launch hook handed it: the firing's own run, under the firing's key (a second start
    // answers that run), started by the trigger's target policy as a firing here starts one (its cap, which the host's may
    // lower, its effort when it sets one, its previous result, its trigger, origin and title), with the host's body and
    // launch secrets over it. The firing is its key, so it takes no Idempotency-Key, whose check across a restart is the run's origin.
    if (body.trigger_firing !== undefined) {
      if (req.headers["idempotency-key"] !== undefined) throw invalid([{ field: "trigger_firing", reason: "not_allowed", message: "A run for a trigger firing is keyed by the firing, and a second start answers its run: send it without Idempotency-Key." }]);
      // It starts on its trigger's target as a firing here would: on the agent's current revision, holding no computer.
      const fixed = HANDED_FIXED.filter((field) => body[field] !== undefined);
      if (fixed.length) throw invalid(fixed.map((field) => ({ field, reason: "not_allowed", message: `A run for a trigger firing starts on its trigger's target, on the agent's current revision and holding no computer: send it without ${field}.` })));
      const { trigger_firing: given, ...rest } = body;
      // The firing's room is checked and held as drive's is while its run is written; the firing is started with the run.
      const run = await triggers.handedStart(given, agentId, async (firing) => {
        const secrets = await handed();
        const seal = startSeal(secrets);
        return targets.start(firing.target, rest.input, firing.trigger, firing.from, firing.title, firing.previous, { body: rest, ...(seal ? { sealed: seal } : {}), ...carriedOf(secrets) });
      });
      return { status: 202, body: await viewOverStore(store, run.run_id, viewDepsFor(linkOrigin(req))), headers: { location: `/v2/runs/${run.run_id}`, ...(run.replayed ? { "idempotent-replayed": "true" } : {}) } };
    }
    return idempotent(req, `/agents/${agentId}/runs`, body, async (origin) => {
      // A run the store started under this key, though no answer was kept (its server went down first): that run, as it is now.
      const first = origin && (await agents.request(() => agents.store.runOfOrigin(origin.key)));
      if (first) {
        if (first.existing?.fingerprint !== origin.fingerprint) throw mismatch();
        const headers: Record<string, string> = { location: `/v2/runs/${first.runId}`, "idempotent-replayed": "true" };
        return { status: 202, body: await viewOverStore(store, first.runId, viewDepsFor(linkOrigin(req))), headers };
      }
      const secrets = await handed();
      const seal = startSeal(secrets);
      const run = await startRunOf(entry, body, { ...(origin ? { origin } : {}), ...(seal ? { sealed: seal } : {}), ...carriedOf(secrets) });
      // Its view from the store: the run and its launch were inserted in one transaction, so the view reads it whole.
      return { status: 202, body: await viewOverStore(store, run.id, viewDepsFor(linkOrigin(req))), headers: { location: `/v2/runs/${run.id}` } };
    });
  }

  /** POST /runs: a run of an agent another system owns, given inline. The body is POST /agents/{agent_id}/runs' own, but
   *  `revision` (the run's revision is its external version's), with the agent's reference in its source (`external`) and
   *  the agent as POST /agents takes one (`definition`, `skills`, `note`), checked as that route checks it, in its words.
   *  Its first run makes the agent, a version's first run its revision; a later run of the version reuses both
   *  (runs-over-store startInline). The answer is POST /agents/{agent_id}/runs' own: 202 and the run. */
  async function createInlineRun(req: IncomingMessage) {
    const { body, handed } = handedLaunchSecrets(await bodyOf(req));
    if (isObject(body.definition) && body.definition.cli_learning !== undefined) throw new ApiError("input_invalid", "CLI learning references are registered only through /cli-learning/connections on the source machine.");
    if (isObject(body.definition) && body.definition.native !== undefined) throw new ApiError("input_invalid", "Native references are registered only through /native/connect on the source machine; an inline definition cannot create one.");
    const { external, definition, skills, note, revision: pinned, ...run } = body;
    const given = { definition, ...(skills !== undefined ? { skills } : {}), ...(note !== undefined ? { note } : {}) };
    const issues: InputIssue[] = [
      ...externalIssues(external),
      ...(pinned !== undefined ? [{ field: "revision", reason: "not_allowed", message: "An inline run pins no revision: it runs the revision of its external version.", fix: "Remove revision." }] : []),
      ...runBodyIssues(run),
      ...definitionBodyIssues(given, { harnesses }),
      // The agent's id is this server's, one per external reference, and its version is the reference's.
      ...(["id", "version"] as const).flatMap((key) => (isObject(definition) && definition[key] !== undefined ? [{ field: `definition.${key}`, reason: "not_allowed", message: `An inline agent's ${key} is its external reference's: the definition names none.`, fix: `Remove definition.${key}.` }] : [])),
    ];
    if (issues.length) throw invalid(issues);
    const checked = checkDefinitionBody(given, { harnesses });
    const made = makeRevision(checked.definition, checked.skills ?? {}, checked.note);
    // A version's first run is its save: refused where POST /agents refuses the definition (one this host can never run),
    // its MCP tools pinned as a save pins them (a server down keeps the agent's current pin when this version grants nothing
    // new from it). A version already stored is a run of its revision, as a run of a stored agent is: no save, nothing
    // listed here, its pin as stored (one stored with no pin is pinned at this run, StartDeps.pinFirst). What this host
    // still lacks for either is the run's own refusal (prepareLaunch's runnable).
    const ref = external as { source: string; kind: string; id: string; version: string | number };
    const mapped = await store.agents.byExternal(externalKey(ref));
    const stored = mapped ? await store.agents.externalRevision(mapped.id, String(ref.version)) : undefined;
    const current = !stored && mapped?.currentRevision ? await store.agents.revision(mapped.currentRevision) : undefined;
    const revision = stored ? made : { ...made, ...(await saveable(made, current)).stamp };
    const inline = {
      external: { source: ref.source, kind: ref.kind, id: ref.id, version: String(ref.version) },
      name: checked.definition.name as string,
      description: typeof checked.definition.description === "string" ? checked.definition.description : null,
      revision,
      ...(stored ? { stored } : {}),
    };
    return idempotent(req, "/runs", body, async (origin) => {
      // A run the store started under this key, though no answer was kept (its server went down first): that run, as it is now.
      const first = origin && (await agents.request(() => agents.store.runOfOrigin(origin.key)));
      if (first) {
        if (first.existing?.fingerprint !== origin.fingerprint) throw mismatch();
        const headers: Record<string, string> = { location: `/v2/runs/${first.runId}`, "idempotent-replayed": "true" };
        return { status: 202, body: await viewOverStore(store, first.runId, viewDepsFor(linkOrigin(req))), headers };
      }
      const secrets = await handed();
      const seal = startSeal(secrets);
      const started = await startInline(store, startDeps, inline, run, { ...(origin ? { origin } : {}), ...(seal ? { sealed: seal } : {}), ...carriedOf(secrets) });
      return { status: 202, body: await viewOverStore(store, started.id, viewDepsFor(linkOrigin(req))), headers: { location: `/v2/runs/${started.id}` } };
    });
  }

  /** An inline run's `external`, field by field: its source and kind (no colon, which the reference's key splits on), its
   *  id in its source (text), and its version there (text or a whole number). */
  function externalIssues(external: unknown): InputIssue[] {
    if (external === undefined) return [{ field: "external", reason: "missing", message: "external is the agent's reference in the system that owns it: {source, kind, id, version}" }];
    if (!isObject(external)) return [{ field: "external", reason: "wrong_type", message: "external is an object: {source, kind, id, version}" }];
    const issues: InputIssue[] = unknownFields(external, ["source", "kind", "id", "version"]).map((issue) => ({ ...issue, field: `external.${issue.field}`, message: `external keeps no field ${issue.field}.` }));
    for (const key of ["source", "kind"] as const) {
      const value = external[key];
      if (value === undefined) issues.push({ field: `external.${key}`, reason: "missing", message: `external.${key} is required` });
      else if (typeof value !== "string") issues.push({ field: `external.${key}`, reason: "wrong_type", message: `external.${key} is text` });
      else if (!EXTERNAL_NAME.test(value)) issues.push({ field: `external.${key}`, reason: "bad_format", message: `external.${key} does not match ${EXTERNAL_NAME.source}` });
    }
    if (external.id === undefined) issues.push({ field: "external.id", reason: "missing", message: "external.id is required" });
    else if (typeof external.id !== "string" || external.id.length < 1 || external.id.length > 255) issues.push({ field: "external.id", reason: "wrong_type", message: "external.id is the agent's id in its source: text of 1 to 255 characters" });
    const { version } = external;
    if (version === undefined) issues.push({ field: "external.version", reason: "missing", message: "external.version is required" });
    else if (!((typeof version === "string" && version.length >= 1 && version.length <= 128) || (Number.isSafeInteger(version) && (version as number) >= 0))) issues.push({ field: "external.version", reason: "wrong_type", message: "external.version is the agent's version in its source: text of 1 to 128 characters, or a whole number" });
    return issues;
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
    const issues = unknownFields(body, ["input", "revision", "file_ids", "effort", "max_cost_usd", "quote_id", "learning", "archil_disk", "repo", "workflow_first", "hold", "hold_minutes", "labels"]);
    issues.push(...holdIssues(body));
    if (body.repo !== undefined && !(typeof body.repo === "string" && REPO_NAME.test(body.repo))) issues.push({ field: "repo", reason: "wrong_type", message: "repo is a GitHub repository as owner/name, one the agent is bound to" });
    if (body.archil_disk !== undefined) {
      const disk = body.archil_disk;
      const extra = isObject(disk) ? Object.keys(disk).filter((key) => key !== "disk_id") : [];
      if (!isObject(disk) || typeof disk.disk_id !== "string" || !ARCHIL_DISK_ID.test(disk.disk_id)) issues.push({ field: "archil_disk.disk_id", reason: "wrong_type", message: "archil_disk is { disk_id }: the disk id Archil returned when the disk was made (dsk- and 16 hex digits; Archil's API addresses disks by id, not owner/name), in this server's Archil region" });
      else if (extra.length) issues.push({ field: `archil_disk.${extra[0]}`, reason: "not_allowed", message: "archil_disk names a disk by its id alone: its region is this server's Archil key's, and no key is ever sent with a run", fix: `Remove ${extra.map((key) => `archil_disk.${key}`).join(" and ")}.` });
    }
    if (!isObject(body.input)) issues.push({ field: "input", reason: body.input === undefined ? "missing" : "wrong_type", message: "input is an object" });
    if (body.revision !== undefined && (typeof body.revision !== "string" || !ID.test(body.revision))) issues.push({ field: "revision", reason: "wrong_type", message: "revision is a revision id of this agent" });
    if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) issues.push({ field: "effort", reason: "not_an_option", message: `effort is one of ${EFFORTS.join(", ")}` });
    if (body.max_cost_usd !== undefined && !(typeof body.max_cost_usd === "number" && body.max_cost_usd > 0 && Number.isFinite(body.max_cost_usd))) issues.push({ field: "max_cost_usd", reason: "wrong_type", message: "max_cost_usd is a number above 0" });
    if (body.file_ids !== undefined && !Array.isArray(body.file_ids)) issues.push({ field: "file_ids", reason: "wrong_type", message: "file_ids is a list of file ids" });
    if (body.workflow_first !== undefined && typeof body.workflow_first !== "boolean") issues.push({ field: "workflow_first", reason: "wrong_type", message: "workflow_first is true or false" });
    if (body.learning !== undefined && body.learning !== RUN_LEARNING_USE) issues.push({ field: "learning", reason: "not_an_option", message: `learning is "${RUN_LEARNING_USE}" (the run starts from what its agent learned and keeps nothing), or absent (its agent's own)` });
    issues.push(...labelsIssues(body.labels));
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
    // `label=<key>:<value>`, once: only the runs holding it (run-labels.ts), filtered in the store.
    const labels = labelFilter(url.searchParams.getAll("label"));
    const vd = viewDepsFor(origin);
    // The page from the runs' rows alone (store/schema.ts RUN_LISTING_COLUMNS): filtered (`status` on the listing's status),
    // ordered and cut to the page in one query, so a list costs the same at ten runs and at thousands, however long their
    // journals. An audit's shadow run is no row of the list (learn/audit.ts): it is read by id, and its cost is its served
    // run's. A run's archive is its own or its agent's.
    const where = { ...(filter.agent !== undefined ? { agentId: filter.agent } : {}), ...(filter.revision !== undefined ? { revisionId: filter.revision } : {}), ...(labels ? { labels } : {}), archived };
    // A listing is built by the server's lister (run-listing.ts) once per change, so a list finds it current. One that is
    // behind (a write landed since, or the lister has not reached it since the store was upgraded) is built here, written
    // back, and shown as built: for a status filter, first every run still going whose listing is behind (its row's
    // list_status may say what it was, or nothing; a settled run's says what it is, from the write that settled it), all
    // of them read before any is built, UNLISTED_AT_ONCE to a read, so the page's offset counts the rows as they now stand;
    // then any row of the page. With nothing running, none is behind: two reads, whatever the runs. The runs still going
    // are all a filter builds beside its page, and the lister builds them too, so only a list soon after an upgrade
    // builds many.
    // A write that lands while a listing is built moves the run's mark, so the listing is not written (Runs.putListing),
    // and a run still going is left with no status on its row: the build is made again from the mark that write left, up
    // to LIST_TRIES builds, so a filter never leaves off a run because a write met its build. Each is the lister's build
    // (Lister.build), so a held listing built here has its agent's learning folder read by the lister's passes after it.
    const listNow = async (runId: string, read: number) => {
      for (let mark: number | undefined = read, tries = 1; ; tries++) {
        const { listing, written } = await lister.build(runId, mark, vd);
        if (!listing || written || tries === LIST_TRIES) return listing;
        if ((mark = await store.runs.listMark(runId)) === undefined) return listing;
      }
    };
    if (status !== null) {
      const going: { id: string; mark: number }[] = [];
      // Each read starts after the last row read (ListedFilter.after), never at an offset: the lister may build a row read
      // before the next read, which would shift an offset past a row not read yet.
      for (let after: { startedAt: number; id: string } | undefined; ; ) {
        const read = await store.runs.listed({ ...where, going: true, limit: UNLISTED_AT_ONCE, ...(after ? { after } : {}) });
        going.push(...read.rows.map(({ row, listMark }) => ({ id: row.id, mark: listMark })));
        const last = read.rows.at(-1)?.row;
        if (!read.more || !last) break;
        after = { startedAt: last.startedAt, id: last.id };
      }
      for (const { id, mark } of going) await listNow(id, mark);
    }
    const page = await store.runs.listed({ ...where, ...(status !== null ? { status } : {}), limit, offset });
    const secrets = serverSecrets();
    const runs: Record<string, unknown>[] = [];
    for (const { row, agentArchivedAt, listing, listMark, behind } of page.rows) {
      // One cut of other secrets (a secret saved since, or the server's own keys at another start) is built again too: at most the page's `limit` builds, and each writes
      // its listing back, so the next list finds it current.
      const kept = listing === null || behind || !builtOfNow(listing, secrets) ? await listNow(row.id, listMark) : listing;
      // A run whose status moved between the two reads is left off this page, never shown under a status it has left.
      if (kept && (status === null || kept.item.status === status)) runs.push(listedItem(kept, origin, row.archivedAt ?? agentArchivedAt, secrets));
    }
    return { runs, next_cursor: nextCursor(offset + limit, offset + limit + (page.more ? 1 : 0)) };
  }

  async function timeline(req: IncomingMessage, res: ServerResponse, url: URL, runId: string): Promise<void> {
    const after = integerParam(url.searchParams.get("after"), "after", Number.MAX_SAFE_INTEGER);
    const waitMs = integerParam(url.searchParams.get("wait_ms"), "wait_ms", MAX_WAIT_MS);
    // `calls=whole`: each call's arguments and its output too, whole to CALL_RESULT_CHARS (tool_input, tool_result_text), for a grader.
    const shape = url.searchParams.get("calls");
    if (shape !== null && shape !== "whole") throw new ApiError("bad_request", "calls is whole, or absent");
    const calls = shape === "whole";
    // This server's own: a page of at most `limit` rows, for a client that reads a little at a time (the MCP tool's). A
    // calls=whole page holds at most CALLS_PAGE_ROWS, as each row's result may be CALL_RESULT_CHARS long.
    const most = calls ? CALLS_PAGE_ROWS : PAGE_ROWS;
    const asked = url.searchParams.get("limit");
    if (asked !== null && !(/^\d+$/.test(asked) && Number(asked) >= 1 && Number(asked) <= most)) throw new ApiError("bad_request", `limit is an integer from 1 to ${most}${calls ? " with calls=whole" : ""}`);
    const limit = asked === null ? most : Number(asked);
    // The run's page from the store (runTimelines): run_id/status/state/reset/rows/drop/next_after/unchanged/has_more/final/
    // cost, byte-identical to the old live page. TODO(learning-row freshness): a learning row approved or retired since the
    // journal wrote it reads its journal state here (store-view owns the fresh learning view); folded in with learning-1.
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) {
      const page = await timelines.page(store, runId, after, waitMs, limit, calls);
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
        const page = await timelines.page(store, runId, cursor, 0, limit, calls);
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
  // kept, as a settled run's journal no longer changes, keyed by its end and its cost, so a run opened again and ended
  // again is read again: a grade's round ends it again at the same end time (its look-back keeps the end), its cost moved
  // by the round's spend. A run whose journal cannot be read leaves it all tokens.
  const endedMeters = new Map<string, Awaited<ReturnType<typeof metersOverStore>>>();
  const metersOf = async (row: { id: string; endedAt?: string | null; costUsd?: number | null }) => {
    const key = `${row.id} ${row.endedAt} ${row.costUsd}`;
    let meters = endedMeters.get(key);
    if (!meters) {
      // An ended run's meter figures over the one store: cap.ts meterFiguresFrom over A's journal, its paid tools' charges
      // folded back from the paid-tools session (store-reads/journal withPaidCosts).
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
    // How the runs' costs in the window were reached (metrics.ts joinedBasis over each run's costBasis).
    const bases: CostBasis[] = [];
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
      bases.push(row.costBasis);
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
      const soFar = usd !== null || !read ? 0 : read.known.tokens + read.known.browser + read.known.others;
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
    // What learning spent on this server, outside any run (store-reads/learning.ts learningSpendOverStore): each run's grade, on
    // the day its learning ended.
    for (const entry of await learningSpendOverStore(store, { from, to })) {
      const at = Date.parse(entry.at);
      if (at >= from && at < to) add(lineKey(entry.agent, entry.at, "learning"), entry.cost);
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), currency: "USD", basis: joinedBasis(bases), group_by: group, total_usd: round(total.usd), unpriced_runs: total.unpriced,
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

  /** POST /v2/setup, POST /v2/setup/code, POST /v2/auth/sign-in, POST /v2/auth/sign-out, POST /v2/auth/sign-out-everywhere and GET
   *  /v2/auth/session, answered before any credential: their own checks are the setup code (or the token), the password,
   *  and the session. */
  async function ownerRoute(req: IncomingMessage, res: ServerResponse, path: string, me: Owner): Promise<void> {
    const method = path === "/auth/session" || path === "/setup/import" ? "GET" : "POST";
    if (req.method !== method) throw new ApiError("method_not_allowed", `${req.method} is not a method of /v2${path}`, {}, { allow: method });
    switch (path) {
      case "/setup": {
        const byToken = req.headers.authorization !== undefined;
        if (byToken && !bearer(req.headers.authorization, req)) throw new ApiError("unauthenticated", "the Bearer here is the server's token, or none", {}, { "www-authenticate": "Bearer" });
        if (!byToken) fromPage(req);
        const { password, body } = await passwordIn(req, ["password", "code", "import"]);
        // The owner's choice: the projects to import, by the ids the offer named them with (GET /v2/setup/import's
        // candidates); `true` is every project, as before; `false`, none named or the field left out is no import.
        const named = Array.isArray(body.import) ? (body.import as unknown[]) : undefined;
        if (body.import !== undefined && typeof body.import !== "boolean" && !(named && named.length <= MAX_CANDIDATES && named.every((id) => typeof id === "string" && /^imp-[0-9a-f]{32}$/.test(id))))
          throw invalid([{ field: "import", reason: "wrong_type", message: `import is true, false, or at most ${MAX_CANDIDATES} of the project ids GET /v2/setup/import names` }]);
        const chosen = named ? [...new Set(named as string[])] : undefined;
        const takes = body.import === true || (chosen !== undefined && chosen.length > 0);
        if (takes && !offersImport) throw invalid([{ field: "import", reason: "not_allowed", message: "Only a server on this machine (no public address, on loopback) imports its sessions at setup: run the import command where they are." }]);
        // The owner's yes, on the box ticked, is kept with the owner: written durably before the password, so a setup that
        // cannot keep it sets no owner and can be tried again, and taken back if the password is not written.
        const along = takes ? { keep: () => writeDurable(importAsked, chosen ? JSON.stringify({ projects: chosen }) : ""), drop: () => rm(importAsked, { force: true }) } : undefined;
        // The server's API token stands in for the code in the code field too (on Render it is in the Environment tab, the
        // code only in the log), compared as the header is, in constant time; a wrong one counts as a wrong code.
        const tokenAsCode = typeof body.code === "string" && body.code !== "" && bearer(`Bearer ${body.code}`, req);
        const made = await me.setFirst(password, body.code, byToken || tokenAsCode, along);
        if (made === "exists") throw new ApiError("forbidden", "this server has its owner, or is being set up: sign in");
        if (made === "missing") throw new ApiError("forbidden", "this server's setup takes the setup code in its log: send it as code");
        if (made === "wrong") throw new ApiError("forbidden", "that is not the setup code in the server's log");
        if (made === "new") throw new ApiError("forbidden", "that setup code expired, or five wrong tries voided it: a new one is in the server's log");
        // A new password ends every session from before (a reset in another process cleared the old one).
        viewers.recheck();
        // The count is for the offer, now answered: it stops.
        stopCount();
        // Only on a choice made: the owner, now set, asked for it. It runs after the answer; agents arrive as it goes.
        if (takes) void importAtSetup();
        return send(res, 201, { signed_in: true, ...(takes ? { importing: true } : {}) }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      // A setup code to use, asked for with no credential (the person at the Setup code field, or whoever started the
      // server for them): a new one goes to the log only when the last is expired or spent; one still good is kept, so
      // this request never voids a link someone holds. The answer says which and when it runs out, never the code.
      // No origin check and no rate limit, unlike setup and sign-in: the documented caller is a bare curl, the answer
      // holds nothing secret, and all a caller gets is at most one log line per code's 30 minutes. Counting asks with
      // sign-in tries would let one visitor behind a shared proxy hold the button shut for everyone.
      case "/setup/code": {
        if (me.hasPassword()) throw new ApiError("forbidden", "this server has its owner: sign in");
        const code = me.renewSetupCode();
        if (!code) throw new ApiError("forbidden", "no setup code to give: this server's setup takes no code, or its password is being set now");
        return send(res, 200, { printed: code.printed, expires_at: new Date(code.until).toISOString() });
      }
      case "/setup/import": {
        // No offer is an answer, `{ offer: false }`, never a 404: the console reads this on its first page, and a browser
        // logs every 404 as an error.
        // Before the owner is set, to the setup page: none on a server that cannot import, else that it can (202 while it
        // counts), and then how many projects and sessions it would and the projects to choose from (`candidates`, the
        // latest active first, at most MAX_CANDIDATES), or null for each count when the count failed.
        if (!me.hasPassword()) {
          pageRead(req);
          if (!offersImport) return send(res, 200, { offer: false });
          countSessions();
          if (count?.state === "counted") return send(res, 200, { projects: count.projects, sessions: count.sessions, candidates: count.candidates });
          if (count?.state === "failed") return send(res, 200, { projects: null, sessions: null });
          return send(res, 202, { counting: true });
        }
        // After, to the signed-in owner: the import asked for at setup, running, done or stopped, or none asked.
        if (!signedIn(req, me)) throw new ApiError("not_found", "no route /v2/setup/import");
        return send(res, 200, importState ?? { offer: false });
      }
      case "/auth/sign-in": {
        fromPage(req);
        // The body first: the limit's place is taken only for the password's check, so a body sent slowly holds nothing
        // of the limit (the request's own timeout bounds it, as on any route).
        const { password } = await passwordIn(req, ["password"], false);
        if (!me.hasPassword()) throw new ApiError("forbidden", "this server has no password yet: set it on the setup page");
        // Never refused for good (owner.ts SignInLimit): a try past the limit is told how long to wait, a minute at most.
        const allowed = me.signIns.allow(clientOf(req));
        if (!allowed.ok) {
          const seconds = Math.ceil(allowed.retryAfterMs / 1000);
          throw new ApiError("rate_limited", `too many sign-ins ${allowed.by === "address" ? "from this address" : "on this server"}; try again in ${seconds} s`, { retry_after_ms: allowed.retryAfterMs }, { "retry-after": String(seconds) });
        }
        if (allowed.untracked) authFailed("/v2/auth/sign-in", "sign_in_table_full");
        // The try holds its place in the server's count while the password is checked: a wrong one is charged.
        let wrong = false;
        try {
          wrong = !(await me.check(password));
        } finally {
          allowed.done(wrong);
        }
        if (wrong) {
          authFailed("/v2/auth/sign-in", "wrong_password");
          throw new ApiError("unauthenticated", "that is not the password");
        }
        sayForwarded(req);
        return send(res, 200, { signed_in: true }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      // This browser: its session revoked on the server (a copy of its cookie is no session either) and its cookie
      // cleared; every other browser's session left as it is. A viewer watching with it is cut off. Its sessions at this
      // server's other ports go too (page.ts sessionsAtEveryPort: a browser sends a host's cookies to every port), each
      // name cleared; a cookie this server did not make (another server's on the same host) is left as it is.
      case "/auth/sign-out": {
        fromPage(req);
        if (!signedIn(req, me)) throw new ApiError("unauthenticated", "this browser is not signed in");
        const ended = sessionsAtEveryPort(req).filter(({ value }) => me.valid(value));
        for (const { value } of ended) me.revoke(value);
        viewers.recheck();
        const names = new Set([ownerCookieName(req), ...ended.map(({ name }) => name)]);
        return send(res, 200, { signed_out: true }, { "set-cookie": [...names].map((name) => ownerCookie(req, "", 0, name)) });
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
        // Before the owner's password is set: whether setup takes the printed code (a server at a public address, or on a non-loopback listener), so
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
  const definitionCheck = (creating: boolean) => (body: unknown) => definitionBodyIssues(isObject(body) ? body : {}, { creating, harnesses });
  const BODY_CHECKS: Record<string, (sent: Json) => ((body: unknown) => readonly InputIssue[]) | undefined> = {
    createAgent: () => definitionCheck(true),
    updateDefinition: (sent) => ("definition" in sent ? definitionCheck(false) : undefined),
    // POST /runs' agent, given inline, is POST /agents' body inside its own: checked as that one is.
    createInlineRun: () => (body: unknown) => {
      const { definition, skills, note } = isObject(body) ? body : {};
      return definitionBodyIssues({ definition, ...(skills !== undefined ? { skills } : {}), ...(note !== undefined ? { note } : {}) }, { harnesses });
    },
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
    if (CLAUDE_LOGIN_ROUTES.has(found.name) && loginOff) throw new ApiError("not_found", claudeLoginRouteOff(found.name, loginOff));
    if (found.name === "getCapabilities") {
      // features.computers: the computer kinds this server offers now (computers.ts), read at each answer, since turning
      // Archil on or off, or saving a key, changes them. So does a shell on the runner (bash on Archil's serverless exec
      // in Mode 2): where there is one, the document is made again with it (cheap), its tools available with no box.
      const runnerShell = shellTools(await shellOf({ kind: "none" }));
      await planNow();
      await ollamaNow();
      const answer = forCaller(runnerShell.size ? compose(runnerShell) : caps, byOwnerSession(req));
      // features.triggers.public_url: whether Composio (or any sender) has a public address to reach, never the address.
      // runner_refused: why no runner here can take a run, in their words, while every runner there refused to claim
      // (runner/presence.ts); null while one can, or none is there yet.
      const runnerRefused = (await refusedNow().catch(() => undefined)) ?? null;
      // store_schema: the store's version and runner floor now, beside this build's (Store.schemaState), for a deploy's
      // skew check; left out when the store cannot say (a read that failed).
      const state = await store.schemaState?.().catch(() => undefined);
      const storeSchema = state ? { store_schema: { version: state.version, runner_floor: state.runnerFloor, known: state.known } } : {};
      return send(res, 200, { ...answer, ...storeSchema, runner_refused: runnerRefused, features: { ...answer.features, computers: await computerCapabilities(computersOf()), triggers: { ...answer.features.triggers, public_url: Boolean(options.publicUrl) }, claude_login: !loginOff && !options.apiOnly } });
    }
    if (found.name === "getOpenapi") return send(res, 200, servedOpenapi(openapi, ownerCookieName(req)));
    // With accounts off there is no owner, and the console still asks whether it may save a secret: secret-writes.ts'
    // verdict over the request the page just marked, never a signed-in user it doesn't have.
    if (found.name === "getAuthSession") return send(res, 200, { accounts: false, ...secretsWritableFields(secretWriterFacts(req, { accounts: false, loopbackBound: isLoopback(host) })) });
    // The one route with no token: a pushed trigger source's request, checked by its source before anything else is
    // read (push-handler.ts).
    if (found.name === "receiveHook") {
      // A body cut at its cap or its time is answered, then its socket closed: never read to its end.
      const answer = await receivePush({ adapters, hooked: (id) => triggers.hookSource(id), ...(options.hookBodyMs !== undefined ? { bodyMs: options.hookBodyMs } : {}), ignored: (id, eventId) => triggers.ignored(id, eventId), listening: (kind) => triggers.listening(kind), notice: async (adapterId, event, body) => (adapterId === "github" && event === "installation" ? githubConnect.installationEvent(body, (detail) => triggers.turnOff("github", detail)) : undefined), receive: (id, eventId, payload, attrs) => triggers.receive(id, eventId, payload, attrs), scoped: (kind, scope) => triggers.scoped(kind, scope), setting: (adapterId, scope, field) => triggerSettings.get(adapterId)?.get(scope, field), refused: authFailed, say: (fields) => (log ? log(logLine("trigger", fields)) : void process.stderr.write(`agentrun-serve: ${logLine("trigger", fields)}\n`)) }, req, ...((([, segment, sub]) => [segment!, sub] as const)(/^\/hooks\/([^/]+)(?:\/([^/]+))?$/.exec(path)!)));
      return send(res, answer.status, answer.body, answer.headers ?? {});
    }
    // A paired computer's driver trading its pairing code for its token: the code is its credential (computer-attach.ts),
    // limited by source address before anything in the body is checked.
    if (found.name === "pairComputer") return send(res, 201, await attach.pair(await bodyOf(req), clientOf(req)), { "cache-control": "no-store" });
    // A hosted machine fetching this server's computerd build: the token its create minted is its credential, never the
    // owner's (computer-attach.ts daemon).
    if (found.name === "getComputerDaemon") {
      const file = await attach.daemon(req.headers.authorization, url.searchParams.get("arch")).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) authFailed(`/v2${path}`, "machine_token");
        throw error;
      });
      const bytes = await readFile(file).catch(() => {
        throw new ApiError("unavailable", `this server has no computerd build at ${file}: run npm run build:daemon -w @parcha/agentrun-computer where it runs`);
      });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return void res.end(req.method === "HEAD" ? undefined : bytes);
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
      // The store this server opened (SQLite or Postgres), never a second open of the data directory's file.
      // Degraded (every runner here refused to claim) is 200: a platform's health check never restarts it over a setting.
      const health = await healthOf(store, data, minFreeBytes, undefined, refusedNow);
      return send(res, health.status === "failing" ? 503 : 200, health);
    }
    // Approving a learned workflow held for its owner's OK (a step calls a tool with no price) takes the owner's
    // signed-in page alone: never a token, which a run's process, an agent's MCP client or a script may hold, nor a
    // page cookie a token can mint (accounts off). The page's cookie stands in for the token only on its own origin
    // with a JSON body (page.ts), so this is CSRF-checked as every page write is. With no credential at all it is 401,
    // as every route is.
    // Restoring a retired one puts it back in every later run, as an approval does: the same owner's session alone.
    if (found.name === "restoreLearningFile" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "restore_without_session");
      throw new ApiError("forbidden", owner ? "Restoring a retired workflow takes the owner's password sign-in in the console, never a token." : "Restoring a retired workflow takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    if (found.name === "approveLearningFile" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "approve_without_session");
      throw new ApiError("forbidden", owner ? "Approving a workflow takes the owner's password sign-in in the console, never a token." : "Approving a workflow takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    // A replay its owner starts runs the agent's graded inputs again at its cost, and may promote a revision that then
    // serves first: the same session as an approval.
    if (found.name === "startLearnedWorkflowReplay" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "replay_without_session");
      throw new ApiError("forbidden", owner ? "Replaying a learned workflow's revision takes the owner's password sign-in in the console, never a token." : "Replaying a learned workflow's revision takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    // A run's live computer view, and its take-over and hand-back (COMPUTER_ROUTES), are a full-control credential for its
    // computer: the owner's signed-in page alone, as approving a note is (never a token a run, an MCP client or a script
    // may hold). An API-only server has no owner: there the server's token, its backend's own, takes a run's computer,
    // checked below as every route's token is.
    const runComputer = found.name === "getRunComputer" || COMPUTER_ROUTES.has(found.name);
    if ((found.name === "getRunBrowser" || found.name === "handBackRunBrowser" || (runComputer && !options.apiOnly)) && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      const what = found.name.endsWith("Browser") ? "browser" : "computer";
      authFailed(`/v2${path}`, `${what}_without_session`);
      throw new ApiError("forbidden", owner ? `A run's live ${what} takes the owner's password sign-in in the console, never a token.` : `A run's live ${what} takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).`);
    }
    // Answering a tool call that waits for approval (tool-gate.ts) is the same: the owner's signed-in page alone, never a
    // token, which the run's own process, an agent's MCP client or a script may hold.
    if (found.name === "answerApproval" && !byOwnerSession(req) && req.headers.authorization !== undefined) {
      authFailed(`/v2${path}`, "approve_without_session");
      throw new ApiError("forbidden", owner ? "Answering a tool call's approval takes the owner's password sign-in in the console, never a token." : "Answering a tool call's approval takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
    }
    // Purging a run or an agent, deleting another system's agent, or resetting an agent's learning cannot be undone: the
    // owner's session or the API token. A console session counts as the owner's only where it does for a secret
    // (secret-writes.ts: accounts off on a loopback-bound server); bound off loopback with accounts off, whoever opened the
    // console is no owner. With no credential at all it is 401, as every route is.
    if ((found.name === "deleteRun" || found.name === "deleteAgent" || found.name === "deleteAgentLearning") && byConsoleSession(req) && !writesSecretsAllowed(req, { accounts: owner !== undefined, loopbackBound: isLoopback(host) })) {
      authFailed(`/v2${path}`, "delete_without_owner");
      throw new ApiError("forbidden", "Deleting a run or an agent, or resetting an agent's learning, takes the owner's session (the password sign-in, or the console on a server bound to loopback) or the API token.");
    }
    // Saving, replacing or removing a secret (secret-writes.ts): the one check. Who may is mayWriteSecrets' alone (the
    // owner's session); which writes are secret is each plane's registered predicate, read from the body, so a token's
    // non-secret edit on the same route still goes through. A body that does not read counts as the plane says of none.
    // What a stored predicate read to let the request through (SecretRequest.seen): the operation's write is refused if
    // that changed before it lands, so a write allowed against one stored credential never lands over another.
    // `byToken`: the gate read this request as the API token's, so an MCP server it saves is recorded as the token's, and
    // it saves over or removes only one the token saved (mcp-secret-writes.ts tokenWriteOverRefused), compared again in
    // the statement that writes or removes the row (mcp-servers-store.ts save, remove).
    let secretSeen: unknown;
    let byToken = false;
    if (isSecretWriteOperation(found.name) && req.headers.authorization !== undefined && !writesSecretsAllowed(req, { accounts: owner !== undefined, loopbackBound: isLoopback(host) })) {
      byToken = true;
      const body = req.method === "DELETE" || req.method === "GET" ? undefined : await bodyOf(req).catch(() => undefined);
      // A segment that is not valid percent-encoding is taken as it came: the request goes on to the token's own check.
      const params = (found.pattern.exec(path) ?? []).slice(1).map((part) => {
        try {
          return part === undefined ? "" : decodeURIComponent(part);
        } catch {
          return part;
        }
      });
      const checked: SecretRequest = { params, store, apiOnly: options.apiOnly === true };
      if (await writesSecretFor(found.name, body, checked)) {
        authFailed(`/v2${path}`, "secret_without_session");
        // Where the person finishes it: the operation's console page, filled with what the request held that is no
        // secret (secretPageFor), at the address people open the console at.
        const page = await secretPageFor(found.name, body, { params, store });
        const link = page === undefined ? undefined : `${linkOrigin(req)}${page}`;
        throw new ApiError("forbidden", secretWriteRefusal(link), link === undefined ? {} : { details: { console_url: link } });
      }
      secretSeen = checked.seen;
    }
    // Connector credentials have no authority over the ordinary API. Enrollment is a one-use owner grant;
    // subsequent calls are restricted to one connector and its explicitly imported target allowlist.
    if (found.name === "registerRemoteConnector") {
      const credential = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      return send(res, 200, await new RemoteConnectors(store).register(credential, await bodyOf(req)));
    }
    if (found.name === "revokeRemoteConnector" && String(req.headers.authorization ?? "").startsWith("Bearer ar_connector_")) {
      const connectorId = decodeURIComponent(found.pattern.exec(path)![1]!);
      const broker = new RemoteConnectors(store);
      await broker.authenticate(connectorId, String(req.headers.authorization).slice(7));
      return send(res, 200, await broker.revoke(connectorId));
    }
    if (["importRemoteTarget", "importRemoteHistory", "pollRemoteConnector", "remoteCommandEvents", "completeRemoteCommand", "grantSourceSync", "publishSourceSync", "sourceSyncFailure"].includes(found.name)) {
      const parts = found.pattern.exec(path)!;
      const connectorId = decodeURIComponent(parts[1]!);
      const broker = new RemoteConnectors(store);
      await broker.authenticate(connectorId, String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      // History pages and command completions have separate bounded contracts; other JSON keeps MAX_BODY.
      const limit = found.name === "importRemoteHistory" ? REMOTE_HISTORY_BODY_BYTES
        : found.name === "completeRemoteCommand" ? REMOTE_COMPLETION_BODY_BYTES : found.name === "publishSourceSync" ? SOURCE_BODY_BYTES : MAX_BODY;
      const body = await bodyOf(req, limit);
      if (found.name === "importRemoteTarget") return send(res, 200, await broker.importTarget(connectorId, body, cliAdoptionResolver(store, new CliLearningConnections(store, sdkSecret))));
      if (found.name === "importRemoteHistory") return send(res, 200, await broker.importHistory(connectorId, decodeURIComponent(parts[2]!), body, [...tokens.map((entry) => entry.token),String(req.headers.authorization??"").replace(/^Bearer /,"")]));
      if (["grantSourceSync", "publishSourceSync", "sourceSyncFailure"].includes(found.name)) {
        const targetId = decodeURIComponent(parts[2]!), target = await broker.syncAuthority(connectorId, targetId);
        const scoped = sources.forConnector(broker, connectorId, targetId);
        if (found.name === "grantSourceSync") {
          if (Object.keys(body).length) throw new ApiError("input_invalid", "A sync grant takes an empty object; export authority comes from connector enrollment.");
          const granted = await agentWrite(target.agentId, async () => {
            const record = await scoped.grant(target.agentId);
            // Account/environment prerequisites can recover while source bytes stay unchanged.
            try { await scoped.reconcile(target.agentId); }
            catch (error) { if (!(error instanceof SourcePreparationError) && !(error instanceof ApiError && error.status < 500)) throw error; }
            return record;
          });
          return send(res, 200, granted);
        }
        const allowed = found.name === "publishSourceSync" ? ["generation", "sequence", "snapshot"] : ["generation", "sequence", "code"];
        if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.generation !== "string" || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0) throw new ApiError("input_invalid", "Supply the current sync generation and a non-negative sequence.");
        if (found.name === "sourceSyncFailure") {
          if (typeof body.code !== "string" || !Object.hasOwn(SOURCE_FAILURES, body.code)) throw new ApiError("input_invalid", "Choose a supported source failure code.");
          return send(res, 200, await agentWrite(target.agentId, () => scoped.failed(target.agentId, { generation: body.generation as string, sequence: Number(body.sequence), code: body.code as SourceFailureCode })));
        }
        if (!isObject(body.snapshot)) throw new ApiError("input_invalid", "Supply a complete source snapshot envelope.");
        try {
          // Even an idempotent replay must carry a valid bounded envelope; a matching digest is not validation.
          validateSourceSnapshot(body.snapshot as unknown as SourceSnapshot);
          const saved = await agentWrite(target.agentId, async () => {
            const published = await scoped.publish(target.agentId, { generation: body.generation as string, sequence: Number(body.sequence), snapshot: body.snapshot as unknown as SourceSnapshot });
            // Publication is durable even when a new setup cannot yet be applied; the owner sees its readiness reason.
            try { await scoped.reconcile(target.agentId); }
            catch (error) { if (!(error instanceof SourcePreparationError) && !(error instanceof ApiError && error.status < 500)) throw error; }
            return published;
          });
          return send(res, 200, saved);
        } catch (error) {
          if (error instanceof SnapshotError) throw new ApiError("input_invalid", error.message);
          throw error;
        }
      }
      if (found.name === "pollRemoteConnector") return send(res, 200, await broker.poll(connectorId, body));
      const commandId = decodeURIComponent(parts[2]!);
      return send(res, 200, found.name === "remoteCommandEvents" ? await broker.events(connectorId, commandId, body) : await broker.complete(connectorId, commandId, body));
    }
    if (found.name === "startCliLearningRun") {
      if (options.apiOnly || options.publicUrl || !isLoopback(host) || !isLoopback(req.socket.remoteAddress ?? "")) throw new ApiError("forbidden", "CLI learning runs require the enrolled local source server.");
      const connectionId=decodeURIComponent(found.pattern.exec(path)![1]!);
      const broker=new CliLearningConnections(store,sdkSecret);
      const connection=await broker.authenticate(connectionId,String(req.headers.authorization??"").replace(/^Bearer /,""));
      if(!req.headers["idempotency-key"])throw new ApiError("bad_request","A CLI prompt window requires Idempotency-Key.");
      const body=await bodyOf(req);
      if(Object.keys(body).some(key=>!["session_id","turn_id","input","instructions","policy_complete","model"].includes(key)) || typeof body.session_id!=="string" || !body.session_id || body.session_id.length>256 || typeof body.turn_id!=="string" || !body.turn_id || body.turn_id.length>256 || typeof body.policy_complete!=="boolean")throw new ApiError("input_invalid","Supply session_id, turn_id, input, instructions, and explicit policy_complete.");
      const entry=await needAgent(connection.agent_id);
      const runtime = NATIVE_RUNTIME_FACTS[connection.runtime].captureRuntime;
      const sdk=new SdkRuns(store,data,sdkSecret,()=>[...serverSecrets(),broker.token(connection)],[],"cli");
      const input={runtime,input:body.input,instructions:body.instructions,...(body.model!==undefined?{model:body.model}:{})};
      const key=`cli-window:${connectionId}:${connection.generation}:${createHash("sha256").update(`${body.session_id}\0${body.turn_id}`).digest("hex")}`;
      const fingerprint=createHash("sha256").update(stable(body)).digest("hex");
      const answer=await idempotent(req,`${path}:${connection.generation}`,body,async()=>({status:201,body:await sdk.start(entry,input,startDeps, {key,fingerprint},{check:async()=>{}},linkOrigin(req),{runtime,connection_id:connectionId,connection_generation:connection.generation,session_id:body.session_id as string,turn_id:body.turn_id as string,instructions:String(body.instructions??""),policy_complete:body.policy_complete as boolean})}));
      const receipt=await sdk.receipt((answer.body as {run_id:string}).run_id,linkOrigin(req));
      await broker.recordWindow(connectionId,connection.generation,receipt.run_id,body.session_id as string);
      return send(res,answer.status,receipt,answer.headers);
    }
    if (["getCliLearningRun","cliLearningEvents","completeCliLearningRun"].includes(found.name)) {
      const runId=decodeURIComponent(found.pattern.exec(path)![1]!);
      const authentication=new SdkRuns(store,data,sdkSecret,serverSecrets,[],"cli");
      await authentication.authenticate(runId,String(req.headers.authorization??"").replace(/^Bearer /,""));
      const launch=(await store.runs.launch(runId)).body as unknown as RunLaunch;
      if(!launch.cli_learning)throw new ApiError("not_found","This is not a CLI learning prompt window.");
      const connection=await new CliLearningConnections(store,sdkSecret).get(launch.cli_learning.connection_id);
      if(!connection.active || connection.generation !== launch.cli_learning.connection_generation)throw new ApiError("unauthenticated","The CLI learning connection was disconnected.");
      const sdk=new SdkRuns(store,data,sdkSecret,()=>[...serverSecrets(),new CliLearningConnections(store,sdkSecret).token(connection)],[],"cli");
      if(found.name==="cliLearningEvents")return send(res,200,await sdk.events(runId,await bodyOf(req)));
      if(found.name==="completeCliLearningRun"){const result=await sdk.complete(runId,await bodyOf(req));await new CliLearningConnections(store,sdkSecret).recordWindow(connection.connection_id,connection.generation,runId,launch.cli_learning.session_id);return send(res,200,result);}
      return send(res,200,{...await sdk.status(runId),learning:await servedRunLearning({serverSecrets,signIns,statuses},store,runId)});
    }
    if (["getSdkRun","sdkRunEvents","completeSdkRun"].includes(found.name)) {
      const runId=decodeURIComponent(found.pattern.exec(path)![1]!);
      const sdk=new SdkRuns(store,data,sdkSecret,serverSecrets,tokens.map((entry) => entry.token));
      await sdk.authenticate(runId,String(req.headers.authorization??"").replace(/^Bearer /,""));
      if(found.name==="sdkRunEvents")return send(res,200,await sdk.events(runId,await bodyOf(req)));
      if(found.name==="completeSdkRun")return send(res,200,await sdk.complete(runId,await bodyOf(req)));
      return send(res,200,{...await sdk.status(runId),learning:await servedRunLearning({serverSecrets,signIns,statuses},store,runId)});
    }
    if (!bearer(req.headers.authorization, req)) {
      authFailed(`/v2${path}`, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      throw new ApiError("unauthenticated", "this route needs Authorization: Bearer <the token in the data directory>", {}, { "www-authenticate": "Bearer" });
    }
    if (found.capability) throw unsupported(found.capability, UNSUPPORTED[found.capability]!);
    if (["discoverNative","connectNative","enrollCliLearning"].includes(found.name) && (options.apiOnly || options.publicUrl || !isLoopback(host))) throw new ApiError("forbidden", "Native connections require AgentRun on the source machine, bound to loopback without a public URL. A hosted browser cannot discover your laptop.");
    const [, first, second] = found.pattern.exec(path)!;
    const id = first ? decodeURIComponent(first) : "";
    // A purged run or agent (DELETE /runs/{id}, /agents/{id}): every route of it but its DELETE answers 410 purged, with
    // its tombstone in the details.
    if (id && ID.test(id)) {
      if (found.name !== "deleteRun" && found.pattern.source.startsWith("^\\/runs\\/([^/]+)")) {
        const row = await store.runs.get(id);
        if (row && row.purgedAt !== null) throw purgedRun(row);
      }
      if (found.name !== "deleteAgent" && found.pattern.source.startsWith("^\\/agents\\/([^/]+)")) {
        const agent = await store.agents.get(id);
        if (agent && agent.purgedAt !== null) throw purgedAgent(agent);
      }
    }
    switch (found.name) {
      case "enrollCliLearning": {
        if(!isLoopback(req.socket.remoteAddress ?? ""))throw new ApiError("forbidden","CLI learning enrollment must come from the local source machine.");
        const { source_sync, ...body } = await bodyOf(req);
        const connection = await new CliLearningConnections(store,sdkSecret).enroll(body);
        if (source_sync !== undefined) {
          await localSources.grant(connection.agent_id, source_sync); await sources.sync.grant(connection.agent_id);
          void sweepLocalSources();
        }
        return send(res,201,connection);
      }
      case "listCliLearning": return send(res,200,await new CliLearningConnections(store,sdkSecret).list());
      case "revokeCliLearning": return send(res,200,await new CliLearningConnections(store,sdkSecret).revoke(id));
      case "startSdkRun": {
        if(!req.headers["idempotency-key"])throw new ApiError("bad_request","An SDK run requires Idempotency-Key so a retried start never duplicates execution.");
        const body=await bodyOf(req),entry=await needAgent(id);
        // A learning SDK run's compile turn is asked on its agent's own model: checked reachable before the run starts.
        let compileModel: string | undefined;
        if(sdkOf(entry.revision?.body) && learnsOf((entry.revision!.body as AgenticBody).learning) && learning!=="off"){
          const configured = await learningModelOf(env, (await pinnedOf(entry, {}))!.revision);
          compileModel = configured.model ?? undefined;
        }
        const sdk=new SdkRuns(store,data,sdkSecret,serverSecrets,tokens.map((entry) => entry.token));
        const compile={...(compileModel?{model:compileModel}:{}),check:async()=>{
          // SdkRuns checks this only after its durable origin lookup, so a successful admission remains recoverable
          // when the owner has since changed its model or removed its key.
          const configured = await learningModelOf(env, entry.revision, { checkCredential: true });
          if (!configured.ready) throw new ApiError("agent_not_runnable", configured.reason ?? "Configure a server learning model in Settings → API Keys.");
        }};
        const answer=await idempotent(req,path,body,async origin=>({status:201,body:await sdk.start(entry,body,startDeps,origin,compile,linkOrigin(req))}));
        // Re-read the pinned receipt even on an in-memory replay: credentials saved since
        // the first response must still be withheld without reselecting a different seed.
        const receipt=await sdk.receipt((answer.body as {run_id:string}).run_id,linkOrigin(req));
        return send(res,answer.status,receipt,answer.headers);
      }
      case "getObservations": {
        const days = Number(url.searchParams.get("days") ?? 30);
        if (!Number.isInteger(days) || days < 1 || days > 31) throw new ApiError("input_invalid", "Choose an observation window from 1 to 31 days.");
        return send(res, 200, await new Observations(store, Date.now, new ObservationLearning(store, new CliLearningConnections(store, sdkSecret), learning !== "off")).snapshot(days, url.searchParams.get("session_id") ?? undefined));
      }
      case "getSourceSync": return send(res, 200, await sources.status(id));
      case "reviewSourceProject": {
        const body = await bodyOf(req), entry = await needAgent(id);
        if (!sourceSyncOf(entry.revision?.body)) throw new ApiError("input_invalid", "This agent has no moved project to review.");
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "receipts")) throw new ApiError("input_invalid", "Choose the unresolved run receipts you reviewed.");
        await reconcileProjectCheckpoints(store, id);
        await acknowledgeProjects(store, id, body.receipts);
        return send(res, 200, await sources.status(id));
      }
      case "setSourceSync": {
        const body = await bodyOf(req);
        if (Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") throw new ApiError("input_invalid", "Set enabled to true or false.");
        await sources.sync.setEnabled(id, body.enabled);
        return send(res, 200, await sources.status(id));
      }
      case "moveSourceAgent": {
        const body = await bodyOf(req);
        if (Object.keys(body).length) throw new ApiError("input_invalid", "Move takes an empty object and uses the latest complete synchronized setup.");
        try {
          const entry = await agentWrite(id, () => sources.sync.move(id));
          return send(res, 200, { agent: agentView(entry, linkOrigin(req), await agentExtra(entry)), source: await sources.status(id) });
        } catch (error) {
          if (error instanceof SourcePreparationError || error instanceof SnapshotError) throw new ApiError("agent_not_runnable", error.message);
          throw error;
        }
      }
      case "resolveSourceSync": {
        const body = await bodyOf(req);
        if (Object.keys(body).some(key => !["revision", "snapshot"].includes(key)) || typeof body.revision !== "string" || typeof body.snapshot !== "string") throw new ApiError("input_invalid", "Choose the source snapshot and current agent revision you reviewed.");
        try {
          const entry = await agentWrite(id, () => sources.sync.useSource(id, { revision: body.revision as string, snapshot: body.snapshot as string }));
          return send(res, 200, { agent: agentView(entry, linkOrigin(req), await agentExtra(entry)), source: await sources.status(id) });
        } catch (error) {
          if (error instanceof SourcePreparationError || error instanceof SnapshotError) throw new ApiError("agent_not_runnable", error.message);
          throw error;
        }
      }
      case "bindSourceTool": {
        const body = await bodyOf(req), record = await sources.sync.get(id);
        if (Object.keys(body).some(key => !["tool", "server"].includes(key)) || typeof body.tool !== "string" || typeof body.server !== "string") throw new ApiError("input_invalid", "Choose a source tool and its destination connection.");
        if (!record?.snapshot) throw new ApiError("agent_not_runnable", "Sync the complete setup before choosing its tool connections.");
        const snapshot = await sources.sync.options.read(id, record.snapshot), requirement = snapshot.configuration.tools.find(tool => tool.name === body.tool);
        if (!requirement) throw new ApiError("input_invalid", "Choose a tool required by this source setup.");
        await bindSourceTool(store, id, requirement, body.server);
        return send(res, 200, await sources.status(id));
      }
      case "listRemoteConnectors": return send(res, 200, await new RemoteConnectors(store).list());
      case "enrollRemoteConnector": return send(res, 200, await new RemoteConnectors(store).enroll(await bodyOf(req)));
      case "revokeRemoteConnector": return send(res, 200, await new RemoteConnectors(store).revoke(id));
      case "discoverNative": {
        const body=await bodyOf(req);
        if(typeof body.project!=="string" || (body.runtime!==undefined && !isNativeRuntime(body.runtime))) throw new ApiError("input_invalid","Choose the project directory on this source machine and a supported CLI runtime.");
        return send(res,200,await discoverNative({project:body.project,...(body.runtime?{runtime:body.runtime}:{})}));
      }
      case "connectNative": {
        const { source_sync, ...body } = await bodyOf(req);
        const entry=await connectNative(store,body);
        if (source_sync !== undefined) { await localSources.grant(entry.agent.id, source_sync); await sources.sync.grant(entry.agent.id); void sweepLocalSources(); }
        return send(res,200,{agent:agentView(entry,linkOrigin(req),await agentExtra(entry)),native:nativeOf(entry.revision?.body)});
      }
      case "getNative": {
        const entry=await needAgent(id);
        const native=nativeOf(entry.revision?.body);
        return send(res,200,{native:native?.remote?await new RemoteConnectors(store).status(native):native??null});
      }
      case "verifyNative": {
        const before=await needAgent(id);
        if(!nativeOf(before.revision?.body)?.remote && (options.apiOnly || options.publicUrl || !isLoopback(host)))throw new ApiError("forbidden","Local native verification must run on the source machine.");
        const entry=nativeOf(before.revision?.body)?.remote?await verifyRemote(store,before):await verifyConnection(store,before);
        return send(res,200,{native:nativeOf(entry.revision?.body)});
      }
      case "disconnectNative": {
        const entry=await needAgent(id); const native=nativeOf(entry.revision?.body);
        if(!native)throw new ApiError("not_found","This agent has no native connection.");
        await localSources.revoke(id);
        const changed=await updateNative(store,entry,{...native,connected:false});
        if(native.remote)await new RemoteConnectors(store).disconnectTarget(native);
        return send(res,200,{native:nativeOf(changed.revision?.body)});
      }
      case "createAgent": {
        const body = await bodyOf(req);
        if (isObject(body.definition) && body.definition.cli_learning !== undefined) throw new ApiError("input_invalid", "CLI learning references are registered only through /cli-learning/connections on the source machine.");
    if (isObject(body.definition) && body.definition.native !== undefined) throw new ApiError("input_invalid", "Native references are registered only through /native/connect on the source machine.");
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
        // A tool of bash's family the agent's computer gives no shell for reads unavailable (runShellOf).
        const revision = entry.revision as unknown as Revision | undefined;
        const tooling = revision ? await toolingOf(revision) : undefined;
        // An MCP tool's effect, what "allow reads" reads: as the revision's pin marks it (pinnedEffect), the marks its runs
        // read. A revision saved before pins were made at save holds none until its first run, which pins its saved
        // server's listing then (pinFirst): so until then, that listing now (mcp-servers-store.ts).
        const pin = (revision as { mcpPin?: McpPin | null } | undefined)?.mcpPin ?? undefined;
        const listed = !pin && tooling?.tools.some((name) => mcpToolOf(name)) ? new Map((await store.mcp.servers()).map((row) => [row.name, (row.tools ?? []) as { name: string; annotations?: unknown }[]])) : undefined;
        const effectOf = (name: string) => {
          if (pin) return pinnedEffect(pin, name);
          const parsed = mcpToolOf(name);
          const tool = parsed && listed?.get(parsed.server)?.find((one) => one.name === parsed.tool);
          return tool ? toolEffect(tool.annotations) : undefined;
        };
        const tools = revision && tooling ? agentTools(env, settings.get(), tooling, caps.tools.map((tool) => tool.name), await shellOfRevision(revision), effectOf) : [];
        return send(res, 200, { ...agentView(entry, linkOrigin(req), await agentExtra(entry)), tools, run_blockers: await runBlockersOf(entry) }, { etag: etagOf(entry) });
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
        const cliEdit=contract?body.cli_learning:isObject(body.definition)?body.definition.cli_learning:undefined;
        if(cliEdit!==undefined&&stable(cliEdit)!==stable(cliLearningOf(entry.revision?.body)))throw new ApiError("input_invalid","CLI learning bindings are changed only through their enrollment endpoints.");
        const nativeEdit = contract ? body.native : isObject(body.definition) ? body.definition.native : undefined;
        if (nativeEdit !== undefined && stable(nativeEdit) !== stable(nativeOf(entry.revision?.body))) throw new ApiError("input_invalid", "Native references are changed only through the native connection endpoints. Normal edits retain the existing reference.");
        // Check explicit native selectors before canonicalization (the ordinary default harness, pi, is not stored).
        const definition = contract ? body : body.definition;
        if (nativeOf(entry.revision?.body) && isObject(definition)) {
          const execution = nativeExecutionOverrides({ ...definition, native: nativeOf(entry.revision?.body) });
          if (execution.length) throw invalid(execution.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_EXECUTION_SETTINGS_UNSUPPORTED })));
        }
        if (contract) {
          if (match === undefined) throw new ApiError("precondition_failed", "If-Match is required: the agent's ETag, as GET /agents/{agent_id} returned it.");
          if (body.version === undefined || (typeof body.version === "number" && body.version <= entry.version)) throw invalid([{ field: "definition.version", reason: body.version === undefined ? "missing" : "not_an_option", message: `definition.version must be greater than the current one, ${entry.version}` }]);
        }
        // The checks above are a fast path on the agent as the request found it, its body read after. The commit reads the
        // agent again in its delete turn (reviseAgentOf, agentWrite): one whose body arrived once the agent was purged is
        // 410, nothing written. The store compares If-Match again inside the commit, so of two edits that read the same
        // revision exactly one lands.
        const { entry: edited, warnings } = await reviseAgentOf(entry, contract ? { definition: body } : body, { contract, ...(match === undefined ? {} : { ifCurrent: entry.revision?.id ?? null }) });
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
      case "getAgentPackage": {
        const entry = await needAgent(id);
        const { agent, revision } = entry;
        // An agent whose source is somewhere else has no package here: its project or application holds it.
        const body = (revision?.body ?? {}) as Json;
        const elsewhere = ownedElsewhere(agent) ? "another system's agent, which that system defines" : body.native ? "a native agent, which its project on its own machine defines" : body.cli_learning ? "a CLI learning agent, which its CLI's sessions define" : body.sdk ? "an SDK agent, which its application's code defines" : undefined;
        if (elsewhere) throw new ApiError("not_exportable", `The agent ${id} is ${elsewhere}: export it from there.`);
        if (!revision || revision.kind !== "agentic") throw new ApiError("not_exportable", `The agent ${id} ${revision ? "is a workflow, and a template package holds an agent" : "has no revision to export"}.`);
        // Its triggers: those that start its runs and those that message one of them (each row names the agent it runs as).
        const own = new Set((await store.triggers.list(id)).map((row) => row.id));
        const views = (await triggers.list()).triggers.filter((view) => own.has(view.id)) as unknown as Json[];
        const answer = agentPackage({
          agent: { id, name: agent.name, description: agent.description ?? null },
          definition: definitionOf(agent, revision, entry.version),
          skills: (isObject(revision.skills) ? revision.skills : {}) as Record<string, string>,
          template: entry.template ? { id: entry.template.id, version: entry.template.version, ...(entry.template.secrets ? { secrets: entry.template.secrets } : {}) } : null,
          origin: entry.template ? registry.get(entry.template.id) : undefined,
          servers: mcpMeta,
          triggers: views,
          signIns: await store.signIns.list(id),
          now: options.triggerClock?.now() ?? Date.now(),
        });
        return send(res, 200, answer);
      }
      case "setCurrent": {
        // The body read first, outside the agent's delete turn; the move made in it (agentWrite), as an edit's revision is:
        // one whose body arrives while the agent is purged is 410 (the store refuses it too, AgentPurged).
        const body = await bodyOf(req);
        const moved = await agentWrite(id, async () => {
          const entry = await needAgent(id);
          const extra = unknownFields(body, ["revision"]);
          if (extra.length) throw invalid(extra);
          const revision = body.revision;
          if (typeof revision !== "string" || !ID.test(revision)) throw invalid([{ field: "revision", reason: revision === undefined ? "missing" : "wrong_type", message: "revision is a revision id of this agent" }]);
          const candidate = await agents.revision(id, revision);
          if (!candidate) throw invalid([{ field: "revision", reason: "not_an_option", message: `${revision} is not a revision of the agent ${id}` }]);
          if (sourceSyncOf(candidate.revision.body)?.id !== sourceSyncOf(entry.revision?.body)?.id) throw new ApiError("input_invalid", "A revision restore cannot change this agent’s source ownership. Keep a revision from after Move.");
          if (stable(cliLearningOf(candidate.revision.body)) !== stable(cliLearningOf(entry.revision?.body))) throw new ApiError("input_invalid", "A revision restore cannot change the enrolled CLI learning connection.");
          if (stable(nativeOf(candidate.revision.body)) !== stable(nativeOf(entry.revision?.body))) throw new ApiError("input_invalid", "This revision changes the native connection. Reconnect or verify through the native connection controls; ordinary revision restore cannot change its source or connection state.");
          if (nativeOf(candidate.revision.body)) {
            const overrides = nativeModelOverrides(candidate.revision.body);
            if (overrides.length) throw invalid(overrides.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_MODEL_SETTINGS_UNSUPPORTED })));
            const execution = nativeExecutionOverrides(candidate.revision.body);
            if (execution.length) throw invalid(execution.map(field => ({ field: `definition.${field}`, reason: "not_allowed", message: NATIVE_EXECUTION_SETTINGS_UNSUPPORTED })));
          }
          return agents.setCurrent(entry, revision);
        });
        reconcileComputer(id);
        return send(res, 200, agentView(moved, linkOrigin(req), await agentExtra(moved)), { etag: etagOf(moved) });
      }
      case "deleteAgent": {
        // Another system's agent deleted whole; one made here purged once archived (agent-delete.ts). One delete of an agent
        // at a time, the agent read in its turn, so a DELETE after one that finished is 404 (deleted) or 204 (purged).
        try {
          await deleteInTurn(id, async () => {
            const { agent } = await needAgent(id);
            if (agent.purgedAt !== null) return;
            if (ownedElsewhere(agent)) return deleteExternalAgent(agentDeleteHost, id);
            if (agent.archivedAt === null) throw new ApiError("agent_not_archived", `The agent ${id} is not archived: archive it first (POST /v2/agents/${id}/archive), which stops new runs and turns its triggers off, then send the DELETE again. Nothing was purged.`);
            await purgeAgent(agentDeleteHost, id);
          });
        } finally {
          // An upload its purge took with it is no longer served: also after a purge that committed and then failed, and on
          // the DELETE sent again. A store that cannot answer leaves it to the next DELETE, or the next start's load.
          await dropRemovedUploads({ registry, store }).catch(() => undefined);
        }
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "archiveAgent":
      case "unarchiveAgent": {
        // An agent another system owns is that system's to keep or drop: archiving it here is refused, as an edit is.
        refuseExternal((await needAgent(id)).agent);
        // No run sweep on archive: a runner reads an archived agent's run rows directly, nothing to sweep.
        // The engine archives (or unarchives) the agent itself: archived, every trigger that runs as it turns off with
        // agent_archived in that same store transaction; unarchived, none turns on. Never archived first by another path,
        // which would turn its triggers off with no reason and leave the answer empty. Both answer the triggers off for
        // the archive, each turned on again by PATCH /triggers/{id} {enabled: true}.
        // In the agent's delete turn (agentWrite): an unarchive sent while its purge runs waits for it and is 410, so no
        // run of it starts between the purge's live check and its tombstone.
        // On an API-only server with the launch hook, which serves no trigger route to turn one on, the unarchive turns its
        // schedule and feed triggers on again (the ones its apply makes there).
        const turnOn = options.apiOnly && options.launchHook ? (source: { kind: string }) => API_ONLY_HOOKED_KINDS.has(source.kind) : undefined;
        const triggersOff = await agentWrite(id, () => (found.name === "archiveAgent" ? triggers.agentArchived(id) : triggers.agentUnarchived(id, turnOn)));
        // An archived agent's own computer is deleted (an unarchived one gets a new one at its next persistent run).
        if (found.name === "archiveAgent") reconcileComputer(id);
        const entry = await needAgent(id);
        return send(res, 200, { ...agentView(entry, linkOrigin(req), await agentExtra(entry)), triggers_off: triggersOff }, { etag: etagOf(entry) });
      }
      case "getAgentArchil":
      case "deleteAgentArchil": {
        // The agent's Archil disk (archil-routes.ts): its rules are the handler's; the dispatch reads the agent (archived, or
        // managed by its source) and how to count the live runs on a disk.
        const entry = await needAgent(id);
        const controller = new AbortController();
        req.once("close", () => controller.abort());
        const agent = { id, archived: entry.agent.archivedAt != null, external: ownedElsewhere(entry.agent), liveOn: (diskId: string) => liveRunsOnDisk(store.runs, id, diskId) };
        return send(res, 200, await archilRoute(archil, found.name, { agent, signal: controller.signal }), { "cache-control": "no-store" });
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
      case "createInlineRun": {
        const answer = await createInlineRun(req);
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
        const run = await runRead(id, linkOrigin(req));
        if (!run) throw new ApiError("not_found", `no run ${id}`);
        return send(res, 200, run);
      }
      case "getTimeline":
        await needRun(id);
        // Awaited, not dropped: a throw from the timeline (a run gone mid-stream, a bad page) reaches the router's catch,
        // which answers; a floated rejection would hang the request with no answer.
        return await timeline(req, res, url, id);
      case "sendMessage": {
        const run = await needRun(id);
        if (run.kind === "workflow") throw unsupported("messages.steer_workflow_runs", "A workflow run takes no messages here: its workflow runs to its end, or a cancel ends it.");
        const { body, handed } = handedLaunchSecrets(await bodyOf(req));
        const answer = await idempotent(req, `/runs/${id}/messages`, body, async () => {
          const seal = await messageSeal(run, await handed());
          const extra = unknownFields(body, ["content"]);
          if (extra.length) throw invalid(extra);
          const content = body.content;
          if (typeof content !== "string" || !/\S/.test(content)) throw invalid([{ field: "content", reason: content === undefined ? "missing" : "wrong_type", message: "content is a non-empty string" }]);
          if (content.length > MAX_MESSAGE) throw invalid([{ field: "content", reason: "too_long", message: `content is at most ${MAX_MESSAGE} characters` }]);
          // Its mcp_auth and model_key replace the run's in the steer's own write, so the turn it starts uses them.
          // In its agent's delete turn (runWrite): a message that may open the run again never lands under its purge.
          const { mode, messageId } = await runWrite(run.agentId, run.id, () => message(store, run, content, { ...(seal ? { launchSealed: seal } : {}), ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}) }));
          // The run's state after the command row is written (the run view): the runner applies the steer; the client polls.
          const { status, state } = await runStatusState(run.id);
          return { status: 202, body: { run_id: run.id, message_id: messageId, mode, status, state, poll_after_ms: 1000 } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "raiseRunCap": {
        // The run is read once its body is in, right before the raise row is written: the pause the answer names
        // (raiseFollowUpId) is the one the run stands at when its runner takes that row, never one an earlier raise ended
        // while this body was on its way.
        if (!ID.test(id) || !(await store.runs.get(id))) throw new ApiError("not_found", `no run ${id}`);
        const body = await bodyOf(req);
        const extra = unknownFields(body, ["max_cost_usd"]);
        if (extra.length) throw invalid(extra);
        const cap = body.max_cost_usd;
        if (!(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) throw invalid([{ field: "max_cost_usd", reason: cap === undefined ? "missing" : "wrong_type", message: "max_cost_usd is a number above 0" }]);
        const run = await needRun(id);
        const now = run.maxCostUsd;
        if (now === undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "This run has no cap to raise: a cap is named when a run starts." }]);
        const { resumed, messageId, note } = await raiseCap(store, run, cap);
        const { status, state } = await runStatusState(run.id);
        return send(res, 200, { run_id: run.id, max_cost_usd: cap, resumed, ...(messageId ? { message_id: messageId } : {}), ...(note ? { note } : {}), status, state });
      }
      case "deleteRun": {
        // In its agent's delete turn (an agent's delete or purge, or another purge of one of its runs, finishes first), the
        // run read in that turn, so a DELETE after one that finished is 204 again (purgeRun: a purged run's only work is
        // its learning folder's scrub, again).
        const row = ID.test(id) ? await store.runs.get(id) : undefined;
        if (!row) throw new ApiError("not_found", `no run ${id}`);
        // API-only (api-only.ts) purges a run wherever its token may delete the run's whole agent, which is any agent:
        // another system's, and one made here once archived. One run is less than all of them, so it is served alike.
        await deleteInTurn(row.agentId, () => purgeRun(agentDeleteHost, id));
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "stopRun": {
        const run = await needRun(id);
        const stopped = await stopRunOverStore(store, run);
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
        const issues: InputIssue[] = Object.keys(body).filter((k) => k !== "decision" && k !== "note" && k !== "confirm_destructive").map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` }));
        if (body.confirm_destructive !== undefined && body.confirm_destructive !== true) issues.push({ field: "confirm_destructive", reason: "wrong_type", message: "confirm_destructive is true when sent: the second confirm of a destructive call's allow" });
        if (body.decision !== "allow" && body.decision !== "deny") issues.push({ field: "decision", reason: body.decision === undefined ? "missing" : "not_an_option", message: "decision is allow or deny" });
        if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) issues.push({ field: "note", reason: "wrong_type", message: "note is a string of at most 2000 characters" });
        if (issues.length) throw invalid(issues);
        await approve(store, run, decodeURIComponent(second!), body.decision as "allow" | "deny", typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined, body.confirm_destructive === true);
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "gradeRun": {
        const row = ID.test(id) ? await store.runs.get(id) : undefined;
        if (!row) throw new ApiError("not_found", `no run ${id}`);
        const body = await bodyOf(req);
        const extra = unknownFields(body, ["correct", "expected", "source", "label"]);
        if (extra.length) throw invalid(extra);
        if (typeof body.correct !== "boolean") throw invalid([{ field: "correct", reason: body.correct === undefined ? "missing" : "wrong_type", message: "correct is true or false: whether the run's answer was right" }]);
        if (body.expected !== undefined && !isObject(body.expected)) throw invalid([{ field: "expected", reason: "wrong_type", message: "expected is an object: the fields a right answer's JSON holds" }]);
        if (body.source !== undefined && !GRADE_SOURCES.includes(body.source as never)) throw invalid([{ field: "source", reason: "not_an_option", message: `source is one of ${GRADE_SOURCES.join(", ")}` }]);
        if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > LABEL_MAX)) throw invalid([{ field: "label", reason: "wrong_type", message: `label is a string of at most ${LABEL_MAX} characters: the grade's words` }]);
        // A run that reads ended while it still learns from that end (its look-back: store-view.ts lookingBackEnd) is graded
        // once that ends: its row is not ended yet, and the round a grade opens reopens only an ended run.
        if (!FINAL_STATES.includes(row.state) && (await lookingBackEnd(store, row))) throw new ApiError("run_learning", "The run is still learning from its answer: grade it once that ends.");
        if (!FINAL_STATES.includes(row.state)) throw invalid([{ field: "run_id", reason: "not_allowed", message: "A run is graded once it has ended." }]);
        const m = (isObject(row.metrics as Json) ? row.metrics : {}) as { path?: unknown; workflow?: unknown; workflow_digest?: unknown; workflow_promotion?: unknown };
        if (m.path === "replay") throw invalid([{ field: "run_id", reason: "not_allowed", message: "A replay run is never graded: its answer is scored against the run it replays." }]);
        if (m.path === "audit" || isShadowRun(row.id)) throw invalid([{ field: "run_id", reason: "not_allowed", message: "An audit's shadow run is never graded: grade the run it audits." }]);
        const path = RUN_PATHS.includes(m.path as never) ? (m.path as Grade["path"]) : "agent";
        const grade: Grade = {
          run: row.id, correct: body.correct, ...(body.expected !== undefined ? { expected: body.expected as Record<string, unknown> } : {}), source: (body.source as GradeSource | undefined) ?? "feedback", at: new Date().toISOString(), path,
          ...(typeof m.workflow === "string" ? { workflow: m.workflow } : {}), ...(typeof m.workflow_digest === "string" ? { digest: m.workflow_digest } : {}),
          ...(typeof m.workflow_promotion === "number" ? { promotion: m.workflow_promotion } : {}),
        };
        // The grade and its audit row are written to the agent's learning in its delete turn (agentWrite): a grade whose body
        // came in while a DELETE ran waits for it and finds the agent gone, so nothing is written after its learning went.
        const kept = await runWrite(row.agentId, row.id, async () => {
          // Kept with what it asks of the run's learning (runner/feedback-round.ts): nothing, or a look-back.
          // Its feedback round is a turn with no caller's model key: on the server's key for the run's route, else not opened.
          const graded = gradeView(await keepGrade(store, row.agentId, grade, typeof body.label === "string" ? body.label : undefined, (launch) => !serverKeyMissing(env, { kind: "agentic", model: launch.model, native: Boolean(launch.native) })));
          // A grade of a run its learned workflow answered alone is an audit row too (runner/audit.ts gradeRow): the hold rule
          // reads it with the shadows'. A row not written now is logged, never the grade refused.
          const said = (line: string) => log?.(logLine("audit", { run: row.id, said: line }));
          await gradeRow({ store, agentId: row.agentId, revisionId: row.revisionId, context: ctx, folder: () => learningFolderOf(data, row.agentId), shown: () => learningShown(row.agentId), log: said }, row, grade.correct).catch((error) => said(`the grade wrote no audit row (${(error as Error)?.message ?? error})`));
          return graded;
        });
        // Its workflow's name cut as GET /runs/{id}/learning cuts it (learningShown); withheld whole when that cut can't be
        // read (the grade is kept by then: never a shorter cut, never a refusal of a grade it kept).
        const shown = await learningShown(row.agentId).catch(() => undefined);
        return send(res, 200, { ...kept, workflow: kept.workflow === null ? null : shown ? shown.name(kept.workflow) : REDACTED });
      }
      case "archiveRun":
      case "unarchiveRun": {
        const run = await needRun(id);
        await archiveRun(store, run.id, found.name === "archiveRun");
        return send(res, 200, await viewOverStore(store, run.id, runReadDepsFor(linkOrigin(req))));
      }
      case "getRunBrowser":
      case "getRunComputer": {
        // One read for both families, over the one store: the computer family's answer, and the browser's own in its base
        // shape (its link under /browser/live, no kind or hold, off's why as `reason`).
        const run = await needRun(id);
        const family: LiveFamily = found.name === "getRunBrowser" ? "browser" : "computer";
        // The run's open viewer, from the store's sealed viewer rows the runner publishes its hand-over into (browser-live.ts
        // liveViewerLink/computerViewerLink, under the seal key); who drives, from the cut's computerHoldOf over the store,
        // and where a computer with no viewer is (sessionIn), both over one read of the run's journal.
        const entries = (await runEntries(store, run.id, ctx)) as unknown as readonly JournalEntry[];
        const hold = await computerHoldOf(store, run.id, { entries: async () => entries });
        const kept = await keptBrowserOf(store, run.id);
        // A desktop or a phone (the run's revision's computer) whose screen is not open now is still the run's computer:
        // none with its kind, never off as if the agent had none (#2170).
        const own = family === "computer" ? await runComputerKind(store, run.id) : undefined;
        const viewed = own === "desktop" || own === "phone" ? own : undefined;
        // A parked run's desktop or phone is no screen being opened: its claim let it go, or kept it for the resume
        // (computer-kept.ts; the run's timeline says until when), and once its time passed, the timeout's words.
        const parked = family === "computer" && !run.terminal && (await store.runs.get(run.id))?.state === "parked";
        const view = await computerView({
          viewer: async () => {
            if (family === "browser") {
              const link = await liveViewerLink(store, sealKey, run.id, answers(run.id));
              return link === undefined ? undefined : { kind: "browser" as const, viewer: link.viewer };
            }
            return computerViewerLink(store, sealKey, run.id, answers(run.id));
          },
          computer: () => (viewed ? { kind: viewed } : computerOf(kept, env, family, own)),
          session: (kind) => sessionIn(kind, entries, run.terminal || (parked && kind !== "browser")),
          lapsed: async (kind) => (parked ? lapsedOf(kind, await readKept(store.settings, run.id).catch(() => undefined), Date.now()) : undefined),
          hold: () => hold,
          // A going run's browser let go while it waited for its person: the Screen tab says so, with when. One settings
          // row (browser-wait-ended.ts), never the run's journal: this is read on every Screen poll.
          // For an ended run, nothing, and its row goes.
          ended: () => screenWaitEnded(store.settings, run.id, run.terminal),
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
        const answer = await computerRoute(found.name, run.id, await bodyOf(req), store, { context: ctx });
        return send(res, 200, answer, { "cache-control": "no-store" });
      }
      case "createRunComputerViewer": {
        // A viewer credential for the run's live view (viewer-credential.ts), for an API-only server's backend to hand its
        // user: a link on the public address to the run's open viewer, the credential in its query, the viewer's own token
        // in its fragment. A server with no backend in between has an owner who opens the view in the console: not here.
        if (!options.apiOnly) throw new ApiError("not_found", "A run's viewer link is minted on an API-only server alone (AGENTRUN_API_ONLY=1): here its owner opens the live view in the console.");
        const run = await needRun(id);
        const body = await bodyOf(req);
        const issues = unknownFields(body, []);
        if (issues.length) throw invalid(issues);
        if (!options.publicUrl) throw new ApiError("unsupported_here", "A run's viewer link is on this server's public address, and AGENTRUN_PUBLIC_URL is unset: set it to the address your users' browsers open this server at.");
        if (await runOver(store, run.id)) throw new ApiError("computer_not_live", "This run has ended: its computer has no live view.");
        const link = await computerViewerLink(store, sealKey, run.id, answers(run.id));
        if (link === undefined) throw new ApiError("computer_not_live", "This run's computer has no live view open now: ask again once GET /v2/runs/{run_id}/computer reads live.");
        const { credential, expiresAt } = mintViewerCredential(viewerKey, run.id, Date.now());
        const [path, fragment] = link.viewer.split("#");
        const minted = `${options.publicUrl.replace(/\/+$/, "")}${path}?${VIEWER_PARAM}=${credential}${fragment === undefined ? "" : `#${fragment}`}`;
        return send(res, 201, { url: minted, expires_at: new Date(expiresAt).toISOString() }, { "cache-control": "no-store" });
      }
      case "startRun":
      case "callRunComputer":
      case "releaseRunComputer": {
        // A call on a run's computer (the computer call channel) and a held computer's start and release
        // (computer-held-routes.ts), over the store: each a command row the run's runner applies.
        const run = await needRun(id);
        return send(res, 200, await heldRoute(found.name, run.id, await bodyOf(req), store, { context: ctx }), { "cache-control": "no-store" });
      }
      case "createPairing":
        return send(res, 201, await attach.createPairing(), { "cache-control": "no-store" });
      case "attachComputer":
        throw new ApiError("bad_request", `${ATTACH_PATH} is the attach WebSocket: a paired computer's driver dials it with Upgrade: websocket and its own token`);
      case "deleteComputer":
        await attach.remove(id);
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "listRunningComputers": {
        const origin = linkOrigin(req);
        return send(res, 200, await runningComputers(store, (runId) => runRead(runId, origin)), { "cache-control": "no-store" });
      }
      case "listComputers":
      case "saveComputerKeys":
      case "testComputer":
      case "listComputerChoices": {
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
        // With ?cut=run, each file's name under the run's cut too.
        return send(res, 200, await listRunFilesOverStore(store, id, runReadsDeps, url.searchParams.get("cut")));
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
        const written = await agentWrite(id, async () => {
          const home = await homeWorkspace(id, true);
          await home!.write(rel, bytes).catch(homeRefusal);
          return entryAt(home!, rel);
        });
        if (written?.kind !== "file") throw new ApiError("not_found", "no such file");
        return send(res, 200, viewOf(rel, written));
      }
      case "deleteHomeFile": {
        await needAgent(id);
        if (!homeWrites) throw new ApiError("unsupported_here", HOME_WRITES_OFF);
        const rel = homePath(second!, id, true);
        // A remove is a write to the agent's home: in its delete turn (agentWrite), as a file's write is.
        await agentWrite(id, async () => {
          const home = await homeWorkspace(id, false);
          if (!home) throw new ApiError("not_found", "no such file");
          // A file alone: a folder is refused by the listing; a link (never listed) by the Workspace's remove (ESCAPE).
          if ((await entryAt(home, rel))?.kind === "dir") throw new ApiError("invalid_file_path", "the path names a directory, or runs through a file");
          await home.remove(rel).catch((error: unknown) => {
            if (isWorkspaceError(error, "NOT_FOUND")) throw new ApiError("not_found", "no such file");
            homeRefusal(error);
          });
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
        const { workflowIssues } = await import("./workflow-run.js");
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
      case "getRunUsage":
        await needRun(id);
        // The run's lines from its booking (run-usage.ts), the figures its cost.usd joins: none, with why, while it is at work
        // or where its figure is not its booking's.
        // Names through the run's cut, and a withheld run refused (403), as its trace is.
        return send(res, 200, await servedRunUsage({ serverSecrets, signIns }, store, id));
      case "getRunTrace":
        await needRun(id);
        // The run's spans over its served Timeline rows and its journal (run-trace.ts): cut by the run's one cut, as its
        // Timeline is; a run withheld is refused (403), as its graph is.
        return send(res, 200, await servedRunTrace(servedTimelineDeps, store, id, ctx));
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
        const kept = await uploadsHere(true);
        if (url.searchParams.has("path") || !isJson(req)) {
          const received = await kept.take(url.searchParams, req.headers["content-type"], req);
          try {
            const answer = await idempotent(req, "/files", received.fingerprint, async () => ({ status: 201, body: await received.commit() }));
            return send(res, answer.status, answer.body, answer.headers);
          } finally {
            await received.discard();
          }
        }
        const body = await bodyOf(req);
        const answer = await idempotent(req, "/files", body, async () => ({ status: 201, body: await kept.reserve(body) }));
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "uploadFile":
        return send(res, 200, await (await uploadsHere()).receive(id, req));
      case "listFiles": {
        const kept = await uploadsHere();
        // This server's own: its uploads, newest first, a page at a time, so an id is never lost with the answer that gave it.
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const ids = await kept.ids();
        const files = (await Promise.all(ids.slice(offset, offset + limit).map((fileId) => kept.get(fileId)))).filter((file) => file !== null);
        return send(res, 200, { files, next_cursor: nextCursor(offset + limit, ids.length) });
      }
      case "getFile": {
        const file = await (await uploadsHere()).get(id);
        if (!file) throw new ApiError("not_found", `no file ${id}: GET /v2/files lists the files this server keeps`);
        return send(res, 200, file);
      }
      case "deleteFile":
        await (await uploadsHere()).remove(id);
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "getUsage":
        return send(res, 200, await usage(url));
      case "getCapacity":
        return send(res, 200, await capacityOverStore(store.runners, capacityWindowOf(url)));
      case "getWrapped": {
        // The session files of the machine this server runs on: only a server bound to loopback with no public URL answers.
        // A name an operator allowed (--allow-host) passes the server's Host check for its other routes, but a page that rebound
        // one to this address must not read the machine's files: here the Host is a loopback name or address, or it is refused.
        if (options.apiOnly || options.publicUrl || !isLoopback(host) || !isLoopbackName(hostName(req.headers.host))) throw new ApiError("forbidden", "wrapped reads this machine's own session files, so only a server on loopback with no public URL, reached by a loopback name, answers it");
        const given = url.searchParams.get("year");
        const year = given === null ? new Date().getFullYear() : Number(given);
        if (given !== null && !/^[1-9]\d{3}$/.test(given)) throw new ApiError("bad_request", "year is a four-digit year");
        const [{ wrapped, unread }, analytics] = await Promise.all([readWrapped(year), analyticsOverStore(store, { from: new Date(year, 0, 1).toISOString(), to: new Date(year + 1, 0, 1).toISOString() })]);
        return send(res, 200, wrappedView(wrapped, analytics.bySource.filter((g) => g.source !== "live").map((g) => ({ source: g.source, runs: g.runs })), unread));
      }
      case "getStats": {
        const filter = analyticsFilter(url);
        // The store's counts and cost sums (store-reads/stats), the runs' metrics summed (store-reads/analytics), and the
        // runs over the store for the learning counts. No in-process pending set and no held Runs: the runner writes a
        // run's end to the store before it lets it go.
        const [s, a, tokens] = await Promise.all([statsOverStore(store), analyticsOverStore(store, { ...filter }), unifiedUsage(store, filter)]);
        // Each running row's status over the store (viewOverStore), for the active/needs_input/unknown buckets.
        const vd = viewDepsFor(ownOriginOf());
        const runningStatus = new Map<string, Status>();
        await Promise.all(s.running.map(async (id) => { const v = await viewOverStore(store, id, vd); if (v?.status) runningStatus.set(id, v.status as Status); }));
        // How the runs that tried to learn fared, over the store (learning-1's learningCountsOverStore): the same figures the
        // ledger gave, run for run; no held run's learning from memory.
        const learning = await learningCountsOverStore(store, filter);
        return send(res, 200, { ...statsView(s, (id) => runningStatus.get(id)), analytics: { ...analyticsView(a, filter), usage: tokens }, learning });
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
      case "listHarnessKeys":
        return send(res, 200, harnessKeys.list());
      // Never through `idempotent`: its record keeps the body, and this body is the value. The owner's session alone (the
      // dispatch's secret-write check, harness-keys.ts registerSecretWrite), for a recipe this server names and a key it
      // runs on; the next claim of a run on that harness opens it, with no restart. Then the listings are built again, cut
      // of it, and the harness offers probed again: whether the recipe is offered turns on its keys being saved.
      case "saveHarnessKey": {
        const recipe = harnessKeys.recipe(id);
        const body = await bodyOf(req);
        if (stopping.signal.aborted) throw new ApiError("unavailable", "The server is shutting down: the key was not saved.");
        await harnessKeys.save(recipe, decodeURIComponent(second!), body);
        await harnessKeysChanged();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      }
      case "deleteHarnessKey":
        await harnessKeys.remove(harnessKeys.recipe(id), decodeURIComponent(second!));
        await harnessKeysChanged();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      // Never through `idempotent`: its record keeps the body, and the body holds the password.
      case "getEmailAccount":
      case "saveEmailAccount":
      case "deleteEmailAccount":
      case "testEmailAccount": {
        const body = found.name === "saveEmailAccount" || found.name === "testEmailAccount" ? await bodyOf(req) : undefined;
        if (found.name === "saveEmailAccount" && stopping.signal.aborted) throw new ApiError("unavailable", "The server is shutting down: the account was not saved.");
        const answer = await emailRoute({ store, sealKey }, found.name, body);
        if (found.name === "saveEmailAccount") await heldEmailPassword();
        if (answer === undefined) return void res.writeHead(204, { "cache-control": "no-store" }).end();
        return send(res, 200, answer, { "cache-control": "no-store" });
      }
      // Never through `idempotent` either: its record keeps the body, and the body holds the calendar's address. A read
      // reaches loopback only on a local install (its fakes), and a private host only where the owner allows it.
      case "getCalendar":
      case "saveCalendar":
      case "deleteCalendar":
      case "testCalendar": {
        const body = found.name === "saveCalendar" || found.name === "testCalendar" ? await bodyOf(req) : undefined;
        if (found.name === "saveCalendar" && stopping.signal.aborted) throw new ApiError("unavailable", "The server is shutting down: the calendar was not saved.");
        // The MCP servers' network and reach (mcp-oauth.ts calendarAt is mcpServerAt's rule), and their stop with the server's.
        const outbound = await mcpServers.outboundReach();
        const answer = await calendarRoute({ store, sealKey, reach: async () => outbound.reach, network: outbound.network, signal: AbortSignal.any([outbound.signal, stopping.signal]) }, found.name, body);
        if (found.name === "saveCalendar") await heldCalendar();
        if (answer === undefined) return void res.writeHead(204, { "cache-control": "no-store" }).end();
        return send(res, 200, answer, { "cache-control": "no-store" });
      }
      // The ChatGPT sign-in (chatgpt-plan.ts): a step it refuses is 400 in its words; its token is in no answer.
      case "getChatGPTSignIn":
        await planNow();
        return send(res, 200, plan.view());
      case "startChatGPTSignIn":
        return send(res, 200, await planStep(() => plan.startSignIn()));
      case "finishChatGPTSignIn": {
        const body = (await bodyOf(req)) as { redirect_url?: unknown };
        return send(res, 200, await planStep(() => plan.finishSignIn(body?.redirect_url)));
      }
      case "signOutChatGPT": {
        const { revoked } = await plan.signOut();
        return send(res, 200, revoked ? { revoked } : { revoked, message: SIGN_OUT_UNCONFIRMED });
      }
      // Claude Code's login on this machine (claude-login.ts): only its status is read, by asking the CLI.
      case "getClaudeLogin":
      case "turnOnClaudeLogin":
      case "turnOffClaudeLogin":
      case "startClaudeLogin": {
        const body = found.name === "turnOnClaudeLogin" ? await bodyOf(req) : undefined;
        const deps = loginDeps();
        try {
          const view = found.name === "getClaudeLogin" ? await claudeLoginView(deps) : found.name === "turnOnClaudeLogin" ? await turnOnClaudeLogin(deps, body) : found.name === "turnOffClaudeLogin" ? await turnOffClaudeLogin(deps) : await startLoginHere(deps);
          return send(res, 200, view, { "cache-control": "no-store" });
        } catch (error) {
          if (error instanceof ClaudeLoginRefused) throw new ApiError(error.code, error.message);
          throw error;
        }
      }
      // The model gateway saved in the console (model-gateway.ts): never through `idempotent`, as its body may hold the
      // key; a save or removal makes the reading again (gatewayChanged), so capabilities and the next run see it at once.
      case "getModelGateway":
      case "saveModelGateway":
      case "deleteModelGateway":
      case "testModelGateway": {
        // The test's body is optional (none: the gateway in force is asked); a save's is not.
        const sent = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
        const body = found.name === "saveModelGateway" || (found.name === "testModelGateway" && sent) ? await bodyOf(req) : undefined;
        if ((found.name === "saveModelGateway" || found.name === "deleteModelGateway") && stopping.signal.aborted) throw new ApiError("unavailable", "The server is shutting down: the model gateway was not changed.");
        const answer = await modelGatewayRoute({ store, sealKey: seal.key, env: own(withSecrets(base, "own")), changed: gatewayChanged }, found.name, { ...(body !== undefined ? { body } : {}), signal: stopping.signal });
        return send(res, 200, answer, { "cache-control": "no-store" });
      }
      // Never through `idempotent`: its record keeps the body, and a body may hold a credential.
      case "listMcpServers":
        return send(res, 200, await mcpServers.list());
      // Names only: what the API-only profile serves in place of the list.
      case "listMcpServerNames":
        return send(res, 200, { names: (await listMcpServers(store)).map((row) => row.name).sort() });
      case "getMcpServer":
        return send(res, 200, await mcpServers.get(id));
      case "previewMcpServer":
        return send(res, 200, await mcpServers.preview(await bodyOf(req), stopping.signal));
      case "saveMcpServer": {
        const body = await bodyOf(req);
        // A server that isn't a Composio preset's is saved at once, as ever: no save waits on another's listing.
        if (!(await mcpServers.composioPreset(id))) {
          const saved = await mcpServers.save(id, body, stopping.signal, secretSeen as McpCredentialMark | undefined, undefined, undefined, undefined, undefined, byToken);
          await refreshMcpMeta();
          return send(res, 200, saved);
        }
        // A preset server's: listed as any save is, at once; then its write and cleanup in the Composio turn and its
        // project's. A save that moves it off Composio is refused while Composio triggers use it, in the delete's words;
        // else it removes there what its save made (the MCP server, then what no other saved server uses), as a delete
        // does, with the key it was saved with, and says so.
        const over: { dropped?: ComposioDropped; note?: Awaited<ReturnType<typeof composioLeft>> } = {};
        const guard: SaveGuard = {
          turn: (work) => inComposioTurn(async () => {
            const done = await composioTriggers.inTurnOf(id, work);
            if (over.dropped) over.note = await composioLeft(id, over.dropped);
            return done;
          }),
          inUse: () => composioTriggers.inUse(id, SAVE_AFTER_TRIGGERS),
        };
        const saved = await mcpServers.save(id, body, stopping.signal, secretSeen as McpCredentialMark | undefined, undefined, undefined, (left) => (over.dropped = left), guard, byToken);
        await refreshMcpMeta();
        return send(res, 200, over.note ? { ...saved, composio: over.note } : saved);
      }
      // Composio makes the managed MCP server; what is kept is the ordinary MCP save, so the key is a sealed header.
      case "listComposioTools":
        return send(res, 200, await composioTools(await bodyOf(req), options.composioControl ?? {}, stopping.signal), { "cache-control": "no-store" });
      case "saveComposioServer": {
        // The name is checked before Composio is called: a refused name leaves nothing made there.
        mcpNameOf(id);
        const body = await bodyOf(req);
        // In the Composio turn. A save over a preset server removes there, once it is saved, the MCP server the save before
        // made and what that save made that this one no longer stands on (an account of another user, an auth config of
        // another toolkit), with the key it was made with, and says so as a delete does; what another saved server uses is
        // that one's now, and said too. A save as another user or auth config is refused while Composio triggers use the
        // server, in the delete's words, checked in its project's turn before the row is written. An API-only server's token
        // saves one that names its key by api_key_env (the secret-write gate), and over a saved server only one it saved
        // (mcp-secret-writes.ts tokenWriteOverRefused), landing only while the row still has the credential the gate read
        // (secretSeen) and the token's mark. The body names no address or headers (composioSave refuses them).
        const answer = await inComposioTurn(async () => {
          const over: { dropped?: ComposioDropped } = {};
          const guard: SaveGuard = { turn: (work) => composioTriggers.inTurnOf(id, work), inUse: () => composioTriggers.inUse(id, SAVE_AFTER_TRIGGERS) };
          const saved = await composioSave(body, options.composioControl ?? {}, (mcp, made, stands) => mcpServers.save(id, mcp, stopping.signal, secretSeen as McpCredentialMark | undefined, made, stands, (left) => (over.dropped = left), guard, byToken), id, stopping.signal, async () => (await mcpServers.get(id)).url);
          await refreshMcpMeta();
          return over.dropped ? { ...saved, composio: await composioLeft(id, over.dropped) } : saved;
        });
        return send(res, 200, answer, { "cache-control": "no-store" });
      }
      case "listComposioEvents":
        return send(res, 200, await composioTriggers.events(id), { "cache-control": "no-store" });
      case "listComposioTriggers":
        return send(res, 200, await composioTriggers.triggersOf(id), { "cache-control": "no-store" });
      case "rotateComposioSecret":
        return send(res, 200, await composioTriggers.rotate(id), { "cache-control": "no-store" });
      case "deleteComposioSubscription":
        return send(res, 200, await composioTriggers.forget(id), { "cache-control": "no-store" });
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
      case "listGitHubRepositories": {
        // The installations repaired from GitHub's own first, as getGitHubConnection does (at most once a minute): an
        // installation whose event was missed is listed, not hidden until a restart.
        await githubConnect.reconcile((detail) => triggers.turnOff("github", detail));
        const listed = await githubConnect.repositories(stopping.signal);
        if ("unusable" in listed) throw new ApiError("github_not_connected", listed.unusable);
        return send(res, 200, listed, { "cache-control": "no-store" });
      }
      case "listSuggestions":
        // The same repair first: the page's Refresh and Check again read installations as GitHub has them.
        await githubConnect.reconcile((detail) => triggers.turnOff("github", detail));
        return send(res, 200, await suggestions.list({ ...(url.searchParams.has("repo") ? { repo: url.searchParams.get("repo")! } : {}), ...(url.searchParams.has("status") ? { status: url.searchParams.get("status")! } : {}) }), { "cache-control": "no-store" });
      case "scanForSuggestions": {
        const scanned = await suggestions.scan(await bodyOf(req));
        return send(res, scanned.status, scanned.body, { location: `/v2/runs/${String(scanned.body.run_id)}` });
      }
      case "getSuggestion":
        return send(res, 200, await suggestions.get(id, stopping.signal, url.searchParams.get("name") ?? undefined), { "cache-control": "no-store" });
      case "discardSuggestion":
        return send(res, 200, await suggestions.discard(id));
      case "restoreSuggestion":
        return send(res, 200, await suggestions.restore(id));
      case "createSuggestedAgent": {
        const created = await suggestions.create(id, await bodyOf(req), stopping.signal);
        return send(res, created.status, created.body);
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
      case "deleteMcpServer": {
        // Our row goes first, by the checked removal (a 412 sends Composio nothing), and answers what it removed: a Composio
        // preset server's MCP server on Composio is deleted next, as the row removed named it and with its saved key, then
        // what its save made for it there that no other saved server uses (its connect link's account, its auth config).
        // Composio refusing or not answering, or a key that does not open, never keeps our row. A preset's answer says in
        // words what went there, what stays and why, and what to remove by hand. One that Composio triggers still use is kept: refused, naming them, checked and deleted in
        // its Composio project's turn, so a trigger still being made on it is counted (composio-triggers.ts deleting). All of
        // it in the Composio turn, so a Composio save still at work finishes first and its record is counted.
        const forgotten = await inComposioTurn(async () => {
          const { composio: made } = await composioTriggers.deleting(id, () => mcpServers.remove(id, secretSeen as McpCredentialMark | undefined, byToken));
          await refreshMcpMeta();
          return !made ? undefined : "unusable" in made ? composioNote(id, made.cleanup) : await composioForget(options.composioControl ?? {}, made.key, made.id, id, stopping.signal, made.cleanup);
        });
        if (forgotten) return send(res, 200, { deleted: true, composio: forgotten }, { "cache-control": "no-store" });
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      }
      case "getToolSettings":
        return send(res, 200, withDefaults(settings.get()));
      case "putToolSettings": {
        // Replaces the settings: a capability the body leaves out takes its default. Runs launched from now on resolve
        // on them, and capabilities say so at once.
        const body = await bodyOf(req);
        const issues = settingsIssues(body);
        if (issues.length) throw invalid(issues);
        const before = settings.get();
        await settings.put(body as ToolSettingsMap);
        // A setting changes what the web tools resolve to, never env or what a harness offers: capabilities again.
        recompose();
        // A run parked on a call whose tool reads allow now, on its pinned revision: woken, so its next claim's gate answers
        // the ask by the setting (settings-wake.ts), before this answer. The settings as the runner's gate reads them.
        const woken = await wakeAnsweredBySetting(store, await loadToolSettings(store), before);
        if (woken.length) log?.(logLine("tool_settings", { condition: "runs_woken", runs: woken.join(",") }));
        return send(res, 200, withDefaults(settings.get()));
      }
      // A person's view and control of what an agent learned (learning-routes.ts). Every text cut of the host's secrets as
      // they are now and of the agent's own sign-in pointers, live and forgotten (agentPointers); a write as the
      // definition's: an archived agent's too.
      case "getAgentLearning": {
        const entry = await needAgent(id);
        // The agent's learning view: its corrections, workflows and log from its learning folder; its run-fared counts and
        // its impact over the one store (agentLearningOverStore), from each run's launch, journal and learning end.
        const { counts, impact } = await agentLearningOverStore(store, id);
        // Each workflow's status past its README.md's: where it stands as GET .../learning/promotions says it (servingStateOf
        // over the same records and the money rule's decision, costStopOverStore), so the view never says a workflow serves
        // that does not run first.
        const records = await promotionsOf(store.settings, id);
        const refused = await refusedFor(id, records);
        const costStop = await costStopOverStore(store, id);
        const body = entry.revision?.body as AgenticBody | undefined;
        const modelEnv = !body || sdkOf(body) || nativeOf(body) ? env : envAtPlace(env, resolvePlace(body.place as Place | undefined, fallbackPlace(entry.revision!.kind === "workflow" ? "workflow" : "agentic", body.tools ?? [])));
        return send(res, 200, { ...await agentLearning(data, id, await learningShown(id), counts, impact, (workflow) => servingStateOf(records, workflow, costStop, refused), store), learning_model: await learningModelOf(modelEnv, entry.revision) });
      }
      case "getLearningCost": {
        await needAgent(id);
        // The agent's cost per run over the one store (agentCostOverStore): each ended run's figures and path, aggregates only.
        const { limit, csv } = learningCostQuery(url);
        const read = await agentCostOverStore(store, id, limit, refusedFor);
        // Each workflow's name as the other learning reads show it: one that holds a secret or a sign-in's value is cut.
        const shown = await learningShown(id);
        const cost = { ...read, runs: read.runs.map((run) => (run.workflow === null ? run : { ...run, workflow: shown.name(run.workflow) })), workflows: read.workflows.map((one) => ({ ...one, workflow: shown.name(one.workflow) })), bill: { ...read.bill, revisions: read.bill.revisions.map((one) => ({ ...one, workflow: shown.name(one.workflow) })), holds: read.bill.holds.map((one) => ({ ...one, workflow: shown.name(one.workflow), reason: shown.text(one.reason) })) } };
        if (csv) {
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="${id}-cost-per-run.csv"` });
          return void res.end(costCsv(cost.runs));
        }
        return send(res, 200, { agent: id, ...cost });
      }
      case "listLearningPromotions": {
        const entry = await needAgent(id);
        // Each learned workflow's promotion records, oldest first (learn/promote.ts): its check's numbers and decisions,
        // its holds (a check's, an audit's). Every text in them cut as the other learning reads cut theirs
        // (promotionsShown: a reason as well as each workflow's name). Beside what serves, each one's state, its check's
        // numbers and its audit line (learn/audit.ts servingLinesOf), at the agent's numbers.
        const records = await promotionsOf(store.settings, id);
        // Every champion below skips a record the purge gate refuses at its commit, as a run's claim does (championOf).
        const refused = await refusedFor(id, records);
        const shown = await learningShown(id);
        const shownRead = promotionsShown(records, shown, refused);
        // A ledger that can't be read now leaves each audit line at no rows, never the read refused.
        const loop = auditLoopOf((entry.revision?.body as { learning?: unknown } | undefined)?.learning);
        // Each one's state with the money rule's decision a run's launch reads (costStopOverStore): a champion it stopped
        // running first reads `stopped`.
        const lines = servingLinesOf(records, await auditsOfAgent(id).catch(() => []), loop, await costStopOverStore(store, id), refused);
        // Why its runs are never audited, when the agent can call a tool that writes (learn/audit.ts auditWriterOf, the
        // rule startAudit reads); and how many of the serving revision's runs a trigger started (never audited).
        const writer = auditWriterOf(entry.revision ?? undefined);
        const auditsOff = writer === undefined ? null : shown.text(auditsOffWords(writer));
        // The champion's own revision, read by its recorded digest at the learning commits its records name (newest
        // first), then main: never by paging the workflow's history. Its nodes with their tiers and code checks, and the
        // check it was promoted on; nodes null when no commit read holds its text (or the folder can't be read now).
        const championRead = async (workflow: string, digest: string) => {
          const champion = championOf(records, workflow, refused);
          const record = champion?.digest === digest ? champion : undefined;
          const commits = records.filter((one) => one.workflow === workflow && one.digest === digest && one.commit).map((one) => one.commit!).reverse();
          const read = await workflowAtDigest(data, id, workflow, digest, commits, store).catch(() => undefined);
          let doc: unknown;
          try {
            doc = read ? JSON.parse(read.text) : undefined;
          } catch {
            doc = undefined;
          }
          return shownDeep({ digest, commit: read?.commit ?? null, nodes: doc === undefined ? null : workflowNodesOf(doc), check: record?.check ?? null }, shown);
        };
        const serving = await Promise.all(servingOf(records, refused).map(async (one, i) => ({
          ...shownRead.serving[i]!, ...lines[i]!, audits_off: auditsOff,
          not_auditable: one.digest === null ? 0 : await notAuditableOf(store, id, one.workflow, one.digest, loop).catch(() => 0),
          champion: one.digest === null ? null : await championRead(one.workflow, one.digest),
        })));
        return send(res, 200, { agent: id, promotions: shownRead.promotions, serving });
      }
      case "listLearningAudits": {
        await needAgent(id);
        // The audit ledger (learn/audit.ts audits.jsonl), oldest first: each workflow's name and every other text cut as the
        // promotions read cuts its own.
        const shown = await learningShown(id);
        const rows = await auditsOfAgent(id);
        return send(res, 200, { agent: id, audits: rows.map((row) => ({ ...row, workflow: shown.name(row.workflow), run: shown.text(row.run), shadow_run: row.shadow_run === null ? null : shown.text(row.shadow_run), digest: shown.text(row.digest) })) });
      }
      case "getLearningLoop": {
        await needAgent(id);
        // The loop's own record over the one store (store-reads/loop.ts): compile turns, aggregates only.
        // Names cut as the other learning reads cut them; a compile's error texts cut by its run's own cut as its run's
        // learning read cuts them (run-learning-served.ts), and left out when that run's handed values can't be read.
        const shown = await learningShown(id);
        const values = await learningValues(id);
        const read = await agentLoopOverStore(store, id);
        const compiles = await Promise.all(read.compiles.map(async (one) => {
          const cut = await runCutValues({ serverSecrets, signIns }, store, one.run_id).catch(() => "unreadable" as const);
          const workflow = one.workflow === null ? null : shown.name(one.workflow);
          if (cut === "unreadable") return { ...one, workflow, attempts: one.attempts.map(({ ok }) => ({ ok, errors: [] })), draft_errors: [], withheld: true };
          const all = [...values, ...cut.values];
          const said = (error: string) => shown.text(printable({ rule: "workflow", detail: error }, all).detail);
          return { ...one, workflow, attempts: one.attempts.map(({ ok, errors }) => ({ ok, errors: errors.map(said) })), draft_errors: one.draft_errors.map(said), withheld: false };
        }));
        return send(res, 200, { agent: id, completed_runs: read.completed_runs, compiles });
      }
      case "listLearningLog":
        await needAgent(id);
        return send(res, 200, await learningLog(data, id, url.searchParams, await learningShown(id), store));
      case "getLearningCorrections": {
        await needAgent(id);
        // corrections.md whole, as every run of the agent is served it under # Learned, with its ETag in the body and the header.
        const read = await correctionsView(data, id, await learningShown(id));
        return send(res, 200, read, { etag: read.etag });
      }
      case "putLearningCorrections": {
        await needAgent(id);
        const text = await textBody(req, MAX_BODY);
        // What it refuses is what the reads cut: the host's secrets and the agent's sign-in pointers.
        const refuse = await learningValues(id);
        // A write to the agent's learning: in its delete turn (agentWrite), the body read before, outside it.
        const written = await agentWrite(id, () => correctionsWrite(data, id, { text, ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined, refuse }));
        return send(res, 200, written, { etag: written.etag });
      }
      case "deleteAgentLearning": {
        // The agent's learning reset (learning-reset.ts), a write to its learning: in its delete turn (agentWrite), which
        // reads the agent there (404 unknown) and refuses one being deleted.
        await agentWrite(id, () => resetLearning(learningResetHost, id));
        // A run's list row that read a workflow of the agent's says what the folder says now, at the next list.
        await lister.learningChanged(id);
        res.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void res.end();
      }
      case "listLearnedWorkflowRevisions":
        await needAgent(id);
        return send(res, 200, await workflowRevisions(data, id, second!, url.searchParams, await learningShown(id), store));
      case "readLearningFile":
        await needAgent(id);
        return sendText(res, 200, await readLearnedFile(data, id, second!, await learningShown(id), store));
      case "retireLearningFile":
      case "approveLearningFile":
      case "restoreLearningFile": {
        await needAgent(id);
        const refuse = await learningValues(id);
        const action = found.name === "approveLearningFile" ? "approve" : found.name === "restoreLearningFile" ? "restore" : "retire";
        // A change to a workflow is a write to the agent's learning: in its delete turn (agentWrite).
        const written = await agentWrite(id, () => changeWorkflow(data, id, second!, { action, ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined, refuse, draftTools: () => learnedDraftToolsOf(id), store }));
        // A run's list row that read a workflow held for the owner's OK says what the folder says now, at the next list.
        await lister.learningChanged(id);
        return sendText(res, written.status, { ...written, text: secretsShown(refuse).text(written.text) });
      }
      case "startLearnedWorkflowReplay": {
        const body = await bodyOf(req);
        // An archived agent starts no run: refused before the replay is reserved, as a person's start is.
        const entry = await needRunnableAgent(id);
        const extra = unknownFields(body, ["inputs"]);
        if (extra.length) throw invalid(extra);
        const inputs = body.inputs === undefined ? "held" : body.inputs;
        if (inputs !== "held" && !(typeof inputs === "number" && Number.isInteger(inputs) && inputs >= 1 && inputs <= COMPILE_AFTER_MAX)) {
          throw new ApiError("bad_request", `inputs is "held" (the runs the revision was last checked on, the default) or a whole number from 1 to ${COMPILE_AFTER_MAX}: that many of the agent's newest completed runs.`);
        }
        const [, , name, digest] = found.pattern.exec(path)!.map((part) => decodeURIComponent(part));
        // Its replay runs are started by no caller, with no model key: none to spend on a server that holds none.
        const keyless = noServerKeyFor(env, "An owner's replay");
        if (keyless) throw new ApiError("not_continuable", keyless);
        // Reserved in the agent's promotions record, in its delete turn (agentWrite), as every write to its learning is.
        const started = await agentWrite(id, () => replayAsked(() => askReplay(replayAskOf(entry), name!, digest!, inputs as "held" | number)));
        return send(res, 202, started, { location: `/v2/agents/${encodeURIComponent(id)}/learning/workflows/${encodeURIComponent(name!)}/revisions/${encodeURIComponent(digest!)}/replays/${started.replay}` });
      }
      case "getLearnedWorkflowReplay": {
        const entry = await needAgent(id);
        const [, , name, digest, replayId] = found.pattern.exec(path)!.map((part) => decodeURIComponent(part));
        const view = await replayAsked(() => replayView(replayAskOf(entry), name!, digest!, replayId!));
        // Its words cut as the promotions list cuts a record's (promotionsShown).
        const shown = await learningShown(id);
        return send(res, 200, { ...view, workflow: shown.name(view.workflow), ...(view.reason !== undefined ? { reason: shown.text(view.reason) } : {}) });
      }
      case "getRunLearning": {
        const run = await needRun(id);
        // The run's learning view over the store (learning-1's runLearningOverStore): its end, the notes it was given and its seed
        // from its launch, what it holds for the owner's OK as the store's run view reads it (on its folder's main), as main.
        // Cut by the run's one cut, and refused for a withheld run (run-learning-served.ts).
        return send(res, 200, await servedRunLearning({ serverSecrets, signIns, statuses }, store, run.id));
      }
      case "getRunLearningDiff": {
        const run = await needRun(id);
        // The run's learning diff over the store (learning-routes.ts runDiffOverStore): its merge from its agent's learning
        // folder, else its kept proposal's notes against its seed, else no file against the seed its launch names. Cut by the
        // run's one cut, and refused for a withheld run, as its learning is (run-learning-served.ts).
        return send(res, 200, await servedRunDiff({ serverSecrets, signIns }, store, data, run.id));
      }
      case "getWebhook":
        return send(res, 200, webhooks.view());
      case "saveWebhook": {
        // Never through `idempotent`: its record would keep the answer, and the first one holds the secret.
        // Its minted secret to the owner's session alone (trigger-secrets-shown.ts); the token gets its metadata and the words.
        const saved = await webhooks.save(await bodyOf(req));
        return send(res, saved.created ? 201 : 200, webhookSaved(saved.view, saved.secret, mayHoldSecrets(req)));
      }
      case "rotateWebhookSecret": {
        // A secret write: the dispatch's one check let only the owner's session this far (trigger-secrets-shown.ts). Never
        // through `idempotent`, whose record would keep the secret. It takes no body, as a trigger's rotation takes none.
        if (req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) !== 0) {
          throw invalid([{ field: "body", reason: "not_allowed", message: "Rotating the webhook's secret takes no body: send none, and the new secret is made here." }]);
        }
        const rotated = await webhooks.rotate();
        return send(res, 200, webhookRotated(rotated.view, rotated.secret), { "cache-control": "no-store" });
      }
      case "deleteWebhook":
        await webhooks.remove();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "testWebhook":
        return send(res, 200, await webhooks.test());
      case "listWebhookDeliveries":
        return send(res, 200, await webhooks.attemptsView());
      case "redeliverWebhook":
        return send(res, 200, await webhooks.redeliver(id));
      case "getSlack":
        return send(res, 200, slack.slackView());
      case "saveSlack": {
        // A body with `url` is a secret write: the dispatch's one check let only the owner's session this far
        // (slack.ts registers it). The URL is never in the answer.
        const saved = await slack.saveSlack(await bodyOf(req));
        return send(res, saved.created ? 201 : 200, saved.view);
      }
      case "deleteSlack":
        await slack.remove();
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "testSlack":
        return send(res, 200, await slack.test());
      case "listSlackDeliveries":
        return send(res, 200, await slack.attemptsView());
      case "redeliverSlack":
        return send(res, 200, await slack.redeliver(id));
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
          // A secret the sender gave is not shown: the trigger answers its metadata, as a read does.
          return { status: 201, body: shown ? { ...made, note: `Its secret was shown once, in the first answer; POST /v2/triggers/${made.id}/secret makes a new one.` } : withSecretOf(made), headers: { location: `/v2/triggers/${made.id}` } };
        });
        const replayed = answer.headers?.["idempotent-replayed"] === "true";
        const { note: _, ...first } = answer.body as Json;
        // Its minted secret to the owner's session alone (trigger-secrets-shown.ts); the token gets secret_set and the words.
        return send(res, answer.status, secret && !replayed ? triggerMade(first, secret, mayHoldSecrets(req), new Date().toISOString()) : answer.body, answer.headers);
      }
      case "listTemplates": {
        // Each package's computer list read against this server now: what an apply here would pick (pickComputer).
        const listed = registry.list();
        const pickView = await computerHere(listed);
        return send(res, 200, { templates: listed.map((pkg) => ({ ...packageView(pkg), computer_here: pickView(pkg) })) });
      }
      case "importTemplate": {
        // Read from GitHub, or uploaded whole ({files}), and checked; a dry run answers it (200), else it is stored and
        // served (201). The answer shows the package whole, its instructions and every skill file, for a person to read
        // before they apply it. An upload's body carries the package's bytes (base64 among them), up to the import's own
        // limit (TEMPLATE_UPLOAD_BODY).
        const body = await bodyOf(req, TEMPLATE_UPLOAD_BODY);
        const done = new AbortController();
        res.once("close", () => done.abort());
        const imported = await importTemplate(importDeps, body, done.signal);
        const uploaded = imported.pkg.id.startsWith(UPLOAD_PREFIX);
        return send(res, imported.status, { ...packageDetail(imported.pkg, await computerHere([imported.pkg])), publisher_trusted: imported.trusted, stored: imported.status === 201, replaced: imported.replaced, console_url: imported.status === 201 ? templateLink(linkOrigin(req), imported.pkg.id) : uploaded ? templatesLink(linkOrigin(req)) : templateInstallLink(linkOrigin(req), imported.pkg.origin?.source ?? imported.pkg.id) });
      }
      case "getTemplate": {
        // One package whole, a bundled one's too: as the list shows it, with the files an import's answer shows, for a
        // person (or a coding agent) to read before they apply it.
        const pkg = registry.get(id);
        if (!pkg) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
        return send(res, 200, { ...packageDetail(pkg, await computerHere([pkg])), console_url: templateLink(linkOrigin(req), pkg.id) });
      }
      case "deleteTemplate":
        await deleteTemplate(importDeps, id);
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      case "applyTemplate": {
        const pkg = registry.get(id);
        if (!pkg) throw new ApiError("not_found", `no template ${id}: GET /v2/templates lists them`);
        const body = await bodyOf(req);
        // A dry run writes nothing, so it keeps no Idempotency-Key record either: a retry reads the plan again.
        if (body.dry_run === true) return send(res, 200, await planTemplate(pkg, body));
        // The Idempotency-Key's record keeps the agent and triggers, so a retry under the key gets the same apply; it never
        // keeps a webhook trigger's secret (below).
        let minted = new Map<string, string>();
        const answer = await idempotent(req, `/templates/${encodeURIComponent(pkg.id)}/apply`, body, async () => {
          const made = await applyTemplate(pkg, body);
          minted = made.minted;
          // 200 for an update of the agent agent_id named, 201 for an agent made.
          return { status: made.updated ? 200 : 201, body: made.applied, headers: { location: `/v2/agents/${made.applied.agent_id}` } };
        });
        // Each webhook trigger's secret, to the owner's session in this first answer alone (trigger-secrets-shown.ts
        // templateApplied): the record above never held it, so a replay under the key shows none.
        const replayed = answer.headers?.["idempotent-replayed"] === "true";
        const shown = replayed ? "replay" : mayHoldSecrets(req) ? "first" : "token";
        return send(res, answer.status, answer.status === 201 || answer.status === 200 ? templateApplied(answer.body as Json, minted, shown) : answer.body, answer.headers);
      }
      case "rotateTriggerSecret":
        // A secret write: the dispatch's one check let only the owner's session this far (trigger-secrets-shown.ts).
        // It takes no body: the new secret is made here, never given. Any body is refused before it rotates, `{}` too: a
        // length other than 0, or one sent chunked, is a body whatever it holds.
        if (req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) !== 0) {
          throw invalid([{ field: "body", reason: "not_allowed", message: "Rotating a trigger's secret takes no body: send none, and the new secret is made here." }]);
        }
        return send(res, 200, triggerRotated(id, (await triggers.rotate(id)).secret, new Date().toISOString()));
      case "getTrigger":
        return send(res, 200, withSecretOf(await triggers.get(id)));
      case "updateTrigger":
        // Its secret's metadata as a read answers it, so a page showing the changed trigger keeps saying it is set.
        return send(res, 200, withSecretOf(await triggers.update(id, await bodyOf(req))));
      case "deleteTrigger": {
        // Deleted here whatever its sender says; what could not be removed there is answered (Composio's instance).
        const said = await triggers.remove(id);
        // Its cached create answers are masked now and saved, so no later start has to find the trigger to mask them. A
        // failed save is said by a code; the map is masked already, so a replay is too.
        if (maskCachedGone(id).length) await keep().catch((error: NodeJS.ErrnoException) => idempotencySaid({ condition: "idempotency_not_saved", trigger: id, error: typeof error?.code === "string" ? error.code : "error" }));
        if (said) return send(res, 200, { deleted: true, ...(said as Record<string, unknown>) });
        return void res.writeHead(204, { "cache-control": "no-store" }).end();
      }
      case "fireTrigger": {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new ApiError("bad_request", "Running a trigger now takes an Idempotency-Key of 1 to 255 characters: a retry with the same key fires it once.");
        const fired = await triggers.fire(id, key);
        return send(res, fired.created ? 202 : 200, fired.firing, fired.created ? {} : { "idempotent-replayed": "true" });
      }
      case "listTriggerFirings":
        return send(res, 200, await triggers.firings(id));
      case "releaseTriggerFiring":
        // The launch hook's host took the firing and will start no run for it: failed now, its trigger's room free. Its
        // words are kept and sent on (trigger.failed) as any stored string is, cut of every secret the server holds.
        return send(res, 200, await triggers.release(id, decodeURIComponent(second!), await bodyOf(req), (text) => redacted(text, serverSecrets(), RELEASE_WORDS_MAX)));
    }
    throw new ApiError("not_found", `no route ${path}`);
  }

  // The MCP endpoint's tools are the routes above, called in process with the caller's token (mcp.ts).
  const mcp = mcpEndpoint({ route, authorized: (header, req) => bearer(header, req), authFailed, version: VERSION });

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(text);
  }

  /**
   * Whether an API-only server lets this request into run `runId`'s live view, its page and files or (socket) its
   * WebSocket: from the public address alone (a page navigation may send no Origin; a socket always sends one), with the
   * viewer credential its backend minted for this run (viewer-credential.ts), not expired, its run not ended (read from
   * the store each time: its revocation). The credential, or the refusal and its authFailed reason.
   */
  async function liveAdmits(req: IncomingMessage, runId: string, { socket }: { socket: boolean }): Promise<{ credential: string } | { reason: string; error: ApiError }> {
    const sent = req.headers.origin?.toLowerCase();
    if (sent === undefined ? socket : sent !== publicOrigin) {
      return { reason: "live_view_origin", error: new ApiError("forbidden", "a run's live view here is opened on this server's public address (AGENTRUN_PUBLIC_URL) alone") };
    }
    const credential = viewerCredentialOf(req);
    if (credential === undefined) return { reason: "no_credential", error: new ApiError("unauthenticated", "a run's live view here takes the viewer link its backend minted (POST /v2/runs/{run_id}/computer/viewer)") };
    if (!viewerCredentialFor(viewerKey, runId, credential, Date.now()) || (await runOver(store, runId))) {
      return { reason: "viewer_credential", error: new ApiError("forbidden", "this viewer link is expired, for another run, or its run has ended: ask for a new one") };
    }
    return { credential };
  }

  /** A run's live viewer's page and files (browser-live.ts, /v2/runs/{id}/computer/live/*): the owner's signed-in page
   *  alone, GET or HEAD, for a viewer the run's live process has handed over. The bytes are this server's own copy of pi-browser's viewer, never the run's port's:
   *  only the viewer's WebSocket reaches the run. */
  async function liveRoute(req: IncomingMessage, res: ServerResponse, runId: string, family: LiveFamily, rest: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError("method_not_allowed", `${req.method} is not a method of a run's live view`, {}, { allow: "GET, HEAD" });
    if (options.apiOnly) {
      // API-only: no owner here (liveAdmits). The page's answer sets the credential as the cookie its files and socket carry.
      const admitted = await liveAdmits(req, runId, { socket: false });
      if ("error" in admitted) {
        authFailed(`/v2/runs/${runId}/${family}/live`, admitted.reason);
        throw admitted.error;
      }
      const handover = await liveViewerFor(store, sealKey, runId, rest);
      if (handover === undefined) throw new ApiError("not_found", `this run's ${family} has no live view at that address`);
      res.setHeader("set-cookie", viewerCookie(req, runId, admitted.credential));
      return serveViewerFile(req, res, rest, (handover.kind ?? "browser") === "browser" ? "browser" : "computer");
    }
    if (!byOwnerSession(req)) {
      authFailed(`/v2/runs/${runId}/${family}/live`, req.headers.authorization === undefined ? "no_credential" : `${family}_without_session`);
      throw req.headers.authorization === undefined ? new ApiError("unauthenticated", `a run's live ${family} view takes the owner's password sign-in in the console`) : new ApiError("forbidden", `a run's live ${family} view takes the owner's password sign-in in the console, never a token`);
    }
    await needRun(runId);
    // The run's live viewer from the store (the runner's browser/computer tool wrote it under its claim; liveViewerFor picks
    // a named viewer's handover or the run's open one). None for a run no runner holds. A /computer/live path reaches a viewer of every kind (the link GET /computer gives, a browser's among
    // them), a /browser/live path a browser's alone (familyReaches).
    const handover = await liveViewerFor(store, sealKey, runId, rest);
    if (handover === undefined || !familyReaches(family, handover)) throw new ApiError("not_found", `this run's ${family} has no live view at that address`);
    // A desktop's or a phone's viewer gets the computer viewer's page (computer-viewer.ts), a browser's pi-browser's.
    await serveViewerFile(req, res, rest, (handover.kind ?? "browser") === "browser" ? "browser" : "computer");
  }

  /** The origin of the address people open (`publicUrl`, AGENTRUN_PUBLIC_URL), lowercased; none, undefined. */
  const publicOrigin = (() => {
    try {
      return options.publicUrl ? new URL(options.publicUrl).origin.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  })();

  // The public address this server last served at, kept in its data folder (public-address.ts): a change signs the owner
  // out and leaves earlier webhook messages' links on the old address, so the start says so, in one line, once it serves
  // (below), when it also remembers the new address: a start that fails changes neither.
  const address = readPublicAddress(data, options.publicUrl);
  // The earlier address's name (`moved.from`), whose console a browser is redirected from to the new address (`moved.to`,
  // parsed: a Location header carries no raw name in another script): set only when the server has a public address now
  // and the earlier name is none it answers to.
  const moved = movedAddress(address.earlier, options.publicUrl, loopbackNames(host, options.allowHosts, options.publicUrl));

  let names: Set<string> | undefined;
  // The listener: the CLI's, bound early and answering warming until the takeover below (listen-first.ts), or a new one.
  const server = options.listener ?? createServer();
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    res.setHeader("x-request-id", requestId);
    if (log && !quiet) {
      const started = performance.now();
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0]!;
      // Who the request was answered for: the owner's or the console's session, or the id of the API token it carried
      // (api-token.ts), never a secret. A request opened by neither has no such field.
      res.once("finish", () => {
        const by: Record<string, string> = byOwnerSession(req) ? { session: "owner" } : byConsoleSession(req) ? { session: "console" } : tokenUsed.has(req) ? { token: tokenUsed.get(req)! } : {};
        log(logLine("request", { method, path, status: res.statusCode, ms: Math.round(performance.now() - started), ...by }));
      });
    }
    const fail = (error: unknown) => {
      if (res.headersSent) return void res.end();
      // A request cut before its body was read (push-handler.ts readCapped): its socket goes once the answer is out.
      if (error instanceof HookCut) res.once("finish", () => req.socket.destroy());
      // A store still busy past a request's wait, or a write still open at its deadline, is home_busy, whichever read or
      // write met it: the request may be sent again, never a 500 (agents.ts answerOf, as an MCP tool's call answers).
      const known = answerOf(error);
      if (logged(error)) process.stderr.write(`agentrun-serve: ${(error as Error)?.stack ?? String(error)}\n`);
      send(res, known.status, known.body(requestId), known.headers);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://serve");
    } catch {
      return fail(new ApiError("bad_request", "the request target is not a URL"));
    }
    // Under the server's earlier public address (public-address.ts): a browser that opens the console is sent on to the new
    // address, whatever the listener. No other route is: on loopback, the rest is refused as any other name is, in words
    // that name the new address. That name passes the Host check for this one fixed answer alone, which reads nothing of
    // the request but its path: it is a name this server's operator set before, and a page that rebound it reads no data.
    if (moved !== undefined && hostName(req.headers.host) === moved.from) {
      const browser = /\btext\/html\b/i.test(String(req.headers.accept ?? ""));
      if (browser && (req.method === "GET" || req.method === "HEAD") && consoleEntry((req.url ?? "/").split("?")[0]!)) return sendMoved(res, moved.to);
      if (names) return browser ? sendMovedPage(req, res, moved.to) : fail(new ApiError("forbidden", `unexpected Host header: ${movedFix(moved.to)}`));
    }
    // On loopback, a Host that is not one of its names (host-check.ts) is a page that rebound a name of its own to this
    // address. A browser is shown a page that says which names work; a script, the same in the error.
    if (names && !names.has(hostName(req.headers.host) ?? "")) {
      if (/\btext\/html\b/i.test(String(req.headers.accept ?? ""))) return sendHostRefused(req, res);
      return fail(new ApiError("forbidden", `unexpected Host header: ${hostFix(req.socket.localPort ?? 0)}`));
    }
    // Routed on the path as sent: a parsed URL folds `..` and `%2E%2E` segments away, and a file path must see them.
    const raw = (req.url ?? "/").split("?")[0]!;
    // API-only (api-only.ts): any address but the run routes is refused here, before the page, the owner's routes, the
    // MCP endpoint, the token-less hooks or the token check read anything of the request.
    if (options.apiOnly && !servedApiOnly(ROUTES, req.method, raw)) return fail(new ApiError("not_found", apiOnlyRefusal(raw)));
    // Before the page: its cookie must not stand in for the token on the owner's own routes, nor on the MCP endpoint.
    if (owner && (raw === "/v2/setup" || raw === "/v2/setup/import" || raw === "/v2/setup/code" || raw.startsWith("/v2/auth/"))) return void ownerRoute(req, res, raw.slice(3), owner).catch(fail);
    if (raw === MCP_PATH) return void mcp(req, res).catch(fail);
    if (raw === "/llms.txt") return void answerLlms(req, res).catch(fail);
    if (raw === "/skills/agentrun-serve/SKILL.md") return void answerSkill(req, res).catch(fail);
    if (answerPage(req, res, raw, { token, authFailed, console: options.console, takesBytes, ...(owner ? { owner } : {}), ...(consoleSessions ? { sessions: consoleSessions } : {}), ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}) })) return;
    if (isObservationRoute(raw)) return void observationHttp(req, res, url, new Observations(store, Date.now, new ObservationLearning(store, new CliLearningConnections(store, sdkSecret), learning !== "off")), (header) => bearer(header, req)).catch(fail);
    if (!raw.startsWith("/v2/")) return fail(new ApiError("not_found", `no route ${raw}; the API is under /v2`));
    // A run's id needs no decoding: one that is not an id as sent (a stray or malformed escape) is no run's, and is never
    // decoded here, where a throw would leave the request listener.
    const viewing = LIVE_PATH.exec(raw);
    if (viewing) return ID.test(viewing[1]!) ? void liveRoute(req, res, viewing[1]!, viewing[2] as LiveFamily, viewing[3]!).catch(fail) : fail(new ApiError("not_found", "no run's live view at that address"));
    route(req, res, url, raw.slice(3)).catch(fail);
  };
  // A request's headers come within 10 s, whatever its route: nothing sends more than a few kilobytes of them. Its body
  // keeps Node's 5-minute request timeout, which an upload of a large file needs; the token-less hook route has its own
  // 30 s for its body (push-handler.ts HOOK_BODY_MS), so dribbling senders hold no socket for long.
  server.headersTimeout = 10_000;
  // The one upgrade this server takes: a run's live computer viewer's WebSocket (browser-live.ts). Every other is refused.
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const raw = (req.url ?? "/").split("?")[0]!;
    const viewing = LIVE_PATH.exec(raw);
    const deny = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // On loopback, the Host check every route gets (host-check.ts), first: a page that rebound a name of its own to this
    // address sends its own name as Origin too, which the Origin check below would take, so its Host is what gives it
    // away. Its name alone, on any port, as the HTTP routes check it.
    if (names && !names.has(hostName(req.headers.host) ?? "")) return deny("403 Forbidden");
    // API-only: paired computers are the console's (Settings), and refused with it, whose tokens the attach socket takes as
    // unknown there (machinesOnly). A run's hosted machine that dials still reaches it, and a run's computer live view takes
    // its viewer credential (below); a browser's live view stays the console's.
    if (options.apiOnly && raw !== ATTACH_PATH && viewing?.[2] !== "computer") return deny("404 Not Found");
    // A paired computer's driver or a hosted machine dialing the attach socket (computer-attach.ts): its token, not the
    // owner's, lets it in.
    if (raw === ATTACH_PATH) {
      return attach.upgrade(req, socket, head, (status, words = "", headers = {}) => {
        if (status.startsWith("401")) authFailed(raw, "attach_token");
        const lines = Object.entries({ ...headers, "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(words)) }).map(([name, value]) => `${name}: ${value}\r\n`).join("");
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${lines}\r\n${words}`);
      });
    }
    if (!viewing || !ID.test(viewing[1]!) || !/^\/v\/[A-Za-z0-9_-]{22}\/ws$/.test(viewing[3]!)) return deny("404 Not Found");
    // A browser always sends its page's origin on a WebSocket, which no other page's script can forge: this server's own
    // (as this request reaches it, or its public address, which a TLS proxy that rewrites Host or drops
    // X-Forwarded-Proto leaves as the only one the owner's page has), and the owner signed in, or nothing. API-only:
    // liveAdmits, below.
    if (!options.apiOnly) {
      const sent = String(req.headers.origin ?? "").toLowerCase();
      if (sent === "" || (sent !== ownOrigin(req) && sent !== publicOrigin)) return (authFailed(raw, "live_view_origin"), deny("403 Forbidden"));
      if (!owner || !signedIn(req, owner)) return (authFailed(raw, "live_view_without_session"), deny("401 Unauthorized"));
    }
    // Once the run's WebSocket is piped to this socket, a failure here only ends it: an HTTP line would land mid-stream.
    let piping = false;
    void (async () => {
      if (options.apiOnly) {
        const admitted = await liveAdmits(req, viewing[1]!, { socket: true });
        if ("error" in admitted) return (authFailed(raw, admitted.reason), deny(admitted.error.code === "unauthenticated" ? "401 Unauthorized" : "403 Forbidden"));
      }
      const run = ID.test(viewing[1]!) ? await momentOverStore(store, viewing[1]!, viewDepsFor(ownOriginOf())) : undefined;
      // The run's live viewer from the store (the runner's browser/computer tool wrote it under its claim): none for a run no
      // runner holds. A /computer/live socket reaches a viewer of every kind, a
      // /browser/live socket a browser's alone (familyReaches), as the page does.
      const viewerHandover = run ? await liveViewerById(store, sealKey, run.id, viewing[3]!.slice(3, -3)) : undefined;
      const handover = viewerHandover !== undefined && familyReaches(viewing[2] as LiveFamily, viewerHandover) ? viewerHandover : undefined;
      if (!handover) return deny("404 Not Found");
      // Gone during the lookup, or the server is closing and has ended its viewers, or is about to.
      if (socket.destroyed || closing) return void socket.destroy();
      // Checked again after the lookup, then for as long as the socket is open: the sessions that let it in, and no other.
      // API-only: the credential's run not ended, read from the store (its revocation); its expiry bounds the opening alone.
      if (options.apiOnly) viewers.watch(socket, async () => !(await runOver(store, run!.id)));
      else {
        const held = heldSessions(req);
        const admitted = () => held.some((value) => owner!.valid(value));
        if (!admitted()) return deny("401 Unauthorized");
        viewers.watch(socket, admitted);
      }
      proxyLiveUpgrade(req, socket, head, handover, viewing[3]!, () => { piping = true; }, reachForRun(reach, run!.id));
    })().catch(() => (piping ? void socket.destroy() : deny("500 Internal Server Error")));
  };
  // The CLI's early listener answers with this server's routes from here on, where a new one would start to listen.
  if (options.listener) takeOver(server, onRequest, onUpgrade);
  else {
    server.on("request", onRequest);
    server.on("upgrade", onUpgrade);
    await listenOn(server, host, options.port ?? DEFAULT_PORT, options.nextFreePort === true);
  }
  // The tool keys the server is started with, each checked once against its provider, in the background, once it
  // listens: a start that fails sends no check, and the start never waits on one. Capabilities are made again as each
  // answers (a refused one leaves its tools unavailable); close() aborts one still waiting. It never rejects.
  void toolKeys.checkServer(startFetch, stopping.signal, () => recompose()).catch(() => undefined);
  // Only a server that started takes up the import its owner asked for, or counts for setup's offer: one that failed to
  // listen hands back no close to stop them.
  if (offersImport && existsSync(importAsked)) void importAtSetup();
  else if (offersImport && options.countSessions && owner && !owner.hasPassword()) countSessions();
  if (isLoopback(host)) names = loopbackNames(host, options.allowHosts, options.publicUrl);
  // An address of every interface is reached on this machine at its loopback one.
  const url = urlOf(server, host);
  owner?.attach(options.publicUrl ?? url, options.publicUrl ? [] : elsewhereOf(host, (server.address() as AddressInfo).port));
  webhooks.attach(options.publicUrl ?? url);
  slack.attach(options.publicUrl ?? url);
  // A local install is the one server an MCP server's URL may be on loopback for (anywhere else, loopback is this machine's
  // other services: mcp-oauth.ts mcpServerAt), and only as its operator says (mcpLoopback), never inferred from where it
  // listens: a hosted container listens on loopback behind its proxy too.
  const localInstall = options.mcpLoopback === true;
  mcpServers.attach(options.publicUrl ?? url, url, localInstall);
  // Its own addresses, kept in the store for a runner in its own process whose own opt-in lets it reach loopback: its runs
  // never reach this server's ports there either (mcp-private-hosts.ts saveServerOwn). It listens already: a write that
  // fails stops the start and lets go of the port, as the start's other stops let go of the store and the locks.
  await saveServerOwn(store, mcpServers.own).catch(async (error: unknown) => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    throw error;
  });
  // It serves: the public address it serves at is remembered now, and a change of it said (above).
  address.keep((said) => void process.stderr.write(`agentrun-serve: ${said}\n`));
  if (address.changed) {
    const line = logLine("public_url_changed", { from: address.changed.from ?? "none", to: address.changed.to ?? "none", warning: publicAddressChanged });
    if (log) log(line);
    else process.stderr.write(`agentrun-serve: ${line}\n`);
  }
  // The lister's own passes (above), once this server listens and knows its own address (ownOriginOf).
  lister.start();
  // Then, not waited on: every ended run whose stored cost is unknown heals by its run read's rule, the store's figure
  // from a priced booking (cost-heal.ts), a page at a time. One count line when it read any run, no ids; a store with
  // none says nothing. Drained by stop.
  const costHealSaid = (fields: Record<string, string | number>) => {
    const line = logLine("cost_heal", fields);
    if (log) log(line);
    else process.stderr.write(`agentrun-serve: ${line}\n`);
  };
  costHealed = healEndedCosts(store, { stopped: () => costHealStopped })
    .then(({ read, healed, failed }) => (read > 0 ? costHealSaid({ read, healed, failed }) : undefined))
    .catch((error: Error) => costHealSaid({ condition: "cost_heal_failed", error: error.message }));
  // A run's end and its wait are the outbound webhook's run.ended and run.needs_input (webhooks.ts). The runners write them
  // to the store and this server runs no run, so it follows the store's run-change feed (Store.runs.changedSince): every
  // run reaching a final state, or let go by its runner (parked, or running with none), once, in order, under a cursor
  // kept in this process. It tells each end once the run reads final, and each wait of a run let go once it reads
  // input_required. The markers are an end's time and a wait's ask (webhooks.ts waitMarkerOf), so each webhook-id is the
  // same on every read, and the ledger tells each once across restarts. The feed is read every 250 ms; a store that woke its readers on a
  // change would be the next seam.
  const RUN_CHANGES_POLL_MS = 250;
  const final = (row: { state: string }) => (FINAL_STATES as readonly string[]).includes(row.state);
  /** A row its stop ended (stopEnd), which may stand at the person's stop (store.ts stoppedByPerson: an agentic run, its
   *  status input_required and idle, a message continues it) and not have ended: its view says which. */
  const stopRow = (row: RunRow) => row.state === "stopped" && row.outcome === "stopped" && row.importedFrom === null;
  const endOf = (row: RunRow) => ({ id: row.id, state: final(row) ? row.state : "running", ...(final(row) && row.endedAt !== null ? { endedAt: new Date(row.endedAt).toISOString() } : {}), ...(stopRow(row) ? { stop: true } : {}) });
  /** Agent `agentId`'s name as the store holds it now, for a webhook notice: its id when it has none, or is gone. */
  const agentNameOf = async (agentId: string): Promise<string> => (await store.agents.get(agentId))?.name || agentId;
  /** The run as the store holds it now, with its notice (the run list's own view of it); null when there is no such run. */
  const endNotice = async (id: string) => {
    const row = await store.runs.get(id);
    const summary = row && (await summaryOverStore(store, id, viewDepsFor(ownOriginOf())));
    if (!row || !summary) return null;
    return { ...endOf(row), notice: { run_id: id, agent_id: row.agentId, agent_name: await agentNameOf(row.agentId), status: String(summary.status), title: typeof summary.title === "string" ? summary.title : "" } };
  };
  /** The run-end read's look at a run: its end from its row alone when it has none, or one told already; else its
   *  endNotice. The run's view redacts the run's words (its title, its output) on every build, and the newest runs are
   *  read every RUN_ENDS_POLL_MS, so only an end still to tell builds one. */
  const endToTell = async (id: string): Promise<ReturnType<typeof endOf> | Awaited<ReturnType<typeof endNotice>>> => {
    const row = await store.runs.get(id);
    if (!row) return null;
    const end = endOf(row);
    return !end.endedAt || toldEnds.get(id) === end.endedAt ? end : endNotice(id);
  };
  const toldEnds = new Map<string, string>();
  /** Each waiting run's row as it was last read for its wait (its state, epoch and runner): a row that has not moved since
   *  is not read again, and a new wait comes with a new claim, so a new epoch. */
  const readWaits = new Map<string, string>();
  /** When each held wait (a run waiting on its person with its claim held) was last read again. */
  const heldReadAt = new Map<string, number>();
  const HELD_WAIT_REREAD_MS = 1_000;
  const waitKinds = new Set(["question", "approval", "budget", "browser", "computer", "stopped"]);
  /** The wait of a run its runner left parked (or let go of), or holds in its claim, told once per ask: its marker the
   *  ask's own (webhooks.ts waitMarkerOf), its kind the pending card's (none when the run waits on no card). False when it
   *  is not done (a read that failed, or its notice not saved): it is read again. */
  const tellWait = async (row: RunRow): Promise<boolean> => {
    const seen = `${row.state}\n${row.epoch}\n${row.runner ?? ""}\n${row.summary ?? ""}`;
    // An audit's shadow run waits on no one (runner/audit.ts AUDIT_PARKED): the park it ends at once is no one's to answer.
    if (readWaits.get(row.id) === seen || isShadowRun(row.id)) return true;
    const view = await viewOverStore(store, row.id, viewDepsFor(ownOriginOf()));
    if (view?.status !== "input_required") return (readWaits.set(row.id, seen), true);
    const rows = (await timelineOverStore(store, row.id, viewDepsFor(ownOriginOf()))) ?? [];
    const card = (view.pending as { kind?: unknown } | null | undefined)?.kind;
    // A stop asked for and not yet taken reads stopped (store-view's stopAsked) before its row ends: it is told once the
    // runner's end commit ends the row (a change the feed brings), under the one marker that end gives it.
    if (card === "stopped" && row.endedAt === null) return true;
    // One marker per ask, so the held read and the let-go read of one ask agree, whatever row shows last. A stop's is when
    // its stop ended the row: rows its stopped turn still streams in (a late result, a charge) never move it.
    const marker = card === "stopped" && row.endedAt !== null ? `stopped:${new Date(row.endedAt).toISOString()}` : waitMarkerOf(rows, view.pending as Parameters<typeof waitMarkerOf>[1], view.state === "waiting", LEARNING_LABEL);
    if (!marker) return (readWaits.set(row.id, seen), true);
    // Its kind is the read's own `pending.kind` (a stop's is stoppedTurn's), so the notice and GET never disagree; a wait
    // whose card is withheld is a question. A run idle on nothing named (its harness ended its turn on its own) names no kind.
    const kind = typeof card === "string" && waitKinds.has(card) ? card : view.state === "waiting" ? "question" : undefined;
    const wait = kind === undefined ? undefined : ({ kind } as NonNullable<RunNotice["pending"]>);
    const notice: RunNotice = { run_id: row.id, agent_id: row.agentId, agent_name: await agentNameOf(row.agentId), status: "input_required", title: typeof view.title === "string" ? view.title : "", ...(wait ? { pending: wait } : {}) };
    if (!(await toldAll(row.id, waitSubscribers.map((tell) => () => tell(notice, wait, marker))))) return false;
    readWaits.set(row.id, seen);
    return true;
  };
  /** Who hears of each run's end and each wait the follower reads (runNotices): the outbound webhook first. Each is called
   *  once a run reads final (onEnded) or is let go waiting on a person (onWaits), and again on a later read while any of
   *  them threw (said once, run_notice_unread): so at least once, and the same moment always comes with the same `marker`
   *  (an end's time, a wait's ask), on which each dedupes in a ledger of its own. An end from while no server was up
   *  reaches the webhook alone, through its own catch-up (webhooks.ts catchUp). */
  const endedSubscribers: Array<(run: RunNotice, marker: string) => unknown> = [];
  const waitSubscribers: Array<(run: RunNotice, wait: RunNotice["pending"], marker: string) => unknown> = [];
  const runNotices = {
    onEnded: (tell: (run: RunNotice, marker: string) => unknown) => void endedSubscribers.push(tell),
    onWaits: (tell: (run: RunNotice, wait: RunNotice["pending"], marker: string) => unknown) => void waitSubscribers.push(tell),
  };
  runNotices.onEnded(async (run, marker) => {
    if ((await webhooks.emit("run.ended", run, marker)) === "unsaved") throw new Error("its run.ended is not saved yet");
  });
  runNotices.onWaits(async (run, _wait, marker) => {
    if ((await webhooks.emit("run.needs_input", run, marker)) === "unsaved") throw new Error("its run.needs_input is not saved yet");
  });
  // Slack hears the same moments, under its own ledger (slack.ts).
  runNotices.onEnded(async (run, marker) => {
    if ((await slack.emit("run.ended", run, marker)) === "unsaved") throw new Error("its Slack run.ended is not saved yet");
  });
  runNotices.onWaits(async (run, _wait, marker) => {
    if ((await slack.emit("run.needs_input", run, marker)) === "unsaved") throw new Error("its Slack run.needs_input is not saved yet");
  });
  /** Every call of `calls` made: false when one threw (said once for the run), so the run is told again. */
  const toldAll = async (id: string, calls: ReadonlyArray<() => unknown>): Promise<boolean> => {
    let done = true;
    for (const call of calls) {
      try {
        await call();
      } catch (error) {
        sayUnread(id, (error as Error).message);
        done = false;
      }
    }
    return done;
  };
  /** Why a run's notice is not done yet, said once for the run (until it is done): one that stays undone shows. */
  const unreadSaid = new Set<string>();
  const sayUnread = (id: string, error: string) => {
    if (unreadSaid.has(id)) return;
    unreadSaid.add(id);
    log?.(logLine("webhook", { condition: "run_notice_unread", run: id, error }));
  };
  /** A run's end, told once the run reads final. False when it is not done (a read that failed, or its notice not saved). */
  const tellEnd = async (id: string): Promise<boolean> => {
    // An audit's shadow run is no host's run (learn/audit.ts): it sends no notice of any kind; its cost reaches a host as
    // the audited run's cost.learning_usd alone.
    if (isShadowRun(id)) return true;
    const now = await endNotice(id).catch((error: Error) => (sayUnread(id, error.message), undefined));
    if (now === undefined) return false;
    // A person's stop of an agentic run ends its row but not the run: it reads input_required (pending kind stopped), so
    // it is told as that wait, run.needs_input, never as an end.
    if (now?.notice.status === "input_required") {
      const row = await rowNow(id);
      if (row === UNREAD) return (sayUnread(id, "its row could not be read"), false);
      const told = row === undefined || (await tellWait(row).catch((error: Error) => (sayUnread(id, error.message), false)));
      if (told) unreadSaid.delete(id);
      return told;
    }
    readWaits.delete(id);
    heldReadAt.delete(id);
    if (!now?.endedAt || toldEnds.get(id) === now.endedAt) return (unreadSaid.delete(id), true);
    if (!(await toldAll(id, endedSubscribers.map((tell) => () => tell(now.notice, now.endedAt!))))) return false;
    toldEnds.set(id, now.endedAt);
    unreadSaid.delete(id);
    return true;
  };
  /** A run's row as the store holds it now: undefined when there is no such run, UNREAD when the read failed. */
  const UNREAD = Symbol("unread");
  const rowNow = (id: string) => store.runs.get(id).catch((): typeof UNREAD => UNREAD);
  /** A run held in its claim waiting on its person (ask_person with its browser open, adapter-loop waitInClaim; or its
   *  browser hand-over, tools.ts), which its row's summary says (HELD_WAITS). Its row's state and runner do not move, so
   *  the feed has no change for it: each read looks for these among the running runs. */
  const heldWait = (row: RunRow) => row.state === "running" && row.runner !== null && row.summary !== null && HELD_WAITS.has(row.summary);
  /** A run waiting on its person: let go by its runner (parked, or running with none), or held in its claim (heldWait). */
  const letGo = (row: RunRow) => row.state === "parked" || (row.state === "running" && row.runner === null) || heldWait(row);
  /** One change of the feed, handled: an end told, a wait told, or nothing to tell. One not done goes to endsLeft or
   *  waitsLeft, by its run, which each read tries first until it is: a run that stays undone holds back no other. A wait is
   *  read from the run as it is now (a run gone since, or moved on, has none to tell). */
  const handle = async (change: RunChange): Promise<void> => {
    if (final(change)) {
      if (!(await tellEnd(change.id))) endsLeft.add(change.id);
      return;
    }
    if (change.state === "parked" || (change.state === "running" && change.runner === null)) {
      if (!(await tellLetGo(change.id))) waitsLeft.add(change.id);
    }
  };
  /** The wait of run `id` if it is let go now: false when not done (its read failed, or its wait not told). */
  const tellLetGo = async (id: string): Promise<boolean> => {
    const row = await rowNow(id);
    if (row === UNREAD) return (sayUnread(id, "its row could not be read"), false);
    if (row === undefined || !(letGo(row) || stopRow(row))) return true;
    const told = await tellWait(row).catch((error: Error) => (sayUnread(id, error.message), false));
    if (told) unreadSaid.delete(id);
    return told;
  };
  /** Where the feed is read on from: past each page once its changes are handled, each told or left in endsLeft or
   *  waitsLeft. None is dropped (a run left is tried again on each read), none is skipped, and none is read twice. */
  let changesCursor: RunChangeCursor | undefined;
  /** The runs whose end, or whose wait, is not told yet (a read that failed, or a notice not saved): from the feed, or from
   *  the start. Each read tries them first, until each is done. */
  const endsLeft = new Set<string>();
  const waitsLeft = new Set<string>();
  const readChanges = async (): Promise<void> => {
    for (const id of [...endsLeft]) {
      if (closing) return;
      if (await tellEnd(id)) endsLeft.delete(id);
    }
    for (const id of [...waitsLeft]) {
      if (closing) return;
      if (await tellLetGo(id)) waitsLeft.delete(id);
    }
    for (;;) {
      if (closing) return;
      const page = await store.runs.changedSince(changesCursor, { limit: RUN_CHANGES_PAGE });
      for (const change of page.changes) await handle(change);
      changesCursor = page.next;
      if (page.changes.length < RUN_CHANGES_PAGE) break;
    }
    // The held waits, which the feed has no change for. A held run's next ask in the same claim reads the same row as its
    // last (state, epoch, runner, summary), and the answer between may come and go within one read: so a held wait is read
    // again now and then (HELD_WAIT_REREAD_MS), and told once per ask all the same, each ask's notice keyed to the ask
    // itself (webhooks.ts waitMarkerOf), never to the row that shows last.
    for (const row of await store.runs.list({ state: "running" })) {
      if (closing) return;
      if (!heldWait(row)) continue;
      if (Date.now() - (heldReadAt.get(row.id) ?? 0) >= HELD_WAIT_REREAD_MS) {
        heldReadAt.set(row.id, Date.now());
        readWaits.delete(row.id);
      }
      if (!(await tellWait(row).catch((error: Error) => (sayUnread(row.id, error.message), false)))) waitsLeft.add(row.id);
    }
  };
  let endsTimer: NodeJS.Timeout | undefined;
  let endsRead: Promise<void> = Promise.resolve();
  /** Whether the start (startFollowing) is done: until it is, each turn runs it again before it reads the feed, so the ends
   *  and waits from while no server was up are told whatever failed it. Said once. */
  let started = false;
  let startSaid = false;
  const followChanges = () => {
    if (closing) return;
    const turn = started
      ? readChanges()
      : startFollowing().then(
          () => ((started = true), readChanges()),
          (error: Error) => void (startSaid || ((startSaid = true), log?.(logLine("webhook", { condition: "catch_up_unread", error: error.message })))),
        );
    endsRead = turn
      .catch((error: Error) => log?.(logLine("webhook", { condition: "run_changes_unread", error: error.message })))
      .finally(() => {
        if (!closing) (endsTimer = setTimeout(followChanges, RUN_CHANGES_POLL_MS)).unref();
      });
  };
  /** The start, in this order, so no change is lost between its steps: the feed's head first (one read, untold),
   *  then what the store holds now (the ends the ledger lacks, webhooks.ts catchUp, and the waits of the runs let go: the
   *  feed has none from before its table, and none from a time no server read it), then the feed from that head. A change
   *  after the head is read by the feed even when the store's rows already showed it, and the ledger tells it once. */
  const startFollowing = async () => {
    changesCursor = await store.runs.changesHead();
    const rows = await store.runs.list({});
    // An end catchUp cannot read, or whose notice the store refused, is said there and left for each read to try
    // (endsLeft): it is before the feed's head, so no change of the feed brings it back.
    const ends = rows.filter((row) => !row.importedFrom && !isShadowRun(row.id)).map(endOf);
    const unsaved = await webhooks.catchUp(ends, (id) => endNotice(id).catch((error: Error) => (endsLeft.add(id), Promise.reject(error))));
    for (const id of unsaved) endsLeft.add(id);
    for (const id of await slack.catchUp(ends, (id) => endNotice(id).catch((error: Error) => (endsLeft.add(id), Promise.reject(error))))) endsLeft.add(id);
    // A run that stands at a person's stop waits too (tellWait reads its view: one its stop ended reads no wait).
    for (const row of rows) if (!closing && (letGo(row) || stopRow(row)) && !(await tellWait(row).catch((error: Error) => (sayUnread(row.id, error.message), false)))) waitsLeft.add(row.id);
  };
  followChanges();
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
    clearInterval(localSourceTimer);
    // Cancel a pending ChatGPT callback without signing out or changing the saved credential (not waited for).
    void plan.close();
    // The CLI's sign-in still waiting for its browser ends with the server, which forgets it: left running, its CLI would
    // keep the browser's callback port from the next server's sign-in. Awaited until its process is gone.
    const signInStopped = claudeSignIns.close();
    const observationStopped = stopObservationRetention();
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
    await schemaSealed;
    await installStopped;
    await signInStopped;
    await observationStopped;
    await localSourceSweep;
    // The ends' follower stops before the webhooks it feeds and the store it reads.
    clearTimeout(endsTimer);
    await endsRead;
    await webhooks.close();
    await slack.close();
    // An upgraded socket is no connection closeAllConnections ends, and server.close waits for it.
    viewers.close();
    await attach.close();
    await new Promise((done) => (server.close(done), server.closeAllConnections()));
    await mcpStopped;
    await githubStopped;
    // --faux-github's fake GitHub API, once nothing asks it anything.
    await fauxGitHub?.close();
    // The start's cost heal stops at its next run, and the listings' builder ends its pass, before the store they read
    // and write closes.
    costHealStopped = true;
    await costHealed;
    await lister.stop();
    // No more sweeps of the runs no runner can take, and the refused word of the runner beside it goes with it: a start
    // whose runner can claim finds no refusal of this one.
    refusedStopped = true;
    clearInterval(refusedTimer);
    await refusedSweep;
    await refusedBeside?.close();
    // The store's EXCLUSIVE lock is the one-server lock: closing it releases it for the next server.
    await store.close();
    dataLock.release();
    seal.release();
    // Last, so a stop cut at its deadline has closed the rest: the host-address retry, aborted above, its read in flight
    // cut then and its container's removal running since, within two REMOVE_MS.
    await hostRetried;
  }
  return {
    url,
    baseUrl: `${url}/v2`,
    port: (server.address() as AddressInfo).port,
    token,
    tokenIds: tokens.map((entry) => entry.id),
    tokenFile,
    tokenMade: stored?.made ?? false,
    ...(setupUrl ? { setupUrl, setupOpen: openSetup } : {}),
    ...(consoleSessions ? { launchCode: consoleSessions.code } : {}),
    boxesLine: boxesLine(boxOffers, enabledBoxes(env), boxAllow, boxesByDefault(env)),
    attachHub,
    dial: { ...(options.publicUrl ? { url: options.publicUrl.replace(/\/+$/, "") } : {}), tokens: attach.machineTokens, hub: attachHub },
    localInstall,
    ollamaHost,
    own: mcpServers.own,
    ...(fauxGitHub ? { fauxGitHub: { api: fauxGitHub.url, ...(fauxGitHub.web ? { web: fauxGitHub.web } : {}) } } : {}),
    // Once: a second call, at any time, is the first one's promise, so a close repeated after the next server started
    // never writes this data root's record again (the next server's, by then).
    close: () => (stopped ??= stop()),
    // No per-run process drains here: the runner owns a run's turn, so a stop waits on none.
    stopping: () => ({ runs: 0, boundMs: 0 }),
    listingSettled: () => lister.settled(),
    refuseRuns: (words) => {
      if (refusedBeside || refusedStopped) return;
      refusedBeside = keepPresence(store.runners, `${hostname()}:${process.pid}:beside`, words, { warn: (line) => void process.stderr.write(`agentrun-serve: ${line}\n`) });
      // The runs it left queued fail now, not at the next sweep.
      void sweepRefused();
    },
  };
}
