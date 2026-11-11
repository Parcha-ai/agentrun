import { ArrowLeft, Check, LayoutTemplate } from "lucide-react";
import { Picker } from "@/components/ui/picker";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { SecretOnce } from "@/components/Schedules";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/field";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { keeper } from "@/lib/idempotency";
import { hookUrlOf } from "@/lib/schedules";
import { type Problem, problem } from "@/lib/problem";
import { choicesOf, grantsOf, issuesAt, needsOf, paramIssueWords, paramLabel, parametersOf, paramValid, type ParameterText, startValues, templateHash, titleOf } from "@/lib/templatePackages";
import { type Approvals, NEVER_ASK_LINE, type TemplateApplied, type TemplateView } from "@/lib/v2";

type Props = { v2: Client; go: (hash: string) => void };

/** The server's templates (GET /v2/templates): the list (no `name`), or one template's Apply screen. */
export function TemplatesPage({ v2, name, go }: Props & { name?: string }) {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    v2.listTemplates().then((r) => { if (live) setTemplates(r.templates); }, (e) => { if (live) setError(problem(e, "the templates")); });
    return () => { live = false; };
  }, [v2, tries]);
  const shown = name === undefined ? undefined : templates?.find((t) => t.name === name);
  return (
    <div className="p-5 md:p-8">
      {error && !templates ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" />
        : !templates ? <ListSkeleton label="Loading the templates" rows={3} />
        : name === undefined ? <TemplateList templates={templates} go={go} />
        : shown ? <ApplyTemplate key={shown.name} v2={v2} template={shown} go={go} />
        : <p className="border px-4 py-12 text-center font-mono text-body text-muted-foreground" role="alert">This server offers no template named {name}. <a href="#/templates" className="underline">See its templates</a>.</p>}
    </div>
  );
}

function TemplateList({ templates, go }: { templates: TemplateView[]; go: (hash: string) => void }) {
  return (
    <>
      <h1 className="mb-5 font-mono text-2xl font-semibold">Templates</h1>
      {!templates.length ? <p className="border px-4 py-12 text-center font-mono text-body text-muted-foreground">This server offers no templates yet.</p> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.name}>
              <article aria-label={titleOf(t)} className="flex h-full flex-col border bg-card px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <LayoutTemplate className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden />
                  <h2 className="min-w-0 break-words text-prose font-semibold">{titleOf(t)}</h2>
                  <span className="font-mono text-small text-muted-foreground">{t.version}</span>
                </div>
                <p className="mt-2 text-lead leading-[1.6]">{t.description}</p>
                <dl className="mt-3 space-y-1 font-mono text-small text-muted-foreground">
                  {needsOf(t).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0">{what}</dt><dd className="min-w-0 break-words text-foreground/80">{words}</dd></div>)}
                </dl>
                <div className="mt-auto pt-4">
                  <Button size="sm" variant="solid" onClick={() => go(templateHash(t.name))}>Apply</Button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}


/** One template's Apply screen: its parameters, the owner's consent (one tick per MCP tool, none ticked until the owner
 *  ticks it), and what it needs. Apply sends the parameters as typed and the ticks as `grants`, under one Idempotency-Key a
 *  retry reuses. A refusal is the server's words at its field; a made agent opens, or, with warnings, they show first. */
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
  // The parameters an apply sent: what its "applied" title names, whatever was typed while it was under way.
  const [sentValues, setSentValues] = useState<ParameterText>({});
  const keys = useRef(keeper()).current;
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
      const done = await v2.applyTemplate(t.name, body, keys.keyFor(t.name, body));
      keys.done();
      // Opens the agent at once only when there is nothing to show first: a warning (a webhook trigger's among them).
      if (!done.warnings.length && !done.webhook_secrets?.length) { go(`#/agents/${encodeURIComponent(done.agent_id)}`); return; }
      setSentValues(sending);
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
        <div className="mt-5" />
        <a href={`#/agents/${encodeURIComponent(made.agent_id)}`} className="inline-flex border px-3 py-2 font-mono text-body font-semibold hover:bg-accent">Open the agent</a>
      </section>
    );
  }
  return (
    <div className="max-w-3xl">
      <a href="#/templates" className="caps mb-4 inline-flex items-center gap-1.5 text-small text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Templates</a>
      <h1 className="font-mono text-2xl font-semibold">{titleOf(t, values)} <span className="text-lead font-normal text-muted-foreground">{t.version}</span></h1>
      <p className="mt-2 text-lead leading-[1.6]">{t.description}</p>

      {params.length > 0 && (
        <Section title="Parameters">
          {params.map(([key, p]) => (
            <div key={key} data-field={`parameters.${key}`} className="px-4 py-3">
              <label className="block">
                <span className="caps text-small font-semibold">{paramLabel(key)}{p.required && <span className="text-destructive-text"> *</span>}</span>
                {/* The parameter's own words; its pattern is the server's to check, never printed. */}
                <span className="mb-1.5 block text-small text-muted-foreground">{p.description}</span>
                {choicesOf(p)
                  ? <Picker label={key} className="w-full" value={values[key] ?? ""} onChange={(v) => setParam(key, v)}
                      options={[{ value: "", label: p.required ? "Choose one" : p.default !== undefined ? `${String(p.default)} (default)` : "None chosen" }, ...choicesOf(p)!.map((c) => ({ value: c, label: c }))]} />
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

