// The Workspace port (workspace.ts), its folder layout (paths.ts), attach to a computer (attach.ts), where a run's
// tools run (place.ts) and the local backend. Nothing on main imports this folder until the cutover that moves every
// writer onto it.
export * from "./workspace.js";
export {
  type AttachableComputer, attachedWorkspace, checkReadBack, COMPUTER_CHUNK, type MountCheck, NO_COMPUTER, noProcesses,
  type Processes,
} from "./attach.js";
export {
  agentDirName, agentFolder, agentLearningFolder, COMPUTER_ROOT, DISK_DIR, portPath, relativePath, relativeSegments, runFolder,
} from "./paths.js";
export { type Available, type Place, type Registry, type Resolved, resolvePlace } from "./place.js";
export { localWorkspace } from "./local.js";
export { ARCHIL_MAX_EXEC_S, type Hands, type HandsExecResult, handsOf, MAX_EXEC_S, shellEnv } from "./hands.js";
