import { Archive, ArrowLeft, ArrowRight, Check, Eye, FileText, History, Settings, TriangleAlert, Workflow, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LearningField } from "@/components/LearningSwitch";
import { McpToolPicker } from "@/components/McpToolPicker";
import { PlaceSetting } from "@/components/PlaceSetting";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { AgentToolSettings } from "@/components/ToolSettings";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { type Agent, type AgentFields, capOf, DECISION, defaultTools, harnessOptions, defaultPlaceOf, isStarter, reachesWeb, same, sandboxReason, type SaveProblem, type ToolOffer, toolsFor, warningsFor } from "@/lib/agentForm";
import type { WorkflowCheck } from "@/lib/client";
import { markdown, when } from "@/lib/format";
import { harnessDefault, modelLabel, NO_DEFAULT } from "@/lib/models";
import type { McpServer } from "@/lib/mcp";
import { newAgentPlace, placeOf } from "@/lib/place";
import type { Places } from "@/lib/place";
import { callNodeTools, type ToolChoice, type ToolGate } from "@/lib/toolSettings";
import { useLeaveGuard } from "@/lib/leaving";
import { cn } from "@/lib/utils";

/** A revision as GET /v2/agents/{id}/revisions lists it; `definition` is what it holds (a workflow revision's workflow). */
export type Revision = { revision: string; version: number; current: boolean; note: string | null; created_at: string; definition?: Agent["definition"] };
/** `decisionProvider`: the decision provider a new decision agent's judge names (agentForm's decisionProvider); none when
 *  the server runs no decision workflows a starter can use, and then Decision is offered disabled. `modelSource`:
 *  capabilities' `models.source`; `routePrefix`, its `models.route_prefix`, the routing prefix taken off model ids. A harness's `default_model` is the
 *  model the server runs for it when a definition names none (null: none). */
