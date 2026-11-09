// The agent body validator (the P4 fold of pi-durable-agent's agent-store.ts bodyOf, with kinds.ts's canonical JSON): what
// a revision's stored body may be, checked before anything is written, so a refusal makes no agent and no revision. It is
// the one check the control plane runs over a revision's body, kept with the store (A) it writes into. The body keeps a
// skill path to its text's SHA-256 (two revisions with the same files are one body); the texts ride beside it on the
// revision's own row (store schema `revisions`). Everything the old validator accepted it accepts, plus the agent-level
// argument `pin` form in tool settings (the lead's ruling): at most 8 arguments mapped to JSON scalars, keys sorted, so
// two equal pins are one revision.
import { createHash } from "node:crypto";

/** A revision's body the store refuses: its content is not one the store keeps. The server maps it to an input refusal. */
export class AgentBodyInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBodyInvalid";
  }
}
const invalid = (message: string): never => {
  throw new AgentBodyInvalid(message);
};

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The SHA-256 of a skill's text (hex). */
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** JSON with sorted keys (an absent or undefined field is no field): one text for one value, so two bodies that are equal
 *  as JSON compare equal (the basis for "equal body, equal pins = one revision"). Ported from kinds.ts. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A skill path is relative, with `/` between non-empty segments, and never leaves `.agents/skills/`. Ported from home.ts. */
export const isSkillPath = (value: string): boolean =>
  typeof value === "string" && value !== "" && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** An id a host knows: a harness, a place's mode, a box (lowercase letters, digits and dashes). */
const HOST_ID = /^[a-z][a-z0-9-]{0,63}$/;
const hostId = (value: unknown): value is string => typeof value === "string" && HOST_ID.test(value);

/** An overlay prompt variant, as a body carries it (kept opaque here, passed through unchanged). Ported from kinds.ts. */
export type PromptVariant = { role: "base" | "overlay" | "generic" | "question"; label: string; text: string; when?: { question: string; option: string; threshold: number }; criteria?: Record<string, string> };

export type RevisionPlace = { mode: string; box?: string };
/** A revision's tool settings as its body keeps them: a map of a tool's key to its settings ({provider?, permission?,
 *  pin?}), checked and made canonical by the caller (agents-store.ts, through tool-plane's settingsIssues +
 *  canonicalToolSettings, the one copy). The store body holds it as it is given; this validator never reimplements it. */
export type ToolSettings = Record<string, unknown>;
export type AgenticBody = { instructions: string; skills: Record<string, string>; tools: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: RevisionPlace; learning?: boolean; toolSettings?: ToolSettings; maxCostUsd?: number; capMode?: string; approvals?: "ask" | "never" };
export type WorkflowBody = { workflow: Record<string, unknown>; skills: Record<string, string>; tools: string[]; harness?: string; place?: RevisionPlace; toolSettings?: ToolSettings; maxCostUsd?: number; capMode?: string };

/** The input a revision's body is built from (the control plane's, in the store's own shape). `toolSettings` is already
 *  checked and canonical (agents-store.ts via tool-plane's one copy); this validator keeps it as given. */
export type RevisionBodyInput =
  | { kind: "agentic"; instructions: string; skills?: Record<string, string>; tools?: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: unknown; learning?: boolean; toolSettings?: ToolSettings; maxCostUsd?: number; capMode?: string; approvals?: "ask" | "never" }
  | { kind: "workflow"; workflow: unknown; skills?: Record<string, string>; tools?: string[]; harness?: string; place?: unknown; toolSettings?: ToolSettings; maxCostUsd?: number; capMode?: string };

/** A place as a body keeps it: `{mode, box?}`, nothing else. */
function placeOf(place: unknown): RevisionPlace {
  if (!isObject(place) || !hostId(place.mode) || (place.box !== undefined && !hostId(place.box)) || Object.keys(place).some((key) => key !== "mode" && key !== "box")) invalid("the place is not {mode, box?}, each an id (lowercase letters, digits and dashes)");
  const ok = place as { mode: string; box?: string };
  return { mode: ok.mode, ...(ok.box !== undefined ? { box: ok.box } : {}) };
}

