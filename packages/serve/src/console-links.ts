// The console's page of a run and of an agent, at `origin`: the address people open (the server's public URL when it has
// one, else its own; server.ts consoleOrigin). Every answer that names one takes it from here.
export const runLink = (origin: string, runId: string): string => `${origin}/#/runs/${encodeURIComponent(runId)}`;
export const agentLink = (origin: string, agentId: string): string => `${origin}/#/agents/${encodeURIComponent(agentId)}`;
