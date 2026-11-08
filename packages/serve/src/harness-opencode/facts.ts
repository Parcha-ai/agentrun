// What opencode is, as its adapter states it (AdapterFacts): the server reads these and never branches on its name. They
// describe the harness; none renames or reshapes what its model sees.
import type { AdapterFacts } from "@parcha/agentrun-kernel";
import { OPENCODE_VERSION } from "./binary.js";
import { openCodePolicy } from "./host/policy.js";

export const facts: AdapterFacts = Object.freeze<AdapterFacts>({
  id: "opencode",
  label: "OpenCode",
  wire: "openai-responses",
  // A message that comes mid-turn waits for the turn's end.
  steer: false,
  // One run's memory, measured with the server's (host.ts): OpenCode's server beside the run's process.
  runMib: 704,
  // OpenAI's reasoning efforts stop at xhigh.
  // Its MCP client is not bound to the session's remote MCP servers yet.
  mcp: false,
  thinking: Object.freeze(["low", "medium", "high", "xhigh"] as const),
  // OpenCode's model requests carry no provider-hosted tool: no search of its own.
  ownModel: false,
  normalizeModel: (model: { provider: string; modelId: string }) => model,
  // The server is named first, as the other lines name a package beside it: OpenCode's CLI is an optional peer of the
  // server's own.
  install: Object.freeze({ npmLine: `npm install @parcha/agentrun-serve opencode-ai@${OPENCODE_VERSION}`, spec: `opencode-ai@${OPENCODE_VERSION}`, codes: Object.freeze({ install: "OPENCODE_NOT_INSTALLED", pins: "OPENCODE_PIN_MISMATCH" }) }),
  // Its client calls a session's MCP tool `<server>_<tool>` too.
  toolAlias: /^([a-z][a-z0-9-]*)_(.+)$/,
  policy: (options) => openCodePolicy({ model: options.model, tools: options.tools, ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }),
});
