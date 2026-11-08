// Commands as rows (design: "Commands from the console are rows, not files or doors"). The server inserts one through
// sendCommand; a runner reads them with store.commands(run, after) and hands each to the run's loop. A command's
// taken_at is set once: by the loop's journal commit that applies it, or by the runner's refusal with a reason.
import { originOf } from "@parcha/pi-durable-agent/timeline";
import type { Command } from "./loop-contract.js";

/** stop and cancel both end the run, stopped: a cancel's end says it was cancelled, as main's cancel ends a run for good. */
export const COMMAND_KINDS: ReadonlySet<string> = new Set(["stop", "cancel", "steer", "approve", "deny", "raise"]);

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
    case "cancel":
      return body.reason === undefined || typeof body.reason === "string" ? undefined : `a ${kind}'s reason is text`;
    case "steer":
      if (!text(body.text)) return "a steer needs its text";
      // A trigger's message names who wrote it, as the Timeline shows it (pi-durable-agent's originOf): never a person's.
      return body.origin === undefined || originOf(body.origin) !== undefined ? undefined : "a steer's origin is a message origin (a trigger's, or the server's)";
    case "approve":
    case "deny":
      if (!text(body.approval)) return `${kind === "approve" ? "an approve" : "a deny"} names its approval`;
      return body.note === undefined || typeof body.note === "string" ? undefined : `${kind === "approve" ? "an approve" : "a deny"}'s note is text`;
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

/** The reason a command still untaken when its run ended is refused with: the store's own words (the write that makes a
 *  run final refuses such rows itself). */
export { endedReason } from "../store/store.js";
