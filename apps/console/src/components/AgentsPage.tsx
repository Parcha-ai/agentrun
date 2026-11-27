import { cliLearningOf } from "@/lib/cliLearning";
import { useEffect, useRef, useState } from "react";
import { AgentEditor, type EditorCaps, type EditorProps, type Revision } from "@/components/AgentEditor";
import { agentHash } from "@/components/AgentPage";
import { goBack } from "@/lib/back";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { Banner } from "@/components/ui";
import { backendSdkOf } from "@/lib/backendSdk";
import { editAgentPrompt } from "@/lib/codingAgentPrompts";
import { useObservations } from "@/lib/observations";
import { AgentsList } from "@/components/AgentsList";
import { buttonVariants } from "@/components/ui/button";
import { Plug } from "lucide-react";
import { type Agent, createBody, editBody, saveError } from "@/lib/agentForm";
import { allPages, type Client, ClientError } from "@/lib/client";
import { useMcpServers } from "@/lib/useMcpServers";
import type { ToolChoice, ToolGate } from "@/lib/toolSettings";
import type { ComputerKindView, ToolSettings } from "@/lib/v2";

const problemOf = (e: unknown) => (e instanceof ClientError ? saveError(e) : { kind: "other" as const, message: e instanceof Error ? e.message : String(e) });

