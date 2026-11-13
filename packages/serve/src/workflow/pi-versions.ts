// What the workflow code holds pi-durable to about a tool result and a failed Session, in one place (pi-durable 1.5).
//
// A tool result's blocks are its `output` (pi 1.1 read `content`). A storage error fails the Session, and its later
// calls reject with `SessionFailed` whose cause is that error.
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export type TextBlock = { type: "text"; text: string };

/** A tool result pi-durable reads as `blocks`: the blocks under `output`, each its own copy. */
export function toolResult(blocks: readonly TextBlock[], fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult {
  return { ...fields, output: blocks.map((block) => ({ ...block })) } as unknown as ToolExecutionResult;
}

/** The storage error behind a Session that failed at one (`SessionFailed`, matched by name), else the error. */
export function storageError(error: unknown): unknown {
  return error instanceof Error && error.name === "SessionFailed" && error.cause !== undefined ? error.cause : error;
}
