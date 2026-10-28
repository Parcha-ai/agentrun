import { describe, expect, it } from "vitest";
import { curlFor, keeper, startBody } from "./runStart";

describe("startBody", () => {
  it("starts an agentic run with its first message as content, and only the options given", () => {
    expect(startBody("agentic", { text: "Summarize the standup." })).toEqual({ ok: true, body: { input: { content: "Summarize the standup." } } });
    expect(startBody("agentic", { text: "Go.", revision: "r1", effort: "high", maxCostUsd: "0.50" })).toEqual({
      ok: true, body: { input: { content: "Go." }, revision: "r1", effort: "high", max_cost_usd: 0.5 },
    });
  });

  it("starts a workflow run with its typed input as JSON, and never a spend cap (the server refuses one)", () => {
    expect(startBody("workflow", { text: '{"subject":"Where is my invoice?","body":"Cannot find it."}', maxCostUsd: "1" })).toEqual({
      ok: true, body: { input: { subject: "Where is my invoice?", body: "Cannot find it." } },
    });
  });

  it("refuses an empty message, input that is not JSON, and a cap that is not a positive number", () => {
    expect(startBody("agentic", { text: "  " })).toMatchObject({ ok: false, field: "input" });
    expect(startBody("workflow", { text: "{subject:" })).toMatchObject({ ok: false, field: "input" });
    expect(startBody("agentic", { text: "Go.", maxCostUsd: "-1" })).toMatchObject({ ok: false, field: "max_cost_usd" });
  });
});

describe("keeper", () => {
  it("keeps one Idempotency-Key per request: a retry of the same request reuses it, a changed request gets a new one", () => {
    let n = 0;
    const keys = keeper(() => `k${++n}`);
    const a = { input: { content: "Go." } };
    expect(keys.keyFor("agent-1", a)).toBe("k1");
    expect(keys.keyFor("agent-1", { input: { content: "Go." } })).toBe("k1");
    expect(keys.keyFor("agent-1", { input: { content: "Go now." } })).toBe("k2");
    expect(keys.keyFor("agent-2", { input: { content: "Go now." } })).toBe("k3");
  });
  it("starts fresh after a run started, so the next start is a new run", () => {
    let n = 0;
    const keys = keeper(() => `k${++n}`);
    keys.keyFor("a", { input: { content: "Go." } });
    keys.done();
    expect(keys.keyFor("a", { input: { content: "Go." } })).toBe("k2");
  });
});

describe("curlFor", () => {
  it("is the request as cURL, with the token from the environment, never a value", () => {
    const c = curlFor("http://127.0.0.1:7340", "meeting-notes", { input: { content: "It's done." } }, "k1");
    expect(c).toContain("curl -X POST 'http://127.0.0.1:7340/v2/agents/meeting-notes/runs'");
    expect(c).toContain('-H "Authorization: Bearer $AGENTRUN_TOKEN"');
    expect(c).toContain("-H 'Idempotency-Key: k1'");
    expect(c).toContain(`-d '{"input":{"content":"It'\\''s done."}}'`);
  });
});
