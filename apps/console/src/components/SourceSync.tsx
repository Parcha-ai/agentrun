import { useEffect, useRef, useState } from "react";
import { Banner, Button, Chip, ConfirmDialog, Dialog, Field, Input, Picker, Switch } from "@/components/ui";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import type { Agent } from "@/lib/agentForm";
import { type Client, problemOf } from "@/lib/client";
import type { ConnectorEnrollment } from "@/lib/connectors";
import type { SourceSyncStatus } from "@/lib/sourceSync";

const words: Record<SourceSyncStatus["state"], string> = {
  needs_connection: "Sync not connected", paused: "Sync paused", syncing: "Syncing setup…", needs_attention: "Needs attention",
  ready: "Ready to move", moved: "Runs on AgentRun", conflict: "Settings changed in both places",
};

/** One connected agent keeps its page, identity and run history through Move. Polls never overwrite a newer action. */
export function SourceSyncPanel({ agent, v2, onAgent }: { agent: Agent; v2: Client; onAgent: (agent: Agent) => void }) {
  const [status, setStatus] = useState<SourceSyncStatus | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [enrollment, setEnrollment] = useState<ConnectorEnrollment | null>(null);
  const [expired, setExpired] = useState(false);
  const [confirmSource, setConfirmSource] = useState<{ revision: string; snapshot: string } | null>(null);
  const [reviewProject, setReviewProject] = useState<{ run_id: string; entry_id: number }[] | null>(null);
  const epoch = useRef(0), mutation = useRef(false), alive = useRef(true);
  const id = agent.agent_id;
  useEffect(() => {
    alive.current = true;
    let reading = false;
    const refresh = async () => {
      if (reading || mutation.current || !v2.sourceSync) return;
      reading = true; const asked = epoch.current;
      try { const value = await v2.sourceSync(id); if (!Array.isArray(value.blockers) || typeof value.enabled !== "boolean") throw new Error("Source sync status is unavailable."); if (alive.current && asked === epoch.current) { setStatus(value); setError(null); } }
      catch (cause) { if (alive.current && asked === epoch.current) setError(problemOf(cause)); }
      finally { reading = false; }
    };
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); }, timer = setInterval(visible, 15_000);
    window.addEventListener("focus", visible);
    return () => { alive.current = false; epoch.current++; clearInterval(timer); window.removeEventListener("focus", visible); };
  }, [v2, id, agent.revision]);
  useEffect(() => {
    if (!enrollment) return;
    const delay = new Date(enrollment.expires_at).getTime() - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) { setEnrollment(null); setExpired(true); return; }
    const timer = setTimeout(() => { setEnrollment(null); setExpired(true); }, delay);
    return () => clearTimeout(timer);
  }, [enrollment]);
  const change = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true; epoch.current++; setBusy(true); setError(null);
    try { await action(); } catch (cause) { if (alive.current) setError(problemOf(cause)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const move = () => change(async () => {
    const result = await v2.moveToAgentRun(id);
    if (alive.current) { setStatus(result.source); onAgent(result.agent); }
  });
  const enable = () => change(async () => {
    if (status?.state !== "needs_connection") {
      const next = await v2.setSourceSync(id, !status?.enabled); if (alive.current) setStatus(next); return;
    }
    const connection = status.connection ?? agent.definition.native?.remote;
    if (!connection) throw new Error("Connect sync on the source machine using the setup action below.");
    const connectors = (await v2.listConnectors()).connectors, connector = connectors.find(item => item.connector_id === connection.connector_id);
    if (!connector) throw new Error("Reconnect the source machine before enabling sync.");
    const code = await v2.upgradeConnectorSync(connection.connector_id, {
      native_execution: connector.capabilities.native_execution, history_import: connector.capabilities.history_import === true, config_sync: true,
    });
    if (alive.current) { setExpired(false); setEnrollment(code); }
  });
  if (!v2.sourceSync) return null;
  const label = status?.moved ? "Runs on AgentRun" : status ? words[status.state] : "Checking sync…";
  const setup = `Enable default-on configuration sync for the existing AgentRun agent ${JSON.stringify(id)} at ${location.origin}. Keep this agent's identity and history. Use the installed connector's sync-only flow for an existing CLI capture profile; upgrade an existing connector with its owner-issued code in the secure terminal prompt. Do not put credentials in arguments or this conversation. Sync its approved project, instructions, authored skills, tools and settings. Show any required unsupported tool or destination sign-in. Do not launch or move it until I use Move to AgentRun.`;
  return <section className="space-y-3 border bg-card p-4" aria-label="Source sync">
    <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-body font-semibold">{label}</h2>{status?.moved && <Chip tone="success">Durable</Chip>}</div>
    <p className="text-small text-muted-foreground">{status?.moved ? "Your runs, tools and project live on AgentRun. Source updates sync while your connection is on." : "Keep your setup in sync, then move this agent here with its tools, settings and project."}</p>
    {status && status.state !== "needs_connection" && <div className="flex items-center gap-3"><span id={`source-sync-${id}`} className="flex-1 text-body">Keep source in sync</span><Switch labelledBy={`source-sync-${id}`} checked={status.enabled} disabled={busy || !!agent.archived_at} busy={busy} onChange={() => void enable()} /></div>}
    {status?.files !== undefined && <p className="text-small text-muted-foreground">{status.files.toLocaleString()} files · {status.skills ?? 0} skills · {status.tools ?? 0} tool connections</p>}
    {!!status?.blockers.length && <Banner tone="warning"><ul className="space-y-2">{status.blockers.map((item, i) => <li key={`${item.code}-${i}`}>{item.message}</li>)}</ul></Banner>}
    {!!status?.project_issues?.length && <div className="space-y-2"><ul className="space-y-1 text-small">{status.project_issues.map(issue => <li key={`${issue.run_id}-${issue.entry_id}`}><a href={`#/runs/${encodeURIComponent(issue.run_id)}`} className="underline underline-offset-2">Review run {issue.run_id}</a>{issue.status === "pending" ? " · saving project" : issue.status === "conflict" ? " · another version was saved first" : " · project save could not be verified"}</li>)}</ul><Button size="sm" disabled={busy || status.project_issues.some(issue => issue.status === "pending")} onClick={() => setReviewProject(status.project_issues!.map(({ run_id, entry_id }) => ({ run_id, entry_id })))}>Continue with saved project</Button></div>}
    {status?.tool_connections?.filter(tool => !tool.ready).map(tool => <Field key={tool.name} label={`Connection for ${tool.name}`} hint={tool.candidates.length ? "Choose the destination account this agent should use." : "Connect this tool server in Settings, then return here."}>
      {tool.candidates.length > 0 ? <Picker label={`Connection for ${tool.name}`} value="" disabled={busy} placeholder="Choose a connection" options={tool.candidates.map(candidate => ({ value: candidate.name, label: `${candidate.name}${candidate.auth === "none" ? " · no sign-in" : " · saved account"}` }))} onChange={server => { if (server) void change(async () => { const next = await v2.bindSourceTool(id, tool.name, server); if (alive.current) setStatus(next); }); }} /> : <a href="#/settings/mcp" className="text-small underline underline-offset-2">Connect tool server</a>}
    </Field>)}
    {status?.state === "conflict" && <div className="flex flex-wrap justify-end gap-2"><Button size="sm" disabled={busy} onClick={() => void change(async () => { const next = await v2.setSourceSync(id, false); if (alive.current) setStatus(next); })}>Keep AgentRun and pause sync</Button><Button size="sm" disabled={busy || !status.snapshot} onClick={() => setConfirmSource({ revision: agent.revision, snapshot: status.snapshot! })}>Use source version</Button></div>}
    {error && <Banner tone="error">{error}</Banner>}
    {expired && <Banner tone="warning">The connection code expired. Use Enable sync to create a new code.</Banner>}
    {status?.state === "needs_connection" && <div className="flex flex-wrap justify-end gap-2"><CodingAgentAction label="Set up sync" prompt={setup} />{(status.connection || agent.definition.native?.remote) && <Button size="sm" disabled={busy} onClick={() => void enable()}>Enable sync</Button>}</div>}
    {status && !status.moved && status.state !== "needs_connection" && <div className="flex justify-end"><Button variant="primary" size="sm" disabled={busy || status.state !== "ready" || !!agent.archived_at} aria-busy={busy} onClick={() => void move()}>{busy ? "Moving…" : "Move to AgentRun"}</Button></div>}
    {status?.moved && <p className="text-small text-muted-foreground">Use Run and Edit above to work here or change harness. Your original CLI can keep reporting its runs.</p>}
    <ConfirmDialog open={confirmSource !== null} title="Use the source’s files and settings?" confirm="Use source version" busy={busy} onCancel={() => { if (!busy) setConfirmSource(null); }} onConfirm={() => void change(async () => {
      if (!confirmSource) return;
      const result = await v2.resolveSourceSync(id, confirmSource.revision, confirmSource.snapshot);
      if (alive.current) { setConfirmSource(null); setStatus(result.source); onAgent(result.agent); }
    })}>
      <p>Future runs will use this source snapshot. AgentRun’s current files and settings remain in revision history. Finish active runs before applying it.</p>
      {error && <Banner tone="error">{error}</Banner>}
    </ConfirmDialog>
    <ConfirmDialog open={reviewProject !== null} title="Continue without these run changes?" confirm="Use saved project" busy={busy} onCancel={() => { if (!busy) setReviewProject(null); }} onConfirm={() => void change(async () => {
      if (!reviewProject) return;
      const next = await v2.reviewSourceProject(id, reviewProject);
      if (alive.current) { setReviewProject(null); setStatus(next); }
    })}><p>Later runs will use the current saved project. Changes from the listed runs will not be applied. Their files and receipts remain available for recovery.</p>{error && <Banner tone="error">{error}</Banner>}</ConfirmDialog>
    <Dialog open={enrollment !== null} onClose={() => setEnrollment(null)} title="Enable sync on your source machine" description="Use this one-use code in the connector’s secure terminal prompt."
      footer={<Button size="sm" onClick={() => setEnrollment(null)}>Done</Button>}>
      {enrollment && <Field label="Connection code" hint="Expires in ten minutes. Upgrade the existing connector with enable-sync; its agent identities stay the same."><Input value={enrollment.enrollment_token} readOnly autoComplete="off" onFocus={event => event.currentTarget.select()} /></Field>}
      <p className="mt-3 text-body">Sync copies your approved project, instructions, authored skills and supported settings to AgentRun. Native sign-in stays on the source; connect any required destination accounts here.</p>
    </Dialog>
  </section>;
}
