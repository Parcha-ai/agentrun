// The Claude Agent SDK as an AgentRun harness adapter (id `claude-agent`). Written for AgentRun.
//
// A session is the copied Claude Agent harness (harness.ts) driven over the session's own records: the kernel's
// openDrive on the writer the runner lends (`io.writer`), on a local machine (host/machine.ts). The CLI's built-in tools
// are off, so the host's tools, exactly those `spec.tools` names, are its only tools: each runs through the shared tool
// bridge as a kernel effect, and a PreToolUse hook denies every other call. Its model is the session's loopback proxy
// (@parcha/agentrun-kernel/host, with the Anthropic policy in host/policy.ts): every paid request passes the runner's
// `beforeRequest` first, and its usage comes back through `afterRequest`. The runner alone accounts model spend.
//
// The Agent SDK is the host's: an exact optional peer dependency (`CLAUDE_AGENT_SDK_VERSION`), never shipped here.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { READ_SKILL_FILE, readSkillFileTool, skillProblems, type AdapterSession, type AgentAdapter, type HostSkill, type HostTool, type SessionIO, type SessionSpec, type ToolImage, type TurnStatus } from "@parcha/agentrun-kernel";
import { abortedOutcome, openDrive, pendingSubmissions, Restart, SessionHalt, type Drive, type HostTool as KernelTool } from "@parcha/agentrun-kernel/kernel";
import { toolSchemaProblems } from "@parcha/agentrun-kernel";
import { NativeJournal, recoveryNote, settleTurn, transcriptOf } from "@parcha/agentrun-kernel/process";
import { checkedOnce, hostHeaderProblems, type ModelProxyOptions, sha256OfFile, startModelProxy } from "@parcha/agentrun-kernel/host";
import { anthropicPolicy, withWebSearches } from "./host/policy.js";
import { findClaudeExecutable, platformSuffix } from "./binary.js";
import { CLAUDE_AGENT_PACKAGE, ClaudeAgentNotInstalled, ClaudeAgentPinMismatch, ClaudeAgentThinkingOff } from "./errors.js";
import { type ClaudeAgentSdk, claudeCodeHarness, lostPrompts } from "./harness.js";
import { JournalSessionStore } from "./store.js";
import { CLAUDE_MCP_CLIENT, type ConfineChild, localMachine } from "./host/machine.js";
import { serialWriter } from "./serial.js";
import { MCP_SERVER } from "./transcript.js";
import type { ToolServerModules } from "./host/tool-server.js";
import { CLAUDE_AGENT_SDK_INSTALL, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, installedVersion } from "./versions.js";
export { CLAUDE_AGENT_CLI_SKILL_NAMES } from "./cli-names.js";

/** The pinned CLI's tools the copied harness leaves undecided, off by name in every session (WebSearch unless `webSearch`). */
export const CLAUDE_AGENT_ALSO_OFF: readonly string[] = Object.freeze(["Skill", "WebSearch"]);

/** The local plugin the session's skills are served from: the model sees each as `agentrun:<name>`, and may load it by
 *  that name or, unless the CLI has a command or skill of that name (`CLAUDE_AGENT_CLI_SKILL_NAMES`), by its bare one. */
export const CLAUDE_AGENT_SKILLS_PLUGIN = "agentrun";

/** A skill the model may load (the Skill tool): its name, and its files by path, `SKILL.md` among them. The shape every
 *  adapter takes a host's skills in (`HostSkill`, from @parcha/agentrun-kernel). */
export interface ClaudeAgentSkill extends HostSkill {}

/** The skills, checked: each a name, a `SKILL.md` whose front matter has that name and a description, and files at plain
 *  relative paths, 1 MiB in all; or the problems. @parcha/agentrun-kernel' own check, which the Codex adapter runs too. */
export { skillProblems };

/** Writes the skills as the local plugin at `dir` (replacing what was there), and returns their plugin-qualified names. */
function writeSkillsPlugin(dir: string, skills: readonly ClaudeAgentSkill[]): string[] {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: CLAUDE_AGENT_SKILLS_PLUGIN, version: "0.0.0", description: "The host's skills for this session." }), { mode: 0o600 });
  for (const skill of skills) {
    for (const [path, text] of Object.entries(skill.files)) {
      const file = join(dir, "skills", skill.name, path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
    }
  }
  return skills.map((skill) => `${CLAUDE_AGENT_SKILLS_PLUGIN}:${skill.name}`);
}

/** The adapter's id, as a host's `harness` field names it. */
export const CLAUDE_AGENT_ID = "claude-agent";

/** The pinned CLI's sha256, per platform package, where it is recorded; any other platform is checked by its version. */
export const CLAUDE_AGENT_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  "linux-x64": "fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f",
});

