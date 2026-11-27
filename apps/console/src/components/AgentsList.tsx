import { cliLearningOf, cliLearningLabel } from "@/lib/cliLearning";
import { ConnectedAgentCard } from "@/components/ObservedSessions";
import type { ObservationRead } from "@/lib/observations";
import { agentInventory } from "@/lib/agentInventory";
import { Archive, ArchiveRestore, Plus, Settings, Bot, Brain, History, Pencil, Play, Search, Workflow } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ListSkeleton } from "@/components/Skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import { Banner } from "@/components/ui/banner";
import { Chip } from "@/components/ui/chip";
import { fieldBoxClass, Input } from "@/components/ui/field";
import { type Agent, harnessLabel, learningOn } from "@/lib/agentForm";
import { AgentCardFrame, AgentCardLearning } from "@/components/AgentCard";
import { agentHarness } from "@/components/HarnessIcon";
import { agentHash } from "@/components/AgentPage";
import { nativeReadinessOf, nativeRuntimeLabel, nativeStateLabel } from "@/lib/native";
import { backendSdkLabel, backendSdkOf } from "@/lib/backendSdk";
import { waitingOf, waitingWords } from "@/lib/learning";
import { cn } from "@/lib/utils";
import { agentKindWords, workflowShape } from "@/lib/workflowDoc";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { newAgentEditorHref } from "@/lib/agentEditorRoute";
import { runsHere } from "@/lib/runHere";
import { editAgentPrompt, runAgentPrompt } from "@/lib/codingAgentPrompts";
import { pageBodyClass, pageClass, pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";

/** `onUnarchive`: an archived card's labeled Unarchive (absent: no button); `unarchiving`, the ids it waits on; `unarchiveProblem`,
 *  why the last one did not finish. */
export type AgentsListActions = { onOpen?: (id: string) => void; onEdit?: (id: string) => void; onNew?: () => void; onRuns?: (id: string) => void; onLearning?: (id: string) => void; onUnarchive?: (id: string) => void; unarchiving?: ReadonlySet<string>; unarchiveProblem?: string | null };

/** The hosted console's agent grid: a search box, the count, and a card per agent (name, kind, harness, what it does,
 *  its revision and runs, and its actions). Archived agents are their own view. */
export function AgentsList({ agents, archived = false, onArchivedChange, actions = {}, error, handoff, observations, learning }: { agents: Agent[] | null; archived?: boolean; onArchivedChange?: (archived: boolean) => void; actions?: AgentsListActions; error?: string | null; handoff?: ReactNode; observations?: ObservationRead; learning?: "on" | "off" | null }) {
  const [q, setQ] = useState("");
  // Source sessions have no archive operation. Their latest report and any linked learning profile share one card.
  const connected = archived ? undefined : observations;
  const { agents: shown, sessions, count } = agentInventory(agents ?? [], connected?.data?.sessions ?? [], { archived, query: q });
  const loading = (!agents && !error) || !!(connected?.loading && !connected.data);
  const incomplete = loading || !!error || !!connected?.error;
  const storageFull = connected?.data?.connectors.some((connector) => connector.storage_full);
  return (
    <section className={pageClass}>
      <header className={cn(pageToolbarClass, "flex-wrap justify-between gap-3 px-5")}>
        <h1 className={pageTitleClass}><Brain className="size-4" aria-hidden />{archived ? "Archived agents" : "Agents"}</h1>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{handoff}{!archived && <a href={newAgentEditorHref()} className={buttonVariants({ size: "sm", variant: "primary" })}><Plus aria-hidden />New agent</a>}</div>
      </header>
      <div data-page-body className={cn(pageBodyClass, "p-5 md:p-6")}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className={cn(fieldBoxClass, "flex h-control-lg min-w-0 flex-1 items-center gap-3 px-3")}>
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {/* On a narrow portrait screen only its first letter fitted: there the magnifier says it, and the name stays. */}
          <Input bare value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents by name or description..." aria-label="Search agents"
            className="h-full flex-1 max-sm:portrait:placeholder:text-transparent" />
        </label>
        <Button size="lg" variant={archived ? "primary" : "outline"} aria-pressed={archived} onClick={() => onArchivedChange?.(!archived)}><Archive aria-hidden /> Archived</Button>
      </div>
      <div className="space-y-4">
      {error && <Banner tone="error">Could not refresh agents: {error}</Banner>}
      {actions.unarchiveProblem && <Banner tone="error">Unarchive did not finish: {actions.unarchiveProblem}</Banner>}
      {connected?.error && <Banner tone="error" actions={<Button size="xs" disabled={connected.loading} onClick={connected.refresh}>Try again</Button>}>Some connected agents could not be refreshed: {connected.error}</Banner>}
      {storageFull && <Banner tone="warning" title="Telemetry needs attention">A connector has reached its telemetry storage capacity. New reports cannot be accepted until storage becomes available.</Banner>}
      {count > 0 && <>
        <p className="font-mono text-small text-muted-foreground" aria-label="Agent count">{count} {count === 1 ? "agent" : "agents"}{incomplete ? " shown" : ""}</p>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label="Agents">
          {shown.map((a) => <AgentCard key={`agent:${a.agent_id}`} agent={a} actions={actions} learning={learning} />)}
          {sessions.map((session) => <ConnectedAgentCard key={`session:${session.id}`} session={session} />)}
        </ul>
      </>}
      {loading && (count ? <p role="status" className="text-small text-muted-foreground">Loading more agents…</p> : <ListSkeleton label="Loading the agents" rows={6} />)}
      {!count && !incomplete && (
          <div className="border px-4 py-16 text-center">
            <p className="font-mono text-body text-muted-foreground">{q ? "No agent matches." : archived ? "No archived agents." : "No agents yet."}</p>
            {!q && !archived && <p className="mt-4 text-lead text-muted-foreground">Create an agent or connect one you already use. You can also <a className="text-primary-text underline underline-offset-4" href="#/templates">start from a template</a>.</p>}
          </div>
      )}
      </div>
      </div>
    </section>
  );
}

function AgentCard({ agent: a, actions, learning }: { agent: Agent; actions: AgentsListActions; learning?: "on" | "off" | null }) {
  const Icon = a.kind === "workflow" ? Workflow : Bot;
  const archived = !!a.archived_at;
  const native = nativeReadinessOf(a);
  const sdk = backendSdkOf(a.definition);
  const cli = cliLearningOf(a.definition);
  const here = runsHere(a);
  // Its learned items that wait for its owner's OK (the list's own read: each agent's `learning.pending`); nothing at 0.
  const waiting = waitingOf(a);
  const supportsLearning = a.kind === "agentic" && learning !== null;
  const learningState = !supportsLearning ? "unsupported" : learning === undefined ? "unknown" : learning === "off" || !learningOn(a.definition.learning) ? "off" : "on";
  const learningReason = a.kind === "workflow" ? "Learning is configured on the agent that produces this workflow."
    : learning === null ? "This server does not support learning." : learning === undefined ? "The server's learning status has not been read yet."
      : learning === "off" ? "Learning is disabled on this server. Its owner must enable it before this agent can learn." : undefined;
  return (
    <AgentCardFrame name={a.definition.name} icon={Icon} harness={agentHarness(a)} archived={archived} onOpen={() => actions.onOpen?.(a.agent_id)}
      harnessName={a.kind === "agentic" ? (cli ? cliLearningLabel(cli.runtime) : sdk ? backendSdkLabel(sdk) : native ? nativeRuntimeLabel(native.runtime) : harnessLabel(a.definition.harness ?? "pi")) : undefined}
      badges={<><Chip>{agentKindWords(a)}</Chip>
        {native && <Chip tone={native.connected && native.state === "ready" ? "success" : "warning"}>{nativeStateLabel(native)}</Chip>}
        {archived && <Chip tone="muted">Archived</Chip>}</>}
      description={a.definition.description || (a.kind === "workflow" ? workflowShape(a.definition.workflow) : "No description.")}
      facts={<>
        <AgentCardLearning state={learningState} serverDisabled={learning === "off"}
          href={supportsLearning && (!archived || learningOn(a.definition.learning)) ? agentHash(a.agent_id, "learning") : undefined} reason={learningReason} />
          <Chip className="shrink-0 whitespace-nowrap">{a.revisions} {a.revisions === 1 ? "revision" : "revisions"}</Chip>
          {a.runs && <Chip className="shrink-0 whitespace-nowrap">{a.runs.count} {a.runs.count === 1 ? "run" : "runs"}{a.runs.live ? ` · ${a.runs.live} live` : ""}</Chip>}
          {waiting > 0 && (
            <Button size="xs" type="button" aria-label={waitingWords(waiting)} onClick={() => actions.onLearning?.(a.agent_id)}
              className="h-5 shrink-0 whitespace-nowrap border-warning/50 bg-warning/10 px-1.5 text-micro text-warning-text hover:bg-warning/20">Learning · {waiting}</Button>
          )}
      </>}
      actions={<>
          {/* An archived agent says how it comes back, by name, first: the Settings icon's Unarchive is easy to miss. */}
          {archived && actions.onUnarchive && <Button size="sm" variant="primary" disabled={actions.unarchiving?.has(a.agent_id)} aria-busy={actions.unarchiving?.has(a.agent_id)} onClick={() => actions.onUnarchive?.(a.agent_id)}><ArchiveRestore aria-hidden />{actions.unarchiving?.has(a.agent_id) ? "Unarchiving…" : "Unarchive"}</Button>}
          {/* An agent this server runs: Run opens its page, where the Run box is, and Edit its settings in the console. */}
          {here ? <>
            <a href={agentHash(a.agent_id)} aria-label={`Run ${a.definition.name}`} title="Run" className={buttonVariants({ size: "icon", variant: "outline" })}><Play className="size-3.5" aria-hidden /></a>
            <a href={agentHash(a.agent_id, "settings")} aria-label={`Edit ${a.definition.name}`} title="Edit" className={buttonVariants({ size: "icon", variant: "outline" })}><Pencil className="size-3.5" aria-hidden /></a>
          </> : <>
            {!archived && <CodingAgentAction compact compactIcon={<Play className="size-3.5" aria-hidden />} label={`Run ${a.definition.name}`} disabled={!!native && (!native.connected || native.state !== "ready" || !native.capabilities.launch)} prompt={runAgentPrompt(location.origin, a.agent_id, sdk, cli?.runtime)} playgroundHref={sdk || cli ? undefined : `#/playground?agent=${encodeURIComponent(a.agent_id)}`} />}
            <CodingAgentAction compact compactIcon={<Pencil className="size-3.5" aria-hidden />} label={`Edit ${a.definition.name}`} prompt={editAgentPrompt(location.origin, a.agent_id, !!native, sdk, cli?.runtime)} playgroundHref={native || sdk || cli ? undefined : `#/playground?operation=edit-agent&agent=${encodeURIComponent(a.agent_id)}`} />
          </>}
          <Button size="sm" className="gap-1 px-2" variant="outline" aria-label={`Runs of ${a.definition.name}`} onClick={() => actions.onRuns?.(a.agent_id)}><History aria-hidden />{a.runs?.count ?? 0}</Button>
          <Button size="icon" variant="outline" aria-label={`Settings for ${a.definition.name}`} title="Settings" onClick={() => actions.onEdit?.(a.agent_id)}><Settings aria-hidden /></Button>
      </>}
    >
      {native && <p className="break-all font-mono">{native.project} · {native.machine_id}</p>}
    </AgentCardFrame>
  );
}
