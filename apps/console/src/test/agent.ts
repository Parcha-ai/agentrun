import type { Agent } from "@/lib/agentForm";

/** The fields every agent answer carries (serve's agents-store.ts agentView) that a test's agent sets nothing of. Spread
 *  first, so the fixture's own fields win. */
export const SERVED_AGENT = {
  source: null, skills: [], sign_ins: [], runs: { count: 0, live: 0 }, region: "local", home_etag: "\"home-1\"",
  created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
} satisfies Partial<Agent>;