/** A tool name the Agent SDK's in-process MCP server takes (the CLI calls it `mcp__hands__<name>`). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** How often one send rebuilds a drive whose CLI exited mid-turn. */
const RESTARTS = 3;

export interface ClaudeAgentProvider {
  /** The provider's origin (`https://api.anthropic.com`): the proxy forwards to its `/v1/messages` only. */
  origin: string;
  /** The provider key, read per request in this process. It never reaches the CLI. */
  credential: () => Promise<string> | string;
  /** How the provider takes it: Anthropic's API takes `x-api-key` (default); a gateway may take a bearer token. */
  auth?: "x-api-key" | "bearer";
  /** Headers sent with every model request, the CLI's small-model calls included (a gateway's spend tags:
   *  `{ "x-litellm-tags": "job:...,run:..." }`). The CLI can neither set nor override them. Send a gateway's only to it. */
  headers?: Readonly<Record<string, string>>;
}

export interface ClaudeAgentAdapterOptions {
  /** The provider's model id, or one per tier (`default` when a node names none). */
  model: string | { default: string; fast?: string; strong?: string };
  /** The model of the CLI's small background calls. Default: the session's model. */
  smallModel?: string;
  provider: ClaudeAgentProvider;
  /** Start the CLI under the host's confinement (its own `confine()`, a `setpriv --no-new-privs` prefix, say). It may
   *  only add in front of the pinned binary and its arguments, and never touches its environment. */
  confine?: ConfineChild;
  /** The price of a response; null (or no function) records its cost as unknown. */
  price?: ModelProxyOptions["price"];
  /** The most output tokens one request may ask for. Default 128 000, what the pinned CLI asks for on current models. */
  maxOutputTokens?: number;
  /** The most one image a tool answers with may be, as base64 (default 5 MB, `CLAUDE_AGENT_MAX_IMAGE_BYTES`; at most
   *  10 MB, Anthropic's API's own limit). A larger one is the call's error. */
  maxImageBytes?: number;
  /** Where sessions keep their private directories when the host lends none (`io.dir`): one per session key. */
  sessionsDir?: string;
  /** The host's skills, which the model may load with the Skill tool (as `agentrun:<name>` or by the bare name), and no
   *  others: never the CLI's bundled ones or any in a home directory. Written into each session's private directory.
   *  Default none. */
  skills?: readonly ClaudeAgentSkill[];
  /** Claude's own WebSearch, and nothing else of the CLI's: the model may call it, and the CLI runs each call as a request
   *  of its own through the session's model proxy with Anthropic's web search server tool, the one hosted tool that proxy
   *  then admits. Each search the provider reports is booked at `CLAUDE_WEB_SEARCH_USD` on top of `price`, into the
   *  session's cost and so its spend cap. WebFetch stays off (it would fetch from the CLI's own process). Default off. */
  webSearch?: boolean;
  /** With `webSearch`: the input tokens a search request may read in beyond its body, added to its input bound, so a cap
   *  can hold it (`inputTokensMax`). Absent, a search request has no input bound. */
  webSearchAllowance?: number;
  /** Diagnostics. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * The Agent SDK module, loaded by the host (from where its runtime installed it). Default: imported by name. Either
   * way it must be the pinned release (`CLAUDE_AGENT_SDK_VERSION`): the CLI it starts says its version, and a
   * different one is refused before the CLI starts.
   */
  sdk?: ClaudeAgentSdk;
  /** The injected module's version, as its package.json says: checked when the adapter is made. */
  sdkVersion?: string;
  /** The MCP library the session's tools are served with (`@modelcontextprotocol/sdk`'s `server/mcp.js` and
   *  `types.js`), loaded by the host from where it installed the SDK, its peer. Default: imported by name, beside this
   *  package. */
  mcp?: ToolServerModules;
  /** The CLI to run (the SDK's platform package's `claude`). Default: found beside the SDK. Its sha256 and version are
   *  checked against the pins when the adapter is made. */
  cliPath?: string;
  /** For tests only (AGENTRUN_CLAUDE_AGENT_STANDIN=1 under a test runner): a scripted SDK's stand-in CLI, which no
   *  pin is checked against. */
  standIn?: { command: string };
  /** How hard the model thinks when a node names no level (its `thinking`, else its `effort`). Default medium; it is
   *  never off. */
  thinking?: ClaudeAgentThinking;
  /** For tests: the fetch the model proxy forwards with. */
  fetch?: typeof fetch;
}

/** The thinking levels a session runs at: the SDK's effort levels, with adaptive thinking. There is no off. */
export type ClaudeAgentThinking = "low" | "medium" | "high" | "xhigh" | "max";
const THINKING: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** A session's level: the node's thinking, else its effort (minimal thinks at low, never at nothing), else the adapter's. */
export function thinkingOf(spec: Pick<SessionSpec, "thinking" | "effort">, fallback: ClaudeAgentThinking): ClaudeAgentThinking {
  const asked = (spec.thinking ?? spec.effort) as string | undefined;
  if (asked === "minimal") return "low";
  return asked && THINKING.has(asked) ? (asked as ClaudeAgentThinking) : fallback;
}

