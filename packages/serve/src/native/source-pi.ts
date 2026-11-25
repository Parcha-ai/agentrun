/** Pi's source configuration resolved through the snapshot reader: no extension, model or MCP process is started.
 * The supported semantics come from the pinned pi-coding-agent configuration/resource loaders. */
import { dirname, join, resolve } from "node:path";
import type { SourceNativeCapability, SourceSnapshot, SourceTarget } from "./source-snapshot-types.js";
import { SOURCE_NATIVE_CAPABILITIES } from "./source-snapshot-types.js";

type RecordValue = Record<string, any>;
type ReadValue = { bytes?: Buffer; names?: string[] } | null;
type Setup = Omit<SourceSnapshot, "digest" | "complete">;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const PI_CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
const PI_TOOLS: Readonly<Record<string, readonly SourceNativeCapability[]>> = {
  read: ["file_read", "image_read"], bash: ["shell", "file_read", "file_write", "file_edit", "file_search"],
  edit: ["file_edit"], write: ["file_write"], grep: ["file_search"], find: ["file_search"], ls: ["file_search"],
};
const DISPLAY_SETTINGS = new Set(["$schema", "theme", "themes", "quietStartup", "tuiMode", "fullscreenExitOutput", "fullscreenScrollbar", "fullscreenCopyOnSelect", "fullscreenWheelScrollLines", "editorPaddingX", "outputPad", "autocompleteMaxVisible", "showHardwareCursor", "terminal", "markdown", "hideThinkingBlock", "showCacheMissNotices", "doubleEscapeAction", "treeFilterMode", "externalEditor", "collapseChangelog", "showChangelog", "enableSkillCommands", "checkForUpdates", "telemetry", "disableUpdateCheck"]);