/** The body of a new revision and the text of each skill it names (path to text), everything checked here, before any
 *  write. The body keeps each skill path to its text's SHA-256; `skills` is the texts, for the revision's row. */
export function bodyOf(input: RevisionBodyInput): { body: AgenticBody | WorkflowBody; skills: Record<string, string> } {
  if (!isObject(input)) invalid("the revision is not an object");
  const skillShas: Record<string, string> = {};
  const skillTexts: Record<string, string> = {};
  for (const [file, text] of Object.entries(input.skills ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSkillPath(file)) invalid("a skill path is not a relative path inside .agents/skills/");
    if (typeof text !== "string") invalid("a skill is not text");
    skillShas[file] = sha256(text as string);
    skillTexts[file] = text as string;
  }

  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && t !== "") || new Set(tools).size !== tools.length) invalid("the tools are not a list of distinct non-empty names");
  if (input.harness !== undefined && !hostId(input.harness)) invalid("the harness is not a harness id (lowercase letters, digits and dashes)");

  // tool settings are checked and made canonical by the caller (agents-store.ts via tool-plane's settingsIssues +
  // canonicalToolSettings, the one copy); the body keeps them as given. An empty map keeps none.
  const set = input.toolSettings;
  if (set !== undefined && !isObject(set)) invalid("the tool settings are not an object of tools to their settings");
  const toolSettings = set && Object.keys(set).length ? (set as ToolSettings) : undefined;

  // Unattended (approvals "never") is the one value kept: ask, the default, is kept as nothing, so an agent that asks is
  // one body with an agent that names the default.
  if (input.approvals !== undefined && input.approvals !== "never") invalid('the approvals is "never", or absent (ask)');
  const host = {
    ...(input.harness !== undefined ? { harness: input.harness } : {}),
    ...(input.place !== undefined ? { place: placeOf(input.place) } : {}),
    ...(toolSettings ? { toolSettings } : {}),
    ...(input.approvals === "never" ? { approvals: "never" as const } : {}),
  };

  // A default spend cap, and how it prices a request, for a revision of either kind.
  if (input.maxCostUsd !== undefined && !(typeof input.maxCostUsd === "number" && Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0)) invalid("the maxCostUsd is not a number above 0");
  if (input.capMode !== undefined && (typeof input.capMode !== "string" || input.capMode === "")) invalid("the capMode is not a non-empty string");
  const capped = { ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}), ...(input.capMode !== undefined ? { capMode: input.capMode } : {}) };

  if (input.kind === "agentic") {
    if (typeof input.instructions !== "string") invalid("an agentic revision needs instructions (its prompt, possibly empty)");
    for (const field of ["model", "thinking"] as const) if (input[field] !== undefined && (typeof input[field] !== "string" || input[field] === "")) invalid(`the ${field} is not a non-empty string`);
    if (input.learning !== undefined && typeof input.learning !== "boolean") invalid("learning is not true or false");
    if (input.approvals !== undefined && input.approvals !== "ask" && input.approvals !== "never") invalid("approvals is ask or never");
    const body: AgenticBody = {
      instructions: input.instructions,
      skills: skillShas,
      tools: [...tools],
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.prompts !== undefined ? { prompts: structuredClone(input.prompts) } : {}),
      ...host,
      ...(input.learning !== undefined ? { learning: input.learning } : {}),
      // The agent's unattended policy (PR #2003): the runner's gate reads it from the revision body at claim.
      ...(input.approvals !== undefined ? { approvals: input.approvals } : {}),
      ...capped,
    };
    return { body, skills: skillTexts };
  }
  if (input.kind !== "workflow") invalid("the revision kind is not agentic or workflow");
  if (!isObject((input as { workflow?: unknown }).workflow)) invalid("a workflow revision needs a workflow (a JSON object)");
  const body: WorkflowBody = { workflow: structuredClone((input as { workflow: Record<string, unknown> }).workflow), skills: skillShas, tools: [...tools], ...host, ...capped };
  return { body, skills: skillTexts };
}
