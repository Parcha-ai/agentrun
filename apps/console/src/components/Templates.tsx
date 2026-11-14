import { ArrowLeft, Check, LayoutTemplate } from "lucide-react";
import { Picker } from "@/components/ui/picker";
import { ScheduleWhen } from "@/components/ScheduleWhen";
import { ZonePicker } from "@/components/ZonePicker";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { SecretOnce } from "@/components/Schedules";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/field";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { keeper } from "@/lib/idempotency";
import { hookUrlOf, isScheduleTrigger, type Schedule, scheduleLine } from "@/lib/schedules";
import { type Problem, problem } from "@/lib/problem";
import { choiceOptions, grantsOf, issuesAt, needsOf, paramHelp, paramIssueWords, paramLabel, parametersOf, paramValid, type ParameterText, startValues, templateHash, titleOf } from "@/lib/templatePackages";
import { type Approvals, NEVER_ASK_LINE, type TemplateApplied, type TemplateImported, type TemplateView } from "@/lib/v2";

type Props = { v2: Client; go: (hash: string) => void };

/** The server's templates (GET /v2/templates): the list (no `name`), one template's Apply screen (`name`, its id), or a
 *  package on GitHub read before it is installed (`install`, its source). */
export function TemplatesPage({ v2, name, install, go }: Props & { name?: string; install?: string }) {
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
  if (install !== undefined) return <div className="p-5 md:p-8"><InstallTemplate v2={v2} source={install} go={go} /></div>;
  const shown = name === undefined ? undefined : templates?.find((t) => t.id === name);
  return (
    <div className="p-5 md:p-8">
      {error && !templates ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" />
        : !templates ? <ListSkeleton label="Loading the templates" rows={3} />
        : name === undefined ? <TemplateList v2={v2} templates={templates} go={go} onRemoved={() => setTries((n) => n + 1)} />
        : shown ? <ApplyTemplate key={shown.id} v2={v2} template={shown} go={go} />
        : <p className="border px-4 py-12 text-center font-mono text-body text-muted-foreground" role="alert">This server offers no template named {name}. <a href="#/templates" className="underline">See its templates</a>.</p>}
    </div>
  );
}

/** An imported package's provenance in one line: its source, the commit it was read at, its publisher. */
function Provenance({ t }: { t: Pick<TemplateView, "source" | "sha" | "publisher"> }) {
  if (!t.source) return null;
  return <p className="mt-1 break-all font-mono text-small text-muted-foreground" data-provenance>{t.source} at {t.sha?.slice(0, 12)}, published by {t.publisher}</p>;
}

