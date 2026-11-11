// The kernel's one tool registry: the host tools' definitions, words and limits, the gate's shell family, the run's
// hands, and the executors the kernel owns; a computer kind's own tools (desktop, phone) and the narrow ports they run
// on. A browser computer's tools are the host's browser tool's (serve's tools.ts, pi-browser's durable extension), not
// the registry's.
export { BACKGROUND_EXECUTORS, endBackground, NEEDS_A_COMPUTER, NO_SHELL } from "./background.js";
export { boundedBash } from "./bash.js";
export { bashTimeoutWords, CAPABILITY_KINDS, capabilityToolDefs, hostToolDefs } from "./defs.js";
export type { ShellPlace, ToolDef } from "./defs.js";
export { DESKTOP_ACTIONS, DESKTOP_EXECUTORS, DESKTOP_KEYS, DESKTOP_MAX_ACTIONS, DESKTOP_TOOL_DEFS } from "./desktop.js";
export { defaultPermissionOf, SHELL_FAMILY, SHELL_WATCHERS, shellPermission, shellToolOf } from "./gate.js";
export type { Permission } from "./gate.js";
export { answerOf, exitCodeOf, needsKindWords } from "./hands.js";
export type {
  CapabilityKind, ExecResult, Executor, Hands, HostExecutors, Input, InputAction, Phone, PhoneKey, PhoneNode, PhonePoint, ProcessInfo, Processes, Screen,
  ScreenPoint, Shot, ToolAnswer, ToolCall,
} from "./hands.js";
export { PHONE_EXECUTORS, PHONE_KEYS, PHONE_SWIPE_MAX_MS, PHONE_SWIPE_MS, PHONE_TOOL_DEFS, PHONE_TREE_MAX_CHARS, PHONE_TREE_MAX_NODES } from "./phone.js";
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
  BASH_MAX_TIMEOUT_S,
  READ_IMAGE_MAX_BYTES,
  SHELL_TOOLS,
} from "./limits.js";
export { createRegistry } from "./registry.js";
export type { Registry } from "./registry.js";
