import { describe, expect, it } from "vitest";
import { readTemplateDraft, templatePlaygroundHref } from "./templatePackages";
import type { TemplateView } from "./v2";

const template: TemplateView = { id: "review/kit", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [], name: "review/kit", display_name: "Review kit", version: "2.0.0", description: "Review a pull request.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
  parameters: { type: "object", additionalProperties: false, required: ["repo"], properties: { repo: { type: "string", description: "Repository" }, comment: { type: "boolean", description: "Comment", default: true } } },
  mcp: [{ source: "github", toolkit: "github", required: true, reason: null, tools: [{ name: "read", tool: "mcp:github/read", asks: "allow" }] }] };
const body = { parameters: { repo: "acme/web", comment: false }, grants: ["mcp:github/read"], overrides: { approvals: "ask" as const } };
const raw = (patch: object = {}) => JSON.stringify({ template: template.name, version: template.version, body, ...patch });

describe("a prepared template request", () => {
  it("round trips scalar array parameters and refuses values the line-based form would change", () => {
    const lists: TemplateView = { ...template, parameters: { type: "object", additionalProperties: false, required: ["names", "counts", "flags"], properties: {
      names: { type: "array", items: { type: "string" }, description: "Names" },
      counts: { type: "array", items: { type: "integer" }, description: "Counts" },
      flags: { type: "array", items: { type: "boolean" }, description: "Flags" },
    } } };
    const body = { parameters: { names: ["alpha", "beta"], counts: [1, 2], flags: [true, false] }, overrides: { approvals: "ask" as const } };
    const draft = (parameters = body.parameters) => JSON.stringify({ template: lists.name, version: lists.version, body: { ...body, parameters } });
    expect(readTemplateDraft(draft(), lists)).toEqual({ body });
    for (const names of [["alpha\nbeta"], [" alpha "], [""], [["alpha"]], [false]]) {
      expect(readTemplateDraft(draft({ ...body.parameters, names } as never), lists).error).toBeTruthy();
    }
  });

  it("round trips the exact parameters and consent in the fragment without a server URL query", () => {
    const href = templatePlaygroundHref(template, body);
    expect(href.startsWith("#/playground?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("operation")).toBe("apply-template");
    expect(params.get("template")).toBe(template.name);
    expect(readTemplateDraft(params.get("draft")!, template)).toEqual({ body });
    expect(readTemplateDraft(undefined, template)).toEqual({});
  });

  it("rejects malformed, different-package and stale requests without keeping partial choices", () => {
    for (const invalid of ["", "null", "[]", "{", raw({ template: "other" }), raw({ version: "1.0.0" }),
      raw({ body: { ...body, instructions: "Replace the original package" } }),
      raw({ body: { ...body, parameters: { secret_value: "unexpected" } } }),
      raw({ body: { ...body, grants: ["mcp:other/write"] } }),
      raw({ body: { ...body, overrides: { approvals: "sometimes" } } }),
      raw({ body: { ...body, overrides: { approvals: ["never"] } } }),
      raw({ body: { ...body, overrides: { approvals: ["ask"] } } }),
      raw({ body: { ...body, overrides: { approvals: "ask", tools: ["shell"] } } }),
      raw({ body: { ...body, parameters: { comment: "false" } } }),
      raw({ body: { ...body, parameters: { repo: 3 } } }),
      raw({ body: { ...body, parameters: { repo: { input: "acme/web" } } } })]) {
      const result = readTemplateDraft(invalid, template);
      expect(result.error, invalid).toBeTruthy();
      expect(result.body, invalid).toBeUndefined();
    }
  });
});
