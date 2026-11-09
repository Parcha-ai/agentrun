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
  ARCHIL_API_KEY_ROW, ARCHIL_DISK_TOKEN_ROW, type ArchilClaim, archilClaim, type ArchilClaimOptions, ArchilClaimRefused, type ArchilSettings,
} from "./archil-claim.js";
export { openRunWorkspace, type RunWorkspace, type RunWorkspaceOptions } from "./run-workspace.js";
export { type LedgerEntry, type ProviderLedger, storeLedger } from "./computer-ledger.js";
export { type LearningPlace, type LearningWorkspace, learningWorkspace, type LearningWorkspaceOptions } from "./learning-workspace.js";
export { ARCHIL_MAX_EXEC_S, type Hands, handsOf, MAX_EXEC_S, processesOf, shellEnv } from "./hands.js";
export { type RunBrowser, type RunComputer, type RunHold, runTools, type RunTools } from "./run-tools.js";
export { inputOf, phoneOf, screenOf } from "./computer-ports.js";
export {
  type ClaimSide, type ComputerSetting, type ComputerSettingKind, type KindCapabilities, type KindRegistry, type LaunchedComputer, type Port,
  type ProviderEntry, resolveComputer, type ResolvedComputer, type StartedComputer,
} from "./resolve-computer.js";
export { type ClaimComputer, type ClaimLaunch, computerForClaim, type ComputerForClaimDeps, type OpenComputerView, type ProviderMakers, sweepComputers, type ViewEnd } from "./computer-for-claim.js";
export { layRevisionSkills, RUN_SKILLS_DIR } from "./revision-skills.js";
