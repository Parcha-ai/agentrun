import type { Place, Places } from "./place";
import type { ClientError } from "./client";
import type { NoteProblem } from "./learning";
import type { AgentTool, Approvals, ToolSettings } from "./v2";
import { decisionStarter, STARTER_PROVIDERS } from "./decisionStarter";
import { workflowStarter } from "./workflowStarter";

export type HarnessId = "pi" | "claude-agent" | "codex" | "opencode";
/** `learning`: whether the agent's runs learn (an agentic revision's switch; absent is off). */
/** `max_cost_usd`: the agent's default spend cap per run, in dollars, for a run (or a trigger) with no cap of its own; an
 *  agentic revision's only. Absent or 0 is none, and an edit clears it only with an explicit 0. */
export type Definition = { version: number; approvals?: Approvals; name: string; description?: string; instructions?: string; workflow?: unknown; harness?: string; thinking?: string; model?: string; learning?: boolean; max_cost_usd?: number; skills: string[]; tools: string[]; tool_settings?: ToolSettings; [field: string]: unknown };
/** What a save's answer says this host lacks to run the revision (`reason` not_set_up_here, say): it saved, and a run of it
 *  is refused until the host has it. `field` names the definition's field (`definition.model`, `definition.tools[2]`). */
export type SaveWarning = { field: string; reason: string; message: string };
/** `warnings`: on a create's or an edit's answer only (never on a read of the agent); the console keeps a create's for
 *  the agent's page that opens after it (client.ts). */
export type Agent = { agent_id: string; kind: "agentic" | "workflow"; revision: string; revisions: number; definition: Definition; archived_at: string | null; runs?: { count: number; live: number }; warnings?: SaveWarning[]; tools?: AgentTool[] };
export type AgentFields = Partial<Pick<Definition, "name" | "description" | "instructions" | "harness" | "thinking" | "model" | "tools" | "workflow" | "learning" | "tool_settings" | "max_cost_usd" | "approvals">> & { workflowText?: string; maxCostText?: string; place?: Place };

/** The body of a definition edit: the current definition with the edited fields; name and
 *  description stay as the agent was created. Every field the
 *  form does not show (schemas, tools, a workflow, connection references) is kept as it is, never dropped. A workflow
 *  revision keeps no thinking level (the server refuses one). Skill files are not sent, so they stay as they are. */
export function editBody(agent: Agent, fields: AgentFields, note: string): { definition: Definition; note?: string; unchanged: boolean } {
  // The agent store keeps an agent's id, name and description from its creation: an edit never sends a changed one.
  const { name: _name, description: _description, ...editable } = fields as AgentFields & { id?: string };
  const edited: Definition = { ...agent.definition, ...editable };
  // A workflow revision takes no instructions, model or thinking beside its workflow (validate.ts refuses each).
  if (agent.kind === "workflow") { delete edited.thinking; delete edited.instructions; delete edited.model; }
  // An empty model is no model: the server's default. No tool settings of its own are none: the server's.
  if (edited.model === "") delete edited.model;
  if (edited.tool_settings && !Object.keys(edited.tool_settings).length) delete edited.tool_settings;
  for (const key of Object.keys(edited)) if (edited[key] === undefined) delete edited[key];
  // serve makes no revision for a definition equal to the current one (a note alone changes nothing): then the version
  // is the current one's. A changed definition is the next revision, number revisions + 1.
  const unchanged = same({ ...edited, version: 0 }, { ...agent.definition, version: 0 });
  edited.version = unchanged ? agent.definition.version : agent.revisions + 1;
  return { definition: edited, ...(note.trim() ? { note: note.trim() } : {}), unchanged };
}

/** Deep equality of two JSON values, whatever their keys' order. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The picker's choice that makes a decision agent: a workflow revision from the starter decision workflow. It is a
 *  choice in the form only, never a harness id: the revision names no harness, so its model nodes run on the default. */
export const DECISION = "decision";

/** The picker's choice that makes a general workflow agent: a workflow revision from the general starter
 *  (workflowStarter.ts), which every server runs. A choice in the form only, as Decision is. */
export const WORKFLOW = "workflow";

/** The workflow each starter choice creates the agent from: Decision's judge names the server's decision provider. */
const STARTERS: Record<string, (decisionProvider?: string) => unknown> = { [DECISION]: decisionStarter, [WORKFLOW]: workflowStarter };

/** Whether the picker's choice is a starter (a workflow agent), not a harness. */
export const isStarter = (choice: string | undefined): boolean => choice !== undefined && Object.hasOwn(STARTERS, choice);

/** The decision provider a new decision agent's judge names, from the server's capabilities (`workflows`): the first
 *  of the starter's providers available here, Jev first. None when the server runs no decision workflows (no `runJudge`
 *  adapter) or none of those providers runs here; a server that lists no providers runs its default, Jev. */
export function decisionProvider(workflows: { adapters?: string[]; decisions?: { providers?: { id: string; available: boolean }[] } } | undefined): string | undefined {
  if (!workflows?.adapters?.includes("runJudge")) return undefined;
  const providers = workflows.decisions?.providers;
  if (!providers) return "jev";
  return STARTER_PROVIDERS.find((id) => providers.some((p) => p.id === id && p.available));
}

