// A faux model for the MCP tests: "Call <tool> with <json>" makes one call of that tool, then it answers with what the
// tool said; "Report the MCP credentials" answers the names of the servers whose credential this process was handed; the
// tool gate's resume of an answered call is answered "Resumed: <its result or refusal>".
// A test's hold (FAUX_MCP_HOLD_AFTER_CALL, a file not yet there): the first request that reads a call's result marks the
// file and is never answered, only let go when its runner aborts it, so a test can take the runner away between a call
// that ran and the model's reading of its result. Every later request is answered as usual.
import { existsSync, writeFileSync } from "node:fs";
import { noteRequest } from "./faux-requests.mjs";
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export const HOLD_ENV = "FAUX_MCP_HOLD_AFTER_CALL";

/** The held request: marks `hold` and settles only when `signal` aborts (a runner that goes lets its request go). */
function held(hold, signal) {
  if (!signal) throw new Error(`${HOLD_ENV} needs the request's abort signal`);
  writeFileSync(hold, "");
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true }));
}

export default function reply(context, faux) {
  noteRequest(context);
  // The call's result, once it is in after the last message a person sent: answered from it, whatever follows it, so a
  // later request never makes the call again (mcp-gate's "one call each").
  const asker = context.messages.findLastIndex((m) => m.role === "user");
  const answered = context.messages.slice(asker + 1).findLast((m) => m.role === "toolResult");
  const hold = process.env[HOLD_ENV];
  if (answered && hold && !existsSync(hold)) return held(hold, faux.signal);
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
