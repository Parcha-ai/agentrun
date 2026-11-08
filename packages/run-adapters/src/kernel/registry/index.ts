// The kernel's one tool registry: the host tools' definitions, words and limits, the gate's shell family, the run's
// hands, and the executors the kernel owns. Unused on main until the cutover wires serve onto it.
export { BACKGROUND_EXECUTORS, endBackground } from "./background.js";
export { boundedBash } from "./bash.js";
export { bashTimeoutWords, hostToolDefs } from "./defs.js";
export type { ShellPlace, ToolDef } from "./defs.js";
export { defaultPermissionOf, SHELL_FAMILY, SHELL_WATCHERS, shellPermission, shellToolOf } from "./gate.js";
export type { Permission } from "./gate.js";
export { answerOf, exitCodeOf } from "./hands.js";
export type { ExecResult, Executor, Hands, HostExecutors, ProcessInfo, Processes, ToolAnswer, ToolCall } from "./hands.js";
export {
  BACKGROUND_DIR,
  BACKGROUND_INPUT_BYTES,
  BACKGROUND_LIST_MAX,
  BACKGROUND_LOG_BYTES,
  BACKGROUND_MAX,
  BACKGROUND_PAGE_BYTES,
  BACKGROUND_SIGNALS,
  BACKGROUND_TOOLS,
  BASH_DEFAULT_TIMEOUT_S,
  BASH_MAX_TIMEOUT_S,
  READ_IMAGE_MAX_BYTES,
  SHELL_TOOLS,
} from "./limits.js";
export { createRegistry } from "./registry.js";
export type { Registry } from "./registry.js";
