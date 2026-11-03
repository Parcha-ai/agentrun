// The Claude Agent adapter's setup errors, typed for a host to map to a run's failure line. Written for AgentRun.

/** Which pin a mismatch is about. */
export type ClaudeAgentPin = "cli_sha256" | "cli_version" | "sdk_version";

/** The Agent SDK or its CLI is not the build this adapter is pinned to and checked with: nothing runs. */
export class ClaudeAgentPinMismatch extends Error {
  readonly code = "CLAUDE_AGENT_PIN_MISMATCH";
  constructor(readonly pin: ClaudeAgentPin, readonly expected: string, readonly found: string, readonly path?: string) {
    super(`agentrun-harness-claude: the Claude Agent ${pin === "sdk_version" ? "SDK" : "CLI"}${path ? ` at ${path}` : ""} is not the pinned build: its ${pin.replace("_", " ")} is ${found}, not ${expected}`);
    this.name = "ClaudeAgentPinMismatch";
  }
}

/** This package's name on npm, as a message names it. */
export const CLAUDE_AGENT_PACKAGE = "@parcha/agentrun-harness-claude";

/** The host has not installed the Agent SDK (it is an optional peer dependency the host brings), or its CLI. The message
 *  is one line: what is missing, and, where installing the pinned SDK is the fix, the line that does it (`install`). */
export class ClaudeAgentNotInstalled extends Error {
  readonly code = "CLAUDE_AGENT_NOT_INSTALLED";
  constructor(readonly detail?: string, readonly install?: string) {
    super(`Claude Agent SDK not installed${detail ? `: ${detail}` : ""}${install ? `; install it with: ${install}` : ""}`);
    this.name = "ClaudeAgentNotInstalled";
  }
}

/** A thinking level that would turn the model's reasoning off: never taken; a node that names none thinks at medium. */
export class ClaudeAgentThinkingOff extends Error {
  readonly code = "CLAUDE_AGENT_THINKING_OFF";
  constructor(readonly level: string) {
    super(`agentrun-harness-claude: thinking is never off; ${JSON.stringify(String(level).slice(0, 20))} is not a level (low, medium, high, xhigh or max)`);
    this.name = "ClaudeAgentThinkingOff";
  }
}
