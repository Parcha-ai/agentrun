import { BadgeDollarSign, Globe, LayoutTemplate } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import type { Client } from "@/lib/client";
import { freeApplyHash, freeHarness, freeModels, runsFree, freeModelFor, webTools } from "@/lib/freeShelf";
import { type HarnessInfo, modelLabel } from "@/lib/models";
import { type Problem, problem } from "@/lib/problem";
import { titleOf } from "@/lib/templatePackages";
import { cn } from "@/lib/utils";
import type { TemplateView } from "@/lib/v2";

/** `fit`: the hardware-fit card (what this machine can run, and a pull), shown where the server has no local model. Until
 *  it lands its slot stays, empty, under the line that points to it. */
type Props = { v2: Pick<Client, "listTemplates">; harnesses: readonly HarnessInfo[]; tools: unknown; freeRequests?: number; routePrefix?: string | null; go: (hash: string) => void; fit?: ReactNode };

/** The Free shelf: what runs for $0 on this server. Its free models (this machine's Ollama first), what its web tools go
 *  through in the server's own words, and the templates that run free, each a click from its Apply screen on the free
 *  model. All of it from capabilities and GET /v2/templates. */
export function FreeShelf({ v2, harnesses, tools, freeRequests, routePrefix, go, fit }: Props) {
  const models = freeModels(harnesses, routePrefix);
  const harness = freeHarness(harnesses) ?? "pi";
  const web = webTools(tools, harness);
  return (
    <section className="flex min-h-full flex-col">
      <header className={cn(pageToolbarClass, "gap-2 px-5 md:px-6")}>
        <h1 className={pageTitleClass}><BadgeDollarSign className="size-4" aria-hidden />Free</h1>
      </header>
      <div className="mx-auto w-full max-w-4xl space-y-6 p-5 md:p-6">
        <p className="text-lead text-muted-foreground">What runs for $0 on this server: its free models, the web tools that need no key, and the agents built to run on them.</p>

        <Shelf label="Free models">
          {models.length > 0 && (
            <ul className="divide-y">
              {models.map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                  <span className="min-w-0 flex-1 break-all font-mono text-body" title={m.id}>{m.label}</span>
                  <span className="font-mono text-label text-muted-foreground">{m.context} context</span>
                  {/* A local model's requests count toward no limit; a catalog one's toward the server's limit a run. */}
                  {!m.local && typeof freeRequests === "number" && <span className="font-mono text-label text-muted-foreground">up to {freeRequests} requests a run</span>}
                </li>
              ))}
            </ul>
          )}
          {!models.some((m) => m.local) && (
            <div className={cn("px-4 py-3", models.length > 0 && "border-t")}>
              <p className="text-body text-muted-foreground" role="status">
                {models.length ? "No local model yet. A model on this machine's Ollama runs with no key and no limit on its requests." : "No free model on this server yet. A model on this machine's Ollama runs for $0 with no key."}
              </p>
              <div data-testid="free-fit-slot" className="empty:hidden mt-3">{fit}</div>
            </div>
          )}
        </Shelf>

        <Shelf label="Web tools" icon={<Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}>
          {web.length ? (
            <ul className="divide-y">
              {web.map((t) => (
                <li key={t.name} data-tool={t.name} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-body">{t.name}</span>
                    <Chip tone="muted"><span data-resolves>{t.resolves}</span></Chip>
                  </div>
                  {/* The server's own sentence (capabilities' tools[].why), never reworded here. */}
                  <p className="mt-1 text-small text-muted-foreground" data-why>{t.why}</p>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-3 text-body text-muted-foreground">This server resolves no web tool on {harness} yet.</p>}
        </Shelf>

        <FreeAgents v2={v2} harnesses={harnesses} routePrefix={routePrefix} go={go} />
      </div>
    </section>
  );
}

function Shelf({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">{icon}<h2 className="caps text-small font-semibold">{label}</h2></div>
      {children}
    </section>
  );
}

/** The templates that run free (lib/freeShelf.ts runsFree), each with Use free: its Apply screen, the agent on the free
 *  model there (apply's overrides.model). */
function FreeAgents({ v2, harnesses, routePrefix, go }: Pick<Props, "v2" | "harnesses" | "routePrefix" | "go">) {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    v2.listTemplates().then((r) => { if (live) setTemplates(r.templates); }, (e) => { if (live) setError(problem(e, "the templates")); });
    return () => { live = false; };
  }, [v2, tries]);
  const free = templates?.filter((t) => runsFree(t, harnesses)) ?? [];
  return (
    <Shelf label="Agents that run free" icon={<LayoutTemplate className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}>
      {error && !templates ? <div className="p-4"><ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" /></div>
        : !templates ? <div className="p-4"><ListSkeleton label="Loading the templates" rows={2} /></div>
        : !free.length ? <p className="px-4 py-3 text-body text-muted-foreground">No template on this server runs on a free model yet.</p>
        : (
          <ul className="grid gap-3 p-4 md:grid-cols-2">
            {free.map((t) => {
              const model = freeModelFor(t, harnesses);
              return (
                <li key={t.id}>
                  <article aria-label={titleOf(t)} className="flex h-full flex-col border bg-background px-4 py-3">
                    <h3 className="text-prose font-semibold">{titleOf(t)}</h3>
                    <p className="mt-1 text-body text-muted-foreground">{t.description}</p>
                    <p className="mt-2 font-mono text-label text-muted-foreground">{model ? <>On <span className="text-foreground" title={model}>{modelLabel(model, routePrefix).text}</span></> : "No free model to run it on here yet"}</p>
                    <div className="mt-auto flex justify-end pt-3">
                      <Button size="sm" variant="primary" disabled={!model} onClick={() => model && go(freeApplyHash(t.id, model))}>Use free</Button>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
    </Shelf>
  );
}
