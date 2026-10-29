// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-codex/src/config.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: the provider is AgentRun's model proxy; code mode's host on, with no sub-agents (`agents.max_depth = 0`, and `agents` reserved); message prefixes; comments.
/**
 * The `config.toml` a session's `CODEX_HOME` gets: the model and its
 * provider (the session's model proxy), and Codex's built-in tools and side
 * features turned off.
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

/**
 * Codex features turned off (`codex features list`). With these off, a
 * classic model is offered only the harness's dynamic tools and
 * `request_user_input` (which Codex itself answers "unavailable in Default
 * mode"): no shell, no `apply_patch`, no images, no web, no sub-agents. A
 * code-mode model (luna) is offered code mode's `exec` and `wait`; see
 * `code_mode_host`. The rest are side features that would download plugins,
 * call chatgpt.com or start a daemon.
 */
export const BUILTINS_OFF: Record<string, boolean> = {
  shell_tool: false,
  unified_exec: false,
  view_image: false,
  image_generation: false,
  multi_agent: false,
  goals: false,
  sleep_tool: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  in_app_browser: false,
  // Code mode's JavaScript runtime (no Node, no file system, no network): the only way a code-mode model such as luna
  // calls a tool. Its nested tools are the dynamic tools plus Codex's own apply_patch and MCP resource readers, which
  // run nothing here (read-only, approvals declined, no MCP server); its sub-agent tools are removed by agents.max_depth.
  code_mode_host: true,
  tool_suggest: false,
  skill_search: false,
  skill_mcp_dependency_install: false,
  tool_call_mcp_elicitation: false,
  realtime_conversation: false,
  workspace_dependencies: false,
  worktrees: false,
  hooks: false,
  plugins: false,
  remote_plugin: false,
  apps: false,
  shell_snapshot: false,
  daemon_auto_start: false,
  // A shell or sub-command path Codex would approve per sub-command (an `approvalId` the drive declines), and the git undo snapshots app-server took itself (outside bwrap): off, though 0.160 has these off or removed already.
  shell_zsh_fork: false,
  unified_exec_zsh_fork: false,
  undo: false,
};

/**
 * The features on top of `BUILTINS_OFF` with the built-ins on: the shell
 * (unified exec: `exec_command`, `write_stdin`; `apply_patch` runs through
 * it) and `view_image`. Sub-agents, goals, images, the browser and plugins
 * stay off: their state is not in the rollout, or they reach outside.
 */
export const BUILTINS_ON: Record<string, boolean> = {
  ...BUILTINS_OFF,
  shell_tool: true,
  unified_exec: true,
  view_image: true,
};

export interface CodexConfigOptions {
  model: string;
  /** The Responses API base URL (`…/v1`): the VM's model port, relayed to the driver's gateway handler. */
  baseUrl: string;
  /** The env var holding the provider key (a placeholder: the driver adds the credential). */
  envKey: string;
  /** Gateway model ids are unknown to Codex, so its context window must be given. */
  contextWindow: number;
  /**
   * The thread's working directory (`/workspace`): marked untrusted, so a
   * project config the model plants there (`.codex/config.toml`, a trust
   * entry) is never loaded.
   */
  cwd?: string;
  /**
   * `sandbox({ env })`: set for the model's commands too
   * (`shell_environment_policy.set`; `inherit = "core"` passes them nothing
   * else), less any name the policy excludes.
   */
  commandEnv?: Readonly<Record<string, string>>;
  /** Merged over the generated config, last. */
  extra?: Record<string, TomlValue>;
}

/**
 * What a command Codex runs inherits: the core variables only (`HOME`,
 * `LOGNAME`, `PATH`, `SHELL`, `USER`, `USERNAME`, `TMPDIR`, `TEMP`, `TMP`),
 * plus `sandbox({ env })` (`set`, `codexConfig`), and never one named like
 * the harness's own (`HARNESS_*`, the provider key's placeholder among them)
 * or a token. Codex 0.160 otherwise passes its whole environment on
 * (docs/workspaces.md §5.6).
 */
export const SHELL_ENVIRONMENT_POLICY: Readonly<{ inherit: 'core'; exclude: readonly string[] }> = Object.freeze({ inherit: 'core', exclude: Object.freeze(['HARNESS_*', '*TOKEN*']) });

/** Whether `name` matches one of the policy's `exclude` patterns (`*` globs, case-insensitive, as Codex matches them). */
export function excludedName(name: string): boolean {
  return SHELL_ENVIRONMENT_POLICY.exclude.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 'i').test(name));
}

