import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, route } from "./App";
import { pick, picker } from "@/test/picker";
import { agentFixture } from "@/fixtures";
import type { TemplateView } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const template: TemplateView = {
  name: "review-kit", display_name: "Review kit", version: "1.2.0", description: "Review changes with the package's checked skills.",
  license: null, author: null, repository: null, output: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, computer_here: null, checkout: null, mcp: [], secrets: [], budget: null, learning: true, approvals_default: "ask", triggers: [], skills: ["review"], evals: [],
  parameters: { repo: { type: "string", required: true, description: "Repository to review" } },
};
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

async function open(hash: string) {
  const writes: { path: string; body: unknown; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://console.example.test").pathname;
    if (init?.method && init.method !== "GET") {
      writes.push({ path, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return json({ template: template.name, version: template.version, agent_id: "new-reviewer", trigger_ids: [], warnings: [] }, 201);
    }
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: true });
    if (path === "/v2/setup/import") return json({ offer: false });
    if (path === "/v2/capabilities") return json({ harnesses: [], models: { ready: false, needs: "key" }, features: {} });
    if (path === "/v2/templates") return json({ templates: [template] });
    if (path === "/v2/settings/mcp-servers") return json({ servers: [] });
    if (path === "/v2/agents") return json({ agents: [], next_cursor: null });
    if (path === "/v2/agents/new-reviewer") return json({ ...agentFixture("invoice-checker"), agent_id: "new-reviewer" });
    if (path === "/v2/stats") return json({ error: { code: "not_found", message: "No analytics" } }, 404);
    return json({ runs: [], next_cursor: null });
  });
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await settle();
  return { host, writes };
}

describe("template requests in the API playground", () => {
  it("keeps only the selected template when routing an apply request", () => {
    expect(route("#/playground?operation=apply-template&template=review%20kit&agent=old&draft=%7B%7D&status=failed&archived=true"))
      .toEqual({ section: "playground", operation: "apply-template", template: "review kit" });
    expect(route("#/playground?operation=apply-template")).toEqual({ section: "playground", operation: "apply-template" });
    expect(route("#/playground?operation=create-agent&template=review-kit")).toEqual({ section: "playground", operation: "create-agent" });
  });

  it("opens the real package form and sends its parameters only when Apply is clicked", async () => {
    const { host, writes } = await open("#/playground?operation=apply-template&template=review-kit");
    expect(host.textContent).toContain("/v2/templates/review-kit/apply");
    expect(host.textContent).toContain("Review kit");
    expect(host.textContent).not.toContain("No model yet");
    expect(writes).toEqual([]);
    const field = host.querySelector<HTMLInputElement>('[data-field="parameters.repo"] input')!;
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "example/project");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Apply")!;
    await act(async () => apply.click());
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/v2/templates/review-kit/apply");
    expect(writes[0].body).toEqual({ parameters: { repo: "example/project" }, overrides: { approvals: "ask" } });
    expect(writes[0].headers.get("idempotency-key")).toBeTruthy();
    expect(location.hash).toBe("#/agents/new-reviewer");
  });

  it("keeps the template catalog in the playground and drops stale fields when switching operation", async () => {
    const { host, writes } = await open("#/playground?operation=apply-template");
    expect(host.textContent).toContain("/v2/templates/{template}/apply");
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Apply")!;
    await act(async () => apply.click()); await settle();
    expect(location.hash).toBe("#/playground?operation=apply-template&template=review-kit");
    expect(host.querySelector('a[href="#/playground?operation=apply-template"]')).not.toBeNull();
    await pick(picker(host, "API operation")!, "create-agent"); await settle();
    expect(location.hash).toBe("#/playground?operation=create-agent");
    await pick(picker(host, "API operation")!, "apply-template"); await settle();
    expect(location.hash).toBe("#/playground?operation=apply-template");
    expect(writes).toEqual([]);
  });
});
