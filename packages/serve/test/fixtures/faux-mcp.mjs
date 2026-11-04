// A faux model for the MCP tests: "Call <tool> with <json>" makes one call of that tool, "Calls <json list of [tool,
// args]>" makes those calls at once, then it answers with what the tools said; "Report the MCP credentials" answers the
// names of the servers whose credential this process was handed.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    const results = [];
    for (let i = context.messages.length - 1; context.messages[i]?.role === "toolResult"; i--) results.unshift(textOf(context.messages[i]));
    return faux.message(`The tool said: ${results.join(" | ")}`);
  }
  const asked = textOf(context.messages.findLast((m) => m.role === "user"));
  const call = /^Call (\S+) with (\{.*\})$/s.exec(asked);
  if (call) return faux.message(faux.toolCall(call[1], JSON.parse(call[2])), { stopReason: "toolUse" });
  const many = /^Calls (\[.*\])$/s.exec(asked);
  if (many) return faux.message(JSON.parse(many[1]).map(([tool, args]) => faux.toolCall(tool, args)), { stopReason: "toolUse" });
  if (asked === "Report the MCP credentials") {
    return import(new URL("../../dist/secrets.js", import.meta.url).href).then(({ mcpCredentials }) => faux.message(`Held: ${JSON.stringify(Object.keys(mcpCredentials()).sort())}`));
  }
  return faux.message("Answered.");
}
