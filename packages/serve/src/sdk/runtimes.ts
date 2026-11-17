/** The sources an SDK run can name. Each one runs in the caller's backend; AgentRun only records the run.
 *  `claude-agent-sdk` and `codex-sdk` are SDK libraries; `openclaw` and `capy` are agent platforms whose own agents,
 *  scheduled jobs and threads report their runs through the same SDK-run calls. */
export const SDK_RUNTIMES = ["claude-agent-sdk", "codex-sdk", "eve", "openclaw", "capy"] as const;
export type SdkRuntime = (typeof SDK_RUNTIMES)[number];
/** The runtimes with a backend workflow bridge (the client wrappers' local MCP `learned_workflow` server). The agent
 *  platforms have none, so their runs learn notes and skills, and a start that carries workflow_tools is refused. */
export const SDK_WORKFLOW_RUNTIMES: readonly SdkRuntime[] = ["claude-agent-sdk", "codex-sdk"];
export const isSdkRuntime = (value: unknown): value is SdkRuntime =>
  typeof value === "string" && (SDK_RUNTIMES as readonly string[]).includes(value);
