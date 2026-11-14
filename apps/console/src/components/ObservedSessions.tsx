import { ArrowLeft, ArrowUpRight, RadioTower, RefreshCw } from "lucide-react";
import { Banner, Button, Chip } from "@/components/ui";
import type { Client } from "@/lib/client";
import { when } from "@/lib/format";
import { observationHash, observedHarness, observedNumber, observedState, observedTone, type ObservationRead, type ObservedUsage, useObservations } from "@/lib/observations";

/** Native sessions share the existing pages, with their actual source and metadata limits visible. */
export function ObservedSessions({ read, view = "table", query = "", days = 30 }: { read: ObservationRead; view?: "cards" | "table" | "summary"; query?: string; days?: 7 | 30 }) {
  const { data, error, refresh } = read;
  const storageFull = data?.connectors.some((connector) => connector.storage_full);
  if (!data?.sessions.length && !error && !storageFull) return null;
  const sessions = (data?.sessions ?? []).filter((session) => `${session.display_name} ${session.harness} ${session.models.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="space-y-4" aria-label="Observed sessions">
    <div className="flex flex-wrap items-center gap-3">
      <div className="mr-auto"><h2 className="flex items-center gap-2 text-lead font-semibold"><RadioTower className="size-4" aria-hidden />Observed sessions</h2><p className="mt-1 text-small text-muted-foreground">Agents running in their original applications. Activity refreshes every 15 seconds.</p></div>
      <Button size="icon" aria-label="Refresh observed sessions" disabled={read.loading} onClick={refresh}><RefreshCw className="size-4" aria-hidden /></Button>
    </div>
    {storageFull && <Banner tone="warning" title="Telemetry needs attention">A connector has reached its telemetry storage capacity. New reports cannot be accepted until storage becomes available.</Banner>}
    {error && <Banner tone="error">Could not refresh observed sessions: {error}</Banner>}
    {view === "summary" && data && <div className="space-y-4 border bg-card p-4">
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[["Retained sessions", sessions.length], ["Running", sessions.filter((s) => observedState(s) === "Running").length], ["Needs input", sessions.filter((s) => observedState(s) === "Needs input").length], ["Disconnected", sessions.filter((s) => observedState(s) === "Disconnected").length]].map(([label, value]) => <div key={label}><dt className="caps text-label text-muted-foreground">{label}</dt><dd className="mt-2 font-mono text-figure">{value}</dd></div>)}
      </dl>
      <h3 className="text-body font-semibold">Observed token usage · last {days} days</h3>
      {data.usage.status === "unavailable" ? <p className="text-small text-muted-foreground">{data.usage.overflow ? "Combined token totals are too large to display reliably. Open individual sessions for exact counters." : "Token usage has not been reported."}</p> : <><UsageFacts usage={data.usage} /><UsageByModel models={data.usage.models} /><p className="text-small text-muted-foreground">Reported tokens only. Input includes cache reads and writes; cache hit rate is cache reads divided by input. Idle does not mean a task completed.</p></>}
    </div>}
    {view === "summary" && <p className="text-small text-muted-foreground">Session totals cover retained reports, independently of the aggregate range.</p>}
    {!sessions.length ? <p className="text-body text-muted-foreground">No observed session matches.</p> : view === "cards" ? <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{sessions.map((session) => <li key={session.id} className="border p-5 transition-colors hover:border-border-strong">
      <a href={observationHash(session.id)} className="block space-y-3">
        <div className="flex flex-wrap items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-base font-semibold">{session.display_name}</h3><ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden /></div>
        <div className="flex flex-wrap gap-2"><Chip>{observedHarness(session.harness)}</Chip><Chip tone={observedTone(session)}>{observedState(session)}</Chip><Chip tone="muted">Observed</Chip></div>
        <p className="text-small text-muted-foreground">{session.models.join(", ") || "Model not reported"}</p>
        <p className="font-mono text-small text-muted-foreground">Session {session.id.slice(0, 8)} · Last received {when(session.received_at)}</p>
      </a>
    </li>)}</ul> : <div className="overflow-x-auto border"><table className="w-full text-left text-small" aria-label="Observed sessions">
      <thead className="border-b bg-card text-muted-foreground"><tr>{["Activity", "Session", "Harness", "Model", "Tokens · retained", "Last received"].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3 font-semibold">{label}</th>)}</tr></thead>
      <tbody>{sessions.map((session) => <tr key={session.id} className="border-b last:border-b-0 hover:bg-accent"><td className="whitespace-nowrap px-4 py-3"><Chip tone={observedTone(session)}>{observedState(session)}</Chip></td><td className="px-4 py-3"><a href={observationHash(session.id)} className="inline-flex items-center gap-1 underline underline-offset-2">{session.display_name}<ArrowUpRight className="size-3 shrink-0" aria-hidden /></a></td><td className="whitespace-nowrap px-4 py-3">{observedHarness(session.harness)}</td><td className="px-4 py-3">{session.models.join(", ") || "Not reported"}</td><td className="px-4 py-3 font-mono">{session.usage.status === "unavailable" ? "—" : observedNumber(session.usage.total_tokens)}</td><td className="whitespace-nowrap px-4 py-3">{when(session.received_at)}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}

function UsageFacts({ usage }: { usage: Omit<ObservedUsage, "status"> & { status?: string } }) {
  if (usage.status === "unavailable") return <p className="text-small text-muted-foreground">Token usage has not been reported.</p>;
  return <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">{[["Input", observedNumber(usage.input_tokens)], ["Output", observedNumber(usage.output_tokens)], ["Cache writes", observedNumber(usage.cache_write_tokens)], ["Cache reads", observedNumber(usage.cache_read_tokens)], ["Total tokens", observedNumber(usage.total_tokens)], ["Cache hit rate", usage.cache_hit_rate == null ? "—" : `${(usage.cache_hit_rate * 100).toFixed(1)}%`]].map(([label, value]) => <div key={label}><dt className="text-small text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-body">{value}</dd></div>)}</dl>;
}
function UsageByModel({ models }: { models: ({ model: string } & ObservedUsage)[] }) {
  if (!models.length) return null;
  return <div className="overflow-x-auto"><table className="w-full text-right text-small" aria-label="Observed tokens by model"><thead className="border-b text-muted-foreground"><tr>{["Model", "Input", "Output", "Cache writes", "Cache reads"].map((label) => <th key={label} className="whitespace-nowrap py-2 pl-4 font-normal first:pl-0 first:text-left">{label}</th>)}</tr></thead><tbody>{models.map((row) => <tr key={row.model} className="border-b last:border-b-0"><th className="py-2 text-left font-normal">{row.model}</th>{[row.input_tokens, row.output_tokens, row.cache_write_tokens, row.cache_read_tokens].map((value, i) => <td key={i} className="py-2 pl-4 font-mono">{observedNumber(value)}</td>)}</tr>)}</tbody></table></div>;
}

export function ObservedSessionPage({ v2, sessionId, go }: { v2: Client; sessionId: string; go: (hash: string) => void }) {
  const read = useObservations(v2, { sessionId });
  const session = read.data?.sessions.find((s) => s.id === sessionId);
  return <section className="flex min-h-full flex-col" aria-label="Observed session detail">
    <header className="flex min-h-12 flex-wrap items-center gap-2 border-b px-5 py-2"><Button size="icon" variant="ghost" aria-label="Back to agents" onClick={() => go("#/agents")}><ArrowLeft aria-hidden /></Button><RadioTower className="size-4" aria-hidden /><strong className="min-w-0 flex-1 truncate text-body">{session?.display_name ?? "Observed session"}</strong><Button size="icon" aria-label="Refresh session" disabled={read.loading} onClick={read.refresh}><RefreshCw aria-hidden /></Button></header>
    <main className="mx-auto w-full max-w-page space-y-6 p-5 md:p-8">
      {read.error && <Banner tone="error">Could not read this session: {read.error}</Banner>}
      {!session ? <p className="text-body text-muted-foreground">{read.loading ? "Loading observed session…" : read.data ? "This session was not found." : "Observed sessions are unavailable on this server."}</p> : <>
        <div><h1 className="text-2xl font-semibold">{session.display_name}</h1><div className="mt-3 flex flex-wrap gap-2"><Chip tone="muted">Observed</Chip><Chip tone={observedTone(session)}>{observedState(session)}</Chip><Chip>{observedHarness(session.harness)}</Chip></div></div>
        <Banner>Activity and token usage come from the original application. Run, edit and stop remain in that application. This connection observes activity; the backend SDK integration adds self-improvement.</Banner>
        <dl className="grid gap-4 border bg-card p-4 sm:grid-cols-2">{[["Harness", observedHarness(session.harness)], ["Model", session.models.join(", ") || "Not reported"], ["Connection", session.connection_state], ["Last reported activity", session.reported_activity], ["First seen", when(session.created_at)], ["Last received", when(session.received_at)], ["Session", session.id], ["Connector", session.connector_id]].map(([label, value]) => <div key={label}><dt className="text-small text-muted-foreground">{label}</dt><dd className="mt-1 break-all text-body">{value}</dd></div>)}</dl>
        <section className="space-y-4 border bg-card p-4" aria-label="Session token usage"><h2 className="text-lead font-semibold">Reported token usage · retained session</h2><UsageFacts usage={session.usage} /><p className="text-small text-muted-foreground">Session totals cover retained reports. Input includes cache reads and writes. Missing cache counters are shown as a dash. Activity signals do not establish a completed task or its outcome.</p></section>
      </>}
    </main>
  </section>;
}
