// The Workspace port (workspace.ts), its folder layout (paths.ts) and its backends. Nothing on main imports this
// folder until the cutover that moves every writer onto it.
export * from "./workspace.js";
export { agentDirName, agentFolder, agentLearningFolder, DISK_DIR, relativePath, relativeSegments, runFolder } from "./paths.js";
export { localWorkspace } from "./local.js";
