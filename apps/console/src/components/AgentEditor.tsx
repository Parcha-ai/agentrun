import { cliLearningOf } from "@/lib/cliLearning";
import { Archive, ArchiveRestore, ArrowLeft, BookOpen, Brain, Eye, FileText, History, Monitor, Settings, TriangleAlert, Workflow, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LearningField } from "@/components/LearningSwitch";
import { MonidGrants, monidCards } from "@/components/MonidGrants";
import { ComputerSetting } from "@/components/ComputerSetting";
import { PlaceSetting } from "@/components/PlaceSetting";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Chip } from "@/components/ui/chip";
import { NavItem } from "@/components/ui/nav-item";
import { Picker } from "@/components/ui/picker";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ToolPicker } from "@/components/ToolPicker";
import { AgentToolSettings } from "@/components/ToolSettings";
import { AgentSkillsEditor } from "@/components/AgentSkillsEditor";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { backendSdkOf } from "@/lib/backendSdk";
import { buildAgentPrompt, DEFINITION_TEXT_NOTE, editAgentPrompt } from "@/lib/codingAgentPrompts";
import { type Agent, type AgentFields, type Definition, capOf, editBody, toolsOnSwitch, notOn, DECISION, DEFAULT_INSTRUCTIONS, defaultTools, harnessOptions, isStarter, reachesWeb, same, type SaveProblem, type ToolOffer, toolsFor, warningsFor } from "@/lib/agentForm";
import type { WorkflowCheck } from "@/lib/client";
import { markdown, when } from "@/lib/format";
import { type FreeModel, freeRequestsNote, harnessDefault } from "@/lib/models";
import { ModelField, useModelField } from "@/components/ModelField";
import { SettingsSection } from "@/components/Settings";
import { SpendCapMinimum } from "@/lib/spendCap";
import { CAP_NOTE, isPlanModel } from "@/lib/chatgpt";
import type { McpServer } from "@/lib/mcp";
import { isMonidName, monidFieldsOf, splitMonidWarnings } from "@/lib/monid";
import { computerOfPlace, newAgentPlace, placeOf } from "@/lib/place";
import { computerFields } from "@/lib/computers";
import type { ComputerKindView } from "@/lib/v2";
import type { Places } from "@/lib/place";
import type { ToolSettings } from "@/lib/v2";
import { callNodeTools, type ToolChoice, type ToolGate } from "@/lib/toolSettings";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import { cn } from "@/lib/utils";
import { pageToolbarClass } from "@/components/ui/toolbar";
import { type Approvals, NEVER_ASK_LINE } from "@/lib/v2";

/** A revision as GET /v2/agents/{id}/revisions lists it; `definition` is what it holds (a workflow revision's workflow). */
export type Revision = { revision: string; version: number; current: boolean; note: string | null; created_at: string; definition?: Definition };
/** `decisionProvider`: the decision provider a new decision agent's judge names (agentForm's decisionProvider); none when
 *  the server runs no decision workflows a starter can use, and then Decision is offered disabled. `routePrefix`:
 *  capabilities' `models.route_prefix`, the routing prefix taken off model ids. A harness's `default_model` is the model
 *  the server runs for it when a definition names none (null: none). */
/** `computers`: the server's computers list (capabilities.computers.kinds), the Computer step's kinds; null on a server
 *  that lists none, where the step shows where runs go (places). */
export type EditorCaps = { computers?: ComputerKindView[] | null; harnesses: { id: string; available: boolean; reason?: string; needs?: string[]; default_model?: string | null; models?: string[]; free_models?: FreeModel[] }[]; tools: ToolOffer[]; thinking: string[]; routePrefix?: string | null; decisionProvider?: string; places?: Places | null; learning?: "on" | "off"; mcp?: boolean; mcpHarnesses?: string[]; freeRequests?: number };

