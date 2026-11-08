// What codex is, as its adapter states it (AdapterFacts): a host reads these and never branches on its name. They describe
// the harness; none renames or reshapes what its model sees, and none turns its built-ins, sandbox or session machine on.
import type { AdapterFacts } from "@parcha/agentrun-kernel";
import { codexPolicy } from "./host/policy.js";
import { codexSchemaProblems } from "./schema.js";
import { CODEX_INSTALL, CODEX_VERSION } from "./versions.js";

export const facts: AdapterFacts = Object.freeze<AdapterFacts>({
  id: "codex",
  label: "Codex",
  wire: "openai-responses",
  // A message that comes mid-turn waits for the turn's end.
  steer: false,
  // One run's memory, measured with the server's (serve's host.ts): Codex's app-server beside the run's process.
  runMib: 192,
  // OpenAI's reasoning efforts stop at xhigh.
  // Its own MCP client binds the session's remote MCP servers.
  mcp: true,
  thinking: Object.freeze(["low", "medium", "high", "xhigh"] as const),
  // Codex's own live search, booked per call.
  webSearch: "live",
  ownModel: false,
  normalizeModel: (model: { provider: string; modelId: string }) => model,
  install: Object.freeze({ npmLine: CODEX_INSTALL, spec: `@openai/codex@${CODEX_VERSION}`, codes: Object.freeze({ install: "CODEX_NOT_INSTALLED", pins: "CODEX_PIN_MISMATCH" }) }),
  // Its MCP client builds the model's copy of a server's tool with parse_tool_input_schema (codex-rs
  // tools/src/mcp_tool.rs at rust-v0.164.0): the shapes it drops or retypes, measured on the pinned binary.
  schemaProblems: codexSchemaProblems,
  policy: (options) => codexPolicy({ model: options.model, tools: options.tools, ...(options.webSearch === "live" ? { webSearch: "live" as const } : {}), ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }),
});
