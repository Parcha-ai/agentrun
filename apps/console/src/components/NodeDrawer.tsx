import { ChevronRight, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Answer, type Decision, type Effect, type Evidence, itemCounts, itemLabel, itemOutcome, markOf, ms, optionName, type Question, type Rule, type RunGraph, type Selection, usd, verdictOf } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import { at, nodeMeta } from "@/lib/workflowDoc";

type FileUrl = (ref: string) => string;
const CONTAINERS = new Set(["chain", "parallel", "route", "map", "loop", "workflow"]);
const STATE_TONE: Record<string, "success" | "active" | "error" | "warning" | "muted" | "plain"> = { done: "success", working: "active", failed: "error", review: "warning", escalated: "warning", stopped: "muted", "not-run": "muted", pending: "plain" };
const stateWord = (s: string) => (s === "review" ? "needs review" : s.replace("-", " "));

export function StateChip({ state }: { state: string | undefined }) {
  const s = markOf(state) ?? "pending";
  return <Chip tone={STATE_TONE[s] ?? "plain"} className="whitespace-nowrap">{stateWord(s)}</Chip>;
}

export function ProviderChip({ provider }: { provider: string | null | undefined }) {
  if (!provider) return null;
  const v = provider === "parallel" ? "--wf-parallel" : provider === "openrouter" ? "--wf-openrouter" : "--wf-jev";
  return <span className="caps inline-flex h-5 items-center border px-1.5 text-[10px] leading-none" style={{ color: `hsl(var(${v}))`, borderColor: `hsl(var(${v}) / .6)`, background: `hsl(var(${v}) / .12)` }}>{provider}</span>;
}

const TONE_TEXT: Record<string, string> = { good: "text-success-text", warn: "text-warning-text", bad: "text-destructive-text" };
const span = (a?: string | null, b?: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : undefined);

/** The drawer beside the run's graph: what one node, or one map item, did. A decision's verdict card (a bar per answer,
 *  the rule and the action it took), its sources, the images and the state the model saw; a tool call's input and output. */
