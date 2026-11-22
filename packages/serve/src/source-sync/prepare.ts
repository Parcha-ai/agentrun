// Translate a complete source through the server's actual destination registry. Names, URLs and native permission
// spellings alone are not authority to grant tools, select an account or weaken a policy.
import { uuidv7 } from "../ids.js";
import type { InputIssue } from "../errors.js";
import type { SourceSnapshot, SourceSnapshotBlocker, SourceSnapshotTool } from "../native/source-snapshot-types.js";
import { bodyOf, canonical, type AgenticBody } from "../store/agent-body.js";
import type { NewRevision, SettingsGuard, McpGuard } from "../store/store.js";
import { canonicalToolSettings, settingsIssues, type ToolSettingsMap } from "../tool-plane.js";
import type { SourcePreparation } from "./registry.js";
import { validateSourceSnapshot } from "./snapshots.js";

export class SourcePreparationError extends Error {
  constructor(readonly blockers: readonly SourceSnapshotBlocker[]) {
    super(blockers.map(item => item.message).join(" ")); this.name = "SourcePreparationError";
  }
}
type Refused = { readonly blockers: readonly SourceSnapshotBlocker[] };
type Guarded = { readonly guards?: readonly SettingsGuard[]; readonly mcpGuards?: readonly McpGuard[] };
type ResolvedModel = Guarded & { readonly sourceModel: string | null; readonly model: string; readonly harness: string; readonly thinking?: string };
type ResolvedTool = Guarded & { readonly source: SourceSnapshotTool; readonly tools: readonly string[] };
type ResolvedPolicy = Guarded & Pick<AgenticBody, "approvals" | "place" | "computer"> & {
  readonly toolSettings?: ToolSettingsMap;
  /** The complete native policy handled by this mapping, not just its supported subset. */
  readonly source: Readonly<Record<string, unknown>>;
  /** Required built-in tools, including the executor the source needs. No harness filter may silently remove one. */
  readonly tools: readonly string[];
};
export interface SourcePreparationDeps {
  /** Resolve an actual model route and its independently configured destination authentication. A native default or
   * alias must be resolved from authoritative source/destination configuration, never guessed from its spelling. */
  model(snapshot: SourceSnapshot): Promise<ResolvedModel | Refused>;
  /** Validate the complete capability and account identity against the authenticated destination tool registry.
   * Matching a source name or endpoint alone is insufficient. Credential generations become cutover guards. */
  tool(requirement: SourceSnapshotTool, snapshot: SourceSnapshot): Promise<ResolvedTool | Refused>;
  /** Translate all native restrictions, or refuse. For example, a native `never` approval policy does not establish
   * equivalence to the managed `never` setting, which automatically approves requests. */
  policy(snapshot: SourceSnapshot, externalTools: readonly string[]): Promise<ResolvedPolicy | Refused>;
  /** Check destination secret setup for every named source requirement. No native secret value is copied. */
  credentials(names: readonly string[], snapshot: SourceSnapshot): Promise<Guarded & { readonly resolved: readonly string[] } | Refused>;
  /** The server's ordinary saveable/runnable check, over the final definition. Unlike a normal save, Move rejects
   * host warnings too. Pins come from that real check, never the native manifest. */
  check(revision: NewRevision): Promise<Guarded & { readonly warnings: readonly InputIssue[]; readonly stamp: Pick<NewRevision, "mcpPin" | "monidPin"> }>;
}
function refuse(code: string, message: string, path?: string): never { throw new SourcePreparationError([{ code, ...(path ? { path } : {}), message }]); }
function resolved<T extends object>(value: T | Refused): T {
  if ("blockers" in value) {
    if (!value.blockers.length) refuse("destination_mapping", "The destination did not supply a complete mapping.");
    throw new SourcePreparationError(value.blockers);
  }
  return value;
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const names = (value: readonly string[]): boolean => Array.isArray(value) && value.every(name => typeof name === "string" && name.trim().length > 0) && new Set(value).size === value.length;

/** A managed definition from source-owned configuration. Snapshot asset bytes remain pinned for project seeding;
 * the revision indexes authored skill metadata without decoding binary assets or replacing their executable modes. */
export async function prepareSource(snapshot: SourceSnapshot, deps: SourcePreparationDeps): Promise<SourcePreparation> {
  validateSourceSnapshot(snapshot);
  if (!snapshot.complete || snapshot.blockers.length) throw new SourcePreparationError(snapshot.blockers.length ? snapshot.blockers : [{ code: "incomplete", message: "Sync a complete source setup before moving it." }]);
  if (!snapshot.configuration.model?.trim()) refuse("model_mapping", "Sync the source's effective model before selecting its destination route.", "configuration.model");
  const guards: SettingsGuard[] = [], mcpGuards: McpGuard[] = [];
  const keep = (value: Guarded): void => { guards.push(...(value.guards ?? [])); mcpGuards.push(...(value.mcpGuards ?? [])); };
  const model = resolved(await deps.model(snapshot));
  if (model.sourceModel !== snapshot.configuration.model || typeof model.model !== "string" || !model.model.trim() || typeof model.harness !== "string" || !model.harness.trim()) {
    refuse("model_mapping", "Resolve this source's actual model and destination harness before moving it.", "configuration.model");
  }
  keep(model);
  const external: string[] = [];
  for (const requirement of snapshot.configuration.tools) {
    const tool = resolved(await deps.tool(requirement, snapshot));
    if (!same(tool.source, requirement) || !names(tool.tools) || !tool.guards?.length) {
      refuse("tool_identity", `Verify the destination capabilities and account for source tool ${JSON.stringify(requirement.name)}.`, "configuration.tools");
    }
    external.push(...tool.tools); keep(tool);
  }
  const policy = resolved(await deps.policy(snapshot, external));
  if (!same(policy.source, snapshot.configuration.permissions) || !names(policy.tools)) {
    refuse("policy_mapping", "Map every source permission and required built-in tool before moving this agent.", "configuration.permissions");
  }
  keep(policy);
  const required = [...new Set([...snapshot.configuration.credentials, ...snapshot.configuration.tools.flatMap(tool => tool.credentials)])];
  const credentials = resolved(await deps.credentials(required, snapshot));
  if (!names(credentials.resolved) || required.some(name => !credentials.resolved.includes(name))) {
    refuse("credentials_missing", "Configure the destination credentials required by this source's model and tools.", "configuration.credentials");
  }
  keep(credentials);
  const skills: Record<string, string> = Object.create(null);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const skill of snapshot.skills) {
    const entry = snapshot.entries.find(item => item.path === `${skill.path}/SKILL.md` && item.type === "file");
    if (!entry?.sha256) refuse("skill_missing", `Sync the complete authored skill ${JSON.stringify(skill.name)}.`, skill.path);
    try { skills[`${skill.name}/SKILL.md`] = decoder.decode(Buffer.from(snapshot.blobs[entry.sha256]!, "base64")); }
    catch { refuse("skill_encoding", `The authored skill ${JSON.stringify(skill.name)} needs a UTF-8 SKILL.md.`, `${skill.path}/SKILL.md`); }
  }
  if (policy.toolSettings) {
    const issues = settingsIssues(policy.toolSettings, "definition.tool_settings", "agent");
    if (issues.length) throw new SourcePreparationError(issues.map(issue => ({ code: issue.reason, path: issue.field, message: issue.message })));
  }
  const made = bodyOf({ kind: "agentic", instructions: snapshot.instructions.text, skills,
    tools: [...new Set([...policy.tools, ...external])], model: model.model, harness: model.harness,
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    ...(policy.toolSettings === undefined ? {} : { toolSettings: canonicalToolSettings(policy.toolSettings) }),
    ...(policy.approvals === undefined ? {} : { approvals: policy.approvals }),
    ...(policy.place === undefined ? {} : { place: policy.place }),
    ...(policy.computer === undefined ? {} : { computer: policy.computer }),
  });
  const revision: NewRevision = { id: uuidv7(), kind: "agentic", body: made.body, skills: made.skills };
  const checked = await deps.check(revision);
  if (checked.warnings.length) throw new SourcePreparationError(checked.warnings.map(issue => ({ code: issue.reason, path: issue.field, message: issue.message })));
  keep(checked);
  return { revision: { ...revision, ...checked.stamp }, guards, mcpGuards };
}
