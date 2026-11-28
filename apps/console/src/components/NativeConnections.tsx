import { agentHash } from "@/components/AgentPage";
import { ArrowLeft, Plug } from "lucide-react";
import { useState } from "react";
import { Banner, Button, Chip, Field, Input, Segmented } from "@/components/ui";
import { pageBodyClass, pageClass, pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { goBack } from "@/lib/back";
import { cn } from "@/lib/utils";
import { RemoteConnections } from "@/components/RemoteConnections";
import { CodingAgentAction, type CodingAgentActionProps } from "@/components/CodingAgentAction";
import { connectExistingAgentsPrompt, enableCliLearningPrompt } from "@/lib/codingAgentPrompts";
import { type Client, problemOf } from "@/lib/client";
import { type NativeTarget, nativeRuntimeLabel, nativeSelectorLabel, nativeStateLabel } from "@/lib/native";

export function ConnectExistingAgents({ variant }: Pick<CodingAgentActionProps, "variant">) {
  return <CodingAgentAction variant={variant} label="Connect your agents" prompt={connectExistingAgentsPrompt(location.origin)} playgroundHref="#/agents/connect" playgroundLabel="Connection setup" />;
}

/** Reads only the server host's explicitly selected project. It never presents browser-local discovery as possible. */
export function NativeConnections({ v2, initialSource = "server" }: { v2: Client; initialSource?: "server" | "remote" | "observe" }) {
  const [source, setSource] = useState<"server" | "remote" | "observe">(initialSource);
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
  // The shared frame of a page under Agents (a connected agent's, New agent): beside the sidebar the bar with the back arrow
  // and the page's name stays in view and the body under it is the box that scrolls; on a phone the page scrolls as a
  // whole, bar and all (pageClass). Each tab's hand-off stays in its own section.
  return <section className={pageClass} aria-label="Connect agent">
    <header className={cn(pageToolbarClass, "gap-2 px-5")}>
      <Button size="icon" variant="ghost" aria-label="Back" title="Back" onClick={() => goBack("#/agents")}><ArrowLeft aria-hidden /></Button>
      <h1 className={pageTitleClass}><Plug className="size-4" aria-hidden />Connect agent</h1>
    </header>
    <div data-page-body className={pageBodyClass}><div className="space-y-6 p-5 md:p-8">
    <p className="max-w-prose text-lead text-muted-foreground">Connect an agent already running, or use an existing native setup for new jobs. Keep its instructions, tools, permissions and sign-in.</p>
    <Banner title="Choose how to connect">Choose this server or another machine to launch jobs from an existing native setup. Choose an existing application for observation or learning while you keep using its CLI. This browser cannot scan your laptop.</Banner>
    <Segmented name="native-source" label="Connection method" value={source} onChange={setSource} options={[{ value: "server", label: "This server", disabled: busy }, { value: "remote", label: "Another machine", disabled: busy }, { value: "observe", label: "Existing application", disabled: busy }]} />
    {source === "observe" ? <><section className="space-y-4 border bg-card p-4" aria-label="Observe an existing application">
      <h2 className="text-lg font-semibold">Observe your existing agent</h2>
      <p className="max-w-prose text-body text-muted-foreground">Connect Claude Code or Codex running locally, in Docker, or on another server. Your application continues to start and control its jobs; AgentRun receives session activity, model and token usage.</p>
      <p className="max-w-prose text-small text-muted-foreground">Observation reports activity without sending conversations or enabling learning.</p>
      <CodingAgentAction label="Connect your agents" prompt={`${connectExistingAgentsPrompt(location.origin)}\n\nI selected observation of an existing application. Preserve its current job trigger and SDK configuration; do not import or launch a replacement agent.`} />
    </section><section className="space-y-4 border bg-card p-4" aria-label="Learn from existing CLI sessions">
      <h2 className="text-lg font-semibold">Learn as you code</h2>
      <p className="max-w-prose text-body text-muted-foreground">Keep starting Codex CLI and Claude Code normally. Capture prompt windows for a selected project and deliver owner corrections on later prompts.</p>
      <p className="max-w-prose text-small text-muted-foreground">Uses your local AgentRun server. No SDK wrapper required. Add and review corrections in the agent’s Learning tab.</p>
      <CodingAgentAction variant="primary" label="Enable learning" prompt={enableCliLearningPrompt(location.origin)} />
    </section></> : source === "remote" ? <RemoteConnections v2={v2} /> : <>
    {/* The hand-off heads its tab's section, at the right of its title, as Another machine's does: under the tabs, never
        on their line (both are inline, and stood touching there). */}
    <section className="space-y-4 border bg-card p-4" aria-label="Discover native setups">
      <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-lg font-semibold">Discover on this server</h2><ConnectExistingAgents /></div>
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
        <p className="text-small text-muted-foreground">Native launch: {target.capabilities.launch ? "supported" : "unavailable"} · Self-improving: {target.capabilities.learning ? "corrections and compile" : "unavailable"} · Learned workflows: not served ·Usage: {target.capabilities.usage ? "supported counters only; dollar cost may be unknown" : "unavailable"}</p>
        {target.issues.length > 0 && <Banner tone="warning"><ul>{target.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></Banner>}
        {connected[index] && <p role="status" className="text-body">Connected. <a href={agentHash(connected[index])} className="underline underline-offset-2">Open connected agent</a></p>}
      </article>)}
      {!!targets.length && <Button variant="solid" size="sm" onClick={() => void connect()} disabled={busy || !selected.some((index) => !connected[index])} aria-busy={busy}>{busy ? "Connecting…" : "Connect selected"}</Button>}
      <p className="text-small text-muted-foreground">Connecting saves a reference and starts no run. Authentication and approval compatibility are checked separately on the connected agent's page.</p>
    </section>}
    </>}
    <p className="text-small text-muted-foreground">Your coding agent can also help import selected history. Past conversations stay historical; they do not become live jobs or AgentRun learning.</p>
    </div></div>
  </section>;
}
