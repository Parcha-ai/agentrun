// What claude-agent is, as its adapter states it (AdapterFacts): a host reads these and never branches on its name. They
// describe the harness; none renames or reshapes what its model sees, and none turns its built-ins, sandbox or session
// machine on.
import { type AdapterFacts, toolSchemaProblems } from "@parcha/agentrun-kernel";
import { anthropicPolicy } from "./host/policy.js";
import { CLAUDE_AGENT_SDK_INSTALL, CLAUDE_AGENT_SDK_VERSION } from "./versions.js";

export const facts: AdapterFacts = Object.freeze<AdapterFacts>({
  id: "claude-agent",
  label: "Claude",
  wire: "anthropic-messages",
  // A message that comes mid-turn waits for the turn's end.
  steer: false,
  // A call that started is never run again (the CLI answers it "[Tool call interrupted]"); only the model calls again.
  rerunsStarted: false,
  // An answer its output limit cut, the CLI resumes itself in the same turn ("Output token limit hit. Resume directly"),
  // up to 3 times; only a cut it no longer resumes ends the turn cut.
  recoversCutAnswers: 3,
  // One run's memory, measured with the server's (serve's host.ts): the CLI and its SDK beside the run's process.
  runMib: 288,
  // Its own MCP client binds the session's remote MCP servers.
  mcp: true,
  thinking: Object.freeze(["low", "medium", "high", "xhigh", "max"] as const),
  // Anthropic's web search, through the session's proxy, as the pinned CLI's WebSearch asks for it.
  webSearch: "native",
  // Its model is Anthropic's, on its own settings, never the gateway's default for the other harnesses.
  ownModel: true,
  // Anthropic's ids hold no dot; OpenRouter names the same models with dots (anthropic/claude-sonnet-5.5).
  normalizeModel: (model: { provider: string; modelId: string }) => (model.provider === "anthropic" ? { ...model, modelId: model.modelId.replaceAll(".", "-") } : model),
  install: Object.freeze({ npmLine: CLAUDE_AGENT_SDK_INSTALL, spec: `@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`, codes: Object.freeze({ install: "CLAUDE_AGENT_NOT_INSTALLED", pins: "CLAUDE_AGENT_PIN_MISMATCH" }) }),
  // The CLI drops a tool whose schema fails the kernel's check, or whose root holds anyOf, allOf or oneOf (measured on
  // the pinned CLI), without a word.
  // The CLI's own tools, each the host's table tool it is.
  nativeTools: Object.freeze({ WebSearch: "web_search", WebFetch: "web_fetch", Bash: "bash", Read: "read", Write: "write", Edit: "edit" }),
  schemaProblems: (tool: string, schema: Record<string, unknown>) => [...toolSchemaProblems(tool, schema), ...["anyOf", "allOf", "oneOf"].filter((key) => key in schema).map((key) => `/${key}: the Claude Agent CLI drops a tool whose root has ${key}`)],
  policy: (options) => anthropicPolicy({ model: options.model, tools: options.tools, ...(options.auth ? { auth: options.auth } : {}), ...(options.webSearch === true ? { webSearch: true, ...(options.webSearchAllowance ? { webSearchAllowance: options.webSearchAllowance } : {}) } : {}), ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }),
});
