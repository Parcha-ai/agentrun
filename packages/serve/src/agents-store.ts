// The agents this server holds, over the one store (A: store.agents), the store-backed replacement for serve/src/agents.ts's
// Agents class and pi-durable-agent's agent-store.ts (bodyOf, revisionOf folded into store/agent-body.ts). An agent is a
// row with revisions written once; a definition is one revision; an edit commits the next and makes it current. A
// revision's body is checked by store/agent-body.ts before anything is written; its skill texts ride on the revision's row.
// The one server per store (the owner lock) is the sole writer of agents and revisions, so a read-then-write here is not
// racing another writer; the store's own transactions make each write atomic.
//
// The run counts an agent view shows (runs.count, runs.live) are E3's run reads, not this module's; agentView takes them.
import { randomBytes } from "node:crypto";
import { agentLink } from "./console-links.js";
import { ApiError, invalid } from "./errors.js";
import { harnessOfBody } from "./harness.js";
import { storedHarness } from "./harness-table.js";
import {
  AgentBodyInvalid, type AgenticBody, type AgentRow, bodyOf, canonical, isObject, type NewRevision, type RevisionBodyInput,
  type RevisionComputer, type RevisionPlace, type RevisionRow, type Store, StoreConstraint, type ToolSettings, type WorkflowBody,
} from "./store/index.js";
import { canonicalToolSettings, settingsIssues, type ToolSettingsMap } from "./tool-plane.js";
import { computerOfPlace, type PlaceView, settingOfDefinition } from "./computer-setting.js";
import { type DefinitionBody, type Json, skillIssues, skillNames } from "./validate.js";

/** A UUIDv7: time-ordered, so a listing by created_at is stable, and unique per revision and per minted agent. */
function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The store slice this module needs (its agents accessor). */
export type AgentsStore = Pick<Store, "agents">;

/** The current revision's body, typed by its kind (store/agent-body.ts). */
type Body = AgenticBody | WorkflowBody;

/** One agent as the routes show it: its row, its current revision and that revision's number (the oldest is 1), how many
 *  revisions it has, and the byte size of each skill file by its SHA-256 (for the view). Run counts are E3's, added by the
 *  caller. */
export type AgentEntry = {
  agent: AgentRow;
  revision: RevisionRow | null;
  version: number;
  revisions: number;
  sizes: Map<string, number>;
};

/** A store refusal as the request's answer: a duplicate name (agent exists) and a constraint map the right way. */
function storeError(error: unknown): never {
  if (error instanceof AgentBodyInvalid) throw invalid([{ field: "definition", reason: "invalid", message: error.message }]);
  if (error instanceof StoreConstraint) throw invalid([{ field: "definition", reason: "invalid", message: error.message }]);
  throw error;
}

/** Refuses a write to an externally owned agent: one that mirrors an agent in another system (its `externalRef` set) is
 *  read-only here — its source is the truth, which writes a new version by running it. Edits, set-current and archive are
 *  refused (403 forbidden); reads work as for any agent. */
export function refuseExternal(agent: AgentRow): void {
  if (agent.externalRef !== null) throw new ApiError("forbidden", `The agent ${agent.id} is managed by its source and is read-only here; change it there and run it again.`);
}

/** An externally owned agent's reference in its source, as POST /runs names it: its source system, the kind of thing it
 *  is there, and its id there (with the version, the revision's own). */
export type ExternalRef = { source: string; kind: string; id: string };

/** The store's one key of an external reference, "<source>:<kind>:<id>": source and kind hold no colon (POST /runs checks
 *  them), so the id, which may, is all that follows the second. */
export const externalKey = ({ source, kind, id }: ExternalRef): string => `${source}:${kind}:${id}`;

/** The agent's reference in its source and the version its current revision maps there, or null for an agent of this
 *  server's own. */
export function externalOf(agent: AgentRow, revision: RevisionRow | null): (ExternalRef & { version: string | null }) | null {
  if (agent.externalRef === null) return null;
  const [source = "", kind = "", ...id] = agent.externalRef.split(":");
  return { source, kind, id: id.join(":"), version: revision?.externalVersion ?? null };
}

/** A definition's tool settings as a revision body keeps them, through the one copy: checked by tool-plane's settingsIssues
 *  (a refusal is an input error) and made canonical by canonicalToolSettings (sorted keys, empty tools dropped, a pin's
 *  arguments sorted). `{ toolSettings }` when any survive, `{}` when none. Whether an agent may set its own pin is the
 *  request layer's gate (validate.ts AGENT_LAYER_PINS); here a pin that reaches this is kept canonical. */
