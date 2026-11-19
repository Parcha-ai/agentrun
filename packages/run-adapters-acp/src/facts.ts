// What an ACP harness is, as its adapter states it, and the codes its refusals carry. Narrower than the kernel's
// AdapterFacts: an ACP agent's wire, policy and install are its recipe's (S1's table makes those optional for plan
// harnesses), so this states only what the adapter itself guarantees. Written for AgentRun.

/** The codes the adapter's refusals start with (`<code>: <words>`), so a host tells them apart without reading words. */
export const ACP_CODES = Object.freeze({
  /** initialize advertised less than the recipe declares (session/load, MCP over HTTP). */
  capabilityMismatch: "ACP_CAPABILITY_MISMATCH",
  /** initialize answered a protocol version the adapter does not speak. */
  protocolMismatch: "ACP_PROTOCOL_MISMATCH",
  /** A plan-billed run reached the owner's limit of session/prompt turns. */
  turnLimit: "ACP_TURN_LIMIT",
  /** A plan-billed run reached the owner's limit of tool calls. */
  toolCallLimit: "ACP_TOOL_CALL_LIMIT",
  /** The agent's process ended, or never answered initialize. */
  agentExited: "ACP_AGENT_EXITED",
  /** The agent stopped the turn at its own limit of requests (stopReason max_turn_requests). */
  agentTurnRequests: "ACP_MAX_TURN_REQUESTS",
  /** The agent refused to go on (stopReason refusal). */
  refusal: "ACP_REFUSAL",
  /** The agent's binary is not the pinned one: its sha256 differs from the pin's. */
  binaryMismatch: "ACP_BINARY_MISMATCH",
  /** The binary of an agent with no registry digest differs from the first one recorded for it. */
  binaryDrift: "ACP_BINARY_DRIFT",
  /** The agent's binary cannot be read to be checked. */
  binaryUnreadable: "ACP_BINARY_UNREADABLE",
  /** No digest is pinned for the agent's binary on this platform, and none was given. */
  binaryUnpinned: "ACP_BINARY_UNPINNED",
  /** A key the recipe runs on (recipe.keys) is not in the host's environment: the agent was not started. */
  keyMissing: "ACP_KEY_MISSING",
  /** The run's model (recipe.model) is not one the agent lists for its key: no prompt was sent. */
  modelUnlisted: "ACP_MODEL_UNLISTED",
} as const);

export interface AcpFacts {
  readonly id: string;
  readonly label: string;
  /** A message mid-turn waits for the turn's end: ACP has no steer. */
  readonly steer: false;
  /** A call the agent started is never run again: one cut off is reported interrupted, never repeated. */
  readonly rerunsStarted: false;
  /** An answer cut at the output limit (stopReason max_tokens) ends the turn. */
  readonly recoversCutAnswers: 0;
}

/** The facts of the ACP harness `id`. */
export function acpFacts(id: string, label = id): AcpFacts {
  return Object.freeze({ id, label, steer: false, rerunsStarted: false, recoversCutAnswers: 0 } as const);
}
