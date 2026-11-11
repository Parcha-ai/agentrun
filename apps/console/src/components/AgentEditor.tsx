import { Archive, ArrowLeft, ArrowRight, Check, Eye, FileText, History, Monitor, Settings, TriangleAlert, Workflow, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LearningField } from "@/components/LearningSwitch";
import { McpToolPicker } from "@/components/McpToolPicker";
import { ComputerSetting } from "@/components/ComputerSetting";
import { PlaceSetting } from "@/components/PlaceSetting";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/dialog";
import { AgentToolSettings } from "@/components/ToolSettings";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { Field as UiField, Input, Textarea } from "@/components/ui/field";
import { type Agent, type AgentFields, capOf, DECISION, DEFAULT_INSTRUCTIONS, defaultTools, editBody,harnessOptions, defaultPlaceOf, isStarter, reachesWeb, same, sandboxReason, type SaveProblem, type ToolOffer, toolsFor, warningsFor } from "@/lib/agentForm";
import type { WorkflowCheck } from "@/lib/client";
import { markdown, when } from "@/lib/format";
import { harnessDefault, modelLabel, NO_DEFAULT } from "@/lib/models";
import type { McpServer } from "@/lib/mcp";
import { computerOfPlace, newAgentPlace, placeOf } from "@/lib/place";
import { placeOfComputer } from "@/lib/computers";
import type { ComputerKindView } from "@/lib/v2";
import type { Places } from "@/lib/place";
import type { ToolSettings } from "@/lib/v2";
import { callNodeTools, SERVER_DENY, serverDenies, type ToolChoice, type ToolGate } from "@/lib/toolSettings";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import { cn } from "@/lib/utils";
import { type Approvals, NEVER_ASK_LINE } from "@/lib/v2";

/** A revision as GET /v2/agents/{id}/revisions lists it; `definition` is what it holds (a workflow revision's workflow). */
export type Revision = { revision: string; version: number; current: boolean; note: string | null; created_at: string; definition?: Agent["definition"] };
/** `decisionProvider`: the decision provider a new decision agent's judge names (agentForm's decisionProvider); none when
 *  the server runs no decision workflows a starter can use, and then Decision is offered disabled. `routePrefix`:
 *  capabilities' `models.route_prefix`, the routing prefix taken off model ids. A harness's `default_model` is the model
 *  the server runs for it when a definition names none (null: none). */
/** `computers`: the server's computers list (capabilities.computers.kinds), the Computer step's kinds; null on a server
 *  that lists none, where the step shows where runs go (places). */
export type EditorCaps = { computers?: ComputerKindView[] | null; harnesses: { id: string; available: boolean; reason?: string; default_model?: string | null }[]; tools: ToolOffer[]; thinking: string[]; routePrefix?: string | null; decisionProvider?: string; places?: Places | null; learning?: "on" | "off"; mcp?: boolean; mcpHarnesses?: string[] };
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
  /** The capabilities with a provider choice (capabilities.tools): the Tools step's tool settings, for those the agent grants. */
  providerChoices?: ToolChoice[];
  /** The saved MCP servers, when `caps.mcp`: null while read, "failed" when they could not be. */
  mcpServers?: McpServer[] | null | "failed";
  /** This server's tool settings (GET /v2/settings/tools), for the pins it sets: said beside an agent's own. */
  serverToolSettings?: ToolSettings;
  /** Reads the MCP servers again, after a read that failed. */
  onRetryMcp?: () => void;
  /** Each tool's permission on this server (approvals/1), from capabilities: an agent's own is set over it. */
  permissionGates?: ToolGate[];
  /** A tool whose permission the Tools step opens on, focused (a start refused for it links here). */
  focusTool?: string;
};
type Step = "context" | "workflow" | "computer" | "tools" | "settings" | "history";
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
  { id: "computer", label: "Computer", note: "Where it runs and what it drives", Icon: Monitor },
  { id: "tools", label: "Tools & skills", note: "What this agent can do", Icon: Wrench },
  { id: "settings", label: "Settings", note: "Harness, thinking and model", Icon: Settings },
  { id: "history", label: "History", note: "Revisions and the current one", Icon: History },
];

