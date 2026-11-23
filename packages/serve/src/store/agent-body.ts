// The agent body validator (with canonical JSON): what
// a revision's stored body may be, checked before anything is written, so a refusal makes no agent and no revision. It is
// the one check the control plane runs over a revision's body, kept with the store (A) it writes into. The body keeps a
// skill path to its text's SHA-256 (two revisions with the same files are one body); the texts ride beside it on the
// revision's own row (store schema `revisions`). Everything the old validator accepted it accepts, plus the agent-level
// argument `pin` form in tool settings (the lead's ruling): at most 8 arguments mapped to JSON scalars, keys sorted, so
// two equal pins are one revision.
import { sourceSyncOf, type SourceSyncBinding } from "../source-sync/types.js";
import { sdkBindingOf, type SdkBinding } from "../sdk/runtimes.js";
import { createHash } from "node:crypto";
import type { NativeBinding } from "../native/types.js";
import { nativeBindingOf } from "../native/binding.js";
import { isNativeRuntime, type NativeRuntime } from "../native/runtimes.js";
import { type LearningSetting, learningSettingIssue, learningSettingOf } from "../learning-setting.js";
import { needsIssues } from "../computer-needs.js";

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
/** A revision's computer (computer-setting.ts): its kind and the provider that serves it, ids its host knows, and a
 *  sandbox's GPUs, a type its provider names and how many; `place` is its v2 view. `image`: one the provider offers for
 *  the kind, absent for its default. A desktop's or a phone's surface and exec: how the agent drives it, and whether it
 *  may run programs on it, and whether each run records a video of its screen. */
export type RevisionComputer = { kind: string; provider?: string; image?: string; gpu?: { type: string; count: number }; persistent?: boolean; surface?: "code" | "tools"; exec?: boolean; record?: boolean; needs?: string[] };
/** A revision's tool settings as its body keeps them: a map of a tool's key to its settings ({provider?, permission?,
 *  pin?}), checked and made canonical by the caller (agents-store.ts, through tool-plane's settingsIssues +
 *  canonicalToolSettings, the one copy). The store body holds it as it is given; this validator never reimplements it. */
export type ToolSettings = Record<string, unknown>;
/** The model of each tier an agentic revision names (its definition's `model_tiers`: fast, strong), each "provider/model-id". */
export type ModelTiers = Partial<Record<"fast" | "strong", string>>;
/** A revision's monid pin (revisions.monid_pin, monid.ts pinMonid): each granted endpoint by its catalog name, as monid
 *  listed it at the save; its input as POST /v1/run takes it; `usd` its fixed price (monid.ts fixedUsd), null for one
 *  priced by usage (held at monid's estimate). Stamped by the save (server.ts saveable), never shown in a definition. */
export type MonidPinBody = Readonly<Record<string, { readonly description: string; readonly input: Record<string, unknown>; readonly usd: number | null }>>;
export type CliLearningBinding = { runtime: NativeRuntime; connection_id: string; project: string };
export const cliLearningOf = (body: unknown): CliLearningBinding | undefined => isObject(body) && isObject(body.cli_learning) && isNativeRuntime(body.cli_learning.runtime) && typeof body.cli_learning.connection_id === "string" && typeof body.cli_learning.project === "string" ? body.cli_learning as CliLearningBinding : undefined;
/** Read old CLI enrollment settings through the current model without rewriting its revision or learned files.
 * New definitions still reject "notes"; existing CLI profiles use owner corrections and no workflow bridge. */
export function learningSettingForBody(body: unknown): LearningSetting | undefined {
  if (!isObject(body) || body.learning === undefined) return undefined;
  if (cliLearningOf(body) && body.learning === "notes") return true;
  return learningSettingIssue(body.learning) === undefined ? body.learning as LearningSetting : undefined;
}
export type { SdkBinding } from "../sdk/runtimes.js";
export type AgenticBody = { sourceSync?: SourceSyncBinding; cli_learning?: CliLearningBinding; sdk?: SdkBinding; native?: NativeBinding; instructions: string; skills: Record<string, string>; tools: string[]; model?: string; modelTiers?: ModelTiers; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: RevisionPlace; computer?: RevisionComputer; learning?: LearningSetting; toolSettings?: ToolSettings; maxCostUsd?: number; maxRequests?: number; approvals?: "ask" | "never"; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; checkout?: "pull_request" | "repository" };
export type WorkflowBody = { workflow: Record<string, unknown>; skills: Record<string, string>; tools: string[]; harness?: string; place?: RevisionPlace; computer?: RevisionComputer; toolSettings?: ToolSettings; maxCostUsd?: number; maxRequests?: number; approvals?: "ask" | "never" };

/** The input a revision's body is built from (the control plane's, in the store's own shape). `toolSettings` is already
 *  checked and canonical (agents-store.ts via tool-plane's one copy); this validator keeps it as given. */
