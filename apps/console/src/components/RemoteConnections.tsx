import { useCallback, useEffect, useRef, useState } from "react";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { Banner, Button, Chip, ConfirmDialog, Dialog, Field, Input, useToast } from "@/components/ui";
import { type Client, problemOf } from "@/lib/client";
import type { ConnectorEnrollment, RemoteConnector } from "@/lib/connectors";
import { connectRemoteAgentsPrompt } from "@/lib/codingAgentPrompts";
import { when } from "@/lib/format";
import { nativeRuntimeLabel } from "@/lib/native";

/** A source worker makes outbound connections. The browser never discovers another machine's files. */
export function RemoteConnections({ v2 }: { v2: Client }) {
  const [connectors, setConnectors] = useState<RemoteConnector[] | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [enrollment, setEnrollment] = useState<ConnectorEnrollment | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<RemoteConnector | null>(null);
  const mutation = useRef(false);
  const readingRef = useRef(false);
  const generation = useRef(0);
  const live = useRef(true);
  const toast = useToast();
  const read = useCallback(async () => {
    if (readingRef.current) return;
    readingRef.current = true; setReading(true);
    const asked = generation.current;
    try {
      const result = await v2.listConnectors();
      if (live.current && asked === generation.current) { setConnectors(result.connectors); setError(null); }
    } catch (e) { if (live.current && asked === generation.current) setError(problemOf(e)); }
    finally { readingRef.current = false; if (live.current) setReading(false); }
  }, [v2]);
  useEffect(() => {
    live.current = true;
    // Let StrictMode's setup/cleanup/setup settle before starting the first request.
    queueMicrotask(() => { if (live.current) void read(); });
    const refresh = () => { if (!document.hidden && !mutation.current) void read(); };
    const timer = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { live.current = false; generation.current++; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [read]);
  useEffect(() => {
    if (!enrollment) return;
    const delay = new Date(enrollment.expires_at).getTime() - Date.now();
    if (delay <= 0) { setEnrollment(null); setExpired(true); return; }
    const timer = setTimeout(() => { setEnrollment(null); setExpired(true); }, delay);
    return () => clearTimeout(timer);
  }, [enrollment]);
  const enroll = async () => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setActionError(null); setExpired(false);
    try { const result = await v2.enrollConnector(label); if (live.current) setEnrollment(result); }
    catch (e) { if (live.current) setActionError(problemOf(e)); }
    finally { mutation.current = false; if (live.current) setBusy(false); }
  };
  const revoke = async () => {
    if (mutation.current || !revoking) return;
    mutation.current = true; setBusy(true); setActionError(null); generation.current++;
    try {
      const { connector } = await v2.revokeConnector(revoking.connector_id);
      if (live.current) { setConnectors((current) => current?.map((item) => item.connector_id === connector.connector_id ? connector : item) ?? null); setRevoking(null); }
    } catch (e) { if (live.current) setActionError(problemOf(e)); }
    finally { mutation.current = false; if (live.current) setBusy(false); }
  };
  const copyCode = async () => {
    if (!enrollment) return;
    try { await navigator.clipboard.writeText(enrollment.enrollment_token); toast({ title: "Connection code copied" }); }
    catch { toast({ title: "Select and copy the connection code below", tone: "error" }); }
  };
  return <div className="space-y-6" aria-label="Remote connections">
    <section className="space-y-4 border bg-card p-4" aria-label="Connect another machine">
      <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-lg font-semibold">Connect remote agents</h2><CodingAgentAction label="Connect agent" prompt={connectRemoteAgentsPrompt(location.origin)} /></div>
      <p className="max-w-prose text-body text-muted-foreground">Run the connector on your laptop, VM or container. Choose a Claude Code project or named agent, or a Codex project or profile. AgentRun imports a reference to that setup; its files and native sign-in stay on the source machine.</p>
      <p className="max-w-prose text-body text-muted-foreground">The source worker runs approved jobs and receives accepted learning. Connecting does not import past conversations, start a model task or enable self-improvement.</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start"><div className="min-w-0 flex-1"><Field label="Machine label" hint="Optional. A name you recognize in this console."><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="My development machine" disabled={busy} maxLength={120} /></Field></div><Button size="md" className="self-start sm:mt-6" disabled={busy} aria-busy={busy} onClick={() => void enroll()}>{busy && !revoking ? "Creating code…" : "Create connection code"}</Button></div>
      <p className="text-small text-muted-foreground">Use the code only in the connector's secure terminal prompt. It expires after ten minutes and can pair one machine. The coding-agent prompt contains no credentials.</p>
      {expired && <Banner tone="warning">The connection code expired. Create a new one if you have not connected the machine.</Banner>}
      {actionError && !revoking && <Banner tone="error" title="Connection action failed">{actionError}</Banner>}
    </section>
    <section className="space-y-4" aria-label="Connected remote machines">
      <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-lg font-semibold">Remote machines</h2><Button size="sm" disabled={reading || busy} onClick={() => void read()} aria-busy={reading}>{reading ? "Refreshing…" : "Refresh"}</Button></div>
      {error && <Banner tone="error" title="Remote machines could not be read" actions={<Button size="xs" disabled={reading} onClick={() => void read()}>Try again</Button>}>{error}</Banner>}
      {connectors === null && !error && <p className="text-body text-muted-foreground" role="status">Loading remote machines…</p>}
      {connectors?.length === 0 && <div className="border p-6"><h3 className="text-body font-semibold">No remote machines connected</h3><p className="mt-2 text-body text-muted-foreground">Use your coding agent to connect a source machine. It appears here once the connector has paired.</p></div>}
      {connectors?.map((connector) => <article key={connector.connector_id} className="space-y-4 border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3"><h3 className="mr-auto break-words text-body font-semibold">{connector.label || connector.connector_id}</h3><Chip tone={connector.status === "online" ? "success" : connector.status === "offline" ? "warning" : "plain"}>{connector.status === "online" ? "Online" : connector.status === "offline" ? "Offline" : "Revoked"}</Chip><Button size="sm" disabled={busy || connector.status === "revoked"} onClick={() => { setActionError(null); setRevoking(connector); }}>Revoke access</Button></div>
        <dl className="grid gap-3 text-small sm:grid-cols-2"><div><dt className="text-muted-foreground">Last seen</dt><dd>{connector.last_seen_at ? when(connector.last_seen_at) : "Not yet seen"}</dd></div><div><dt className="text-muted-foreground">Access</dt><dd>{connector.capabilities.native_execution ? "Selected native agents and remote jobs" : "Observation only"}</dd></div></dl>
        {connector.status === "offline" && <Banner tone="warning">The source worker is offline. Start it on the original machine to verify or run its agents. Saved agents and learning are preserved.</Banner>}
        {connector.targets.length > 0 ? <ul className="divide-y border-t">{connector.targets.map((target) => <li key={target.target_id} className="space-y-2 pt-3 [&+li]:mt-3">
          <div className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 break-words text-body font-semibold">{target.name}</span>{target.agent_id ? <a href={`#/agents/${encodeURIComponent(target.agent_id)}`} className="text-small underline underline-offset-2">Open agent</a> : <Chip>Not imported</Chip>}</div>
          <p className="break-words text-small text-muted-foreground">{nativeRuntimeLabel(target.runtime)} · {target.machine_id} · {connector.status === "online" ? target.state === "ready" ? "Ready to run" : target.state === "needs_attention" ? "Needs attention" : "Needs verification" : "Worker unavailable"}</p>
          {target.issues.length > 0 && <p className="text-small text-warning-text">{target.issues.join("; ")}</p>}
        </li>)}</ul> : <p className="text-small text-muted-foreground">No native targets imported. Choose a project or agent with the source connector.</p>}
      </article>)}
      <p className="text-small text-muted-foreground">Refreshes every 15 seconds while this page is visible. Imported agents use the usual Runs and Learning Dojo views.</p>
    </section>
    <Dialog open={enrollment !== null} onClose={() => setEnrollment(null)} title="Connect this machine" description="Enter this code directly in the source connector's secure prompt."
      footer={<><Button size="sm" onClick={() => setEnrollment(null)}>Done</Button><Button size="sm" variant="solid" onClick={() => void copyCode()}>Copy connection code</Button></>}>
      {enrollment && <><Field label="One-use connection code" hint={`Expires ${when(enrollment.expires_at)}. Closing this dialog clears it from the page.`}><Input readOnly value={enrollment.enrollment_token} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} /></Field><p className="mt-3 text-body text-muted-foreground">This grants a scoped connector credential. Keep it out of coding-agent prompts, URLs and source control. After pairing, the connector retains its own credential in its private state directory.</p></>}
    </Dialog>
    <ConfirmDialog open={revoking !== null} title="Revoke this machine's access?" confirm={busy ? "Revoking…" : "Revoke access"} busy={busy} onCancel={() => { setRevoking(null); setActionError(null); }} onConfirm={() => void revoke()}>
      <p>{revoking?.label || "This machine"} will no longer receive work or report activity. Agent definitions, past runs and saved learning stay available. Pair the machine again to restore access.</p>
      {actionError && <Banner tone="error" className="mt-3">{actionError}</Banner>}
    </ConfirmDialog>
  </div>;
}