/** The list, with the "Add from URL" box: a package on GitHub is read and shown whole (the install page) before it is stored. */
function TemplateList({ v2, templates, go, onRemoved }: { v2: Client; templates: TemplateView[]; go: (hash: string) => void; onRemoved: () => void }) {
  const [source, setSource] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const remove = async (t: TemplateView) => {
    setRemoving(t.id); setSaid(null);
    try { await v2.deleteTemplate(t.id); onRemoved(); } catch (e) { setSaid(e instanceof Error ? e.message : String(e)); } finally { setRemoving(null); }
  };
  return (
    <>
      <h1 className="mb-5 font-mono text-2xl font-semibold">Templates</h1>
      <form aria-label="Add from URL" className="mb-5 flex flex-wrap items-end gap-2 border bg-card px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (source.trim()) go(installHash(source.trim())); }}>
        <label className="min-w-0 flex-1">
          <span className="caps text-small font-semibold">Add from URL</span>
          <span className="mb-1.5 block text-small text-muted-foreground">A package on GitHub: github:owner/repo/path@ref, or its github.com/…/tree/… address. You read it whole before anything is stored.</span>
          <Input type="text" value={source} placeholder="github:owner/repo/templates/name@main" onChange={(e) => setSource(e.target.value)} />
        </label>
        <Button size="sm" variant="solid" type="submit" disabled={!source.trim()}>Read it</Button>
      </form>
      {said && <p className="mb-3 text-body text-destructive-text" role="alert">{said}</p>}
      {!templates.length ? <p className="border px-4 py-12 text-center font-mono text-body text-muted-foreground">This server offers no templates yet.</p> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.id}>
              <article aria-label={titleOf(t)} className="flex h-full flex-col border bg-card px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <LayoutTemplate className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden />
                  <h2 className="min-w-0 break-words text-prose font-semibold">{titleOf(t)}</h2>
                  <span className="font-mono text-small text-muted-foreground">{t.version}</span>
                  {!t.bundled && <Chip tone="muted">Imported</Chip>}
                </div>
                <Provenance t={t} />
                <p className="mt-2 text-lead leading-[1.6]">{t.description}</p>
                <dl className="mt-3 space-y-1 font-mono text-small text-muted-foreground">
                  {needsOf(t).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0">{what}</dt><dd className="min-w-0 break-words text-foreground/80">{words}</dd></div>)}
                </dl>
                <div className="mt-auto flex gap-2 pt-4">
                  <Button size="sm" variant="solid" onClick={() => go(templateHash(t.id))}>Apply</Button>
                  {!t.bundled && <Button size="sm" onClick={() => void remove(t)} disabled={removing === t.id}>{removing === t.id ? "Removing…" : "Remove"}</Button>}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
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
      const done = await v2.importTemplate(source, { trustPublisher: trusted });
      go(templateHash(done.template.id));
    } catch (e) { setSaid(refusalText(e)); } finally { setInstalling(false); }
  };
  const back = <a href="#/templates" className="caps mb-4 inline-flex items-center gap-1.5 text-small text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Templates</a>;
  if (error) return <div className="max-w-3xl">{back}<p className="border px-4 py-6 font-mono text-body text-destructive-text" role="alert">{error}</p></div>;
  if (!read) return <ListSkeleton label="Reading the package from GitHub" rows={3} />;
  const t = read.template;
  const owner = t.publisher ?? "";
  const files = Object.entries(read.skill_files);
  return (
    <section aria-label="Install from GitHub" className="max-w-3xl">
      {back}
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
          {needsOf(t).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{what}</dt><dd className="min-w-0 break-words">{words}</dd></div>)}
        </dl>
      </Section>
      <Section title="Instructions" note="What the agent is told, in full: a package from someone else says this to your agent.">
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-small" data-instructions>{read.instructions}</pre>
      </Section>
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

/** A refusal in the server's words: its message, and each field's. */
function refusalText(e: unknown): string {
  if (e instanceof ClientError && e.fields?.length) return [e.message, ...e.fields.map((i) => i.message)].join(" ");
  return e instanceof Error ? e.message : String(e);
}

const installHash = (source: string) => `#/templates/install?src=${encodeURIComponent(source)}`;


/** One template's Apply screen: its parameters, the owner's consent (one tick per MCP tool, none ticked until the owner
 *  ticks it), and what it needs. Apply sends the parameters as typed and the ticks as `grants`, under one Idempotency-Key a
 *  retry reuses. A refusal is the server's words at its field; a made agent opens, or, with warnings or a schedule, they
 *  show first: a schedule with when it runs and its next run, as the Triggers page says them. */
/** How long the Apply page waits on one of its new triggers' read-back before it leaves that trigger out. */
export const TRIGGER_READ_MS = 3_000;
/** `promise`'s answer, or undefined once `ms` have passed without one. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function ApplyTemplate({ v2, template: t, go }: Props & { template: TemplateView }) {
  // The form starts at the template's served defaults for its checkboxes (a box shows what is sent); a text field
  // starts empty, its default as its hint, and is left out untouched for the server to apply that default.
  const [values, setValues] = useState<ParameterText>(() => startValues(t));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  // The agent's approvals, sent as overrides.approvals: the template's own (approvals_default: never for one that runs
  // on its triggers with no one there), which the owner can switch.
  const [approvals, setApprovals] = useState<Approvals>(t.approvals_default ?? "ask");
  const [servers, setServers] = useState<Set<string> | null>(null);
  const [applying, setApplying] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  // The refusal's own words beside Apply; `withIssues` when it came with issues, so it goes once the last of them does.
  const [said, setSaid] = useState<{ text: string; withIssues: boolean } | null>(null);
  const [made, setMade] = useState<TemplateApplied | null>(null);
  // The schedules the apply made, each read back (GET /triggers/{id}) for its next run.
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  // The parameters an apply sent: what its "applied" title names, whatever was typed while it was under way.
  const [sentValues, setSentValues] = useState<ParameterText>({});
  const keys = useRef(keeper()).current;
  // Whether this page is still the one shown: an Apply that answers after the owner left never takes them anywhere.
  const shown = useRef(true);
  // Set on every setup, not only the first: StrictMode runs setup, cleanup, then setup again.
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  // The MCP servers saved here (GET /v2/settings/mcp-servers): which of the template's servers are set up.
  useEffect(() => {
    let live = true;
    v2.listMcpServers().then((r) => { if (live) setServers(new Set(r.servers.map((s) => s.name))); }, () => {});
    return () => { live = false; };
  }, [v2]);
  const grants = grantsOf(t, ticked);
  const at = (field: string) => issuesAt(issues, field);
  // A parameter's value as typed or picked: an issue at it goes as soon as the value is one the server takes.
  const setParam = (key: string, value: string) => {
    setValues((was) => ({ ...was, [key]: value }));
    const p = t.parameters[key];
    if (p && paramValid(p, value)) setIssues((was) => was.filter((i) => i.field !== `parameters.${key}`));
  };
  const apply = async () => {
    setApplying(true); setIssues([]); setSaid(null);
    const sending = values;
    const body = { parameters: parametersOf(t, sending), ...(grants.length ? { grants } : {}), overrides: { approvals } };
    try {
      const done = await v2.applyTemplate(t.id, body, keys.keyFor(t.id, body));
      keys.done();
      // Each trigger the apply made, read back: a schedule shows when it runs next. One that can't be read, or isn't
      // answered within TRIGGER_READ_MS, is left out (the Triggers page has it): a slow read never holds the result back.
      const schedulesOf = async (): Promise<Schedule[]> => {
        const read = await Promise.all(done.trigger_ids.map((id) => bounded(v2.getTrigger(id), TRIGGER_READ_MS).catch(() => null)));
        return read.filter((x): x is Schedule => x !== null && x !== undefined && isScheduleTrigger(x));
      };
      // A warning or a webhook's once-shown secret is shown at once; its schedules are added as they are read.
      if (done.warnings.length || done.webhook_secrets?.length) {
        setSentValues(sending);
        setMade(done);
        void schedulesOf().then(setSchedules, () => {});
        return;
      }
      // Otherwise the agent opens at once, unless a schedule's next run is there to show first.
      const scheduled = done.trigger_ids.length ? await schedulesOf() : [];
      if (!shown.current) return;
      if (!scheduled.length) { go(`#/agents/${encodeURIComponent(done.agent_id)}`); return; }
      setSentValues(sending);
      setSchedules(scheduled);
      setMade(done);
    } catch (e) {
      if (e instanceof ClientError && e.fields?.length) { setIssues(e.fields); setSaid({ text: e.message, withIssues: true }); }
      else setSaid({ text: e instanceof Error ? e.message : String(e), withIssues: false });
    } finally { setApplying(false); }
  };
  const params = Object.entries(t.parameters);
  // Issues the form has no place for (a trigger's, an override's) show above the button, in the server's words.
  const placed = (i: FieldIssue) => /^(parameters|secrets|mcp)\./.test(i.field) || /^grants\.\d+$/.test(i.field);
  if (made) {
    return (
      <section aria-label="Applied" className="max-w-3xl">
        <h1 className="mb-4 flex items-center gap-2 font-mono text-2xl font-semibold"><Check className="size-5 text-success-text" aria-hidden /> {titleOf(t, sentValues)} applied</h1>
        {made.warnings.length > 0 && <>
          <p className="mb-3 text-lead">The agent is made. The server says:</p>
          <ul className="mb-5 space-y-2 border bg-card px-4 py-3 text-body" role="status" aria-label="Warnings">
            {made.warnings.map((w, i) => {
              // A webhook trigger's (triggers.<i>.secret): the trigger the apply made (trigger_ids, in the template's order)
              // opens from here, where its secret is shown with Rotate. One webhook_secrets speaks for gets its link there.
              const hook = /^triggers\.(\d+)\.secret$/.exec(w.field);
              const id = hook ? made.trigger_ids[Number(hook[1])] : undefined;
              const named = hook ? t.triggers[Number(hook[1])]?.name : undefined;
              if (id && made.webhook_secrets?.some((x) => x.trigger_id === id)) return <li key={`${w.field}:${i}`}><span className="font-mono text-small text-muted-foreground">{w.field}</span> {w.message}</li>;
              return (
                <li key={`${w.field}:${i}`}><span className="font-mono text-small text-muted-foreground">{w.field}</span> {w.message}{w.fix ? <span className="block text-muted-foreground">{w.fix}</span> : null}
                  {id && <a href={`#/triggers/${encodeURIComponent(id)}`} className="mt-1 block font-mono text-small text-primary-text underline-offset-2 hover:underline">Open {typeof named === "string" && named ? named : id} to get its signing secret (Rotate)</a>}
                </li>
              );
            })}
          </ul>
        </>}
        {/* Each webhook trigger the apply made: its signing secret this once, in the first answer to this session (held in
            this screen's state alone, never stored or logged), beside its URL; else the server's note and the trigger to
            rotate it from. */}
        {made.webhook_secrets?.map((x) => {
          const index = made.trigger_ids.indexOf(x.trigger_id);
          const named = index >= 0 ? t.triggers[index]?.name : undefined;
          const name = typeof named === "string" && named ? named : x.trigger_id;
          return x.signing_secret
            ? <SecretOnce key={x.trigger_id} label={`The webhook's URL and secret (${name})`} url={hookUrlOf({ id: x.trigger_id })} secret={x.signing_secret} />
            : (
              <div key={x.trigger_id} className="mt-4 border px-4 py-3 text-body">
                {x.note && <p className="text-muted-foreground" role="note">{x.note}</p>}
                <a href={`#/triggers/${encodeURIComponent(x.trigger_id)}`} className="mt-1 block font-mono text-small text-primary-text underline-offset-2 hover:underline">Open {name} to get its signing secret (Rotate)</a>
              </div>
            );
        })}
        {/* Each schedule the apply made: its line (scheduleLine), as the Triggers page says it. */}
        {schedules.length > 0 && (
          <ul className="mt-4 divide-y border" aria-label="Schedules">
            {schedules.map((s) => (
              <li key={s.id} data-trigger={s.id} className="px-4 py-3">
                <a href={`#/triggers/${encodeURIComponent(s.id)}`} className="break-words text-prose font-semibold hover:underline">{s.name}</a>
                <p className="mt-1 break-words font-mono text-small text-muted-foreground">{scheduleLine(s.source, s.next_at)}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5" />
        <a href={`#/agents/${encodeURIComponent(made.agent_id)}`} className="inline-flex border px-3 py-2 font-mono text-body font-semibold hover:bg-accent">Open the agent</a>
      </section>
    );
  }
  return (
    <div className="max-w-3xl">
      <a href="#/templates" className="caps mb-4 inline-flex items-center gap-1.5 text-small text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Templates</a>
      <h1 className="font-mono text-2xl font-semibold">{titleOf(t, values)} <span className="text-lead font-normal text-muted-foreground">{t.version}</span></h1>
      <Provenance t={t} />
      <p className="mt-2 text-lead leading-[1.6]">{t.description}</p>

      {params.length > 0 && (
        <Section title="Parameters">
          {params.map(([key, p]) => (
            <div key={key} data-field={`parameters.${key}`} className="px-4 py-3">
              <label className="block">
                <span className="caps text-small font-semibold">{paramLabel(key, p)}{p.required && <span className="text-destructive-text"> *</span>}</span>
                {/* The parameter's own words (a cron line's or a zone's without their format, which the picker says in
                    words); its pattern is the server's to check, never printed. */}
                <span className="mb-1.5 block text-small text-muted-foreground">{paramHelp(p)}</span>
                {/* A parameter with its own list of choices offers just those, whatever its format: the server holds it to them. */}
                {choiceOptions(p)
                  ? <Picker label={paramLabel(key, p)} className="w-full" value={values[key] ?? ""} onChange={(v) => setParam(key, v)} options={choiceOptions(p)!} />
                  : p.format === "cron" && p.type === "string"
                  ? <ScheduleWhen label={paramLabel(key, p)} value={values[key] ?? ""} onChange={(v) => setParam(key, v)} />
                  : p.format === "timezone" && p.type === "string"
                  ? <ZonePicker label={paramLabel(key, p)} className="w-full" value={values[key] ?? ""} onChange={(v) => setParam(key, v)} />
                  : p.type === "boolean"
                  ? <input type="checkbox" className="size-4 accent-primary" checked={values[key] === "true"} onChange={(e) => setParam(key, e.target.checked ? "true" : "false")} />
                  : <Input type={p.type === "string" ? "text" : "number"} step={p.type === "integer" ? 1 : "any"} value={values[key] ?? ""} required={p.required} placeholder={p.default === undefined ? undefined : String(p.default)}
                      onChange={(e) => setParam(key, e.target.value)} />}
              </label>
              <Issues issues={at(`parameters.${key}`)} words={(i) => paramIssueWords(i, key, p)} />
            </div>
          ))}
        </Section>
      )}

      {t.mcp.length > 0 && (
        <Section title="Tools you allow" note="Nothing is granted until you tick it. A tool you leave unticked stays at your own setting for it.">
          {t.mcp.map((m) => (
            <div key={m.server} data-mcp={m.server} className="px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 font-mono text-body">
                <span className="font-semibold">{m.server}</span>
                <Chip tone={m.required ? "plain" : "muted"}>{m.required ? "Required" : "Optional"}</Chip>
                {servers && <span className="text-small text-muted-foreground">{servers.has(m.server) ? "Set up here" : "Not set up here"}</span>}
              </p>
              {/* A server the template names that is not saved here: said before Apply, with the way to set it up, so an agent is
                  never made without its tools unseen. `github` is GitHub's own, set up as a GitHub App. */}
              {servers && !servers.has(m.server) && (
                <p role="status" data-missing-mcp={m.server} className="mt-2 border border-warning/50 px-3 py-2 text-small text-warning-text">
                  {m.required ? `${m.server} is required and not set up here: Apply is refused until it is.` : `${m.server} is not set up here: Apply makes the agent without its tools (${m.tools.map((x) => x.name).join(", ")}).`}{" "}
                  <a href={`#/settings/mcp?add=${encodeURIComponent(m.server)}${m.server === "github" ? "&auth=github_app" : ""}`} className="font-mono text-primary-text underline-offset-2 hover:underline">{m.server === "github" ? "Set up GitHub App access" : `Set up ${m.server}`}</a>
                </p>
              )}
              <Issues issues={at(`mcp.${m.server}`)} />
              <ul className="mt-2 space-y-2">
                {m.tools.map((tool) => {
                  const index = grants.indexOf(tool.tool);
                  return (
                    <li key={tool.tool} data-tool={tool.tool}>
                      <label className="flex items-start gap-2.5">
                        <input type="checkbox" className="mt-1 accent-primary" checked={ticked.has(tool.tool)} onChange={() => setTicked((s) => { const n = new Set(s); if (n.has(tool.tool)) n.delete(tool.tool); else n.add(tool.tool); return n; })} />
                        <span className="min-w-0">
                          <span className="font-mono text-body">{tool.name}</span> <span className="font-mono text-label text-muted-foreground">{tool.tool}</span>
                          {/* A tick is a grant, and the server stores every granted tool as allow: that is what the tick says. What the
                              template asks for is said apart. */}
                          <span className="block text-small">Allow: the agent may call this without asking you.</span>
                          <span className="block text-small text-muted-foreground">{tool.asks === "allow" ? "The template asks you to allow this." : "The template does not ask for this; unticked, it stays at your setting."}</span>
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

      <fieldset aria-label="Approvals" className="mt-6">
        <legend className="caps text-small font-semibold">Approvals</legend>
        <div className="mt-2 divide-y border">
          {([["ask", "Ask me", "A call whose permission is ask waits for your answer."], ["never", "Never ask (run unattended)", "For an agent that runs on its triggers, with no one there to answer."]] as const).map(([value, label, note]) => (
            <label key={value} className="flex items-start gap-3 px-4 py-3">
              <input type="radio" name="approvals" value={value} className="mt-1 accent-primary" checked={approvals === value} onChange={() => setApprovals(value)} />
              <span><span className="font-mono text-body">{label}</span><span className="block text-small text-muted-foreground">{note}</span></span>
            </label>
          ))}
        </div>
        {approvals === "never" && <p className="mt-2 text-small text-warning-text">{NEVER_ASK_LINE}</p>}
      </fieldset>

      <Section title="What it makes">
        <dl className="space-y-1 px-4 py-3 font-mono text-small">
          {needsOf(t, { secrets: false, mcp: false }).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{what}</dt><dd className="min-w-0 break-words">{words}</dd></div>)}
        </dl>
      </Section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="solid" onClick={() => void apply()} disabled={applying}>{applying ? "Applying…" : "Apply"}</Button>
        {said && (!said.withIssues || issues.length > 0) && <p className="min-w-0 flex-1 text-body text-destructive-text" role="alert">{said.text}</p>}
      </div>
      {issues.filter((i) => !placed(i)).length > 0 && <div className="mt-2"><Issues issues={issues.filter((i) => !placed(i))} named /></div>}
    </div>
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

/** A field's issues, in the server's words (or `words`, the form's for a parameter), with its `fix` when it names one.
 *  `named`: each with its field. */
function Issues({ issues, named = false, words = (i) => i.message }: { issues: FieldIssue[]; named?: boolean; words?: (issue: FieldIssue) => string }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-1.5 space-y-1 text-small text-destructive-text" role="alert">
      {issues.map((i, n) => <li key={`${i.field}:${n}`}>{named && <span className="font-mono">{i.field} </span>}{words(i)}{i.fix && <span className="block text-foreground/80">{i.fix}</span>}</li>)}
    </ul>
  );
}

