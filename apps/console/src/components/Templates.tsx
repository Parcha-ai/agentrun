import { agentHash } from "@/components/AgentPage";
import { ArrowLeft, ArrowUpRight, Check, LayoutTemplate } from "lucide-react";
import { FieldInput, FieldIssues as Issues } from "@/components/FieldInput";
import { Picker } from "@/components/ui/picker";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { SecretOnce } from "@/components/Schedules";
import { ListSkeleton } from "@/components/Skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { formColumnsClass, Input } from "@/components/ui/field";
import { pageBodyClass, pageClass, pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { ListFilter } from "@/components/ListFilter";
import { matchesFilter } from "@/lib/filter";
import { marketplaceLine, marketplaceMatches, marketplaceNote, notHere, useMarketplace } from "@/lib/marketplace";
import { HarnessIcons, TemplateHarnessIcon } from "@/components/HarnessIcon";
import { ToolkitIcons } from "@/components/ToolkitIcon";
import { runTemplatePrompt } from "@/lib/codingAgentPrompts";
import { allPages, type Client, ClientError, type FieldIssue } from "@/lib/client";
import { keeper } from "@/lib/idempotency";
import { cn } from "@/lib/utils";
import { modelLabel } from "@/lib/models";
import { hookUrlOf, isScheduleTrigger, type Schedule, scheduleLine, TRIGGER_KINDS } from "@/lib/schedules";
import { type Problem, problem } from "@/lib/problem";
import { type McpServer, SOURCE_LABEL } from "@/lib/mcp";
import { type FieldSpec, fieldIssueWords, fieldKind, fieldLabel, fieldOfIssue, fieldStartText, fieldValid, fieldValues, schemaFields } from "@/lib/inputForm";
import { APPLY_REQUIREMENTS, grantsOf, isPlain, issuesAt, matchesOf, needsOf, paramHelp, type ParameterText, readTemplateDraft, setUpHref, templateHash, templatePlaygroundHref, titleOf, cardTitleOf, inCatalog } from "@/lib/templatePackages";
import { type Approvals, type MarketplaceTemplate, NEVER_ASK_LINE, type TemplateApplied, type TemplateImported, type TemplateView } from "@/lib/v2";

type Props = { v2: Client; go: (hash: string) => void; playground?: boolean; draft?: string };

/** A template's lines with its harnesses drawn as their icons, each named on hover and for a screen reader. */
function withHarnessIcons(lines: [string, string][], t: TemplateView): [string, ReactNode][] {
  return lines.map(([what, words]) => [what, what === "Harness" && t.harness?.length ? <HarnessIcons ids={t.harness} /> : words]);
}
/** A card's lines: its keys, then the apps its MCP servers reach as icons ("Apps"), then the rest of needsOf. */
function cardNeeds(t: TemplateView): [string, ReactNode][] {
  const lines = withHarnessIcons(needsOf(t), t);
  const at = lines[0]?.[0] === "Keys" ? 1 : 0;
  if (t.mcp.length) lines.splice(at, 0, ["Apps", <ToolkitIcons needs={t.mcp} />]);
  return lines;
}
const catalogHash = (playground: boolean) => playground ? "#/playground?operation=apply-template" : "#/templates";

/** The server's templates: review and install a GitHub package, run with a coding agent, or apply through the API playground. */
/** `model`: the agent's model, sent as apply's `overrides.model` (the Free shelf's "Use free" opens a template with it).
 *  `freeIds`: this server's free models, once capabilities are read: a linked model not among them is said to be one. */
export function TemplatesPage({ v2, name, install, go, playground = false, draft, model, freeIds }: Props & { name?: string; install?: string; model?: string; freeIds?: readonly string[] }) {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (install !== undefined) return;
    let live = true;
    setError(null);
    v2.listTemplates().then((r) => { if (live) setTemplates(r.templates); }, (e) => { if (live) setError(problem(e, "the templates")); });
    return () => { live = false; };
  }, [v2, tries, install]);
  const shown = name === undefined ? undefined : templates?.find((t) => t.id === name);
  const retry = () => setTries((n) => n + 1);
  const body = install !== undefined ? <InstallTemplate v2={v2} source={install} go={go} />
    // The list's own page keeps the marketplace's section when this server's list fails: it reads apart, and its cards
    // need nothing from this server's list. The error stands where this server's templates go.
    : error && !templates && name === undefined && !playground ? <TemplateList v2={v2} templates={[]} failed={error} onRetry={retry} go={go} playground={playground} onRemoved={retry} />
    : error && !templates ? <ProblemCard problem={error} onRetry={retry} className="" />
    : !templates ? <ListSkeleton label="Loading the templates" rows={3} />
    : name === undefined ? <TemplateList v2={v2} templates={templates} go={go} playground={playground} onRemoved={retry} />
    : shown ? <ApplyTemplate key={`${shown.id}:${draft ?? ""}:${model ?? ""}`} v2={v2} template={shown} go={go} playground={playground} draft={draft} model={model} freeIds={freeIds} />
    : <p className="border px-4 py-12 text-center font-mono text-body text-muted-foreground" role="alert">This server offers no template named {name}. <a href={catalogHash(playground)} className="underline">See its templates</a>.</p>;
  // In the API playground the page sits under the playground's own bar, with its own way back.
  if (playground) return <div className="p-5 md:p-8">{body}</div>;
  // Its own page has the sections' top bar: the list names the section; a template, or a package being read, leads back to it.
  const listing = install === undefined && name === undefined;
  return (
    <section className={pageClass}>
      <header className={cn(pageToolbarClass, "flex-wrap gap-2 px-5 md:px-6")}>
        {listing
          ? <h1 className={pageTitleClass}><LayoutTemplate className="size-4" aria-hidden />Templates</h1>
          : <nav aria-label="Breadcrumb"><a href="#/templates" className={cn(pageTitleClass, "text-muted-foreground hover:text-foreground")}><ArrowLeft className="size-4" aria-hidden />Templates</a></nav>}
      </header>
      <div data-page-body className={cn(pageBodyClass, "p-5 md:p-6")}>{body}</div>
    </section>
  );
}

/** An imported package's provenance in one line: its source, the commit it was read at, its publisher; an uploaded one
 *  (`agentrun deploy`, no publisher) its id and the start of its sha256. */
export function TemplateProvenance({ t }: { t: Pick<TemplateView, "source" | "sha" | "publisher"> }) {
  if (!t.source) return null;
  return <p className="mt-1 break-all font-mono text-small text-muted-foreground" data-provenance>{t.source} at {t.sha?.slice(0, 12)}{t.publisher ? `, published by ${t.publisher}` : ", uploaded"}</p>;
}

