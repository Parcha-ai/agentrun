import type { ToolOutput } from "../core/custody.js";

/** A tool result's blocks as pi-durable reads them: its `output`. */
export const forModel = (content: ToolOutput["content"]): { output: ToolOutput["content"] } => ({ output: content });
