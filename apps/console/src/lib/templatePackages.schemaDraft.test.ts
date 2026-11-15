import { expect, it } from "vitest";
import { readTemplateDraft, templatePlaygroundHref } from "./templatePackages";
import { fieldValues, schemaFields } from "./inputForm";
import type { TemplateApply, TemplateView } from "./v2";

const template: TemplateView = { id: "github:acme/review-kit", bundled: false, source: "github:acme/review-kit@main", sha: "a".repeat(40), publisher: "acme", category: null, tags: [], name: "review-kit", display_name: "Review kit", version: "2.0.0", description: "Review changes.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
  parameters: { type: "object", additionalProperties: false, required: ["repo", "names", "counts", "flags"], properties: {
    repo: { type: "string" }, flag: { type: "boolean", default: true }, count: { type: "integer", default: 0 }, note: { type: "string", default: "fallback" },
    names: { type: "array", items: { type: "string" } }, counts: { type: "array", items: { type: "integer" } }, flags: { type: "array", items: { type: "boolean" } },
  } },
  mcp: [{ source: "url", toolkit: "crm", required: true, reason: null, tools: [{ name: "read", tool: "mcp:crm/read", asks: "allow" }] }] };
const body: TemplateApply = { parameters: { repo: "acme/web", flag: false, count: 0, names: ["alpha", "beta"], counts: [0, 2], flags: [false, true] }, grants: ["mcp:crm/read"], servers: { crm: "crm-work" }, overrides: { approvals: "never" } };
const raw = (parameters: Record<string, unknown> = body.parameters!) => JSON.stringify({ template: template.id, version: template.version, sha: template.sha, body: { ...body, parameters } });

it("restores compiled-schema scalar and array parameters with exact consent, server and imported identity", () => {
  const params = new URLSearchParams(templatePlaygroundHref(template, body).split("?")[1]);
  expect(params.get("template")).toBe(template.id);
  expect(readTemplateDraft(params.get("draft")!, template)).toEqual({ body });
});

it("omits known blank parameters for server defaults while retaining false and zero", () => {
  expect(readTemplateDraft(raw({ ...body.parameters, note: "" }), template)).toEqual({ body });
});

it("preserves whitespace-only scalar strings through draft restoration and shared field conversion", () => {
  const parameters = { ...body.parameters, note: "  " };
  const restored = readTemplateDraft(raw(parameters), template);
  expect(restored).toEqual({ body: { ...body, parameters } });
  const text = Object.fromEntries(Object.entries(restored.body!.parameters!).map(([key, value]) => [key, Array.isArray(value) ? value.map(String).join("\n") : String(value)]));
  expect(fieldValues({ fields: schemaFields(template.parameters)!, contentRequired: false }, text)).toEqual(parameters);
});

it("rejects unknown blank fields, unsafe scalar coercion and arrays the line form cannot preserve", () => {
  for (const patch of [{ typo: "" }, { flag: "false" }, { count: "0" }, { repo: 3 }, { names: "alpha" }, { counts: [0, "2"] }, { flags: [false, "true"] }, { names: [" alpha "] }, { names: ["alpha\nbeta"] }, { names: [""] }]) {
    const result = readTemplateDraft(raw({ ...body.parameters, ...patch }), template);
    expect(result.error, JSON.stringify(patch)).toBeTruthy();
    expect(result.body).toBeUndefined();
  }
});

it("continues to reject stale imports and mismatched package identities without partial choices", () => {
  for (const patch of [{ template: "github:other/review-kit" }, { version: "1.0.0" }, { sha: "b".repeat(40) }]) {
    const result = readTemplateDraft(JSON.stringify({ ...JSON.parse(raw()), ...patch }), template);
    expect(result.error).toBeTruthy();
    expect(result.body).toBeUndefined();
  }
});