function toolSettingsOf(given: unknown): { toolSettings?: ToolSettings } {
  if (!isObject(given)) return {};
  // Layer "agent": the one copy checks an agent's own tool settings (a broken agent pin is a 422, not served pin_broken).
  const issues = settingsIssues(given, "tool_settings", "agent");
  if (issues.length) throw invalid(issues);
  const canonical = canonicalToolSettings(given as ToolSettingsMap);
  return Object.keys(canonical).length ? { toolSettings: canonical as ToolSettings } : {};
}

/** The revision a checked definition makes, in the store's shape (store/agent-body.ts's input), ready for bodyOf. `files`
 *  are the skill files by path. Ported from serve/src/agents.ts's revisionOf, over the folded validator. */
function revisionInputOf(definition: Json, files: Record<string, string>): RevisionBodyInput {
  const issues = skillIssues(definition.skills, Object.keys(files));
  if (issues.length) throw invalid(issues);
  // The default harness is never stored: naming pi and naming none are one revision.
  const stored = typeof definition.harness === "string" ? storedHarness(definition.harness) : undefined;
  const harness = stored ? { harness: stored } : {};
  // The computer and its place are one setting (computer-setting.ts): naming either keeps both, and both given must agree.
  const setting = settingOfDefinition(definition);
  const place = setting ? { place: setting.place as RevisionPlace, computer: setting.computer as RevisionComputer } : {};
  // Tool settings go through the one copy (tool-plane.ts): settingsIssues checks them (providers, permissions, keys, and
  // an MCP tool's pin via pinIssues), then canonicalToolSettings makes the one form (sorted keys, empty tools dropped, a
  // pin's arguments sorted) so two revisions that say the same are one body. The store never reimplements it.
  const set = toolSettingsOf(definition.tool_settings);
  const common = { skills: files, tools: (definition.tools as string[] | undefined) ?? [], ...harness, ...place, ...set };
  const capped = {
    ...(typeof definition.max_cost_usd === "number" && definition.max_cost_usd > 0 ? { maxCostUsd: definition.max_cost_usd } : {}),
    ...(typeof definition.cap_mode === "string" ? { capMode: definition.cap_mode } : {}),
  };
  if (isObject(definition.workflow)) return { kind: "workflow", workflow: definition.workflow, ...common, ...capped };
  const learning = typeof definition.learning === "boolean" ? { learning: definition.learning } : {};
  return {
    kind: "agentic",
    instructions: definition.instructions as string,
    ...(typeof definition.model === "string" ? { model: definition.model } : {}),
    ...(typeof definition.thinking === "string" ? { thinking: definition.thinking } : {}),
    ...(definition.approvals === "ask" || definition.approvals === "never" ? { approvals: definition.approvals } : {}),
    ...common,
    ...learning,
    ...capped,
  };
}

/** The new revision (NewRevision for the store) a checked definition makes: its body and skills from bodyOf, a fresh id. */
function newRevisionOf(definition: Json, files: Record<string, string>): NewRevision {
  const input = revisionInputOf(definition, files);
  const { body, skills } = bodyOf(input);
  return { id: uuidv7(), kind: input.kind, body, skills };
}

/** `definition.version`, when given, is the number of the revision the request leaves current. */
function checkVersion(definition: Json, version: number): void {
  if (definition.version !== undefined && definition.version !== version) {
    throw invalid([{ field: "definition.version", reason: "not_an_option", message: `definition.version is ${version} here: the number of the revision this definition leaves current` }]);
  }
}

/** Whether committing `next` would leave the agent's current revision unchanged: the same kind and body (skills are in the
 *  body as their SHA-256, so equal files are an equal body — and equal pins an equal body, keys sorted by the validator). */
function sameRevision(current: RevisionRow, next: NewRevision): boolean {
  return current.kind === next.kind && canonical(current.body) === canonical(next.body);
}

/** The byte size of each of the revision's skill files, by the SHA-256 the body keeps (from the texts on its row). */
function sizesOf(revision: RevisionRow | null): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!revision) return sizes;
  const body = revision.body as Body;
  const texts = (isObject(revision.skills) ? revision.skills : {}) as Record<string, string>;
  for (const [path, sha] of Object.entries(body.skills ?? {})) {
    const text = texts[path];
    if (typeof text === "string") sizes.set(sha, Buffer.byteLength(text, "utf8"));
  }
  return sizes;
}

