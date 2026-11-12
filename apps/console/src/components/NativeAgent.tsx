import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Banner, Button, Chip, Dialog, Switch } from "@/components/ui";
import { type Agent, editBody } from "@/lib/agentForm";
import { type Client, problemOf } from "@/lib/client";
import { nativeRuntimeLabel, nativeSelectorLabel, nativeStateLabel } from "@/lib/native";

type NativeMutations = { busy: boolean; begin: () => boolean; end: () => void };
const NativeMutationContext = createContext<NativeMutations | null>(null);
function useNativeMutations(): NativeMutations {
  const shared = useContext(NativeMutationContext);
  const [busy, setBusy] = useState(false);
  const held = useRef(false);
  return shared ?? { busy, begin: () => { if (held.current) return false; held.current = true; setBusy(true); return true; }, end: () => { held.current = false; setBusy(false); } };
}
/** One latch for native mutations across the overview, the Learning tab and a confirmation dialog. */
export function NativeMutationProvider({ children }: { children: ReactNode }) {
  const mutations = useNativeMutations();
  return <NativeMutationContext.Provider value={mutations}>{children}</NativeMutationContext.Provider>;
}

/** Native runs use notes/skills only. Off stops both seed delivery and new AgentRun learning, preserving saved history. */
export function NativeLearningSwitch({ agent, v2, learning, onAgent }: { agent: Agent; v2: Client; learning?: "on" | "off" | null; onAgent?: (agent: Agent) => void }) {
  const native = agent.definition.native!;
  const mutations = useNativeMutations();
  const on = agent.definition.learning === true || agent.definition.learning === "notes";
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = native.connected && native.state === "ready" && native.capabilities.notes && native.capabilities.skills && native.capabilities.launch;
  const save = async (next: boolean) => {
    if (!mutations.begin()) return;
    setBusy(true); setError(null);
    try {
      if (next) {
        const { native: checked } = await v2.verifyNative(agent.agent_id);
        if (!checked.connected || checked.state !== "ready" || !checked.capabilities.notes || !checked.capabilities.skills) throw new Error(`Native learning is not ready: ${checked.issues.join("; ") || nativeStateLabel(checked)}. Verify the connection and try again.`);
      }
      const { agent: current, etag } = await v2.getAgent(agent.agent_id);
      const { unchanged, ...body } = editBody(current, { learning: next ? "notes" : false }, next ? "Native self-improvement on" : "Native self-improvement off");
      onAgent?.(unchanged ? current : (await v2.updateDefinition(agent.agent_id, body, etag)).agent);
      setConfirm(false);
    } catch (e) { setError(problemOf(e)); }
    finally { setBusy(false); mutations.end(); }
  };
  return <div className="space-y-3">
    <div className="flex items-center gap-3"><h3 id={`native-learning-${agent.agent_id}`} className="min-w-0 flex-1 text-body font-semibold">Self-improving: {on ? "On" : "Off"}</h3><Switch labelledBy={`native-learning-${agent.agent_id}`} checked={on} busy={busy} disabled={mutations.busy || !!agent.archived_at || (!on && (!available || learning !== "on"))} onChange={(next) => next ? setConfirm(true) : void save(false)} /></div>
    <p className="text-small text-muted-foreground">{on ? "On supplies approved notes and skills, then checks proposals after each job. Learned workflows are unavailable." : "Off neither supplies nor creates AgentRun learning. Saved learning stays available. Native memory behavior is unchanged."}</p>
    {learning !== "on" && <Banner tone="warning">{learning === "off" ? "This server has learning turned off." : learning === null ? "This server does not expose learning." : "Checking this server's learning support."}</Banner>}
    {!available && <p className="text-small text-warning-text">Verify a connected native launch with notes and skills support before enabling self-improvement.</p>}
    {error && !confirm && <Banner tone="error">{error}</Banner>}
    <Dialog open={confirm} onClose={() => { if (!busy) { setConfirm(false); setError(null); } }} title="Enable self-improvement?" description="AgentRun reuses the runtime's local sign-in."
      footer={<><Button size="sm" disabled={busy || mutations.busy} onClick={() => { setConfirm(false); setError(null); }}>Cancel</Button><Button size="sm" variant="solid" disabled={busy || mutations.busy} aria-busy={busy} onClick={() => void save(true)}>{busy ? "Enabling…" : "Enable self-improvement"}</Button></>}>
      <p className="text-body">Reflection and grading incur additional native model usage after jobs. Task usage and learning usage are recorded separately; dollar cost may be unknown. Native spend caps are unavailable, so AgentRun cannot promise a dollar limit. Verification checks native authentication and compatibility before the policy is saved; it starts no paid task.</p>
      <p className="mt-3 text-body">Accepted notes and skills become active automatically. Risky proposals wait for owner review in Dojo. Existing tests, a rubric or task feedback can help measure outcomes; passing a grader alone does not prove an improvement.</p>
      {error && <Banner tone="error" className="mt-3">{error}</Banner>}
    </Dialog>
  </div>;
}

