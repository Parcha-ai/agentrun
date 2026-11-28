/** Resolve source requirements against this server's ordinary model, tool and execution registries. */
import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { factsOf, harnessForSourceProtocol } from "../harness-table.js";
import { sourceRuntimeProtocol } from "../native/source-snapshot-types.js";
import { chooseModel } from "../model.js";
import { formOf, pickerCandidates } from "../model-form.js";
import type { SourceSnapshot, SourceSnapshotTool } from "../native/source-snapshot-types.js";
import { missingMcpTools, selectedMcpTool, sourceMcpSelection } from "../native/source-mcp-selection.js";
import { resourceToolOperation } from "../mcp-resources.js";
import { BOX_IDS, type BoxOffer } from "../place-offers.js";
import { NEW_AGENT_TOOLS, type Place } from "../place.js";
import { isHostTool } from "../tool-list.js";
import { wireOf } from "../wires.js";
import { canonical, isObject } from "../store/agent-body.js";
import type { McpServerRow, Store } from "../store/store.js";
import type { SourcePreparationDeps } from "./prepare.js";

const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const bindingKey = (agentId: string, name: string): string => `source-sync.tool.${agentId}.${digest(name)}`;
const stamp = (row: McpServerRow) => ({ url: row.url, auth: row.auth, credential: row.credentialChangedAt, sealedHash: row.sealed ? createHash("sha256").update(row.sealed).digest("hex") : null, tools: digest(row.tools) });
const refused = (code: string, message: string, path?: string) => ({ blockers: [{ code, message, ...(path ? { path } : {}) }] });
type ToolBinding = { requirement: string; server: string; stamp: ReturnType<typeof stamp> };
function selectedTools(source: SourceSnapshotTool, row: McpServerRow): string[] {
  if (!sourceMcpSelection(source.selection) || !Array.isArray(source.resources)
    || source.resources.some(op => !["list", "templates", "read"].includes(op)))
    throw new ApiError("input_invalid", "Sync this source's complete MCP tool and resource selection before choosing its destination.");
  if (!Array.isArray(row.tools)) throw new ApiError("input_invalid", "Refresh the destination MCP catalog first.");
  const selected: string[] = [], ordinary: string[] = [];
  for (const tool of row.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || !isObject(tool.input_schema)) throw new ApiError("input_invalid", "The destination MCP catalog is incomplete.");
    const resource = resourceToolOperation(tool);
    if (tool.resource !== undefined && !resource) throw new ApiError("input_invalid", "The destination resource capability is invalid; refresh its catalog.");
    if (resource) {
      if (source.resources.includes(resource)) selected.push(`mcp:${row.name}/${tool.name}`);
    } else {
      ordinary.push(tool.name);
      if (selectedMcpTool(source.selection, source.name, tool.name)) selected.push(`mcp:${row.name}/${tool.name}`);
    }
  }
  if (missingMcpTools(source.selection, source.name, ordinary).length) throw new ApiError("input_invalid", "A required source tool is missing from the destination MCP catalog.");
  // Empty is meaningful: an explicit zero-tool source may point at a tools-only server whose
  // native resource listing is empty. Preserve zero grants; never replace them with all tools.
  return selected;
}
const needsSignIn = (source: SourceSnapshotTool, row: McpServerRow): boolean => source.credentials.length > 0 && row.auth === "none"
  || row.auth !== "none" && (!row.sealed || row.tokenLeftMs !== null && row.tokenLeftMs <= 0);
export async function sourceToolConnections(store: Store, agentId: string, snapshot: SourceSnapshot) {
  const rows = await store.mcp.servers();
  return Promise.all(snapshot.configuration.tools.map(async source => {
    const binding = await store.settings.get(bindingKey(agentId, source.name)) as ToolBinding | undefined;
    const selected = binding && rows.find(row => row.name === binding.server);
    const ready = !!(binding && selected && binding.requirement === digest(source) && canonical(stamp(selected)) === canonical(binding.stamp));
    return { name: source.name, ready, ...(ready ? { selected: binding!.server } : {}),
      candidates: rows.filter(row => source.transport === "http" && source.url === row.url).map(row => ({ name: row.name, auth: row.auth })) };
  }));
}

/** The owner explicitly chooses the destination account. Source OAuth tokens and private command environments never
 * cross the source boundary. The binding expires when the source requirement or the saved account changes. */
export async function bindSourceTool(store: Store, agentId: string, source: SourceSnapshotTool, server: string): Promise<void> {
  const row = await store.mcp.server(server);
  if (!row) throw new ApiError("input_invalid", "Connect and verify the destination tool server first.");
  if (needsSignIn(source, row)) throw new ApiError("auth_required", "Sign in to this destination tool server first.");
  if (source.transport !== "http" || source.url !== row.url) throw new ApiError("input_invalid", "This source tool needs a verified destination equivalent before it can move.");
  selectedTools(source, row);
  await store.settings.put(bindingKey(agentId, source.name), { requirement: digest(source), server, stamp: stamp(row) } satisfies ToolBinding);
}

