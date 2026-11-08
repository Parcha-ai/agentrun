// The Workspace port (workspace.ts), its folder layout (paths.ts), attach to a computer (attach.ts), where a run's
// tools run (place.ts) and the local backend. Nothing on main imports this folder until the cutover that moves every
// writer onto it.
export * from "./workspace.js";
export {
  attachedWorkspace, BACKGROUND_REFUSAL, checkMount, COMPUTER_CHUNK, type Computer, type ComputerErrorCode, type ComputerFileType,
  type ComputerResult, type ComputerStat, MOUNT_AT, type MountReadBack, type MountSpec, noProcesses, type ProcessExit, type Processes,
  type ProcessInfo, type ProcessSignal, type ProcessStream,
} from "./attach.js";
export { agentDirName, agentFolder, agentLearningFolder, DISK_DIR, relativePath, relativeSegments, runFolder } from "./paths.js";
export { type Available, type Place, PROVIDERS, type ProviderId, type Resolved, resolvePlace } from "./place.js";
export { localWorkspace } from "./local.js";