export function NativeAgent({ agent, v2, learning, onAgent, onChanged }: { agent: Agent; v2: Client; learning?: "on" | "off" | null; onAgent: (agent: Agent) => void; onChanged: () => Promise<void> }) {
  const native = agent.definition.native!;
  const mutations = useNativeMutations();
  const busy = mutations.busy;
  const [error, setError] = useState<string | null>(null);
  const change = async (kind: "verify" | "disconnect") => {
    if (!mutations.begin()) return;
    setError(null);
    try {
      const { native } = await (kind === "verify" ? v2.verifyNative(agent.agent_id) : v2.disconnectNative(agent.agent_id));
      onAgent({ ...agent, definition: { ...agent.definition, native } });
      await onChanged();
    } catch (e) { setError(problemOf(e)); }
    finally { mutations.end(); }
  };
  return <NativeMutationContext.Provider value={mutations}><section className="space-y-4 border bg-card p-4" aria-label="Native connection">
    <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-body font-semibold">Native connection</h2><Chip tone={native.connected && native.state === "ready" ? "success" : "warning"}>{nativeStateLabel(native)}</Chip></div>
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !native.connected} aria-busy={busy} onClick={() => void change("verify")}>Verify connection</Button><Button size="sm" disabled={busy || !native.connected} onClick={() => void change("disconnect")}>Disconnect</Button></div>
    {error && <Banner tone="error">{error}</Banner>}
    <div className="border-y py-4"><NativeLearningSwitch agent={agent} v2={v2} learning={learning} onAgent={onAgent} /></div>
    {native.issues.length > 0 && <Banner tone="warning">{native.issues[0]}{native.issues.length > 1 && <details className="mt-2"><summary className="cursor-pointer text-small">{native.issues.length - 1} more compatibility {native.issues.length === 2 ? "note" : "notes"}</summary><ul className="mt-2 space-y-2">{native.issues.slice(1).map((issue) => <li key={issue}>{issue}</li>)}</ul></details>}</Banner>}
    <dl className="space-y-3 text-small">{[["Runtime", `${nativeRuntimeLabel(native.runtime)} · ${native.version ?? "Version unknown"}`], ["Project", native.project], ["Selector", nativeSelectorLabel(native.selector)], ["Model", native.model ?? "Native default · unknown until launch"], ["Machine", native.machine_id]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl>
    <details><summary className="cursor-pointer text-small">Skills · {native.skills.length} detected</summary>{native.skills.length ? <ul className="mt-2 space-y-1 text-small">{native.skills.map((skill) => <li key={skill} className="break-all font-mono">{skill}</li>)}</ul> : <p className="mt-2 text-small text-muted-foreground">None detected.</p>}</details>
    <details><summary className="cursor-pointer text-small">MCP servers · {native.mcp_servers.length} configured</summary>{native.mcp_servers.length ? <ul className="mt-2 space-y-1 text-small">{native.mcp_servers.map((server) => <li key={server} className="break-all font-mono">{server}</li>)}</ul> : <p className="mt-2 text-small text-muted-foreground">None configured.</p>}</details>
    <details><summary className="cursor-pointer text-small">Configuration provenance · {native.configuration.length} files</summary><dl className="mt-2 space-y-3 text-small"><div><dt className="text-muted-foreground">Verified</dt><dd className="break-all font-mono">{native.verified_at ?? "Not yet verified"}</dd></div><div><dt className="text-muted-foreground">Fingerprint</dt><dd className="break-all font-mono">{native.fingerprint}</dd></div></dl><ul className="mt-3 space-y-2 text-small">{native.configuration.map((file) => <li key={file.path} className="break-all font-mono">{file.path}<span className="block text-muted-foreground">SHA-256 {file.sha256}</span></li>)}</ul></details>
    <details><summary className="cursor-pointer text-small">Capabilities and source machine</summary><p className="mt-2 text-small text-muted-foreground">Future launches resolve the latest original configuration. Verification checks metadata and authentication separately from a paid run. The source machine's local server must be available; hosted native pairing is unavailable.</p><p className="mt-2 text-small text-muted-foreground">Launch: {native.capabilities.launch ? "supported" : "unavailable"} · Approvals: {native.capabilities.approval} · Usage: {native.capabilities.usage ? "supported counters only; dollar cost may be unknown" : "unavailable"} · Spend caps: unavailable · Learned workflows: unavailable</p></details>
    <p className="text-small text-muted-foreground">Disconnect prevents future native jobs. Original files and run history are preserved.</p>
    {!native.connected && <a href="#/agents/connect" className="block text-small underline underline-offset-2">Reconnect existing agent</a>}
  </section></NativeMutationContext.Provider>;
}
