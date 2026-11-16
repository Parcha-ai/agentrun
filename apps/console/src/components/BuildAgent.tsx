import { fieldBoxClass, Input, Textarea } from "@/components/ui/field";
import { ArrowRight, Code, FileText, LayoutTemplate, Radar, Search, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { CodingAgentAction } from "./CodingAgentAction";
import { ProblemCard } from "./Problem";
import { TemplateProvenance } from "./Templates";
import { agentDraftHref, briefAgentDraft } from "@/lib/agentDraft";
import { applyTemplatePrompt, buildAgentPrompt } from "@/lib/codingAgentPrompts";
import type { Client } from "@/lib/client";
import { type Problem, problem } from "@/lib/problem";
import { templatePlaygroundHref, titleOf } from "@/lib/templatePackages";
import { cn } from "@/lib/utils";
import type { TemplateView } from "@/lib/v2";

const ICONS: Record<string, typeof FileText> = {
  "code-review": Code, "inbound-lead": Search, kyb: ShieldCheck,
  "market-monitor": Radar, "release-notes": FileText,
};

/** Build in a coding agent, or apply the same complete template in the API playground. Choosing a template never writes. */
export function BuildAgent({ origin, v2 }: { origin: string; v2: Pick<Client, "listTemplates"> }) {
  const [brief, setBrief] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [packages, setPackages] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  const id = useId();
  const prompt = buildAgentPrompt(origin, brief);
  const draft = briefAgentDraft(brief);
  useEffect(() => {
    let live = true;
    setError(null);
    v2.listTemplates().then(
      (result) => { if (live) setPackages(result.templates); },
      (cause) => { if (live) setError(problem(cause, "the template catalog")); },
    );
    return () => { live = false; };
  }, [v2, tries]);
  const query = search.trim().toLocaleLowerCase();
  const shown = (packages ?? []).filter((template) => `${titleOf(template)} ${template.description} ${template.name} ${template.id} ${template.publisher ?? ""}`.toLocaleLowerCase().includes(query));
  return <section className="mx-auto w-full max-w-page-wide px-5 pb-20 pt-10 md:px-12 md:pt-16" aria-labelledby={`${id}-heading`}>
    <header className="text-center">
      <h1 id={`${id}-heading`} className="text-2xl font-semibold leading-tight tracking-tight md:text-display">What do you want to build?</h1>
      <p className="mt-3 text-base text-muted-foreground">Describe your agent, or pick a template to start from.</p>
    </header>
    <div className="mx-auto mt-8 max-w-page">
      <div className={cn(fieldBoxClass, "!rounded-composer overflow-hidden bg-card transition-colors")} data-agent-composer>
        <label htmlFor={`${id}-brief`} className="sr-only">Describe your agent</label>
        <Textarea bare id={`${id}-brief`} value={brief} onChange={(event) => setBrief(event.target.value)} rows={3}
          placeholder="A support agent that answers questions from our docs and escalates to Slack when it’s stuck…"
          className="block min-h-28 w-full resize-none px-5 pb-3 pt-5 font-sans text-base leading-relaxed text-foreground md:px-6 md:pt-6" />
        <div className="flex justify-end px-4 pb-4 pt-1 md:px-5 md:pb-5">
          <CodingAgentAction variant="primary" label="Build an agent" prompt={prompt} playgroundHref={agentDraftHref(draft)} />
        </div>
      </div>
      <details className="mt-3 text-small text-muted-foreground">
        <summary className="ml-auto w-fit cursor-pointer hover:text-foreground">View coding-agent prompt</summary>
        <label htmlFor={`${id}-prompt`} className="sr-only">Coding-agent prompt</label>
        <Textarea id={`${id}-prompt`} value={prompt} readOnly rows={8} spellCheck={false}
          className="mt-3 w-full border bg-card p-4 font-mono text-small leading-relaxed text-foreground" />
      </details>
    </div>
    <section className="mt-10 md:mt-12" aria-labelledby={`${id}-templates`}>
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-3">
          <h2 id={`${id}-templates`} className="text-lead font-semibold">Start from a template</h2>
          <span role="status" className="text-small text-muted-foreground">{packages === null && !error ? "Loading templates…" : packages ? `${shown.length} of ${packages.length}` : ""}</span>
        </div>
        <div className={cn(fieldBoxClass, "flex w-full items-center gap-2 px-3 sm:w-72")}>
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input bare type="search" aria-label="Search templates" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search templates…" className="h-control-md w-full font-sans" />
        </div>
      </div>
      {error && <ProblemCard problem={error} onRetry={() => setTries((value) => value + 1)} className="mb-5" />}
      {packages?.length === 0 && <p className="border border-border px-5 py-10 text-center text-lead text-muted-foreground">This server has no template packages yet. Describe the agent you want to build above.</p>}
      {packages && packages.length > 0 && !shown.length && <p role="status" className="border border-border px-5 py-10 text-center text-muted-foreground">No templates match “{search}”.</p>}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((template) => {
          const expanded = selected === template.id;
          const Icon = ICONS[template.name] ?? LayoutTemplate;
          const actionsId = `${id}-${encodeURIComponent(template.id)}-actions`;
          const detail = [template.skills.length ? `${template.skills.length} skill${template.skills.length === 1 ? "" : "s"}` : "Ready to configure", template.triggers.length ? `${template.triggers.length} trigger${template.triggers.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
          return <article key={template.id} className={`flex flex-col overflow-hidden border transition-colors ${expanded ? "border-border-strong bg-card" : "border-border hover:border-border-strong"}`}>
            <button type="button" aria-expanded={expanded} aria-controls={actionsId} aria-label={`Start with ${titleOf(template)}${template.source ? ` from ${template.id}` : ""}`}
              className="flex min-h-48 flex-1 flex-col p-5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => setSelected(expanded ? null : template.id)}>
              <h3 className="text-lg font-semibold leading-snug">{titleOf(template)}</h3>
              <TemplateProvenance t={template} />
              <p className="mt-3 line-clamp-3 text-lead leading-relaxed text-muted-foreground">{template.description}</p>
              <span className="mt-auto flex w-full items-center gap-2 pt-5 text-small text-muted-foreground"><Icon className="size-4" aria-hidden />{detail}<ArrowRight className="ml-auto size-3.5" aria-hidden /></span>
            </button>
            {expanded && <div id={actionsId} className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-4">
              <span className="mr-auto font-mono text-small text-muted-foreground">v{template.version}</span>
              <CodingAgentAction variant="primary" label="Use this template" prompt={applyTemplatePrompt(origin, template, brief)} playgroundHref={templatePlaygroundHref(template)} />
            </div>}
          </article>;
        })}
      </div>
    </section>
    <p className="mt-10 text-center text-lead text-muted-foreground">Or <a className="text-primary-text underline underline-offset-4 hover:text-primary-text/80" href={agentDraftHref(briefAgentDraft(""))}>start from a blank agent</a>.</p>
  </section>;
}
