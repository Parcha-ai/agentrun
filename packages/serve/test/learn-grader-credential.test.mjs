// The learning grader sends a claude-agent grade as the run's own requests go: to claudeProvider's origin, with its
// credential, in its auth mode (x-api-key for Anthropic's API), and with nothing else of serve's env. pi-ai's anthropic
// provider, left to read serve's env, reads ANTHROPIC_AUTH_TOKEN before ANTHROPIC_API_KEY and would send that token as a
// bearer instead of the run's key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeProposal } from "../dist/grade.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { note } from "./fixtures/faux-learn.mjs";

/** Dummy keys: none is a real one. */
const KEY = (name) => `not-a-secret-${name}`;
/** The grader's prompt begins so (gradePrompt). */
const GRADER = "You grade what an agent proposes to remember.";
const isGrade = (request) => JSON.stringify(request.body ?? "").includes(GRADER);
const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const KEEP = JSON.stringify({ merge: true, reason: "The note is general and new.", items: [{ file: "check-units.md", keep: true, why: "It holds as a general rule." }] });

test("a claude-agent grade goes where the run's requests go, with the run's ANTHROPIC_API_KEY as x-api-key and no authorization, even when serve's env also holds ANTHROPIC_AUTH_TOKEN", { timeout: 60_000 }, async (t) => {
  const gw = await startFauxGateway({ text: (request) => (isGrade(request) ? KEEP : "ok") });
  t.after(() => gw.close());
  // serve's env as the grade reads it: the run's provider (claudeProvider: ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY), and
  // a token the run never sends. No Jev key, so no injection screen runs before the grade.
  const env = { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_API_KEY: KEY("anthropic"), ANTHROPIC_AUTH_TOKEN: KEY("host-token") };
  const judged = await judgeProposal({
    runId: "run_grader_credential",
    agent: { instructions: "Answer the question.", harness: "claude-agent", model: "anthropic/claude-haiku-4-5" },
    main: { active: [], superseded: [] },
    proposed: [{ file: "check-units.md", text: UNITS }],
    env,
    signal: new AbortController().signal,
    gradeTimeoutMs: 30_000,
  });

  const sent = gw.requests.map((r) => ({ method: r.method, path: r.path, query: r.query, authorization: r.headers.authorization ?? null, apiKey: r.headers["x-api-key"] ?? null, model: r.body?.model, grade: isGrade(r) }));
  assert.deepEqual(sent, [{ method: "POST", path: "/v1/messages", query: "beta=true", authorization: null, apiKey: KEY("anthropic"), model: "claude-haiku-4-5", grade: true }]);
  assert.equal(typeof gw.requests[0].headers["anthropic-version"], "string", "it names an anthropic-version");
  assert.ok("verdict" in judged, `graded, not ${judged.reason}: ${judged.error?.message}`);
  assert.equal(judged.verdict.merge, true, JSON.stringify(judged.verdict));
});