/** The hosted console's agent builder, over AgentRun Server's agents: a numbered step rail, one step at a time, and a
 *  save that makes a new revision. A save made on a revision that is no longer current is refused (If-Match), and the
 *  editor says so instead of overwriting the other save. */
export function AgentEditor({ agent, revisions = [], caps, onSave, onMakeCurrent, onArchive, onReload, onBack, step: initialStep, problem: initialProblem = null, notice, draft, validate, providerChoices = [], permissionGates = [], focusTool, mcpServers = null, serverToolSettings, onRetryMcp }: EditorProps) {
  const creating = !agent;
  const d = agent?.definition;
  const [chosen, setStep] = useState<Step>(initialStep ?? (agent?.kind === "workflow" ? "workflow" : "context"));
  // Tools are on by default: a new agent starts with every tool its harness runs here; an agent keeps its own. A new
  // agent starts on the place the server gives new agents (a sandbox where it has a box: bash ticked too); else none.
  const startPlace = creating ? newAgentPlace(caps.places) : undefined;
  const [f, setF] = useState<AgentFields>({ name: d?.name ?? "", description: d?.description ?? "", instructions: d?.instructions ?? (creating ? DEFAULT_INSTRUCTIONS : ""), harness: d?.harness ?? "pi", thinking: d?.thinking, model: d?.model, tools: creating ? defaultTools("pi", caps.tools, startPlace) : d?.tools ?? [], maxCostText: typeof d?.max_cost_usd === "number" && d.max_cost_usd > 0 ? String(d.max_cost_usd) : "", ...(startPlace ? { place: startPlace } : {}), ...(agent?.kind === "workflow" ? { workflowText: draft ?? JSON.stringify(d!.workflow, null, 2) } : {}) });
  // The form as it is now, for a save's answer to compare with what that save sent.
  const formNow = useRef(f);
  formNow.current = f;
  // The form as it opened or was last saved: a form that differs from it, or a typed revision note, is unsaved, and a
  // move away asks first.
  const [clean, setClean] = useState<AgentFields>(f);
  // On a new agent, picking another harness re-ticks that harness's tools, until a tool is changed by hand.
  const [toolsTouched, setToolsTouched] = useState(false);
  // The server's tools can arrive after the form opens (capabilities answer late): a new agent's untouched tools follow.
  // So can its places: a new agent with no place yet takes the served default then; a place the person picked stays.
  const toolsKey = caps.tools.map((t) => `${t.name}:${t.available}:${(t.harnesses ?? []).join("+")}`).join(",");
  const placeKey = JSON.stringify(newAgentPlace(caps.places) ?? null);
  useEffect(() => {
    if (!creating) return;
    const follow = (x: AgentFields): AgentFields => {
      const place = x.place ?? newAgentPlace(caps.places);
      return { ...x, ...(place ? { place } : {}), ...(toolsTouched ? {} : { tools: defaultTools(x.harness ?? "pi", caps.tools, place) }) };
    };
    // Defaults that arrive late are where the form opens, never an edit: the clean form takes them too.
    setF(follow); setClean(follow);
  }, [toolsKey, placeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(initialProblem);
  const [saved, setSaved] = useState(false);
  // A workflow agent's past revision, opened from History as its read-only graph.
  const [viewing, setViewing] = useState<Revision | null>(null);
  const goTo = (s: Step) => { setViewing(null); setStep(s); };
  // A refusal at the field, or at a part of it (`tools` takes `definition.tools[1]`), as its warnings are matched.
  const fieldError = (field: string) => (problem?.kind === "invalid" ? Object.entries(problem.fields).filter(([k]) => k === `definition.${field}` || k.startsWith(`definition.${field}[`) || k.startsWith(`definition.${field}.`)).map(([, m]) => m).join(" ") || undefined : undefined);
  // What the save's answer said this host lacks to run the revision: all of it above the form, and each beside the field
  // it names (one the form does not show, such as a place, only above).
  const warnings = agent?.warnings ?? [];
  const fieldWarning = (field: string) => warningsFor(warnings, field).map((w) => w.message).join(" ") || undefined;
  const set = (patch: AgentFields) => { setF((x) => ({ ...x, ...patch })); setSaved(false); };
  const workflow = agent?.kind === "workflow";
  // A new agent made from a starter (Decision, Workflow): a workflow revision, so no instructions, tools, thinking or model.
  const starting = creating && isStarter(f.harness);
  // The agent's approvals as the form has them: changed here, else the definition's, else ask (the server's default).
  const approvals: Approvals = f.approvals ?? d?.approvals ?? "ask";
  const choices = harnessOptions(caps.harnesses, creating ? { available: !!caps.decisionProvider } : undefined);
  // `revisions` counts them; the current one is the agent's `revision`, which can be an earlier one after "Make current".
  const current = revisions.find((r) => r.revision === agent?.revision) ?? revisions.find((r) => r.current);
  // The Computer step is an agentic agent's (a workflow runs on the runner), on a server that lists where runs can go.
  const steps = STEPS.filter((s) => !(creating && s.id === "history") && (s.id !== "workflow" || workflow) && !(starting && s.id === "tools") && (s.id !== "computer" || (!workflow && !starting && !!(caps.computers || caps.places))));
  // A step this agent or server has none of (the Computer step on a server that lists no places) opens the first one.
  const step: Step = steps.some((s) => s.id === chosen) ? chosen : steps[0]!.id;
  const at = steps.findIndex((s) => s.id === step);
  const save = async () => {
    if (!onSave) return;
    setSaving(true);
    // A workflow agent's edit is sent as its parsed JSON; text that does not parse is not sent at all.
    let fields: AgentFields = { ...f, workflowText: undefined, maxCostText: undefined };
    // The default cap, an agentic revision's or a workflow's: the field's number. Emptied, an edit clears a saved cap with an
    // explicit 0 (the server's "no default"; a field left out keeps the cap), and sends none when there is no cap to clear.
    if (!starting) {
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
    const p = await onSave(fields, note);
    // A provider picked or reset while the save was under way is not in it: the form keeps that change, unsaved. Saved
    // and unchanged since, the tool settings are the agent's own: the form shows them as the definition has them.
    const unchanged = same(formNow.current.tool_settings ?? {}, fields.tool_settings ?? {});
    setSaving(false); setProblem(p); setSaved(!p && unchanged); if (!p) setNote("");
    if (!p && unchanged) setF(({ tool_settings: _saved, ...rest }) => rest);
    // Saved, the form as it was sent is the clean one (an edit made while the save was under way stays unsaved).
    if (!p) setClean(unchanged ? (({ tool_settings: _saved, ...rest }) => rest)(f) : f);
  };
  // What a form saves, to tell whether it differs from the clean one: on an agent, the definition its save would send, so
  // a choice put back to the saved one (or to what the form shows when the definition has none) is no change.
  const saves = (x: AgentFields) => {
    const { version: _version, ...def } = agent ? editBody(agent, x, "").definition : { version: 0, ...x };
    return { ...def, approvals: x.approvals ?? d?.approvals ?? "ask" };
  };
  // A save under way holds nothing: a new agent's save opens its page itself.
  const guard = useUnsavedChangesGuard(!saving && (note !== "" || !same(saves(f), saves(clean))));
  // The model a definition that names none runs on, for this harness, as a person reads it: the gateway's routing prefix
  // off, the full id in a title.
  const fallback = harnessDefault(f.harness ?? "pi", caps.harnesses);
  const modelDefault = fallback ? modelLabel(fallback, caps.routePrefix) : undefined;
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
            <span className="caps text-label text-muted-foreground">{current ? `rev ${current.version} current · ` : ""}{agent.revisions} {agent.revisions === 1 ? "revision" : "revisions"}</span>
            {onArchive && <Button size="sm" variant={agent.archived_at ? "primary" : "outline"} onClick={() => onArchive(!agent.archived_at)}><Archive aria-hidden /> {agent.archived_at ? "Unarchive" : "Archive"}</Button>}
          </div>
        )}
      </header>
      {problem?.kind === "conflict" && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-card px-5 py-3 md:px-8" role="alert">
          <TriangleAlert className="size-4 text-warning-text" aria-hidden />
          <p className="min-w-0 flex-1 text-body">This agent changed since you opened it: another revision was saved first, so this save was not made. Reload to see the current revision; it replaces your unsaved edits here.</p>
          <Button size="sm" onClick={onReload}>Reload</Button>
        </div>
      )}
      {notice && <p className="border-b bg-card px-5 py-3 font-mono text-body text-warning-text md:px-8" role="alert">{notice}</p>}
      {warnings.length > 0 && (
        <div className="border-b bg-card px-5 py-3 md:px-8" role="status" aria-label="Save warnings">
          <p className="flex items-center gap-2 font-mono text-body text-warning-text"><TriangleAlert className="size-4 shrink-0" aria-hidden /> Saved. A run of this revision is refused until the server has what each line names:</p>
          <ul className="mt-2 space-y-1 font-mono text-small">
            {warnings.map((w, i) => <li key={`${w.field}:${i}`}><span className="text-muted-foreground">{w.field}</span> {w.message}</li>)}
          </ul>
        </div>
      )}
      {problem?.kind === "invalid" && <p className="border-b bg-card px-5 py-3 font-mono text-body text-destructive-text md:px-8" role="alert">The server refused the save: {problem.message}</p>}
      {problem?.kind === "other" && <p className="border-b bg-card px-5 py-3 font-mono text-body text-destructive-text md:px-8" role="alert">{problem.message}</p>}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ol className={cn("relative flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:flex-col md:gap-0 md:border-b-0 md:border-r md:p-4", step === "workflow" ? "md:w-[76px]" : "md:w-[240px]")}>
          {steps.map((s, i) => (
            <li key={s.id} className="shrink-0">
              <button type="button" aria-current={step === s.id ? "step" : undefined} onClick={() => goTo(s.id)}
                className={cn("flex w-full items-start gap-3 border-l-2 px-3 py-2.5 text-left font-mono", step === s.id ? "border-l-foreground bg-foreground/5" : "border-l-transparent text-muted-foreground hover:text-foreground")}>
                <span className={cn("inline-flex size-6 shrink-0 items-center justify-center border text-label font-semibold", step === s.id ? "border-foreground bg-foreground text-background" : i < at ? "border-border-strong" : "border-border")}>
                  {i < at ? <Check className="size-3" aria-hidden /> : i + 1}
                </span>
                <span className={cn("hidden min-w-0", step !== "workflow" && "md:block")} title={step === "workflow" ? s.label : undefined}>
                  <span className="caps flex items-center gap-1.5 text-small"><s.Icon className="size-3.5" aria-hidden /> {s.label}</span>
                  <span className="mt-0.5 block text-label text-muted-foreground">{s.note}</span>
                </span>
                {/* Below md the rail is a row across the top: step numbers only, so it fits a phone; the step's name heads the step. */}
                <span className="sr-only md:hidden">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <section className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-10">
          <p className="caps text-label text-muted-foreground">Step {at + 1}</p>
          <h2 className="caps mb-6 border-b pb-4 text-prose font-semibold">{steps[at].label}</h2>

          {step === "context" && (
            <div className="max-w-3xl space-y-6">
              <Field label="Name" id="agent-name" required={creating} note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("name")} warning={fieldWarning("name")}>
                <Input id="agent-name" value={f.name} readOnly={!creating} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Invoice checker" />
              </Field>
              <Field label="Description" id="agent-description" optional note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("description")} warning={fieldWarning("description")}>
                <Input id="agent-description" value={f.description} readOnly={!creating} onChange={(e) => set({ description: e.target.value })} placeholder={creating ? "Short summary for the agent list" : "No description"} />
              </Field>
              {starting ? (
                <Field label="Workflow">
                  <p className="border px-3 py-4 font-mono text-body text-muted-foreground">{f.harness === DECISION
                    ? "A decision agent is a workflow. It starts from a starter decision workflow: one typed question, and a person when the answer is unclear or not confident enough. Create it, then edit its nodes in the Workflow step."
                    : "A workflow agent starts from a one-step workflow: an agent node that does what its input's task asks. Create it, then edit its nodes, or paste a workflow's JSON over it, in the Workflow step."}</p>
                </Field>
              ) : workflow ? (
                <Field label="Workflow" note="This agent is a workflow. Edit its nodes in the Workflow step: the graph redraws as you type and the server checks it." warning={fieldWarning("workflow")}>
                  <Button size="sm" onClick={() => setStep("workflow")}><Workflow aria-hidden /> Open the workflow</Button>
                </Field>
              ) : (
                <Field label="Instructions" id={preview ? undefined : "agent-instructions"} required error={fieldError("instructions")} warning={fieldWarning("instructions")}
                  aside={<span className="flex">{(["Preview", "Edit"] as const).map((m) => <Button key={m} type="button" size="xs" aria-pressed={(m === "Preview") === preview} onClick={() => setPreview(m === "Preview")} className={cn("-ml-px first:ml-0", (m === "Preview") === preview ? "relative border-foreground bg-foreground text-background hover:bg-foreground" : "text-muted-foreground")}>{m}</Button>)}</span>}>
                  {preview ? <article className="report min-h-64 border p-4" dangerouslySetInnerHTML={{ __html: markdown(f.instructions || "") }} />
                    : <Textarea id="agent-instructions" value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={14} placeholder="Describe what the agent does, how, and its rules." className="resize-y leading-[1.7]" />}
                  <p className="mt-2 font-mono text-label text-muted-foreground">{(f.instructions ?? "").length} characters</p>
                </Field>
              )}
            </div>
          )}

          {step === "workflow" && (
            <WorkflowEditor text={f.workflowText ?? ""} onText={(t) => set({ workflowText: t })} base={workflow ? d!.workflow : undefined}
              baseLabel={current ? `rev ${current.version}` : undefined} validate={validate} tools={f.tools} serverIssues={workflowIssues(problem, workflow)} />
          )}

          {step === "computer" && !workflow && !starting && caps.computers && (
            <div className="max-w-4xl space-y-8">
              {/* The computer picked, else the one saved, else the place the form starts on as a computer (the server's
                  default for a new agent). A pick sets the place it is too, so a tool a box opens (bash) follows it. */}
              <ComputerSetting kinds={caps.computers} value={f.computer ?? (d?.computer as AgentFields["computer"]) ?? computerOfPlace(f.place ?? { mode: "runner" })}
                onChange={(computer) => {
                  const place = placeOfComputer(computer);
                  const sandboxOnly = new Set(caps.tools.filter((t) => t.sandbox_only).map((t) => t.name));
                  set({ computer, place, ...(place.mode === "runner" ? { tools: (f.tools ?? []).filter((t) => !sandboxOnly.has(t)) } : {}) });
                }} error={fieldError("computer") ?? fieldError("place")} warning={fieldWarning("computer") ?? fieldWarning("place")} />
            </div>
          )}
          {step === "computer" && !workflow && !starting && !caps.computers && caps.places && (
            <div className="max-w-3xl space-y-8">
              {/* A pick is saved as the computer, the setting the server keeps place as a view of; the form's place still
                  decides which tools a box opens (bash). */}
              <PlaceSetting value={f.place} saved={d?.place} places={caps.places} tools={caps.tools} picked={f.tools ?? []}
                onChange={(next) => set({ ...next, ...(next.place ? { computer: computerOfPlace(next.place) } : {}) })} error={fieldError("computer") ?? fieldError("place")} warning={fieldWarning("computer") ?? fieldWarning("place")} />
            </div>
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
                    const why = serverDenies(t.name, permissionGates, agent?.tools) ? SERVER_DENY : t.call_only && !workflow ? "Workflow-only: a workflow's call node runs it, not an agent" : !runs ? `Not on ${f.harness ?? "pi"} on this server` : sandboxReason(t, f.place ?? placeOf(d?.place) ?? defaultPlaceOf(workflow, f.tools ?? [], caps.places)) ?? (!t.available && !pickedOver ? (choice?.reason ?? t.reason ?? `Needs ${(t.missing ?? []).join(", ")}`) : undefined);
                    return (
                      <li key={t.name}><label title={why} className={cn("flex items-center gap-3 border px-3 py-2.5 font-mono text-body", on && "border-foreground", why && !on ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                        <input type="checkbox" value={t.name} checked={on} disabled={!!why && !on} onChange={() => { setToolsTouched(true); set({ tools: on ? f.tools!.filter((x) => x !== t.name) : [...(f.tools ?? []), t.name] }); }} className="accent-primary" />
                        <span className="min-w-0">{t.name}{why && <span className="ml-2 text-label text-muted-foreground">{why}</span>}
                          {t.summary && <Summary text={t.summary} />}</span>
                      </label></li>
                    );
                  })}
                  {caps.mcp && !workflow && <li className="sm:col-span-2"><McpToolPicker servers={mcpServers} tools={f.tools ?? []} harness={f.harness ?? "pi"} harnesses={caps.mcpHarnesses} onRetry={onRetryMcp} onChange={(tools) => { setToolsTouched(true); set({ tools }); }} /></li>}
                </ul>
                {/* Quiet, here only: an agent can be given no web tool on purpose (one that works on files). */}
                {!workflow && !reachesWeb(f.tools ?? []) && (
                  <p className="mt-2 font-mono text-small text-muted-foreground">This agent can't reach the web: {webHere.length ? `tick ${webHere.join(" or ")} in Tools.` : `${f.harness ?? "pi"} runs no web tool on this server.`}</p>
                )}
              </Field>
              {/* A workflow agent's tools have no provider here (a call node runs the tool as the server resolves it), but each
                  one's permission is this agent's to set: a call node refused for a tool set to deny or ask is fixed here. */}
              {(
                <AgentToolSettings agent={agent} unattended={!workflow && approvals === "never"} harness={f.harness ?? "pi"} model={f.model} tools={f.tools ?? []} choices={workflow ? [] : providerChoices} gates={permissionGates} mcpServers={Array.isArray(mcpServers) ? mcpServers : undefined} serverSettings={serverToolSettings} focus={focusTool} callTools={workflow ? callNodeTools(parsedWorkflow(f.workflowText) ?? d?.workflow) : undefined}
                  value={f.tool_settings ?? d?.tool_settings ?? {}} issues={problem?.kind === "invalid" ? problem.fields : {}}
                  // Settings equal to the definition's are no change of the form's. While a save is under way the definition is
                  // about to be what it sent, so every change is kept: the save's answer drops it only if it equals what was sent.
                  onChange={(next) => (!saving && same(next, d?.tool_settings ?? {}) ? (setF(({ tool_settings: _gone, ...rest }) => rest), setSaved(false)) : set({ tool_settings: next }))} />
              )}
              {/* The agent's approvals (definition.approvals): whether a call its gate says ask waits for you. */}
              {!workflow && !starting && (
                <fieldset aria-label="Approvals" className="space-y-2">
                  <legend className="caps text-small font-semibold">Approvals</legend>
                  {([["ask", "Ask me", "A call whose permission is ask waits for your answer."], ["never", "Never ask (run unattended)", "For an agent that runs on a trigger, with no one there to answer."]] as const).map(([value, label, note]) => (
                    <label key={value} className={cn("flex items-start gap-3 border px-3 py-2.5", approvals === value && "border-foreground")}>
                      <input type="radio" name="approvals" value={value} className="mt-1 accent-primary" checked={approvals === value} disabled={saving} onChange={() => set({ approvals: value })} />
                      <span><span className="font-mono text-body">{label}</span><span className="block text-small text-muted-foreground">{note}</span></span>
                    </label>
                  ))}
                  {approvals === "never" && <p className="text-small text-warning-text">{NEVER_ASK_LINE}</p>}
                </fieldset>
              )}
              <Field label="Skills" note="Skill files are saved with each revision and kept as they are by an edit.">
                {d?.skills?.length ? <ul className="border">{d.skills.map((s) => <li key={s} className="border-b px-3 py-2 font-mono text-body last:border-b-0">{s}</li>)}</ul>
                  : <p className="border px-3 py-4 font-mono text-body text-muted-foreground">No skills.</p>}
              </Field>
            </div>
          )}

          {step === "settings" && (
            <div className="max-w-3xl space-y-8">
              {!workflow && (
                <Field named label="Harness" note="What runtime runs this agent." error={fieldError("harness")} warning={fieldWarning("harness")}>
                  {/* Cards by a minimum width: they wrap to more rows in a narrow pane (a phone on its side), never squeezed. */}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-3" role="radiogroup" aria-label="Harness">
                    {/* A harness this server runs is one label, a click anywhere on the card picks it. One it doesn't run says so
                        briefly (the served `available: false`), and the server's whole reason, an install command in it, is one
                        tap away in a details line beside the label (so opening it never picks the card), wrapping inside it. */}
                    {choices.map((h) => {
                      const row = (
                        <>
                          <input type="radio" name="harness" value={h.id} checked={f.harness === h.id} disabled={!h.available && f.harness !== h.id} onChange={() => set({ harness: h.id, ...(creating && !toolsTouched ? { tools: defaultTools(h.id, caps.tools, f.place) } : {}) })} className="mt-1 accent-primary" />
                          <span className="min-w-0"><span className="block break-words font-mono text-body font-semibold">{h.label}</span><span className="mt-0.5 block font-mono text-label text-muted-foreground">{h.available ? h.id : "Not available here"}</span></span>
                        </>
                      );
                      const edge = cn("min-w-0 border px-4 py-3", f.harness === h.id ? "border-foreground" : "border-border");
                      return h.available ? (
                        <label key={h.id} className={cn(edge, "flex cursor-pointer items-start gap-3")}>{row}</label>
                      ) : (
                        <div key={h.id} className={cn(edge, "opacity-60")}>
                          <label className="flex cursor-not-allowed items-start gap-3">{row}</label>
                          {h.reason && (
                            <details className="mt-2 font-mono text-label text-muted-foreground">
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
                <Field named label="Thinking" note="How hard the model thinks before it answers." error={fieldError("thinking")} warning={fieldWarning("thinking")}>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Thinking">
                    {caps.thinking.map((t) => (
                      <label key={t} className={cn("caps cursor-pointer border px-3 py-2 text-small", f.thinking === t ? "border-foreground" : "text-muted-foreground")}>
                        <input type="radio" name="thinking" className="sr-only" checked={f.thinking === t} onChange={() => set({ thinking: t })} />{t}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              {!starting && (
                <Field label="Model" id="agent-model" optional note={modelDefault ? <>Empty uses the server's default (<span title={modelDefault.title}>{modelDefault.text}</span>).</> : NO_DEFAULT} error={fieldError("model")} warning={fieldWarning("model")}>
                  <Input id="agent-model" value={f.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} placeholder="provider/model" />
                </Field>
              )}
              {!starting && (
                <Field label="Default spend cap per run, $" id="agent-max-cost" optional note="A run started without a cap of its own, and a trigger with none, stops at this spend. Empty means none." error={fieldError("max_cost_usd")} warning={fieldWarning("max_cost_usd")}>
                  <Input id="agent-max-cost" inputMode="decimal" value={f.maxCostText ?? ""} onChange={(e) => set({ maxCostText: e.target.value })} placeholder="e.g., 2.50" />
                </Field>
              )}
              {!workflow && !starting && caps.learning && <LearningField fields={f} onFields={set} saved={d?.learning} server={caps.learning} error={fieldError("learning")} warning={fieldWarning("learning")} />}
            </div>
          )}

          {step === "history" && viewing && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="ghost" onClick={() => setViewing(null)}><ArrowLeft aria-hidden /> Back to History</Button>
                <span className="caps text-small">rev {viewing.version}</span>
                <span className="min-w-0 flex-1 text-lead">{viewing.note ?? <span className="text-muted-foreground">No note</span>}</span>
                <span className="font-mono text-label text-muted-foreground">{when(viewing.created_at)}</span>
                <Button size="sm" onClick={() => onMakeCurrent?.(viewing.revision)} disabled={!onMakeCurrent}>Make current</Button>
              </div>
              <WorkflowEditor readOnly text={JSON.stringify(viewing.definition?.workflow, null, 2)} onText={() => {}} base={d!.workflow} baseLabel={current ? `rev ${current.version}, the current one` : "the current revision"} />
            </div>
          )}

          {step === "history" && !viewing && (
            <ul className="max-w-3xl border">
              {revisions.map((r) => (
                <li key={r.revision} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <span className="caps w-14 text-small">rev {r.version}</span>
                  <span className="min-w-0 flex-[1_1_14rem] break-words text-lead">{r.note ?? <span className="text-muted-foreground">No note</span>}</span>
                  <span className="font-mono text-label text-muted-foreground">{when(r.created_at)}</span>
                  {workflow && !r.current && r.definition?.workflow !== undefined && <Button size="sm" variant="ghost" onClick={() => setViewing(r)} aria-label={`View rev ${r.version}`}><Eye aria-hidden /> View</Button>}
                  {r.current ? <Chip tone="success">Current</Chip> : <Button size="sm" onClick={() => onMakeCurrent?.(r.revision)} disabled={!onMakeCurrent}>Make current</Button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t px-5 py-3 md:px-8">
        <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => goTo(steps[at - 1].id)}><ArrowLeft aria-hidden /> Previous</Button>
        {step !== "history" && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={creating ? "" : "What changed (a note on this revision)"} aria-label="Revision note" className={cn("h-9 min-w-0 flex-1", creating && "invisible")} />}
        {step === "history" && <span className="flex-1" />}
        {saved && <span className="caps text-label text-success-text">Saved</span>}
        {at < steps.length - 1 && <Button size="sm" onClick={() => goTo(steps[at + 1].id)}>Next <ArrowRight aria-hidden /></Button>}
        {!viewing && <Button size="sm" variant="solid" onClick={save} disabled={!onSave || saving || !f.name?.trim() || (!workflow && !starting && !f.instructions?.trim())}>{saving ? "Saving" : creating ? "Create" : "Save revision"}</Button>}
      </footer>
      <ConfirmDialog open={guard.asking} title="Leave without saving?" confirm="Leave" cancel="Stay" onConfirm={guard.leave} onCancel={guard.stay}>
        {creating ? "This new agent is not saved yet." : "Your changes to this agent are not saved."} Leave drops them; Stay keeps them here.
      </ConfirmDialog>
    </div>
  );
}



/** The editor's field: the console's Field. One without an `id` holds several controls, or none, so its heading names
 *  the group; `named`: what it holds is a radiogroup with that name already. */
const Field = ({ named, ...props }: Omit<React.ComponentProps<typeof UiField>, "group"> & { named?: boolean }) => <UiField {...props} group={props.id ? false : named ? "heading" : true} />;

/** A tool's description in its card: two lines, and "more" for the rest when it is longer (a tool's summary is written for
 *  the model, often a paragraph). A <div>-free span pair, so the clamp's own display holds. "more" never ticks the tool. */
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="mt-0.5 block font-sans text-label text-muted-foreground">
      <span className={open ? undefined : "line-clamp-2"} title={text}>{text}</span>
      {text.length > 120 && (
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}>{open ? "less" : "more"}</button>
      )}
    </span>
  );
}
