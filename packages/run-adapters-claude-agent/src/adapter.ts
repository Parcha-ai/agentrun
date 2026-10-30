// The Claude Agent SDK as an AgentRun harness adapter (id `claude-agent`). Written for AgentRun.
//
// A session is the copied Claude Agent harness (harness.ts) driven over the session's own records: the kernel's
// openDrive on the writer the runner lends (`io.writer`), on a local machine (host/machine.ts). The CLI's own tools are
// on by default (the pinned allowlist, CLAUDE_BUILTINS, minus the tools whose state lives outside the log), beside the
// host's tools, exactly those `spec.tools` names. A host tool runs through the shared tool bridge as a kernel effect; a
// built-in's intent is committed by the PreToolUse hook before the CLI runs it, and its outcome after (BuiltinCalls).
// Both kinds are counted in flight the same way, so a pause drains either. Its model is the session's loopback proxy
// (@parcha/agentrun-kernel/host, with the Anthropic policy in host/policy.ts): every paid request passes the runner's
// `beforeRequest` first, and its usage comes back through `afterRequest`. The runner alone accounts model spend.
//
// The Agent SDK is the host's: an exact optional peer dependency (`CLAUDE_AGENT_SDK_VERSION`), never shipped here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CallsInFlight, openAdapterSession, READ_SKILL_FILE, readSkillFileTool, type AgentAdapter, type HostTool, type SessionIO, type SessionSpec, type ToolImage } from "@parcha/agentrun-kernel";
import type { HostTool as KernelTool } from "@parcha/agentrun-kernel/kernel";
import { toolSchemaProblems } from "@parcha/agentrun-kernel";
import { hostHeaderProblems, type ModelProxyOptions } from "@parcha/agentrun-kernel/host";
import { findClaudeExecutable, platformSuffix } from "./binary.js";
import { CLAUDE_AGENT_PACKAGE, ClaudeAgentNotInstalled, ClaudeAgentPinMismatch, ClaudeAgentThinkingOff } from "./errors.js";
import { builtinTools, type ClaudeAgentSdk, claudeCodeHarness } from "./harness.js";
import { type ConfineChild, localMachine, type MachineBox } from "./host/machine.js";
import { CLAUDE_AGENT_SDK_INSTALL, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION, installedVersion } from "./versions.js";
export { CLAUDE_AGENT_CLI_SKILL_NAMES } from "./cli-names.js";

/** The pinned CLI's tools the copied harness leaves undecided, off by name in every session. */
export const CLAUDE_AGENT_ALSO_OFF: readonly string[] = Object.freeze(["Skill", "WebSearch"]);

/** The local plugin the session's skills are served from: the model sees each as `agentrun:<name>`, and may load it by
 *  that name or, unless the CLI has a command or skill of that name (`CLAUDE_AGENT_CLI_SKILL_NAMES`), by its bare one. */
export const CLAUDE_AGENT_SKILLS_PLUGIN = "agentrun";

/** A skill the model may load (the Skill tool): its name, and its files by path, `SKILL.md` among them. */
export interface ClaudeAgentSkill {
  /** Lowercase letters, digits and dashes; `SKILL.md`'s front matter names it the same. */
  name: string;
  /** Each file's text by its path inside the skill (`SKILL.md`, `reference/sources.md`). */
  files: Readonly<Record<string, string>>;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/){0,4}[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const SKILL_BYTES = 1024 * 1024;

/** The skills, checked: each a name, a `SKILL.md` whose front matter has that name and a description, and files at plain
 *  relative paths, 1 MiB in all; or the problems. */
export function skillProblems(skills: readonly ClaudeAgentSkill[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const skill of skills) {
    const name = String(skill?.name ?? "");
    if (!SKILL_NAME.test(name)) { problems.push(`the skill name ${JSON.stringify(name.slice(0, 80))} is not lowercase letters, digits and dashes`); continue; }
    if (seen.has(name)) problems.push(`the skill ${name} is given twice`);
    seen.add(name);
    const files = skill.files ?? {};
    const md = files["SKILL.md"];
    const front = typeof md === "string" ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md)?.[1] : undefined;
    if (front === undefined) problems.push(`the skill ${name} has no SKILL.md with front matter`);
    else {
      if (!new RegExp(`^name:\\s*(['"]?)${name}\\1\\s*$`, "m").test(front)) problems.push(`the skill ${name}'s SKILL.md names it otherwise`);
      if (!/^description:\s*\S/m.test(front)) problems.push(`the skill ${name}'s SKILL.md has no description`);
    }
    // A path that is another's folder (reference, and reference/sources.md) can't be written as both.
    const paths = new Set(Object.keys(files));
    for (const folder of new Set([...paths].flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))) {
      if (paths.has(folder)) problems.push(`the skill ${name}'s ${folder} is both a file and a folder`);
    }
    for (const [path, text] of Object.entries(files)) {
      if (!SKILL_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) problems.push(`the skill ${name}'s file ${JSON.stringify(path.slice(0, 80))} is not a plain relative path`);
      if (typeof text !== "string") problems.push(`the skill ${name}'s file ${path} is not text`);
      else bytes += Buffer.byteLength(text);
    }
  }
  if (bytes > SKILL_BYTES) problems.push(`the skills hold ${bytes} bytes, more than ${SKILL_BYTES}`);
  return problems;
}

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
  /** The CLI's own tools: `true` (the default) is the pinned allowlist (CLAUDE_BUILTINS: Bash, Read, Edit, Write,
   *  NotebookEdit, WebFetch), `false` none, or a list of names. The tools whose state lives outside the log
   *  (CLAUDE_BUILTINS_OFF) and the provider-hosted ones stay off whatever this says. */
  builtins?: boolean | readonly string[];
  /** The host's box for the CLI (@parcha/agentrun-kernel/host's MachineBox), or `unsandboxed`, the operator's word
   *  that there is none. Absent: the host gives none, and a session with built-ins on fails with a named error. The
   *  CLI's own sandbox is never used: in the box it is off, the box being the boundary. */
  box?: MachineBox | "unsandboxed";
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

