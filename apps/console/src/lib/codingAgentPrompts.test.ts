import { describe, expect, it } from "vitest";
import { buildAgentPrompt, connectAgentPrompt, editAgentPrompt, importAgentsPrompt, playgroundPrompt, queryRunsPrompt, runAgentPrompt } from "./codingAgentPrompts";

describe("coding-agent handoffs", () => {
  it("targets the current server without carrying credentials or page parameters into the prompt", () => {
    for (const make of [importAgentsPrompt, connectAgentPrompt, buildAgentPrompt, queryRunsPrompt]) {
      const prompt = make("https://owner:do-not-copy@console.example.test/?token=also-private#/agents");
      expect(prompt).toContain("https://console.example.test/v2");
      expect(prompt).not.toContain("do-not-copy");
      expect(prompt).not.toContain("also-private");
      expect(prompt).toContain("agentrun-serve");
      expect(prompt).toContain("Never print credentials");
      expect(prompt).not.toContain("/api/v2");
    }
    expect(() => importAgentsPrompt("javascript:alert(1)")).toThrow();
  });

  it("imports into the selected local instance after checking the source and actual data directory", () => {
    const prompt = importAgentsPrompt("http://127.0.0.1:7342");
    expect(prompt).toContain("http://127.0.0.1:7342/v2");
    expect(prompt).toContain("loopback");
    expect(prompt).toContain("same machine");
    expect(prompt).toContain("actual --data directory");
    expect(prompt).toContain('import --data "$AGENTRUN_DATA_DIR" --dry-run');
    expect(prompt).toContain("Claude Code, Codex and pi");
    expect(prompt).toContain("No model-provider key");
    expect(prompt).toContain("historical");
    expect(prompt).toContain("last 10 minutes");
    expect(prompt).not.toContain("~/.agentrun");
  });

  it("does not suggest that a remote console can import this computer through an unsupported endpoint", () => {
    const prompt = importAgentsPrompt("https://console.example.test");
    expect(prompt).toContain("remote");
    expect(prompt).toContain("local CLI import does not upload");
    expect(prompt).toContain("no remote session-import API");
    expect(prompt).toContain("Do not transfer transcripts");
    expect(prompt).toContain("confirm the destination");
    expect(prompt).not.toContain("POST /v2/import");
  });

  it("connects the existing coding agent without implying that MCP monitors that agent", () => {
    const prompt = connectAgentPrompt("https://console.example.test");
    expect(prompt).toContain("https://console.example.test/v2/mcp");
    expect(prompt).toContain("whoami");
    expect(prompt).toContain("does not enable live monitoring");
    expect(prompt).toContain("Do not start a run");
  });

  it("asks for a useful agent definition while keeping paid execution a separate action", () => {
    const prompt = buildAgentPrompt("http://localhost:7340");
    expect(prompt).toContain("inputs, expected outputs");
    expect(prompt).toContain("tools");
    expect(prompt).toContain("existing agents");
    expect(prompt).toContain("approval");
    expect(prompt).toContain("Do not start a run");
  });

  it("carries the user's build brief and preserves the supplied template definition", () => {
    const definition = { version: 1 as const, name: "Page reader", instructions: "Read the page and cite it.", harness: "pi" as const, tools: ["web_fetch"], skills: [] as [] };
    const prompt = buildAgentPrompt("http://localhost:7340", "Keep the summary under 200 words.", { definition });
    expect(prompt).toContain("Keep the summary under 200 words.");
    expect(prompt).toContain(JSON.stringify({ definition }, null, 2));
    expect(prompt).toContain("Preserve the template's instructions, tools and skills");
    expect(prompt).toContain("Ask only the missing questions");
    expect(prompt).toContain("Do not start a run");
  });

  it("edits the exact agent using a new revision and preserves unrelated configuration", () => {
    const prompt = editAgentPrompt("https://console.example.test", "support/a?b");
    expect(prompt).toContain("/v2/agents/support%2Fa%3Fb");
    expect(prompt).toContain("current revision");
    expect(prompt).toContain("If-Match");
    expect(prompt).toContain("Preserve unrelated");
    expect(prompt).toContain("Do not start a run");
  });

  it("scopes a query to its agent when supplied, otherwise includes every source of runs", () => {
    const all = queryRunsPrompt("https://console.example.test");
    expect(all).toContain("/v2/runs");
    expect(all).toContain("imported history");
    expect(all).toContain("read-only");
    expect(all).toContain("pagination");
    const scoped = queryRunsPrompt("https://console.example.test", "support/a");
    expect(scoped).toContain("/v2/agents/support%2Fa/runs");
    expect(scoped).toContain('agent "support/a"');
  });

  it("prepares a run of the selected agent without silently starting a paid job", () => {
    const prompt = runAgentPrompt("https://console.example.test", "support/a");
    expect(prompt).toContain("/v2/agents/support%2Fa");
    expect(prompt).toContain("current revision");
    expect(prompt).toContain("required input, files");
    expect(prompt).toContain("approval before starting");
    expect(prompt).toContain("Start once");
  });

  it("hands off exactly the playground's prepared body, including files and pinned revision", () => {
    const body = { input: { content: "Read my files.\nKeep their order." }, revision: "rev-2", file_ids: ["file-2", "file-1"], effort: "high", max_cost_usd: 0.5 };
    const before = JSON.stringify(body);
    const prompt = playgroundPrompt("https://console.example.test", "support/a", body);
    expect(prompt).toContain("POST https://console.example.test/v2/agents/support%2Fa/runs");
    expect(prompt.endsWith(JSON.stringify(body, null, 2))).toBe(true);
    expect(JSON.stringify(body)).toBe(before);
    expect(prompt).toContain("approval to execute");
    expect(prompt).toContain("idempotency key");
    expect(prompt).toContain("reconcile that same request");
  });
});
