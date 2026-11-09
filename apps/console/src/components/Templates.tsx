import { ArrowLeft, Check, LayoutTemplate } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { SecretOnce } from "@/components/Schedules";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Client, ClientError, type FieldIssue } from "@/lib/client";
import { keeper } from "@/lib/idempotency";
import { hookUrlOf } from "@/lib/schedules";
import { type Problem, problem } from "@/lib/problem";
import { grantsOf, issuesAt, needsOf, parametersOf, type ParameterText, startValues, templateHash, titleOf } from "@/lib/templatePackages";
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
        : <p className="border px-4 py-12 text-center font-mono text-[13px] text-muted-foreground" role="alert">This server offers no template named {name}. <a href="#/templates" className="underline">See its templates</a>.</p>}
    </div>
  );
}

function TemplateList({ templates, go }: { templates: TemplateView[]; go: (hash: string) => void }) {
  return (
    <>
      <h1 className="mb-5 font-mono text-2xl font-semibold">Templates</h1>
      {!templates.length ? <p className="border px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">This server offers no templates yet.</p> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.name}>
              <article aria-label={titleOf(t)} className="flex h-full flex-col border bg-card px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <LayoutTemplate className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden />
                  <h2 className="min-w-0 break-words text-[15px] font-semibold">{titleOf(t)}</h2>
                  <span className="font-mono text-[12px] text-muted-foreground">{t.version}</span>
                </div>
                <p className="mt-2 text-[14px] leading-[1.6]">{t.description}</p>
                <dl className="mt-3 space-y-1 font-mono text-[12px] text-muted-foreground">
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

const input = "w-full border bg-background px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong";

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
  const [said, setSaid] = useState<string | null>(null);
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
  const apply = async () => {
    setApplying(true); setIssues([]); setSaid(null);
    const sending = values;
    const body = { parameters: parametersOf(t, sending), ...(grants.length ? { grants } : {}), overrides: { approvals } };
    try {
      const done = await v2.applyTemplate(t.name, body, keys.keyFor(t.name, body));
      keys.done();
      // Opens the agent at once only when there is nothing to show first: a warning, a webhook's secret (shown this once),
      // or the server's note on a retry.
      if (!done.warnings.length && !done.webhook_secrets?.length && !done.note) { go(`#/agents/${encodeURIComponent(done.agent_id)}`); return; }
      setSentValues(sending);
      setMade(done);
    } catch (e) {
      if (e instanceof ClientError && e.fields?.length) { setIssues(e.fields); setSaid(e.message); }
      else setSaid(e instanceof Error ? e.message : String(e));
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
          <p className="mb-3 text-[14px]">The agent is made. The server says:</p>
          <ul className="mb-5 space-y-2 border bg-card px-4 py-3 text-[13px]" role="status" aria-label="Warnings">
            {made.warnings.map((w, i) => <li key={`${w.field}:${i}`}><span className="font-mono text-[12px] text-muted-foreground">{w.field}</span> {w.message}{w.fix ? <span className="block text-muted-foreground">{w.fix}</span> : null}</li>)}
          </ul>
        </>}
        {/* Each webhook trigger's signing secret, this once, beside its URL (a schedule or GitHub trigger has none). */}
        {made.webhook_secrets?.map((w) => <SecretOnce key={w.trigger_id} label={`The webhook's URL and secret (${w.trigger_id})`} url={hookUrlOf({ id: w.trigger_id })} secret={w.secret} />)}
        {made.note && <p className="mt-4 text-[13px] text-muted-foreground" role="note">{made.note}</p>}
        <div className="mt-5" />
        <a href={`#/agents/${encodeURIComponent(made.agent_id)}`} className="inline-flex border px-3 py-2 font-mono text-[13px] font-semibold hover:bg-accent">Open the agent</a>
      </section>
    );
  }
  return (
    <div className="max-w-3xl">
      <a href="#/templates" className="caps mb-4 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" aria-hidden /> Templates</a>
      <h1 className="font-mono text-2xl font-semibold">{titleOf(t, values)} <span className="text-[14px] font-normal text-muted-foreground">{t.version}</span></h1>
      <p className="mt-2 text-[14px] leading-[1.6]">{t.description}</p>

      {params.length > 0 && (
        <Section title="Parameters">
          {params.map(([key, p]) => (
            <div key={key} data-field={`parameters.${key}`} className="px-4 py-3">
              <label className="block">
                <span className="caps text-[12px] font-semibold">{key}{p.required && <span className="text-destructive-text"> *</span>}</span>
                <span className="mb-1.5 block text-[12px] text-muted-foreground">{p.description}{p.pattern ? ` (as ${p.pattern})` : ""}</span>
                {p.type === "boolean"
                  ? <input type="checkbox" checked={values[key] === "true"} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.checked ? "true" : "false" }))} />
                  : <input className={input} type={p.type === "string" ? "text" : "number"} step={p.type === "integer" ? 1 : "any"} value={values[key] ?? ""} required={p.required} placeholder={p.default === undefined ? undefined : String(p.default)}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />}
              </label>
              <Issues issues={at(`parameters.${key}`)} />
            </div>
          ))}
        </Section>
      )}

      {t.mcp.length > 0 && (
        <Section title="Tools you allow" note="Nothing is granted until you tick it. A tool you leave unticked stays at your own setting for it.">
          {t.mcp.map((m) => (
            <div key={m.server} data-mcp={m.server} className="px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 font-mono text-[13px]">
                <span className="font-semibold">{m.server}</span>
                <Chip tone={m.required ? "plain" : "muted"}>{m.required ? "Required" : "Optional"}</Chip>
                {servers && <span className="text-[12px] text-muted-foreground">{servers.has(m.server) ? "Set up here" : "Not set up here"}</span>}
              </p>
              <Issues issues={at(`mcp.${m.server}`)} />
              <ul className="mt-2 space-y-2">
                {m.tools.map((tool) => {
                  const index = grants.indexOf(tool.tool);
                  return (
                    <li key={tool.tool} data-tool={tool.tool}>
                      <label className="flex items-start gap-2.5">
                        <input type="checkbox" className="mt-1" checked={ticked.has(tool.tool)} onChange={() => setTicked((s) => { const n = new Set(s); if (n.has(tool.tool)) n.delete(tool.tool); else n.add(tool.tool); return n; })} />
                        <span className="min-w-0">
                          <span className="font-mono text-[13px]">{tool.name}</span> <span className="font-mono text-[11px] text-muted-foreground">{tool.tool}</span>
                          {/* A tick is a grant, and the server stores every granted tool as allow: that is what the tick says. What the
                              template asks for is said apart. */}
                          <span className="block text-[12px]">Allow: the agent may call this without asking you.</span>
                          <span className="block text-[12px] text-muted-foreground">{tool.asks === "allow" ? "The template asks you to allow this." : "The template does not ask for this; unticked, it stays at your setting."}</span>
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
            <div key={s} data-secret={s} className="px-4 py-3 font-mono text-[13px]">{s}<Issues issues={at(`secrets.${s}`)} /></div>
          ))}
        </Section>
      )}

      <fieldset aria-label="Approvals" className="mt-6">
        <legend className="caps text-[12px] font-semibold">Approvals</legend>
        <div className="mt-2 divide-y border">
          {([["ask", "Ask me", "A call whose permission is ask waits for your answer."], ["never", "Never ask (run unattended)", "For an agent that runs on its triggers, with no one there to answer."]] as const).map(([value, label, note]) => (
            <label key={value} className="flex items-start gap-3 px-4 py-3">
              <input type="radio" name="approvals" value={value} className="mt-1" checked={approvals === value} onChange={() => setApprovals(value)} />
              <span><span className="font-mono text-[13px]">{label}</span><span className="block text-[12px] text-muted-foreground">{note}</span></span>
            </label>
          ))}
        </div>
        {approvals === "never" && <p className="mt-2 text-[12px] text-warning-text">{NEVER_ASK_LINE}</p>}
      </fieldset>

      <Section title="What it makes">
        <dl className="space-y-1 px-4 py-3 font-mono text-[12px]">
          {needsOf(t, { secrets: false, mcp: false }).map(([what, words]) => <div key={what} className="flex gap-2"><dt className="shrink-0 text-muted-foreground">{what}</dt><dd className="min-w-0 break-words">{words}</dd></div>)}
        </dl>
      </Section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="solid" onClick={() => void apply()} disabled={applying}>{applying ? "Applying…" : "Apply"}</Button>
        {said && <p className="min-w-0 flex-1 text-[13px] text-destructive-text" role="alert">{said}</p>}
      </div>
      {issues.filter((i) => !placed(i)).length > 0 && <div className="mt-2"><Issues issues={issues.filter((i) => !placed(i))} named /></div>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-6">
      <h2 className="caps text-[12px] font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-[12px] text-muted-foreground">{note}</p>}
      <div className="mt-2 divide-y border">{children}</div>
    </section>
  );
}

/** A field's issues, in the server's words, with its `fix` when it names one. `named`: each with its field. */
function Issues({ issues, named = false }: { issues: FieldIssue[]; named?: boolean }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-1.5 space-y-1 text-[12px] text-destructive-text" role="alert">
      {issues.map((i, n) => <li key={`${i.field}:${n}`}>{named && <span className="font-mono">{i.field} </span>}{i.message}{i.fix && <span className="block text-foreground/80">{i.fix}</span>}</li>)}
    </ul>
  );
}

