// A faux model and a faux harness that answer with the tools they were offered, each as {name, description}: the words a
// run's model reads about its tools.
const said = (tools) => JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description })));

/** As a faux model: from the request the run's process made (its tools, and its system messages' tool changes in order). */
export default function reply(context, faux) {
  const tools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  for (const message of context.messages.filter((m) => m.role === "system")) {
    for (const tool of message.toolsRemoved ?? []) tools.delete(typeof tool === "string" ? tool : tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return faux.message(said([...tools.values()]));
}

/** As a faux harness (claude-agent, codex): the host tools its session was handed, the list a real adapter serves its CLI
 *  (claude-agent's tool server lists each with its description; codex's dynamicTools carry it), then the turn ends. */
export const script = (spec) => Array.from({ length: 10 }, () => [{ say: said(spec.tools), usd: 0.001 }, { end: true, usd: 0.001 }]).flat();
