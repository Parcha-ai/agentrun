import { agentHash } from "@/components/AgentPage";
import { useState } from "react";
import { Banner, Button, Chip, Field, Input, Segmented } from "@/components/ui";
import { RemoteConnections } from "@/components/RemoteConnections";
import { CodingAgentAction, type CodingAgentActionProps } from "@/components/CodingAgentAction";
import { connectExistingAgentsPrompt } from "@/lib/codingAgentPrompts";
import { type Client, problemOf } from "@/lib/client";
import { type NativeTarget, nativeRuntimeLabel, nativeSelectorLabel, nativeStateLabel } from "@/lib/native";

export function ConnectExistingAgents({ variant }: Pick<CodingAgentActionProps, "variant">) {
  return <CodingAgentAction variant={variant} label="Connect agent" prompt={connectExistingAgentsPrompt(location.origin)} playgroundHref="#/agents/connect" playgroundLabel="Connection setup" />;
}

/** Reads only the server host's explicitly selected project. It never presents browser-local discovery as possible. */
export function NativeConnections({ v2, go, initialSource = "server" }: { v2: Client; go: (hash: string) => void; initialSource?: "server" | "remote" }) {
  const [source, setSource] = useState<"server" | "remote">(initialSource);
  const [project, setProject] = useState("");
  const [targets, setTargets] = useState<NativeTarget[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [connected, setConnected] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discover = async () => {
    setBusy(true); setError(null); setTargets(null); setSelected([]); setConnected({});
    try { setTargets((await v2.discoverNative(project.trim())).targets); }
    catch (e) { setError(problemOf(e)); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      for (const index of selected) {
        if (connected[index]) continue;
        const { project, runtime, selector } = targets![index];
        const result = await v2.connectNative({ project, runtime, selector });
        setConnected((current) => ({ ...current, [index]: result.agent.agent_id }));
      }
    } catch (e) { setError(problemOf(e)); }
    finally { setBusy(false); }
  };
  return <section className="mx-auto max-w-page space-y-6 p-5 md:p-8" aria-label="Connect agent">
    <div className="flex flex-wrap items-center gap-3"><h1 className="mr-auto text-2xl font-semibold">Connect agent</h1><Button size="sm" onClick={() => go("#/agents")}>Back to agents</Button></div>
    <p className="max-w-prose text-lead text-muted-foreground">Connect a native setup for new jobs. Keep its instructions, tools, permissions and sign-in.</p>
    <Banner title="Choose how to connect">Choose this server or another machine to launch jobs from an existing native setup. This browser cannot scan your laptop.</Banner>
    <Segmented name="native-source" label="Connection method" value={source} onChange={setSource} options={[{ value: "server", label: "This server", disabled: busy }, { value: "remote", label: "Another machine", disabled: busy }]} />
    {source === "remote" ? <RemoteConnections v2={v2} /> : <>
    <ConnectExistingAgents />
    <section className="space-y-4 border bg-card p-4" aria-label="Discover native setups">
      <h2 className="text-lg font-semibold">Discover on this server</h2>
      <p className="text-body text-muted-foreground">Read-only discovery checks configuration without launching a model or executing project hooks. No model API key is needed to connect.</p>
      <Field label="Project on server host" hint="Enter the absolute path on the machine running AgentRun."><Input aria-label="Project on server host" value={project} onChange={(event) => { setProject(event.target.value); setTargets(null); }} placeholder="/path/to/project" disabled={busy} /></Field>
      <Button variant={targets ? "outline" : "solid"} size="sm" disabled={busy || !project.trim().startsWith("/")} aria-busy={busy} onClick={() => void discover()}>{busy && !targets ? "Discovering…" : "Discover"}</Button>
    </section>
    {error && <Banner tone="error" title="Connection request failed">{error}</Banner>}
    {targets && <section className="space-y-4" aria-label="Native targets">
      <h2 className="text-lg font-semibold">Choose what to connect</h2>
      {!targets.length && <Banner>No supported native setup was found. Install Claude Code or Codex on this host and check the project path.</Banner>}
      {targets.map((target, index) => <article key={`${target.runtime}:${target.selector.kind}:${target.selector.name ?? ""}`} className="space-y-3 border bg-card p-4">
        <div className="flex flex-wrap items-start gap-3"><label className="flex min-w-0 flex-1 items-start gap-3"><input type="checkbox" className="mt-1 accent-primary" disabled={busy || !!connected[index]} checked={selected.includes(index)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, index] : current.filter((value) => value !== index))} /><span className="min-w-0"><strong className="break-words text-body">{nativeSelectorLabel(target.selector)}</strong><span className="block text-small text-muted-foreground">{nativeRuntimeLabel(target.runtime)} · {target.version ?? "Version unknown"}</span></span></label><Chip tone={target.state === "ready" ? "success" : "warning"}>{nativeStateLabel(target)}</Chip></div>
        <dl className="grid gap-3 text-small sm:grid-cols-2">{[["Project", target.project], ["Machine", target.machine_id], ["Model", target.model ?? "Native default · unknown until launch"], ["Skills", target.skills.join(", ") || "None detected"], ["MCP servers", target.mcp_servers.join(", ") || "None configured"], ["Approval handling", target.capabilities.approval]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl>
        {target.selector.kind === "agent" && <p className="text-small text-muted-foreground">This named agent runs as the main Claude Code session, rather than a delegated subagent.</p>}
        {target.selector.kind === "profile" && <p className="text-small text-muted-foreground">A Codex profile selects native configuration; it is not a custom subagent.</p>}
        <p className="text-small text-muted-foreground">Native launch: {target.capabilities.launch ? "supported" : "unavailable"} · Notes: {target.capabilities.notes ? "supported" : "unavailable"} · Learned skills: {target.capabilities.skills ? "supported" : "unavailable"} · Learned workflows: unavailable · Usage: {target.capabilities.usage ? "supported counters only; dollar cost may be unknown" : "unavailable"}</p>
        {target.issues.length > 0 && <Banner tone="warning"><ul>{target.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></Banner>}
        {connected[index] && <p role="status" className="text-body">Connected. <a href={agentHash(connected[index])} className="underline underline-offset-2">Open connected agent</a></p>}
      </article>)}
      {!!targets.length && <Button variant="solid" size="sm" onClick={() => void connect()} disabled={busy || !selected.some((index) => !connected[index])} aria-busy={busy}>{busy ? "Connecting…" : "Connect selected"}</Button>}
      <p className="text-small text-muted-foreground">Connecting saves a reference and starts no run. Authentication and approval compatibility are checked separately on the connected agent's page.</p>
    </section>}
    </>}
    <p className="text-small text-muted-foreground">Your coding agent can also help import selected history. Past conversations stay historical; they do not become live jobs or AgentRun learning.</p>
  </section>;
}