/** The agent `id` as an entry, or null when there is no such agent: its row, its current revision (by the agent row's
 *  current_revision), that revision's number (newest is the count), and the skill sizes. */
export async function getAgent(store: AgentsStore, id: string): Promise<AgentEntry | null> {
  const agent = await store.agents.get(id);
  if (!agent) return null;
  const revisions = await store.agents.revisions(id); // oldest first (created_at, id)
  const at = agent.currentRevision === null ? -1 : revisions.findIndex((r) => r.id === agent.currentRevision);
  const revision = at < 0 ? null : revisions[at]!;
  return { agent, revision, version: at < 0 ? 0 : at + 1, revisions: revisions.length, sizes: sizesOf(revision) };
}

/** Every agent here, newest first (its creation, then its id). Archived agents are left out by default. */
export async function listAgents(store: AgentsStore, options: { archived?: boolean } = {}): Promise<AgentEntry[]> {
  const agents = await store.agents.list(options);
  const entries = await Promise.all(agents.map((agent) => getAgent(store, agent.id)));
  return (entries.filter((entry): entry is AgentEntry => entry !== null))
    .sort((a, b) => b.agent.createdAt - a.agent.createdAt || a.agent.id.localeCompare(b.agent.id));
}

/** A new agent and its first revision, current, in one store transaction (store.agents.create). A definition id already
 *  here is 409 agent_exists. `check` sees the revision before anything is written and may refuse it (a workflow's own
 *  check). `fresh`: the place and tools a new agent that names none is saved with (an agentic definition alone). */
export async function createAgent(
  store: AgentsStore,
  { definition, skills = {}, note }: DefinitionBody,
  options: { check?: (revision: NewRevision) => Promise<void>; fresh?: { place: RevisionPlace; tools: readonly string[] } } = {},
): Promise<AgentEntry> {
  const given = typeof definition.id === "string" ? definition.id : undefined;
  if (given !== undefined && !ID_PATTERN.test(given)) throw invalid([{ field: "definition.id", reason: "invalid", message: `definition.id does not match ${ID_PATTERN.source}` }]);
  if (given !== undefined && (await store.agents.get(given))) throw new ApiError("agent_exists", `an agent ${given} exists here`);
  // Stamped on the revision now, never resolved at run time: an agent saved with no place keeps running on the runner.
  const stamped = options.fresh && definition.place === undefined && definition.computer === undefined && !isObject(definition.workflow)
    ? { place: options.fresh.place, ...(definition.tools === undefined ? { tools: [...options.fresh.tools] } : {}) }
    : {};
  const revision = makeRevision({ ...definition, ...stamped }, skills, note);
  checkVersion(definition, 1);
  await options.check?.(revision);
  const id = given ?? uuidv7();
  const name = definition.name as string;
  try {
    await store.agents.create({ id, name, ...(typeof definition.description === "string" ? { description: definition.description } : {}) }, revision);
  } catch (error) {
    if (error instanceof StoreConstraint && given !== undefined) throw new ApiError("agent_exists", `an agent ${given} exists here`);
    storeError(error);
  }
  return (await getAgent(store, id))!;
}

/** NewRevision from a definition and its skill files, with its note kept (note is not part of the body or its dedup). A
 *  body the validator refuses is mapped to an input refusal here (never thrown raw). Nothing is written: POST /runs makes
 *  an inline agent's revision with it, as POST /agents makes one. */
export function makeRevision(definition: Json, files: Record<string, string>, note: string | undefined): NewRevision & { note?: string } {
  let revision: NewRevision;
  try {
    revision = newRevisionOf(definition, files);
  } catch (error) {
    storeError(error);
  }
  return note !== undefined ? { ...revision, note } : revision;
}

/** An edit: a new revision of the agent, made current. Without `skills` the current revision's skill files carry over. An
 *  edit that is the current revision writes nothing, so a PUT sent twice makes one revision. The agent keeps its id, name
 *  and description from its creation. `ifCurrent` (from If-Match) is the current revision the caller read, null for none;
 *  it is checked against the agent's current revision (one server per store writes agents). `check` may refuse the revision
 *  before a write. `contract`: an edit that always makes a new revision, even one equal to the current. */