export function NodeDrawer({ data, selected, onSelect, onClose, fileUrl }: { data: RunGraph; selected: NonNullable<Selection>; onSelect: (s: Selection) => void; onClose: () => void; fileUrl: FileUrl }) {
  const node = data.graph.nodes.find((n) => n.path === selected.path);
  const [zoom, setZoom] = useState<string | null>(null);
  if (!node) return null;
  const run = data.nodes[node.path];
  const meta = nodeMeta(data.workflow, node.path, node as unknown as Record<string, unknown>);
  const mapPath = node.kind === "map" ? node.path : data.graph.nodes.find((n) => n.kind === "map" && node.path.startsWith(`${n.path}/body/`))?.path;
  const item = selected.item != null && mapPath ? data.nodes[mapPath]?.items?.find((x) => x.index === selected.item) : undefined;
  const decisionsHere = data.decisions.filter((d) => d.node === node.path);
  const effectsHere = data.effects.filter((e) => e.node === node.path);
  const inMap = !!mapPath && node.kind !== "map";
  const time = span(run?.startedAt, run?.endedAt);

  return (
    <aside className="flex min-h-0 flex-col bg-background" aria-label="Node details">
      <header className="border-b px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="caps flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              {node.kind}{meta.tool ? ` · ${meta.tool}` : node.via ? ` · ${node.via}` : ""}
              {item && <><ChevronRight className="size-3" aria-hidden /> item {item.index + 1}</>}
            </p>
            <h2 className="mt-1 break-words font-mono text-[17px] font-semibold leading-tight">{item ? itemLabel(data, mapPath!, item.index) ?? `Item ${item.index + 1}` : node.label}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StateChip state={item ? item.status : run?.status} />
              {item && (() => { const o = itemOutcome(data, mapPath!, item); return o.outcome ? <span className="font-mono text-[11px]" title={o.pNote}>outcome <b className={TONE_TEXT[o.tone ?? ""]}>{o.outcome}</b>{o.p !== undefined && <span className="text-muted-foreground"> · {p2(o.p)}</span>}</span> : null; })()}
              {meta.decision && <ProviderChip provider={meta.provider} />}
              {meta.decision && meta.model && <span className="font-mono text-[11px] text-muted-foreground">{meta.model}</span>}
              {run?.branch && <span className="font-mono text-[11px]">took <b>{run.branch}</b></span>}
              {!item && time !== undefined && <span className="font-mono text-[11px] text-muted-foreground">{ms(time)}</span>}
            </div>
          </div>
          <Button size="icon" variant="ghost" aria-label="Close details" onClick={onClose}><X aria-hidden /></Button>
        </div>
        {item && <button type="button" className="caps mt-3 text-[10.5px] text-muted-foreground hover:text-foreground" onClick={() => onSelect({ path: mapPath!, item: null })}>All {data.nodes[mapPath!]?.items?.length} items of {data.graph.nodes.find((n) => n.path === mapPath)?.label}</button>}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-5">
        {item ? <ItemDetail data={data} mapPath={mapPath!} index={item.index} status={item.status} fileUrl={fileUrl} zoom={setZoom} />
          : node.kind === "map" ? <ItemTable data={data} mapPath={node.path} onSelect={onSelect} />
          : inMap && (decisionsHere.length || effectsHere.length) ? <PerItem data={data} path={node.path} mapPath={mapPath!} onSelect={onSelect} />
          : <>
              {node.kind === "parallel" && <Jury data={data} path={node.path} onSelect={onSelect} />}
              {decisionsHere.map((d, k) => <VerdictCard key={d.id ?? k} d={d} fileUrl={fileUrl} zoom={setZoom} />)}
              {effectsHere.map((e, k) => <ToolCard key={k} e={e} fileUrl={fileUrl} zoom={setZoom} />)}
              {!decisionsHere.length && !effectsHere.length && node.kind !== "parallel" && <NoRecord kind={node.kind} status={run?.status} meta={meta} />}
            </>}
        <Definition workflow={data.workflow} path={node.path} kind={node.kind} />
      </div>
      {zoom && <Zoom src={zoom} onClose={() => setZoom(null)} />}
    </aside>
  );
}

function NoRecord({ kind, status, meta }: { kind: string; status?: string; meta: ReturnType<typeof nodeMeta> }) {
  const text = meta.decision
    ? status === "working" ? "Asking now. The verdict shows here when the answer comes back." : "Not asked yet."
    : kind === "code" ? "A code node: a pure transform of the run's state. It calls nothing, so it leaves no record of its own."
    : kind === "route" ? "Routed by a value already in the state: no model was asked."
    : CONTAINERS.has(kind) ? "Its nodes are drawn inside it. Pick one to see what it did." : "Nothing recorded yet.";
  return <p className="border border-dashed px-4 py-3 text-[13px] text-muted-foreground">{text}</p>;
}

