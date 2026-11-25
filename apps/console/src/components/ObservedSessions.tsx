import { goBack } from "@/lib/back";
import { ArrowLeft, Bot, Pencil, Play, RefreshCw } from "lucide-react";
import { Banner, Button, Chip } from "@/components/ui";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { observedAgentPrompt } from "@/lib/codingAgentPrompts";
import { AgentCardFrame, AgentCardLearning } from "@/components/AgentCard";
import { HarnessName } from "@/components/HarnessIcon";
import type { ReactNode } from "react";
import type { Client } from "@/lib/client";
import { when } from "@/lib/format";
import { observationHash, observedHarness, observedNumber, observedState, observedTone, type ObservedSession, type ObservedUsage, useObservations } from "@/lib/observations";
import { pageToolbarClass } from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

/** A connected coding agent shares the agent grid, with only the controls its connection supports. */
export function ConnectedAgentCard({ session }: { session: ObservedSession }) {
  return <AgentCardFrame name={session.display_name} icon={Bot} harness={session.harness} harnessName={observedHarness(session.harness)} href={observationHash(session.id)}
    badges={<Chip tone={observedTone(session)}>{observedState(session)}</Chip>}
    description={session.models.join(", ") || "Model not reported"}
    facts={<><SessionLearning session={session} /><Chip>{session.usage.status === "unavailable" ? "—" : observedNumber(session.usage.total_tokens)} tokens reported</Chip></>}
    actions={<>
      <CodingAgentAction compact compactIcon={<Play className="size-3.5" aria-hidden />} label={`Run ${session.display_name}`} prompt={observedAgentPrompt(location.origin, session, "run")} />
      <CodingAgentAction compact compactIcon={<Pencil className="size-3.5" aria-hidden />} label={`Edit ${session.display_name}`} prompt={observedAgentPrompt(location.origin, session, "edit")} />
    </>}
  >
    {session.project_name && <p className="break-words">Project · {session.project_name}</p>}
    <p className="font-mono">Session {session.external_session_id.slice(-8)}</p>
    <p>Last reported {when(session.received_at)}</p>
  </AgentCardFrame>;
}

function SessionLearning({ session, controls = false }: { session: ObservedSession; controls?: boolean }) {
  const learning = session.learning;
  const state = !learning || (["on", "off"].includes(learning.state) && !learning.agent_id) ? "unknown" : learning.state;
  return <AgentCardLearning controls={controls} state={state} href={learning?.agent_id ? `#/agents/${encodeURIComponent(learning.agent_id)}/learning` : undefined}
    prompt={observedAgentPrompt(location.origin, session, "learning")} reason={learningReason(session)}
    awaitingActivation={learning?.reason === "awaiting_activation"} serverDisabled={learning?.reason === "server_disabled"} />;
}

function learningReason(session: ObservedSession): string | undefined {
  return ({
    source_setup_required: "Set up learning hooks in this agent's source project.",
    source_unknown: "Learning has not been verified for this agent. Check its source project before setting it up.",
    delegated_session: "Delegated sessions do not run the project's learning hooks. Configure learning on the parent coding session.",
    connection_unavailable: "The learning connection is unavailable. Check the source project's connection and hooks.",
    server_disabled: "Learning is disabled on this server. Its owner must enable it before this agent can learn.",
    agent_disabled: "Learning is off for this project. Enable it in the project's Learning settings.",
    awaiting_activation: "Learning is configured, but this session has not reported an activated hook yet. Verify hook trust and start a new prompt in the original coding agent.",
  } as Record<string, string>)[session.learning?.reason ?? ""];
}

