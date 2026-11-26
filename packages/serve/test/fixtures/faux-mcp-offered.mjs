// faux-mcp.mjs's model, which also notes the tools each request offers it: one JSON line of their names per request, in
// the file FAUX_MCP_OFFERED names, when a test sets it. A test reads it to see a tool was never offered to the model.
// "Hold until released" (FAUX_MCP_RELEASE, a file not yet there): that request is answered "Released." only once the
// file exists, so a test holds the run's turn open while it sends the run a message; a stopped turn lets it go.
import { appendFileSync } from "node:fs";
import { access } from "node:fs/promises";
import reply from "./faux-mcp.mjs";

export const OFFERED_ENV = "FAUX_MCP_OFFERED";
export const RELEASE_ENV = "FAUX_MCP_RELEASE";
export const HOLD = "Hold until released";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

/** "Released." once `file` exists; an aborted reply as soon as the turn is stopped. */
async function released(faux, file) {
  while (!faux.signal?.aborted) {
    if (await access(file).then(() => true, () => false)) return faux.message("Released.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return faux.message("", { stopReason: "aborted" });
}

export default function offered(context, faux) {
  const file = process.env[OFFERED_ENV];
  // Offered in the request's tools, or added along the way by a system message (pi's toolsAdded).
  const tools = [...(context.tools ?? []), ...(context.messages ?? []).flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []))];
  if (file) appendFileSync(file, `${JSON.stringify([...new Set(tools.map((tool) => tool.name))])}\n`);
  const last = context.messages.at(-1);
  if (process.env[RELEASE_ENV] && last?.role === "user" && textOf(last) === HOLD) return released(faux, process.env[RELEASE_ENV]);
  return reply(context, faux);
}
