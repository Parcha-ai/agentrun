import { FileText, Globe, ListChecks } from "lucide-react";
import { useState } from "react";
import { ModelStep } from "@/components/ModelStep";
import { Button } from "@/components/ui/button";
import type { ToolOffer } from "@/lib/agentForm";
import { type Template, TEMPLATES, templateHarness, type TemplateHarness, templateOffer } from "@/lib/templates";

export type StartHereProps = {
  harnesses: readonly TemplateHarness[];
  tools: readonly ToolOffer[];
  /** Makes the template's agent (once) and runs it, then opens the run; resolves with the refusal to show, or null. */
  onTry: (t: Template) => Promise<string | null>;
  /** Sessions imported from this machine's coding agents, if any: history to read while nothing of the owner's has run. */
  imported?: number;
  /** A key saved in the model-key card above gives the server its model (App decides): the model step points at it. */
  keyCard?: boolean;
};

const ICONS: Record<string, typeof FileText> = { hello: FileText, web: Globe, plan: ListChecks };

/** Mission Control before the owner's first run: three templates, each one click from an agent at work, or the model
 *  step first when no harness here has a model to run. */
export function StartHere({ harnesses, tools, onTry, imported = 0, keyCard = false }: StartHereProps) {
  const [trying, setTrying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const harness = templateHarness(harnesses);
  const tryIt = async (t: Template) => {
    setTrying(t.id); setProblem(null);
    const p = await onTry(t);
    setTrying(null); setProblem(p);
  };
  return (
    <section aria-label="Start here" className="space-y-4">
      <div className="border border-primary/50 bg-primary/5 p-6">
        <p className="caps text-[11px] text-brand-accent">Start here</p>
        <h2 className="mt-2 text-xl font-semibold">Watch an agent work in about ten seconds</h2>
        <p className="mt-1 text-[14px] text-muted-foreground">{harness ? "Pick one: it makes the agent, runs it, and opens the run as it happens." : "First a model to run on; then one click makes an agent, runs it, and opens the run as it happens."}</p>
        <div className="mt-5">
          {harness ? (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {TEMPLATES.map((t) => {
                const offer = templateOffer(t, harness, tools);
                const Icon = ICONS[t.id] ?? FileText;
                return (
                  <li key={t.id} className="flex flex-col border bg-background p-4">
                    <p className="flex items-center gap-2 text-[15px] font-semibold"><Icon className="size-4 text-brand-accent" aria-hidden />{t.name}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">{t.shows}</p>
                    <p className="mt-2 flex-1 text-[14px] leading-relaxed text-muted-foreground">{t.description}</p>
                    {offer.ok
                      ? <Button type="button" variant={t.id === "hello" ? "solid" : "outline"} size="sm" className="mt-4 self-start" disabled={trying !== null} onClick={() => void tryIt(t)}>{trying === t.id ? "Starting…" : "Try it"}</Button>
                      : <p className="mt-4 font-mono text-[12px] text-muted-foreground">{offer.reason}</p>}
                  </li>
                );
              })}
            </ul>
          ) : <ModelStep keyCard={keyCard} />}
          {problem && <p className="mt-3 font-mono text-[13px] text-destructive-text" role="alert">{problem}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border px-5 py-4">
        <p className="text-[14px]">Or <a href="#/agents/new" className="text-brand-accent underline-offset-4 hover:underline">Create your own</a>: name it, say what it does, pick its tools.</p>
        {imported > 0 && <p className="text-[14px] text-muted-foreground">{imported} imported sessions to read · <a href="#/runs" className="text-brand-accent underline-offset-4 hover:underline">Browse them</a></p>}
      </div>
    </section>
  );
}
