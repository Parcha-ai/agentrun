// The kernel's one tool registry: the host tools' definitions, words and limits, the gate's shell family, the run's
// hands, and the executors the kernel owns; a desktop's or a phone's computer tools and the one port they run on. A
// browser computer's tools are the host's browser tool's (serve's tools.ts, pi-browser's durable extension), not
// the registry's.
export { BACKGROUND_EXECUTORS, endBackground, NEEDS_A_COMPUTER, NO_SHELL } from "./background.js";
export { boundedBash } from "./bash.js";
export { bashTimeoutWords, CAPABILITY_KINDS, hostToolDefs } from "./defs.js";
export type { ShellPlace, ToolDef } from "./defs.js";
export { COMPUTER_TOOLS, computerExecutors, computerToolDefs, computerToolsFor, SCRIPT_TOOL } from "./computer.js";
export { COMPUTER_TOOL_SCHEMAS, computerDeclarations } from "./computer-surface.generated.js";
export { defaultPermissionOf, SHELL_FAMILY, SHELL_WATCHERS, shellPermission, shellToolOf } from "./gate.js";
export type { Permission } from "./gate.js";
export { answerOf, exitCodeOf, needsKindWords } from "./hands.js";
export type { CapabilityKind, ComputerAnswer, ComputerPort, ExecResult, Executor, Hands, HostExecutors, ProcessInfo, Processes, ToolAnswer, ToolCall } from "./hands.js";
export { HANDOFF_DEFAULT_S, HANDOFF_MAX_S, HANDOFF_MIN_S, HANDOFF_TOOL } from "./handoff.js";
export type { Handoff } from "./hands.js";
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
  READ_IMAGE_MAX_BYTES,
  SHELL_TOOLS,
} from "./limits.js";
export { createRegistry } from "./registry.js";
export type { Registry } from "./registry.js";
