// A faux model for the MCP tests: "Call <tool> with <json>" makes one call of that tool, then it answers with what the
// tool said; "Report the MCP credentials" answers the names of the servers whose credential this process was handed; the
// tool gate's resume of an answered call is answered "Resumed: <its result or refusal>".
import { noteRequest } from "./faux-requests.mjs";
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  noteRequest(context);
  // The call's result, once it is in after the last message a person sent: answered from it, whatever follows it, so a
  // later request never makes the call again (mcp-gate's "one call each").
  const asker = context.messages.findLastIndex((m) => m.role === "user");
  const answered = context.messages.slice(asker + 1).findLast((m) => m.role === "toolResult");
  if (answered) return faux.message(`The tool said: ${textOf(answered)}`);
  const asked = textOf(context.messages.findLast((m) => m.role === "user"));
  // The tool gate's resume of a call a person answered: what it says after its first line.
  if (asked.startsWith("[tool approval]")) return faux.message(`Resumed: ${asked.slice(asked.indexOf("\n") + 1)}`);
  // On its first line; what follows (a trigger's payload, a repository named) is the run's own.
  const call = /^Call (\S+) with (\{[^\n]*\})(?:\n|$)/.exec(asked);
  if (call) return faux.message(faux.toolCall(call[1], JSON.parse(call[2])), { stopReason: "toolUse" });
  if (asked === "Report the MCP credentials") {
    return import(new URL("../../dist/secrets.js", import.meta.url).href).then(({ mcpCredentials }) => faux.message(`Held: ${JSON.stringify(Object.keys(mcpCredentials()).sort())}`));
  }
  return faux.message("Answered.");
}