/** The agents on the live server: the list, or the archived ones (`#/agents?archived=true`), every page of them. */
export function AgentsPage({ v2, archived, go, learning }: { v2: Client; archived: boolean; go: (hash: string) => void; learning?: "on" | "off" | null }) {
  const observations = useObservations(v2, { active: !archived });
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unarchiving, setUnarchiving] = useState<ReadonlySet<string>>(new Set());
  const [unarchiveProblem, setUnarchiveProblem] = useState<string | null>(null);
  const asked = useRef(0);
  const load = ({ quiet = false } = {}) => {
    // Only the newest request lands: a slower answer for the other view never replaces this one. A quiet read keeps the
    // list on screen until it answers.
    const n = ++asked.current;
    if (!quiet) { setAgents(null); setError(null); setUnarchiveProblem(null); }
    allPages((cursor) => v2.listAgents({ archived, cursor }), (p) => p.agents)
      .then((a) => { if (n === asked.current) { setAgents(a); setError(null); } })
      .catch((e) => { if (n === asked.current) setError(problemOf(e).message); });
  };
  // The view shown now, for a write's answer that lands after the person moved between Active and Archived.
  const shown = useRef({ archived, load });
  shown.current = { archived, load };
  // An archived card's Unarchive: the agent leaves the Archived list once the server says so, and the list shown then is
  // read again, which no read started before the answer replaces. A refusal says why above.
  const unarchive = (id: string) => {
    if (unarchiving.has(id)) return;
    setUnarchiving((s) => new Set(s).add(id)); setUnarchiveProblem(null);
    v2.unarchiveAgent(id)
      .then(() => {
        const now = shown.current;
        if (now.archived) setAgents((list) => list?.filter((a) => a.agent_id !== id) ?? list);
        now.load({ quiet: true });
      })
      .catch((e) => setUnarchiveProblem(problemOf(e).message))
      .finally(() => setUnarchiving((s) => { const next = new Set(s); next.delete(id); return next; }));
  };
  useEffect(() => {
    load();
    const refresh = () => { if (!document.hidden) load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [v2, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AgentsList observations={observations} agents={agents} archived={archived} onArchivedChange={(on) => go(on ? "#/agents?archived=true" : "#/agents")} error={error} learning={learning}
      handoff={<a href="#/agents/connect" className={buttonVariants({ size: "sm" })}><Plug aria-hidden />Connect agent</a>}
      actions={{
        onOpen: (id) => go(agentHash(id)),
        onEdit: (id) => go(agentHash(id, "settings")),
        onNew: () => go("#/agents/new"),
        onRuns: (id) => go(agentHash(id, "runs")),
        onLearning: (id) => go(agentHash(id, "learning")),
        ...(archived ? { onUnarchive: unarchive, unarchiving, unarchiveProblem } : {}),
      }} />
  );
}

/** One agent's editor on the live server. Each save is made on the revision the editor loaded (its ETag as If-Match):
 *  when another save landed first, the server refuses it and the editor shows the conflict. */
export function AgentEditPage({ v2, caps, choices = [], gates = [], focusTool, initialStep, agentId, go, embedded, onAgent, onEditPromptChange, initialInstructions }: { v2: Client; caps: EditorCaps; choices?: ToolChoice[]; gates?: ToolGate[]; focusTool?: string; initialStep?: EditorProps["step"]; embedded?: boolean; onAgent?: (agent: Agent) => void; onEditPromptChange?: EditorProps["onEditPromptChange"]; initialInstructions?: string; agentId: string | null; go: (hash: string) => void }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // The revision the form was loaded from: an action that finds another current revision reloads the form with it.
  const [formRevision, setFormRevision] = useState<string | null>(null);
  const [skillRead, setSkillRead] = useState<{ agentId: string; revision: string; files?: Record<string, string>; error?: string } | null>(null);
  const [skillsRetry, setSkillsRetry] = useState(0);
  // Load the exact form revision: the update API replaces the complete map, including support files.
  useEffect(() => {
    if (!agent || agent.definition.native || backendSdkOf(agent.definition) || cliLearningOf(agent.definition)) return;
    let live = true;
    const key = { agentId: agent.agent_id, revision: agent.revision };
    setSkillRead(previous => previous?.agentId === key.agentId && previous.revision === key.revision && previous.files ? previous : key);
    v2.getRevisionSkills(key.agentId, key.revision).then(result => {
      if (result.revision !== key.revision) throw new Error("The skill files do not match the revision being edited.");
      if (live) setSkillRead({ ...key, files: result.skills });
    }).catch(error => {
      if (live) setSkillRead(previous => ({ ...key, ...(previous?.agentId === key.agentId && previous.revision === key.revision ? previous : {}), error: problemOf(error).message }));
    });
    return () => { live = false; };
  }, [v2, agent?.agent_id, agent?.revision, skillsRetry]); // eslint-disable-line react-hooks/exhaustive-deps
  const skillFiles = skillRead?.agentId === agent?.agent_id && skillRead?.revision === agent?.revision ? skillRead?.files : undefined;
  const skillFilesError = skillRead?.agentId === agent?.agent_id && skillRead?.revision === agent?.revision ? skillRead?.error : undefined;
  // Whether this page is still shown: a save's answer that lands after the person left it moves nowhere.
  const shown = useRef(true);
  // Set in the setup too: StrictMode (main.tsx) sets an effect up, cleans it up and sets it up again.
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  const revisionsOf = (id: string) => allPages((cursor) => v2.listRevisions(id, cursor), (p) => p.revisions);
  const load = async () => {
    if (!agentId) return;
    try {
      const [{ agent: a, etag: t }, r] = await Promise.all([v2.getAgent(agentId), revisionsOf(agentId)]);
      setAgent(a); setEtag(t); setRevisions(r); setFormRevision(a.revision); setVersion((n) => n + 1); setNotice(null); setLoadError(null);
      onAgent?.(a);
    } catch (e) {
      // A reload of an agent already on the page keeps the editor, its form and its Reload: the failure is said beside it.
      if (agent) setNotice(`The agent could not be reloaded: ${problemOf(e).message}`);
      else setLoadError(problemOf(e).message);
    }
  };
  useEffect(() => { void load(); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The server's computers list (GET /v2/computers), for the Computer step's kinds; null until it answers, and on a server
  // that answers none, where the step shows where runs go. Only the newest read lands.
  const [computers, setComputers] = useState<ComputerKindView[] | null>(null);
  const computersAsked = useRef(0);
  useEffect(() => {
    const n = ++computersAsked.current;
    v2.computers().then((r) => { if (n === computersAsked.current) setComputers(r.kinds); }, () => { if (n === computersAsked.current) setComputers(null); });
  }, [v2]);
  // This server's tool settings, for the pins it sets on tools an agent grants: a read that fails says none (the gate holds
  // them whatever this page says).
  const [serverTools, setServerTools] = useState<ToolSettings | undefined>(undefined);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => v2.toolSettings()).then((s) => { if (live) setServerTools(s); }, () => {});
    return () => { live = false; };
  }, [v2]);
  // The saved MCP servers, for the Tools step's MCP groups.
  const [mcpServers, loadMcp] = useMcpServers(v2, !!caps.mcp);
  // An action (archive, make current): its write and the page's refresh after it fail apart, so a committed write never
  // reads as failed. The page shows the write's own answer; the refresh brings the ETag and the history. When the refresh
  // finds another current revision (made current here, or saved in another tab), the form reloads with it, so a later save
  // never puts the old form's fields over it.
  const act = async (what: string, run: () => Promise<Agent>) => {
    let done: Agent;
    try { done = await run(); } catch (e) { setNotice(`${what} did not finish: ${problemOf(e).message}`); return; }
    setAgent(done); onAgent?.(done);
    try {
      const { agent: now, etag: t } = await v2.getAgent(done.agent_id);
      const r = await revisionsOf(done.agent_id).catch(() => revisions);
      setAgent(now); setEtag(t); setRevisions(r); onAgent?.(now);
      if (now.revision !== formRevision) {
        setFormRevision(now.revision); setVersion((n) => n + 1);
        setNotice(what === "Make current" ? null : `${what} done. This agent changed since you opened it: the form now shows its current revision.`);
      } else setNotice(null);
    } catch (e) { setNotice(`${what} done. The page could not be refreshed: ${problemOf(e).message}. Reload to see the current state.`); }
  };
  if (agentId && loadError && !agent) return <p className="m-8 border p-4 font-mono text-body text-destructive-text" role="alert">{loadError}</p>;
  if (agentId && !agent) return <p className="p-8 text-center font-mono text-body text-muted-foreground">Loading the agent...</p>;
  return (
    // Keyed on loads only: a save updates the agent in place, so the editor keeps its form, and its Save reads "Saved".
    agent && (backendSdkOf(agent.definition) || cliLearningOf(agent.definition)) ? <section className="space-y-4 p-5 md:p-8">
      <h1 className="text-2xl font-semibold">Edit {agent.definition.name}</h1>
      <Banner>{cliLearningOf(agent.definition) ? "This agent runs in your CLI. Edit its original project configuration; manage self-improving in its Learning tab." : "This agent runs in your backend. Edit its application code with your coding agent; manage self-improving in its Learning tab."}</Banner>
      <CodingAgentAction label="Edit agent" prompt={editAgentPrompt(location.origin, agent.agent_id, false, backendSdkOf(agent.definition), cliLearningOf(agent.definition)?.runtime)} />
      <a href={agentHash(agent.agent_id)} className="block text-body underline underline-offset-2">Back to agent</a>
    </section> : <AgentEditor skillFiles={skillFiles} skillFilesError={skillFilesError} onRetrySkills={() => setSkillsRetry(n => n + 1)} embedded={embedded} onEditPromptChange={onEditPromptChange} initialInstructions={initialInstructions} key={`${agent?.agent_id ?? "new"}:${version}`} agent={agent} revisions={revisions} caps={{ ...caps, computers }} providerChoices={choices} permissionGates={gates} mcpServers={mcpServers} serverToolSettings={serverTools} onRetryMcp={loadMcp} focusTool={focusTool} step={focusTool ? "tools" : initialStep} notice={notice} validate={v2.validateWorkflow} onBack={() => goBack(agentId ? agentHash(agentId) : "#/agents")} onReload={() => { void load(); loadMcp(); }}
      onSave={async (fields, note) => {
        let saved;
        try {
          if (!agent) {
            const made = await v2.createAgent(createBody({ name: fields.name ?? "", description: fields.description ?? "", instructions: fields.instructions ?? "", harness: fields.harness ?? "pi", tools: fields.tools ?? [], approvals: fields.approvals, tool_settings: fields.tool_settings, thinking: fields.thinking, model: fields.model, computer: fields.computer, learning: fields.learning, max_cost_usd: fields.max_cost_usd, skillFiles: fields.skillFiles, decisionProvider: caps.decisionProvider }));
            // A new agent lands on its own page; a workflow agent (Decision, Workflow) on its Workflow tab.
            // Only while this page is still the one shown: a Create that answers after the person left moves nowhere.
            if (!shown.current) return null;
            go(agentHash(made.agent_id, made.kind === "workflow" ? "workflow" : undefined));
            return null;
          }
          const body = editBody(agent, fields, note, skillFiles);
          if (body.unchanged) return { kind: "other" as const, message: "Nothing to save: the definition is the current revision's, and a note alone makes no new revision." };
          const { unchanged: _u, ...send } = body;
          saved = await v2.updateDefinition(agent.agent_id, send, etag);
        } catch (e) { return problemOf(e); }
        // The revision is committed: a failed history refresh after it does not make the save look failed.
        setAgent(saved.agent); setEtag(saved.etag); setFormRevision(saved.agent.revision);
        const savedSkills = fields.skillFiles ?? skillFiles;
        if (savedSkills) setSkillRead({ agentId: saved.agent.agent_id, revision: saved.agent.revision, files: savedSkills });
        onAgent?.(saved.agent);
        // What its tools resolve to (`tools`) only GET /agents/{id} says: read for the revision just saved.
        v2.getAgent(saved.agent.agent_id).then((r) => setAgent((cur) => (cur && cur.revision === r.agent.revision ? { ...cur, tools: r.agent.tools } : cur))).catch(() => {});
        revisionsOf(saved.agent.agent_id).then(setRevisions).catch(() => setNotice("Saved. The history could not be refreshed; reload to see it."));
        return null;
      }}
      onMakeCurrent={(rev) => { if (agent) void act("Make current", () => v2.setCurrent(agent.agent_id, rev)); }}
      onArchive={(archive) => { if (agent) void act(archive ? "Archive" : "Unarchive", () => (archive ? v2.archiveAgent(agent.agent_id) : v2.unarchiveAgent(agent.agent_id))); }} />
  );
}
