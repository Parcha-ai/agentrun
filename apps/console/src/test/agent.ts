import type { Agent, Definition } from "@/lib/v2";

// An agent as the server sends it (components["Agent"], generated), for a test: the fields a test names, and the rest of
// the served agent filled in the way a fresh one on a local server reads (no source, skills or sign-ins; no runs yet).
// The definition is the served one too: a test names what it reads, and `name` at least.

/** What a test gives: the agent's id and definition, and any other served field it reads. */
export type AgentGiven = Partial<Omit<Agent, "definition">> & { agent_id: string; definition: Definition };

/** A served agent from what a test gives: an agentic one at revision r1 (its first), not archived, unless given. */
export function servedAgent(given: AgentGiven): Agent {
  return {
    source: null, skills: [], sign_ins: [], runs: { count: 0, live: 0 }, region: "local", home_etag: "etag-1",
    created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z",
    kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
    ...given,
  };
}
