import { afterEach, describe, expect, it } from "vitest";
import { apiOf, CODING_AGENT_KEY, codingAgentPrompt, saveCodingAgent, savedCodingAgent, SERVE_SKILL_URL } from "./codingAgentHandoff";

// The prompt a person copies into Claude Code or Codex: the server's public documents, the route the task uses, and the
// task's context, with no credential in it, wherever the console's endpoint points.
afterEach(() => { localStorage.clear(); history.replaceState(null, "", "/"); });

const contextOf = (prompt: string) => JSON.parse(prompt.split("```json\n")[1]!.split("\n```")[0]!);

describe("codingAgentPrompt", () => {
  it("create: the agents route, the skill, llms.txt, the OpenAPI document, capabilities and MCP on the server's own /v2", () => {
    const prompt = codingAgentPrompt({ kind: "create" }, "/v2", `${location.origin}/`);
    const api = `${location.origin}/v2`;
    expect(prompt.split("\n")[0]).toBe("Create an AgentRun agent on this server.");
    expect(contextOf(prompt)).toEqual({ server: api, operation: "POST /v2/agents" });
    expect(prompt).toContain(SERVE_SKILL_URL);
    expect(SERVE_SKILL_URL).toBe("https://github.com/Parcha-ai/agentrun/tree/main/packages/serve/skills/agentrun-serve");
    for (const doc of [`${location.origin}/llms.txt`, `${api}/openapi.json`, `${api}/capabilities`, `${api}/mcp`]) expect(prompt).toContain(doc);
    expect(prompt).toContain("Idempotency-Key");
    expect(prompt).toContain(`console (${location.origin}/)`);
  });

  it("edit: the agent at the page's revision, read first, saved with If-Match on PUT .../definition", () => {
    const prompt = codingAgentPrompt({ kind: "edit", agentId: "citer", revision: "r1" }, "/v2");
    expect(contextOf(prompt)).toEqual({ server: `${location.origin}/v2`, operation: "PUT /v2/agents/citer/definition", agent_id: "citer", revision: "r1" });
    expect(prompt).toContain("GET /v2/agents/citer and keep its ETag");
    expect(prompt).toContain("If-Match");
    expect(prompt).toContain("412 precondition_failed");
  });

  it("run: pinned to the revision, with the input and effort typed, and one Idempotency-Key", () => {
    const prompt = codingAgentPrompt({ kind: "run", agentId: "citer", revision: "r1", input: { content: "Check this." }, effort: "high" }, "/v2");
    expect(contextOf(prompt)).toEqual({ server: `${location.origin}/v2`, operation: "POST /v2/agents/citer/runs", agent_id: "citer", revision: "r1", request: { input: { content: "Check this." }, effort: "high", revision: "r1" } });
    expect(prompt).toContain("Idempotency-Key");
    expect(prompt).toContain("Do not add a spending cap");
  });

  it("run with nothing typed yet: the request holds only the revision", () => {
    expect(contextOf(codingAgentPrompt({ kind: "run", agentId: "citer", revision: "r1" }, "/v2")).request).toEqual({ revision: "r1" });
  });

  it.each([
    ["https://server.example", "https://server.example", ""],
    ["", location.origin, ""],
    ["https://server.example/proxy/v2/", "https://server.example/proxy/v2", "/proxy/v2"],
    ["https://server.example/native-api/", "https://server.example/native-api", "/native-api"],
    ["/native-api", `${location.origin}/native-api`, "/native-api"],
    ["native-api", `${location.origin}/console/native-api`, "/console/native-api"],
  ])("at %s: the route under the endpoint's path, and no credential the address held", (endpoint, api, path) => {
    history.replaceState(null, "", "/console/");
    const address = new URL(endpoint, location.href);
    address.username = "owner"; address.password = "secret";
    address.search = "?token=private"; address.hash = "credential";
    const source = endpoint.startsWith("https:") ? address.href : endpoint ? `${endpoint}${address.search}${address.hash}` : "";
    const prompt = codingAgentPrompt({ kind: "run", agentId: "citer /", revision: "r1", input: { content: "Check this." } }, source, `${address.href}`);
    expect(contextOf(prompt)).toEqual({ server: api, operation: `POST ${path}/agents/citer%20%2F/runs`, agent_id: "citer /", revision: "r1", request: { input: { content: "Check this." }, revision: "r1" } });
    expect(prompt).toContain(`${api}/openapi.json`);
    // llms.txt and MCP are named only where the endpoint is the server's own /v2.
    expect(prompt.includes("/llms.txt")).toBe(path.endsWith("/v2"));
    expect(prompt.includes("/mcp")).toBe(path.endsWith("/v2"));
    for (const secret of ["owner:", "secret", "token=private", "#credential"]) expect(prompt).not.toContain(secret);
  });

  it("names no credential and no token value, only that the coding agent signs in on its own", () => {
    for (const kind of ["create", "edit", "run"] as const) {
      const prompt = codingAgentPrompt(kind === "create" ? { kind } : { kind, agentId: "a", revision: "r" }, "/v2");
      expect(prompt).not.toMatch(/Bearer\s+\S|ar_live_|AGENTRUN_API_KEY=|AGENTRUN_TOKEN=/);
      expect(prompt).toContain("Never print a credential");
    }
  });
});

describe("apiOf", () => {
  it("keeps only the origin and the path, without a trailing slash", () => {
    expect(apiOf("https://u:p@server.example/v2/?q=1#h")).toEqual({ origin: "https://server.example", path: "/v2", api: "https://server.example/v2" });
  });
});

describe("the application this browser keeps", () => {
  it("is Claude Code's app until one is picked, then the one picked, under its own key", () => {
    expect(savedCodingAgent()).toBe("claude");
    saveCodingAgent("codex-cli");
    expect(localStorage.getItem(CODING_AGENT_KEY)).toBe("codex-cli");
    expect(savedCodingAgent()).toBe("codex-cli");
  });
  it("ignores a value it does not know", () => {
    localStorage.setItem(CODING_AGENT_KEY, "something-else");
    expect(savedCodingAgent()).toBe("claude");
  });
  it("works with storage disabled: reads the default and keeps nothing, without throwing", () => {
    const refusing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(savedCodingAgent(refusing)).toBe("claude");
    expect(() => saveCodingAgent("codex", refusing)).not.toThrow();
    expect(savedCodingAgent(null)).toBe("claude");
    expect(() => saveCodingAgent("codex", null)).not.toThrow();
  });
});
