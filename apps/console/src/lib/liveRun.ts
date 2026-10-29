import { harnessSteers, type MessageFeatures, NO_MESSAGES } from "./runState";

/** Where reading a run's agent (for its harness) stands. */
export type HarnessRead = { state: "loading" } | { state: "read"; id: string | undefined } | { state: "failed" };

/** What the run page may offer as a message, from the run's harness and the server's capabilities. While the harness is
 *  not known, nothing is offered. Once read, a steer only where that harness steers mid-turn. When the agent could not be
 *  read, it fails closed: never a steer (a follow_up, which every harness takes, stays). */
export function messageOffer(
  harness: HarnessRead,
  caps: { features: { messages: MessageFeatures }; harnesses: { id: string; available?: boolean; steer?: boolean }[] } | null,
): { messages: MessageFeatures; steers: boolean } {
  if (!caps || harness.state === "loading") return { messages: NO_MESSAGES, steers: false };
  if (harness.state === "failed") return { messages: caps.features.messages, steers: false };
  return { messages: caps.features.messages, steers: harnessSteers(harness.id, caps.harnesses) };
}

/** Reads a run's agent for its harness: read (none named is the default, pi) or failed. A failed read is never taken
 *  for pi: messageOffer then offers no steer. */
export function readHarness(v2: { agentHarness: (agentId: string) => Promise<string | undefined> }, agentId: string): Promise<HarnessRead> {
  return v2.agentHarness(agentId).then((id): HarnessRead => ({ state: "read", id }), (): HarnessRead => ({ state: "failed" }));
}