export type RevisionBodyInput =
  | { kind: "agentic"; sourceSync?: SourceSyncBinding; cli_learning?: CliLearningBinding; sdk?: SdkBinding; native?: NativeBinding; instructions: string; skills?: Record<string, string>; tools?: string[]; model?: string; modelTiers?: ModelTiers; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: unknown; computer?: unknown; learning?: LearningSetting; toolSettings?: ToolSettings; maxCostUsd?: number; maxRequests?: number; approvals?: "ask" | "never"; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; checkout?: "pull_request" | "repository" }
  | { kind: "workflow"; workflow: unknown; skills?: Record<string, string>; tools?: string[]; harness?: string; place?: unknown; computer?: unknown; toolSettings?: ToolSettings; maxCostUsd?: number; maxRequests?: number; approvals?: "ask" | "never" };

/** A place as a body keeps it: `{mode, box?}`, nothing else. */
function placeOf(place: unknown): RevisionPlace {
  if (!isObject(place) || !hostId(place.mode) || (place.box !== undefined && !hostId(place.box)) || Object.keys(place).some((key) => key !== "mode" && key !== "box")) invalid("the place is not {mode, box?}, each an id (lowercase letters, digits and dashes)");
  const ok = place as { mode: string; box?: string };
  return { mode: ok.mode, ...(ok.box !== undefined ? { box: ok.box } : {}) };
}

/** A GPU type as a body keeps it: the vendor's own name ("T4", "A100-80GB", "RTX-PRO-6000"). */
const GPU_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The keys a body's computer keeps. */
const COMPUTER_KEYS: ReadonlySet<string> = new Set(["kind", "provider", "image", "gpu", "persistent", "surface", "exec", "record", "needs"]);

/** A computer as a body keeps it: `{kind, provider?, image?, gpu?, persistent?, surface?, exec?, record?, needs?}`,
 *  nothing else: kind and provider ids, image a name with no spaces around it, gpu `{type, count}`, a GPU type name and a
 *  whole count from 1, persistent, exec and record booleans, surface code or tools, and needs a list of program names. */