export type EditorProps = {
  /** The agent being edited, or null for a new one. */
  agent: Agent | null;
  revisions?: Revision[];
  /** Every skill file from the loaded revision; undefined until its complete contents are read. */
  skillFiles?: Record<string, string>;
  skillFilesError?: string;
  onRetrySkills?: () => void;
  caps: EditorCaps;
  /** Saves the form: a new agent, or the next revision of this one. Resolves with the server's refusal, or null. */
  onSave?: (fields: AgentFields, note: string) => Promise<SaveProblem | null>;
  onMakeCurrent?: (revision: string) => void;
  onArchive?: (archive: boolean) => void;
  onReload?: () => void;
  onBack?: () => void;
  /** Inside an agent page: its toolbar already names the agent and provides navigation. */
  embedded?: boolean;
  /** The surrounding toolbar's coding-agent handoff, including the live form draft; cleared when the editor leaves. */
  onEditPromptChange?: (prompt: string | null) => void;
  /** A new agent's brief from an editor link; existing definitions always keep their saved instructions. */
  initialInstructions?: string;
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
type Step = "context" | "workflow" | "computer" | "tools" | "skills" | "settings" | "learning" | "history";
/** The workflow in the form's text, when it parses; else undefined (the saved one stands). */
const parsedWorkflow = (text: string | undefined): unknown => { try { return text ? JSON.parse(text) : undefined; } catch { return undefined; } };

/** A refused save's issues in the workflow: each 422 field under definition.workflow at its path, else the refusal's
 *  message for a workflow agent. */
function workflowIssues(problem: SaveProblem | null, workflow: boolean): { path: string; message: string }[] | null {
  if (problem?.kind !== "invalid") return null;
  const mine = Object.entries(problem.fields).filter(([f]) => f === "definition.workflow" || f.startsWith("definition.workflow/")).map(([f, message]) => ({ path: f.slice("definition.workflow".length), message }));
  return mine.length ? mine : workflow ? [{ path: "", message: problem.message }] : null;
}

/** The section that shows a definition's field; creation and editing share the same sections. */
function stepOfField(field: string): Step | undefined {
  if (field === "skills" || field.startsWith("skills.")) return "skills";
  const name = /^definition\.([a-z_]+)/.exec(field)?.[1];
  if (!name) return undefined;
  if (["name", "description", "instructions"].includes(name)) return "context";
  if (["tools", "tool_settings", "approvals"].includes(name)) return "tools";
  if (name === "skills") return "skills";
  if (["harness", "thinking", "model", "max_cost_usd"].includes(name)) return "settings";
  if (name === "learning") return "learning";
  if (["place", "computer"].includes(name)) return "computer";
  if (name === "workflow") return "workflow";
  return undefined;
}

const STEPS: { id: Step; label: string; note: string; Icon: typeof FileText }[] = [
  { id: "context", label: "General", note: "Name, description and instructions", Icon: FileText },
  { id: "workflow", label: "Workflow", note: "Its graph and its JSON", Icon: Workflow },
  { id: "computer", label: "Computer", note: "Where it runs and what it drives", Icon: Monitor },
  { id: "tools", label: "Tools", note: "What this agent can do", Icon: Wrench },
  { id: "skills", label: "Skills", note: "Skill files saved with this revision", Icon: BookOpen },
  { id: "settings", label: "Model & runtime", note: "Runtime, model and spending", Icon: Settings },
  { id: "learning", label: "Learning", note: "Corrections and reusable workflows", Icon: Brain },
  { id: "history", label: "History", note: "Revisions and the current one", Icon: History },
];

/** Create and configure agents with one settings editor and one set of configuration controls. A save makes a
 *  new revision. A save made on a revision that is no longer current is refused (If-Match), and the editor says so
 *  instead of overwriting the other save. */
export function AgentEditor({ agent, revisions = [], skillFiles, skillFilesError, onRetrySkills, caps, onSave, onMakeCurrent, onArchive, onReload, onBack, embedded = false, onEditPromptChange, initialInstructions, step: initialStep, problem: initialProblem = null, notice, draft, validate, providerChoices = [], permissionGates = [], focusTool, mcpServers = null, serverToolSettings, onRetryMcp }: EditorProps) {
  const creating = !agent;
  const d = agent?.definition;
  const sdk = backendSdkOf(d);
  const cli = cliLearningOf(d);
  const sourceOwned = !!d?.native || !!sdk || !!cli;
  const [chosen, setStep] = useState<Step>(initialStep ?? (agent?.kind === "workflow" ? "workflow" : "context"));
  // Tools are on by default: a new agent starts with every tool its harness runs here; an agent keeps its own. A new
  // agent starts on the place the server gives new agents (a sandbox where it has a box: bash ticked too); else none.
  const startPlace = creating ? newAgentPlace(caps.places) : undefined;
  const [f, setF] = useState<AgentFields>({ name: d?.name ?? "", description: d?.description ?? "", instructions: d?.instructions ?? (creating ? initialInstructions ?? DEFAULT_INSTRUCTIONS : ""), harness: d?.harness ?? "pi", thinking: d?.thinking, model: d?.model, tools: creating ? defaultTools("pi", caps.tools, startPlace) : d?.tools ?? [], maxCostText: typeof d?.max_cost_usd === "number" && d.max_cost_usd > 0 ? String(d.max_cost_usd) : "", ...(startPlace ? { place: startPlace } : {}), ...(agent?.kind === "workflow" ? { workflowText: draft ?? JSON.stringify(d!.workflow, null, 2) } : {}) });
  // The Model field's own choices (Custom picked, Free only), kept across steps.
  const modelField = useModelField();
  // The form as it is now, for a save's answer to compare with what that save sent.
  const formNow = useRef(f);
  formNow.current = f;
  // The form as saved: as it opened, or as its last save left it. Save is on, and leaving asks first, only for a form
  // unlike it (one flag, so the two never disagree). The revision note is not part of it: a note alone saves nothing.
  const [base, setBase] = useState<AgentFields>(f);
  // What a form saves, to tell whether it differs from the saved one: on an agent, the definition its save would send (a
  // setting put back to the saved one, or to what the form shows when the definition has none, is no change; the form's
  // own tool settings, else the definition's), with approvals as the form shows them and the tools as a set (a harness
  // switch and back can reorder them, never change them).
  const saves = (x: AgentFields): Record<string, unknown> => {
    // The cap and the workflow as Save sends them: "2.50" is the saved 2.5, and reformatted JSON is the same workflow.
    // Text that doesn't parse stays as typed (a change: Save says why it can't send it).
    const { maxCostText, workflowText, ...fields } = x;
    const cap = capOf(maxCostText), parsed = parsedWorkflow(workflowText);
    const sent: AgentFields & Record<string, unknown> = { ...fields, maxCost: cap.ok ? cap.value ?? 0 : maxCostText, ...(workflowText !== undefined ? { workflowSent: parsed !== undefined ? parsed : workflowText } : {}) };
    const def: Record<string, unknown> = agent ? { ...editBody(agent, sent, "").definition } : { ...sent };
    delete def.version;
    if (def.tool_settings && !Object.keys(def.tool_settings).length) delete def.tool_settings;
    return { ...def, skillFiles: x.skillFiles ?? skillFiles ?? {}, tools: [...((def.tools as string[] | undefined) ?? [])].sort(), approvals: x.approvals ?? d?.approvals ?? "ask" };
  };
  const dirty = !same(saves(f), saves(base));
  // The tools a harness switch took off (the new harness doesn't run them here), with why, so a switch back ticks them again.
  const [held, setHeld] = useState<string[]>([]);
  // On a new agent, picking another harness re-ticks that harness's tools, until a tool is changed by hand.
  const [toolsTouched, setToolsTouched] = useState(false);
  // Whether the last computer picked was refused because no tools are listed yet (computerFields answered null).
  const [toolsUnread, setToolsUnread] = useState(false);
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
    // Defaults that arrive late are where the form opens, never an edit: the saved form takes them too.
    setF(follow); setBase(follow);
  }, [toolsKey, placeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState("");
  // Every monid grant this form has shown: the agent's, and each one granted here since. The monid row lists them, ticked or
  // not, so one unticked stays to tick again through a save (the saved revision no longer names it) and a step change (the
  // row is drawn anew). A reload opens the form anew, with the agent's.
  const [monidSeen, setMonidSeen] = useState<string[]>(() => (d?.tools ?? []).filter(isMonidName));
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(initialProblem);
  // The harness and model the problem was said of: the form as the save sent it (one handed in, the form as it opened).
  // The Model field shows a refusal only while the form names both again.
  const [problemOf, setProblemOf] = useState<{ harness: string; model: string | undefined }>(() => ({ harness: f.harness ?? "pi", model: f.model }));
  // A workflow agent's past revision, opened from History as its read-only graph.
  const [viewing, setViewing] = useState<Revision | null>(null);
  const goTo = (s: Step) => { setViewing(null); setStep(s); };
  // The tools the last save sent: a refusal points at a grant by its place in them (`definition.tools[2]`).
  const sentTools = useRef<string[] | null>(null);
  // A refusal at a monid grant, in the server's words: the monid row shows it, beside the grant, not the Tools field.
  const monidAt = monidFieldsOf(sentTools.current ?? f.tools ?? []);
  const monidRefused = problem?.kind === "invalid" ? Object.entries(problem.fields).flatMap(([k, message]) => { const grant = monidAt.get(k); return grant ? [{ grant, message }] : []; }) : [];
  // A refusal at the field, or at a part of it (`tools` takes `definition.tools[1]`), as its warnings are matched.
  const fieldError = (field: string) => (problem?.kind === "invalid" ? Object.entries(problem.fields).filter(([k]) => !monidAt.has(k) && (k === `definition.${field}` || k.startsWith(`definition.${field}[`) || k.startsWith(`definition.${field}.`))).map(([, m]) => m).join(" ") || undefined : undefined);
  // What the save's answer said: of a monid grant (the endpoints a wildcard left out, monid's pricing in the server's
  // words), on the monid row and above the form; else what this host lacks to run the revision, all of it above the form,
  // and each beside the field it names (one the form does not show, such as a place, only above).
  const { monid: monidWarnings, rest: warnings } = splitMonidWarnings(agent?.warnings ?? [], d?.tools ?? []);
  const fieldWarning = (field: string) => warningsFor(warnings, field).map((w) => w.message).join(" ") || undefined;
  // Above the form, what refuses a run until this host has it (the server's not_set_up_here) apart from what a run goes on
  // under (a computer every tool of which is set to deny, which no run starts; a cap below one more step).
  const refusing = warnings.filter((w) => w.reason === "not_set_up_here");
  const noted = warnings.filter((w) => w.reason !== "not_set_up_here");
  // While a new agent's Create is under way its form takes no change (its fields are disabled too), so it stays what was sent.
  const set = (patch: AgentFields) => { if (creating && saving) return; setF((x) => ({ ...x, ...patch })); };
  // The Save button, which keeps the focus after a save the server refused, where its reason shows.
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (problem?.kind === "invalid" || problem?.kind === "other") saveButton.current?.focus(); }, [problem]);
  const workflow = agent?.kind === "workflow";
  // A new agent made from a starter (Decision, Workflow): a workflow revision, so no instructions, tools, thinking or model.
  const starting = creating && isStarter(f.harness);
  const lastAgenticHarness = useRef(f.harness ?? "pi");
  const starters = creating ? harnessOptions(caps.harnesses, { available: !!caps.decisionProvider }).filter((h) => isStarter(h.id)) : [];
  // What a new agent still needs before Create is on.
  const createNeeds = [...(!f.name?.trim() ? ["Give the agent a name to create it."] : []), ...(!workflow && !starting && !f.instructions?.trim() ? ["Write its instructions to create it."] : [])];
  // The agent's approvals as the form has them: changed here, else the definition's, else ask (the server's default).
  const approvals: Approvals = f.approvals ?? d?.approvals ?? "ask";
  const choices = harnessOptions(caps.harnesses);
  // Keep a saved runtime visible even when this server no longer advertises it. Opening Settings never changes it.
  if (f.harness && !choices.some((h) => h.id === f.harness)) choices.push({ id: f.harness, label: f.harness, available: false, reason: "This server does not report this runtime. Your saved choice is kept until you choose another." });
  const unavailable = choices.filter((h) => !h.available);
  const thinkingChoices = [...new Set([...caps.thinking, ...(f.thinking ? [f.thinking] : [])])];
  // Picking a harness: a new agent whose tools are untouched takes that harness's tools. Otherwise the tools it doesn't
  // run here come off at once, before any save, and are held: a switch back ticks them again.
  const toolOpts = { mcpHarnesses: caps.mcpHarnesses, workflow };
  // A place off the box (the runner) takes the box's tools (bash) off the held ones too: a later switch back to a harness
  // never ticks a tool the place now refuses.
  const leavePlace = (place: { mode?: string }) => {
    if (place.mode === "sandbox") return;
    const sandboxOnly = new Set(caps.tools.filter((t) => t.sandbox_only).map((t) => t.name));
    setHeld((h) => h.filter((t) => !sandboxOnly.has(t)));
  };
  const pickHarness = (harness: string) => {
    if (harness === f.harness) return;
    if (creating && !toolsTouched) { set({ harness, tools: defaultTools(harness, caps.tools, f.place) }); setHeld([]); return; }
    const next = toolsOnSwitch(harness, f.tools ?? [], held, caps.tools, toolOpts);
    if (agent?.source_sync) {
      // Keep required imported tools selected. The normal capability/save checks explain an incompatible harness.
      set({ harness });
      return;
    }
    set({ harness, tools: next.tools });
    setHeld(next.held);
  };
  // `revisions` counts them; the current one is the agent's `revision`, which can be an earlier one after "Make current".
  const current = revisions.find((r) => r.revision === agent?.revision) ?? revisions.find((r) => r.current);
  // The Computer step is an agentic agent's (a workflow runs on the runner), on a server that lists where runs can go.
  const steps = STEPS.filter((s) => (!starting || s.id === "context") && !(creating && s.id === "history") && (s.id !== "workflow" || workflow) && (s.id !== "computer" || (!workflow && !!(caps.computers || caps.places))) && (s.id !== "learning" || (!workflow && !!caps.learning)));
  // A step this agent or server has none of (the Computer step on a server that lists no places) opens the first one.
  const step: Step = steps.some((s) => s.id === chosen) ? chosen : steps[0]!.id;
  const at = steps.findIndex((s) => s.id === step);
  const save = async () => {
    if (!onSave) return;
    // The form this save sends: once saved, it is the form as saved.
    const sent = f;
    sentTools.current = f.tools ?? [];
    setSaving(true);
    // A workflow agent's edit is sent as its parsed JSON; text that does not parse is not sent at all.
    let fields: AgentFields = { ...f, workflowText: undefined, maxCostText: undefined };
    // The default cap, an agentic revision's or a workflow's: the field's number. Emptied, an edit clears a saved cap with an
    // explicit 0 (the server's "no default"; a field left out keeps the cap), and sends none when there is no cap to clear.
    const cap = capOf(starting ? undefined : f.maxCostText);
    if (!cap.ok) { setSaving(false); setProblem({ kind: "invalid", message: cap.message, fields: { "definition.max_cost_usd": cap.message } }); return; }
    // 0 (typed, or an emptied field) clears a saved cap; with no cap saved there is nothing to clear, and a 0 sent
    // anyway would count as a change and make a revision the server refuses as unchanged.
    const saved = typeof d?.max_cost_usd === "number" && d.max_cost_usd > 0;
    const value = cap.value ?? 0;
    if (value !== 0 || saved) fields = { ...fields, max_cost_usd: value };
    if (workflow) {
      try { fields = { ...fields, workflow: JSON.parse(f.workflowText ?? "") }; }
      catch (e) { setSaving(false); setProblem({ kind: "invalid", message: `The workflow is not JSON: ${(e as Error).message}`, fields: { "definition.workflow": `The workflow is not JSON: ${(e as Error).message}` } }); return; }
    }
    const p = await onSave(fields, note);
    // A provider picked or reset while the save was under way is not in it: the form keeps that change, unsaved. Saved
    // and unchanged since, the tool settings are the agent's own: the form shows them as the definition has them.
    const unchanged = same(formNow.current.tool_settings ?? {}, fields.tool_settings ?? {});
    setSaving(false); setProblem(p); setProblemOf({ harness: sent.harness ?? "pi", model: sent.model });
    if (p) return;
    // Saved, the form as it was sent is the saved one (an edit made while the save was under way stays unsaved).
    // The held tools are the saved harness's to give back no more; a switch made while the save was under way keeps its own.
    setNote(""); if (formNow.current.harness === sent.harness) setHeld([]);
    setBase(unchanged ? (({ tool_settings: _saved, ...rest }) => rest)(sent) : sent);
    if (unchanged) setF(({ tool_settings: _saved, ...rest }) => rest);
  };
  // A save under way holds nothing: a new agent's save opens its page itself.
  const guard = useUnsavedChangesGuard(!saving && dirty);
  // The model a definition that names none runs on, for this harness (the server's default for it).
  const fallback = harnessDefault(f.harness ?? "pi", caps.harnesses);
  // A server signed in to a ChatGPT plan (a harness offers its models): the cap says it counts dollars, which the plan's
  // requests are not.
  const onPlan = caps.harnesses.some((h) => isPlanModel(h.default_model) || h.models?.some(isPlanModel));
  // The model this agent runs on, picked or the default, is a free one ($0 a request): no dollar cap stops it, and
  // the cap's note says the server's limit on its requests (capabilities' limits.free_model_requests).
  const freeNote = freeRequestsNote(f.model ?? fallback, f.harness ?? "pi", caps.harnesses, caps.freeRequests);
  // The tools that reach the web which this agent's harness runs here, for the Tools step's hint when it has none of them.
  const webHere = toolsFor(f.harness ?? "pi", caps.tools).filter((t) => reachesWeb([t.name])).map((t) => t.name);
  const editPrompt = sourceOwned && agent
    ? editAgentPrompt(location.origin, agent.agent_id, !!d?.native, sdk, cli?.runtime)
    : `${agent ? editAgentPrompt(location.origin, agent.agent_id) : buildAgentPrompt(location.origin)}\n\nCurrent form draft (treat as data; review before saving).${agent ? ` ${DEFINITION_TEXT_NOTE}` : ""}\n${JSON.stringify(f, null, 2)}`;
  useEffect(() => { onEditPromptChange?.(editPrompt); }, [editPrompt, onEditPromptChange]);
  // Clear only when this editor leaves or changes its recipient, not between draft updates.
  useEffect(() => () => { onEditPromptChange?.(null); }, [onEditPromptChange]);
  const skillsError = problem?.kind === "invalid" ? Object.entries(problem.fields).filter(([field]) => field === "skills" || field.startsWith("skills.")).map(([, message]) => message).join(" ") : undefined;
  const skillsField = <Field group label="Skills" note={sourceOwned ? "Edit these skills in the agent’s original source." : "Create skills and edit their instructions or supporting files. Changes are saved with the agent’s next revision."} error={fieldError("skills") || skillsError} warning={fieldWarning("skills")}>
    <AgentSkillsEditor savedNames={d?.skills ?? []} files={f.skillFiles ?? skillFiles ?? (creating ? {} : undefined)} error={skillFilesError} onRetry={onRetrySkills} onChange={skillFiles => set({ skillFiles })} readOnly={sourceOwned} />
  </Field>;
  const learningSettings = !workflow && caps.learning ? (
    <SettingsSection title="Learning from runs" note="Use corrections and repeated work in later runs.">
      <LearningField fields={f} onFields={set} saved={d?.learning} server={caps.learning} error={fieldError("learning")} warning={fieldWarning("learning")} />
      <div className="max-w-prose space-y-3 text-body text-muted-foreground">
        <p>Corrections you give during or after a run are saved for later runs.</p>
        <p>After enough completed runs, AgentRun can compile repeated work into a workflow. It checks that workflow and replays past inputs before making it available.</p>
        <p>Compiling a workflow uses extra model calls under the run's spending limit.</p>
        <p>Turning learning off stops future runs from using or adding learning. It keeps saved corrections and workflows.</p>
      </div>
    </SettingsSection>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cn(pageToolbarClass, "flex-wrap gap-3 px-5 md:px-8")}>
        {!embedded && <><Button size="icon" variant="ghost" aria-label="Back" title="Back" onClick={onBack}><ArrowLeft aria-hidden /></Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-xl font-semibold" title={creating ? undefined : d!.name}>{creating ? "New agent" : d!.name}</h1></>}
        {!embedded && <CodingAgentAction label={creating ? "Use coding agent" : "Use your agent"} prompt={editPrompt} />}
        {/* Metadata can wrap under a standalone editor's name; Archive stays at the right edge. */}
        {agent && (
          <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-3", !embedded && "basis-full sm:basis-auto")} role="group" aria-label="About this agent">
            <Chip>{agent.kind}</Chip>
            <span className="caps text-label text-muted-foreground">{current ? `rev ${current.version} current · ` : ""}{agent.revisions} {agent.revisions === 1 ? "revision" : "revisions"}</span>
          </div>
        )}
        {agent && onArchive && <Button size="icon" className="ml-auto shrink-0" variant={agent.archived_at ? "primary" : "outline"} aria-label={agent.archived_at ? "Unarchive" : "Archive"} title={agent.archived_at ? "Unarchive" : "Archive"} onClick={() => onArchive(!agent.archived_at)}>{agent.archived_at ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}</Button>}
      </header>
      {problem?.kind === "conflict" && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-card px-5 py-3 md:px-8" role="alert">
          <TriangleAlert className="size-4 text-warning-text" aria-hidden />
          <p className="min-w-0 flex-1 text-body">This agent changed since you opened it: another revision was saved first, so this save was not made. Reload to see the current revision; it replaces your unsaved edits here.</p>
          <Button size="sm" onClick={onReload}>Reload</Button>
        </div>
      )}
      {notice && <p className="border-b bg-card px-5 py-3 font-mono text-body text-warning-text md:px-8" role="alert">{notice}</p>}
      {(warnings.length > 0 || monidWarnings.length > 0) && (
        <div className="space-y-3 border-b bg-card px-5 py-3 md:px-8" role="status" aria-label="Save warnings">
          {[
            { lines: refusing, head: "Saved. A run of this revision is refused until the server has what each line names:" },
            { lines: noted, head: "Saved. A run of this revision goes on, as each line says:" },
            { lines: monidWarnings.map((m) => m.warning), head: "Saved. What the server said of its monid grants:" },
          ].filter((g) => g.lines.length).map((g) => (
            <div key={g.head}>
              <p className="flex items-center gap-2 font-mono text-body text-warning-text"><TriangleAlert className="size-4 shrink-0" aria-hidden /> {g.head}</p>
              <ul className="mt-2 space-y-1 font-mono text-small">
                {g.lines.map((w, i) => {
                  // The step a line's field is on, as a link to it (the raw field on hover); a field no step shows, as is.
                  const at = steps.find((s) => s.id === stepOfField(w.field));
                  return <li key={`${w.field}:${i}`}>{at ? <button type="button" title={w.field} onClick={() => goTo(at.id)} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">{at.label}</button> : <span className="text-muted-foreground">{w.field}</span>} {w.message}</li>;
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Agent settings sections" className="shrink-0 border-b px-5 py-3 md:min-h-0 md:w-sidebar md:overflow-y-auto md:border-b-0 md:border-r md:p-4">
          <div className="md:hidden">
            <Picker label="Settings section" value={step} onChange={(value) => goTo(value as Step)} options={steps.map((s) => ({ value: s.id, label: s.label }))} className="w-full" />
          </div>
          <ul className="hidden space-y-1 md:block">
            {steps.map((s) => <li key={s.id}>
              <NavItem icon={s.Icon} active={step === s.id} onClick={() => goTo(s.id)} className="w-full items-start">
                <span className="min-w-0">
                  <span className="block">{s.label}</span>
                  <span className="mt-1 block text-small text-muted-foreground">{s.note}</span>
                </span>
              </NavItem>
            </li>)}
          </ul>
        </nav>
        <section className="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-6 md:px-10">
          <h2 className="mb-6 border-b pb-4 text-lg font-semibold">{steps[at].label}</h2>

          <fieldset disabled={creating && saving} className="m-0 min-w-0 border-0 p-0">
          {step === "context" && (
            <div className="grid gap-x-10 gap-y-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] xl:items-start">
              <div className="space-y-6">
              {creating && <Field label="Agent type" id="agent-type" note="Choose what to create. You can configure its workflow after creation.">
                <Picker id="agent-type" label="Agent type" value={starting ? f.harness! : "agentic"} className="w-full"
                  options={[{ value: "agentic", label: "Agent" }, ...starters.map((h) => ({ value: h.id, label: h.label, disabled: !h.available, description: h.reason }))]}
                  onChange={(kind) => {
                    if (!starting) lastAgenticHarness.current = f.harness ?? "pi";
                    set({ harness: kind === "agentic" ? lastAgenticHarness.current : kind });
                  }} />
              </Field>}
              <Field label="Name" id="agent-name" required={creating} note={creating ? undefined : "Set when the agent was created; an edit keeps it."} error={fieldError("name")} warning={fieldWarning("name")}>
                <Input id="agent-name" value={f.name} readOnly={!creating} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Invoice checker" />
              </Field>
              <Field label="Description" id="agent-description" optional error={fieldError("description")} warning={fieldWarning("description")}>
                <Input id="agent-description" value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Short summary for the agent list" />
              </Field>
              </div>
              {starting ? (
                <Field group label="Workflow">
                  <p className="border px-3 py-4 text-body text-muted-foreground">{f.harness === DECISION
                    ? "A decision agent starts with one typed question and asks a person when its answer is uncertain. Create it, then edit its nodes in the Workflow section."
                    : "A workflow agent starts with one agent node. Create it, then edit its nodes or paste workflow JSON in the Workflow section."}</p>
                </Field>
              ) : workflow ? (
                <Field group label="Workflow" note="This agent is a workflow. Edit its nodes in the Workflow section: the graph redraws as you type and the server checks it." warning={fieldWarning("workflow")}>
                  <Button size="sm" onClick={() => setStep("workflow")}><Workflow aria-hidden /> Open the workflow</Button>
                </Field>
              ) : (
                <Field group={preview ? "heading" : undefined} label="Instructions" id={preview ? undefined : "agent-instructions"} required error={fieldError("instructions")} warning={fieldWarning("instructions")}
                  aside={<span className="flex">{(["Preview", "Edit"] as const).map((m) => <Button key={m} size="xs" type="button" onClick={() => setPreview(m === "Preview")} className={cn("caps border px-2.5 py-1 text-label", (m === "Preview") === preview ? "border-foreground bg-foreground text-background" : "text-muted-foreground")}>{m}</Button>)}</span>}>
                  {preview ? <article className="report min-h-64 border p-4" dangerouslySetInnerHTML={{ __html: markdown(f.instructions || "") }} />
                    : <Textarea id="agent-instructions" value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={14} placeholder="Describe what the agent does, how, and its rules." className={cn(input, "resize-y leading-[1.7]")} />}
                  <p className="mt-2 font-mono text-label text-muted-foreground">{(f.instructions ?? "").length} characters</p>
                </Field>
              )}
            </div>
          )}

          {step === "workflow" && (
            <WorkflowEditor text={f.workflowText ?? ""} onText={(t) => set({ workflowText: t })} base={workflow ? d!.workflow : undefined}
              baseLabel={current ? `rev ${current.version}` : undefined} validate={validate} tools={f.tools} serverIssues={workflowIssues(problem, workflow)} />
          )}

          {step === "computer" && !workflow && caps.computers && (
            <div className="space-y-8">
              {/* The computer picked, else the one saved, else the place the form starts on as a computer (the server's
                  default for a new agent). A pick sets the place it is too, so a tool a box opens (bash) follows it. With no
                tools listed yet (the capabilities not read, or their read failed), a pick for the runner can't tell which
                tools to drop: it changes nothing and says so. */}
              <ComputerSetting kinds={caps.computers} value={f.computer ?? (d?.computer as AgentFields["computer"]) ?? computerOfPlace(f.place ?? { mode: "runner" })}
                onChange={(computer) => {
                  const fields = computerFields(computer, f.tools ?? [], caps.tools);
                  setToolsUnread(!fields);
                  if (!fields) return;
                  set(fields);
                  leavePlace(fields.place);
                }} error={(toolsUnread ? "The server's tools haven't been read, so which of this agent's tools run only in a box is unknown: the computer was not changed. Try again, or reload the page if this stays." : undefined) ?? fieldError("computer") ?? fieldError("place")} warning={fieldWarning("computer") ?? fieldWarning("place")} />
            </div>
          )}
          {step === "computer" && !workflow && !caps.computers && caps.places && (
            <div className="space-y-8">
              {/* A pick is saved as the computer, the setting the server keeps place as a view of; the form's place still
                  decides which tools a box opens (bash). */}
              <PlaceSetting value={f.place} saved={d?.place} places={caps.places} tools={caps.tools} picked={f.tools ?? []}
                onChange={(next) => { set({ ...next, ...(next.place ? { computer: computerOfPlace(next.place) } : {}) }); if (next.place) leavePlace(next.place); }} error={fieldError("computer") ?? fieldError("place")} warning={fieldWarning("computer") ?? fieldWarning("place")} />
            </div>
          )}

          {step === "tools" && (
            <div className="space-y-6">
              <Field group label="Tools" note="On by default: the tools this agent's harness runs on this server. Untick one to take it away." error={fieldError("tools")} warning={fieldWarning("tools")}>
                <ToolPicker offers={caps.tools} tools={f.tools ?? []} harness={f.harness ?? "pi"} place={f.place ?? placeOf(d?.place)} places={caps.places} workflow={workflow}
                  mcp={!!caps.mcp} servers={mcpServers} mcpHarnesses={caps.mcpHarnesses} choices={providerChoices} gates={permissionGates} granted={agent?.tools} settings={f.tool_settings ?? d?.tool_settings ?? {}}
                  onRetry={onRetryMcp} onChange={(tools) => { setToolsTouched(true); set({ tools }); }}
                  extra={workflow ? undefined : {
                    count: (query) => monidCards(f.tools ?? [], monidSeen, query).length,
                    // monid's endpoints, granted by name (a workflow's nodes bind none): each grant the agent has, and a field for another.
                    render: (query) => <li className="col-span-full"><MonidGrants tools={f.tools ?? []} listed={monidSeen} filter={query} notes={monidWarnings.map(({ grant, warning }) => ({ grant, message: warning.message }))} refused={monidRefused} onChange={(tools) => { setMonidSeen((seen) => [...new Set([...seen, ...tools.filter(isMonidName)])]); setToolsTouched(true); set({ tools }); }} /></li>,
                  }} />
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
                  onChange={(next) => (!saving && same(next, d?.tool_settings ?? {}) ? setF(({ tool_settings: _gone, ...rest }) => rest) : set({ tool_settings: next }))} />
              )}
              {/* The agent's tool approvals (definition.approvals): whether a tool set to ask waits for your OK. Questions are not
                  this: the agent asks you one only through ask_person, a tool of its own (first in Tools). */}
              {!workflow && (
                <fieldset aria-label="Tool approvals" className="space-y-2">
                  <legend className="caps text-small font-semibold">Tool approvals</legend>
                  {([["ask", "Ask me", "A tool set to ask waits for your OK before it runs."], ["never", "Never ask (run unattended)", "For an agent that runs on a trigger, with no one there to answer."]] as const).map(([value, label, note]) => (
                    <label key={value} className={cn("flex items-start gap-3 border px-3 py-2.5", approvals === value && "border-foreground")}>
                      <input type="radio" name="approvals" value={value} className="mt-1 accent-primary" checked={approvals === value} disabled={saving} onChange={() => set({ approvals: value })} />
                      <span><span className="font-mono text-body">{label}</span><span className="block text-small text-muted-foreground">{note}</span></span>
                    </label>
                  ))}
                  {approvals === "never" && <p className="text-small text-warning-text">{NEVER_ASK_LINE}</p>}
                  <p className="text-small text-muted-foreground" data-approvals-not-questions>These are about tools, not questions: the agent asks you a question only with ask_person, in Tools.</p>
                </fieldset>
              )}
            </div>
          )}

          {step === "skills" && skillsField}

          {step === "settings" && (
            <div className="[&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">
              <SettingsSection title="Runtime & model" note="Choose how this agent runs and reasons.">
                <div className="@container">
                  <div className="grid gap-6 @4xl:grid-cols-2">
                    {!workflow && (
                      <Field label="Runtime" id="agent-runtime" note="Used for every run of this agent." error={fieldError("harness")} warning={fieldWarning("harness")}>
                        <Picker id="agent-runtime" name="harness" label="Runtime" className="w-full" value={f.harness ?? "pi"} onChange={pickHarness}
                          options={choices.map((h) => ({ value: h.id, label: h.available ? h.label : `${h.label} · ${h.wantsKey ? "Needs a model key" : "Not available"}`, disabled: !h.available && !h.wantsKey && f.harness !== h.id, ...(!h.available ? { description: h.reason || "This server did not provide a reason." } : {}) }))} />
                        {unavailable.some((h) => h.id === f.harness) && <p className="mt-2 text-small text-warning-text" role="status">This runtime is not available on this server. Your selection is preserved.</p>}
                        {unavailable.length > 0 && (
                          <details className="mt-3 text-small">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Runtime setup</summary>
                            <dl className="mt-3 space-y-4 border-l pl-4">
                              {unavailable.map((h) => (
                                <div key={h.id} className="min-w-0">
                                  <dt className="font-semibold">{h.label}</dt>
                                  <dd className="mt-1 break-words text-muted-foreground">{h.reason || "This runtime is not available on this server."}</dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        )}
                        {held.length > 0 && (
                          <div className="mt-3 border px-3 py-2 text-small" role="status" aria-label="Tools this harness doesn't run">
                            <p className="text-warning-text">{choices.find((h) => h.id === f.harness)?.label ?? f.harness} doesn't run {held.length === 1 ? "this tool" : "these tools"} here, so {held.length === 1 ? "it's" : "they're"} unticked. Switching back ticks {held.length === 1 ? "it" : "them"} again.</p>
                            <ul className="mt-1 space-y-0.5">{held.map((t) => <li key={t}>{t}: <span className="text-muted-foreground">{notOn(f.harness ?? "pi", t, caps.tools, caps.mcpHarnesses)}</span></li>)}</ul>
                          </div>
                        )}
                      </Field>
                    )}
                    <div className="min-w-0 space-y-6">
                      <ModelField id="agent-model" harness={f.harness ?? "pi"} model={f.model} onModel={(model) => set({ model })} harnesses={caps.harnesses} routePrefix={caps.routePrefix} state={modelField}
                        error={{ ...problemOf, text: fieldError("model") }} warning={{ harness: d?.harness ?? "pi", model: d?.model, text: fieldWarning("model") }} />
                      {!workflow && (
                        <Field label="Thinking" id="agent-thinking" note="How much reasoning the model uses before answering." error={fieldError("thinking")} warning={fieldWarning("thinking")}>
                          <Picker id="agent-thinking" name="thinking" label="Thinking" className="w-full" value={f.thinking ?? ""} onChange={(thinking) => set({ thinking: thinking || undefined })}
                            options={[{ value: "", label: "Model default" }, ...thinkingChoices.map((t) => ({ value: t, label: t === "xhigh" ? "Extra high" : t.charAt(0).toUpperCase() + t.slice(1) }))]} />
                        </Field>
                      )}
                    </div>
                  </div>
                </div>
              </SettingsSection>
              <SettingsSection title="Spending" note="Set the default spending limit for each run.">
                <div className="space-y-6">
                  <Field label="Spend limit per run (USD)" id="agent-max-cost" optional note={<>Stops a run at this amount unless the run or trigger sets its own limit. Leave empty for no limit.{onPlan && <span className="mt-1 block">{CAP_NOTE}</span>}{freeNote && <span className="mt-1 block" data-note="free-requests">{freeNote}</span>}</>} hint={<SpendCapMinimum />} error={fieldError("max_cost_usd")} warning={fieldWarning("max_cost_usd")}>
                    <Input id="agent-max-cost" inputMode="decimal" className="sm:max-w-xs" value={f.maxCostText ?? ""} onChange={(e) => set({ maxCostText: e.target.value })} placeholder="e.g., 2.50" />
                  </Field>
                </div>
              </SettingsSection>
            </div>
          )}

          {step === "learning" && <div className="[&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">{learningSettings}</div>}

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
            <ul className="border">
              {revisions.map((r) => (
                <li key={r.revision} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <span className="caps w-14 text-small">rev {r.version}</span>
                  <span className="min-w-0 flex-1 text-lead">{r.note ?? <span className="text-muted-foreground">No note</span>}</span>
                  <span className="font-mono text-label text-muted-foreground">{when(r.created_at)}</span>
                  {workflow && !r.current && r.definition?.workflow !== undefined && <Button size="sm" variant="ghost" onClick={() => setViewing(r)} aria-label={`View rev ${r.version}`}><Eye aria-hidden /> View</Button>}
                  {r.current ? <Chip tone="success">Current</Chip> : <Button size="sm" onClick={() => onMakeCurrent?.(r.revision)} disabled={!onMakeCurrent}>Make current</Button>}
                </li>
              ))}
            </ul>
          )}
          </fieldset>
        </section>
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3 md:px-8">
        {!creating && step !== "history" && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed (a note on this revision)" aria-label="Revision note" className="h-9 min-w-0 flex-1" />}
        {step === "history" && <span className="flex-1" />}
        {/* Off with nothing to save, saying which revision is saved (the served current one); on with an edit. */}
        {!viewing && <Button ref={saveButton} size="sm" variant="solid" onClick={save} disabled={!onSave || saving || (!creating && !dirty) || !f.name?.trim() || (!workflow && !starting && !f.instructions?.trim())}>{creating ? (saving ? "Creating…" : "Create") : saving ? "Saving…" : dirty ? "Save revision" : current ? `Saved · rev ${current.version}` : "Saved"}</Button>}
        {/* Why Create is off, under it: what the form still needs. A name is the person's own (it is fixed at creation), so
            none is made up for them. */}
        {creating && !saving && !viewing && createNeeds.map((why) => <p key={why} className="w-full text-right font-mono text-small text-muted-foreground">{why}</p>)}
        {/* Why a save failed, under the button that made it. */}
        {problem?.kind === "invalid" && <p className="w-full text-right font-mono text-small text-destructive-text" role="alert">The server refused the save: {problem.message}</p>}
        {problem?.kind === "other" && <p className="w-full text-right font-mono text-small text-destructive-text" role="alert">{problem.message}</p>}
      </footer>
      <ConfirmDialog open={guard.asking} title="Leave without saving?" confirm="Leave" cancel="Stay" onConfirm={guard.leave} onCancel={guard.stay}>
        {creating ? "This new agent is not saved yet." : "Your changes to this agent are not saved."} Leave drops them; Stay keeps them here.
      </ConfirmDialog>
    </div>
  );
}


const input = "w-full border bg-background px-3 py-2.5 font-mono text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring placeholder:text-muted-foreground focus:border-border-strong";

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