/** The CLI at `path`, checked against the pins: its path, or the typed reason it is not the pinned build. */
export function verifyClaudeAgentCli(path: string | undefined, pins = claudeAgentCliPins()): { path: string } | ClaudeAgentPinMismatch | ClaudeAgentNotInstalled {
  if (!path) return new ClaudeAgentNotInstalled(`no CLI of @anthropic-ai/claude-agent-sdk ${CLAUDE_AGENT_SDK_VERSION} for ${platformSuffix()} (its platform package, an optional dependency npm installs with it), and no cliPath`, CLAUDE_AGENT_SDK_INSTALL);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return new ClaudeAgentNotInstalled(`no CLI at ${path}`);
  }
  if (pins.sha256) {
    const found = createHash("sha256").update(bytes).digest("hex");
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
export function verifyClaudeAgent(options: Pick<ClaudeAgentAdapterOptions, "sdk" | "sdkVersion" | "cliPath">, installed: (name: string) => string | undefined = installedVersion): { cliPath: string } {
  const sdkVersion = options.sdk ? options.sdkVersion : installed("@anthropic-ai/claude-agent-sdk");
  if (!options.sdk && sdkVersion === undefined) throw new ClaudeAgentNotInstalled(`@anthropic-ai/claude-agent-sdk ${CLAUDE_AGENT_SDK_VERSION} is not installed beside ${CLAUDE_AGENT_PACKAGE}, and no module was given (sdk)`, CLAUDE_AGENT_SDK_INSTALL);
  if (sdkVersion !== undefined && sdkVersion !== CLAUDE_AGENT_SDK_VERSION) throw new ClaudeAgentPinMismatch("sdk_version", CLAUDE_AGENT_SDK_VERSION, sdkVersion);
  // The session's tools are served by an MCP server built here (host/tool-server.ts), whichever SDK runs: an injected
  // SDK does not bring the MCP library, so a missing one is refused now, not at the first turn.
  if (installed("@modelcontextprotocol/sdk") === undefined) throw new ClaudeAgentNotInstalled(`@modelcontextprotocol/sdk is not installed beside ${CLAUDE_AGENT_PACKAGE} (the Agent SDK's peer, which serves the session's tools; npm installs it with the SDK)`, CLAUDE_AGENT_SDK_INSTALL);
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
      // In flight, and past the pause's check, before the host hears of it: a pause the host starts on this tool_start
      // waits for this call rather than refusing it.
      calls.begin(callId);
      // A guard: a call begun during a pause is not run; the bridge's per-drive mutex keeps it unreachable while calls are serial, and its test lands with the fan-out PR.
      if (calls.draining) throw new Error(`${tool.name} was not run: the session is pausing`);
      io.onEvent({ type: "tool_start", callId, name: tool.name, args: input });
      const result = await tool.call(input, { callId, signal: effect.signal });
      if (result.isError) throw new Error(result.text);
      if (!result.images?.length) return result.text;
      // An image the model can't be sent is the call's error, by the tool's name and the image, not a request refused later.
      const wrong = toolImageProblems(tool.name, result.images, maxImageBytes);
      if (wrong) throw new Error(wrong);
      return { text: result.text, images: result.images.map((image) => ({ mimeType: image.mimeType, data: image.data })) };
    },
  };
}

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
    capabilities: () => ({ fork: false }),
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
      const builtins = options.builtins ?? true;
      // The built-ins this session offers the model, the Skill tool with skills: the proxy forwards exactly these.
      const native = [...(builtinTools(builtins === true ? true : builtins === false ? false : [...builtins]) ?? []), ...(skills.length ? ["Skill"] : [])];
      const acquire = localMachine({
        dir,
        ...(options.confine ? { confine: options.confine } : {}),
        ...(options.box ? { box: options.box } : {}),
        proxy: {
          hooks: io.models,
          tools: tools.map((t) => t.name),
          ...(native.length ? { builtins: native } : {}),
          ...(options.price ? { price: options.price } : {}),
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.provider.auth ? { auth: options.provider.auth } : {}),
          ...(options.provider.headers ? { headers: options.provider.headers } : {}),
          ...(options.log ? { log: options.log } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        },
      });
      // The SDK this session runs on (the host's, or the one installed beside this package, checked above), thinking at
      // the session's level.
      const sdk = thinkingAt(options.sdk ?? (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeAgentSdk, thinkingOf(spec, thinking));
      const harness = claudeCodeHarness({
        name: CLAUDE_AGENT_ID,
        sandbox: {
          attach: (ctx, request) => acquire({ ctx, ...(request.model ? { model: request.model } : {}), ...(request.deadline === undefined ? {} : { deadline: request.deadline }) }),
          // No provider-hosted tool and no command of its own: the CLI reaches nothing but its model proxy.
          network: "deny-all",
          // The runner's turn cap and the host's beforeRequest bound the spend.
          budget: { turnUsd: Infinity, sessionUsd: Infinity },
        },
        tools: tools.map((tool) => kernelTool(tool, io, maxImageBytes, calls)),
        builtins: builtins === true || builtins === false ? builtins : [...builtins],
        // A built-in call, counted in flight before the host hears of it, as a host tool's is: a pause the host starts on
        // its tool_start waits for it. One a pause has begun is refused before it is counted: a refused call never ends,
        // so counted it would hold the pause to its whole drainMs.
        builtinAround: (call, run) => {
          if (calls.draining) throw new Error(`${call.name} was not run: the session is pausing`);
          calls.begin(call.callId);
          io.onEvent({ type: "tool_start", callId: call.callId, name: call.name, args: call.input });
          return run();
        },
        // Off by name too, besides tools: []: the pinned CLI's tools that neither the harness's allowlist nor its off list
        // decide (test/tool-off.test.mjs pins the CLI's whole tool set against these lists).
        disallowedTools: [...CLAUDE_AGENT_ALSO_OFF],
        model: modelFor(spec),
        ...(skills.length ? { skills: { plugin: join(dir, "plugin"), names: writeSkillsPlugin(join(dir, "plugin"), skills) } } : {}),
        ...(options.smallModel ? { smallModel: options.smallModel } : {}),
        ...(spec.system.length ? { instructions: spec.system.join("\n\n") } : {}),
        credential: async () => options.provider.credential(),
        gatewayUrl: options.provider.origin,
        executable,
        sdk,
        ...(options.log ? { log: options.log } : {}),
      });

      const live = (event: unknown) => {
        const e = event as { type?: string; delta?: unknown; callId?: unknown; name?: unknown; isError?: unknown; result?: unknown; args?: unknown; reason?: unknown };
        if (e?.type === "text" && typeof e.delta === "string") io.onEvent({ type: "text", delta: e.delta });
        // The tool bridge's `tool_end` comes once the call's outcome is in the session's records: only then does the host
        // hear the call ended, with the text recorded.
        if (e?.type === "tool_end" && typeof e.callId === "string" && typeof e.name === "string") {
          calls.end(e.callId);
          io.onEvent({ type: "tool_end", callId: e.callId, name: e.name, isError: e.isError === true, ...(typeof e.result === "string" ? { result: e.result } : {}) });
        }
        // A call the CLI refused itself (a tool the session doesn't have): shown as a call that failed, by the name the
        // model gave. The CLI's transcript, mirrored to the store, keeps the refusal.
        if (e?.type === "tool_refused" && typeof e.callId === "string" && typeof e.name === "string") {
          io.onEvent({ type: "tool_start", callId: e.callId, name: e.name, args: e.args ?? {} });
          io.onEvent({ type: "tool_end", callId: e.callId, name: e.name, isError: true });
          options.log?.("claude-agent: the CLI turned down a call to a tool this session does not have", { name: e.name, reason: e.reason });
        }
      };
      return openAdapterSession({ name: "agentrun-harness-claude", io, drive: (drive) => harness.drive(drive), live, calls, restarts: RESTARTS });
    },
  };
}
