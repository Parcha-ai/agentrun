// faux-mcp.mjs's model, which also notes the tools each request offers it: one JSON line of their names per request, in
// the file FAUX_MCP_OFFERED names, when a test sets it. A test reads it to see a tool was never offered to the model.
import { appendFileSync } from "node:fs";
import reply from "./faux-mcp.mjs";

export const OFFERED_ENV = "FAUX_MCP_OFFERED";

export default function offered(context, faux) {
  const file = process.env[OFFERED_ENV];
  if (file) appendFileSync(file, `${JSON.stringify((context.tools ?? []).map((tool) => tool.name))}\n`);
  return reply(context, faux);
}
