import { Brain, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import type { TimelinePage } from "@/lib/v2";

/** One thing a live run waits on now: a model request sent and not answered, or a tool call not returned (the timeline
 *  page's `in_flight`, GRE-4835). */
export type InFlightItem = NonNullable<TimelinePage["in_flight"]>[number];

/** How long since `iso`, as a clock reads it: 0:07, 2:13, 1:04:09. Null for no start. */
export function elapsed(iso: string | null, now: number): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** What an item is, in words: a model request is its model thinking (a tool's own, "for" that tool); a tool call is its tool. */
export const inFlightWords = (f: InFlightItem): string => f.kind === "model" ? `${f.name} thinking${f.for_tool ? ` for ${f.for_tool}` : ""}` : f.name;

/** A run's requests in flight, each with how long it has waited, the clock ticking each second: what a run waits on is
 *  on its page while it waits (a local model reading a long prompt, a slow web fetch), not only once it answers. Nothing
 *  when it waits on nothing. */
export function InFlight({ items, now: given }: { items: readonly InFlightItem[]; now?: number }) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!items.length || given !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [items.length, given]);
  if (!items.length) return null;
  const now = given ?? tick;
  return (
    <section aria-label="Waiting on" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-2 text-small md:px-8" data-in-flight>
      <span className="caps text-label text-muted-foreground">Waiting on</span>
      {items.map((f, i) => {
        const Icon = f.kind === "model" ? Brain : Wrench;
        const since = elapsed(f.started_at, now);
        return (
          <span key={`${f.kind}:${f.tool_use_id ?? f.name}:${i}`} className="inline-flex items-center gap-1.5 font-mono" data-in-flight-item={f.kind}
            title={f.input_tokens_max ? `Sent with up to ${f.input_tokens_max.toLocaleString("en-US")} tokens of input` : undefined}>
            <Icon className="size-3.5 shrink-0 text-primary-text motion-safe:animate-pulse" aria-hidden />
            <span>{inFlightWords(f)}</span>
            {since && <span className="text-muted-foreground">· {since}</span>}
          </span>
        );
      })}
    </section>
  );
}
