import { useEffect, useRef, useState } from "react";
import { AgentEditor, type EditorCaps, type Revision } from "@/components/AgentEditor";
import { agentHash } from "@/components/AgentPage";
import { AgentsList } from "@/components/AgentsList";
import { CodingAgentHandoff } from "@/components/CodingAgentHandoff";
import { type Agent, createBody, editBody, saveError } from "@/lib/agentForm";
import { allPages, type Capabilities, type Client, ClientError } from "@/lib/client";
import type { ToolChoice, ToolGate } from "@/lib/toolSettings";

const problemOf = (e: unknown) => (e instanceof ClientError ? saveError(e) : { kind: "other" as const, message: e instanceof Error ? e.message : String(e) });

/** The agents on the live server: the list, or the archived ones (`#/agents?archived=true`), every page of them. */
export function AgentsPage({ v2, archived, go, capabilities }: { v2: Client; archived: boolean; go: (hash: string) => void; capabilities?: Capabilities | null }) {
  const permissions = { create: capabilities?.features.agents?.create, update: capabilities?.features.agents?.update, archive: capabilities?.features.archive?.agents, runs: capabilities?.features.runs?.list };
  const mayList = capabilities?.features.agents?.list !== false && (!archived || permissions.archive !== false);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const load = () => {
    if (!mayList) return;
    // Only the newest request lands: a slower answer for the other view never replaces this one.
    const n = ++asked.current;
    setAgents(null); setError(null);
    allPages((cursor) => v2.listAgents({ archived, cursor }), (p) => p.agents)
      .then((a) => { if (n === asked.current) setAgents(a); })
      .catch((e) => { if (n === asked.current) setError(problemOf(e).message); });
  };
  useEffect(load, [v2, archived, mayList]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
    <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4 md:px-8"><h1 className="flex-1 text-xl font-semibold">Agents</h1>{!archived && permissions.create !== false && <CodingAgentHandoff context={{ kind: "create" }} serverUrl={v2.endpoint} label="Build with your coding agent" />}</header>
    {!mayList ? <p role="status" className="p-8 text-[13px] text-muted-foreground">This server does not support {archived ? "archived agents" : "listing agents"}.</p> : <AgentsList agents={agents} archived={archived} permissions={permissions} onArchivedChange={(on) => go(on ? "#/agents?archived=true" : "#/agents")} error={error}
      actions={{
        onOpen: (id) => go(agentHash(id)),
        onEdit: (id) => { if (permissions.update !== false) go(agentHash(id, "edit")); },
        onNew: () => { if (permissions.create !== false) go("#/agents/new"); },
        onRuns: (id) => { if (permissions.runs !== false) go(agentHash(id, "runs")); },
        onArchive: async (id, archive) => { if (permissions.archive === false) return; try { await (archive ? v2.archiveAgent(id) : v2.unarchiveAgent(id)); load(); } catch (e) { setError(problemOf(e).message); } },
      }} />}
    </>
  );
}

/** One agent's editor on the live server. Each save is made on the revision the editor loaded (its ETag as If-Match):
 *  when another save landed first, the server refuses it and the editor shows the conflict. */