/** Whether a search keeps one of this server's templates, by the words its card shows. */
/** Whether a search keeps a template: by its words, and by `line`, the one line its card shows (the marketplace's summary
 *  where the marketplace lists it), so a word the card shows always finds it. */
const templateMatches = (query: string, t: TemplateView, line?: string) => matchesFilter(query, titleOf(t), t.name, t.id, t.description, line, t.publisher, t.category, t.tags.join(" "));

/** The list, with the "Add from URL" box: a package on GitHub is read and shown whole (the install page) before it is
 *  stored. Its own page lists this server's templates, then the marketplace's others (GRE-4834), under one search; the
 *  API playground's lists this server's alone, the ones an apply takes. */
function TemplateList({ v2, templates, failed, onRetry, go, playground, onRemoved }: { v2: Client; templates: TemplateView[]; failed?: Problem; onRetry?: () => void; go: (hash: string) => void; playground: boolean; onRemoved: () => void }) {
  const Heading = playground ? "h2" : "h1";
  const CardHeading = "h3";
  const market = useMarketplace(v2, !playground);
  const [search, setSearch] = useState("");
  const listed = playground ? templates : templates.filter(inCatalog);
  // A card the marketplace lists reads its one line there, as the marketplace's card does; else its description.
  const lineOf = (t: TemplateView) => market.list?.templates.find((m) => m.here === t.id)?.summary ?? t.description;
  const here = listed.filter((t) => templateMatches(search, t, lineOf(t)));
  const elsewhere = notHere(market.list);
  const others = elsewhere.filter((t) => marketplaceMatches(search, t));
  const [source, setSource] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const remove = async (t: TemplateView) => {
    setRemoving(t.id); setSaid(null);
    // The marketplace's list is read again too: its `here` marks are as of its last read, and the template removed
    // goes back to the marketplace's section, where it can be installed again.
    try { await v2.deleteTemplate(t.id); onRemoved(); market.retry(); } catch (e) { setSaid(e instanceof Error ? e.message : String(e)); } finally { setRemoving(null); }
  };
  return (
    <>
      {playground && <Heading className="mb-5 text-2xl font-semibold">Templates</Heading>}
      <form aria-label="Add from URL" className="mb-5 flex flex-wrap items-end gap-2 border bg-card px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (source.trim()) go(installHash(source.trim())); }}>
        <label className="min-w-0 flex-1">
          <span className="caps text-small font-semibold">Add from URL</span>
          <span className="mb-1.5 block text-small text-muted-foreground">A package on GitHub: github:owner/repo/path@ref, or its github.com/…/tree/… address. You read it whole before anything is stored.</span>
          <Input type="text" value={source} placeholder="github:owner/repo/templates/name@main" onChange={(e) => setSource(e.target.value)} />
        </label>
        <Button size="sm" variant="solid" type="submit" disabled={!source.trim()}>Read it</Button>
      </form>
      {said && <p className="mb-3 text-body text-destructive-text" role="alert">{said}</p>}
      {!playground && <ListFilter className="mb-5" value={search} onChange={setSearch} label="Search templates" placeholder="Search templates…" shown={here.length + others.length} total={listed.length + elsewhere.length} />}
      {!playground && <h2 className="mb-3 text-lead font-semibold">On this server</h2>}
      {failed ? <ProblemCard problem={failed} onRetry={onRetry} className="" />
        : !listed.length ? <p className="border px-4 py-12 text-center font-mono text-body text-muted-foreground">This server offers no templates yet.</p>
        : !here.length ? <p role="status" className="border px-4 py-6 text-center text-body text-muted-foreground">None of this server's templates match “{search}”.</p> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {here.map((t) => (
            <li key={t.id}>
              <article aria-label={cardTitleOf(t)} className="flex h-full flex-col border bg-card px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span data-template-icon className="flex shrink-0 self-center"><TemplateHarnessIcon harness={t.harness ?? []} /></span>
                  <CardHeading className="min-w-0 break-words text-prose font-semibold">{cardTitleOf(t)}</CardHeading>
                  <span className="font-mono text-small text-muted-foreground">{t.version}</span>
                  {t.category && <Chip tone="muted">{t.category}</Chip>}
                  {!t.bundled && <Chip tone="muted">Imported</Chip>}
                </div>
                <TemplateProvenance t={t} />
                <p className="mt-2 text-lead leading-[1.6]">{lineOf(t)}</p>
                {t.tags.length > 0 && <p aria-label="Tags" className="mt-1.5 break-words font-mono text-small text-muted-foreground">{t.tags.join(" · ")}</p>}
                <dl className="mt-3 space-y-1 font-mono text-small text-muted-foreground">
                  {cardNeeds(t).map(([what, words]) => <div key={what} className="flex items-center gap-2"><dt className="shrink-0">{what}</dt><dd className="min-w-0 break-words text-foreground/80">{words}</dd></div>)}
                </dl>
                <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-4">
                  {!t.bundled && <Button size="sm" onClick={() => void remove(t)} disabled={removing === t.id}>{removing === t.id ? "Removing…" : "Remove"}</Button>}
                  {/* Every card's buttons look the same, whatever its template needs: Configure opens its screen, where a plain
                      template's Apply is the main action, and Run hands it to a coding agent. */}
                  {playground ? <Button size="sm" variant="primary" onClick={() => go(templatePlaygroundHref(t))}>Configure</Button> : <>
                    <Button size="sm" onClick={() => go(templateHash(t.id))}>Configure</Button>
                    <CodingAgentAction variant="primary" label="Run" prompt={runTemplatePrompt(location.origin, t)} playgroundHref={templatePlaygroundHref(t)} />
                  </>}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      {!playground && <Marketplace market={market} templates={others} total={elsewhere.length} search={search} go={go} />}
    </>
  );
}

/** The marketplace's templates that are not on this server, after this server's own: each installs through the install
 *  page (read whole, its publisher trusted once) when the list names its source, else from its marketplace page. Nothing
 *  when the server reads no marketplace (off). */
function Marketplace({ market, templates, total, search, go }: { market: ReturnType<typeof useMarketplace>; templates: MarketplaceTemplate[]; total: number; search: string; go: (hash: string) => void }) {
  const { list, error, retry } = market;
  if (list?.state === "off") return null;
  const note = marketplaceNote(list);
  return (
    <section aria-labelledby="marketplace-heading" className="mt-10" data-marketplace>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="marketplace-heading" className="text-lead font-semibold">From the marketplace{templates.length > 0 ? <span className="ml-2 font-mono text-small font-normal text-muted-foreground">{templates.length}</span> : null}</h2>
        {list?.url && <a href={list.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-small text-primary-text hover:underline hover:underline-offset-4">Open the marketplace<ArrowUpRight className="size-3.5" aria-hidden /></a>}
      </div>
      {error ? <ProblemCard problem={error} onRetry={retry} className="" />
        : !list ? <ListSkeleton label="Loading the marketplace's templates" rows={2} />
        : <>
          {note && <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted-foreground" role="status">{note}<Button size="sm" onClick={retry}>Try again</Button></p>}
          {total > 0 && !templates.length && <p role="status" className="border px-4 py-6 text-center text-body text-muted-foreground">None of the marketplace's templates match “{search}”.</p>}
          {templates.length > 0 && (
            <ul className="grid gap-3 md:grid-cols-2">
              {templates.map((t) => (
                <li key={t.name}>
                  <article aria-label={t.title} className="flex h-full flex-col border bg-card px-5 py-4" data-marketplace-template={t.name}>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span data-template-icon className="flex shrink-0 self-center"><TemplateHarnessIcon harness={t.harness} /></span>
                      <h3 className="min-w-0 break-words text-prose font-semibold">{t.title}</h3>
                      {t.category && <Chip tone="muted">{t.category}</Chip>}
                    </div>
                    <p className="mt-2 line-clamp-3 text-lead leading-[1.6]">{marketplaceLine(t)}</p>
                    {t.needs.length > 0 && <ul aria-label="Needs" className="mt-3 space-y-1 font-mono text-small text-muted-foreground">{t.needs.map((n) => <li key={n}>{n}</li>)}</ul>}
                    {/* Its harnesses as this server's cards draw them, when the list says. */}
                    {!!t.harness?.length && <dl className="mt-1 font-mono text-small text-muted-foreground"><div className="flex items-center gap-2"><dt className="shrink-0">Harness</dt><dd className="min-w-0"><HarnessIcons ids={t.harness} /></dd></div></dl>}
                    <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-4">
                      {/* With its source, Install reads the package here first (the install page); with none, its page installs it. */}
                      {t.source ? <>
                        <a href={t.page_url} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>Details<ArrowUpRight className="size-3.5" aria-hidden /></a>
                        <Button size="sm" variant="primary" onClick={() => go(installHash(t.source!))}>Install</Button>
                      </> : <a href={t.page_url} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm", variant: "primary" })}>Install from the marketplace<ArrowUpRight className="size-3.5" aria-hidden /></a>}
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </>}
    </section>
  );
}

/** A package on GitHub read before it is installed (a dry run): its publisher, the commit, what it makes, its instructions
 *  and every skill file in full. The first package from a publisher installs only once "I trust <owner>" is ticked; the
 *  server keeps that. Install stores it and opens its Apply screen, where nothing is granted until it is ticked. */
function InstallTemplate({ v2, source, go }: { v2: Client; source: string; go: (hash: string) => void }) {
  const [read, setRead] = useState<TemplateImported | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!source) { setError("Give a package's source: github:owner/repo/path@ref."); return; }
    v2.importTemplate(source, { dryRun: true }).then((r) => { if (live) setRead(r); }, (e) => { if (live) setError(refusalText(e)); });
    return () => { live = false; };
  }, [v2, source]);
  const install = async () => {
    setInstalling(true); setSaid(null);
    try {
      // The commit the preview showed, never the ref again: a branch moved since is not what the owner read.
      if (!read) return;
      const done = await v2.importTemplate(`${read.template.id}@${read.template.sha}`, { trustPublisher: trusted });
      go(templateHash(done.template.id));
    } catch (e) { setSaid(refusalText(e)); } finally { setInstalling(false); }
  };
  if (error) return <div className="max-w-3xl"><p className="border px-4 py-6 font-mono text-body text-destructive-text" role="alert">{error}</p></div>;
  if (!read) return <ListSkeleton label="Reading the package from GitHub" rows={3} />;
  const t = read.template;
  const owner = t.publisher ?? "";
  const files = Object.entries(read.skill_files);
  return (
    <section aria-label="Install from GitHub" className="max-w-3xl">
      <h1 className="font-mono text-2xl font-semibold">{titleOf(t)} <span className="text-lead font-normal text-muted-foreground">{t.version}</span></h1>
      <dl className="mt-3 space-y-1 border bg-card px-4 py-3 font-mono text-small">
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Publisher</dt><dd data-publisher>{owner}{read.publisher_trusted ? " (trusted here)" : " (new here)"}</dd></div>
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Commit</dt><dd className="break-all" data-sha>{t.sha}</dd></div>
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Source</dt><dd className="break-all">{t.source}</dd></div>
        <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">Installs as</dt><dd className="break-all">{t.id}{read.replaced ? `, replacing the one read at ${read.replaced.slice(0, 12)}` : ""}</dd></div>
      </dl>
      <p className="mt-3 text-lead leading-[1.6]">{t.description}</p>
      <Section title="What it makes">
        <dl className="space-y-1 px-4 py-3 font-mono text-small">
          {withHarnessIcons(needsOf(t), t).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{what}</dt><dd className="min-w-0 break-words">{words}</dd></div>)}
        </dl>
      </Section>
      {t.mcp.length > 0 && (
        <Section title="MCP tools it asks for" note="None is granted by installing: the Apply screen asks you to tick each one.">
          {t.mcp.map((m) => (
            <div key={m.toolkit} data-mcp={m.toolkit} className="px-4 py-3">
              <NeedHead m={m} />
              <p className="mt-1 break-words font-mono text-small">{m.tools.map((x) => x.name).join(", ")}</p>
            </div>
          ))}
        </Section>
      )}
      <RunInputs t={t} />
      <EvalCases t={t} />
      {read.workflow ? (
        // A workflow package's agent has no instructions of its own: each node of its workflow carries its own.
        <Section title="Workflow" note={`What the agent runs (${t.workflow}), in full: each step's instructions are what that step is told.`}>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-small" data-workflow>{JSON.stringify(read.workflow, null, 2)}</pre>
        </Section>
      ) : (
        <Section title="Instructions" note="What the agent is told, in full: a package from someone else says this to your agent.">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-small" data-instructions>{read.instructions}</pre>
        </Section>
      )}
      {t.output?.json_schema && (
        // Each run is told the answer's schema whole (its output contract), each description in it included.
        <Section title="Output schema" note={`What the agent is told to answer in (${t.output.schema}), in full: its descriptions are instructions too.`}>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-small" data-output-schema>{JSON.stringify(t.output.json_schema, null, 2)}</pre>
        </Section>
      )}
      {files.length > 0 && (
        <Section title="Skill files" note="Every file the agent is given, in full.">
          {files.map(([path, text]) => (
            <details key={path} className="px-4 py-2" data-skill-file={path}>
              <summary className="cursor-pointer font-mono text-body">{path}</summary>
              <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-small">{text}</pre>
            </details>
          ))}
        </Section>
      )}
      {!read.publisher_trusted && (
        <label className="mt-6 flex items-start gap-2.5 border border-warning/50 px-4 py-3">
          <input type="checkbox" className="mt-1 accent-primary" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          <span><span className="font-mono text-body">I trust {owner}</span><span className="block text-small text-muted-foreground">This server has no package from {owner} yet. Ticked, it remembers that you trust them.</span></span>
        </label>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="solid" onClick={() => void install()} disabled={installing || (!read.publisher_trusted && !trusted)}>{installing ? "Installing…" : "Install"}</Button>
        <span className="text-small text-muted-foreground">Installing stores it; nothing runs and nothing is granted until you apply it.</span>
        {said && <p className="w-full text-body text-destructive-text" role="alert">{said}</p>}
      </div>
    </section>
  );
}

/** A refusal in the server's words: its message, and each field's, each sentence once (a 422's message is its first
 *  field's when it names no other). */
function refusalText(e: unknown): string {
  if (e instanceof ClientError && e.fields?.length) return [...new Set([e.message, ...e.fields.map((i) => i.message)])].join(" ");
  return e instanceof Error ? e.message : String(e);
}

export const installHash = (source: string) => `#/templates/install?src=${encodeURIComponent(source)}`;


/** One template's Apply screen: its parameters, the owner's consent (one tick per MCP tool, none ticked until the owner
 *  ticks it), and what it needs. Apply sends the parameters as typed and the ticks as `grants`, under one Idempotency-Key a
 *  retry reuses. A refusal is the server's words at its field; a made agent opens, or, with warnings or a schedule, they
 *  show first: a schedule with when it runs and its next run, as the Triggers page says them. */
/** How long the Apply page waits on one of its new triggers' read-back before it leaves that trigger out. */
export const TRIGGER_READ_MS = 3_000;
/** What an apply did to its agent, as its answer says it (agent_change, revision_version): the title's last word and the
 *  sentence above its warnings. An Update that changed nothing wrote no revision, and says so. */
const CHANGE_WORDS: Record<TemplateApplied["agent_change"], { title: string; said: (rev: number) => string }> = {
  made: { title: "applied", said: () => "The agent is made" },
  updated: { title: "updated", said: (rev) => `Updated: rev ${rev}` },
  unchanged: { title: "unchanged", said: (rev) => `Nothing to update: rev ${rev} is current` },
};
/** `promise`'s answer, or undefined once `ms` have passed without one. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function ApplyTemplate({ v2, template: t, go, playground = false, draft, model: linked, freeIds }: Props & { template: TemplateView; model?: string; freeIds?: readonly string[] }) {
  const Heading = playground ? "h2" : "h1";
  const form = { fields: schemaFields(t.parameters) ?? [], contentRequired: false };
  const prepared = readTemplateDraft(draft, t);
  // The agent's model as the link set it, or as a prepared request carries it (the playground opened from Use free).
  const model = linked ?? prepared.body?.overrides?.model;
  // A link sets `?model=` (the Free shelf's Use free sends a free one), and a prepared request carries it on: one this
  // server does not offer free may cost money, on either.
  const unfree = model !== undefined && freeIds !== undefined && !freeIds.includes(model);
  // Shared compiled fields supply defaults; an explicit prepared false, zero or list stays the reviewed choice.
  const [values, setValues] = useState<ParameterText>(() => ({ ...Object.fromEntries(form.fields.filter(([, field]) => field.type === "boolean" && !field.array).map(([key]) => [key, "false"])), ...fieldStartText(form), ...Object.fromEntries(Object.entries(prepared.body?.parameters ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.map(String).join("\n") : String(value)])) }));
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(prepared.body?.grants ?? []));
  // The agent's approvals, sent as overrides.approvals: the template's own (approvals_default: never for one that runs
  // on its triggers with no one there), which the owner can switch.
  const [approvals, setApprovals] = useState<Approvals>(prepared.body?.overrides?.approvals ?? t.approvals_default ?? "ask");
  // The selected package model remains part of both the handoff and the explicit Apply request.
  const [choice, setChoice] = useState(prepared.body?.overrides?.choice ?? "");
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [serversError, setServersError] = useState<Problem | null>(null);
  const [serversTries, setServersTries] = useState(0);
  // The owner's pick, by toolkit, for a need several saved servers match (none picked: the apply's default).
  const [picks, setPicks] = useState<Record<string, string>>(() => prepared.body?.servers ?? {});
  const [applying, setApplying] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  // The refusal's own words beside Apply; `withIssues` when it came with issues, so it goes once the last of them does.
  const [said, setSaid] = useState<{ text: string; withIssues: boolean } | null>(null);
  const [made, setMade] = useState<TemplateApplied | null>(null);
  // The schedules the apply made, each read back (GET /triggers/{id}) for its line and next run.
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  // The parameters an apply sent: what its "applied" title names, whatever was typed while it was under way.
  const [sentValues, setSentValues] = useState<ParameterText>({});
  const keys = useRef(keeper()).current;
  // The agents here this template made (GET /agents, `template.id`): each is offered as Update <agent> beside Apply, which
  // applies onto it (agent_id) in place of making another. A read that fails offers none; Apply still works.
  const [mine, setMine] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    // Every page, to the list's end: an agent it made far down the list is offered too.
    allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents, Number.POSITIVE_INFINITY)
      .then((agents) => agents.filter((a) => a.template?.id === t.id).map((a) => ({ id: a.agent_id, name: a.definition?.name || a.agent_id })))
      .then((found) => { if (live) setMine(found); }, () => {});
    return () => { live = false; };
  }, [v2, t.id]);
  // Whether this page is still the one shown: an Apply that answers after the owner left never takes them anywhere.
  const shown = useRef(true);
  // Set on every setup, not only the first: StrictMode runs setup, cleanup, then setup again.
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  // The MCP servers saved here (GET /v2/settings/mcp-servers): which of them each of the template's needs maps to. A read
  // that fails is said with Try again, and Apply waits for the list.
  useEffect(() => {
    let live = true;
    setServersError(null);
    v2.listMcpServers().then((r) => { if (live) setServers(r.servers); }, (e) => { if (live) setServersError(problem(e, "the saved MCP servers")); });
    return () => { live = false; };
  }, [v2, serversTries]);
  const grants = grantsOf(t, ticked);
  // Each need's matching servers, and the one it uses: its one match, else the owner's pick among several (never one picked
  // for them: the apply refuses several with no pick).
  const mapped = t.mcp.map((m) => { const matches = servers ? matchesOf(m, servers) : []; return { m, matches, uses: matches.length === 1 ? matches[0] : matches.includes(picks[m.toolkit] ?? "") ? picks[m.toolkit] : undefined }; });
  // Sent for every need the screen shows a server for, one match too, so the server shown is the one the agent gets: one
  // deleted and replaced by another match before Apply is refused, never swapped in.
  const chosen = Object.fromEntries(mapped.flatMap(({ m, uses }) => (uses ? [[m.toolkit, uses]] : [])));
  // A need several servers match that the owner hasn't picked one for: Apply waits for the pick.
  const unpicked = mapped.filter(({ matches, uses }) => matches.length > 1 && !uses).map(({ m }) => m.toolkit);
  // A template with MCP needs waits for the saved servers to be read: until then no need is mapped or picked.
  const unread = t.mcp.length > 0 && servers === null;
  // A prepared account choice remains pinned: another matching account is not a replacement for reviewed consent.
  const staleServers = servers && mapped.some(({ m, matches }) => prepared.body?.servers?.[m.toolkit] !== undefined && !matches.includes(prepared.body.servers[m.toolkit]));
  const draftError = prepared.error ?? (staleServers ? "This prepared server choice no longer matches the saved MCP servers. Open a fresh request to review the current accounts." : undefined);
  const blocked = !!draftError || unread || unpicked.length > 0;
  // A plain template is applied here, outside the playground too; any other is run with a coding agent there.
  const applies = playground || isPlain(t);
  // What the apply would refuse that the screen can read first (a saved mailbox), on a plain template outside the
  // playground (the playground shows the server's own answer): Apply waits for each. A failed read is said with Try again.
  const needed = !playground && isPlain(t) ? APPLY_REQUIREMENTS.filter((r) => r.needs(t)) : [];
  const [held, setHeld] = useState<Record<string, "met" | "unmet" | "unread">>({});
  const [heldTries, setHeldTries] = useState(0);
  const neededIds = needed.map((r) => r.id).join(" ");
  // Each read again keeps the last answer shown until the new one comes.
  useEffect(() => {
    let live = true;
    for (const r of APPLY_REQUIREMENTS.filter((x) => neededIds.split(" ").includes(x.id))) {
      r.met(v2).then((ok) => { if (live) setHeld((was) => ({ ...was, [r.id]: ok ? "met" : "unmet" })); }, () => { if (live) setHeld((was) => ({ ...was, [r.id]: "unread" })); });
    }
    return () => { live = false; };
  }, [v2, neededIds, heldTries]);
  const waiting = needed.filter((r) => held[r.id] !== "met");
  const reading = waiting.find((r) => held[r.id] === undefined);
  // One set up in another tab (a mailbox saved under Settings → Email) is read again when this window is back in focus.
  const someWaiting = waiting.length > 0;
  useEffect(() => {
    if (!someWaiting) return;
    const again = () => setHeldTries((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [someWaiting]);
  const body = { parameters: fieldValues(form, values), ...(grants.length ? { grants } : {}), ...(Object.keys(chosen).length ? { servers: chosen } : {}), overrides: { approvals, ...(model ? { model } : choice ? { choice } : {}) } };
  const at = (field: string) => issuesAt(issues, field);
  // A parameter's value as typed or picked: an issue at it goes as soon as the value is one the server takes.
  const setParam = (key: string, p: FieldSpec, value: string) => {
    setValues((was) => ({ ...was, [key]: value }));
    if (fieldValid(p, value)) setIssues((was) => was.filter((i) => fieldOfIssue(i.field, "parameters") !== key));
  };
  // `onto`: the agent an Update applies onto (agent_id); none, a new agent.
  const apply = async (onto?: string) => {
    if (!applies || blocked || waiting.length) return;
    setApplying(true); setIssues([]); setSaid(null);
    const sending = values;
    const sent = onto ? { ...body, agent_id: onto } : body;
    try {
      const done = await v2.applyTemplate(t.id, sent, keys.keyFor(t.id, sent));
      keys.done();
      // Each schedule the apply made, read back for when it runs next. One that can't be read, or isn't answered within
      // TRIGGER_READ_MS, is said by the answer's words alone: a slow read never holds the result back.
      const schedulesOf = async (): Promise<Schedule[]> => {
        const read = await Promise.all(done.triggers.filter((x) => x.kind === "schedule").map((x) => bounded(v2.getTrigger(x.trigger_id), TRIGGER_READ_MS).catch(() => null)));
        return read.filter((x): x is Schedule => x !== null && x !== undefined && isScheduleTrigger(x));
      };
      // An apply that changed the agent, made no trigger and says nothing more opens the agent at once. One that changed
      // nothing (agent_change unchanged) says so first.
      if (!shown.current) return;
      if (done.agent_change !== "unchanged" && !done.warnings.length && !done.webhook_secrets?.length && !done.triggers.length) { go(agentHash(done.agent_id)); return; }
      // Otherwise its result is shown at once, in the answer's words for what it did (CHANGE_WORDS): a warning, a webhook's
      // once-shown secret, and every trigger it made or kept (the answer's own list); a schedule's line and next run are
      // added as it is read back.
      setSentValues(sending);
      setMade(done);
      if (done.triggers.some((x) => x.kind === "schedule")) void schedulesOf().then((read) => { if (shown.current) setSchedules(read); }, () => {});
    } catch (e) {
      if (e instanceof ClientError && e.fields?.length) {
        setIssues(e.fields); setSaid({ text: e.message, withIssues: true });
        // A server choice refused (one deleted or changed while the page was open): the saved servers are read again, so
        // the screen and the next Apply show what is saved now.
        if (e.fields.some((i) => i.field.startsWith("servers.") || i.field.startsWith("mcp."))) setServersTries((n) => n + 1);
      }
      else setSaid({ text: e instanceof Error ? e.message : String(e), withIssues: false });
    } finally { setApplying(false); }
  };
  const params = form.fields;
  // Issues the form has no place for (a trigger's, an override's) show above the button, in the server's words.
  // A choice's keys beyond the package's own: shown under that choice when it is the one picked.
  const choiceKeys = (secrets: readonly string[]) => secrets.filter((s) => !t.secrets.includes(s));
  const picked = t.model?.choices?.find((c) => c.id === choice);
  const placed = (i: FieldIssue) => /^(parameters|mcp|servers)\./.test(i.field) || /^grants\.\d+$/.test(i.field) || (i.field === "overrides.choice" && !!t.model?.choices?.length) || (i.field === "overrides.model" && !!model)
    || (i.field.startsWith("secrets.") && [...t.secrets, ...choiceKeys(picked?.secrets ?? [])].includes(i.field.slice("secrets.".length)));
  if (made) {
    const change = CHANGE_WORDS[made.agent_change];
    return (
      <section aria-label="Applied" className="max-w-page">
        <Heading className="mb-4 flex items-center gap-2 text-2xl font-semibold"><Check className="size-5 text-success-text" aria-hidden /> {titleOf(t, sentValues)} {change.title}</Heading>
        {made.agent_change !== "made" && made.warnings.length === 0 && <p className="mb-3 text-lead">{change.said(made.revision_version)}.</p>}
        {made.warnings.length > 0 && <>
          <p className="mb-3 text-lead">{change.said(made.revision_version)}. The server says:</p>
          <ul className="mb-5 space-y-2 border bg-card px-4 py-3 text-body" role="status" aria-label="Warnings">
            {made.warnings.map((w, i) => (
              <li key={`${w.field}:${i}`}><span className="font-mono text-small text-muted-foreground">{w.field}</span> {w.message}{w.fix ? <span className="block text-muted-foreground">{w.fix}</span> : null}</li>
            ))}
          </ul>
        </>}
        {/* Each webhook trigger the apply made: its signing secret this once, in the first answer to this session (held in
            this screen's state alone, never stored or logged), beside its URL; else the server's note and the trigger to
            rotate it from. */}
        {made.webhook_secrets?.map((x) => {
          const named = made.triggers.find((one) => one.trigger_id === x.trigger_id)?.name;
          const name = named || x.trigger_id;
          return x.signing_secret
            ? <SecretOnce key={x.trigger_id} label={`The webhook's URL and secret (${name})`} url={hookUrlOf({ id: x.trigger_id })} secret={x.signing_secret} />
            : (
              <div key={x.trigger_id} className="mt-4 border px-4 py-3 text-body">
                {x.note && <p className="text-muted-foreground" role="note">{x.note}</p>}
                <a href={`#/triggers/${encodeURIComponent(x.trigger_id)}`} className="mt-1 block font-mono text-small text-primary-text underline-offset-2 hover:underline">Open {name} to get its signing secret (Rotate)</a>
              </div>
            );
        })}
        {/* Every trigger the apply made or kept, of any kind, by the package's name for it: what starts it in words and
            whether it is on. A schedule read back says its line and next run (scheduleLine), as the Triggers page does. A
            webhook with no webhook_secrets item (one the apply kept) says its page is where its secret is. */}
        {made.triggers.length > 0 && (
          <ul className="mt-4 divide-y border" aria-label="Triggers">
            {made.triggers.map((x) => {
              const s = schedules.find((one) => one.id === x.trigger_id);
              const kept = x.kind === "webhook" && !made.webhook_secrets?.some((one) => one.trigger_id === x.trigger_id);
              return (
                <li key={x.trigger_id} data-trigger={x.trigger_id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={`#/triggers/${encodeURIComponent(x.trigger_id)}`} className="break-words text-prose font-semibold hover:underline">{x.name}</a>
                    {kept && <span className="text-small text-muted-foreground">Open it to get its signing secret (Rotate)</span>}
                    <Chip tone={x.enabled ? "success" : "plain"}>{x.enabled ? "on" : "off"}</Chip>
                  </div>
                  {/* Its kind and what starts a run of it, as the Triggers page says each kind. */}
                  <p className="mt-1 break-words text-body">{TRIGGER_KINDS[x.kind].label} · {TRIGGER_KINDS[x.kind].what}{x.enabled ? "" : " It is off: it starts nothing until it is turned on."}</p>
                  {s && <p className="mt-1 break-words font-mono text-small text-muted-foreground">{scheduleLine(s.source, s.next_at)}</p>}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-5" />
        <a href={agentHash(made.agent_id)} className="inline-flex border px-3 py-2 font-mono text-body font-semibold hover:bg-accent">Open the agent</a>
      </section>
    );
  }
  return (
    <div>
      {playground && <a href={catalogHash(playground)} className="caps mb-4 inline-flex min-h-6 items-center gap-1.5 text-small text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Templates</a>}
      <Heading className="text-2xl font-semibold">{titleOf(t, values)} <span className="text-lead font-normal text-muted-foreground">{t.version}</span></Heading>
      <TemplateProvenance t={t} />
      <p className="mt-2 max-w-prose text-lead leading-[1.6]">{t.description}</p>
      <p className="mt-2 text-body text-muted-foreground">{playground ? "Apply creates an agent and its triggers. It does not start a run." : applies ? "Apply creates an agent and its triggers. It does not start a run. Or set it up with your coding agent, which asks for any missing inputs and runs the task." : "Run with your coding agent. It sets up this template, asks for any missing inputs, and runs the task."}</p>
      {draftError && <p className="mt-3 text-body text-destructive-text" role="alert">{draftError} <a href={templatePlaygroundHref(t)} className="underline">Open a fresh request</a>.</p>}

      <div className={`mt-6 ${formColumnsClass}`}>
      {params.length > 0 && (
        <Section title="Parameters">
          {params.map(([key, p]) => (
            <div key={key} data-field={`parameters.${key}`} className="px-4 py-3">
              <FieldInput field={p} label={fieldLabel(key, p)} help={paramHelp(p)} value={values[key] ?? ""} onChange={(v) => setParam(key, p, v)} />
              <Issues issues={issues.filter((i) => fieldOfIssue(i.field, "parameters") === key)} words={(i) => fieldIssueWords(i, key, p)} />
            </div>
          ))}
        </Section>
      )}

      {t.mcp.length > 0 && (
        <Section title="Tools you grant" note="Nothing is granted until you tick it. A tool you tick is granted and follows this server's tool settings: a write asks you first unless you allowed it in Settings or choose Never ask, and a read runs without asking where you turned on Allow reads for its server. A tool you leave unticked is not given to the agent, even when it never asks: you can add it later on the agent's page.">
          {serversError && !servers && (
            <div data-servers-unread className="px-4 py-3"><ProblemCard problem={serversError} onRetry={() => setServersTries((n) => n + 1)} className="" /></div>
          )}
          {mapped.map(({ m, matches, uses }) => (
            <div key={m.toolkit} data-mcp={m.toolkit} className="px-4 py-3">
              <NeedHead m={m}>
                {servers && matches.length < 2 && <span className="text-small text-muted-foreground">{uses ? `Uses ${uses}` : "Not set up here"}</span>}
              </NeedHead>
              {/* Several saved servers are this source and toolkit (two Gmail accounts): the owner picks one, none picked to
                  start, and Apply waits for it. */}
              {servers && matches.length > 1 && (
                <label className="mt-2 flex flex-wrap items-center gap-2 text-small text-muted-foreground">Uses
                  <Picker small label={`Server for ${m.toolkit}`} value={uses ?? ""} placeholder="Pick one" onChange={(v) => setPicks((was) => ({ ...was, [m.toolkit]: v }))} options={matches.map((s) => ({ value: s, label: s }))} />
                  {!uses && <span data-unpicked={m.toolkit}>{matches.length} saved servers are {SOURCE_LABEL[m.source]} {m.toolkit}: pick the one the agent uses.</span>}
                </label>
              )}
              {/* A need no saved server matches: said before Apply, with the way to set it up, so an agent is never made without
                  its tools unseen. Composio's opens the preset with its toolkit and actions; GitHub's is set up as a GitHub App. */}
              {servers && matches.length === 0 && (
                <p role="status" data-missing-mcp={m.toolkit} className="mt-2 border border-warning/50 px-3 py-2 text-small text-warning-text">
                  {m.required ? `${m.toolkit} is required and not set up here: Apply is refused until it is.` : `${m.toolkit} is not set up here: Apply makes the agent without its tools (${m.tools.map((x) => x.name).join(", ")}).`}{" "}
                  <a href={setUpHref(m)} className="font-mono text-primary-text underline underline-offset-2 hover:decoration-2">{m.source === "github" ? "Set up GitHub App access" : m.source === "composio" ? `Add ${m.toolkit} from Composio` : `Set up ${m.toolkit}`}</a>
                </p>
              )}
              <Issues issues={[...at(`mcp.${m.toolkit}`), ...at(`servers.${m.toolkit}`)]} />
              <ul className="mt-2 space-y-2">
                {m.tools.map((tool) => {
                  const index = grants.indexOf(tool.tool);
                  return (
                    <li key={tool.tool} data-tool={tool.tool}>
                      <label className="flex items-start gap-2.5">
                        <input type="checkbox" className="mt-1 accent-primary" checked={ticked.has(tool.tool)} onChange={() => setTicked((s) => { const n = new Set(s); if (n.has(tool.tool)) n.delete(tool.tool); else n.add(tool.tool); return n; })} />
                        <span className="min-w-0">
                          <span className="font-mono text-body">{tool.name}</span> <span className="font-mono text-label text-muted-foreground">{tool.tool}</span>
                          {/* A tick is a grant, with no permission set: the section's note says what a granted tool then does.
                              Every tool the package lists is one the template uses, so each row asks for it; `asks: "ask"`
                              (a write) only means each of its calls waits for approval, said in one clause. */}
                          <span className="block text-small text-muted-foreground">The template asks you to grant this.{tool.asks === "ask" && " Each call waits for your OK unless you allowed it in Settings or pick Never ask."}</span>
                        </span>
                      </label>
                      {index >= 0 && <Issues issues={at(`grants.${index}`)} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </Section>
      )}

      {t.secrets.length > 0 && (
        <Section title="Keys it uses" note="Saved on this server by name; a run is given them.">
          {t.secrets.map((s) => (
            <div key={s} data-secret={s} className="px-4 py-3 font-mono text-body">{s}<Issues issues={at(`secrets.${s}`)} /></div>
          ))}
        </Section>
      )}

      {model ? (
        // The agent's model is set (the Free shelf's Use free): apply takes it in place of the package's, and no choice
        // goes with it (the two together are 422).
        <section aria-label="Model" className="mt-6">
          <h2 className="caps text-small font-semibold">Model</h2>
          <p className="mt-2 border px-4 py-3 font-mono text-body" data-model-override title={model}>{modelLabel(model, null).text}</p>
          {unfree && <p role="status" data-model-unfree className="mt-2 text-body text-warning-text">This model came from the link and is not one of this server's free models: its runs may cost money.</p>}
          <Issues issues={at("overrides.model")} />
        </section>
      ) : t.model?.choices?.length ? (
        // The package's default model first, then each choice by its label. A choice's warning and note show under it
        // whether it is picked or not, word for word: the owner reads them before choosing.
        <fieldset aria-label="Model" className="mt-6">
          <legend className="caps text-small font-semibold">Model</legend>
          <div className="mt-2 divide-y border">
            {/* The default's harness is the first of the package's list this server runs, which the form can't know: one
                harness is named, several are said as the list apply picks from. A choice's id is kebab, so "(default)"
                is no choice's. */}
            {[{ id: "", label: `Your default: ${t.model.tier} on ${!t.harness?.length ? "this server's default harness" : t.harness.length === 1 ? t.harness[0] : `the first of ${t.harness.join(", ")} this server runs`}`, warning: null, note: null }, ...t.model.choices].map((c) => (
              <label key={c.id || "(default)"} data-choice={c.id || "(default)"} className="flex items-start gap-3 px-4 py-3">
                <input type="radio" name="model-choice" value={c.id} className="mt-1 accent-primary" checked={choice === c.id} onChange={() => { setChoice(c.id); setIssues((was) => was.filter((i) => i.field !== "overrides.choice" && !(i.field.startsWith("secrets.") && !t.secrets.includes(i.field.slice("secrets.".length))))); }} />
                <span className="min-w-0">
                  <span className="font-mono text-body" data-choice-label>{c.label}</span>
                  {"model" in c && <span className="block font-mono text-label text-muted-foreground">{c.model} on {c.harness}</span>}
                  {c.warning && <span className="mt-1 block text-small text-warning-text" data-choice-warning={c.id}>{c.warning}</span>}
                  {c.note && <span className="mt-1 block text-small text-muted-foreground" data-choice-note={c.id}>{c.note}</span>}
                  {/* A key the picked choice alone needs, refused at apply: its words and fix here, under the choice. */}
                  {"secrets" in c && choice === c.id && <span data-choice-keys={c.id}><Issues issues={choiceKeys(c.secrets).flatMap((s) => at(`secrets.${s}`))} /></span>}
                </span>
              </label>
            ))}
          </div>
          <Issues issues={at("overrides.choice")} />
        </fieldset>
      ) : null}

      <fieldset aria-label="Tool approvals" className="mt-6">
        <legend className="caps text-small font-semibold">Tool approvals</legend>
        <div className="mt-2 divide-y border">
          {([["ask", "Ask me", "A tool set to ask waits for your OK before it runs: a ticked tool's write unless you allowed it in Settings, and its read unless you turned on Allow reads for its server."], ["never", "Never ask (run unattended)", "Runs without asking you, even for writes. Pick this if a trigger starts the agent while you're away."]] as const).map(([value, label, note]) => (
            <label key={value} className="flex items-start gap-3 px-4 py-3">
              <input type="radio" name="approvals" value={value} className="mt-1 accent-primary" checked={approvals === value} onChange={() => setApprovals(value)} />
              <span><span className="font-mono text-body">{label}</span><span className="block text-small text-muted-foreground">{note}</span></span>
            </label>
          ))}
        </div>
        {approvals === "never" && <p className="mt-2 text-small text-warning-text">{NEVER_ASK_LINE}</p>}
      </fieldset>

      <RunInputs t={t} />
      <EvalCases t={t} />

      <Section title="What it makes">
        <dl className="space-y-1 px-4 py-3 font-mono text-small">
          {withHarnessIcons(needsOf(t, { secrets: false }), t).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{what}</dt><dd className="min-w-0 break-words">{words}</dd></div>)}
        </dl>
      </Section>

      </div>

      <div className="mt-1 flex flex-wrap items-center gap-3">
        {applies ? <>
          <Button size="sm" variant="primary" onClick={() => void apply()} disabled={applying || blocked || waiting.length > 0} title={unread ? (serversError ? "The saved MCP servers couldn't be read: try again first" : "Reading the saved MCP servers…") : unpicked.length ? `Pick the server for ${unpicked.join(", ")} first` : reading ? `Reading ${reading.what}…` : undefined}>{applying ? "Applying…" : "Apply"}</Button>
          {mine.map((a) => {
            // Agents this template made keep its name unless renamed: two or more of one name each say their id too.
            const named = mine.filter((b) => b.name === a.name).length > 1 ? `${a.name} (${a.id})` : a.name;
            return <Button key={a.id} size="sm" variant="outline" onClick={() => void apply(a.id)} disabled={applying || blocked || waiting.length > 0} title={`Apply this template onto ${named}: a new revision of it, its runs, notes and triggers kept`}>{`Update ${named}`}</Button>;
          })}
          {!playground && <CodingAgentAction variant="outline" label="Set it up with an agent" disabled={blocked} prompt={runTemplatePrompt(location.origin, t, body)} playgroundHref={templatePlaygroundHref(t, body)} />}
          {waiting.map((r) => held[r.id] === "unmet"
            ? <p key={r.id} role="status" data-requirement={r.id} className="min-w-0 text-body text-warning-text">{r.unmet.before}<a href={r.unmet.href} className="font-mono text-primary-text underline-offset-2 hover:underline">{r.unmet.link}</a>{r.unmet.after}</p>
            : held[r.id] === "unread"
              ? <p key={r.id} role="alert" data-requirement-unread={r.id} className="flex min-w-0 flex-wrap items-center gap-2 text-body text-destructive-text">{`${r.what[0].toUpperCase()}${r.what.slice(1)} couldn't be read.`}<Button size="sm" onClick={() => setHeldTries((n) => n + 1)}>Try again</Button></p>
              : null)}
        </> : <CodingAgentAction variant="primary" label="Run" disabled={blocked} prompt={runTemplatePrompt(location.origin, t, body)} playgroundHref={templatePlaygroundHref(t, body)} />}
        {said && (!said.withIssues || issues.length > 0) && <p className="min-w-0 flex-1 text-body text-destructive-text" role="alert">{said.text}</p>}
      </div>
      {issues.filter((i) => !placed(i)).length > 0 && <div className="mt-2"><Issues issues={issues.filter((i) => !placed(i))} named /></div>}
    </div>
  );
}

type Need = TemplateView["mcp"][number];
/** An MCP need's head, on the Install and Apply screens alike: its toolkit, source, Required or Optional, and the reason the
 *  template gives for it. `children`: what the screen says beside it (the server it uses here). */
function NeedHead({ m, children }: { m: Need; children?: ReactNode }) {
  return (
    <>
      <p className="flex flex-wrap items-center gap-2 font-mono text-body">
        <span className="font-semibold">{m.toolkit}</span>
        <Chip tone="muted">{SOURCE_LABEL[m.source]}</Chip>
        <Chip tone={m.required ? "plain" : "muted"}>{m.required ? "Required" : "Optional"}</Chip>
        {children}
      </p>
      {m.reason && <p className="mt-1 text-small text-muted-foreground" data-reason>{m.reason}</p>}
    </>
  );
}

/** The typed input each run takes (its input_schema), in the run form's words: each field's label (its key beside a
 *  title), what it takes, Required or Optional, and its help. A schema the form can't draw as fields is shown whole; a
 *  template with none takes a message, and says nothing here. */
function RunInputs({ t }: { t: TemplateView }) {
  if (!t.input_schema) return null;
  const fields = schemaFields(t.input_schema, "content");
  if (fields && !fields.length) return null;
  return (
    <Section title="Run inputs" note="What each run is given, as the run form asks for it.">
      {fields ? fields.map(([key, f]) => (
        <div key={key} data-input={key} className="px-4 py-3">
          <p className="flex flex-wrap items-center gap-2 font-mono text-body">
            <span className="font-semibold">{fieldLabel(key, f)}</span>
            {f.title && <span className="text-small text-muted-foreground">{key}</span>}
            <Chip tone="muted">{fieldKind(f)}</Chip>
            <Chip tone={f.required ? "plain" : "muted"}>{f.required ? "Required" : "Optional"}</Chip>
          </p>
          {paramHelp(f) && <p className="mt-1 text-small text-muted-foreground">{paramHelp(f)}</p>}
        </div>
      )) : <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-small" data-input-schema>{JSON.stringify(t.input_schema, null, 2)}</pre>}
    </Section>
  );
}

/** The package's eval cases (evals/<case>/), by name: what the template is tested on. */
function EvalCases({ t }: { t: TemplateView }) {
  const n = t.evals.length;
  return (
    <Section title="Eval cases" note={n ? `The ${n === 1 ? "one case" : `${n} cases`} this template is tested on.` : undefined}>
      <p className="break-words px-4 py-3 font-mono text-small" data-evals>{n ? t.evals.join(", ") : "None: this package ships no eval cases, so nothing tests it."}</p>
    </Section>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-6">
      <h2 className="caps text-small font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-small text-muted-foreground">{note}</p>}
      <div className="mt-2 divide-y border">{children}</div>
    </section>
  );
}

