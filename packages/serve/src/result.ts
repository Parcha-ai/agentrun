// A tool's result for the model, read the same by every pi-durable serve takes: 1.1 reads `content`, 1.2 and later
// `output`, and a result with only one of them reaches the other as an empty result, with no error.
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** `text` under both keys, with any other fields of the result. */
export const forModel = (text: string, fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult => {
  const blocks = [{ type: "text" as const, text }];
  return { ...fields, content: blocks, output: blocks } as unknown as ToolExecutionResult;
};
