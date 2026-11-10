import { ArrowRight, FileText, Globe, ListChecks } from "lucide-react";
import { useId, useState } from "react";
import { CodingAgentAction } from "./CodingAgentAction";
import { agentDraftHref, briefAgentDraft, templateAgentDraft } from "@/lib/agentDraft";
import { buildAgentPrompt } from "@/lib/codingAgentPrompts";
import { TEMPLATES } from "@/lib/templates";

const ICONS: Record<string, typeof FileText> = { hello: FileText, web: Globe, plan: ListChecks };

/** Build in a coding agent, or prepare the same definition in the API playground. Choosing a template never writes. */
export function BuildAgent({ origin }: { origin: string }) {
  const [brief, setBrief] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  const prompt = buildAgentPrompt(origin, brief);
  const draft = briefAgentDraft(brief);
  return <section className="mx-auto w-full max-w-page-wide px-5 pb-20 pt-12 md:px-12 md:pt-[72px]" aria-labelledby={`${id}-heading`}>
    <header className="text-center">
      <h1 id={`${id}-heading`} className="text-2xl font-semibold leading-tight tracking-tight md:text-display">What do you want to build?</h1>
      <p className="mt-3 text-base text-muted-foreground">Describe your agent, or pick a template to start from.</p>
    </header>
    <div className="mx-auto mt-9 max-w-page">
      <div className="overflow-hidden border border-border-strong bg-card transition-colors focus-within:border-primary/60">
        <label htmlFor={`${id}-brief`} className="sr-only">Describe your agent</label>
        <textarea id={`${id}-brief`} value={brief} onChange={(event) => setBrief(event.target.value)} rows={2}
          placeholder="A support agent that answers questions from our docs and escalates to Slack when it’s stuck…"
          className="block min-h-[96px] w-full resize-y border-0 bg-transparent px-5 pb-2 pt-5 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground md:min-h-[100px]" />
        <div className="flex justify-end px-4 pb-4 pt-2">
          <CodingAgentAction label="Build an agent" prompt={prompt} playgroundHref={agentDraftHref(draft)} />
        </div>
      </div>
      <details className="mt-3 text-small text-muted-foreground">
        <summary className="ml-auto w-fit cursor-pointer hover:text-foreground">View coding-agent prompt</summary>
        <label htmlFor={`${id}-prompt`} className="sr-only">Coding-agent prompt</label>
        <textarea id={`${id}-prompt`} value={prompt} readOnly rows={8} spellCheck={false}
          className="mt-3 w-full border bg-card p-4 font-mono text-small leading-relaxed text-foreground" />
      </details>
    </div>
    <section className="mt-10 md:mt-12" aria-label="Agent templates">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {TEMPLATES.map((template) => {
          const expanded = selected === template.id;
          const Icon = ICONS[template.id] ?? FileText;
          const templateDraft = templateAgentDraft(template, brief);
          const templatePrompt = buildAgentPrompt(origin, brief, templateDraft);
          return <article key={template.id} className={`flex flex-col overflow-hidden border transition-colors ${expanded ? "border-border-strong bg-card" : "border-border hover:border-border-strong"}`}>
            <button type="button" aria-expanded={expanded} aria-controls={`${id}-${template.id}-actions`} aria-label={`Start with ${template.name}`}
              className="flex min-h-[190px] flex-1 flex-col p-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
              onClick={() => setSelected(expanded ? null : template.id)}>
              <h2 className="text-lg font-semibold leading-snug">{template.name}</h2>
              <p className="mt-3 text-lead leading-relaxed text-muted-foreground">{template.description}</p>
              <span className="mt-auto flex w-full items-center gap-2 pt-5 text-small text-muted-foreground"><Icon className="size-4" aria-hidden />{template.shows}<ArrowRight className="ml-auto size-3.5" aria-hidden /></span>
            </button>
            {expanded && <div id={`${id}-${template.id}-actions`} className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-4">
              <CodingAgentAction label="Use this template" prompt={templatePrompt} playgroundHref={agentDraftHref(templateDraft)} />
            </div>}
          </article>;
        })}
      </div>
    </section>
    <p className="mt-10 text-center text-lead text-muted-foreground">Or <a className="text-primary-text underline underline-offset-4 hover:text-primary-text/80" href={agentDraftHref(briefAgentDraft(""))}>start from a blank agent</a>.</p>
  </section>;
}