function computerOf(computer: unknown): RevisionComputer {
  const image = isObject(computer) ? computer.image : undefined;
  const named = (value: unknown) => typeof value === "string" && value !== "" && value === value.trim();
  const flag = (value: unknown) => value === undefined || typeof value === "boolean";
  const surface = isObject(computer) ? computer.surface : undefined;
  if (!isObject(computer) || !hostId(computer.kind) || (computer.provider !== undefined && !hostId(computer.provider)) || (image !== undefined && !named(image)) || !flag(computer.persistent) || !flag(computer.exec) || !flag(computer.record) || (surface !== undefined && surface !== "code" && surface !== "tools") || Object.keys(computer).some((key) => !COMPUTER_KEYS.has(key))) invalid("the computer is not {kind, provider?, image?, gpu?, persistent?, surface?, exec?, record?, needs?}, kind and provider each an id (lowercase letters, digits and dashes), image a name, persistent a boolean, surface code or tools, exec a boolean, record a boolean");
  const ok = computer as { kind: string; provider?: string; image?: string; gpu?: unknown; persistent?: boolean; surface?: "code" | "tools"; exec?: boolean; record?: boolean };
  const gpu = ok.gpu;
  if (gpu !== undefined && (!isObject(gpu) || Object.keys(gpu).some((key) => key !== "type" && key !== "count") || typeof gpu.type !== "string" || !GPU_TYPE.test(gpu.type) || !Number.isSafeInteger(gpu.count) || (gpu.count as number) < 1)) {
    invalid("the computer's gpu is not {type, count}: a GPU type name (letters, digits, dots, underscores and dashes) and a whole count from 1");
  }
  const needs = (computer as { needs?: unknown }).needs;
  const needsIssue = needs === undefined ? undefined : needsIssues(needs, "the computer's needs")[0];
  if (needsIssue) invalid(needsIssue.message);
  const kept = gpu as { type: string; count: number } | undefined;
  return { kind: ok.kind, ...(ok.provider !== undefined ? { provider: ok.provider } : {}), ...(ok.image !== undefined ? { image: ok.image } : {}), ...(kept !== undefined ? { gpu: { type: kept.type, count: kept.count } } : {}), ...(ok.persistent !== undefined ? { persistent: ok.persistent } : {}), ...(ok.surface !== undefined ? { surface: ok.surface } : {}), ...(ok.exec !== undefined ? { exec: ok.exec } : {}), ...(ok.record !== undefined ? { record: ok.record } : {}), ...(needs !== undefined ? { needs: [...(needs as string[])] } : {}) };
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

  const host = {
    ...(input.harness !== undefined ? { harness: input.harness } : {}),
    ...(input.place !== undefined ? { place: placeOf(input.place) } : {}),
    ...(input.computer !== undefined ? { computer: computerOf(input.computer) } : {}),
    ...(toolSettings ? { toolSettings } : {}),
  };

  // A default spend cap, for a revision of either kind.
  if (input.maxCostUsd !== undefined && !(typeof input.maxCostUsd === "number" && Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0)) invalid("the maxCostUsd is not a number above 0");
  // The agent's own limit on each run's requests on free models (definition.max_requests), under the server's.
  if (input.maxRequests !== undefined && !(typeof input.maxRequests === "number" && Number.isSafeInteger(input.maxRequests) && input.maxRequests >= 1)) invalid("the maxRequests is not a whole number above 0");
  const capped = { ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}), ...(input.maxRequests !== undefined ? { maxRequests: input.maxRequests } : {}) };

  // Whether the agent runs unattended (its definition.approvals): "never" lets an ask run without a person, for a revision
  // of either kind. "ask" (the default, as an agent read says it) is taken and kept as no value, so the default stays
  // implicit and a definition put back as it reads is the same revision; "never" is kept.
  if (input.approvals !== undefined && input.approvals !== "ask" && input.approvals !== "never") invalid("approvals is ask or never");
  const unattended = input.approvals === "never" ? { approvals: "never" as const } : {};

  if (input.kind === "agentic") {
    if (typeof input.instructions !== "string") invalid("an agentic revision needs instructions (its prompt, possibly empty)");
    for (const field of ["model", "thinking"] as const) if (input[field] !== undefined && (typeof input[field] !== "string" || input[field] === "")) invalid(`the ${field} is not a non-empty string`);
    if (input.learning !== undefined) {
      const wrong = learningSettingIssue(input.learning);
      if (wrong) invalid(wrong);
    }
    if (input.inputSchema !== undefined && !isObject(input.inputSchema)) invalid("the inputSchema is not a JSON object");
    if (input.outputSchema !== undefined && !isObject(input.outputSchema)) invalid("the outputSchema is not a JSON object");
    if (input.checkout !== undefined && input.checkout !== "pull_request" && input.checkout !== "repository") invalid("the checkout is not pull_request or repository");
    if (input.modelTiers !== undefined && !(isObject(input.modelTiers) && Object.keys(input.modelTiers).length && Object.entries(input.modelTiers).every(([tier, ref]) => (tier === "fast" || tier === "strong") && typeof ref === "string" && ref !== ""))) invalid("the modelTiers are not fast and strong to a non-empty model");
    if (input.sdk !== undefined && (!isObject(input.sdk) || Object.keys(input.sdk).some(key => key !== "runtime" && key !== "platform") || !sdkBindingOf(input.sdk))) invalid("sdk is {runtime: claude-agent-sdk, codex-sdk or eve}, or {runtime: external, platform: a label of 1–80 characters without surrounding whitespace, controls or lone surrogates}");
    if ([input.sdk, input.native, input.cli_learning].filter(Boolean).length > 1) invalid("sdk, native and cli_learning connections are mutually exclusive");
    if (input.cli_learning !== undefined && (!cliLearningOf(input) || Object.keys(input.cli_learning).some(key => !["runtime", "connection_id", "project"].includes(key)) || !input.cli_learning.connection_id || !input.cli_learning.project)) invalid("cli_learning requires a registered runtime, connection_id and project");
    if (input.sourceSync !== undefined && !sourceSyncOf(input)) invalid("sourceSync is a complete server-owned source provenance binding");
    if (input.sourceSync && (input.native || input.cli_learning || input.sdk)) invalid("a managed source revision has no external execution binding");
    const body: AgenticBody = {
      ...(input.sourceSync ? { sourceSync: { ...input.sourceSync } } : {}),
      ...(input.sdk ? {sdk: {...input.sdk}} : {}),
      ...(input.cli_learning ? {cli_learning: {...input.cli_learning}} : {}),
      instructions: input.instructions,
      ...(input.native !== undefined ? { native: nativeBindingOf(input.native) } : {}),
      skills: skillShas,
      tools: [...tools],
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelTiers !== undefined ? { modelTiers: Object.fromEntries(Object.entries(input.modelTiers).sort(([a], [b]) => a.localeCompare(b))) as ModelTiers } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.prompts !== undefined ? { prompts: structuredClone(input.prompts) } : {}),
      ...host,
      ...(input.learning !== undefined ? { learning: learningSettingOf(input.learning) } : {}),
      // The JSON Schema each run's input meets (definition.input_schema), checked at every start (validate.ts inputSchemaOf).
      ...(input.inputSchema !== undefined ? { inputSchema: structuredClone(input.inputSchema) } : {}),
      // The JSON Schema its final answer's structured part meets (definition.output_schema): a completed run's result.output.
      ...(input.outputSchema !== undefined ? { outputSchema: structuredClone(input.outputSchema) } : {}),
      // What the server checks out in each run's folder before its first turn (runner/pr-checkout.ts).
      ...(input.checkout !== undefined ? { checkout: input.checkout } : {}),
      // The agent's unattended policy (PR #2003): the runner's gate reads it from the revision body at claim (`unattended`
      // below: "never" alone is kept).
      ...capped,
      ...unattended,
    };
    return { body, skills: skillTexts };
  }
  if (input.kind !== "workflow") invalid("the revision kind is not agentic or workflow");
  if (!isObject((input as { workflow?: unknown }).workflow)) invalid("a workflow revision needs a workflow (a JSON object)");
  const body: WorkflowBody = { workflow: structuredClone((input as { workflow: Record<string, unknown> }).workflow), skills: skillShas, tools: [...tools], ...host, ...capped, ...unattended };
  return { body, skills: skillTexts };
}