/**
 * The SDK that is handed no message once the drive is stopped: its prompt stream ends instead, so no turn starts after a
 * stop. Whether a placed message reached the CLI is the CLI's own record, not this hand-over: the SDK writes a message to
 * the CLI's stdin at once, and a stop can kill the CLI before it reads it (settleOpenTurn reads the transcript).
 */
export function withStopEndingPrompts(sdk: ClaudeAgentSdk, signal: () => AbortSignal): ClaudeAgentSdk {
  const until = async function* <T>(prompt: AsyncIterable<T>) {
    for await (const message of prompt) {
      if (signal().aborted) return;
      yield message;
    }
  };
  return {
    ...sdk,
    query: ((args: Parameters<ClaudeAgentSdk["query"]>[0]) => sdk.query({ ...args, prompt: (typeof args.prompt === "string" ? args.prompt : until(args.prompt as AsyncIterable<unknown>)) as typeof args.prompt })) as ClaudeAgentSdk["query"],
  };
}

/** The SDK with every query thinking at `level`: adaptive thinking, at that effort. */
function thinkingAt(sdk: ClaudeAgentSdk, level: ClaudeAgentThinking): ClaudeAgentSdk {
  return {
    ...sdk,
    query: ((args: Parameters<ClaudeAgentSdk["query"]>[0]) => sdk.query({ ...args, options: { ...args.options, thinking: { type: "adaptive" }, effort: level } })) as ClaudeAgentSdk["query"],
  };
}

/** The pins a CLI is checked against: its sha256 on this platform (where one is recorded) and its version. */
export function claudeAgentCliPins(): { sha256?: string; version: string } {
  const sha256 = CLAUDE_AGENT_DIGESTS[platformSuffix()];
  return sha256 ? { sha256, version: CLAUDE_CODE_VERSION } : { version: CLAUDE_CODE_VERSION };
}

/** The CLI at `path`, checked against the pins: its path, or the typed reason it is not the pinned build. Its sha256 is
 *  read a chunk at a time, never the whole CLI in memory, and a check that passed holds for this process while the CLI
 *  stays the same file, unchanged (the kernel's checkedOnce): a host that checks it for each model it resolves, and a
 *  run's process that makes its adapter, check it once. */
export function verifyClaudeAgentCli(path: string | undefined, pins = claudeAgentCliPins()): { path: string } | ClaudeAgentPinMismatch | ClaudeAgentNotInstalled {
  if (!path) return new ClaudeAgentNotInstalled(`no CLI of @anthropic-ai/claude-agent-sdk ${CLAUDE_AGENT_SDK_VERSION} for ${platformSuffix()} (its platform package, an optional dependency npm installs with it), and no cliPath`, CLAUDE_AGENT_SDK_INSTALL);
  // Hashed a chunk at a time, and once per CLI in this process while it stays the same file (the kernel's pinned-binary).
  return checkedOnce(path, JSON.stringify(pins), () => checkCli(path, pins), (result) => !(result instanceof Error));
}