export function AgentEditPage({ v2, caps, choices = [], gates = [], focusTool, agentId, go }: { v2: Client; caps: EditorCaps; choices?: ToolChoice[]; gates?: ToolGate[]; focusTool?: string; agentId: string | null; go: (hash: string) => void }) {
  const maySave = (agentId === null ? caps.agents?.create : caps.agents?.update) !== false;
  const mayReadRevisions = caps.agents?.revisions !== false;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // The revision the form was loaded from: an action that finds another current revision reloads the form with it.
  const [formRevision, setFormRevision] = useState<string | null>(null);
  const revisionsOf = (id: string) => mayReadRevisions ? allPages((cursor) => v2.listRevisions(id, cursor), (p) => p.revisions) : Promise.resolve([]);
  const load = async () => {
    if (!agentId || !maySave) return;
    try {
      const [{ agent: a, etag: t }, r] = await Promise.all([v2.getAgent(agentId), revisionsOf(agentId)]);
      setAgent(a); setEtag(t); setRevisions(r); setFormRevision(a.revision); setVersion((n) => n + 1); setNotice(null); setLoadError(null);
    } catch (e) {
      // A reload of an agent already on the page keeps the editor, its form and its Reload: the failure is said beside it.
      if (agent) setNotice(`The agent could not be reloaded: ${problemOf(e).message}`);
      else setLoadError(problemOf(e).message);
    }
  };
  useEffect(() => { void load(); }, [agentId, maySave, mayReadRevisions]); // eslint-disable-line react-hooks/exhaustive-deps
  // An action (archive, make current): its write and the page's refresh after it fail apart, so a committed write never
  // reads as failed. The page shows the write's own answer; the refresh brings the ETag and the history. When the refresh
  // finds another current revision (made current here, or saved in another tab), the form reloads with it, so a later save
  // never puts the old form's fields over it.
  const act = async (what: string, run: () => Promise<Agent>) => {
    let done: Agent;
    try { done = await run(); } catch (e) { setNotice(`${what} did not finish: ${problemOf(e).message}`); return; }
    setAgent(done);
    try {
      const { agent: now, etag: t } = await v2.getAgent(done.agent_id);
      const r = await revisionsOf(done.agent_id).catch(() => revisions);
      setAgent(now); setEtag(t); setRevisions(r);
      if (now.revision !== formRevision) {
        setFormRevision(now.revision); setVersion((n) => n + 1);
        setNotice(what === "Make current" ? null : `${what} done. This agent changed since you opened it: the form now shows its current revision.`);
      } else setNotice(null);
    } catch (e) { setNotice(`${what} done. The page could not be refreshed: ${problemOf(e).message}. Reload to see the current state.`); }
  };
  if (!maySave) return <p role="status" className="p-8 text-[13px] text-muted-foreground">This server does not support {agentId === null ? "creating" : "editing"} agents. <a className="text-primary underline" href={agentId === null ? "#/agents" : agentHash(agentId)}>View agents</a></p>;
  if (agentId && loadError && !agent) return <p className="m-8 border p-4 font-mono text-[13px] text-destructive-text" role="alert">{loadError}</p>;
  if (agentId && !agent) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the agent...</p>;
  return (
    // Keyed on loads only: a save updates the agent in place, so the editor keeps its form and says "Saved".
    <AgentEditor key={`${agent?.agent_id ?? "new"}:${version}`} agent={agent} revisions={revisions} caps={caps} serverUrl={v2.endpoint} providerChoices={choices} permissionGates={gates} {...(focusTool ? { focusTool, step: "tools" as const } : {})} notice={notice} validate={v2.validateWorkflow} onBack={() => go("#/agents")} onReload={() => void load()}
      onSave={async (fields, note) => {
        if (!maySave) return { kind: "other", message: "This server does not support saving this agent." };
        let saved;
        try {
          if (!agent) {
            const made = await v2.createAgent(createBody({ name: fields.name ?? "", description: fields.description ?? "", instructions: fields.instructions ?? "", harness: fields.harness ?? "pi", tools: fields.tools ?? [], tool_settings: fields.tool_settings, thinking: fields.thinking, model: fields.model, place: fields.place, learning: fields.learning, max_cost_usd: fields.max_cost_usd, decisionProvider: caps.decisionProvider, skillFiles: fields.skillFiles }));
            // A new agent lands on its own page; a workflow agent (Decision, Workflow) on its Workflow tab.
            go(agentHash(made.agent_id, made.kind === "workflow" ? "workflow" : undefined));
            return null;
          }
          const body = editBody(agent, fields, note);
          if (body.unchanged) return { kind: "other" as const, message: "Nothing to save: the definition is the current revision's, and a note alone makes no new revision." };
          const { unchanged: _u, ...send } = body;
          saved = await v2.updateDefinition(agent.agent_id, send, etag);
        } catch (e) { return problemOf(e); }
        // The revision is committed: a failed history refresh after it does not make the save look failed.
        setAgent(saved.agent); setEtag(saved.etag); setFormRevision(saved.agent.revision);
        // What its tools resolve to (`tools`) only GET /agents/{id} says: read for the revision just saved.
        v2.getAgent(saved.agent.agent_id).then((r) => setAgent((cur) => (cur && cur.revision === r.agent.revision ? { ...cur, tools: r.agent.tools } : cur))).catch(() => {});
        revisionsOf(saved.agent.agent_id).then(setRevisions).catch(() => setNotice("Saved. The history could not be refreshed; reload to see it."));
        return null;
      }}
      onMakeCurrent={mayReadRevisions && maySave ? (rev) => { if (agent) void act("Make current", () => v2.setCurrent(agent.agent_id, rev)); } : undefined}
      onArchive={caps.archive !== false ? (archive) => { if (agent) void act(archive ? "Archive" : "Unarchive", () => (archive ? v2.archiveAgent(agent.agent_id) : v2.unarchiveAgent(agent.agent_id))); } : undefined} />
  );
}
