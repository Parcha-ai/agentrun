// What Goose is as a host's harness table reads it (the kernel's AdapterFacts), as this adapter states it: a host reads
// these and never branches on its name. Measured on Goose 1.59.2 over ACP (goose.ts says what its recipe holds).
// Written for AgentRun.
import type { AdapterFacts } from "@parcha/agentrun-kernel";
import { ACP_CODES } from "./facts.js";
import { goosePolicy, gooseToolName } from "./host/goose-proxy.js";
import { GOOSE_PIN } from "./pinned-binary.js";

/** The command that installs the pinned Goose into an AgentRun server's data (`<data>/harnesses/goose`). */
export const GOOSE_INSTALL = "agentrun harness install goose";

/** The code a host's refusal carries when Goose is not installed where it looks. */
export const GOOSE_NOT_INSTALLED = "HARNESS_NOT_INSTALLED";

const OURS = gooseToolName("");

export const gooseFacts: AdapterFacts = Object.freeze<AdapterFacts>({
  id: "goose",
  label: "Goose",
  wire: "anthropic-messages",
  // ACP has no steer: a message mid-turn waits for the turn's end.
  steer: false,
  // A call Goose started is never run again: one cut off is reported interrupted, never repeated.
  rerunsStarted: false,
  // An answer cut at the output limit (stopReason max_tokens) ends the turn.
  recoversCutAnswers: 0,
  // One run's memory, measured with the server's (serve's host.ts): Goose's own process beside the run's.
  runMib: 256,
  // Goose asks for adaptive thinking at the model's own effort (high), whatever the run's level: no level is passed to it.
  thinking: Object.freeze(["high"] as const),
  // Its model is Anthropic's, on its own settings, never the gateway's default for the other harnesses.
  ownModel: true,
  // Its proxy forwards with the fetch it is handed: a model the route translates onto its wire runs on it.
  forwardsRoute: true,
  // Anthropic's ids hold no dot; OpenRouter names the same models with dots (anthropic/claude-sonnet-5.5).
  normalizeModel: (model: { provider: string; modelId: string }) => (model.provider === "anthropic" ? { ...model, modelId: model.modelId.replaceAll(".", "-") } : model),
  // Installed by its owner, never on first use: the archive the pin names, its digests checked (serve's harness-archive.ts).
  install: Object.freeze({ npmLine: GOOSE_INSTALL, spec: `goose@${GOOSE_PIN.version}`, codes: Object.freeze({ install: GOOSE_NOT_INSTALLED, pins: ACP_CODES.binaryMismatch }) }),
  // Its bundled extensions are off: the model calls only our MCP server's tools, as `agentrun__<host tool>`.
  hostName: (given: string) => (given.startsWith(OURS) ? given.slice(OURS.length) : given),
  policy: (options) => goosePolicy({ model: options.model, tools: options.tools, ...(options.auth ? { auth: options.auth } : {}), ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }),
});
