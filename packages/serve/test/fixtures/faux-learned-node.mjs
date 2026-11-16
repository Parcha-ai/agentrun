// A priced faux model for a learned workflow's model node beside the MCP tests' agent (faux-mcp.mjs): a request whose
// system prompt holds NODE_INSTRUCTIONS is the node's, answered with a `submit` of `{ title: "Launch" }` and then
// "Done.", each one noted as a line in the file NODE_REQUESTS_ENV names, so a test counts how often the node's model was
// asked. Every other request is the agent's, answered as faux-mcp.mjs answers it. Priced, so each request is booked on
// the run's ledger.
import { appendFileSync } from "node:fs";
import mcp from "./faux-mcp.mjs";

export const NODE_REQUESTS_ENV = "AGENTRUN_TEST_LEARNED_NODE_REQUESTS";
export const NODE_INSTRUCTIONS = "Name the note.";
export const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const messages = context?.messages ?? [];
  const system = `${context?.systemPrompt ?? ""}\n${messages.filter((m) => m.role === "system").map(textOf).join("\n")}`;
  if (!system.includes(NODE_INSTRUCTIONS)) return mcp(context, faux);
  const file = process.env[NODE_REQUESTS_ENV];
  if (file) appendFileSync(file, `${JSON.stringify({ at: Date.now() })}\n`);
  return messages.at(-1)?.role === "toolResult" ? faux.message("Done.") : faux.message(faux.toolCall("submit", { value: { title: "Launch" } }), { stopReason: "toolUse" });
}
