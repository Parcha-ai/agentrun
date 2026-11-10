import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TemplatesPage } from "./Templates";
import { ClientError } from "@/lib/client";
import type { TemplateView } from "@/lib/v2";
import { picker, pick } from "@/test/picker";

// A template's Apply form names a field by the label it shows, never its raw path ("parameters.risk_appetite"), and an
// issue goes once the field's value is valid: under the field, and the summary beside Apply once no issue is left.
// Issues are placed by the served `field`, never by their words.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const KYB: TemplateView = {
  name: "kyb", display_name: "KYB", version: "1.0.0", description: "Checks a business.", license: "MIT", author: null, repository: null, output: null,
  harness: ["pi"], model: { tier: "balanced" }, effort: null, tools: null, mcp: [],
  parameters: {
    risk_appetite: { type: "string", required: true, description: "How much risk to accept", enum: ["low", "medium", "high"] },
    company: { type: "string", required: true, description: "The company's legal name" },
    depth: { type: "integer", required: false, description: "How many sources to read" },
  },
  secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
};
const refusal = (fields: { field: string; reason: string; message: string }[]) => Object.assign(new ClientError(422, "input_invalid", "The template's input is not valid."), { fields });

async function open(apply: () => Promise<unknown>) {
  const v2 = { listTemplates: async () => ({ templates: [KYB] }), listMcpServers: async () => ({ servers: [] }), applyTemplate: async () => apply() };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(TemplatesPage, { v2: v2 as never, name: "kyb", go: () => {} })); });
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const apply_ = async () => { await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Apply")!.click(); }); await settle(); };
  const type = async (field: string, value: string) => {
    const el = host.querySelector(`[data-field="${field}"] input`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const at = (field: string) => host.querySelector(`[data-field="${field}"]`)!.textContent ?? "";
  const summary = () => host.querySelector('p[role="alert"]')?.textContent ?? null;
  return { host, apply: apply_, type, at, summary, settle };
}

describe("a template's Apply form, a refused parameter", () => {
  it("names the field by its label, never its raw path", async () => {
    const t = await open(async () => { throw refusal([{ field: "parameters.risk_appetite", reason: "missing", message: "parameters.risk_appetite is required: How much risk to accept" }]); });
    await t.apply();
    expect(t.at("parameters.risk_appetite")).toContain("risk_appetite is required.");
    expect(t.host.textContent).not.toContain("parameters.risk_appetite");
  });

  it("an issue goes once its field's value is valid, and the summary beside Apply with the last of them", async () => {
    const t = await open(async () => { throw refusal([
      { field: "parameters.risk_appetite", reason: "missing", message: "parameters.risk_appetite is required: How much risk to accept" },
      { field: "parameters.company", reason: "missing", message: "parameters.company is required: The company's legal name" },
    ]); });
    await t.apply();
    expect(t.summary()).toBe("The template's input is not valid.");
    await pick(picker(t.host, "risk_appetite")!, "medium");
    await t.settle();
    expect(t.at("parameters.risk_appetite")).not.toContain("is required");
    // One issue is left: the summary stays.
    expect(t.summary()).toBe("The template's input is not valid.");
    await t.type("parameters.company", "Acme Ltd");
    expect(t.at("parameters.company")).not.toContain("is required");
    expect(t.summary()).toBeNull();
  });

  it("an invalid value keeps its issue: a number field typed with letters", async () => {
    const t = await open(async () => { throw refusal([{ field: "parameters.depth", reason: "wrong_type", message: "parameters.depth is a integer: How many sources to read" }]); });
    await t.apply();
    expect(t.at("parameters.depth")).toContain("depth takes a whole number.");
    await t.type("parameters.depth", "2.5");
    expect(t.at("parameters.depth")).toContain("depth takes a whole number.");
    await t.type("parameters.depth", "3");
    expect(t.at("parameters.depth")).not.toContain("whole number");
  });

  it("places an issue by its served field, whatever its words name", async () => {
    const t = await open(async () => { throw refusal([{ field: "parameters.company", reason: "missing", message: "parameters.risk_appetite is required: words naming another field" }]); });
    await t.apply();
    expect(t.at("parameters.company")).toContain("company is required.");
    expect(t.at("parameters.risk_appetite")).not.toContain("required.");
  });
});
