import type { ToolOutput } from "./core/custody.js";

/** pi-durable 1.0 and 1.1 read a tool result's `content`; 1.2 reads `output` and treats a result that lacks it as empty. The model's text goes under both keys. */
export const forModel = (content: ToolOutput["content"]): { content: ToolOutput["content"]; output: ToolOutput["content"] } => ({ content, output: content });
