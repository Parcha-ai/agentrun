import type { ClientError } from "./client";

export type HarnessId = "pi" | "claude-agent" | "codex";
export type Definition = { version: number; name: string; description?: string; instructions?: string; workflow?: unknown; harness?: string; thinking?: string; model?: string; skills: string[]; tools: string[]; [field: string]: unknown };
export type Agent = { agent_id: string; kind: "agentic" | "workflow"; revision: string; revisions: number; definition: Definition; archived_at: string | null; runs?: { count: number; live: number } };
export type AgentFields = Partial<Pick<Definition, "name" | "description" | "instructions" | "harness" | "thinking" | "model" | "tools">> & { workflowText?: string };

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
  // An empty model is no model: the server's default.
  if (edited.model === "") delete edited.model;
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

/** The body that creates an agent: its first revision, with what the form names and no skills yet. */
export function createBody(f: { name: string; description: string; instructions: string; harness: string; tools: string[]; thinking?: string; model?: string }): { definition: Definition } {
  return {
    definition: {
      version: 1, name: f.name, ...(f.description.trim() ? { description: f.description } : {}), instructions: f.instructions, harness: f.harness,
      ...(f.thinking ? { thinking: f.thinking } : {}), ...(f.model?.trim() ? { model: f.model.trim() } : {}), skills: [], tools: f.tools,
    },
  };
}

/** The body that creates a workflow agent from the workflow's JSON as pasted: its first revision, with no instructions,
 *  model, thinking or harness (a workflow revision keeps none of them). Text that is not a JSON object makes no body: the
 *  error says why, and nothing is sent. Whether the workflow itself is valid is the server's to say, as on any save. */
export function workflowCreateBody(f: { name: string; description: string; text: string }): { body?: { definition: Definition }; error?: string } {
  let workflow: unknown;
  try { workflow = JSON.parse(f.text); } catch (e) { return { error: `The workflow is not a JSON object: ${(e as Error).message}` }; }
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) return { error: "The workflow is not a JSON object: paste the workflow's body, starting with {." };
  return { body: { definition: { version: 1, name: f.name, ...(f.description.trim() ? { description: f.description } : {}), workflow, skills: [], tools: [] } } };
}

const LABEL: Record<HarnessId, string> = { pi: "Pi", "claude-agent": "Claude", codex: "Codex" };
const ORDER: HarnessId[] = ["pi", "claude-agent", "codex"];

/** The harness choices: pi, Claude and Codex as the server lists them (`GET /v2/capabilities` `harnesses`), each one the
 *  server does not run shown disabled with its reason. A harness the server does not list is not offered. */
export function harnessOptions(harnesses: { id: string; available: boolean; reason?: string }[]) {
  return ORDER.flatMap((id) => {
    const h = harnesses.find((x) => x.id === id);
    return h ? [{ id, label: LABEL[id], available: h.available, reason: h.reason }] : [];
  });
}

export type SaveProblem = { kind: "conflict"; message: string } | { kind: "invalid"; message: string; fields: Record<string, string> } | { kind: "other"; message: string };

/** What a refused save means for the editor: a stale If-Match (412) is someone else's save landing first; a 422 names
 *  the fields to fix; anything else is shown as the server said it. */
export function saveError(e: ClientError): SaveProblem {
  if (e.status === 412 || e.code === "precondition_failed") return { kind: "conflict", message: e.message };
  if (e.status === 422 && e.fields?.length) return { kind: "invalid", message: e.message, fields: Object.fromEntries(e.fields.map((f) => [f.field, f.message])) };
  return { kind: "other", message: e.message };
}
