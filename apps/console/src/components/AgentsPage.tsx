import { useEffect, useState } from "react";
import { AgentEditor, type EditorCaps, type Revision } from "@/components/AgentEditor";
import { AgentsList } from "@/components/AgentsList";
import { type Agent, createBody, editBody, saveError } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";

const problemOf = (e: unknown) => (e instanceof ClientError ? saveError(e) : { kind: "other" as const, message: String(e) });

/** The agents on the live server: the list (and the archived ones), and an agent's editor. */
export function AgentsPage({ v2, caps, go }: { v2: Client; caps: EditorCaps; go: (hash: string) => void }) {
  const [archived, setArchived] = useState(false);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setAgents(null); v2.listAgents({ archived }).then((r) => setAgents(r.agents)).catch((e) => setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e))); };
  useEffect(load, [v2, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AgentsList agents={agents} archived={archived} onArchivedChange={setArchived} error={error}
      actions={{
        onOpen: (id) => go(`#/agents/${encodeURIComponent(id)}`),
        onNew: () => go("#/agents/new"),
        onRuns: (id) => go(`#/runs?agent=${encodeURIComponent(id)}`),
        onArchive: async (id, archive) => { try { await (archive ? v2.archiveAgent(id) : v2.unarchiveAgent(id)); } catch (e) { setError(problemOf(e).message); } load(); },
      }} />
  );
}

/** One agent's editor on the live server. Each save is made on the revision the editor loaded (its ETag as If-Match):
 *  when another save landed first, the server refuses it and the editor shows the conflict. */
export function AgentEditPage({ v2, caps, agentId, go }: { v2: Client; caps: EditorCaps; agentId: string | null; go: (hash: string) => void }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const load = async () => {
    if (!agentId) return;
    try {
      const [{ agent: a, etag: t }, r] = await Promise.all([v2.getAgent(agentId), v2.listRevisions(agentId)]);
      setAgent(a); setEtag(t); setRevisions(r.revisions); setVersion((n) => n + 1);
    } catch (e) { setLoadError(problemOf(e).message); }
  };
  useEffect(() => { void load(); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (agentId && loadError) return <p className="m-8 border p-4 font-mono text-[13px] text-destructive-text" role="alert">{loadError}</p>;
  if (agentId && !agent) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the agent...</p>;
  return (
    // Keyed on loads only: a save updates the agent in place, so the editor keeps its form and says "Saved".
    <AgentEditor key={`${agent?.agent_id ?? "new"}:${version}`} agent={agent} revisions={revisions} caps={caps} onBack={() => go("#/agents")} onReload={() => void load()}
      onSave={async (fields, note) => {
        try {
          if (!agent) {
            const made = await v2.createAgent(createBody({ name: fields.name ?? "", description: fields.description ?? "", instructions: fields.instructions ?? "", harness: fields.harness ?? "pi", tools: fields.tools ?? [] }));
            go(`#/agents/${encodeURIComponent(made.agent_id)}`);
            return null;
          }
          const saved = await v2.updateDefinition(agent.agent_id, editBody(agent, fields, note), etag);
          setAgent(saved.agent); setEtag(saved.etag);
          setRevisions((await v2.listRevisions(agent.agent_id)).revisions);
          return null;
        } catch (e) { return problemOf(e); }
      }}
      onMakeCurrent={async (rev) => { if (agent) { await v2.setCurrent(agent.agent_id, rev); await load(); } }}
      onArchive={async (archive) => { if (agent) { await (archive ? v2.archiveAgent(agent.agent_id) : v2.unarchiveAgent(agent.agent_id)); await load(); } }} />
  );
}
