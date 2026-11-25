/** A new agent's full editor. The brief stays in the fragment, including across a reload; opening it creates nothing. */
export function newAgentEditorHref(instructions = ""): string {
  const params = new URLSearchParams({ editor: "true" });
  if (instructions) params.set("instructions", instructions);
  return `#/agents/new?${params}`;
}
