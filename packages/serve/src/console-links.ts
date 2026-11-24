// The console's page of a run and of an agent, at `origin`: the address people open (the server's public URL when it has
// one, else the address the request reached it at; server.ts linkOrigin). Every answer that names one takes it from here.
export const runLink = (origin: string, runId: string): string => `${origin}/#/runs/${encodeURIComponent(runId)}`;
// `#/agents/new` and `#/agents/connect` are setup forms, so agents with either id get their Runs tab, as the console's
// own agentHash gives them (apps/console AgentPage.tsx).
export const agentLink = (origin: string, agentId: string): string => `${origin}/#/agents/${encodeURIComponent(agentId)}${agentId === "new" || agentId === "connect" ? "/runs" : ""}`;
// A template package's apply page; for a package not stored (a dry run), the install page, which shows it whole first.
export const templateLink = (origin: string, id: string): string => `${origin}/#/templates/${encodeURIComponent(id)}`;
export const templateInstallLink = (origin: string, source: string): string => `${origin}/#/templates/install?src=${encodeURIComponent(source)}`;
// The templates page: where an upload's dry run (nothing stored, nothing on GitHub to read again) sends a person.
export const templatesLink = (origin: string): string => `${origin}/#/templates`;
