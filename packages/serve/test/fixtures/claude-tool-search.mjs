// A scripted Messages model's step for Claude Code's own tool search. With an MCP server's tools on the run, the CLI
// defers them behind its ToolSearch: a request does not offer one until ToolSearch has found it. A real model searches
// first, so a script that calls an MCP tool does too.

/** The ids of the conversation's ToolSearch calls. */
const searchIds = (request) => new Set(request.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_use" && block.name === "ToolSearch").map((block) => block.id));

/** A request's tool results (`results`, by call id), ToolSearch's own left out. */
export function callResults(request) {
  const searched = searchIds(request);
  return Object.fromEntries(Object.entries(request.results).filter(([id]) => !searched.has(id)));
}

/** `reply`, after one ToolSearch for `query` while ToolSearch is offered and the model has not searched yet. The request
 *  `reply` sees has the search taken out (its call and result, from `messages` and `results`), so a script reads it as if
 *  the tools had been offered from the start: "mcp" finds every MCP tool of the session. */
export function withToolSearch(reply, query = "mcp") {
  return (request) => {
    const searched = searchIds(request);
    if (request.tools.includes("ToolSearch") && searched.size === 0) return { tool: { name: "ToolSearch", input: { query, max_results: 50 } } };
    if (searched.size === 0) return reply(request);
    const kept = (block) => !((block.type === "tool_use" && searched.has(block.id)) || (block.type === "tool_result" && searched.has(block.tool_use_id)));
    const messages = request.messages.map((message) => (Array.isArray(message.content) ? { ...message, content: message.content.filter(kept) } : message)).filter((message) => !Array.isArray(message.content) || message.content.length > 0);
    return reply({ ...request, messages, results: callResults(request) });
  };
}