/** Only explicitly represented native policies are mapped. Unknown constraints never disappear into a permissive
 * host default. File operations are workspace-scoped; shell work requires the host's real sandbox and network rule. */
export function sourcePolicy(snapshot: SourceSnapshot, boxes: readonly BoxOffer[], external: readonly string[]) {
  const policy = snapshot.configuration.permissions, evidence = snapshot.configuration.native_tools;
  const block = () => refused("policy_mapping", "This source permission policy needs a supported AgentRun equivalent before Move.", "configuration.permissions");
  if (!evidence?.complete) return refused("native_tool_closure", "Sync complete native tool requirements before Move.", "configuration.native_tools");
  const capabilities = new Set(evidence.capabilities), tools = new Set<string>();
  const missing = (name: string) => refused("native_capability", `The source capability ${JSON.stringify(name)} needs a verified equivalent on this agent's destination harness.`, "configuration.native_tools");
  for (const capability of capabilities) {
    let mapped: readonly string[];
    switch (capability) {
      case "file_read": case "image_read": mapped = ["read"]; break;
      case "file_write": mapped = ["write"]; break;
      case "file_edit": mapped = ["edit"]; break;
      case "shell": mapped = NEW_AGENT_TOOLS; break;
      case "web_search": mapped = ["web_search"]; break;
      case "web_fetch": mapped = ["web_fetch"]; break;
      case "user_input": mapped = ["ask_person"]; break;
      case "file_search": case "clock": case "sleep": case "worktree":
        // Reuse an already authorized shell; never grant a write-capable shell to a read-only tool list.
        if (!capabilities.has("shell")) return missing(capability);
        mapped = ["bash"]; break;
      case "subagents": mapped = ["subagent"]; break;
      // The selected server-local resource operations come through the ordinary pinned MCP
      // path below. A tools-only server adds none; native empty resource discovery adds no access.
      case "mcp_resources": mapped = []; break;
      // Ending the conversation and loading captured authored skills have direct managed equivalents.
      // Planning-mode transitions, context reset APIs and feedback delivery need their own proofs.
      case "session_end": case "skills": mapped = []; break;
      default: return missing(capability);
    }
    for (const name of mapped) {
      // Both source protocols select adapters. Their actual host registry excludes Pi-only tools.
      if (!isHostTool(name)) return missing(capability);
      tools.add(name);
    }
  }
  let shellPermission: "allow" | "ask", externalPermission: "allow" | "ask";
  if (sourceRuntimeProtocol(snapshot.source.runtime) === "pi-settings") {
    if (Object.keys(policy).some(key => !["tools", "project_trust"].includes(key)) || !Array.isArray(policy.tools)
      || policy.tools.some(name => typeof name !== "string" || !["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name))
      || !["trusted", "none"].includes(String(policy.project_trust))) return block();
    shellPermission = "allow"; externalPermission = "allow";
  } else if (sourceRuntimeProtocol(snapshot.source.runtime) === "codex-json") {
    if (Object.keys(policy).some(key => !["approval_policy", "sandbox_mode", "sandbox_workspace_write", "web_search", "project_trust"].includes(key))) return block();
    if (policy.project_trust !== undefined && policy.project_trust !== "trusted") return block();
    // Codex workspace-write protects .git/.codex/.agents even inside writable roots. Our host
    // shell has no equivalent protected-path enforcement yet; a generic container is insufficient.
    if (policy.sandbox_mode !== "danger-full-access") return block();
    if (policy.approval_policy !== "never" && policy.approval_policy !== "on-request") return block();
    if (policy.sandbox_workspace_write !== undefined && (!isObject(policy.sandbox_workspace_write) || Object.keys(policy.sandbox_workspace_write).length)) return block();
    if (![undefined, "disabled", "live", "cached"].includes(policy.web_search as string | undefined)) return block();
    if (capabilities.has("web_search") && policy.web_search !== "live") return refused("web_search_mapping", "The source's cached-search policy needs a verified cached destination route before Move.", "configuration.permissions.web_search");
    shellPermission = "allow"; externalPermission = "ask";
  } else {
    if (Object.keys(policy).some(key => !["defaultMode", "permissionMode", "tools", "disallowedTools"].includes(key))) return block();
    const mode = policy.permissionMode ?? policy.defaultMode;
    if (mode !== "bypassPermissions") return block();
    // Bypass is not permission to skip Claude's critical-operation checks. Keep an explicit
    // owner ask for shell and external operations instead of widening those exceptional effects.
    shellPermission = "ask"; externalPermission = "ask";
  }
  const box = boxes.find(box => box.available && BOX_IDS.includes(box.id) && box.network !== "none");
  if (!box) return refused("execution_environment", "Set up an AgentRun sandbox with the network access this source requires.");
  const names = [...tools].sort();
  return { source: policy, tools: names, approvals: "ask" as const, place: { mode: "sandbox", box: box.id } as Place,
    toolSettings: Object.fromEntries([...names, ...external].map(name => [NEW_AGENT_TOOLS.includes(name) ? "bash" : name, { permission: external.includes(name) ? externalPermission : NEW_AGENT_TOOLS.includes(name) ? shellPermission : "allow" }])) };
}

export function destinationPreparation(store: Store, agentId: string, options: {
  env: () => NodeJS.ProcessEnv; boxes: () => readonly BoxOffer[]; check: SourcePreparationDeps["check"];
  /** Successful probes of this server's destination only. Another or later runner must enforce the same
   * prerequisite at claim: a server-local probe cannot establish a remote runner's isolation policy. */
  projectExecution(): Promise<{ readonly storage: "local" | "archil"; readonly isolation: "uid" | "process" }>;
}): SourcePreparationDeps {
  const authenticated = new Set<string>();
  return {
    model: async snapshot => {
      const source = snapshot.configuration.model, harness = harnessForSourceProtocol(sourceRuntimeProtocol(snapshot.source.runtime));
      if (!source) return refused("model_mapping", "Sync the source's effective model before Move.");
      const env = options.env(), candidates = pickerCandidates(env, harness);
      // Exact catalog IDs only; an alias such as `sonnet` cannot be guessed into a different model version.
      const matches = sourceRuntimeProtocol(snapshot.source.runtime) === "pi-settings" && source.includes("/") ? [source] : candidates.filter(id => id === source || id.slice(id.lastIndexOf("/") + 1) === source);
      // The picker is a short convenience list, not the model catalog. Preserve its configured
      // route preference, otherwise ask the registered source wire's vendor for the exact ID.
      const facts = factsOf(env, harness), vendor = facts && wireOf(facts.wire)?.vendor;
      if (!matches.length && vendor && !env.AGENT_MODEL_BASE_URL && !source.includes("/")) matches.push(formOf(env, vendor, source));
      if (matches.length !== 1) return refused("model_mapping", `Configure one destination route for the source model ${JSON.stringify(source)} in Settings → Model keys.`);
      const model = matches[0]!, chosen = await chooseModel(env, model, "default", harness);
      if ("why" in chosen) return refused("model_authentication", chosen.why);
      authenticated.add("model-provider");
      return { sourceModel: source, model, harness, ...(snapshot.configuration.thinking ? { thinking: snapshot.configuration.thinking } : {}) };
    },
    tool: async source => {
      const key = bindingKey(agentId, source.name);
      const binding = await store.settings.get(key) as ToolBinding | undefined;
      const row = binding && await store.mcp.server(binding.server);
      if (!binding || binding.requirement !== digest(source) || !row || canonical(stamp(row)) !== canonical(binding.stamp)) return refused("tool_connection", `Connect ${JSON.stringify(source.name)} on AgentRun and choose the account this agent should use.`, `configuration.tools.${source.name}`);
      if (needsSignIn(source, row)) return refused("tool_authentication", `Sign in to the destination connection for ${JSON.stringify(source.name)}.`);
      let names: string[];
      try { names = selectedTools(source, row); }
      catch (error) { if (!(error instanceof ApiError)) throw error; return refused("tool_capabilities", error.message, `configuration.tools.${source.name}`); }
      source.credentials.forEach(name => authenticated.add(name));
      return { source, tools: names, mcpGuards: [{ name: row.name, url: row.url, auth: row.auth, credentialChangedAt: row.credentialChangedAt, tools: row.tools, sealed: row.sealed }], guards: [{ key, fields: { requirement: binding.requirement, server: binding.server, stamp: binding.stamp } }] };
    },
    policy: async (snapshot, external) => {
      let execution: Awaited<ReturnType<typeof options.projectExecution>>;
      try { execution = await options.projectExecution(); }
      catch { return refused("project_mode_fidelity", "Verify a destination that preserves project file permissions before Move."); }
      // The per-user helper recursively replaces permission bits, not merely ownership. The source's
      // exact local modes cannot survive that transform; the separate Archil project is untouched.
      if (execution.storage === "local" && execution.isolation === "uid") return refused("project_mode_fidelity",
        "This runner rewrites local project file permissions for per-user isolation. A moved project needs a destination that preserves its original permissions.");
      return sourcePolicy(snapshot, options.boxes(), external);
    },
    credentials: async names => names.every(name => authenticated.has(name)) ? { resolved: [...names] }
      : refused("credentials_missing", "Set up the destination credentials required by this source's tools and model."),
    check: options.check,
  };
}