/** A new agent's instructions until the person writes their own: the field is required, so the form opens with these
 *  to edit, never empty. Harness-neutral, one sentence. */
export const DEFAULT_INSTRUCTIONS = "You are a helpful agent. Do the task you're given and report what you found.";

/** The body that creates an agent: its first revision, with what the form names and no skills yet. A starter choice
 *  (Decision, Workflow) makes a workflow agent from that starter (Decision's on the server's decision provider), with no
 *  instructions, harness, thinking, model or tools: a workflow revision keeps none of those beside its workflow. */
export function createBody(f: { name: string; description: string; instructions: string; harness: string; tools: string[]; approvals?: Approvals; thinking?: string; model?: string; learning?: boolean; decisionProvider?: string; tool_settings?: ToolSettings; place?: Place; max_cost_usd?: number }): { definition: Definition } {
  if (isStarter(f.harness)) {
    return { definition: { version: 1, name: f.name, ...(f.description.trim() ? { description: f.description } : {}), workflow: STARTERS[f.harness]!(f.decisionProvider), skills: [], tools: [] } };
  }
  return {
    definition: {
      version: 1, name: f.name, ...(f.description.trim() ? { description: f.description } : {}), instructions: f.instructions, harness: f.harness,
      ...(f.thinking ? { thinking: f.thinking } : {}), ...(f.model?.trim() ? { model: f.model.trim() } : {}), ...(f.place ? { place: f.place } : {}), ...(f.learning ? { learning: true } : {}), ...(f.max_cost_usd !== undefined ? { max_cost_usd: f.max_cost_usd } : {}), skills: [], tools: f.tools,
      ...(f.tool_settings && Object.keys(f.tool_settings).length ? { tool_settings: f.tool_settings } : {}),
      // Approvals: sent only when it never asks (ask is the server's default).
      ...(f.approvals === "never" ? { approvals: "never" as const } : {}),
    },
  };
}

/** The default cap field's text as a definition's `max_cost_usd`: empty is none (`value` undefined), a number is sent as
 *  it is (the server judges it), and text that is no number is not sent at all. */
export function capOf(text: string | undefined): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const raw = (text ?? "").trim();
  if (!raw) return { ok: true, value: undefined };
  // A leading $ is allowed, but a $ with no number after it is no number (never read as an empty field, which clears).
  const t = raw.replace(/^\$\s*/, "");
  const n = Number(t);
  return t && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: "A spend cap is a number of dollars, such as 2.50; empty means none." };
}

/** One tool the server offers (`GET /v2/capabilities` `tools`): whether it can run here, what it lacks, what it does
 *  (`summary`), and, when the server says, which harnesses run it. */
export type ToolOffer = { name: string; available: boolean; summary?: string; missing?: string[]; reason?: string; harnesses?: string[]; call_only?: true; sandbox_only?: true; nodes?: boolean };

export function toolOffers(raw: unknown): ToolOffer[] {
  return (Array.isArray(raw) ? raw : []).flatMap((t): ToolOffer[] => {
    if (!t || typeof t !== "object" || typeof (t as { name?: unknown }).name !== "string") return [];
    const { name, available, summary, missing, reason, harnesses, call_only, sandbox_only, nodes } = t as { name: string; available?: boolean; summary?: unknown; missing?: string[]; reason?: unknown; harnesses?: string[]; call_only?: unknown; sandbox_only?: unknown; nodes?: unknown };
    return [{
      name, available: available !== false, ...(typeof summary === "string" && summary ? { summary } : {}), ...(missing?.length ? { missing } : {}), ...(typeof reason === "string" && reason ? { reason } : {}), ...(harnesses ? { harnesses } : {}),
      ...(call_only === true ? { call_only: true as const } : {}), ...(sandbox_only === true ? { sandbox_only: true as const } : {}), ...(typeof nodes === "boolean" ? { nodes } : {}),
    }];
  });
}

/** The tools a harness runs here. The server says per tool when it can (`harnesses`); until it does, its own rule
 *  (serve's runnable.ts): pi binds every tool, another harness only the file tools, and any other tool refuses its run. */
const FILE_TOOLS = ["read", "write", "edit"];
export function toolsFor(harness: string, offers: ToolOffer[]): ToolOffer[] {
  // A call-only tool (capabilities' `call_only`) runs only in a workflow's call node: no harness binds it, and no
  // revision names it in its tools.
  return offers.filter((t) => !t.call_only && (t.harnesses ? t.harnesses.includes(harness) : harness === "pi" || FILE_TOOLS.includes(t.name)));
}

/** Why `tool` cannot be ticked on an agent whose definition names `place`: a sandbox-only tool (bash) runs in a box, and
 *  this form shows no place, so a new agent's is the runner. Undefined when it can be ticked. */
export const sandboxReason = (tool: ToolOffer, place: unknown): string | undefined =>
  tool.sandbox_only && (place as { mode?: unknown } | undefined)?.mode !== "sandbox" ? "Sandbox-only: it runs in a box, and this agent's place is the runner" : undefined;

