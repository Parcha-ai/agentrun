import { fieldBoxClass, Input, Textarea } from "@/components/ui/field";
import { ArrowUpRight, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { EditorCaps } from "./AgentEditor";
import { CodingAgentAction } from "./CodingAgentAction";
import { TemplateHarnessIcon } from "./HarnessIcon";
import { PlaceSetting } from "./PlaceSetting";
import { ProblemCard } from "./Problem";
import { ToolPicker } from "./ToolPicker";
import { installHash, TemplateProvenance } from "./Templates";
import { Button, buttonVariants } from "./ui/button";
import { agentDraftHref, briefAgentDraft } from "@/lib/agentDraft";
import { defaultPlaceOf } from "@/lib/agentForm";
import type { ToolGate } from "@/lib/toolSettings";
import { type Place, placeLabel } from "@/lib/place";
import { applyTemplatePrompt, buildAgentPrompt } from "@/lib/codingAgentPrompts";
import type { Client } from "@/lib/client";
import { type Problem, problem } from "@/lib/problem";
import { cardTitleOf, inCatalog, templatePlaygroundHref, titleOf } from "@/lib/templatePackages";
import { cn } from "@/lib/utils";
import type { TemplateView } from "@/lib/v2";
import { matchesFilter } from "@/lib/filter";
import { useMcpServers } from "@/lib/useMcpServers";
import { marketplaceLine, marketplaceMatches, marketplaceNote, notHere, useMarketplace } from "@/lib/marketplace";

/** What Build's Tools step reads of the server: the tools it offers, where runs can go, and whether it runs MCP tools. */
export type BuildCaps = Pick<EditorCaps, "tools" | "places" | "mcp" | "mcpHarnesses"> & {
  /** Each tool's permission on this server (capabilities' tools, toolGates): a tool it denies for every agent is refused. */
  gates?: ToolGate[];
};

/** Build in a coding agent, or apply the same complete template in the API playground. Choosing a template never writes.
 *  The composer and the templates share one column, and every template card shows its action: nothing to open first.
 *  This server's templates come first, then the marketplace's others (GRE-4834), each installed from the install page.
 *  With `caps`, a Tools step picks the new agent's tools and where it runs; both go on the create request and into the
 *  coding-agent prompt. Left alone, it adds nothing. */
export function BuildAgent({ origin, v2, caps }: { origin: string; v2: Pick<Client, "listTemplates" | "listMarketplaceTemplates"> & Partial<Pick<Client, "listMcpServers">>; caps?: BuildCaps }) {
  const [brief, setBrief] = useState("");
  const [search, setSearch] = useState("");
  const [packages, setPackages] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  const id = useId();
  const [tools, setTools] = useState<string[]>([]);
  const [place, setPlace] = useState<Place | undefined>(undefined);
  const draft = briefAgentDraft(brief, { tools, place });
  const prompt = buildAgentPrompt(origin, brief, tools.length || place ? draft : undefined);
  useEffect(() => {
    let live = true;
    setError(null);
    v2.listTemplates().then(
      (result) => { if (live) setPackages(result.templates); },
      (cause) => { if (live) setError(problem(cause, "the template catalog")); },
    );
    return () => { live = false; };
  }, [v2, tries]);
  const listed = packages?.filter(inCatalog) ?? null;
  // This server's read has ended, read or failed: the marketplace's cards follow it, so they never show before this server's
  // own, and a failed read here does not hide them.
  const settled = packages !== null || error !== null;
  const market = useMarketplace(v2);
  // A card the marketplace lists reads its one line there, as the marketplace's card does; else its description.
  const lineOf = (template: TemplateView) => market.list?.templates.find((m) => m.here === template.id)?.summary ?? template.description;
  // A word the card shows finds it: its line (the marketplace's summary where it lists it) is searched too.
  const shown = (listed ?? []).filter((template) => matchesFilter(search, titleOf(template), template.description, lineOf(template), template.name, template.id, template.publisher));
  const elsewhere = notHere(market.list);
  const others = elsewhere.filter((template) => marketplaceMatches(search, template));
  const note = marketplaceNote(market.list);
  return <section className="mx-auto w-full max-w-page px-5 pb-20 pt-10 md:px-12 md:pt-16" aria-labelledby={`${id}-heading`}>
    <header className="text-center">
      <h1 id={`${id}-heading`} className="text-2xl font-semibold leading-tight tracking-tight md:text-display">What do you want to build?</h1>
      <p className="mt-3 text-base text-muted-foreground">Describe your agent, or pick a template to start from.</p>
    </header>
    <div className="mt-8">
      <div className={cn(fieldBoxClass, "!rounded-composer overflow-hidden bg-card transition-colors")} data-agent-composer>
        <label htmlFor={`${id}-brief`} className="sr-only">Describe your agent</label>
        <Textarea bare id={`${id}-brief`} value={brief} onChange={(event) => setBrief(event.target.value)} rows={3}
          placeholder="A support agent that answers questions from our docs and escalates to Slack when it’s stuck…"
          className="block min-h-28 w-full resize-none px-5 pb-3 pt-5 font-sans text-base leading-relaxed text-foreground md:px-6 md:pt-6" />
        <div className="flex justify-end px-4 pb-4 pt-1 md:px-5 md:pb-5">
          <CodingAgentAction variant="primary" label="Build an agent" prompt={prompt} playgroundHref={agentDraftHref(draft)} />
        </div>
      </div>
      {caps && <ToolsStep caps={caps} v2={v2} tools={tools} place={place} onTools={setTools} onPlace={setPlace} />}
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
          <span role="status" className="text-small text-muted-foreground">{!settled ? "Loading templates…" : listed || elsewhere.length ? `${shown.length + others.length} of ${(listed?.length ?? 0) + elsewhere.length}` : ""}</span>
        </div>
        <div className={cn(fieldBoxClass, "flex w-full items-center gap-2 px-3 sm:w-72")}>
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input bare type="search" aria-label="Search templates" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search templates…" className="h-control-md w-full font-sans" />
        </div>
      </div>
      {error && <ProblemCard problem={error} onRetry={() => setTries((value) => value + 1)} className="mb-5" />}
      {listed?.length === 0 && <p className="border border-border px-5 py-10 text-center text-lead text-muted-foreground">This server has no template packages yet. Describe the agent you want to build above.</p>}
      {settled && (listed?.length ?? 0) + elsewhere.length > 0 && !shown.length && !others.length && <p role="status" className="border border-border px-5 py-10 text-center text-muted-foreground">No templates match “{search}”.</p>}
      {/* The marketplace's own failure, and a list it could not read now, each with Try again, as the Templates page says them. */}
      {market.error && <ProblemCard problem={market.error} onRetry={market.retry} className="mb-5" />}
      {note && <p role="status" className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted-foreground">{note}<Button size="sm" onClick={market.retry}>Try again</Button></p>}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((template) => {
          const detail = [template.skills.length ? `${template.skills.length} skill${template.skills.length === 1 ? "" : "s"}` : "Ready to configure", template.triggers.length ? `${template.triggers.length} trigger${template.triggers.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
          return <article key={template.id} aria-label={`${cardTitleOf(template)}${template.source ? ` from ${template.id}` : ""}`} className="flex flex-col border bg-card">
            <div className="flex flex-1 flex-col p-5">
              <div className="flex items-start gap-2"><span data-template-icon className="flex h-7 shrink-0 items-center"><TemplateHarnessIcon harness={template.harness ?? []} /></span><h3 className="text-lg font-semibold leading-snug">{cardTitleOf(template)}</h3></div>
              <TemplateProvenance t={template} />
              <p className="mt-3 line-clamp-3 text-lead leading-relaxed text-muted-foreground">{lineOf(template)}</p>
              <span className="mt-auto pt-5 text-small text-muted-foreground">{detail}</span>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <CodingAgentAction label="Use this template" prompt={applyTemplatePrompt(origin, template, brief)} playgroundHref={templatePlaygroundHref(template)} />
            </div>
          </article>;
        })}
        {settled && others.map((template) => <article key={`marketplace:${template.name}`} aria-label={`${template.title} from the marketplace`} className="flex flex-col border bg-card" data-marketplace-template={template.name}>
          <div className="flex flex-1 flex-col p-5">
            <div className="flex items-start gap-2"><span data-template-icon className="flex h-7 shrink-0 items-center"><TemplateHarnessIcon harness={template.harness} /></span><h3 className="text-lg font-semibold leading-snug">{template.title}</h3></div>
            <p className="mt-3 line-clamp-3 text-lead leading-relaxed text-muted-foreground">{marketplaceLine(template)}</p>
            <span className="mt-auto pt-5 text-small text-muted-foreground">{["From the marketplace", template.category].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="flex justify-end border-t px-4 py-3">
            {/* With its source, Install reads the package here first (the install page); with none, its page installs it. */}
            {template.source ? <a href={installHash(template.source)} className={buttonVariants({ size: "sm" })}>Install</a>
              : <a href={template.page_url} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>Install from the marketplace<ArrowUpRight aria-hidden /></a>}
          </div>
        </article>)}
      </div>
    </section>
    <p className="mt-10 text-center text-lead text-muted-foreground">Or <a className="text-primary-text underline underline-offset-4 hover:text-primary-text/80" href={agentDraftHref(briefAgentDraft(""))}>start from a blank agent</a>.</p>
  </section>;
}

/** Build's Tools step: the editor's ToolPicker (built-in tools, then each MCP server saved in Settings, read when the step opens)
 *  and PlaceSetting. Nothing is ticked at first. */
function ToolsStep({ caps, v2, tools, place, onTools, onPlace }: { caps: BuildCaps; v2: Partial<Pick<Client, "listMcpServers">>; tools: string[]; place: Place | undefined; onTools: (tools: string[]) => void; onPlace: (place: Place) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const mcp = !!caps.mcp && !!v2.listMcpServers;
  // Read when the step is open and MCP is on, including MCP turning on (capabilities answering late) while it is open.
  const [servers, loadMcp] = useMcpServers(v2, open && mcp);
  const runs = place ?? defaultPlaceOf(false, tools, caps.places);
  const summary = `${tools.length ? `${tools.length} picked: ${tools.join(", ")}` : "None picked: it starts with no tools"} · ${placeLabel(runs)}`;
  return <section aria-label="Tools" className="mt-3 border bg-card">
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-5">
      <div className="min-w-0 flex-1">
        <h2 className="caps text-small font-semibold">Tools</h2>
        <p className="mt-0.5 truncate text-small text-muted-foreground" title={summary}>{summary}</p>
      </div>
      <Button type="button" size="sm" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((v) => !v)}>{open ? "Done" : "Choose tools"}</Button>
    </div>
    {open && <div id={`${id}-body`} className="space-y-6 border-t px-4 py-4 md:px-5">
      <div>
        <ToolPicker offers={caps.tools} tools={tools} harness="pi" place={place} places={caps.places} mcp={mcp} servers={servers} mcpHarnesses={caps.mcpHarnesses}
          gates={caps.gates} onRetry={loadMcp} onChange={onTools} />
      </div>
      {caps.places && <PlaceSetting value={place} saved={undefined} places={caps.places} tools={caps.tools} picked={tools}
        onChange={(next) => { onPlace(next.place); if (next.tools) onTools(next.tools); }} />}
    </div>}
  </section>;
}