export async function commitAgent(
  store: AgentsStore,
  read: AgentEntry,
  { definition, skills, note }: DefinitionBody,
  { ifCurrent, check, contract = false }: { ifCurrent?: string | null; check?: (revision: NewRevision) => Promise<void>; contract?: boolean } = {},
): Promise<AgentEntry> {
  const entry = (await getAgent(store, read.agent.id)) ?? read;
  refuseExternal(entry.agent);
  if (ifCurrent !== undefined && (entry.revision?.id ?? null) !== ifCurrent) {
    throw new ApiError("precondition_failed", "the agent's current revision moved since the If-Match it was read at: read the agent again");
  }
  const { agent } = entry;
  const kept = [
    ...(definition.id !== undefined && definition.id !== agent.id ? [{ field: "definition.id", reason: "not_an_option", message: `definition.id is ${agent.id}, the agent's id` }] : []),
    ...(["name", "description"] as const)
      .filter((key) => definition[key] !== undefined && definition[key] !== (agent as unknown as Record<string, unknown>)[key])
      .map((key) => ({ field: `definition.${key}`, reason: "not_allowed", message: `The agent store keeps an agent's ${key} from its creation; an edit does not change it.`, fix: `Remove definition.${key}.` })),
  ];
  if (kept.length) throw invalid(kept);
  // What an edit leaves out keeps the agent's current revision's: its skill files, harness, place, learning switch and
  // default cap. Absent here is unchanged, not the default.
  const current = entry.revision;
  const currentBody = (current?.body ?? {}) as Partial<AgenticBody & WorkflowBody>;
  let files = skills;
  if (files === undefined) files = (isObject(current?.skills) ? (current!.skills as Record<string, string>) : {});
  const carried = current
    ? {
        ...(definition.harness === undefined && currentBody.harness ? { harness: currentBody.harness } : {}),
        // The computer and its place go together: an edit naming neither keeps both (the computer, else the place).
        ...(definition.place === undefined && definition.computer === undefined ? (currentBody.computer ? { computer: currentBody.computer } : currentBody.place ? { place: currentBody.place } : {}) : {}),
        ...(definition.learning === undefined && current.kind === "agentic" && !isObject(definition.workflow) && (currentBody as AgenticBody).learning !== undefined ? { learning: (currentBody as AgenticBody).learning } : {}),
        ...(definition.approvals === undefined && current.kind === "agentic" && !isObject(definition.workflow) && (currentBody as AgenticBody).approvals !== undefined ? { approvals: (currentBody as AgenticBody).approvals } : {}),
        ...(definition.max_cost_usd === undefined && currentBody.maxCostUsd !== undefined ? { max_cost_usd: currentBody.maxCostUsd } : {}),
        ...(definition.cap_mode === undefined && currentBody.capMode !== undefined ? { cap_mode: currentBody.capMode } : {}),
      }
    : {};
  const revision = makeRevision({ ...definition, ...carried }, files, note);
  await check?.(revision);
  if (!contract && current && sameRevision(current, revision)) {
    checkVersion(definition, entry.version);
    return entry;
  }
  checkVersion(definition, entry.revisions + 1);
  await store.agents.addRevision({ agentId: agent.id, ...revision }).catch(storeError);
  return (await getAgent(store, agent.id))!;
}

/** Makes `revisionId`, one of the agent's own, its current one (POST /agents/{id}/current). */
export async function setCurrentRevision(store: AgentsStore, entry: AgentEntry, revisionId: string): Promise<AgentEntry> {
  refuseExternal(entry.agent);
  await store.agents.setCurrent(entry.agent.id, revisionId).catch((error) => {
    if (error instanceof StoreConstraint) throw new ApiError("not_found", "that revision is not a revision of that agent");
    throw error;
  });
  return (await getAgent(store, entry.agent.id))!;
}

/** Archives or unarchives an agent. */
export async function setAgentArchived(store: AgentsStore, id: string, archived: boolean): Promise<void> {
  const agent = await store.agents.get(id);
  if (!agent) throw new ApiError("not_found", "there is no such agent");
  refuseExternal(agent);
  await store.agents.archive(id, archived);
}

/** The agent's revisions, newest first, each with its number (the oldest is 1). */
export async function agentRevisions(store: AgentsStore, agentId: string): Promise<Array<RevisionRow & { version: number; current: boolean }>> {
  const agent = await store.agents.get(agentId);
  const rows = await store.agents.revisions(agentId); // oldest first
  return rows.map((row, index) => ({ ...row, version: index + 1, current: row.id === agent?.currentRevision })).reverse();
}

