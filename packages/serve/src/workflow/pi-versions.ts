// What the workflow code holds pi-durable to about a tool result and a failed Session, in one place (pi-durable 1.5).
//
// A tool result's blocks are its `output`. pi 1.1 read `content` instead; a result that carries only `content` reaches
// the model empty on 1.5, with no error from pi: where the workflow code receives a result it did not write, that is refused
// here. A storage error fails the Session, and its later calls reject with `SessionFailed` whose cause is that error.
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** The key pi-durable reads a tool result's blocks from. */
export const RESULT_KEY = "output" as const;

export type TextBlock = { type: "text"; text: string };

/** A tool result pi-durable reads as `blocks`: the blocks under `output`, each its own copy. */
export function toolResult(blocks: readonly TextBlock[], fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult {
  return { ...fields, output: blocks.map((block) => ({ ...block })) } as unknown as ToolExecutionResult;
}

/** A tool result whose blocks pi-durable would not read (only under pi 1.1's `content`): it reached the model empty. */
export class ToolResultKeyError extends Error {
  readonly code = "TOOL_RESULT_KEY";
  constructor(readonly tool: string) {
    super(`${tool} returned its result under "content", and pi-durable reads "output": the model would receive an empty result. Return the blocks under "output".`);
    this.name = "ToolResultKeyError";
  }
}

/** The blocks of a result `tool` returned, as pi-durable reads them; undefined for a result with no blocks (pi then
 *  shows what the tool streamed). A result whose blocks are only under `content` throws `ToolResultKeyError`. */
export function resultBlocks(tool: string, result: unknown): unknown[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const own = (result as Record<string, unknown>).output;
  if (own !== undefined) return Array.isArray(own) ? own : undefined;
  if ((result as Record<string, unknown>).content !== undefined) throw new ToolResultKeyError(tool);
  return undefined;
}

/** The storage error behind a Session that failed at one (`SessionFailed`, matched by name), else the error. */
export function storageError(error: unknown): unknown {
  return error instanceof Error && error.name === "SessionFailed" && error.cause !== undefined ? error.cause : error;
}
