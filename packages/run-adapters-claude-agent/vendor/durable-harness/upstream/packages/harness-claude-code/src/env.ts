/**
 * The durable environment of the `claude` CLI in the session's VM
 * (docs/workspaces.md §5.6 "Env"). It replaces the parent's environment
 * entirely: the relay builds the child's environment from this alone (`env -i`
 * after the privilege drop), and nothing of the Function's environment is in
 * it (not its `PATH`, not a secret). A parent Claude Code session alone passes
 * about 50 `CLAUDE_*`, `ANTHROPIC_*` and `MCP_*` variables that change the
 * CLI's behavior; none reaches the child unless it is listed here.
 */

/** The `PATH` of the CLI and its commands in the VM: the image's, never the Function's. */
export const VM_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Claude Code's default Bash timeout. */
const BASH_DEFAULT_MS = 120_000;

/** The projects key both sides use (`CLAUDE_CODE_PROJECT_DIR_NAME`): the CLI's transcript is `projects/session/<id>.jsonl` wherever its cwd is. */
export const PROJECT_DIR_NAME = 'session';

export interface DurableEnvOptions {
  /** The session's HOME in the VM (`SessionMachine.dirs.home`). */
  home: string;
  /** The CLI's config dir in the VM (`dirs.config`: its transcript, settings, caches). */
  configDir: string;
  /** TMPDIR in the VM (`dirs.tmp`). */
  tmpDir: string;
  /** The XDG cache in the VM (`dirs.cache`). */
  cacheDir: string;
  /** Where the CLI sends model requests: the VM's model port (`SessionMachine.modelUrl`). */
  baseUrl: string;
  /**
   * The key the CLI sends (`ANTHROPIC_AUTH_TOKEN`, so `authorization: Bearer
   * <key>`): the attach's model key (`SessionMachine.modelKey`). The relay
   * admits a model request only with it, from the CLI's own process.
   */
  token: string;
  /** The model, as the CLI's main and alias models. */
  model: string;
  /** The model for the CLI's small background calls (titles, summaries). Default `model`. */
  smallModel?: string;
  /** The longest a Bash command may run (`BASH_MAX_TIMEOUT_MS`, and its default): `sandbox({ commandTimeoutMs })`. */
  bashTimeoutMs?: number;
  /**
   * The app's own variables (`sandbox({ env })`, checked there and again at
   * spawn): added under everything above, so none can replace the model
   * port, its key, the paths or the durability flags.
   */
  extra?: Readonly<Record<string, string>>;
}

/**
 * - `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR` and the XDG dirs in the session's
 *   cache dirs, which the relay wipes before every spawn (`/var/lib/dh/s`);
 * - the projects key fixed (`CLAUDE_CODE_PROJECT_DIR_NAME`), so a transcript
 *   resumes on any VM, whatever the cwd;
 * - the model through the VM's model port, with the attach's key; the
 *   credential is added in the Function, never here;
 * - no updater, telemetry, error reporting or other nonessential traffic;
 * - the CLI state the transcript mirror does not carry turned off: auto-memory,
 *   background tasks, cron, workflows, file checkpoints;
 * - no git of the CLI's own in `/workspace` (`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`):
 *   for the system prompt's git context the CLI runs `git status` there
 *   itself, outside Claude's sandbox, as the CLI's user, and git runs what
 *   the repo's config names (a clean filter, a textconv): a `.git/config`
 *   the model planted on the Drive would run with the CLI's environment
 *   (its model key) and the CLI's view of the VM (docs/workspaces.md §6).
 *   It also drops the commit and PR instructions from the prompt.
 */
export function durableEnv(options: DurableEnvOptions): Record<string, string> {
  const { home, model } = options;
  const small = options.smallModel ?? model;
  const env: Record<string, string> = { ...(options.extra ?? {}) };
  Object.assign(env, {
    PATH: VM_PATH,
    HOME: home,
    TMPDIR: options.tmpDir,
    CLAUDE_CONFIG_DIR: options.configDir,
    CLAUDE_CODE_PROJECT_DIR_NAME: PROJECT_DIR_NAME,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: options.cacheDir,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.token,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'harness-world-claude-code',
  });
  if (options.bashTimeoutMs !== undefined) {
    const max = Math.max(1_000, Math.floor(options.bashTimeoutMs));
    env.BASH_MAX_TIMEOUT_MS = String(max);
    // The CLI's own default (2 min), unless the cap is lower.
    env.BASH_DEFAULT_TIMEOUT_MS = String(Math.min(BASH_DEFAULT_MS, max));
  }
  return env;
}

/**
 * A Gateway model id (`anthropic/claude-sonnet-4.5`) as the native id the
 * CLI knows (`claude-sonnet-4-5`). The Gateway accepts both; with a Gateway
 * id the CLI logs `unrecognized_model` and does not know the model's limits.
 * Ids that are not Anthropic Gateway ids come back unchanged.
 */
export function nativeModelId(model: string): string {
  const m = /^anthropic\/(claude-[a-z]+-[0-9.]+)$/.exec(model);
  return m ? m[1]!.replace(/\./g, '-') : model;
}
