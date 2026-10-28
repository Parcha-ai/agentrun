import { useEffect, useRef, useState } from "react";
import { AgentEditor, type EditorCaps, type Revision } from "@/components/AgentEditor";
import { AgentsList } from "@/components/AgentsList";
import { type Agent, createBody, editBody, saveError } from "@/lib/agentForm";
import { allPages, type Client, ClientError } from "@/lib/client";

const problemOf = (e: unknown) => (e instanceof ClientError ? saveError(e) : { kind: "other" as const, message: e instanceof Error ? e.message : String(e) });

/** The agents on the live server: the list, or the archived ones (`#/agents?archived=true`), every page of them. */
export function AgentsPage({ v2, archived, go }: { v2: Client; archived: boolean; go: (hash: string) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const load = () => {
    // Only the newest request lands: a slower answer for the other view never replaces this one.
    const n = ++asked.current;
    setAgents(null); setError(null);
    allPages((cursor) => v2.listAgents({ archived, cursor }), (p) => p.agents)
      .then((a) => { if (n === asked.current) setAgents(a); })
      .catch((e) => { if (n === asked.current) setError(problemOf(e).message); });
  };
  useEffect(load, [v2, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AgentsList agents={agents} archived={archived} onArchivedChange={(on) => go(on ? "#/agents?archived=true" : "#/agents")} error={error}
      actions={{
        onOpen: (id) => go(`#/agents/${encodeURIComponent(id)}`),
        onNew: () => go("#/agents/new"),
        onRuns: (id) => go(`#/runs?agent=${encodeURIComponent(id)}`),
        onArchive: async (id, archive) => { try { await (archive ? v2.archiveAgent(id) : v2.unarchiveAgent(id)); load(); } catch (e) { setError(problemOf(e).message); } },
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
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const revisionsOf = (id: string) => allPages((cursor) => v2.listRevisions(id, cursor), (p) => p.revisions);
  const load = async () => {
    if (!agentId) return;
    try {
      const [{ agent: a, etag: t }, r] = await Promise.all([v2.getAgent(agentId), revisionsOf(agentId)]);
      setAgent(a); setEtag(t); setRevisions(r); setVersion((n) => n + 1); setNotice(null);
    } catch (e) { setLoadError(problemOf(e).message); }
  };
  useEffect(() => { void load(); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  // An action that does not change the definition (archive, make current) keeps the form: it updates the agent in place.
  const act = async (what: string, run: () => Promise<Agent>) => {
    try {
      const a = await run();
      const t = await v2.getAgent(a.agent_id).then((x) => { setAgent(x.agent); return x.etag; });
      setEtag(t); setNotice(null);
      setRevisions(await revisionsOf(a.agent_id).catch(() => revisions));
    } catch (e) { setNotice(`${what} did not finish: ${problemOf(e).message}`); }
  };
  if (agentId && loadError) return <p className="m-8 border p-4 font-mono text-[13px] text-destructive-text" role="alert">{loadError}</p>;
  if (agentId && !agent) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the agent...</p>;
  return (
    // Keyed on loads only: a save updates the agent in place, so the editor keeps its form and says "Saved".
    <AgentEditor key={`${agent?.agent_id ?? "new"}:${version}`} agent={agent} revisions={revisions} caps={caps} notice={notice} onBack={() => go("#/agents")} onReload={() => void load()}
      onSave={async (fields, note) => {
        let saved;
        try {
          if (!agent) {
            const made = await v2.createAgent(createBody({ name: fields.name ?? "", description: fields.description ?? "", instructions: fields.instructions ?? "", harness: fields.harness ?? "pi", tools: fields.tools ?? [], thinking: fields.thinking, model: fields.model }));
            go(`#/agents/${encodeURIComponent(made.agent_id)}`);
            return null;
          }
          const body = editBody(agent, fields, note);
          if (body.unchanged) return { kind: "other" as const, message: "Nothing to save: the definition is the current revision's, and a note alone makes no new revision." };
          const { unchanged: _u, ...send } = body;
          saved = await v2.updateDefinition(agent.agent_id, send, etag);
        } catch (e) { return problemOf(e); }
        // The revision is committed: a failed history refresh after it does not make the save look failed.
        setAgent(saved.agent); setEtag(saved.etag);
        revisionsOf(saved.agent.agent_id).then(setRevisions).catch(() => setNotice("Saved. The history could not be refreshed; reload to see it."));
        return null;
      }}
      onMakeCurrent={(rev) => { if (agent) void act("Make current", () => v2.setCurrent(agent.agent_id, rev)); }}
      onArchive={(archive) => { if (agent) void act(archive ? "Archive" : "Unarchive", () => (archive ? v2.archiveAgent(agent.agent_id) : v2.unarchiveAgent(agent.agent_id))); }} />
  );
}
