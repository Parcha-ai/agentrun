// The Workspace port (workspace.ts), its folder layout (paths.ts), attach to a computer (attach.ts), where a run's
// tools run (place.ts), the local backend and the Archil one. Nothing on main imports this folder until the cutover
// that moves every writer onto it.
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
export { type LedgerEntry, type PhoneLedger, type PhoneLedgerEntry, phoneLedger, type ProviderLedger, storeLedger } from "./computer-ledger.js";
export { type LearningPlace, type LearningWorkspace, learningWorkspace, type LearningWorkspaceOptions } from "./learning-workspace.js";
export { ARCHIL_MAX_EXEC_S, type Hands, handsOf, MAX_EXEC_S, processesOf, shellEnv } from "./hands.js";
export { type RunBrowser, type RunComputer, type RunHold, runTools, type RunTools } from "./run-tools.js";
export { inputOf, phoneOf, screenOf } from "./computer-ports.js";
export {
  type ClaimSide, type ComputerSetting, type ComputerSettingKind, type KindCapabilities, type KindRegistry, type LaunchedComputer, type Port,
  type ProviderEntry, resolveComputer, type ResolvedComputer, type StartedComputer,
} from "./resolve-computer.js";
export { computerProviderFactories, computerProviderMakers, type ProviderLoad } from "./computer-providers.js";
export { claimComputer, type ComputerDeps, computerDepsFrom, type ComputerDepsOptions, computerSpecOf, DEFAULT_IMAGE } from "./computer-deps.js";
export { type ClaimComputer, type ClaimLaunch, computerForClaim, type ComputerForClaimDeps, type ComputerRun, type OpenComputerView, type ProviderMakers, sweepComputers, type ViewEnd } from "./computer-for-claim.js";
export { layOwnSkills, RUN_SKILLS_DIR } from "./revision-skills.js";
export { KIND_SKILLS, type KindSkill, kindSkillOf, type SkillKind } from "./kind-skills.js";
