// A tool's result for the model, read the same by every pi-durable serve takes: 1.1 reads `content`, 1.2 and later
// `output`, and a result with only one of them reaches the other as an empty result, with no error.
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** A block of a result for the model: text, or an image as pi-ai's `ImageContent` (the same in pi 1.1, 1.2 and 1.3). */
export type ModelBlock = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** `blocks` under both keys, with any other fields of the result. */
export const forModelBlocks = (blocks: readonly ModelBlock[], fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult =>
  ({ ...fields, content: blocks, output: blocks }) as unknown as ToolExecutionResult;

/** `text` under both keys, with any other fields of the result. */
export const forModel = (text: string, fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult => forModelBlocks([{ type: "text", text }], fields);
