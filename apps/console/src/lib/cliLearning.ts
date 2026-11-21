import type { Run } from "@/lib/v2";
export type CliLearningRuntime = "codex" | "claude-code";
export type CliLearningBinding = { runtime: CliLearningRuntime; connection_id: string; project: string };

/** A source-owned CLI reports its own work; this is not an AgentRun task launcher or SDK wrapper. */
export function cliLearningOf(value: unknown): CliLearningBinding | undefined {
  const cli = value && typeof value === "object" ? (value as { cli_learning?: Partial<CliLearningBinding> }).cli_learning : undefined;
  return cli && (cli.runtime === "codex" || cli.runtime === "claude-code") && typeof cli.connection_id === "string" && typeof cli.project === "string" ? cli as CliLearningBinding : undefined;
}

export const cliLearningLabel = (runtime: CliLearningRuntime) => runtime === "codex" ? "Codex CLI" : "Claude Code";

export const cliRunOf = (run: Run) => run.cli_learning;
export const cliRunLabel = (runtime: "codex-cli" | "claude-code-cli") => runtime === "codex-cli" ? "Codex CLI" : "Claude Code";
