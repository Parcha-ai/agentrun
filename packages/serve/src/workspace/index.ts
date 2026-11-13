// The Workspace port (workspace.ts), its folder layout (paths.ts), attach to a computer (attach.ts), where a run's
// tools run (place.ts), the local backend and the Archil one.
export * from "./workspace.js";
export {
  type AttachableComputer, attachedWorkspace, checkReadBack, COMPUTER_CHUNK, type MountCheck, NO_COMPUTER, noProcesses,
  type Processes,
} from "./attach.js";
export {
  agentDirName, agentFolder, agentHomeFolder, agentLearningFolder, COMPUTER_ROOT, DISK_DIR, homeKey, learningKey, portPath,
  relativePath, relativeSegments, runFolder, runKey, scratchFolder,
} from "./paths.js";
export type { Place } from "./place.js";
export { localWorkspace, workspaceAt } from "./local.js";
export { archilWorkspace, type ArchilWorkspaceOptions } from "./archil.js";
export { archilDisk, type ArchilDisk, type ArchilDiskOptions, type ArchilImage } from "./archil-disk.js";
export {
  ARCHIL_API_KEY_ROW, type ArchilClaim, archilClaim, type ArchilClaimOptions, ArchilClaimRefused, type ArchilSettings,
} from "./archil-claim.js";
export {
  ARCHIL_CONTROL_URLS, type ArchilMountCredentialOptions, ArchilMountCredentialError, listTokenUsers, mintMountToken, type MountCredential, nicknameOf, removeMountToken,
  removeOlderMountTokens,
} from "./archil-mount-credential.js";
export { ARCHIL_API_KEY_ENV, archilApiKey, type ArchilKeyOptions } from "./archil-key.js";
export { openRunWorkspace, type RunWorkspace, type RunWorkspaceOptions } from "./run-workspace.js";
export { readOnlyWorkspace, SERVER_READS_ONLY, serverRunWorkspace, type ServerRunWorkspaceOptions } from "./server-run-workspace.js";
export { type LedgerEntry, type ProviderLedger, storeLedger } from "./computer-ledger.js";
export { type LearningPlace, type LearningWorkspace, learningWorkspace, type LearningWorkspaceOptions } from "./learning-workspace.js";
export { ARCHIL_MAX_EXEC_S, handsOf, MAX_EXEC_S, processesOf, shellEnv } from "./hands.js";
export { type RunComputer, type RunHold, runTools, type RunTools, type ScriptComputer, withKindTools } from "./run-tools.js";
export { portOf } from "./computer-ports.js";
export { computerScriptExecutor, SCRIPT_DEFAULT_MS, SCRIPT_MAX_MS } from "./computer-script.js";
export { COMPUTER_MCP_NAME, computerMcp, type ComputerMcpAnswer, mcpAnswerOf } from "./computer-mcp.js";
export {
  type ClaimSide, computerReadiness, type ComputerSetting, type KindRegistry, type LaunchedComputer, type Port, resolveComputer,
  type ResolvedComputer, runShellOf, type ShellPlace, shellPlaceOf, type StartedComputer,
} from "./resolve-computer.js";
export { computerProviderFactories, computerProviderMakers, type ProviderLoad } from "./computer-providers.js";
export {
  claimComputer, claimKinds, type ComputerDeps, computerDepsFrom, type ComputerDepsOptions, computerSpecOf, DAEMON_CACHE_IN_VOLUME, DOCKER_HOST_ADDRESSES_ENV,
  type DockerComputerOptions, dockerHostAddressesOf, dockerVolumeOf,
} from "./computer-deps.js";
export { type ClaimComputer, type ClaimLaunch, computerForClaim, type ComputerForClaimDeps, type ComputerRun, type ComputerSaid, type ImageWait, type OpenComputerView, type ProviderMakers, type ViewEnd } from "./computer-for-claim.js";
export { JANITOR_EVERY_MS, type JanitorDeps, type ProviderSweep, startJanitor, sweepServerComputers } from "./computer-janitor.js";
export { agentComputerOf, agentComputerView, ownerGoneOf, reconcileAgentComputer, serverIdOf } from "./agent-computer.js";
export { layOwnSkills, RUN_SKILLS_DIR } from "./revision-skills.js";
export { KIND_SKILLS, type KindSkill, kindSkillOf, type SkillKind } from "./kind-skills.js";
