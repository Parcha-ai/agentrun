import { ChevronDown, FileText, Globe, ListChecks, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ToolOffer } from "@/lib/agentForm";
import { type Template, TEMPLATES, templateHarness, type TemplateHarness, templateOffer } from "@/lib/templates";

export type StartHereProps = {
  harnesses: readonly TemplateHarness[];
  tools: readonly ToolOffer[];
  /** Makes the template's agent (once) and runs it, then opens the run. */
  onTry: (t: Template) => Promise<string | null>;
  imported?: number;
  /** The server can save a provider key through Settings. */
  keySettings?: boolean;
  importAction?: ReactNode;
};

const DISMISSED = "agentrun.console.start-here.dismissed";
const ICONS: Record<string, typeof FileText> = { hello: FileText, web: Globe, plan: ListChecks };
function wasDismissed(): boolean {
  try { return localStorage.getItem(DISMISSED) === "true"; } catch { return false; }
}

/** A compact introduction alongside Mission Control. Importing and viewing history needs no provider key;
 *  execution setup and the example runs appear only when the person chooses to run an agent here. */
export function StartHere({ harnesses, tools, onTry, imported = 0, keySettings = false, importAction }: StartHereProps) {
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [expanded, setExpanded] = useState(false);
  const [trying, setTrying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const harness = templateHarness(harnesses);
  const tryIt = async (t: Template) => {
    setTrying(t.id); setProblem(null);
    try { setProblem(await onTry(t)); }
    finally { setTrying(null); }
  };
  if (dismissed) return null;
  return (
    <section aria-label="Start here" className="border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Bring your agents into view</h2>
          <p className="mt-1 text-lead text-muted-foreground">Use Import agents to bring in your local Claude Code, Codex and pi history. No model key needed.</p>
          {imported > 0 && <p className="mt-2 text-body text-muted-foreground">{imported} imported {imported === 1 ? "session" : "sessions"} · <a href="#/runs" className="text-primary-text underline-offset-4 hover:underline">Browse history</a></p>}
        </div>
        <button type="button" aria-label="Dismiss introduction" className="shrink-0 p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => {
          setDismissed(true);
          try { localStorage.setItem(DISMISSED, "true"); } catch { /* Keep dismissal for this visit when storage is unavailable. */ }
        }}><X className="size-4" aria-hidden /></button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {importAction}
        <button type="button" className="flex items-center gap-1.5 text-body text-muted-foreground hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          Run an agent here <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </div>
      {expanded && <div className="mt-4 border-t pt-4">
        {harness ? (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {TEMPLATES.map((t) => {
              const offer = templateOffer(t, harness, tools);
              const Icon = ICONS[t.id] ?? FileText;
              return (
                <li key={t.id} className="flex flex-col border bg-background p-4">
                  <p className="flex items-center gap-2 text-prose font-semibold"><Icon className="size-4 text-primary-text" aria-hidden />{t.name}</p>
                  <p className="mt-1 font-mono text-label text-muted-foreground">{t.shows}</p>
                  <p className="mt-2 flex-1 text-lead leading-relaxed text-muted-foreground">{t.description}</p>
                  {offer.ok
                    ? <Button type="button" variant={t.id === "hello" ? "solid" : "outline"} size="sm" className="mt-4 self-start" disabled={trying !== null} onClick={() => void tryIt(t)}>{trying === t.id ? "Starting…" : "Try it"}</Button>
                    : <p className="mt-4 font-mono text-small text-muted-foreground">{offer.reason}</p>}
                </li>
              );
            })}
          </ul>
        ) : <p className="text-lead text-muted-foreground">Running agents here needs a configured model. {keySettings
          ? <a href="#/settings/keys" className="text-primary-text underline-offset-4 hover:underline">Set up models in Settings</a>
          : "Configure a model where this server runs, then return here."}</p>}
        <p className="mt-3 text-body text-muted-foreground">Or <a href="#/agents/new" className="text-primary-text underline-offset-4 hover:underline">Create your own</a>: name it, say what it does, pick its tools.</p>
        {problem && <p className="mt-3 font-mono text-body text-destructive-text" role="alert">{problem}</p>}
      </div>}
    </section>
  );
}