/** The CLI at `path` against `pins`' sha256 and version. */
function checkCli(path: string, pins: { sha256?: string; version: string }): { path: string } | ClaudeAgentPinMismatch | ClaudeAgentNotInstalled {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.R_OK);
  } catch {
    return new ClaudeAgentNotInstalled(`no CLI at ${path}`);
  }
  if (pins.sha256) {
    let found: string;
    try {
      found = sha256OfFile(path);
    } catch {
      return new ClaudeAgentNotInstalled(`no CLI at ${path}`);
    }
    if (found !== pins.sha256) return new ClaudeAgentPinMismatch("cli_sha256", pins.sha256, found, path);
  }
  let version: string;
  try {
    version = execFileSync(path, ["--version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISABLE_AUTOUPDATER: "1" }, encoding: "utf8", timeout: 15_000 }).trim().split(/\s/)[0] ?? "";
  } catch (error) {
    return new ClaudeAgentPinMismatch("cli_version", pins.version, `unreadable (${String((error as Error)?.message ?? error).slice(0, 120)})`, path);
  }
  if (version !== pins.version) return new ClaudeAgentPinMismatch("cli_version", pins.version, version.slice(0, 40), path);
  return { path };
}

/** What the adapter runs with, or the typed reason it cannot: the SDK (injected or installed) and its CLI, each the
 *  pinned build. `installed` looks a package's version up (default: where Node would import it from here). */
export function verifyClaudeAgent(options: Pick<ClaudeAgentAdapterOptions, "sdk" | "sdkVersion" | "cliPath" | "mcp">, installed: (name: string) => string | undefined = installedVersion): { cliPath: string } {
  const sdkVersion = options.sdk ? options.sdkVersion : installed("@anthropic-ai/claude-agent-sdk");
  if (!options.sdk && sdkVersion === undefined) throw new ClaudeAgentNotInstalled(`@anthropic-ai/claude-agent-sdk ${CLAUDE_AGENT_SDK_VERSION} is not installed beside ${CLAUDE_AGENT_PACKAGE}, and no module was given (sdk)`, CLAUDE_AGENT_SDK_INSTALL);
  if (sdkVersion !== undefined && sdkVersion !== CLAUDE_AGENT_SDK_VERSION) throw new ClaudeAgentPinMismatch("sdk_version", CLAUDE_AGENT_SDK_VERSION, sdkVersion);
  // The session's tools are served by an MCP server built here (host/tool-server.ts), whichever SDK runs: an injected
  // SDK does not bring the MCP library, so a missing one is refused now, not at the first turn.
  if (!options.mcp && installed("@modelcontextprotocol/sdk") === undefined) throw new ClaudeAgentNotInstalled(`@modelcontextprotocol/sdk is not installed beside ${CLAUDE_AGENT_PACKAGE} (the Agent SDK's peer, which serves the session's tools; npm installs it with the SDK)`, CLAUDE_AGENT_SDK_INSTALL);
  const cli = verifyClaudeAgentCli(options.cliPath ?? findClaudeExecutable());
  if (cli instanceof Error) throw cli;
  return { cliPath: cli.path };
}

/** A stand-in CLI is for a test runner only. */
const standInAllowed = () => process.env.AGENTRUN_CLAUDE_AGENT_STANDIN === "1" && Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test") && process.env.NODE_ENV !== "production";

/** The kernel's tool for a host tool: the same name, schema and replay policy, reported to the host under that name. */
/** The most a tool's image may be, as base64, by default: the strictest of the platforms Claude runs on (Anthropic's API
 *  takes 10 MB, Amazon Bedrock 5 MB), so one setting holds everywhere. */
export const CLAUDE_AGENT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The most `maxImageBytes` may be: Anthropic's API's own limit for one image, as base64. */
const MAX_IMAGE_BYTES_CEILING = 10 * 1024 * 1024;
/** The image types Anthropic's API takes. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Why a tool's images can't be sent, naming the tool and the image, or undefined: a type the API takes, base64, and at
 *  most `maxBytes` of it. */
export function toolImageProblems(tool: string, images: readonly ToolImage[], maxBytes = CLAUDE_AGENT_MAX_IMAGE_BYTES): string | undefined {
  for (const [i, image] of images.entries()) {
    const at = `the tool ${tool}'s image ${i + 1}`;
    if (!IMAGE_TYPES.has(image?.mimeType)) return `${at} is ${String(image?.mimeType).slice(0, 40)}, not one the model takes (${[...IMAGE_TYPES].join(", ")})`;
    if (typeof image.data !== "string" || !BASE64.test(image.data)) return `${at} is not base64`;
    if (image.data.length > maxBytes) return `${at} is ${image.data.length} bytes of base64, more than ${maxBytes}`;
  }
  return undefined;
}

/** A session's calls in flight: begun (their intent recorded), their outcome not yet. A pause waits for these to have
 *  their outcomes recorded; the host refuses new work meanwhile (the runner's stop does). */
class CallsInFlight {
  draining = false;
  private readonly open = new Set<string>();
  private readonly waiters = new Set<() => void>();
  begin(callId: string) {
    this.open.add(callId);
  }
  /** The call's outcome is recorded, or it never will be (the drive stopped). */
  end(callId: string) {
    if (this.open.delete(callId) && this.open.size === 0) for (const done of [...this.waiters]) done();
  }
  clear() {
    this.open.clear();
    for (const done of [...this.waiters]) done();
  }
  /** Every call in flight has its outcome recorded, or `ms` passed. */
  idle(ms: number): Promise<void> {
    if (this.open.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

/** The kernel's tool for a host tool. The host hears of the call (`tool_start`) once its intent is in the session's
 *  records, and of its end only once the outcome is (the live `tool_end` the tool bridge sends after the effect). */
function kernelTool(tool: HostTool, io: SessionIO, maxImageBytes: number, calls: CallsInFlight): KernelTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    replay: tool.replay,
    async execute(input, effect) {
      // The effect's step is `tool:<the CLI's tool_use id>#<attempt>`: the host sees the CLI's call id.
      const callId = (effect.stepId ?? "").replace(/^tool:/, "").replace(/#\d+$/, "");
      // The step's attempt: above 0 when a crash cut an earlier attempt and the kernel runs the call again.
      const attempt = Number(/#(\d+)$/.exec(effect.stepId ?? "")?.[1] ?? 0);
      // In flight, and past the pause's check, before the host hears of it: a pause the host starts on this tool_start
      // waits for this call rather than refusing it.
      calls.begin(callId);
      // A guard: a call begun during a pause is not run; the bridge's per-drive mutex keeps it unreachable while calls are serial, and its test lands with the fan-out PR.
      if (calls.draining) throw new Error(`${tool.name} was not run: the session is pausing`);
      io.onEvent({ type: "tool_start", callId, name: tool.name, args: input });
      const result = await tool.call(input, { callId, signal: effect.signal, attempt });
      if (result.isError) throw new Error(result.text);
      if (!result.images?.length) return result.text;
      // An image the model can't be sent is the call's error, by the tool's name and the image, not a request refused later.
      const wrong = toolImageProblems(tool.name, result.images, maxImageBytes);
      if (wrong) throw new Error(wrong);
      return { text: result.text, images: result.images.map((image) => ({ mimeType: image.mimeType, data: image.data })) };
    },
  };
}

const turnsIn = (drive: Drive) => transcriptOf(drive.state()).filter((r) => r.data?.type === "turn");

/** Root keywords the pinned CLI (2.1.286) drops a tool for, with no word to the model or the host: measured, a root
 *  `{ "type": "object", "anyOf": [...] }` (or allOf, oneOf) never reaches the model while the session's other tools do. */
const CLI_DROPS_ROOT = ["anyOf", "allOf", "oneOf"] as const;

/** What the Claude path refuses in a tool's input schema beyond `toolSchemaProblems`, measured on the pinned CLI and
 *  Anthropic's API (tuple `items`, the one shape the API rejects, is already invalid 2020-12). */
function claudeSchemaProblems(tool: string, schema: Record<string, unknown>): string[] {
  return CLI_DROPS_ROOT.filter((key) => key in schema).map((key) => `${tool}: /${key}: the Claude Agent CLI drops a tool whose root has ${key}; put the alternatives under a property`);
}

export function claudeAgentAdapter(options: ClaudeAgentAdapterOptions): AgentAdapter {
  const thinking = options.thinking ?? "medium";
  if (!THINKING.has(thinking)) throw new ClaudeAgentThinkingOff(thinking);
  const maxImageBytes = options.maxImageBytes ?? CLAUDE_AGENT_MAX_IMAGE_BYTES;
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > MAX_IMAGE_BYTES_CEILING) throw new Error(`agentrun-harness-claude: maxImageBytes must be a whole number of bytes from 1 to ${MAX_IMAGE_BYTES_CEILING}`);
  const skills = options.skills ?? [];
  const webSearch = options.webSearch === true;
  const skillsWrong = skillProblems(skills);
  if (skillsWrong.length) throw new Error(`agentrun-harness-claude: ${skillsWrong.join("; ")}`);
  const headersWrong = hostHeaderProblems(options.provider.headers);
  if (headersWrong.length) throw new Error(`agentrun-harness-claude: provider.headers: ${headersWrong.join("; ")}`);
  // The SDK and its CLI are checked once, here: a mismatch is the host's to report, before any run starts.
  let executable: string;
  if (options.standIn) {
    if (!standInAllowed()) throw new Error("agentrun-harness-claude: a stand-in CLI is for tests only (AGENTRUN_CLAUDE_AGENT_STANDIN=1 under a test runner)");
    if (!options.sdk) throw new Error("agentrun-harness-claude: a stand-in CLI needs a scripted SDK (sdk)");
    executable = options.standIn.command;
  } else {
    executable = verifyClaudeAgent(options).cliPath;
  }
  const modelFor = (spec: SessionSpec): string => {
    if (typeof options.model === "string") return options.model;
    return (spec.tier && spec.tier !== "default" ? options.model[spec.tier] : undefined) ?? options.model.default;
  };

  return {
    id: CLAUDE_AGENT_ID,
    version: CLAUDE_AGENT_SDK_VERSION,
    capabilities: () => ({ fork: false, mcpClient: CLAUDE_MCP_CLIENT }),
    check(spec) {
      const problems: string[] = [];
      if (spec.context === "fork") problems.push("Claude Agent sessions cannot fork another session's transcript; declare context: \"fresh\"");
      const seen = new Set<string>();
      for (const tool of spec.tools) {
        if (!TOOL_NAME.test(tool.name)) problems.push(`the tool name ${JSON.stringify(tool.name.slice(0, 80))} is not one the Claude Agent SDK takes (letters, digits, _ and -, at most 64)`);
        if (seen.has(tool.name)) problems.push(`the tool ${tool.name} is given twice`);
        if (skills.length && tool.name === READ_SKILL_FILE) problems.push(`the tool name ${READ_SKILL_FILE} is the adapter's own when it has skills`);
        seen.add(tool.name);
        // What every harness refuses (the root, JSON Schema 2020-12, a remote $ref), then what this one measured.
        const common = toolSchemaProblems(tool.name, tool.inputSchema);
        problems.push(...common, ...(common.length ? [] : claudeSchemaProblems(tool.name, tool.inputSchema)));
      }
      for (const server of spec.mcp?.servers ?? []) {
        if (server.name === MCP_SERVER) problems.push(`the MCP server name ${MCP_SERVER} is the adapter's own`);
        for (const tool of server.tools) {
          const name = `mcp__${server.name}__${tool.name}`;
          if (!TOOL_NAME.test(name)) problems.push(`the MCP tool ${name.slice(0, 80)} is not a name the Claude Agent CLI takes (letters, digits, _ and -, at most 64)`);
          // A remote tool's schema meets the same checks as the host's: the CLI would drop it without a word.
          const common = toolSchemaProblems(name, tool.inputSchema);
          problems.push(...common, ...(common.length ? [] : claudeSchemaProblems(name, tool.inputSchema)));
        }
      }
      return problems;
    },
    async open(spec, io) {
      const problems = this.check(spec);
      if (problems.length) throw new Error(`agentrun-harness-claude: ${problems.join("; ")}`);
      const dir = io.dir ?? (options.sessionsDir ? join(options.sessionsDir, createHash("sha256").update(spec.key).digest("hex").slice(0, 32)) : undefined);
      if (!dir) throw new Error("agentrun-harness-claude: a session needs a private directory: the host lends one (io.dir), or pass sessionsDir");
      // With skills, the model also reads their files (read_skill_file), from the session's own copy of them.
      const tools: HostTool[] = skills.length ? [...spec.tools, readSkillFileTool(join(dir, "plugin", "skills"), skills.map((skill) => ({ name: skill.name, files: Object.keys(skill.files) })))] : spec.tools;

      const calls = new CallsInFlight();
      // The remote MCP servers' granted tools, as the CLI names them: its own MCP client calls them at the proxy.
      const mcpServers = spec.mcp?.servers ?? [];
      const mcpNames = new Set(mcpServers.flatMap((server) => server.tools.map((tool) => `mcp__${server.name}__${tool.name}`)));
      // The CLI's own tools offered to the model: Skill only when the session has skills, WebSearch only when it is on.
      const builtins = [...(skills.length ? ["Skill"] : []), ...(webSearch ? ["WebSearch"] : [])];
      // The session's host port (AdapterSession.port): the host's own requests beside the CLI's (a learned workflow's node)
      // on the session's route, built from the drive proxy's own pieces (the same policy, origin, credential, price, headers
      // and the session's booking, io.models), but on a listener the session holds: a drive's proxy closes with its drive
      // (a park ends the turn; a restart opens none), and an approved call runs before any turn. It serves side keys only:
      // the CLI never holds its key. Its policy object is its own: anything a policy keeps per instance stays apart from the
      // drive's, as a side call's should. Closed with the session, or when the host lets the session go (io.signal).
      const hostPort = await startModelProxy({
        policy: anthropicPolicy({
          model: modelFor(spec),
          ...(options.smallModel ? { smallModel: options.smallModel } : {}),
          tools: [],
          ...(webSearch ? { webSearch: true, ...(options.webSearchAllowance !== undefined ? { webSearchAllowance: options.webSearchAllowance } : {}) } : {}),
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.provider.auth ? { auth: options.provider.auth } : {}),
        }),
        hooks: io.models,
        model: modelFor(spec),
        origin: options.provider.origin,
        credential: async () => (await options.provider.credential()) ?? "",
        ...(options.price ? { price: withWebSearches(options.price) } : {}),
        ...(options.provider.headers ? { headers: options.provider.headers } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }, randomBytes(32).toString("base64url"));
      let hostClosed = false;
      const closeHost = async () => {
        if (hostClosed) return;
        hostClosed = true;
        await hostPort.close().catch(() => {});
      };
      io.signal.addEventListener("abort", () => void closeHost(), { once: true });
      const acquire = localMachine({
        dir,
        // The host's workspace, when it names one: the CLI works where the host's file tools write (io.cwd).
        ...(io.cwd ? { cwd: io.cwd } : {}),
        ...(options.confine ? { confine: options.confine } : {}),
        proxy: {
          hooks: io.models,
          tools: tools.map((t) => t.name),
          ...(builtins.length ? { builtins } : {}),
          ...(webSearch ? { webSearch: true, ...(options.webSearchAllowance !== undefined ? { webSearchAllowance: options.webSearchAllowance } : {}) } : {}),
          ...(options.price ? { price: options.price } : {}),
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.provider.auth ? { auth: options.provider.auth } : {}),
          ...(options.provider.headers ? { headers: options.provider.headers } : {}),
          ...(options.log ? { log: options.log } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(spec.mcp ? { mcp: { session: spec.mcp, tools: [...mcpNames] } } : {}),
        },
      });
      // The SDK this session runs on (the host's, or the one installed beside this package, checked above), thinking at
      // the session's level.
      // Handed nothing once the drive of the moment is stopped (withStopEndingPrompts).
      const sdk = withStopEndingPrompts(thinkingAt(options.sdk ?? (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeAgentSdk, thinkingOf(spec, thinking)), () => drive.signal);
      const harness = claudeCodeHarness({
        name: CLAUDE_AGENT_ID,
        sandbox: {
          attach: (ctx, request) => acquire({ ctx, ...(request.model ? { model: request.model } : {}), ...(request.deadline === undefined ? {} : { deadline: request.deadline }) }),
          // No command of its own: the CLI reaches nothing but its model proxy (a web search, when on, is the provider's).
          network: "deny-all",
          // The runner's turn cap and the host's beforeRequest bound the spend.
          budget: { turnUsd: Infinity, sessionUsd: Infinity },
        },
        tools: tools.map((tool) => kernelTool(tool, io, maxImageBytes, calls)),
        builtins: false,
        // Off by name too, besides tools: []: the pinned CLI's tools that neither the harness's allowlist nor its off list
        // decide (test/tool-off.test.mjs pins the CLI's whole tool set against these lists), but WebSearch when it is on.
        disallowedTools: CLAUDE_AGENT_ALSO_OFF.filter((name) => !(webSearch && name === "WebSearch")),
        ...(webSearch ? { providerTools: ["web_search" as const] } : {}),
        ...(mcpServers.length ? { mcpServers: mcpServers.map((server) => ({ name: server.name, tools: server.tools.map((tool) => tool.name) })) } : {}),
        model: modelFor(spec),
        ...(skills.length ? { skills: { plugin: join(dir, "plugin"), names: writeSkillsPlugin(join(dir, "plugin"), skills) } } : {}),
        ...(options.smallModel ? { smallModel: options.smallModel } : {}),
        ...(spec.system.length ? { instructions: spec.system.join("\n\n") } : {}),
        credential: async () => options.provider.credential(),
        gatewayUrl: options.provider.origin,
        executable,
        sdk,
        ...(options.mcp ? { toolServerModules: options.mcp } : {}),
        ...(options.log ? { log: options.log } : {}),
      });

      const live = (event: unknown) => {
        const e = event as { type?: string; delta?: unknown; callId?: unknown; name?: unknown; isError?: unknown; result?: unknown; truncated?: unknown; args?: unknown; reason?: unknown };
        if (e?.type === "text" && typeof e.delta === "string") io.onEvent({ type: "text", delta: e.delta });
        // An MCP call, recorded as a built-in's: the host hears of it once its intent is in the session's records.
        if (e?.type === "tool_start" && typeof e.callId === "string" && typeof e.name === "string" && mcpNames.has(e.name)) {
          calls.begin(e.callId);
          io.onEvent({ type: "tool_start", callId: e.callId, name: e.name, args: e.args ?? {} });
        }
        // The tool bridge's `tool_end` comes once the call's outcome is in the session's records: only then does the host
        // hear the call ended, with the text recorded.
        if (e?.type === "tool_end" && typeof e.callId === "string" && typeof e.name === "string") {
          calls.end(e.callId);
          io.onEvent({ type: "tool_end", callId: e.callId, name: e.name, isError: e.isError === true, ...(typeof e.result === "string" ? { result: e.result } : {}), ...(e.truncated === true ? { truncated: true as const } : {}) });
        }
        // A call the CLI refused itself (a tool the session doesn't have): shown as a call that failed, by the name the
        // model gave. The CLI's transcript, mirrored to the store, keeps the refusal.
        if (e?.type === "tool_refused" && typeof e.callId === "string" && typeof e.name === "string") {
          io.onEvent({ type: "tool_start", callId: e.callId, name: e.name, args: e.args ?? {} });
          io.onEvent({ type: "tool_end", callId: e.callId, name: e.name, isError: true });
          options.log?.("claude-agent: the CLI turned down a call to a tool this session does not have", { name: e.name, reason: e.reason });
        }
      };
      // Every drive of this session writes through one serialized writer, so a drive opened after an interrupt reads only
      // once the halted drive's last writes are in (serial.ts).
      const writer = serialWriter(io.writer);
      const open = (attempt = 0) => openDrive({ writer, signal: io.signal, live, attempt });
      let drive = await open();
      const initial = drive.state();
      // A turn is open while the session holds input no turn placed, or a turn with no end (its recovery note).
      const holdsTurn = (folded: typeof initial) => Boolean(recoveryNote(folded)) || pendingSubmissions(folded).length > 0;
      let state: AdapterSession["state"] = holdsTurn(initial)
        ? "open_turn"
        : initial.submissions.length === 0 && turnsIn(drive).length === 0 ? "new" : "idle";

      let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
      let closed = false;
      const run = () => {
        const before = turnsIn(drive).length;
        state = "idle";
        running = (async () => {
          let outcome: { status: TurnStatus; error?: string } | undefined;
          for (let attempt = 0; !outcome; attempt += 1) {
            const current = drive;
            try {
              await harness.drive(current);
              const ended = turnsIn(current).slice(before).at(-1)?.data as { status?: TurnStatus; error?: string } | undefined;
              outcome = ended?.status ? { status: ended.status, ...(ended.error ? { error: ended.error } : {}) } : { status: "failed", error: "the turn ended with no outcome in the session's records" };
            } catch (error) {
              // Stopped by the session or its host: interrupted. Halted by anything else (a spend cap, the mirror, a refused
              // spawn): failed, naming why.
              if (current.signal.aborted) {
                outcome = abortedOutcome(current.signal, io.signal);
                // A stop that landed before this turn ran (while send() was still recording its prompt) found no turn to
                // stop, and reads the session as it was: the turn is open now, its prompt pending, so it reads open_turn.
                state = holdsTurn(current.state()) ? "open_turn" : "idle";
              }
              // The CLI exited mid-turn: the drive is rebuilt from the log and the turn resumes, a few times.
              else if (error instanceof Restart && attempt < RESTARTS) drive = await open(attempt + 1);
              else outcome = { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 500) };
            }
          }
          io.onEvent({ type: "turn_end", status: outcome.status });
          return outcome;
        })();
        return running;
      };
      // A drive that was halted (an interrupt) holds the session no more: the next turn opens a fresh one, on the same
      // writer (the adapter never opens the session itself).
      const ready = async () => {
        if (closed) throw new Error("agentrun-harness-claude: the session is closed");
        if (running) await running;
        if (drive.signal.aborted && !io.signal.aborted) drive = await open();
      };

      return {
        get state() { return state; },
        async send(text) {
          if (calls.draining) throw new Error("agentrun-harness-claude: the session is pausing; no new turn");
          await ready();
          await drive.submit({ id: randomUUID(), kind: "prompt", text });
          void run();
        },
        async recover() {
          if (state !== "open_turn") throw new Error("agentrun-harness-claude: there is no turn to recover");
          await ready();
          void run();
        },
        async settleOpenTurn(options = {}) {
          if (state !== "open_turn") throw new Error("agentrun-harness-claude: there is no turn to settle");
          await ready();
          // The turn's end in the session's own transcript, as a turn that ends writes it: the next open finds no open turn,
          // and the next turn carries no recovery of this one. Nothing is sent. A prompt the turn placed that the CLI never
          // recorded (the stop came before the CLI read it) is carried into the next message, as an unplaced one is; a
          // follow-up's own is not. The record is the CLI's transcript as the session keeps it (lostPrompts over the
          // journal's transcript store), the history a resumed CLI is given: a message it lacks the next turn's model never
          // saw, so carrying it never sends it twice.
          const folded = drive.state();
          const transcript = new JournalSessionStore(new NativeJournal(drive), { records: await new NativeJournal(drive).read() });
          const unsent = lostPrompts(folded, recoveryNote(folded)?.turn.placed ?? [], transcript);
          await settleTurn(drive, { unsent, ...(options.opening === undefined ? {} : { host: options.opening }) });
          state = "idle";
        },
        async turnEnd() {
          if (!running) throw new Error("agentrun-harness-claude: no turn is in flight");
          return running;
        },
        async interrupt(interruptOptions = {}) {
          const drainMs = interruptOptions.drainMs ?? 0;
          if (!Number.isFinite(drainMs) || drainMs < 0) throw new Error("agentrun-harness-claude: drainMs must be a non-negative number of milliseconds");
          // A pause: no new turn here (the host refuses new calls and requests); the calls in flight run on until their
          // outcomes are recorded.
          calls.draining = true;
          try {
            if (drainMs > 0) await calls.idle(drainMs);
            drive.halt?.(new SessionHalt("interrupted"));
            await running?.catch(() => {});
            // The turn it stopped is still open in the session (an interrupt writes no end, and a prompt it stopped before
            // the harness placed it is still pending): open_turn, so a host that is done with it settles it here.
            if (holdsTurn(drive.state())) state = "open_turn";
          } finally {
            // Calls the halt cut off have no outcome to wait for; the next turn starts clean.
            calls.clear();
            calls.draining = false;
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          drive.halt?.(new SessionHalt("closed"));
          await running?.catch(() => {});
          await closeHost();
        },
        // The session's one model route, for the host's own request beside the CLI's: the session's host port, which
        // never restarts once closed.
        port: (label: string) => (closed || hostClosed ? undefined : { url: hostPort.url, key: hostPort.sideKey(label), model: modelFor(spec), api: "anthropic-messages" as const }),
      };
    },
  };
}