function UsageFacts({ usage }: { usage: Omit<ObservedUsage, "status"> & { status?: string } }) {
  if (usage.status === "unavailable") return <p className="text-small text-muted-foreground">Token usage has not been reported.</p>;
  return <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">{[["Input", observedNumber(usage.input_tokens)], ["Output", observedNumber(usage.output_tokens)], ["Cache writes", observedNumber(usage.cache_write_tokens)], ["Cache reads", observedNumber(usage.cache_read_tokens)], ["Total tokens", observedNumber(usage.total_tokens)], ["Cache hit rate", usage.cache_hit_rate == null ? "—" : `${(usage.cache_hit_rate * 100).toFixed(1)}%`]].map(([label, value]) => <div key={label}><dt className="text-small text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-body">{value}</dd></div>)}</dl>;
}
export function ObservedSessionPage({ v2, sessionId, go }: { v2: Client; sessionId: string; go: (hash: string) => void }) {
  const read = useObservations(v2, { sessionId });
  const session = read.data?.sessions.find((s) => s.id === sessionId);
  return <section className="flex min-h-full flex-col roomy:h-full roomy:min-h-0" aria-label="Connected agent detail">
    <header className={cn(pageToolbarClass, "flex-wrap gap-2 px-5")}><Button size="icon" variant="ghost" aria-label="Back" title="Back" onClick={() => goBack("#/agents")}><ArrowLeft aria-hidden /></Button><Bot className="size-4" aria-hidden /><strong className="min-w-0 flex-1 truncate text-body">{session?.display_name ?? "Connected agent"}</strong><Button size="icon" aria-label="Refresh agent" disabled={read.loading} onClick={read.refresh}><RefreshCw aria-hidden /></Button>
      {session && <><CodingAgentAction label="Edit agent" prompt={observedAgentPrompt(location.origin, session, "edit")} /><CodingAgentAction variant="primary" label="Run agent" prompt={observedAgentPrompt(location.origin, session, "run")} /></>}
    </header>
    <div className="roomy:min-h-0 roomy:flex-1 roomy:overflow-auto">
    <main className="mx-auto w-full max-w-page space-y-6 p-5 md:p-8">
      {read.error && <Banner tone="error">Could not read this agent: {read.error}</Banner>}
      {!session ? <p className="text-body text-muted-foreground">{read.loading ? "Loading connected agent…" : read.data ? "This agent was not found." : "Connected agent activity is unavailable on this server."}</p> : <>
        <div><h1 className="text-2xl font-semibold">{session.display_name}</h1><div className="mt-3 flex flex-wrap gap-2"><Chip tone={observedTone(session)}>{observedState(session)}</Chip><Chip>{observedHarness(session.harness)}</Chip></div></div>
        <Banner>Activity and token usage come from the original application. Run and Edit hand off to your coding agent; work and stop controls stay in that application.</Banner>
        {session.learning?.agent_id && <section className="space-y-3 border bg-card p-4" aria-label="Agent controls"><h2 className="text-lead font-semibold">Bring this agent to AgentRun</h2><p className="text-body text-muted-foreground">Sync its setup and move it from the agent’s page. Its source runs and usage stay connected.</p><a href={`#/agents/${encodeURIComponent(session.learning.agent_id)}`} className="text-body underline underline-offset-2">Open agent controls</a></section>}
        <section className="space-y-3 border bg-card p-4" aria-label="Learning for this agent">
          <h2 className="text-lead font-semibold">Learn as you code</h2>
          <p className="text-body text-muted-foreground">Learning settings apply to the source project and coding runtime. Verified hooks record future completed prompts and deliver your saved corrections on later prompts. Workflow learning needs an approved tool connection and is unavailable for this CLI connection.</p>
          <div className="flex flex-wrap items-center gap-2"><SessionLearning session={session} controls /></div>
          {learningReason(session) ? <p className="text-small text-muted-foreground">{learningReason(session)}</p>
            : session.learning?.state === "unsupported" ? <p className="text-small text-muted-foreground">This connection does not support learning. Continue using its original application.</p>
            : session.learning?.state === "unknown" || !session.learning ? <p className="text-small text-muted-foreground">Learning has not been verified for this agent. Check its source project before setting it up.</p> : null}
        </section>
        <dl className="grid gap-4 border bg-card p-4 sm:grid-cols-2">{([["Harness", <HarnessName harness={session.harness} name={observedHarness(session.harness)} />], ["Model", session.models.join(", ") || "Not reported"], ["Project", session.project_name || "Not reported"], ["Connection", session.connection_state], ["Last reported activity", session.reported_activity], ["First seen", when(session.created_at)], ["Last received", when(session.received_at)], ["Session", session.external_session_id], ["Source", session.source_id], ["Connector", session.connector_id], ["Record", session.id]] as [string, ReactNode][]).map(([label, value]) => <div key={label}><dt className="text-small text-muted-foreground">{label}</dt><dd className="mt-1 break-all text-body">{value}</dd></div>)}</dl>
        <section className="space-y-4 border bg-card p-4" aria-label="Session token usage"><h2 className="text-lead font-semibold">Reported token usage · retained session</h2><UsageFacts usage={session.usage} /><p className="text-small text-muted-foreground">Session totals cover retained reports. Input includes cache reads and writes. Missing cache counters are shown as a dash. Activity signals do not establish a completed task or its outcome.</p></section>
      </>}
    </main>
    </div>
  </section>;
}
