// The console's page of a run and of an agent, at `origin`: the address people open (the server's public URL when it has
// one, else the address the request reached it at; server.ts linkOrigin). Every answer that names one takes it from here.
export const runLink = (origin: string, runId: string): string => `${origin}/#/runs/${encodeURIComponent(runId)}`;
export const agentLink = (origin: string, agentId: string): string => `${origin}/#/agents/${encodeURIComponent(agentId)}`;
