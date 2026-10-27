// The Claude Agent adapter's setup errors, typed for a host to map to a run's failure line. Written for AgentRun.

/** Which pin a mismatch is about. */
export type ClaudeAgentPin = "cli_sha256" | "cli_version" | "sdk_version";

/** The Agent SDK or its CLI is not the build this adapter is pinned to and checked with: nothing runs. */
export class ClaudeAgentPinMismatch extends Error {
  readonly code = "CLAUDE_AGENT_PIN_MISMATCH";
  constructor(readonly pin: ClaudeAgentPin, readonly expected: string, readonly found: string, readonly path?: string) {
    super(`agentrun-claude-agent: the Claude Agent ${pin === "sdk_version" ? "SDK" : "CLI"}${path ? ` at ${path}` : ""} is not the pinned build: its ${pin.replace("_", " ")} is ${found}, not ${expected}`);
    this.name = "ClaudeAgentPinMismatch";
  }
}

/** The host has not installed the Agent SDK (it is an optional peer dependency the host brings), or its CLI. */
export class ClaudeAgentNotInstalled extends Error {
  readonly code = "CLAUDE_AGENT_NOT_INSTALLED";
  constructor(readonly detail?: string) {
    super("Claude Agent SDK not installed");
    this.name = "ClaudeAgentNotInstalled";
  }
}