/** Every item of a map: its document, state, verdict, cost and time. A row opens the item. */
function ItemTable({ data, mapPath, onSelect }: { data: RunGraph; mapPath: string; onSelect: (s: Selection) => void }) {
  const items = data.nodes[mapPath]?.items ?? [];
  const c = itemCounts(items);
  return (
    <section>
      <div className="mb-3 grid grid-cols-5 border">
        {([["Items", c.total], ["Done", c.done], ["Working", c.working], ["Review", c.review], ["Failed", c.failed]] as const).map(([l, n]) => (
          <div key={l} className="border-r px-3 py-2 last:border-r-0"><p className="caps text-[10px] text-muted-foreground">{l}</p><p className="font-mono text-[18px] font-semibold tabular-nums">{n}</p></div>
        ))}
      </div>
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead><tr className="caps text-left text-[10px] text-muted-foreground"><th className="border-b py-1.5 pr-2 font-normal">#</th><th className="border-b py-1.5 pr-2 font-normal">Item</th><th className="border-b py-1.5 pr-2 font-normal">State</th><th className="border-b py-1.5 pr-2 font-normal">Verdict</th><th className="border-b py-1.5 text-right font-normal">Cost</th></tr></thead>
        <tbody>
          {items.map((it) => {
            const ds = data.decisions.filter((d) => d.item === it.index && !!d.node?.startsWith(`${mapPath}/body`));
            const o = itemOutcome(data, mapPath, it);
            const cost = ds.length ? (ds.some((d) => d.cost_usd === null) ? null : ds.reduce((a, d) => a + (d.cost_usd ?? 0), 0)) : undefined;
            return (
              <tr key={it.index} className="cursor-pointer hover:bg-accent" onClick={() => onSelect({ path: mapPath, item: it.index })}>
                <td className="border-b py-1.5 pr-2 tabular-nums text-muted-foreground">{it.index + 1}</td>
                <td className="max-w-[140px] truncate border-b py-1.5 pr-2" title={itemLabel(data, mapPath, it.index)}>{itemLabel(data, mapPath, it.index) ?? "—"}</td>
                <td className="border-b py-1.5 pr-2"><StateChip state={it.status} /></td>
                <td className="max-w-[150px] truncate whitespace-nowrap border-b py-1.5 pr-2" title={[o.pNote, ...ds.map((d) => verdictOf(d))].filter(Boolean).join(", ")}>
                  {o.outcome ? <><span className={cn("font-semibold", TONE_TEXT[o.tone ?? ""])}>{o.outcome}</span>{o.p !== undefined && <span className="ml-2 tabular-nums text-muted-foreground">{p2(o.p)}</span>}</>
                    : ds.map((d) => verdictOf(d)).filter(Boolean).join(", ") || <span className="text-muted-foreground">—</span>}
                </td>
                <td className="border-b py-1.5 text-right tabular-nums">{cost === undefined ? <span className="text-muted-foreground">—</span> : usd(cost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** One node inside a map, across its items: each item's verdict or call, a row each. */
function PerItem({ data, path, mapPath, onSelect }: { data: RunGraph; path: string; mapPath: string; onSelect: (s: Selection) => void }) {
  const ds = data.decisions.filter((d) => d.node === path);
  const es = data.effects.filter((e) => e.node === path);
  const rows = (data.nodes[mapPath]?.items ?? []).map((it) => ({ it, d: ds.find((x) => x.item === it.index), e: es.find((x) => x.item === it.index) })).filter((r) => r.d || r.e);
  const known = ds.filter((d) => d.cost_usd !== null);
  const timed = ds.filter((d) => d.latency_ms !== null);
  const lat = timed.length ? timed.reduce((a, d) => a + (d.latency_ms ?? 0), 0) / timed.length : undefined;
  return (
    <section>
      {ds.length > 0 && (
        <p className="mb-3 font-mono text-[12px] text-muted-foreground">{ds.length} asked · {usd(known.reduce((a, d) => a + (d.cost_usd ?? 0), 0))}{known.length < ds.length ? ` + ${ds.length - known.length} unknown` : ""} · mean {ms(lat)}</p>
      )}
      <table className="w-full border-collapse font-mono text-[12px]">
        <tbody>
          {rows.map(({ it, d, e }) => (
            <tr key={it.index} className="cursor-pointer hover:bg-accent" onClick={() => onSelect({ path: mapPath, item: it.index })}>
              <td className="border-b py-1.5 pr-2 tabular-nums text-muted-foreground">{it.index + 1}</td>
              <td className="max-w-[150px] truncate border-b py-1.5 pr-2">{itemLabel(data, mapPath, it.index)}</td>
              <td className="border-b py-1.5 pr-2">{d ? verdictOf(d) : e ? <StateChip state={e.status} /> : null}</td>
              <td className="border-b py-1.5 text-right tabular-nums text-muted-foreground">{d ? ms(d.latency_ms) : e ? ms(span(e.startedAt, e.endedAt)) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A parallel node whose branches each answered the same yes/no question: the jurors side by side, their mean and
 *  spread. Nothing for a parallel of other work. */
function Jury({ data, path, onSelect }: { data: RunGraph; path: string; onSelect: (s: Selection) => void }) {
  const prefix = `${path}/branches/`;
  const ds = data.decisions.filter((d) => d.node?.startsWith(prefix) && /^\d+$/.test(d.node.slice(prefix.length)) && d.item === null);
  const ids = new Set(ds.flatMap((d) => Object.keys(d.answers ?? {})));
  const [q] = [...ids];
  const votes = ds.map((d) => ({ d, a: d.answers?.[q] })).filter((v): v is { d: Decision; a: Extract<Answer, { type: "noul" }> } => v.a?.type === "noul");
  if (ids.size !== 1 || votes.length < 2) return <NoRecord kind="parallel" meta={{ decision: false }} />;
  const ps = votes.map((v) => v.a.noul);
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const spread = Math.max(...ps) - Math.min(...ps);
  const label = (d: Decision) => data.graph.nodes.find((n) => n.path === d.node)?.label ?? d.node;
  return (
    <section className="border bg-card">
      <header className="border-b px-4 py-2.5">
        <p className="caps text-[10px] text-muted-foreground">Jury · {votes.length} models · {q}</p>
        <p className="mt-1 text-[13px] leading-snug">{(ds[0].questions?.[q] as { instructions?: string } | undefined)?.instructions ?? q}</p>
      </header>
      <ul className="divide-y">
        {votes.map(({ d, a }) => (
          <li key={d.id ?? d.executionPath}>
            <button type="button" className="flex w-full items-center gap-3 px-4 py-2 text-left font-mono text-[12px] hover:bg-accent" onClick={() => onSelect({ path: d.node!, item: null })}>
              <span className="w-[92px] shrink-0"><ProviderChip provider={d.provider} /></span>
              <span className="w-[132px] shrink-0 truncate" title={d.model ?? ""}>{d.model ?? label(d)}</span>
              <Bar p={a.noul} strong tick={0.5} tone={a.noul >= 0.5 ? "fg" : "muted"} />
              <span className="w-10 text-right tabular-nums">{p2(a.noul)}</span>
            </button>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-3 border-t font-mono text-[12px]">
        <div className="border-r px-4 py-2"><dt className="caps text-[10px] text-muted-foreground">Mean P(yes)</dt><dd className="font-semibold tabular-nums">{p2(mean)}</dd></div>
        <div className="border-r px-4 py-2"><dt className="caps text-[10px] text-muted-foreground">Spread</dt><dd className={cn("font-semibold tabular-nums", spread > 0.3 && "text-warning-text")}>{p2(spread)}</dd></div>
        <div className="px-4 py-2"><dt className="caps text-[10px] text-muted-foreground">Cost</dt><dd className="tabular-nums">{usd(votes.some((v) => v.d.cost_usd === null) ? null : votes.reduce((a, v) => a + (v.d.cost_usd ?? 0), 0))}</dd></div>
      </dl>
    </section>
  );
}

/** One map item: each node of the map's body in order, with what it did for this item. */
function ItemDetail({ data, mapPath, index, status, fileUrl, zoom }: { data: RunGraph; mapPath: string; index: number; status: string; fileUrl: FileUrl; zoom: (src: string) => void }) {
  // Every body node with a record for this item: a leaf, or a container that decides (a judged route).
  const body = data.graph.nodes.filter((n) => n.path.startsWith(`${mapPath}/body`));
  const records = body.map((n) => ({ n, ds: data.decisions.filter((d) => d.node === n.path && d.item === index), es: data.effects.filter((e) => e.node === n.path && e.item === index) }))
    .filter((r) => !CONTAINERS.has(r.n.kind) || r.ds.length || r.es.length);
  if (status === "pending") return <p className="border border-dashed px-4 py-3 text-[13px] text-muted-foreground">Not started: this item waits for a free slot in the map.</p>;
  return (
    <div className="space-y-5">
      {records.map(({ n, ds, es }) => (ds.length || es.length) ? (
        <div key={n.path} className="space-y-3">
          <p className="caps text-[10.5px] text-muted-foreground">{n.label}</p>
          {es.map((e, k) => <ToolCard key={k} e={e} fileUrl={fileUrl} zoom={zoom} compact />)}
          {ds.map((d, k) => <VerdictCard key={d.id ?? k} d={d} fileUrl={fileUrl} zoom={zoom} />)}
        </div>
      ) : null)}
      {status === "working" && !records.some((r) => r.ds.length) && <p className="border border-dashed px-4 py-3 text-[13px] text-muted-foreground">In flight: the verdict shows here when it comes back.</p>}
    </div>
  );
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const p2 = (p: number) => p.toFixed(2);

function Bar({ p, strong, tick, tone = "fg" }: { p: number; strong?: boolean; tick?: number; tone?: "fg" | "success" | "warning" | "muted" }) {
  const fill = { fg: "bg-foreground", success: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground/50" }[tone];
  return (
    <span className="relative block h-2 flex-1 bg-muted">
      <span className={cn("absolute inset-y-0 left-0 transition-[width] duration-500", strong ? fill : "bg-muted-foreground/45")} style={{ width: pct(Math.max(0, Math.min(1, p))) }} />
      {tick !== undefined && <span className="absolute -inset-y-1 w-px bg-primary" style={{ left: pct(tick) }} title={`threshold ${p2(tick)}`} />}
    </span>
  );
}

/** One question and its answer: a bar per option (or P(yes) for a yes/no), the chosen one strong. */
function AnswerRows({ id, q, a, rule }: { id: string; q?: Question; a?: Answer; rule: Rule | null }) {
  // A pick numbers its options: each one's own text names it.
  const named = (opt: string) => (rule?.kind === "pick" && q?.type === "choice" && typeof q.criteria?.[opt] === "string" ? q.criteria[opt]! : opt);
  const text = q?.instructions ?? id;
  const unsure = rule?.kind === "route" ? rule.unsure : null;
  return (
    <div className="py-2.5">
      <p className="mb-2 text-[13px] leading-snug"><span className="mr-2 font-mono text-[11px] text-muted-foreground">{id}</span>{text}</p>
      {!a ? <p className="font-mono text-[12px] text-muted-foreground">No answer.</p>
        : a.type === "refusal" ? <p className="font-mono text-[12px] text-warning-text">Refused to answer.</p>
        : a.type === "noul" ? (
          <div className="flex items-center gap-3 font-mono text-[12px]">
            <span className={cn("w-8 font-semibold", a.noul >= 0.5 ? "text-foreground" : "text-muted-foreground")}>{a.noul >= 0.5 ? "YES" : "NO"}</span>
            <Bar p={a.noul} strong tick={0.5} tone={a.noul >= 0.5 ? "fg" : "muted"} />
            <span className="w-24 text-right tabular-nums text-muted-foreground">P(yes) {p2(a.noul)}</span>
          </div>
        ) : a.type === "box" ? <p className="font-mono text-[12px]">box {JSON.stringify(a.box)}</p>
        : (
          <div className="space-y-1.5">
            {Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, rule?.kind === "pick" ? 5 : undefined).map(([opt, p]) => {
              const chosen = (a.type === "choice" ? a.choice : String(a.score)) === opt;
              return (
                <div key={opt} className="flex items-center gap-3 font-mono text-[12px]">
                  <span className={cn("truncate", rule?.kind === "pick" ? "w-48" : "w-28", chosen ? "font-semibold" : "text-muted-foreground")} title={named(opt)}>{a.type === "score" ? `${opt} ${a.legend[opt] ?? ""}` : named(opt)}</span>
                  <Bar p={p} strong={chosen} tick={chosen && unsure ? unsure.gte : undefined} />
                  <span className="w-12 text-right tabular-nums text-muted-foreground">{p2(p)}</span>
                </div>
              );
            })}
            {rule?.kind === "pick" && Object.keys(a.probabilities).length > 5 && <p className="font-mono text-[11px] text-muted-foreground">{Object.keys(a.probabilities).length - 5} more options, each less likely</p>}
          </div>
        )}
    </div>
  );
}

function ruleText(rule: Rule | null): string {
  if (!rule) return "No rule applied: nothing came back to decide on.";
  switch (rule.kind) {
    case "judge": return "Each answer is decoded on its own: a yes/no is yes at P(yes) ≥ 0.50, a choice is its top option.";
    case "route": return rule.unsure ? `Take the chosen branch; below ${p2(rule.unsure.gte)} confidence take "${rule.unsure.branch}".` : "Take the chosen branch.";
    case "pick": return `Pick one of ${rule.options.length} options${rule.none ? `, or "${rule.none}"` : ""}.`;
    case "ask": return `Holds when P(yes) ≥ ${p2(rule.gte)}.`;
    case "sift": return rule.keep ? `Keep an item when its ${rule.keep.id} ${rule.keep.measure} ≥ ${p2(rule.keep.gte)}.` : "Keep every item.";
    case "verify": return "A yes/no fails below its threshold.";
  }
}

function actionText(d: Decision): string {
  const a = d.action as Record<string, unknown> | null;
  if (a == null) return d.status === "cancelled" ? "None: the outcome is unknown, so it goes to review and is not asked again." : "None.";
  if (d.rule?.kind === "route") {
    const conf = d.answers?.branch?.type === "choice" ? d.answers.branch.confidence : undefined;
    return a.unsure ? `Took "${String(a.taken)}": "${String(a.branch)}" at ${conf !== undefined ? p2(conf) : "?"} is below the threshold.` : `Took "${String(a.taken ?? a.branch)}".`;
  }
  if (d.rule?.kind === "pick" && typeof a.index === "number") {
    const opt = d.rule.options[a.index];
    return a.none ? `None of the options: "${d.rule.none ?? "none"}".` : `Picked ${opt !== undefined ? `"${optionName(d, Object.keys(d.questions ?? {})[0] ?? "pick", opt)}"` : `option ${a.index}`}.`;
  }
  if (typeof a === "object") return Object.entries(a).map(([k, v]) => `${k} = ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ");
  return String(a);
}

/** A decision's receipt as a card: who answered, at what cost and speed, each answer, the rule and what it decided. */
export function VerdictCard({ d, fileUrl, zoom }: { d: Decision; fileUrl: FileUrl; zoom: (src: string) => void }) {
  const ids = Array.from(new Set([...Object.keys(d.questions ?? {}), ...Object.keys(d.answers ?? {})]));
  const tone = d.status === "answered" ? "success" : d.status === "cancelled" ? "warning" : "error";
  return (
    <section className="border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <ProviderChip provider={d.provider} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{d.model ?? "default model"}</span>
        <Chip tone={tone}>{d.status === "cancelled" ? "outcome unknown" : d.status}</Chip>
      </header>
      <dl className="grid grid-cols-[minmax(0,1fr)_100px_92px] border-b font-mono text-[12px]">
        <div className="border-r px-4 py-2"><dt className="caps text-[10px] text-muted-foreground">{Object.keys(d.answers ?? {}).length > 1 && d.rule?.kind !== "route" ? "Least sure answer" : "Verdict"}</dt><dd className="break-words font-semibold">{verdictOf(d) ?? "—"}</dd></div>
        <div className="border-r px-4 py-2"><dt className="caps text-[10px] text-muted-foreground">Cost</dt><dd className="tabular-nums" title={d.cost_basis ?? undefined}>{usd(d.cost_usd)}</dd></div>
        <div className="px-4 py-2"><dt className="caps text-[10px] text-muted-foreground">Latency</dt><dd className="tabular-nums">{ms(d.latency_ms)}</dd></div>
      </dl>
      {d.error && <p className={cn("border-b px-4 py-2.5 font-mono text-[12px]", d.status === "cancelled" ? "text-warning-text" : "text-destructive-text")}>{d.error}</p>}
      {!!d.images?.length && (
        <div className="space-y-3 border-b px-4 py-3">
          {d.images.filter((img) => img.ref || img.url).map((img) => (
            <figure key={img.token} className="flex gap-3">
              <button type="button" className="block shrink-0 border bg-white hover:border-foreground" onClick={() => zoom((img.ref && fileUrl(img.ref)) || img.url || "")} aria-label={`Open ${img.ref}`}>
                <img src={(img.ref && fileUrl(img.ref)) || img.url || undefined} alt={`The page the model saw as ${img.token}`} className="block h-[155px] w-[120px] object-cover object-top" loading="lazy" />
              </button>
              <figcaption className="min-w-0 flex-1 space-y-1.5 font-mono text-[11px]">
                <p className="caps text-[10px] text-muted-foreground">What the model saw</p>
                <p><span className="text-muted-foreground">token </span>{img.token}</p>
                <p className="break-all"><span className="text-muted-foreground">page </span>{img.ref}</p>
                {img.sha256 && <p className="break-all" title={img.sha256}><span className="text-muted-foreground">sha256 </span>{img.sha256.slice(0, 16)}…</p>}
                {(img.mime || img.bytes) && <p className="text-muted-foreground">{[img.mime, img.bytes ? `${Math.round(img.bytes / 1024)} KB` : null].filter(Boolean).join(" · ")}</p>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="divide-y px-4">{ids.map((id) => <AnswerRows key={id} id={id} q={d.questions?.[id]} a={d.answers?.[id]} rule={d.rule} />)}</div>
      <dl className="space-y-2 border-t px-4 py-3 text-[12.5px]">
        <div className="flex gap-3"><dt className="caps w-14 shrink-0 pt-0.5 text-[10px] text-muted-foreground">Rule</dt><dd>{ruleText(d.rule)}</dd></div>
        <div className="flex gap-3"><dt className="caps w-14 shrink-0 pt-0.5 text-[10px] text-muted-foreground">Action</dt><dd className="font-mono text-[12px]">{actionText(d)}</dd></div>
      </dl>
      {!!d.evidence?.length && <Citations evidence={d.evidence} />}
      {d.state != null && (
        <details className="group border-t">
          <summary className="caps flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[10.5px] text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden /> What the model saw{d.state_truncated ? " (cut at 64 KB)" : ""}
          </summary>
          <Pre value={d.state} />
        </details>
      )}
    </section>
  );
}

function Citations({ evidence }: { evidence: Evidence[] }) {
  return (
    <section className="border-t px-4 py-3">
      <p className="caps mb-2 text-[10px] text-muted-foreground">Sources · {evidence.length}</p>
      <ol className="space-y-3">
        {evidence.map((e, k) => {
          let host = e.url;
          try { host = new URL(e.url).host; } catch { /* shown as given */ }
          return (
            <li key={k} className="flex gap-3">
              <span className="font-mono text-[11px] text-muted-foreground">{k + 1}</span>
              <div className="min-w-0 flex-1">
                <a href={e.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-start gap-1 text-[13px] font-semibold leading-snug hover:underline">{e.title ?? host}<ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden /></a>
                <p className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">{host}{e.scope && <span className="border px-1">{e.scope}</span>}</p>
                {e.excerpts.slice(0, 2).map((x, j) => <blockquote key={j} className="mt-1.5 line-clamp-3 border-l-2 border-[hsl(var(--wf-parallel)/.6)] pl-2.5 text-[12.5px] leading-snug text-muted-foreground">{x}</blockquote>)}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A tool call: its input, and its output (a rendered page shows as its image). */
export function ToolCard({ e, fileUrl, zoom, compact = false }: { e: Effect; fileUrl: FileUrl; zoom: (src: string) => void; compact?: boolean }) {
  const raw = e.output;
  // An answer of false, 0 or "" is an answer: only an absent one is not.
  const answered = raw !== null && raw !== undefined;
  const out = (raw && typeof raw === "object" ? raw : null) as { pages?: { page: number; image: string }[]; text?: string; error?: { code?: string; message?: string } } | null;
  const going = !e.endedAt && !["done", "ok", "failed", "stopped"].includes(e.status);
  const failure = e.error ?? (out?.error ? `${out.error.code ? `${out.error.code}: ` : ""}${out.error.message ?? ""}` : null);
  const tone = e.status === "done" || e.status === "ok" ? "success" : e.status === "failed" ? "error" : e.status === "stopped" ? "muted" : "active";
  return (
    <section className="border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="caps inline-flex h-5 items-center border border-[hsl(var(--wf-tool)/.6)] bg-[hsl(var(--wf-tool)/.12)] px-1.5 text-[10px] leading-none text-[hsl(var(--wf-tool))]">tool</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{e.tool}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{e.endedAt ? ms(span(e.startedAt, e.endedAt)) : ""}</span>
        <Chip tone={tone}>{e.status}</Chip>
      </header>
      <div className="space-y-3 px-4 py-3">
        {compact ? <p className="break-all font-mono text-[11px]"><span className="caps mr-2 text-[10px] text-muted-foreground">Input</span>{JSON.stringify(e.input)}</p>
          : <div><p className="caps mb-1 text-[10px] text-muted-foreground">Input</p><Pre value={e.input} small /></div>}
        {failure && <p className="font-mono text-[12px] text-destructive-text">{failure}</p>}
        {!!out?.pages?.length && (
          <div className="flex flex-wrap gap-3">
            {out.pages.map((p) => (
              <button key={p.page} type="button" className="block border bg-white hover:border-foreground" onClick={() => zoom(fileUrl(p.image))} aria-label={`Open page ${p.page}`}>
                <img src={fileUrl(p.image)} alt={`Page ${p.page}`} className="block h-[124px] w-[96px] object-cover object-top" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {answered && !failure && <details className="group"><summary className="caps flex cursor-pointer list-none items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"><ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden /> Output</summary><Pre value={raw} small /></details>}
        {!answered && !failure && <p className="font-mono text-[12px] text-muted-foreground">{e.status === "stopped" ? "Stopped before it answered." : going ? "Running…" : "Finished with no output."}</p>}
      </div>
    </section>
  );
}

/** The node as written: its own fields, with its children's bodies left out. */
function Definition({ workflow, path, kind }: { workflow: unknown; path: string; kind: string }) {
  const n = at(workflow, path) as Record<string, unknown> | undefined;
  if (!n) return null;
  const own = Object.fromEntries(Object.entries(n).map(([k, v]) => [k,
    (k === "steps" || (k === "branches" && kind === "parallel")) && Array.isArray(v) ? `… ${v.length} nodes` : k === "body" ? "… its body" : k === "branches" && kind === "route" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, { criteria?: string }>).map(([b, x]) => [b, x?.criteria ?? "…"])) : v]));
  return (
    <details className="group border">
      <summary className="caps flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[10.5px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden /> Definition <span className="normal-case tracking-normal">{path}</span>
      </summary>
      <Pre value={own} />
    </details>
  );
}

function Pre({ value, small }: { value: unknown; small?: boolean }) {
  return <pre className={cn("overflow-auto whitespace-pre-wrap break-words border-t bg-background px-4 py-3 font-mono leading-[1.6]", small ? "max-h-48 border text-[11px]" : "max-h-80 text-[11.5px]")}>{JSON.stringify(value, null, 2)}</pre>;
}

function Zoom({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" role="dialog" aria-label="Page image" onClick={onClose}>
      <img src={src} alt="Page" className="max-h-full max-w-full border bg-white" />
    </div>
  );
}