export function codexConfig(options: CodexConfigOptions): Record<string, TomlValue> {
  const commandEnv = options.commandEnv ? Object.fromEntries(Object.entries(options.commandEnv).filter(([k]) => !excludedName(k))) : undefined;
  const base: Record<string, TomlValue> = {
    model: options.model,
    model_provider: 'gateway',
    model_context_window: options.contextWindow,
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    check_for_update_on_startup: false,
    shell_environment_policy: {
      inherit: SHELL_ENVIRONMENT_POLICY.inherit,
      exclude: [...SHELL_ENVIRONMENT_POLICY.exclude],
      ...(commandEnv && Object.keys(commandEnv).length ? { set: commandEnv } : {}),
    },
    model_providers: {
      gateway: {
        name: 'AgentRun model proxy',
        base_url: options.baseUrl,
        env_key: options.envKey,
        wire_api: 'responses',
        supports_websockets: false,
      },
    },
    ...(options.cwd ? { projects: { [options.cwd]: { trust_level: 'untrusted' } } } : {}),
    features: { ...BUILTINS_OFF },
    analytics: { enabled: false },
    // No sub-agents: with code mode's host on, `multi_agent = false` alone still leaves its multi_agent_v1 tools.
    agents: { max_depth: 0 },
  };
  return merge(base, options.extra ?? {});
}

/**
 * `config` keys the harness sets itself and an app may not (docs/workspaces.md
 * §3.3): the sandbox and approvals (which bwrap and the log's barrier rest
 * on), the commands' environment, the provider and its key (the model port),
 * trust and project config, MCP servers and notifications (they reach outside
 * the log), the features (the built-ins' switch: `builtins`), web search, and
 * the model (`model`). Also what would swap the binary or shell that does the
 * sandboxing, send traffic outside the log (`otel`, `chatgpt_base_url`), grant
 * permission profiles, keep history or snapshots outside the rollout, or read
 * a file the app names (`RESERVED_CONFIG_SUFFIXES`).
 */
export const RESERVED_CONFIG_KEYS: readonly string[] = Object.freeze([
  'model',
  'model_provider',
  'model_providers',
  'base_url',
  'env_key',
  'sandbox_mode',
  'sandbox_workspace_write',
  'approval_policy',
  'shell_environment_policy',
  'projects',
  'profile',
  'profiles',
  'mcp_servers',
  'notify',
  'features',
  'web_search',
  'tools.web_search',
  'default_permissions',
  'permissions',
  'ghost_snapshot',
  'otel',
  'chatgpt_base_url',
  'history',
  'project_root_markers',
  'allow_symlinked_codex_home',
  'agents',
]);

/** Key suffixes reserved at any depth: a binary, a file or a directory Codex would use (`codex_linux_sandbox_exe`, `zsh_path`, `model_instructions_file`, `experimental_compact_prompt_file`, `sqlite_home`, `log_dir`, ...). */
export const RESERVED_CONFIG_SUFFIXES: readonly string[] = Object.freeze(['_exe', '_path', '_file', '_home', '_dir']);

/** Throw a `TypeError` naming the first key of `config` the harness reserves (a dotted key is a nested table's: `tools.web_search`). */
export function checkConfig(config: Record<string, TomlValue> | undefined): void {
  if (config === undefined) return;
  if (!isTable(config)) throw new TypeError('agentrun-harness-codex: config must be an object of config.toml settings');
  const check = (table: Record<string, TomlValue>, prefix: string) => {
    for (const [k, v] of Object.entries(table)) {
      const path = `${prefix}${k}`;
      // A dotted key in one string (`"tools.web_search"`) is the same setting as the nested one.
      const last = path.slice(path.lastIndexOf('.') + 1);
      if (RESERVED_CONFIG_KEYS.includes(path) || RESERVED_CONFIG_KEYS.some((r) => path.startsWith(`${r}.`)) || RESERVED_CONFIG_SUFFIXES.some((x) => last.endsWith(x))) {
        throw new TypeError(`agentrun-harness-codex: config.${path} is set by the harness (docs/workspaces.md §3.3: ${RESERVED_CONFIG_KEYS.join(', ')} and any key ending ${RESERVED_CONFIG_SUFFIXES.join(', ')} are reserved)`);
      }
      if (isTable(v)) check(v, `${path}.`);
    }
  };
  check(config, '');
}

function merge(a: Record<string, TomlValue>, b: Record<string, TomlValue>): Record<string, TomlValue> {
  const out: Record<string, TomlValue> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isTable(prev) && isTable(v) ? merge(prev, v) : v;
  }
  return out;
}

const isTable = (v: TomlValue | undefined): v is Record<string, TomlValue> => !!v && typeof v === 'object' && !Array.isArray(v);

/** TOML text for a config object: plain values first, then one `[table]` per nested object. */
export function toToml(config: Record<string, TomlValue>, prefix: string[] = []): string {
  const plain: string[] = [];
  const tables: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (isTable(v)) tables.push(toToml(v, [...prefix, k]));
    else plain.push(`${key(k)} = ${value(v)}`);
  }
  const head = prefix.length && plain.length ? `[${prefix.map(key).join('.')}]\n` : '';
  return [plain.length ? `${head}${plain.join('\n')}\n` : '', ...tables].filter(Boolean).join('\n');
}

const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function value(v: TomlValue): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`agentrun-harness-codex: not a TOML number: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(value).join(', ')}]`;
  return `{ ${Object.entries(v)
    .map(([k, x]) => `${key(k)} = ${value(x)}`)
    .join(', ')} }`;
}
