import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRequest } from "./AgentRequest";
import { createClient } from "@/lib/client";
import { templateAgentDraft } from "@/lib/agentDraft";
import { TEMPLATES } from "@/lib/templates";
import type { Agent } from "@/lib/agentForm";
import { holdsMove } from "@/lib/useUnsavedChangesGuard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const origin = "https://console.example.test";
const existing: Agent = { agent_id: "support/a", kind: "agentic", revision: "rev-three", revisions: 5, archived_at: null, definition: {
  version: 3, name: "Support", description: "Answers support questions", instructions: "Answer carefully.", harness: "pi", model: "anthropic/example-model", tools: ["read", "web_fetch"], skills: ["support"], learning: true,
  tool_settings: { web_fetch: { provider: "kernel" } }, input_schema: { type: "object", properties: { ticket: { type: "string" } } },
} };
type Call = { path: string; method: string; body: unknown; headers: Headers };
const json = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
let root: Root | undefined;
let host: HTMLDivElement;
let calls: Call[];
const mount = async (props: Omit<ComponentProps<typeof AgentRequest>, "v2" | "origin">, answer: (call: Call) => Response | Promise<Response>) => {
  calls = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { path: new URL(url, origin).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(AgentRequest, { ...props, origin, v2: createClient({ fetch }) })));
};
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const control = (label: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`) ?? [...host.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const send = () => act(async () => button("Send request").click());
const writes = () => calls.filter((c) => c.method !== "GET");
const unloadAsks = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const answerLeave = async (answer: "Stay" | "Leave") => act(async () => {
  [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === answer)!.click();
});
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); });

describe("AgentRequest, local definition requests", () => {
  it("guards changed form fields on navigation and reload; Stay keeps them and Leave makes the held move", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, () => json(existing, 200, '"rev-three"'));
    expect(unloadAsks()).toBe(false);
    expect(holdsMove("#/runs")).toBe(false);
    type(control("Instructions"), "Include citations.");
    expect(unloadAsks()).toBe(true);
    let moves = 0;
    await act(async () => { expect(holdsMove("#/runs", () => { moves++; })).toBe(true); });
    expect(dialog()?.textContent).toContain("Your changes to this agent are not saved.");
    await answerLeave("Stay");
    expect(moves).toBe(0);
    expect(control("Instructions").value).toBe("Include citations.");
    expect(unloadAsks()).toBe(true);
    await act(async () => { expect(holdsMove("#/runs", () => { moves++; })).toBe(true); });
    await answerLeave("Leave");
    expect(moves).toBe(1);
    expect(writes()).toEqual([]);
  });

  it("guards invalid JSON too and becomes clean when the original request is restored", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, () => json(existing, 200, '"rev-three"'));
    await act(async () => button("JSON").click());
    const original = control("Request JSON").value;
    type(control("Request JSON"), "{unfinished");
    expect(unloadAsks()).toBe(true);
    expect(button("Send request").disabled).toBe(true);
    type(control("Request JSON"), original);
    expect(unloadAsks()).toBe(false);
    expect(holdsMove("#/runs")).toBe(false);
  });

  it("keeps failed edits guarded and clears the guard after a successful save", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => call.method === "GET" ? json(existing, 200, '"rev-three"') : writes().length === 1
      ? json({ error: { code: "precondition_failed", message: "Revision changed", retryable: false } }, 412)
      : json({ ...existing, definition: (call.body as { definition: Agent["definition"] }).definition, revision: "rev-six", revisions: 6 }, 200, '"rev-six"'));
    type(control("Instructions"), "Include citations.");
    await send();
    expect(unloadAsks()).toBe(true);
    await send();
    expect(unloadAsks()).toBe(false);
    expect(holdsMove("#/runs")).toBe(false);
  });

  it("does not mark edits made during a pending save as saved", async () => {
    let finish!: (response: Response) => void;
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => call.method === "GET" ? json(existing, 200, '"rev-three"') : new Promise<Response>((resolve) => { finish = resolve; }));
    type(control("Instructions"), "First edit.");
    await send();
    type(control("Instructions"), "Later edit.");
    await act(async () => finish(json({ ...existing, definition: { ...existing.definition, version: 6, instructions: "First edit." }, revision: "rev-six", revisions: 6 }, 200, '"rev-six"')));
    expect(control("Instructions").value).toBe("Later edit.");
    expect(unloadAsks()).toBe(true);
    type(control("Instructions"), "First edit.");
    expect(unloadAsks()).toBe(false);
  });

  it("keeps the leave dialog available while a revision reload is pending or fails", async () => {
    let reads = 0;
    let finish!: (response: Response) => void;
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => call.method === "GET"
      ? ++reads === 1 ? json(existing, 200, '"rev-three"') : new Promise<Response>((resolve) => { finish = resolve; })
      : json({ error: { code: "precondition_failed", message: "Revision changed", retryable: false } }, 412));
    type(control("Instructions"), "Unsaved work.");
    await send();
    await act(async () => button("Reload current revision").click());
    expect(host.textContent).toContain("Loading the agent definition");
    let moves = 0;
    await act(async () => { expect(holdsMove("#/runs", () => { moves++; })).toBe(true); });
    expect(dialog()?.textContent).toContain("Leave without saving?");
    await answerLeave("Stay");
    expect(moves).toBe(0);
    await act(async () => finish(json({ error: { code: "unavailable", message: "Try again later", retryable: true } }, 503)));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Try again later");
    expect(unloadAsks()).toBe(true);
    await act(async () => { expect(holdsMove("#/runs", () => { moves++; })).toBe(true); });
    expect(dialog()?.textContent).toContain("Leave without saving?");
    await answerLeave("Leave");
    expect(moves).toBe(1);
    expect(writes()).toHaveLength(1);
  });

  it("guards a new agent's edits and clears them only after confirmed creation", async () => {
    const draft = templateAgentDraft(TEMPLATES[0]);
    await mount({ operation: "create-agent", draft: JSON.stringify(draft) }, (call) => json({ ...existing, agent_id: "created", definition: (call.body as { definition: Agent["definition"] }).definition }, 201));
    expect(unloadAsks()).toBe(false);
    type(control("Name"), "My new agent");
    expect(unloadAsks()).toBe(true);
    await send();
    expect(unloadAsks()).toBe(false);
    expect(holdsMove("#/agents/created")).toBe(false);
  });

  it("creates the exact template definition without a model key, only after Send, once", async () => {
    const draft = templateAgentDraft(TEMPLATES.find((t) => t.id === "web")!);
    await mount({ operation: "create-agent", draft: JSON.stringify(draft), harnesses: [{ id: "pi", available: false }] }, (call) => {
      expect(call.method).toBe("POST");
      return json({ ...existing, agent_id: "created", definition: draft.definition, revision: "rev-one", revisions: 1 }, 201);
    });
    expect(calls).toEqual([]);
    expect(button("Send request").disabled).toBe(false);
    await send();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ path: "/v2/agents", method: "POST", body: draft });
    expect(writes()[0].headers.get("authorization")).toBeNull();
    expect(button("Send request").disabled).toBe(true);
    await send();
    expect(writes()).toHaveLength(1);
    expect(host.querySelector('a[href="#/agents/created"]')?.textContent).toContain("Open agent");
  });

  it("refuses invalid JSON and sends all supplied JSON fields unchanged once corrected", async () => {
    await mount({ operation: "create-agent" }, () => json({ ...existing, agent_id: "new" }, 201));
    await act(async () => button("JSON").click());
    type(control("Request JSON"), "{bad");
    expect(button("Send request").disabled).toBe(true);
    await send();
    expect(writes()).toEqual([]);
    expect(host.textContent).toContain("Enter valid JSON");
    const body = { definition: { ...existing.definition, version: 1 }, skills: { "support/SKILL.md": "# Support\nCheck sources." } };
    type(control("Request JSON"), JSON.stringify(body));
    await send();
    expect(writes()[0].body).toEqual(body);
    expect(writes()[0].path).toBe("/v2/agents");
  });

  it("loads edits without mutation and preserves unrelated fields under the read ETag", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => call.method === "GET" ? json(existing, 200, '"rev-three"') : json({ ...existing, definition: (call.body as { definition: Agent["definition"] }).definition, revision: "rev-six", revisions: 6 }, 200, '"rev-six"'));
    expect(writes()).toEqual([]);
    expect(button("Send request").disabled).toBe(true);
    type(control("Instructions"), "Answer carefully and include citations.");
    await send();
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe("/v2/agents/support%2Fa/definition");
    expect(writes()[0].headers.get("if-match")).toBe('"rev-three"');
    expect(writes()[0].body).toEqual({ definition: { ...existing.definition, version: 6, instructions: "Answer carefully and include citations." } });
    expect(button("Send request").disabled).toBe(true);
    type(control("Instructions"), "Answer with citations and confidence.");
    await send();
    expect(writes()[1].headers.get("if-match")).toBe('"rev-six"');
    expect((writes()[1].body as { definition: Agent["definition"] }).definition.version).toBe(7);
  });

  it.each([
    ["note", { note: 12 }],
    ["harness", { definition: { ...existing.definition, harness: { id: "pi" } } }],
    ["model", { definition: { ...existing.definition, model: ["model-id"] } }],
    ["description", { definition: { ...existing.definition, description: { text: "Support" } } }],
  ])("keeps malformed %s JSON editable without crashing the form or sending it", async (name, change) => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, () => json(existing, 200, '"rev-three"'));
    await act(async () => button("JSON").click());
    const raw = JSON.stringify({ definition: existing.definition, ...change });
    type(control("Request JSON"), raw);
    expect(button("Send request").disabled).toBe(true);
    expect(host.textContent).toContain(`${name} must be a string`);
    await act(async () => button("Form").click());
    expect(control("Request JSON").value).toBe(raw);
    await send();
    expect(writes()).toEqual([]);
    type(control("Request JSON"), JSON.stringify({ definition: { ...existing.definition, instructions: "Corrected instructions." } }));
    await act(async () => button("Form").click());
    expect(control("Instructions").value).toBe("Corrected instructions.");
    expect(button("Send request").disabled).toBe(false);
  });

  it("saves changed skill files as the next revision even when the definition is unchanged", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => call.method === "GET" ? json(existing, 200, '"rev-three"') : json({ ...existing, definition: (call.body as { definition: Agent["definition"] }).definition, revision: "rev-six", revisions: 6 }, 200, '"rev-six"'));
    await act(async () => button("JSON").click());
    const skills = { "support/SKILL.md": "# Support\nEscalate unanswered questions with sources." };
    type(control("Request JSON"), JSON.stringify({ definition: existing.definition, skills }));
    expect(button("Send request").disabled).toBe(false);
    await send();
    expect(writes()).toHaveLength(1);
    expect(writes()[0].headers.get("if-match")).toBe('"rev-three"');
    expect(writes()[0].body).toEqual({ definition: { ...existing.definition, version: 6 }, skills });
  });

  it("lets an edit return to the server default model", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => call.method === "GET" ? json(existing, 200, '"rev-three"') : json(existing, 200, '"rev-six"'));
    type(control("Model"), "");
    expect(button("Send request").disabled).toBe(false);
    await send();
    const definition = (writes()[0].body as { definition: Agent["definition"] }).definition;
    expect(definition).not.toHaveProperty("model");
    expect(definition.instructions).toBe(existing.definition.instructions);
    expect(definition.version).toBe(6);
  });

  it("refuses an edit if the server did not provide a revision ETag", async () => {
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, () => json(existing));
    type(control("Instructions"), "New instructions.");
    expect(button("Send request").disabled).toBe(true);
    expect(host.textContent).toContain("ETag");
    await send();
    expect(writes()).toEqual([]);
  });

  it("shows a stale conflict and reloads the latest revision only when asked", async () => {
    const newer = { ...existing, revision: "rev-six", revisions: 6, definition: { ...existing.definition, version: 6, instructions: "Another author's update.", tools: ["read"] } };
    let reads = 0;
    await mount({ operation: "edit-agent", agentId: existing.agent_id }, (call) => {
      if (call.method === "GET") return ++reads === 1 ? json(existing, 200, '"rev-three"') : json(newer, 200, '"rev-six"');
      if (writes().length === 1) return json({ error: { code: "precondition_failed", message: "The agent changed since you read it.", retryable: false } }, 412);
      return json({ ...newer, revision: "rev-seven", revisions: 7, definition: (call.body as { definition: Agent["definition"] }).definition }, 200, '"rev-seven"');
    });
    type(control("Instructions"), "My update.");
    await send();
    expect(host.textContent).toContain("precondition_failed");
    expect(reads).toBe(1);
    expect(writes()).toHaveLength(1);
    await act(async () => button("Reload current revision").click());
    expect(control("Instructions").value).toBe("Another author's update.");
    expect(writes()).toHaveLength(1);
    type(control("Instructions"), "My reviewed update.");
    await send();
    expect(writes()[1].headers.get("if-match")).toBe('"rev-six"');
    expect((writes()[1].body as { definition: Agent["definition"] }).definition).toEqual({ ...newer.definition, version: 7, instructions: "My reviewed update." });
  });

  it.each(["network", "server"])("prevents duplicate creation after an uncertain %s result", async (failure) => {
    const draft = templateAgentDraft(TEMPLATES[0]);
    await mount({ operation: "create-agent", draft: JSON.stringify(draft) }, () => {
      if (failure === "network") throw new TypeError("Connection lost");
      return json({ error: { code: "internal_error", message: "Server stopped responding", retryable: true } }, 500);
    });
    await send();
    expect(button("Send request").disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connected agents");
    await send();
    expect(writes()).toHaveLength(1);
  });
});