/** Revision `revisionId` of `agentId` with its number, or null when it is not one of the agent's. */
export async function agentRevision(store: AgentsStore, agentId: string, revisionId: string): Promise<{ revision: RevisionRow; version: number; current: boolean } | null> {
  const row = (await agentRevisions(store, agentId)).find((r) => r.id === revisionId);
  return row ? { revision: row, version: row.version, current: row.current } : null;
}

/** The agent's ETag: its current revision, which only an edit or POST .../current moves. */
export const etagOf = (entry: AgentEntry) => `"${entry.revision?.id ?? "none"}"`;

/** A revision as a definition, as POST /agents takes one, numbered. */
export function definitionOf(agent: AgentRow, revision: RevisionRow, version: number): Json {
  const body = revision.body as Body;
  const common = {
    ...(body.maxCostUsd !== undefined ? { max_cost_usd: body.maxCostUsd } : {}),
    ...(body.capMode !== undefined ? { cap_mode: body.capMode } : {}),
  };
  const kindBody = revision.kind === "agentic"
    ? { instructions: (body as AgenticBody).instructions, ...((body as AgenticBody).model ? { model: (body as AgenticBody).model } : {}), ...((body as AgenticBody).thinking ? { thinking: (body as AgenticBody).thinking } : {}), ...((body as AgenticBody).learning !== undefined ? { learning: (body as AgenticBody).learning } : {}), ...((body as AgenticBody).approvals !== undefined ? { approvals: (body as AgenticBody).approvals } : {}), ...common }
    : { workflow: (body as WorkflowBody).workflow, ...common };
  return {
    id: agent.id,
    version,
    name: agent.name,
    ...(agent.description !== null && agent.description !== undefined ? { description: agent.description } : {}),
    ...kindBody,
    harness: harnessOfBody(body),
    ...(body.place ? { place: body.place } : {}),
    // A revision's computer as the API shows it: its own, else the one its place says (a revision saved before the
    // setting keeps its place alone); none when it names neither (the host's default applies).
    ...(body.computer ? { computer: body.computer } : body.place ? { computer: computerOfPlace(body.place as PlaceView) } : {}),
    skills: skillNames(Object.keys(body.skills ?? {})),
    tools: body.tools,
    ...(body.toolSettings ? { tool_settings: body.toolSettings } : {}),
  };
}

/** The agent as the contract shows it, with its current revision, its saved sign-ins (never a ref) and its run counts
 *  (E3's, passed in). `origin`: where its console page is. */
export function agentView(
  entry: AgentEntry,
  origin: string,
  extra: { signIns?: readonly object[]; learning?: { pending: number }; runs?: { count: number; live: number } } = {},
) {
  const { agent, revision } = entry;
  const body = (revision?.body ?? {}) as Body;
  const external = externalOf(agent, revision);
  return {
    agent_id: agent.id,
    // Only on an agent another system owns (POST /runs): read-only here.
    ...(external ? { external } : {}),
    definition: revision ? definitionOf(agent, revision, entry.version) : null,
    kind: revision?.kind ?? null,
    revision: revision?.id ?? null,
    revisions: entry.revisions,
    source: null,
    skills: Object.entries(body.skills ?? {}).map(([path, sha]) => ({ path, sha256: sha, size_bytes: entry.sizes.get(sha) ?? null })),
    sign_ins: extra.signIns ?? [],
    runs: extra.runs ?? { count: 0, live: 0 },
    region: "local",
    home_etag: etagOf(entry),
    archived_at: agent.archivedAt == null ? null : new Date(agent.archivedAt).toISOString(),
    console_url: agentLink(origin, agent.id),
    ...(extra.learning ? { learning: extra.learning } : {}),
    created_at: new Date(agent.createdAt).toISOString(),
    updated_at: revision && revision.createdAt > agent.createdAt ? new Date(revision.createdAt).toISOString() : new Date(agent.createdAt).toISOString(),
  };
}

/** One revision as GET .../revisions lists it (the v2 shape: revision, version, parent, kind, current, note, created_at,
 *  definition). */
export function revisionView(agent: AgentRow, row: RevisionRow & { version: number; current: boolean }) {
  return {
    revision: row.id,
    version: row.version,
    parent: row.parent,
    kind: row.kind,
    current: row.current,
    note: row.note ?? null,
    created_at: new Date(row.createdAt).toISOString(),
    definition: definitionOf(agent, row, row.version),
  };
}