/** The tools the server refuses in a sandbox place (serve's runnable.ts, `runnerOnly`): the browser, which files the run's
 *  work/ from the server by path. The server's own rule, until its capabilities mark them. */
const RUNNER_ONLY: ReadonlySet<string> = new Set(["browser"]);

/** Where a revision that names no place runs, as the server resolves it at each run: this mirrors the server's
 *  defaultPlaceOf (packages/serve/src/place.ts), which the server does not report per revision. The runner for a workflow,
 *  and for one that names a tool that runs only there (the browser); else this server's default_place. The editor's
 *  picker and its tool checks both read it, so they agree with the server and with each other. */
export const defaultPlaceOf = (workflow: boolean, tools: readonly string[], places: Places | null | undefined): Place =>
  workflow || tools.some((tool) => RUNNER_ONLY.has(tool)) ? { mode: "runner" } : (places?.defaultPlace ?? { mode: "runner" });

/** A new agent's tools: on by default, every tool its harness runs here that the server can run now. In a sandbox `place`
 *  (the server's default for a new agent, where it has a box) a sandbox-only one (bash) too, and never a runner-only one
 *  (browser); on the runner, no sandbox-only one, since the runner has no shell. */
export const defaultTools = (harness: string, offers: ToolOffer[], place?: Place) => toolsFor(harness, offers).filter((t) => t.available && (place?.mode === "sandbox" ? !RUNNER_ONLY.has(t.name) : !t.sandbox_only)).map((t) => t.name);

/** The tools that reach the web: a page read (web_fetch) or a search (web_search). The server's capabilities
 *  mark no tool as one, so they are named here. */
export const WEB_TOOLS: readonly string[] = ["web_fetch", "web_search"];
/** Whether an agent with these tools can reach the web: through any of WEB_TOOLS. */
export const reachesWeb = (tools: readonly string[]) => tools.some((t) => WEB_TOOLS.includes(t));

const LABEL: Record<HarnessId, string> = { pi: "Pi", "claude-agent": "Claude", codex: "Codex", opencode: "OpenCode" };
const ORDER: HarnessId[] = ["pi", "claude-agent", "codex", "opencode"];

/** The harness choices: pi, Claude, Codex and OpenCode as the server lists them (`GET /v2/capabilities` `harnesses`), each one the
 *  server does not run shown disabled with its reason. A harness the server does not list is not offered. With
 *  `decision` (a new agent), the starters follow them: Decision, available when the server runs decision workflows,
 *  and Workflow, available on every server. */
export function harnessOptions(harnesses: { id: string; available: boolean; reason?: string }[], decision?: { available: boolean }) {
  const options: { id: string; label: string; available: boolean; reason?: string }[] = ORDER.flatMap((id) => {
    const h = harnesses.find((x) => x.id === id);
    return h ? [{ id, label: LABEL[id], available: h.available, reason: h.reason }] : [];
  });
  if (decision) {
    options.push({ id: DECISION, label: "Decision", available: decision.available, reason: decision.available ? undefined : "This server runs no decision workflows: it has no decision provider's key." });
    options.push({ id: WORKFLOW, label: "Workflow", available: true, reason: undefined });
  }
  return options;
}

export type SaveProblem = { kind: "conflict"; message: string } | { kind: "invalid"; message: string; fields: Record<string, string> } | { kind: "other"; message: string };

/** What a refused save means for the editor: a stale If-Match (412) is someone else's save landing first; a 422 names
 *  the fields to fix; anything else is shown as the server said it. */
export function saveError(e: ClientError): SaveProblem {
  if (e.status === 412 || e.code === "precondition_failed") return { kind: "conflict", message: e.message };
  if (e.status === 422 && e.fields?.length) return { kind: "invalid", message: e.message, fields: Object.fromEntries(e.fields.map((f) => [f.field, f.message])) };
  return { kind: "other", message: e.message };
}

/** What a refused note write means for the Learning tab, as saveError does for a definition: a stale If-Match (412) is
 *  a change made since the note was read, or, creating one, a name already taken; a 400 with `problems` lists what the
 *  checks refuse; anything else is shown as the server said it. */
export type NoteSaveProblem = { kind: "conflict" } | { kind: "taken" } | { kind: "refused"; problems: NoteProblem[] } | { kind: "other"; message: string; code: string };
export function noteSaveError(e: ClientError, creating = false): NoteSaveProblem {
  if (e.status === 412 || e.code === "precondition_failed") return creating ? { kind: "taken" } : { kind: "conflict" };
  if (e.problems?.length) return { kind: "refused", problems: e.problems };
  return { kind: "other", message: e.fields?.[0]?.message ?? e.message, code: e.code };
}

/** The warnings that name `field` of the definition, or a part of it (`tools` takes `definition.tools[2]`). */
export function warningsFor(warnings: SaveWarning[] | undefined, field: string): SaveWarning[] {
  const at = `definition.${field}`;
  return (warnings ?? []).filter((w) => w.field === at || w.field.startsWith(`${at}[`) || w.field.startsWith(`${at}.`) || w.field.startsWith(`${at}/`));
}
