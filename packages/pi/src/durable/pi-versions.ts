// What differs between the pi-durable versions this package supports (1.0.4 to 1.2.x), in one place.
//
// A tool result's blocks are `content` up to 1.1 and `output` from 1.2. Each version reads its own key, ignores the other
// and stores only what it read, so a result that carries both is read the same by all of them. A result that carries only
// the other version's key reaches the model empty, with no error from pi: where this package receives a result it did not
// write, that is refused here. A storage error fails a 1.2 Session, and its later calls reject with `SessionFailed`
// whose cause is that error; 1.1 rejected with the error itself. No pi-durable name that one of the versions lacks is
// imported by name, since a missing named export fails the module at load.
import * as piDurable from "@earendil-works/pi-durable";
import type { Harness, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

/** The key the loaded pi-durable reads a tool result's blocks from. 1.2 renamed `content` to `output` in the release
 *  that added `SessionFailed`, so that export tells the two apart. */
export const RESULT_KEY: "content" | "output" = "SessionFailed" in piDurable ? "output" : "content";
const OTHER_KEY = RESULT_KEY === "output" ? "content" : "output";

export type TextBlock = { type: "text"; text: string };

/** A tool result every supported pi-durable reads as `blocks`: the blocks under both keys, each its own copy. */
export function toolResult(blocks: readonly TextBlock[], fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult {
  return { ...fields, content: blocks.map((block) => ({ ...block })), output: blocks.map((block) => ({ ...block })) } as unknown as ToolExecutionResult;
}

/** A tool result whose blocks the loaded pi-durable would not read: it reached the model empty. */
export class ToolResultKeyError extends Error {
  readonly code = "TOOL_RESULT_KEY";
  constructor(readonly tool: string) {
    super(`${tool} returned its result under "${OTHER_KEY}", and the loaded pi-durable reads "${RESULT_KEY}": the model would receive an empty result. Return the blocks under "${RESULT_KEY}", or under both keys.`);
    this.name = "ToolResultKeyError";
  }
}

/** The blocks of a result `tool` returned, as the loaded pi-durable reads them; undefined for a result with no blocks
 *  (pi then shows what the tool streamed). A result whose blocks are only under the other version's key throws
 *  `ToolResultKeyError`. */
export function resultBlocks(tool: string, result: unknown): unknown[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const own = (result as Record<string, unknown>)[RESULT_KEY];
  if (own !== undefined) return Array.isArray(own) ? own : undefined;
  if ((result as Record<string, unknown>)[OTHER_KEY] !== undefined) throw new ToolResultKeyError(tool);
  return undefined;
}

/** The storage error behind a Session that failed at one (`SessionFailed` on 1.2, matched by name), else the error. */
export function storageError(error: unknown): unknown {
  return error instanceof Error && error.name === "SessionFailed" && error.cause !== undefined ? error.cause : error;
}

/** A live task of a newer pi-durable than the loaded one: pi-durable 1.2 keeps a tool call in flight as a version 2
 *  `pi.tool` task, which an earlier version waits on without running. */
export class NewerTaskError extends Error {
  readonly code = "PI_TASK_NEWER";
  constructor(readonly kind: string, readonly version: number) {
    super(`A live ${kind} task is version ${version}, which pi-durable 1.2 or later runs and the loaded pi-durable (before 1.2) cannot: continue the run on pi-durable 1.2 or later.`);
    this.name = "NewerTaskError";
  }
}

/** Refuse a store a newer pi-durable left with a tool call in flight, instead of waiting on it: a host calls this after
 *  opening its Harness and before resuming it. On pi-durable 1.2 it does nothing. */
export async function refuseNewerTasks(harness: Pick<Harness, "inspect">, context: Context): Promise<void> {
  if (RESULT_KEY === "output") return;
  const newer = (await harness.inspect(context)).tasks.find(({ record }) => record.kind === "pi.tool" && record.version > 1)?.record;
  if (newer) throw new NewerTaskError(newer.kind, newer.version);
}