export async function capturePiSetup(input: {
  target: SourceTarget; home: string; agentDir: string; result: Setup;
  read(path: string, label: string): Promise<ReadValue>;
  config(path: string): Promise<RecordValue>;
  instruction(path: string): Promise<void>;
  tools(value: unknown, label: string): Promise<void>;
  context(path: string): Promise<boolean>;
  block(code: string, message: string, path?: string): void;
}): Promise<string[]> {
  const { target, home, agentDir, result, read, config, instruction, tools, context, block } = input;
  const projectDir = join(target.project, ".pi"), ancestors: string[] = [];
  for (let dir = target.project; ; dir = dirname(dir)) { ancestors.unshift(dir); if (dir === dirname(dir)) break; }
  if (target.selector.kind !== "project") block("selector", "Select the Pi project; extension-defined agent selectors need their own portable setup.");
  if (target.version !== "1.5.2") block("native_version", "This Pi version needs a verified configuration resolver before deployment.", "configuration/native_tools");
  for (const dir of [agentDir, ...ancestors]) for (const name of PI_CONTEXT_FILES) {
    const path = join(dir, name);
    if (await context(path)) { await instruction(path); break; }
  }
  const global = await config(join(agentDir, "settings.json")), trust = await config(join(agentDir, "trust.json"));
  let trusted: boolean | undefined;
  for (const dir of [...ancestors].reverse()) if (typeof trust[dir] === "boolean") { trusted = trust[dir]; break; }
  if (trusted === undefined && ["always", "never"].includes(global.defaultProjectTrust)) trusted = global.defaultProjectTrust === "always";
  const projectFiles = (await read(projectDir, "configuration/project"))?.names ?? [];
  const projectSkills: string[] = [];
  // Shared skills above the repository root are not project resources in Pi's package loader.
  for (const dir of [...ancestors].reverse()) {
    const skills = join(dir, ".agents", "skills");
    if (dir !== home && await context(skills)) projectSkills.push(skills);
    if (await context(join(dir, ".git"))) break;
  }
  if (trusted !== true && (projectFiles.length || projectSkills.length))
    block("pi_project_trust", "Trust this Pi project in Pi before exporting its project settings and resources.", "configuration/project_trust");
  const project = trusted === true ? await config(join(projectDir, "settings.json")) : {};
  const settings: RecordValue = {}, selected = new Set<string>(["read", "bash", "edit", "write"]);
  let mcpEnabled = true;
  for (const [scope, value] of [["user", global], ["project", project]] as const) for (const [key, setting] of Object.entries(value)) {
    if (DISPLAY_SETTINGS.has(key)) continue;
    if (key === "defaultProjectTrust") {
      if (scope !== "user" || !["always", "never", "ask"].includes(setting)) block("unsupported_setting", "This Pi trust setting needs a valid user-level policy.", `configuration/${key}`);
    } else if (["defaultProvider", "defaultModel", "defaultThinkingLevel"].includes(key) && typeof setting === "string") settings[key] = setting;
    else if (key === "modelThinkingLevels" && setting && typeof setting === "object" && !Array.isArray(setting)) settings[key] = { ...object(settings[key]), ...setting };
    else if (key === "defaultTools" && Array.isArray(setting) && setting.every(name => typeof name === "string" && name.length)) {
      if (!setting.length || setting.some(name => !name.startsWith("+") && !name.startsWith("-"))) selected.clear();
      for (const name of setting.filter(name => !name.startsWith("+") && !name.startsWith("-"))) selected.add(name);
      for (const name of setting.filter(name => name.startsWith("+") || name.startsWith("-"))) name.startsWith("-") ? selected.delete(name.slice(1)) : selected.add(name.slice(1));
    } else if (key === "extensions" && Array.isArray(setting)) {
      for (const name of setting) {
        if (typeof name !== "string" || !/^[+-]?builtin:(?:mcp|llama\.cpp|codemode|tool-search)$/.test(name)) block("pi_extension", "A configured Pi extension needs a verified managed equivalent.", "configuration/extensions");
        else if (name.replace(/^[+-]/, "") === "builtin:mcp") mcpEnabled = !name.startsWith("-");
      }
    } else if (["skills", "packages", "prompts"].includes(key) && Array.isArray(setting) && !setting.length) { /* no additional resources */ }
    else block("unsupported_setting", "This Pi setting needs an explicit managed equivalent.", `configuration/${key}`);
  }
  for (const dir of [agentDir, ...(trusted === true ? [projectDir] : [])]) {
    if ((await read(join(dir, "extensions"), "configuration/extensions"))?.names?.length) block("pi_extension", "A local Pi extension needs a verified managed equivalent.", "configuration/extensions");
    if ((await read(join(dir, "prompts"), "configuration/prompts"))?.names?.length) block("pi_prompt_templates", "Pi slash-command templates need an explicit managed equivalent.", "configuration/prompts");
    if (Object.keys(await config(join(dir, "models.json"))).length) block("pi_model_configuration", "Custom Pi model/provider configuration needs a verified destination route.", "configuration/models");
  }
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    const path = trusted === true && (await read(join(projectDir, name), "instructions"))?.bytes ? join(projectDir, name) : join(agentDir, name);
    if ((await read(path, "instructions"))?.bytes) {
      if (name === "SYSTEM.md") block("pi_system_prompt", "A Pi system-prompt replacement needs a managed equivalent; it cannot be treated as appended instructions.", "configuration/SYSTEM.md");
      else await instruction(path);
    }
  }
  if (typeof settings.defaultProvider !== "string" || !settings.defaultProvider || typeof settings.defaultModel !== "string" || !settings.defaultModel)
    block("model_mapping", "Save an explicit Pi defaultProvider and defaultModel before deploying this setup.", "configuration/model");
  else result.configuration.model = `${settings.defaultProvider}/${settings.defaultModel}`;
  const thinking = object(settings.modelThinkingLevels)[result.configuration.model ?? ""] ?? settings.defaultThinkingLevel ?? "medium";
  if (["low", "medium", "high", "xhigh", "max"].includes(thinking)) result.configuration.thinking = thinking;
  else block("pi_thinking", "This Pi thinking level needs an exact supported destination equivalent.", "configuration/thinking");
  const capabilities = new Set<SourceNativeCapability>(["skills"]);
  for (const name of selected) {
    if (!Object.hasOwn(PI_TOOLS, name)) block("pi_tool", "A selected Pi tool needs a verified managed equivalent.", `configuration/tools/${name}`);
    else for (const capability of PI_TOOLS[name]!) capabilities.add(capability);
  }
  result.configuration.permissions = { tools: [...selected].sort(), project_trust: trusted === true ? "trusted" : "none" };
  if (mcpEnabled) {
    const servers: RecordValue = Object.assign(Object.create(null), object((await config(join(agentDir, "mcp.json"))).mcpServers));
    if (trusted === true) for (const [name, raw] of Object.entries(object((await config(join(projectDir, "mcp.json"))).mcpServers))) {
      const value = object(raw);
      servers[name] = !value.command && !value.url && !value.type ? { ...object(servers[name]), ...value } : value;
    }
    const active: RecordValue = Object.create(null);
    for (const [name, raw] of Object.entries(servers)) {
      const value = object(raw);
      if (value.enabled === false) continue;
      // Exposure changes affect the available calling interface and cannot be silently discarded.
      if (value.exposure !== undefined || value.toolExposure !== undefined || value.oauth !== undefined || value.description !== undefined)
        block("tool_configuration", "This Pi MCP exposure, OAuth or instruction setting needs a verified destination equivalent.", `tools/${name}`);
      const { enabled: _enabled, ...definition } = value;
      active[name] = definition;
    }
    await tools(active, "tools");
    for (const tool of result.configuration.tools) { tool.selection = { dialect: "exact", allow: null, deny: [] }; tool.resources = ["list", "templates", "read"]; }
    if (result.configuration.tools.length) capabilities.add("mcp_resources");
  }
  const complete = !result.blockers.some(item => ["pi_tool", "native_version"].includes(item.code));
  result.configuration.native_tools = { version: target.version, complete, source: "versioned-runtime", capabilities: [...capabilities].sort(), disabled: SOURCE_NATIVE_CAPABILITIES.filter(name => !capabilities.has(name)) };
  return [...new Set([join(agentDir, "skills"), join(home, ".agents", "skills"), ...(trusted === true ? [join(projectDir, "skills"), ...projectSkills] : [])])].map(path => resolve(path));
}
