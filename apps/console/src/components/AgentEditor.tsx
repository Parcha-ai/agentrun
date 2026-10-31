import { Archive, ArrowLeft, ArrowRight, Check, FileText, History, Settings, TriangleAlert, Workflow, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { type Agent, type AgentFields, defaultTools, harnessOptions, reachesWeb, type SaveProblem, type ToolOffer, toolsFor } from "@/lib/agentForm";
import type { WorkflowCheck } from "@/lib/client";
import { markdown, when } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Revision = { revision: string; version: number; current: boolean; note: string | null; created_at: string };
export type EditorCaps = { harnesses: { id: string; available: boolean; reason?: string }[]; tools: ToolOffer[]; thinking: string[]; defaultModel?: string };
export type EditorProps = {
  /** The agent being edited, or null for a new one. */
  agent: Agent | null;
  revisions?: Revision[];
  caps: EditorCaps;
  /** Saves the form: a new agent, or the next revision of this one. Resolves with the server's refusal, or null. */
  onSave?: (fields: AgentFields, note: string) => Promise<SaveProblem | null>;
  onMakeCurrent?: (revision: string) => void;
  onArchive?: (archive: boolean) => void;
  onReload?: () => void;
  onBack?: () => void;
  step?: Step;
  problem?: SaveProblem | null;
  /** A message about an action outside the form (make current, archive) or after a save. */
  notice?: string | null;
  /** A workflow agent's JSON to open with instead of the saved one: an unsaved draft. */
  draft?: string;
  /** The server's check of a workflow as it is typed (POST /v2/workflows/validate). */
  validate?: (body: { workflow: unknown; tools?: string[] }, signal?: AbortSignal) => Promise<WorkflowCheck>;
};
type Step = "context" | "workflow" | "tools" | "settings" | "history";

/** A refused save's issues in the workflow: each 422 field under definition.workflow at its path, else the refusal's
 *  message for a workflow agent. */
function workflowIssues(problem: SaveProblem | null, workflow: boolean): { path: string; message: string }[] | null {
  if (problem?.kind !== "invalid") return null;
  const mine = Object.entries(problem.fields).filter(([f]) => f === "definition.workflow" || f.startsWith("definition.workflow/")).map(([f, message]) => ({ path: f.slice("definition.workflow".length), message }));
  return mine.length ? mine : workflow ? [{ path: "", message: problem.message }] : null;
}

const STEPS: { id: Step; label: string; note: string; Icon: typeof FileText }[] = [
  { id: "context", label: "Context", note: "Name, description and instructions", Icon: FileText },
  { id: "workflow", label: "Workflow", note: "Its graph and its JSON", Icon: Workflow },
  { id: "tools", label: "Tools & skills", note: "What this agent can do", Icon: Wrench },
  { id: "settings", label: "Settings", note: "Harness, thinking and model", Icon: Settings },
  { id: "history", label: "History", note: "Revisions and the current one", Icon: History },
];

/** The hosted console's agent builder, over AgentRun Server's agents: a numbered step rail, one step at a time, and a
 *  save that makes a new revision. A save made on a revision that is no longer current is refused (If-Match), and the
 *  editor says so instead of overwriting the other save. */
export function AgentEditor({ agent, revisions = [], caps, onSave, onMakeCurrent, onArchive, onReload, onBack, step: initialStep, problem: initialProblem = null, notice, draft, validate }: EditorProps) {
  const creating = !agent;
  const d = agent?.definition;
  const [step, setStep] = useState<Step>(initialStep ?? (agent?.kind === "workflow" ? "workflow" : "context"));
  // Tools are on by default: a new agent starts with every tool its harness runs here; an agent keeps its own.
  const [f, setF] = useState<AgentFields>({ name: d?.name ?? "", description: d?.description ?? "", instructions: d?.instructions ?? "", harness: d?.harness ?? "pi", thinking: d?.thinking, model: d?.model, tools: creating ? defaultTools("pi", caps.tools) : d?.tools ?? [], ...(agent?.kind === "workflow" ? { workflowText: draft ?? JSON.stringify(d!.workflow, null, 2) } : {}) });
  // On a new agent, picking another harness re-ticks that harness's tools, until a tool is changed by hand.
  const [toolsTouched, setToolsTouched] = useState(false);
  // The server's tools can arrive after the form opens (capabilities answer late): a new agent's untouched tools follow.
  const toolsKey = caps.tools.map((t) => `${t.name}:${t.available}:${(t.harnesses ?? []).join("+")}`).join(",");
  useEffect(() => {
    if (creating && !toolsTouched) setF((x) => ({ ...x, tools: defaultTools(x.harness ?? "pi", caps.tools) }));
  }, [toolsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(initialProblem);
  const [saved, setSaved] = useState(false);
  const fieldError = (field: string) => (problem?.kind === "invalid" ? problem.fields[`definition.${field}`] : undefined);
  const set = (patch: AgentFields) => { setF((x) => ({ ...x, ...patch })); setSaved(false); };
  const workflow = agent?.kind === "workflow";
  // `revisions` counts them; the current one is the agent's `revision`, which can be an earlier one after "Make current".
  const current = revisions.find((r) => r.revision === agent?.revision) ?? revisions.find((r) => r.current);
  const steps = STEPS.filter((s) => !(creating && s.id === "history") && (s.id !== "workflow" || workflow));
  const at = steps.findIndex((s) => s.id === step);
  const save = async () => {
    if (!onSave) return;
    setSaving(true);
    // A workflow agent's edit is sent as its parsed JSON; text that does not parse is not sent at all.
    let fields: AgentFields = { ...f, workflowText: undefined };
    if (workflow) {
      try { fields = { ...fields, workflow: JSON.parse(f.workflowText ?? "") }; }
      catch (e) { setSaving(false); setProblem({ kind: "invalid", message: `The workflow is not JSON: ${(e as Error).message}`, fields: { "definition.workflow": `The workflow is not JSON: ${(e as Error).message}` } }); return; }
    }
    const p = await onSave(fields, note);
    setSaving(false); setProblem(p); setSaved(!p); if (!p) setNote("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4 md:px-8">
        <Button size="icon" variant="ghost" aria-label="Back to agents" onClick={onBack}><ArrowLeft aria-hidden /></Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-xl font-semibold">{creating ? "New agent" : d!.name}</h1>
        {agent && <Chip>{agent.kind}</Chip>}
        {agent && <span className="caps text-[11px] text-muted-foreground">{current ? `rev ${current.version} current · ` : ""}{agent.revisions} {agent.revisions === 1 ? "revision" : "revisions"}</span>}
        {agent && onArchive && <Button size="sm" variant={agent.archived_at ? "primary" : "outline"} onClick={() => onArchive(!agent.archived_at)}><Archive aria-hidden /> {agent.archived_at ? "Unarchive" : "Archive"}</Button>}
      </header>
      {problem?.kind === "conflict" && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-card px-5 py-3 md:px-8" role="alert">
          <TriangleAlert className="size-4 text-warning-text" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px]">This agent changed since you opened it: another revision was saved first, so this save was not made. Reload to see the current revision; it replaces your unsaved edits here.</p>
          <Button size="sm" onClick={onReload}>Reload</Button>
        </div>
      )}
      {notice && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-warning-text md:px-8" role="alert">{notice}</p>}
      {!workflow && !reachesWeb(f.tools ?? []) && (
        <p className="border-b bg-card px-5 py-2.5 font-mono text-[12px] text-muted-foreground md:px-8">This agent can't reach the web: fetch_page isn't among its tools{toolsFor(f.harness ?? "pi", caps.tools).some((t) => t.name === "fetch_page") ? "." : ` (${f.harness ?? "pi"} doesn't run it on this server).`}</p>
      )}
      {problem?.kind === "invalid" && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-destructive-text md:px-8" role="alert">The server refused the save: {problem.message}</p>}
      {problem?.kind === "other" && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-destructive-text md:px-8" role="alert">{problem.message}</p>}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ol className={cn("flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:flex-col md:gap-0 md:border-b-0 md:border-r md:p-4", step === "workflow" ? "md:w-[76px]" : "md:w-[240px]")}>
          {steps.map((s, i) => (
            <li key={s.id} className="shrink-0">
              <button type="button" aria-current={step === s.id ? "step" : undefined} onClick={() => setStep(s.id)}
                className={cn("flex w-full items-start gap-3 border-l-2 px-3 py-2.5 text-left font-mono", step === s.id ? "border-l-foreground bg-foreground/5" : "border-l-transparent text-muted-foreground hover:text-foreground")}>
                <span className={cn("inline-flex size-6 shrink-0 items-center justify-center border text-[11px] font-bold", step === s.id ? "border-foreground bg-foreground text-background" : i < at ? "border-border-strong" : "border-border")}>
                  {i < at ? <Check className="size-3" aria-hidden /> : i + 1}
                </span>
                <span className={cn("hidden min-w-0", step !== "workflow" && "md:block")} title={step === "workflow" ? s.label : undefined}>
                  <span className="caps flex items-center gap-1.5 text-[12px]"><s.Icon className="size-3.5" aria-hidden /> {s.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{s.note}</span>
                </span>
                <span className="caps text-[12px] md:hidden">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <section className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-10">
          <p className="caps text-[11px] text-muted-foreground">Step {at + 1}</p>
          <h2 className="caps mb-6 border-b pb-4 text-[15px] font-semibold">{steps[at].label}</h2>

          {step === "context" && (
            <div className="max-w-3xl space-y-6">
              <Field label="Name" required={creating} note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("name")}>
                <input value={f.name} readOnly={!creating} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Invoice checker" className={cn(input, !creating && "text-muted-foreground")} />
              </Field>
              <Field label="Description" optional note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("description")}>
                <input value={f.description} readOnly={!creating} onChange={(e) => set({ description: e.target.value })} placeholder={creating ? "Short summary for the agent list" : "No description"} className={cn(input, !creating && "text-muted-foreground")} />
              </Field>
              {workflow ? (
                <Field label="Workflow" note="This agent is a workflow. Edit its nodes in the Workflow step: the graph redraws as you type and the server checks it.">
                  <Button size="sm" onClick={() => setStep("workflow")}><Workflow aria-hidden /> Open the workflow</Button>
                </Field>
              ) : (
                <Field label="Instructions" required error={fieldError("instructions")}
                  aside={<span className="flex">{(["Preview", "Edit"] as const).map((m) => <button key={m} type="button" onClick={() => setPreview(m === "Preview")} className={cn("caps border px-2.5 py-1 text-[11px]", (m === "Preview") === preview ? "border-foreground bg-foreground text-background" : "text-muted-foreground")}>{m}</button>)}</span>}>
                  {preview ? <article className="report min-h-64 border p-4" dangerouslySetInnerHTML={{ __html: markdown(f.instructions || "") }} />
                    : <textarea value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={14} placeholder="Describe what the agent does, how, and its rules." className={cn(input, "resize-y leading-[1.7]")} />}
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">{(f.instructions ?? "").length} characters</p>
                </Field>
              )}
            </div>
          )}

          {step === "workflow" && (
            <WorkflowEditor text={f.workflowText ?? ""} onText={(t) => set({ workflowText: t })} base={workflow ? d!.workflow : undefined}
              baseLabel={current ? `rev ${current.version}` : undefined} validate={validate} tools={f.tools} serverIssues={workflowIssues(problem, workflow)} />
          )}

          {step === "tools" && (
            <div className="max-w-3xl space-y-6">
              <Field label="Tools" note="On by default: the tools this agent's harness runs on this server. Untick one to take it away." error={fieldError("tools")}>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {caps.tools.map((t) => {
                    const runs = toolsFor(f.harness ?? "pi", caps.tools).some((x) => x.name === t.name);
                    const on = f.tools?.includes(t.name) ?? false;
                    const why = !runs ? `Not on ${f.harness ?? "pi"} on this server` : !t.available ? `Needs ${(t.missing ?? []).join(", ")}` : undefined;
                    return (
                      <li key={t.name}><label title={why} className={cn("flex items-center gap-3 border px-3 py-2.5 font-mono text-[13px]", on && "border-foreground", why && !on ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                        <input type="checkbox" value={t.name} checked={on} disabled={!!why && !on} onChange={() => { setToolsTouched(true); set({ tools: on ? f.tools!.filter((x) => x !== t.name) : [...(f.tools ?? []), t.name] }); }} className="accent-[hsl(var(--primary))]" />
                        <span>{t.name}{why && <span className="ml-2 text-[11px] text-muted-foreground">{why}</span>}</span>
                      </label></li>
                    );
                  })}
                </ul>
              </Field>
              <Field label="Skills" note="Skill files are saved with each revision and kept as they are by an edit.">
                {d?.skills?.length ? <ul className="border">{d.skills.map((s) => <li key={s} className="border-b px-3 py-2 font-mono text-[13px] last:border-b-0">{s}</li>)}</ul>
                  : <p className="border px-3 py-4 font-mono text-[13px] text-muted-foreground">No skills.</p>}
              </Field>
            </div>
          )}

          {step === "settings" && (
            <div className="max-w-3xl space-y-8">
              {!workflow && (
                <Field label="Harness" note="What runtime runs this agent." error={fieldError("harness")}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Harness">
                    {harnessOptions(caps.harnesses).map((h) => (
                      <label key={h.id} title={h.reason} className={cn("flex items-start gap-3 border px-4 py-3", f.harness === h.id ? "border-foreground" : "border-border", h.available ? "cursor-pointer" : "cursor-not-allowed opacity-60")}>
                        <input type="radio" name="harness" value={h.id} checked={f.harness === h.id} disabled={!h.available && f.harness !== h.id} onChange={() => set({ harness: h.id, ...(creating && !toolsTouched ? { tools: defaultTools(h.id, caps.tools) } : {}) })} className="mt-1 accent-[hsl(var(--primary))]" />
                        <span><span className="block font-mono text-[13px] font-semibold">{h.label}</span><span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{h.available ? h.id : h.reason}</span></span>
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              {!workflow && (
                <Field label="Thinking" note="How hard the model thinks before it answers." error={fieldError("thinking")}>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Thinking">
                    {caps.thinking.map((t) => (
                      <label key={t} className={cn("caps cursor-pointer border px-3 py-2 text-[12px]", f.thinking === t ? "border-foreground" : "text-muted-foreground")}>
                        <input type="radio" name="thinking" className="sr-only" checked={f.thinking === t} onChange={() => set({ thinking: t })} />{t}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              <Field label="Model" optional note={caps.defaultModel ? `Empty uses the server's default (${caps.defaultModel}).` : undefined} error={fieldError("model")}>
                <input value={f.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} placeholder={caps.defaultModel ?? "provider/model"} className={input} />
              </Field>
            </div>
          )}

          {step === "history" && (
            <ul className="max-w-3xl border">
              {revisions.map((r) => (
                <li key={r.revision} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <span className="caps w-14 text-[12px]">rev {r.version}</span>
                  <span className="min-w-0 flex-1 text-[14px]">{r.note ?? <span className="text-muted-foreground">No note</span>}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{when(r.created_at)}</span>
                  {r.current ? <Chip tone="success">Current</Chip> : <Button size="sm" onClick={() => onMakeCurrent?.(r.revision)} disabled={!onMakeCurrent}>Make current</Button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t px-5 py-3 md:px-8">
        <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => setStep(steps[at - 1].id)}><ArrowLeft aria-hidden /> Previous</Button>
        {step !== "history" && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={creating ? "" : "What changed (a note on this revision)"} aria-label="Revision note" className={cn(input, "h-9 min-w-0 flex-1 py-0", creating && "invisible")} />}
        {step === "history" && <span className="flex-1" />}
        {saved && <span className="caps text-[11px] text-success-text">Saved</span>}
        {at < steps.length - 1 && <Button size="sm" onClick={() => setStep(steps[at + 1].id)}>Next <ArrowRight aria-hidden /></Button>}
        <Button size="sm" variant="solid" onClick={save} disabled={!onSave || saving || !f.name?.trim() || (!workflow && !f.instructions?.trim())}>{saving ? "Saving" : creating ? "Create" : "Save revision"}</Button>
      </footer>
    </div>
  );
}

const input = "w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong";

function Field({ label, required, optional, note, error, aside, children }: { label: string; required?: boolean; optional?: boolean; note?: string; error?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="caps text-[12px] font-semibold">{label}{required && <span className="text-destructive-text"> *</span>}{optional && <span className="font-normal normal-case text-muted-foreground"> (optional)</span>}</span>
        {aside}
      </div>
      {note && <p className="-mt-1 mb-2 text-[12px] text-muted-foreground">{note}</p>}
      {children}
      {error && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{error}</p>}
    </div>
  );
}
