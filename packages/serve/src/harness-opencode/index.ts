export { openCodeAdapter } from "./adapter.js";
/** The check the adapter runs on the host's skills when it is made: @parcha/agentrun-kernel's own, as the other adapters'. */
export { skillProblems } from "@parcha/agentrun-kernel";
export type { HostSkill } from "@parcha/agentrun-kernel";
export type { OpenCodeAdapterOptions, OpenCodeProvider } from "./adapter.js";
export type { ChildCommand, ConfineChild } from "./host/server.js";
export { OPENCODE_VERSION, findOpenCode, openCodeBinary } from "./binary.js";
export { verifyOpenCode, verifyOpenCodeBinary } from "./verify.js";
export { OPENCODE_BINARY_SHA256, OPENCODE_INSTALL, OPENCODE_NPM_INTEGRITY, OpenCodeNotInstalled, OpenCodePinMismatch } from "./versions.js";
