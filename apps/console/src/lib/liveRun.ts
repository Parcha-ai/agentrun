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

type RevisionPage = { revisions: { revision: string; definition: { harness?: string } }[]; next_cursor: string | null };

/** Reads the harness of the revision a run started from (`run.revision`), not the agent's current one: an edit after
 *  the run started never changes how that run takes a message. Read (none named is the default, pi) or failed: a
 *  failed read, or no revision that is the run's, is never taken for pi, and messageOffer then offers no steer. */
export async function readHarness(
  v2: { listRevisions: (agentId: string, cursor?: string | null) => Promise<RevisionPage> },
  run: { agent_id: string; revision: string },
): Promise<HarnessRead> {
  try {
    let cursor: string | null = null;
    do {
      const page: RevisionPage = await v2.listRevisions(run.agent_id, cursor);
      const own = page.revisions.find((r) => r.revision === run.revision);
      if (own) return { state: "read", id: own.definition.harness };
      cursor = page.next_cursor;
    } while (cursor);
  } catch {
    // Falls through to failed.
  }
  return { state: "failed" };
}
