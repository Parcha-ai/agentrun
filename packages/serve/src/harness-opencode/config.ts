// OpenCode's whole config for a session, in a 0600 file OPENCODE_CONFIG names. Written for AgentRun; every key is one the
// pinned build's config schema holds (an unknown key refuses the start).
//  - One provider, `openai` (the AI SDK's Responses client), at the session's model proxy with the session's own key,
//    and one model, the session's, which is also the small model: no request goes to any other.
//  - One agent, `hands`, whose prompt is the session's instructions (in place of OpenCode's own) and the default; every
//    built-in agent is off, the title and summary agents among them, so OpenCode makes no side request of its own.
//  - Every OpenCode tool denied and only the adapter's MCP tools (`hands_*`) allowed; OpenCode's own sharing,
//    snapshots, formatters, language servers, instruction files and automatic compaction off.
//  - One MCP server, `hands`, the adapter's, with a call timeout long enough for a person to answer (progress resets it).
//  - A host tool's result within the host's bound (HOST_RESULT_MAX_CHARS) reaches the model whole: OpenCode cuts a
//    longer tool output (by default 2,000 lines or 51,200 bytes) and saves the rest to a file, which the session has no
//    tool to read.
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";

export interface OpenCodeConfigOptions {
  model: string;
  /** The model proxy's base for the Responses API: its loopback origin and `/v1`. */
  modelUrl: string;
  modelKey: string;
  /** The adapter's MCP endpoint and its key. */
  mcpUrl: string;
  mcpKey: string;
  contextWindow: number;
  maxOutputTokens: number;
  instructions?: string;
  effort?: string;
}

/** The longest an MCP call may go without progress: a day. The server reports progress every 15 s while a call runs. */
export const MCP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** OpenCode's `tool_output` limits, from the host's result bound: a result within it holds at most that many characters
 *  (UTF-16 units), so at most that many lines plus one, and three bytes of UTF-8 to a character. */
export const TOOL_OUTPUT = Object.freeze({ max_lines: HOST_RESULT_MAX_CHARS + 1, max_bytes: HOST_RESULT_MAX_CHARS * 3 });

/** The permission rules: everything denied, the adapter's MCP tools allowed (the last matching rule wins). */
export const PERMISSION: Readonly<Record<string, string>> = Object.freeze({ "*": "deny", "hands_*": "allow" });

const BUILT_IN_AGENTS = ["build", "plan", "general", "explore", "title", "summary", "compaction"] as const;

export function openCodeConfig(options: OpenCodeConfigOptions): Record<string, unknown> {
  const modelRef = `openai/${options.model}`;
  return {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    formatter: false,
    lsp: false,
    instructions: [],
    compaction: { auto: false },
    tool_output: { ...TOOL_OUTPUT },
    enabled_providers: ["openai"],
    provider: {
      openai: {
        options: { baseURL: options.modelUrl, apiKey: options.modelKey },
        models: {
          [options.model]: {
            name: options.model,
            tool_call: true,
            reasoning: options.effort !== undefined,
            attachment: false,
            limit: { context: options.contextWindow, output: options.maxOutputTokens },
            ...(options.effort ? { options: { reasoningEffort: options.effort } } : {}),
          },
        },
      },
    },
    model: modelRef,
    small_model: modelRef,
    default_agent: "hands",
    agent: {
      hands: { mode: "primary", ...(options.instructions ? { prompt: options.instructions } : {}), permission: { ...PERMISSION } },
      ...Object.fromEntries(BUILT_IN_AGENTS.map((name) => [name, { disable: true }])),
    },
    permission: { ...PERMISSION },
    mcp: {
      hands: { type: "remote", url: options.mcpUrl, headers: { authorization: `Bearer ${options.mcpKey}` }, enabled: true, oauth: false, timeout: MCP_TIMEOUT_MS },
    },
  };
}
