// The console's page of a run and of an agent, at `origin`: the address people open (the server's public URL when it has
// one, else the address the request reached it at; server.ts linkOrigin). Every answer that names one takes it from here.
export const runLink = (origin: string, runId: string): string => `${origin}/#/runs/${encodeURIComponent(runId)}`;
// `#/agents/new` is the console's new-agent form, so an agent whose id is "new" gets its Runs tab, as the console's own
// agentHash gives it (apps/console AgentPage.tsx).
export const agentLink = (origin: string, agentId: string): string => `${origin}/#/agents/${encodeURIComponent(agentId)}${agentId === "new" ? "/runs" : ""}`;
