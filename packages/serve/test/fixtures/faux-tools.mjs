// A faux model that answers with the tools it was offered, each as {name, description}: the words a run's model reads
// about its tools, from the request the run's process made (its tools, and its system messages' tool changes in order).
export default function reply(context, faux) {
  const tools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  for (const message of context.messages.filter((m) => m.role === "system")) {
    for (const tool of message.toolsRemoved ?? []) tools.delete(typeof tool === "string" ? tool : tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return faux.message(JSON.stringify([...tools.values()].map((tool) => ({ name: tool.name, description: tool.description }))));
}
