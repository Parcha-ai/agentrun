// Commands as rows (design: "Commands from the console are rows, not files or doors"). The server inserts one through
// sendCommand; a runner reads them with store.commands(run, after) and hands each to the run's loop. A command's
// taken_at is set once: by the loop's journal commit that applies it, or by the runner's refusal with a reason.
import type { Command } from "./loop-contract.js";

export const COMMAND_KINDS: ReadonlySet<string> = new Set(["stop", "steer", "approve", "deny", "raise"]);

export interface CommandInput {
  readonly kind: string;
  readonly body?: Record<string, unknown>;
}

/** The store's insert: refuses a run that is final (RunFinal) in the insert itself, so it never races the run's end. */
export interface CommandSink {
  command(runId: string, command: { kind: string; body: Record<string, unknown> }): Promise<Command>;
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Why a command's body is wrong for its kind, or undefined when it is right. */
function bodyProblem(kind: string, body: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "stop":
      return body.reason === undefined || typeof body.reason === "string" ? undefined : "a stop's reason is text";
    case "steer":
      return text(body.text) ? undefined : "a steer needs its text";
    case "approve":
    case "deny":
      return text(body.approval) ? undefined : `${kind === "approve" ? "an approve" : "a deny"} names its approval`;
    case "raise":
      return typeof body.capUsd === "number" && Number.isFinite(body.capUsd) && body.capUsd > 0
        ? undefined
        : "a raise names its new cap in dollars (capUsd), above zero";
    default:
      return undefined;
  }
}

/** Inserts a command row for a run, after checking its kind and body. Rejects RunFinal (from the store) when the run is
 *  final, and a TypeError for a kind or body no runner would take. */
export async function sendCommand(store: CommandSink, runId: string, input: CommandInput): Promise<Command> {
  if (!COMMAND_KINDS.has(input.kind)) {
    throw new TypeError(`a command's kind is one of ${[...COMMAND_KINDS].join(", ")}, not ${JSON.stringify(input.kind)}`);
  }
  const body = input.body ?? {};
  const problem = bodyProblem(input.kind, body);
  if (problem) throw new TypeError(problem);
  return store.command(runId, { kind: input.kind, body });
}

/** The reason a runner gives for a command still untaken when its run ended. */
export function endedReason(state: "ended" | "stopped" | "failed"): string {
  const how = state === "ended" ? "ended" : state === "stopped" ? "was stopped" : "failed";
  return `the run ${how} before this command was taken`;
}
