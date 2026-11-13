// A tool's result for the model: its blocks under `output`, the key pi-durable reads (a result without it reaches the
// model empty, with no error).
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** A block of a result for the model: text, or an image as pi-ai's `ImageContent`. */
export type ModelBlock = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** `blocks` under `output`, with any other fields of the result. */
export const forModelBlocks = (blocks: readonly ModelBlock[], fields: Omit<ToolExecutionResult, "output"> = {}): ToolExecutionResult =>
  ({ ...fields, output: blocks }) as unknown as ToolExecutionResult;

/** `text` under `output`, with any other fields of the result. */
export const forModel = (text: string, fields: Omit<ToolExecutionResult, "output"> = {}): ToolExecutionResult => forModelBlocks([{ type: "text", text }], fields);
