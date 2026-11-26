/** Read-only native capability evidence. This resolver never starts a session, runs hooks or connects MCP.
 * Codex facts: openai/codex rust-v0.171.0 and rust-v0.172.0, core/src/tools/spec_plan.rs, features/src/lib.rs,
 * models-manager/models.json and app-server/src/extensions.rs. Claude 2.1.322's explicit agent tool
 * list is documented in code.claude.com/docs/en/{sub-agents,tools-reference,cli-reference}.
 * Default/account catalogs remain prerequisites unless their enabled closure is established. */
import { NATIVE_RUNTIME_FACTS } from "./runtimes.js";
import type { NativeRuntime } from "./types.js";
import { claudeMcpSelector, nativeToolNames } from "./source-mcp-selection.js";
import { SOURCE_NATIVE_CAPABILITIES, type SourceNativeCapability as Capability, type SourceNativeTools, type SourceSnapshotBlocker } from "./source-snapshot-types.js";
/** Only these non-credential environment selectors affect the supported snapshot resolver. Consent hashes
 * their exact source values; neither the consent wire nor a saved grant contains the values themselves. */
export const SOURCE_NATIVE_ENV_KEYS = ["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_ENABLE_TASKS"] as const;
export function sourceNativeEnvironmentFacts(environment: Readonly<Record<string, string | undefined>>): Record<string, string | null> {
  return Object.fromEntries(SOURCE_NATIVE_ENV_KEYS.map(name => [name, environment[name] ?? null]));
}
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const CLAUDE_TOOLS: Record<string, readonly Capability[]> = {
  Bash: ["shell", "file_read", "file_write", "file_edit", "file_search"], Read: ["file_read", "image_read"], Write: ["file_write"], Edit: ["file_edit"], Glob: ["file_search"], Grep: ["file_search"],
  WebSearch: ["web_search"], WebFetch: ["web_fetch"], Agent: ["subagents"], Task: ["subagents"], NotebookEdit: ["notebook_edit"],
  AskUserQuestion: ["user_input"], EnterPlanMode: ["planning"], ExitPlanMode: ["planning"], EndConversation: ["session_end"],
  Skill: ["skills"], ListMcpResourcesTool: ["mcp_resources"], ReadMcpResourceTool: ["mcp_resources"],
  TaskCreate: ["task_tracking"], TaskUpdate: ["task_tracking"], TaskGet: ["task_tracking"], TaskList: ["task_tracking"], TaskStop: ["task_tracking"],
  EnterWorktree: ["worktree"], ExitWorktree: ["worktree"], SendMessage: ["session_messaging"], ListAgents: ["session_messaging"],
  PushNotification: ["notifications"], SendFeedback: ["feedback"], Artifact: ["artifact_publish"], RemoteTrigger: ["remote_tasks"], SendUserFile: ["remote_files"],
};
const CODEX_MODELS: Record<string, { agent: "v1" | "v2" | null; clock: boolean; async: readonly string[]; extra: readonly string[]; lite: boolean }> = Object.fromEntries([
  ...["gpt-6.2-sol", "gpt-6.2-astra"].map(name => [name, { agent: "v2", clock: true, async: ["request_user_input_async", "send_message_to_user_async"], lite: true, extra: ["literature_search_query"] }]),
  ...["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"].map(name => [name, { agent: "v2", clock: true, async: ["send_user_message_async"], lite: true, extra: [] }]),
  ...["gpt-5.6-sol", "gpt-5.6-terra"].map(name => [name, { agent: "v2", clock: false, async: [], lite: true, extra: [] }]),
  ["gpt-5.6-luna", { agent: "v1", clock: false, async: [], lite: true, extra: [] }],
  ["gpt-5.5", { agent: null, clock: false, async: [], lite: false, extra: [] }],
]);
export const SOURCE_CODEX_FEATURES = ["shell_tool", "view_image", "multi_agent", "apps", "plugins", "image_generation", "tool_suggest", "goals", "memories", "current_time_reminder", "sleep_tool", "token_budget"] as const;
export const SOURCE_CODEX_VERSIONS: readonly string[] = ["0.171.0", "0.172.0"];
export function sourceNativeTools(input: { runtime: NativeRuntime; version: string | null; model: string | null;
  config: Record<string, any>; permissions: Record<string, unknown>; mcp: boolean; modelCache?: unknown }): { tools: SourceNativeTools; blockers: SourceSnapshotBlocker[] } {
  const enabled = new Set<Capability>(), disabled = new Set<Capability>(), blockers: SourceSnapshotBlocker[] = [];
  const block = (code: string, message: string) => blockers.push({ code, message, path: "configuration/native_tools" });
  const set = (capability: Capability, on: boolean) => (on ? enabled : disabled).add(capability);
  const tools: SourceNativeTools = { version: input.version, complete: false, source: "versioned-runtime", capabilities: [], disabled: [] };
  if (NATIVE_RUNTIME_FACTS[input.runtime].protocol === "codex-json") {
    if (!SOURCE_CODEX_VERSIONS.includes(input.version ?? "")) block("native_version", "This Codex version needs a verified native capability resolver before Move.");
    const features = object(input.config.features), on = (name: string, fallback: boolean) => typeof features[name] === "boolean" ? features[name] : fallback;
    const model = input.model ? CODEX_MODELS[input.model] : undefined;
    if (!model) block("native_model_tools", "Choose an exact source model with verified builtin tool metadata before Move.");
    // A cache with different tool facts could be active under the source account. Never infer its auth identity.
    const cache = object(input.modelCache), cached = Array.isArray(cache.models) ? cache.models.find((row: any) => row?.slug === input.model) : undefined;
    if (cache.client_version === input.version && cache.identity && cached && model) {
      const expectedExtras = [...model.async, ...(model.clock ? ["clock"] : [])];
      const actualExtras = (Array.isArray(cached.experimental_supported_tools) ? cached.experimental_supported_tools : []).filter((name: unknown) => name !== "multi_agent_v2_in_code_mode").sort();
      // Both catalogue labels use exec_command/write_stdin under the supported versions' UnifiedExec default.
      // The destination shell capability includes background processes, stdin, output, signals and optional TTYs.
      if (!["shell_command", "unified_exec"].includes(cached.shell_type) || cached.apply_patch_tool_type !== "freeform" || (cached.multi_agent_version ?? null) !== model.agent || cached.use_responses_lite !== model.lite || (cached.tool_mode ?? null) !== (model.lite ? "code_mode_only" : null) || JSON.stringify(actualExtras) !== JSON.stringify([...expectedExtras, ...model.extra].sort()))
        block("native_model_catalog", "The source model cache has different builtin tools; resolve its active catalog before Move.");
    }
    set("shell", on("shell_tool", true));
    for (const name of ["file_read", "file_write", "file_edit", "file_search"] as const) set(name, on("shell_tool", true) || name === "file_edit");
    set("image_read", on("view_image", true));
    set("subagents", object(input.config.agents).enabled !== false && (model?.agent !== null && model?.agent !== undefined || on("multi_agent", true)));
    set("web_search", input.permissions.web_search !== "disabled");
    set("mcp_resources", input.mcp || model?.lite === true);
    set("user_input", object(object(input.config.tools).experimental_request_user_input).enabled !== false || model?.async.includes("send_message_to_user_async") === true);
    set("planning", object(object(input.config.tools).update_plan).enabled === true);
    set("clock", on("current_time_reminder", false) || model?.clock === true);
    set("sleep", on("sleep_tool", true) && enabled.has("clock"));
    set("task_tracking", on("goals", true)); set("context_management", on("token_budget", false)); set("skills", true);
    for (const [name, capability] of [["apps", "apps"], ["plugins", "plugins"], ["image_generation", "image_generate"]] as const) {
      set(capability, on(name, true));
      if (on(name, true)) block(`native_${name}`, "An enabled source account integration needs its exact destination capability and account before Move.");
    }
    if (object(object(input.config.cloud).skills).enabled !== false) block("native_cloud_skills", "Source account skills need a verified export or explicit source disable before Move.");
    if (on("memories", false)) block("native_memory", "Source native memory tools need an explicit destination equivalent before Move.");
    if (model?.extra.length && enabled.has("web_search")) block("native_model_tools", "This model enables additional native tools without a verified destination equivalent.");
  } else {
    if (input.version !== "2.1.322") block("native_version", "This Claude Code version needs a verified native capability resolver before Move.");
    const selected = input.permissions.tools, denied = input.permissions.disallowedTools;
    const list = nativeToolNames(selected), exclusions = nativeToolNames(denied) ?? [];
    if (!list || list.some(name => !Object.hasOwn(CLAUDE_TOOLS, name) && !claudeMcpSelector(name)))
      block("native_tool_list", "Select an explicit supported Claude agent tool list; default and account tools are not yet fully resolved.");
    if (denied !== undefined && !nativeToolNames(denied) || exclusions.some(name => !Object.hasOwn(CLAUDE_TOOLS, name) && !claudeMcpSelector(name)))
      block("native_tool_restriction", "A source tool restriction needs exact native tool resolution before Move.");
    for (const name of list ?? []) if (typeof name === "string" && !exclusions.includes(name)) for (const capability of CLAUDE_TOOLS[name] ?? []) enabled.add(capability);
    // Claude 2.1.322 keeps EndConversation even when an explicit nonempty tool list omits it.
    if (list?.length || input.mcp) enabled.add("session_end");
    for (const capability of SOURCE_NATIVE_CAPABILITIES) if (!enabled.has(capability)) disabled.add(capability);
  }
  tools.capabilities = [...enabled].sort(); tools.disabled = [...disabled].filter(name => !enabled.has(name)).sort(); tools.complete = blockers.length === 0;
  return { tools, blockers };
}
