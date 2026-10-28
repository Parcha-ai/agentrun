// The Claude Agent SDK as an AgentRun harness adapter (id `claude-agent`). Written for AgentRun.
export { CLAUDE_AGENT_ALSO_OFF, CLAUDE_AGENT_DIGESTS, CLAUDE_AGENT_ID, claudeAgentAdapter, claudeAgentCliPins, thinkingOf, verifyClaudeAgent, verifyClaudeAgentCli } from "./adapter.js";
export { CLAUDE_AGENT_PACKAGE, ClaudeAgentNotInstalled, ClaudeAgentPinMismatch, ClaudeAgentThinkingOff } from "./errors.js";
export type { ClaudeAgentPin } from "./errors.js";
export type { ClaudeAgentAdapterOptions, ClaudeAgentProvider, ClaudeAgentThinking } from "./adapter.js";
export { CLAUDE_AGENT_SDK_INSTALL, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION as CLAUDE_AGENT_CLI_VERSION } from "./versions.js";
export { findClaudeExecutable as claudeAgentExecutable } from "./binary.js";
export { anthropicPolicy, OWN_TOOL_PREFIX, thinks } from "./host/policy.js";
export type { AnthropicPolicyOptions } from "./host/policy.js";
export type { ChildCommand, ConfineChild } from "./host/machine.js";
