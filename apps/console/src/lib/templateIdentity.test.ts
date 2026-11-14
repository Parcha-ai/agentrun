import { describe, expect, it } from "vitest";
import { applyTemplatePrompt } from "./codingAgentPrompts";
import { readTemplateDraft, templatePlaygroundHref } from "./templatePackages";
import type { TemplateApply, TemplateView } from "./v2";

const bundled: TemplateView = {
  id: "kyb", name: "kyb", display_name: "KYB", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  version: "1.0.0", description: "Checks a business.", license: "MIT", author: null, repository: null, output: null,
  harness: ["pi"], model: { tier: "balanced" }, effort: null, tools: null, tool_policy: null, computer: null, computer_here: null, checkout: null,
  mcp: [], input_schema: null, parameters: { type: "object", additionalProperties: false, required: ["companies"], properties: { companies: { type: "array", items: { type: "string" }, description: "Companies" } } },
  secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
};
const imported: TemplateView = {
  ...bundled, id: "github:acme/agents/templates/kyb", bundled: false, source: "github:acme/agents/templates/kyb@main",
  sha: "0123456789abcdef0123456789abcdef01234567", publisher: "acme",
};
const body: TemplateApply = { parameters: { companies: ["Acme", "Example"] }, overrides: { approvals: "ask" } };
const draftOf = (template: TemplateView) => new URLSearchParams(templatePlaygroundHref(template, body).split("?")[1]).get("draft")!;

describe("a template package's operation identity", () => {
  it("keeps the full GitHub id and exact setup values through a copied playground link", () => {
    const query = new URLSearchParams(templatePlaygroundHref(imported, body).split("?")[1]);
    expect(query.get("template")).toBe(imported.id);
    expect(JSON.parse(query.get("draft")!)).toMatchObject({ template: imported.id, version: imported.version, sha: imported.sha, body });
    expect(readTemplateDraft(query.get("draft")!, imported)).toEqual({ body });
  });

  it("refuses another package's draft even when its name and version match", () => {
    expect(readTemplateDraft(draftOf(bundled), imported).error).toBeTruthy();
    expect(readTemplateDraft(draftOf(imported), { ...imported, id: "github:other/agents/templates/kyb" }).error).toBeTruthy();
  });

  it("asks the coding agent to select the imported id and reviewed commit, and apply that id", () => {
    const prompt = applyTemplatePrompt("https://agents.example.test", imported);
    expect(prompt).toContain(JSON.stringify(imported.id));
    expect(prompt).toContain(imported.sha!);
    expect(prompt).toContain("/v2/templates/" + encodeURIComponent(imported.id) + "/apply");
    expect(prompt).not.toContain("/v2/templates/kyb/apply");
    expect(prompt).toContain("Do not start a run.");
  });

  it("requires review again when the installed commit changes without a version change", () => {
    const changed = { ...imported, sha: "abcdef0123456789abcdef0123456789abcdef01" };
    expect(readTemplateDraft(draftOf(imported), changed).error).toMatch(/commit|package/i);
  });
});
