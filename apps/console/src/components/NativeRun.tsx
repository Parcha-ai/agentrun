import { nativeRuntimeLabel, nativeSelectorLabel, type NativeRunMetadata, type NativeUsage } from "@/lib/native";

/** Native counters are partial. Keep unknown counters and prices unknown, including when another phase is priced. */
export function NativeRun({ native, agentId }: { native: NativeRunMetadata; agentId?: string }) {
  const phases: { label: string; usage: NativeUsage | null }[] = [
    { label: "Task usage", usage: native.usage.task },
    ...(native.usage.reflection.length ? native.usage.reflection.map((usage, index) => ({ label: `Reflection usage · turn ${index + 1}`, usage })) : [{ label: "Reflection usage", usage: null }]),
  ];
  return <section className="space-y-4 border bg-card p-4" aria-label="Native run details">
    <h2 className="text-lg font-semibold">Native run</h2>
    <dl className="grid gap-3 text-small sm:grid-cols-2">{[["Runtime", nativeRuntimeLabel(native.runtime)], ["Project", native.project], ["Selector", nativeSelectorLabel(native.selector)], ["Machine", native.machine_id], ["Native session", native.session_id ?? "Not reported"], ["Model", native.model ?? "Unknown"], ["Configuration fingerprint", native.fingerprint], ["Pinned learning revision", native.learning_revision ?? "None supplied"]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl>
    <div className="overflow-x-auto"><table className="w-full text-left text-small" aria-label="Native usage by phase"><thead><tr>{["Phase", "Uncached input", "Output tokens", "Cache read", "Cache write", "Cost"].map((label) => <th key={label} className="whitespace-nowrap border-b px-2 py-2 font-semibold">{label}</th>)}</tr></thead><tbody>{phases.map(({ label, usage }) => {
      const uncachedInput = native.runtime === "codex" ? usage?.input_tokens == null || usage.cache_read_tokens == null ? null : Math.max(0, usage.input_tokens - usage.cache_read_tokens) : usage?.input_tokens;
      return <tr key={label}><th className="whitespace-nowrap px-2 py-2 font-normal">{label}</th>{[uncachedInput, usage?.output_tokens, usage?.cache_read_tokens, usage?.cache_write_tokens].map((value, index) => <td key={index} className="px-2 py-2 font-mono">{value == null ? "Unknown" : value.toLocaleString("en-US")}</td>)}<td className="px-2 py-2 font-mono">{usage?.cost_usd == null ? "Unknown" : `$${usage.cost_usd.toFixed(2)}`}</td></tr>;
    })}</tbody></table></div>
    <p className="text-small text-muted-foreground">Grading usage belongs to the separate learning run.{agentId && <> <a href={`#/agents/${encodeURIComponent(agentId)}/learning`} className="underline underline-offset-2">Open learning evidence</a>.</>} Unreported native counters and model request totals stay unknown.</p>
  </section>;
}
