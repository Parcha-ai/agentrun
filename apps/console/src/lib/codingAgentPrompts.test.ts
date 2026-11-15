import { describe, expect, it } from "vitest";
import { applyTemplatePrompt, buildAgentPrompt, connectAgentPrompt, connectExistingAgentsPrompt, connectRemoteAgentsPrompt, editAgentPrompt, importAgentsPrompt, playgroundPrompt, queryRunsPrompt, runAgentPrompt, runTemplatePrompt } from "./codingAgentPrompts";
import type { TemplateView } from "./v2";

const template: TemplateView = {
  id: "review/kit", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "review/kit", display_name: "Review kit", version: "1.2.0", description: "Review changes using the package's skills.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, mcp: [], secrets: [], budget: null, learning: true, approvals_default: "ask", triggers: [], skills: ["review"], evals: [],
  parameters: { type: "object", additionalProperties: false, required: ["repo"], properties: { repo: { type: "string", description: "Repository to review" } } },
};

describe("coding-agent handoffs", () => {
  it("reads every setup handoff's skill from the selected server build", () => {
    const origin = "https://console.example.test:9443/path?ignored=1#/agents";
    const prompts = [
      buildAgentPrompt(origin), applyTemplatePrompt(origin, template), runTemplatePrompt(origin, template),
      editAgentPrompt(origin, "reviewer"), runAgentPrompt(origin, "reviewer"), queryRunsPrompt(origin),
      playgroundPrompt(origin, "reviewer", { input: { content: "Review the release." } }), connectAgentPrompt(origin),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("https://console.example.test:9443/skills/agentrun-serve/SKILL.md");
      expect(prompt).not.toContain("raw.githubusercontent.com");
      expect(prompt).not.toContain("ignored=1");
    }
  });
  it("uses one skill-directed Connect agent handoff to clarify live connection or history and the source machine", () => {
    const prompt = connectExistingAgentsPrompt("https://console.example.test");
    expect(prompt).toContain("https://console.example.test/skills/agentrun-serve/SKILL.md");

    expect(prompt).toContain("connect for AgentRun-triggered jobs");
    expect(prompt).toContain("import history, or both");

    expect(prompt).toMatch(/source machine, project, runtime/);
    expect(prompt).toContain("https://console.example.test/v2");
    expect(prompt).toMatch(/approval.*history scope/);
    expect(prompt).toContain("Never print credentials");
    expect(prompt).not.toContain("hosted native pairing is unavailable");
    expect(prompt.split(/\s+/).length).toBeLessThanOrEqual(150);
  });

  it("hands remote setup to the matching connector build without putting a credential into the prompt", () => {
    const prompt = connectRemoteAgentsPrompt("https://console.example.test");
    expect(prompt).toContain("same reviewed build");
    expect(prompt).toContain("secure terminal prompt");
    expect(prompt).toContain("one-use connection code");
    expect(prompt).toMatch(/History is scoped.*project\/runtime/);
    expect(prompt).toMatch(/history only when requested and approved after preview/);
    expect(prompt).toContain("Keep self-improvement Off unless I request it");
    expect(prompt).toContain("Ask before a paid run");
    expect(prompt).not.toContain("--api-key");
    expect(prompt).not.toContain("npx");
    expect(prompt.split(/\s+/).length).toBeLessThanOrEqual(150);
  });

  it("targets the current server without carrying credentials or page parameters into the prompt", () => {
    // Build the credential-bearing input at runtime: the repository's session-import scan must not
    // mistake a literal credential URL in this regression for a secret printed by a coding agent.
    const address = new URL("https://console.example.test/?token=also-private#/agents");
    address.username = "owner";
    address.password = "not-a-secret";
    for (const make of [importAgentsPrompt, connectAgentPrompt, buildAgentPrompt, queryRunsPrompt, connectExistingAgentsPrompt, connectRemoteAgentsPrompt]) {
      const prompt = make(address.href);
      expect(prompt).toContain("https://console.example.test/v2");
      expect(prompt).not.toContain("not-a-secret");
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

  it("uses scoped history-only enrollment for a remote destination without substituting a local store", () => {
    const prompt = importAgentsPrompt("https://console.example.test");
    expect(prompt).toContain("remote");
    expect(prompt).toContain("history only: no executing worker or self-improvement");
    expect(prompt).toMatch(/code at https:\/\/console\.example\.test\/.*source=remote with the matching scope/);
    expect(prompt).toMatch(/history only when requested and approved after preview/);
    expect(prompt).toContain("https://console.example.test/v2 only");
    expect(prompt).not.toContain("import --data");
    expect(prompt).not.toContain("POST /v2/import");
  });

  it("carries the selected connection scope into the shared handoff without broadening it", () => {
    expect(connectRemoteAgentsPrompt("https://console.example.test", "live")).toContain("live agent connection, without past history");
    expect(connectRemoteAgentsPrompt("https://console.example.test", "history")).toContain("history only: no executing worker or self-improvement");
    expect(connectRemoteAgentsPrompt("https://console.example.test", "both")).toContain("both a live agent connection and past history");
  });

  it("requires an approved maintenance window before the CLI takes the running server's store", () => {
    const prompt = importAgentsPrompt("http://localhost:7340");
    expect(prompt).toContain("CLI write import requires exclusive store ownership");
    expect(prompt).toContain("dry run may read the store while the server runs");
    expect(prompt).toContain("AGENTRUN_STORE_URL");
    expect(prompt).toContain("AGENTRUN_STORE_SCHEMA");
    expect(prompt).toContain("Inspect active and queued runs and enabled triggers");
    expect(prompt).toContain("explicit approval for both the import and the stop/restart");
    expect(prompt).toContain("Do not interrupt active work without separate approval");
    expect(prompt).toContain("stop after the dry run and explain what the operator must do");
    expect(prompt).toContain("Gracefully stop the existing server and its runners through that supervisor");
    expect(prompt).toContain("wait for the store owner to release its lock");
    expect(prompt).toContain("Do not delete locks or bypass ownership");
    expect(prompt).toContain("restart the same service even if the import fails");
    expect(prompt).toContain("Do not reset the owner or reuse setup to force another import");
    const dryRun = prompt.indexOf('import --data "$AGENTRUN_DATA_DIR" --dry-run');
    const approval = prompt.indexOf("explicit approval for both the import and the stop/restart");
    const stop = prompt.indexOf("Gracefully stop");
    const apply = prompt.indexOf("run the agreed import without --dry-run");
    const restart = prompt.indexOf("restart the same service even if the import fails");
    expect(dryRun).toBeLessThan(approval);
    expect(approval).toBeLessThan(stop);
    expect(stop).toBeLessThan(apply);
    expect(apply).toBeLessThan(restart);
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

  it("copies the exact canonical package instead of reconstructing an agent from its catalog description", () => {
    const prompt = applyTemplatePrompt("https://console.example.test", template);
    expect(prompt).toContain('template "review/kit", version "1.2.0"');
    expect(prompt).toContain("GET https://console.example.test/v2/templates");
    expect(prompt).toContain("POST https://console.example.test/v2/templates/review%2Fkit/apply");
    expect(prompt).toContain("if the version differs");
    expect(prompt).toContain("instructions, rules, skills, schemas, learning and triggers");
    expect(prompt).toContain("Do not rebuild it from the description");
    expect(prompt).toContain("missing parameter values");
    expect(prompt).toContain("parameters, grants, servers and overrides");
    expect(prompt).toContain("idempotency key");
    expect(prompt).toContain("Do not start a run");
    expect(prompt).toContain("Never print credentials");
  });

  it("clarifies additional requirements and reserves unsupported changes for an explicit revision", () => {
    const prompt = applyTemplatePrompt("https://console.example.test", template, "  Report security findings only.  ");
    expect(prompt).toContain("My additional requirements:\nReport security findings only.");
    expect(prompt).toContain("do not add a brief or instructions field to the apply body");
    expect(prompt).toContain("separately approved revision after applying");
    expect(prompt).toContain("If-Match");
    expect(applyTemplatePrompt("https://console.example.test", template, "  ")).not.toContain("My additional requirements");
  });

  it("runs the canonical package with the selected setup and existing consent, asking only for missing task inputs", () => {
    const selection = { parameters: { repo: "acme/web" }, grants: [], overrides: { approvals: "ask" as const } };
    const before = JSON.stringify(selection);
    const prompt = runTemplatePrompt("https://console.example.test", template, selection);
    expect(prompt).toContain('template "review/kit", version "1.2.0"');
    expect(prompt).toContain("/v2/templates/review%2Fkit/apply");
    expect(prompt).toContain("instructions, rules, skills, schemas, learning and triggers");
    expect(prompt).toContain(JSON.stringify(selection, null, 2));
    expect(prompt).toContain("Ask for missing run inputs, files or output requirements");
    expect(prompt).toContain("Carry out my requested run with the permissions already given");
    expect(prompt).toContain("without adding a cap unless I asked for one");
    expect(prompt).toContain("Do not add tool grants or broaden approvals");
    expect(prompt).toContain("/v2/agents/{created_agent_id}/runs");
    expect(prompt).toContain("avoid duplicating a task already started by a trigger");
    expect(prompt).toContain("reconcile an uncertain response before retrying");
    expect(prompt).toContain("Never print credentials");
    expect(prompt).not.toContain("Do not start a run");
    expect(JSON.stringify(selection)).toBe(before);
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