export type EditorCaps = { harnesses: { id: string; available: boolean; reason?: string; default_model?: string | null }[]; tools: ToolOffer[]; thinking: string[]; defaultModel?: string; modelSource?: string; routePrefix?: string | null; decisionProvider?: string; places?: Places | null; learning?: "on" | "off"; mcp?: boolean; mcpHarnesses?: string[] };
export type EditorProps = {
  /** The agent being edited, or null for a new one. */
  agent: Agent | null;
  revisions?: Revision[];
  caps: EditorCaps;
  /** Saves the form: a new agent, or the next revision of this one. Resolves with the server's refusal, or null. */
  onSave?: (fields: AgentFields, note: string, editor?: { leaveSaved: () => void }) => Promise<SaveProblem | null>;
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
  /** The capabilities with a provider choice (capabilities.tools): the Tools step's tool settings, for those the agent grants. */
  providerChoices?: ToolChoice[];
  /** The saved MCP servers, when `caps.mcp`: null while read, "failed" when they could not be. */
  mcpServers?: McpServer[] | null | "failed";
  /** Reads the MCP servers again, after a read that failed. */
  onRetryMcp?: () => void;
  /** Each tool's permission on this server (approvals/1), from capabilities: an agent's own is set over it. */
  permissionGates?: ToolGate[];
  /** A tool whose permission the Tools step opens on, focused (a start refused for it links here). */
  focusTool?: string;
};
type Step = "context" | "workflow" | "tools" | "settings" | "history";
/** The workflow in the form's text, when it parses; else undefined (the saved one stands). */
const parsedWorkflow = (text: string | undefined): unknown => { try { return text ? JSON.parse(text) : undefined; } catch { return undefined; } };

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
export function AgentEditor({ agent, revisions = [], caps, onSave, onMakeCurrent, onArchive, onReload, onBack, step: initialStep, problem: initialProblem = null, notice, draft, validate, providerChoices = [], permissionGates = [], focusTool, mcpServers = null, onRetryMcp }: EditorProps) {
  const creating = !agent;
  const d = agent?.definition;
  const [step, setStep] = useState<Step>(initialStep ?? (agent?.kind === "workflow" ? "workflow" : "context"));
  // Tools are on by default: a new agent starts with every tool its harness runs here; an agent keeps its own. A new
  // agent starts on the place the server gives new agents (a sandbox where it has a box: bash ticked too); else none.
  const startPlace = creating ? newAgentPlace(caps.places) : undefined;
  const [f, setF] = useState<AgentFields>({ name: d?.name ?? "", description: d?.description ?? "", instructions: d?.instructions ?? "", harness: d?.harness ?? "pi", thinking: d?.thinking, model: d?.model, tools: creating ? defaultTools("pi", caps.tools, startPlace) : d?.tools ?? [], maxCostText: typeof d?.max_cost_usd === "number" && d.max_cost_usd > 0 ? String(d.max_cost_usd) : "", ...(startPlace ? { place: startPlace } : {}), ...(agent?.kind === "workflow" ? { workflowText: draft ?? JSON.stringify(d!.workflow, null, 2) } : {}) });
  // The form as it is now, for a save's answer to compare with what that save sent.
  const formNow = useRef(f);
  formNow.current = f;
  // The form as saved: as it opened, or as its last save left it. A form unlike it holds unsaved changes, and leaving the
  // page asks first (lib/leaving). The revision note is not one: a note alone saves nothing.
  const [base, setBase] = useState<AgentFields>(f);
  const dirty = !same(f, base);
  const leaveSaved = useLeaveGuard(dirty);
  // On a new agent, picking another harness re-ticks that harness's tools, until a tool is changed by hand.
  const [toolsTouched, setToolsTouched] = useState(false);
  // The server's tools can arrive after the form opens (capabilities answer late): a new agent's untouched tools follow.
  // So can its places: a new agent with no place yet takes the served default then; a place the person picked stays.
  const toolsKey = caps.tools.map((t) => `${t.name}:${t.available}:${(t.harnesses ?? []).join("+")}`).join(",");
  const placeKey = JSON.stringify(newAgentPlace(caps.places) ?? null);
  useEffect(() => {
    if (!creating) return;
    // The defaults are no edit: the saved form takes them too.
    const defaults = (x: AgentFields): AgentFields => {
      const place = x.place ?? newAgentPlace(caps.places);
      return { ...x, ...(place ? { place } : {}), ...(toolsTouched ? {} : { tools: defaultTools(x.harness ?? "pi", caps.tools, place) }) };
    };
    setF(defaults); setBase(defaults);
  }, [toolsKey, placeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(initialProblem);
  // The Save button, which keeps the focus after a save the server refused, where its reason shows.
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (problem?.kind === "invalid" || problem?.kind === "other") saveButton.current?.focus(); }, [problem]);
  // A workflow agent's past revision, opened from History as its read-only graph.
  const [viewing, setViewing] = useState<Revision | null>(null);
  const goTo = (s: Step) => { setViewing(null); setStep(s); };
  // A refusal at the field, or at a part of it (`tools` takes `definition.tools[1]`), as its warnings are matched.
  const fieldError = (field: string) => (problem?.kind === "invalid" ? Object.entries(problem.fields).filter(([k]) => k === `definition.${field}` || k.startsWith(`definition.${field}[`) || k.startsWith(`definition.${field}.`)).map(([, m]) => m).join(" ") || undefined : undefined);
  // What the save's answer said this host lacks to run the revision: all of it above the form, and each beside the field
  // it names (one the form does not show, such as a place, only above).
  const warnings = agent?.warnings ?? [];
  const fieldWarning = (field: string) => warningsFor(warnings, field).map((w) => w.message).join(" ") || undefined;
  // While a new agent's Create is under way its form takes no change (its fields are disabled too), so it stays what was sent.
  const set = (patch: AgentFields) => { if (creating && saving) return; setF((x) => ({ ...x, ...patch })); };
  const workflow = agent?.kind === "workflow";
  // A new agent made from a starter (Decision, Workflow): a workflow revision, so no instructions, tools, thinking or model.
  const starting = creating && isStarter(f.harness);
  const choices = harnessOptions(caps.harnesses, creating ? { available: !!caps.decisionProvider } : undefined);
  // `revisions` counts them; the current one is the agent's `revision`, which can be an earlier one after "Make current".
  const current = revisions.find((r) => r.revision === agent?.revision) ?? revisions.find((r) => r.current);
  // The saved revision's number: the one the agent is at (the editor loaded it, or the save returned it), as its revisions
  // name it; unknown until they are read.
  const savedRev = agent ? revisions.find((r) => r.revision === agent.revision)?.version : undefined;
  const steps = STEPS.filter((s) => !(creating && s.id === "history") && (s.id !== "workflow" || workflow) && !(starting && s.id === "tools"));
  const at = steps.findIndex((s) => s.id === step);
  const save = async () => {
    if (!onSave) return;
    setSaving(true);
    // A workflow agent's edit is sent as its parsed JSON; text that does not parse is not sent at all.
    let fields: AgentFields = { ...f, workflowText: undefined, maxCostText: undefined };
    // The default cap, an agentic revision's only: the field's number. Emptied, an edit clears a saved cap with an explicit
    // 0 (the server's "no default"; a field left out keeps the cap), and sends none when there is no cap to clear.
    if (!workflow && !starting) {
      const cap = capOf(f.maxCostText);
      if (!cap.ok) { setSaving(false); setProblem({ kind: "invalid", message: cap.message, fields: { "definition.max_cost_usd": cap.message } }); return; }
      // 0 (typed, or an emptied field) clears a saved cap; with no cap saved there is nothing to clear, and a 0 sent
      // anyway would count as a change and make a revision the server refuses as unchanged.
      const saved = typeof d?.max_cost_usd === "number" && d.max_cost_usd > 0;
      const value = cap.value ?? 0;
      if (value !== 0 || saved) fields = { ...fields, max_cost_usd: value };
    }
    if (workflow) {
      try { fields = { ...fields, workflow: JSON.parse(f.workflowText ?? "") }; }
      catch (e) { setSaving(false); setProblem({ kind: "invalid", message: `The workflow is not JSON: ${(e as Error).message}`, fields: { "definition.workflow": `The workflow is not JSON: ${(e as Error).message}` } }); return; }
    }
    const sent = f;
    // `leaveSaved`: this editor's own guard, for a page that moves on once the save lands (a new agent opening its page).
    // It lifts the guard only while the form is still what this save sent: an edit made while the save was under way
    // was never sent, so the move asks, and Cancel keeps it (as the answer below keeps it unsaved).
    const p = await onSave(fields, note, { leaveSaved: () => { if (same(formNow.current, sent)) leaveSaved(); } });
    // A provider picked or reset while the save was under way is not in it: the form keeps that change, unsaved. Saved
    // and unchanged since, the tool settings are the agent's own: the form shows them as the definition has them.
    const unchanged = same(formNow.current.tool_settings ?? {}, fields.tool_settings ?? {});
    setSaving(false); setProblem(p); if (!p) setNote("");
    if (!p && unchanged) setF(({ tool_settings: _saved, ...rest }) => rest);
    // Saved: the form as sent is the saved one (its tool settings now the definition's, when unchanged since).
    if (!p) setBase(unchanged ? (({ tool_settings: _saved, ...rest }) => rest)(sent) : sent);
  };
  // The model a definition that names none runs on, for this harness, as a person reads it: the gateway's routing prefix
  // off, the full id in a title.
  const fallback = harnessDefault(f.harness ?? "pi", caps.harnesses, caps.defaultModel);
  const modelDefault = fallback ? modelLabel(fallback, { source: caps.modelSource, default: caps.defaultModel, route_prefix: caps.routePrefix }) : undefined;
  // The tools that reach the web which this agent's harness runs here, for the Tools step's hint when it has none of them.
  const webHere = toolsFor(f.harness ?? "pi", caps.tools).filter((t) => reachesWeb([t.name])).map((t) => t.name);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4 md:px-8">
        <Button size="icon" variant="ghost" aria-label="Back to agents" onClick={onBack}><ArrowLeft aria-hidden /></Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-xl font-semibold" title={creating ? undefined : d!.name}>{creating ? "New agent" : d!.name}</h1>
        {/* The kind, revision count and Archive: a row of their own under the name on a phone, so the name keeps the width. */}
        {agent && (
          <div className="flex basis-full flex-wrap items-center gap-3 sm:basis-auto" role="group" aria-label="About this agent">
            <Chip>{agent.kind}</Chip>
            <span className="caps text-[11px] text-muted-foreground">{current ? `rev ${current.version} current · ` : ""}{agent.revisions} {agent.revisions === 1 ? "revision" : "revisions"}</span>
            {onArchive && <Button size="sm" variant={agent.archived_at ? "primary" : "outline"} onClick={() => onArchive(!agent.archived_at)}><Archive aria-hidden /> {agent.archived_at ? "Unarchive" : "Archive"}</Button>}
          </div>
        )}
      </header>
      {problem?.kind === "conflict" && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-card px-5 py-3 md:px-8" role="alert">
          <TriangleAlert className="size-4 text-warning-text" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px]">This agent changed since you opened it: another revision was saved first, so this save was not made. Reload to see the current revision; it replaces your unsaved edits here.</p>
          <Button size="sm" onClick={onReload}>Reload</Button>
        </div>
      )}
      {notice && <p className="border-b bg-card px-5 py-3 font-mono text-[13px] text-warning-text md:px-8" role="alert">{notice}</p>}
      {warnings.length > 0 && (
        <div className="border-b bg-card px-5 py-3 md:px-8" role="status" aria-label="Save warnings">
          <p className="flex items-center gap-2 font-mono text-[13px] text-warning-text"><TriangleAlert className="size-4 shrink-0" aria-hidden /> Saved. A run of this revision is refused until the server has what each line names:</p>
          <ul className="mt-2 space-y-1 font-mono text-[12px]">
            {warnings.map((w, i) => <li key={`${w.field}:${i}`}><span className="text-muted-foreground">{w.field}</span> {w.message}</li>)}
          </ul>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ol className={cn("relative flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:flex-col md:gap-0 md:border-b-0 md:border-r md:p-4", step === "workflow" ? "md:w-[76px]" : "md:w-[240px]")}>
          {steps.map((s, i) => (
            <li key={s.id} className="shrink-0">
              <button type="button" aria-current={step === s.id ? "step" : undefined} onClick={() => goTo(s.id)}
                className={cn("flex w-full items-start gap-3 border-l-2 px-3 py-2.5 text-left font-mono", step === s.id ? "border-l-foreground bg-foreground/5" : "border-l-transparent text-muted-foreground hover:text-foreground")}>
                <span className={cn("inline-flex size-6 shrink-0 items-center justify-center border text-[11px] font-bold", step === s.id ? "border-foreground bg-foreground text-background" : i < at ? "border-border-strong" : "border-border")}>
                  {i < at ? <Check className="size-3" aria-hidden /> : i + 1}
                </span>
                <span className={cn("hidden min-w-0", step !== "workflow" && "md:block")} title={step === "workflow" ? s.label : undefined}>
                  <span className="caps flex items-center gap-1.5 text-[12px]"><s.Icon className="size-3.5" aria-hidden /> {s.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{s.note}</span>
                </span>
                {/* Below md the rail is a row across the top: step numbers only, so it fits a phone; the step's name heads the step. */}
                <span className="sr-only md:hidden">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <section className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-10">
          {/* A new agent's form is read-only while its Create is under way: what the request sent is the form, so the page
              it opens never asks, and no edit made meanwhile is left behind. A refused Create gives it back as it was. */}
          <fieldset disabled={creating && saving} className="m-0 min-w-0 border-0 p-0">
          <p className="caps text-[11px] text-muted-foreground">Step {at + 1}</p>
          <h2 className="caps mb-6 border-b pb-4 text-[15px] font-semibold">{steps[at].label}</h2>

          {step === "context" && (
            <div className="max-w-3xl space-y-6">
              <Field label="Name" id="agent-name" required={creating} note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("name")} warning={fieldWarning("name")}>
                <input id="agent-name" value={f.name} readOnly={!creating} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Invoice checker" className={cn(input, !creating && "text-muted-foreground")} />
              </Field>
              <Field label="Description" id="agent-description" optional note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("description")} warning={fieldWarning("description")}>
                <input id="agent-description" value={f.description} readOnly={!creating} onChange={(e) => set({ description: e.target.value })} placeholder={creating ? "Short summary for the agent list" : "No description"} className={cn(input, !creating && "text-muted-foreground")} />
              </Field>
              {starting ? (
                <Field label="Workflow">
                  <p className="border px-3 py-4 font-mono text-[13px] text-muted-foreground">{f.harness === DECISION
                    ? "A decision agent is a workflow. It starts from a starter decision workflow: one typed question, and a person when the answer is unclear or not confident enough. Create it, then edit its nodes in the Workflow step."
                    : "A workflow agent starts from a one-step workflow: an agent node that does what its input's task asks. Create it, then edit its nodes, or paste a workflow's JSON over it, in the Workflow step."}</p>
                </Field>
              ) : workflow ? (
                <Field label="Workflow" note="This agent is a workflow. Edit its nodes in the Workflow step: the graph redraws as you type and the server checks it." warning={fieldWarning("workflow")}>
                  <Button size="sm" onClick={() => setStep("workflow")}><Workflow aria-hidden /> Open the workflow</Button>
                </Field>
              ) : (
                <Field label="Instructions" id={preview ? undefined : "agent-instructions"} required error={fieldError("instructions")} warning={fieldWarning("instructions")}
                  aside={<span className="flex">{(["Preview", "Edit"] as const).map((m) => <button key={m} type="button" onClick={() => setPreview(m === "Preview")} className={cn("caps border px-2.5 py-1 text-[11px]", (m === "Preview") === preview ? "border-foreground bg-foreground text-background" : "text-muted-foreground")}>{m}</button>)}</span>}>
                  {preview ? <article className="report min-h-64 border p-4" dangerouslySetInnerHTML={{ __html: markdown(f.instructions || "") }} />
                    : <textarea id="agent-instructions" value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={14} placeholder="Describe what the agent does, how, and its rules." className={cn(input, "resize-y leading-[1.7]")} />}
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
              <Field label="Tools" note="On by default: the tools this agent's harness runs on this server. Untick one to take it away." error={fieldError("tools")} warning={fieldWarning("tools")}>
                {/* Columns by a minimum width: as many as fit, one card a row in a narrow pane (a phone on its side). */}
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2">
                  {caps.tools.filter((t) => workflow || !t.call_only || f.tools?.includes(t.name)).map((t) => {
                    // A call-only tool runs only in a workflow's call node, which needs it in its revision's tools: a
                    // workflow agent picks it like any other. An agentic agent is never offered one, and one it already
                    // names shows as such, to untick.
                    const runs = (workflow && t.call_only) || toolsFor(f.harness ?? "pi", caps.tools).some((x) => x.name === t.name);
                    const on = f.tools?.includes(t.name) ?? false;
                    // A tool the server's provider leaves unavailable runs here once this agent picks a provider of its own.
                    const choice = providerChoices.find((c) => c.name === t.name);
                    const ownPick = (f.tool_settings ?? d?.tool_settings ?? {})[t.name]?.provider;
                    const pickedOver = !!choice && ownPick !== undefined && ownPick !== choice.provider;
                    const why = t.call_only && !workflow ? "Workflow-only: a workflow's call node runs it, not an agent" : !runs ? `Not on ${f.harness ?? "pi"} on this server` : sandboxReason(t, f.place ?? placeOf(d?.place) ?? defaultPlaceOf(workflow, f.tools ?? [], caps.places)) ?? (!t.available && !pickedOver ? (choice?.reason ?? t.reason ?? `Needs ${(t.missing ?? []).join(", ")}`) : undefined);
                    return (
                      <li key={t.name}><label title={why} className={cn("flex items-center gap-3 border px-3 py-2.5 font-mono text-[13px]", on && "border-foreground", why && !on ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                        <input type="checkbox" value={t.name} checked={on} disabled={!!why && !on} onChange={() => { setToolsTouched(true); set({ tools: on ? f.tools!.filter((x) => x !== t.name) : [...(f.tools ?? []), t.name] }); }} className="accent-[hsl(var(--primary))]" />
                        <span className="min-w-0">{t.name}{why && <span className="ml-2 text-[11px] text-muted-foreground">{why}</span>}
                          {t.summary && <Summary text={t.summary} />}</span>
                      </label></li>
                    );
                  })}
                  {caps.mcp && !workflow && <li className="sm:col-span-2"><McpToolPicker servers={mcpServers} tools={f.tools ?? []} harness={f.harness ?? "pi"} harnesses={caps.mcpHarnesses} onRetry={onRetryMcp} onChange={(tools) => { setToolsTouched(true); set({ tools }); }} /></li>}
                </ul>
                {/* Quiet, here only: an agent can be given no web tool on purpose (one that works on files). */}
                {!workflow && !reachesWeb(f.tools ?? []) && (
                  <p className="mt-2 font-mono text-[12px] text-muted-foreground">This agent can't reach the web: {webHere.length ? `tick ${webHere.join(" or ")} in Tools.` : `${f.harness ?? "pi"} runs no web tool on this server.`}</p>
                )}
              </Field>
              {/* A workflow agent's tools have no provider here (a call node runs the tool as the server resolves it), but each
                  one's permission is this agent's to set: a call node refused for a tool set to deny or ask is fixed here. */}
              {(
                <AgentToolSettings agent={agent} harness={f.harness ?? "pi"} model={f.model} tools={f.tools ?? []} choices={workflow ? [] : providerChoices} gates={permissionGates} focus={focusTool} callTools={workflow ? callNodeTools(parsedWorkflow(f.workflowText) ?? d?.workflow) : undefined}
                  value={f.tool_settings ?? d?.tool_settings ?? {}} issues={problem?.kind === "invalid" ? problem.fields : {}}
                  // Settings equal to the definition's are no change of the form's. While a save is under way the definition is
                  // about to be what it sent, so every change is kept: the save's answer drops it only if it equals what was sent.
                  onChange={(next) => (!saving && same(next, d?.tool_settings ?? {}) ? setF(({ tool_settings: _gone, ...rest }) => rest) : set({ tool_settings: next }))} />
              )}
              <Field label="Skills" note="Skill files are saved with each revision and kept as they are by an edit.">
                {d?.skills?.length ? <ul className="border">{d.skills.map((s) => <li key={s} className="border-b px-3 py-2 font-mono text-[13px] last:border-b-0">{s}</li>)}</ul>
                  : <p className="border px-3 py-4 font-mono text-[13px] text-muted-foreground">No skills.</p>}
              </Field>
            </div>
          )}

          {step === "settings" && (
            <div className="max-w-3xl space-y-8">
              {!workflow && (
                <Field label="Harness" note="What runtime runs this agent." error={fieldError("harness")} warning={fieldWarning("harness")}>
                  {/* Cards by a minimum width: they wrap to more rows in a narrow pane (a phone on its side), never squeezed. */}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-3" role="radiogroup" aria-label="Harness">
                    {/* A harness this server runs is one label, a click anywhere on the card picks it. One it doesn't run says so
                        briefly (the served `available: false`), and the server's whole reason, an install command in it, is one
                        tap away in a details line beside the label (so opening it never picks the card), wrapping inside it. */}
                    {choices.map((h) => {
                      const row = (
                        <>
                          <input type="radio" name="harness" value={h.id} checked={f.harness === h.id} disabled={!h.available && f.harness !== h.id} onChange={() => set({ harness: h.id, ...(creating && !toolsTouched ? { tools: defaultTools(h.id, caps.tools, f.place) } : {}) })} className="mt-1 accent-[hsl(var(--primary))]" />
                          <span className="min-w-0"><span className="block break-words font-mono text-[13px] font-semibold">{h.label}</span><span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{h.available ? h.id : "Not available here"}</span></span>
                        </>
                      );
                      const edge = cn("min-w-0 border px-4 py-3", f.harness === h.id ? "border-foreground" : "border-border");
                      return h.available ? (
                        <label key={h.id} className={cn(edge, "flex cursor-pointer items-start gap-3")}>{row}</label>
                      ) : (
                        <div key={h.id} className={cn(edge, "opacity-60")}>
                          <label className="flex cursor-not-allowed items-start gap-3">{row}</label>
                          {h.reason && (
                            <details className="mt-2 font-mono text-[11px] text-muted-foreground">
                              <summary className="cursor-pointer select-none hover:text-foreground">Why, and what to do</summary>
                              <p className="mt-1 break-words leading-[1.6]">{h.reason}</p>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Field>
              )}
              {!workflow && !starting && (
                <Field label="Thinking" note="How hard the model thinks before it answers." error={fieldError("thinking")} warning={fieldWarning("thinking")}>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Thinking">
                    {caps.thinking.map((t) => (
                      <label key={t} className={cn("caps cursor-pointer border px-3 py-2 text-[12px]", f.thinking === t ? "border-foreground" : "text-muted-foreground")}>
                        <input type="radio" name="thinking" className="sr-only" checked={f.thinking === t} onChange={() => set({ thinking: t })} />{t}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              {!starting && (
                <Field label="Model" id="agent-model" optional note={modelDefault ? <>Empty uses the server's default (<span title={modelDefault.title}>{modelDefault.text}</span>).</> : NO_DEFAULT} error={fieldError("model")} warning={fieldWarning("model")}>
                  <input id="agent-model" value={f.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} placeholder="provider/model" className={input} />
                </Field>
              )}
              {!workflow && !starting && (
                <Field label="Default spend cap per run, $" id="agent-max-cost" optional note="A run started without a cap of its own, and a trigger with none, stops at this spend. Empty means none." error={fieldError("max_cost_usd")} warning={fieldWarning("max_cost_usd")}>
                  <input id="agent-max-cost" inputMode="decimal" value={f.maxCostText ?? ""} onChange={(e) => set({ maxCostText: e.target.value })} placeholder="e.g., 2.50" className={input} />
                </Field>
              )}
              {!workflow && !starting && caps.places && <PlaceSetting value={f.place} saved={d?.place} places={caps.places} tools={caps.tools} picked={f.tools ?? []} onChange={set} error={fieldError("place")} warning={fieldWarning("place")} />}
              {!workflow && !starting && caps.learning && <LearningField fields={f} onFields={set} saved={d?.learning} server={caps.learning} error={fieldError("learning")} warning={fieldWarning("learning")} />}
            </div>
          )}

          {step === "history" && viewing && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="ghost" onClick={() => setViewing(null)}><ArrowLeft aria-hidden /> Back to History</Button>
                <span className="caps text-[12px]">rev {viewing.version}</span>
                <span className="min-w-0 flex-1 text-[14px]">{viewing.note ?? <span className="text-muted-foreground">No note</span>}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{when(viewing.created_at)}</span>
                <Button size="sm" onClick={() => onMakeCurrent?.(viewing.revision)} disabled={!onMakeCurrent}>Make current</Button>
              </div>
              <WorkflowEditor readOnly text={JSON.stringify(viewing.definition?.workflow, null, 2)} onText={() => {}} base={d!.workflow} baseLabel={current ? `rev ${current.version}, the current one` : "the current revision"} />
            </div>
          )}

          {step === "history" && !viewing && (
            <ul className="max-w-3xl border">
              {revisions.map((r) => (
                <li key={r.revision} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <span className="caps w-14 text-[12px]">rev {r.version}</span>
                  <span className="min-w-0 flex-1 text-[14px]">{r.note ?? <span className="text-muted-foreground">No note</span>}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{when(r.created_at)}</span>
                  {workflow && !r.current && r.definition?.workflow !== undefined && <Button size="sm" variant="ghost" onClick={() => setViewing(r)} aria-label={`View rev ${r.version}`}><Eye aria-hidden /> View</Button>}
                  {r.current ? <Chip tone="success">Current</Chip> : <Button size="sm" onClick={() => onMakeCurrent?.(r.revision)} disabled={!onMakeCurrent}>Make current</Button>}
                </li>
              ))}
            </ul>
          )}
          </fieldset>
        </section>
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t px-5 py-3 md:px-8">
        <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => goTo(steps[at - 1].id)}><ArrowLeft aria-hidden /> Previous</Button>
        {step !== "history" && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={creating ? "" : "What changed (a note on this revision)"} aria-label="Revision note" className={cn(input, "h-9 min-w-0 flex-1 py-0", creating && "invisible")} />}
        {step === "history" && <span className="flex-1" />}
        {at < steps.length - 1 && <Button size="sm" onClick={() => goTo(steps[at + 1].id)}>Next <ArrowRight aria-hidden /></Button>}
        {/* Off with nothing to save, saying which revision is saved (the served current one); on with an edit. */}
        {!viewing && <Button ref={saveButton} size="sm" variant="solid" onClick={save} disabled={!onSave || saving || (!creating && !dirty) || !f.name?.trim() || (!workflow && !starting && !f.instructions?.trim())}>{creating ? (saving ? "Creating…" : "Create") : saving ? "Saving…" : dirty ? "Save revision" : savedRev ? `Saved · rev ${savedRev}` : "Saved"}</Button>}
        {/* Why a save failed, under the button that made it. */}
        {problem?.kind === "invalid" && <p className="w-full text-right font-mono text-[12px] text-destructive-text" role="alert">The server refused the save: {problem.message}</p>}
        {problem?.kind === "other" && <p className="w-full text-right font-mono text-[12px] text-destructive-text" role="alert">{problem.message}</p>}
      </footer>
    </div>
  );
}


const input = "w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong";

function Field({ label, id, required, optional, note, error, warning, aside, children }: { label: string; id?: string; required?: boolean; optional?: boolean; note?: React.ReactNode; error?: string; warning?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  // `id`: the one input this field holds, which its label names. A field of several controls (a list, a radio group)
  // names them its own way, so its heading is no label.
  const Heading = id ? "label" : "span";
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <Heading {...(id ? { htmlFor: id } : {})} className="caps text-[12px] font-semibold">{label}{required && <span className="text-destructive-text"> *</span>}{optional && <span className="font-normal normal-case text-muted-foreground"> (optional)</span>}</Heading>
        {aside}
      </div>
      {note && <p className="-mt-1 mb-2 text-[12px] text-muted-foreground">{note}</p>}
      {children}
      {error && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{error}</p>}
      {warning && <p className="mt-2 font-mono text-[12px] text-warning-text">{warning}</p>}
    </div>
  );
}

/** A tool's description in its card: two lines, and "more" for the rest when it is longer (a tool's summary is written for
 *  the model, often a paragraph). A <div>-free span pair, so the clamp's own display holds. "more" never ticks the tool. */
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="mt-0.5 block font-sans text-[11px] text-muted-foreground">
      <span className={open ? undefined : "line-clamp-2"} title={text}>{text}</span>
      {text.length > 120 && (
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}>{open ? "less" : "more"}</button>
      )}
    </span>
  );
}
