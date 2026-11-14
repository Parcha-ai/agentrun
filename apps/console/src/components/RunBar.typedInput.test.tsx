import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunBar } from "./RunBar";
import type { Agent } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";

// An agentic agent with an input_schema: the run bar shows its message box (optional when the schema requires another
// field) and one field for each other property, and sends them as one typed input. A refusal's issue at input.<key> is
// said at that field; one the form has no field for is listed under the refusal. A schema it can't show as fields is
// typed as JSON, whole.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string", title: "Company", description: "Who to look into" },
    limit: { type: "integer", default: 10 },
    topics: { type: "array", items: { type: "string" } },
  },
  required: ["company"],
};
const agent = (input_schema: Record<string, unknown>): Agent => ({
  agent_id: "researcher", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Researcher", instructions: "Research.", harness: "pi", skills: [], tools: ["read"], input_schema },
});

function mount(a: Agent, refuse?: ClientError) {
  const starts: Record<string, unknown>[] = [];
  const v2 = { startRun: async (_id: string, body: Record<string, unknown>) => { starts.push(body); if (refuse) throw refuse; return { run: { run_id: "r1" }, status: 202 }; } };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunBar, { agent: a, efforts: [], v2: v2 as never, go: () => {} })));
  const set = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const at = (key: string) => host.querySelector<HTMLElement>(`[data-field="input.${key}"]`)!;
  const runButton = () => [...host.querySelectorAll("button")].find((b) => /^Run$/.test((b.textContent ?? "").trim()))!;
  const run = () => act(async () => { runButton().click(); });
  return { host, starts, set, at, run, runButton };
}

describe("RunBar, an agent with typed input", () => {
  it("shows the message as optional and one field for each property, labelled by its title else its key", () => {
    const m = mount(agent(SCHEMA));
    const message = m.host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="The run\'s message"]')!;
    expect(message.placeholder).toMatch(/optional/);
    expect(m.at("company").textContent).toContain("Company *");
    expect(m.at("company").textContent).toContain("Who to look into");
    expect(m.at("limit").textContent).toContain("limit");
    expect(m.at("topics").querySelector("textarea")).not.toBeNull();
    expect(m.runButton().disabled).toBe(false);
  });

  it("sends the message and the typed fields: a number as a number, a list a line at a time", async () => {
    const m = mount(agent(SCHEMA));
    m.set(m.host.querySelector("textarea")!, "Look into them.");
    m.set(m.at("company").querySelector("input")!, "Acme");
    m.set(m.at("limit").querySelector("input")!, "5");
    m.set(m.at("topics").querySelector("textarea")!, "pricing\nhiring");
    await m.run();
    expect(m.starts).toEqual([{ input: { content: "Look into them.", company: "Acme", limit: 5, topics: ["pricing", "hiring"] } }]);
  });

  it("sends no content for an empty optional message", async () => {
    const m = mount(agent(SCHEMA));
    m.set(m.at("company").querySelector("input")!, "Acme");
    await m.run();
    expect(m.starts).toEqual([{ input: { company: "Acme" } }]);
  });

  it("says a refusal's input.company issue at its field, lists one it has no field for, and drops the field's once it is fixed", async () => {
    const refusal = Object.assign(new ClientError(422, "input_invalid", "The run's input is not valid."), { fields: [
      { field: "input.company", reason: "missing", message: "input.company is required" },
      { field: "input.region", reason: "unknown", message: "input.region is not a field this agent takes" },
    ] });
    const m = mount(agent(SCHEMA), refusal);
    m.set(m.host.querySelector("textarea")!, "Look into them.");
    await m.run();
    expect(m.at("company").querySelector('[role="alert"]')?.textContent).toBe("Company is required.");
    const listed = [...m.host.querySelectorAll('[role="alert"]')].find((x) => x.textContent?.startsWith("The run did not start"))!;
    expect(listed.textContent).toContain("input.region: input.region is not a field this agent takes");
    expect(listed.textContent).not.toContain("input.company");
    m.set(m.at("company").querySelector("input")!, "Acme");
    expect(m.at("company").querySelector('[role="alert"]')).toBeNull();
  });

  it("types a schema it can't show as fields as the whole input in JSON, starting from its shape", async () => {
    const m = mount(agent({ type: "object", properties: { company: { type: "string" }, filters: { type: "object" } }, required: ["company"] }));
    const box = m.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="The run\'s input, as JSON"]')!;
    expect(JSON.parse(box.value)).toEqual({ company: "" });
    m.set(box, '{"company":"Acme","filters":{"since":"2026"}}');
    await m.run();
    expect(m.starts).toEqual([{ input: { company: "Acme", filters: { since: "2026" } } }]);
  });
});
