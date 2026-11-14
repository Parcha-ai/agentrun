import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground, startFailure } from "./Playground";
import { agentFixture } from "@/fixtures";
import { ClientError } from "@/lib/client";
import { pick, picker } from "@/test/picker";

// The playground for an agent with an input_schema: the form shows its fields, and the request it shows (its JSON, its
// cURL and its JavaScript) carries the typed input. A schema the form can't show is typed as JSON, whole.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const SCHEMA = {
  type: "object",
  properties: { company: { type: "string", title: "Company" }, limit: { type: "integer" }, topics: { type: "array", items: { type: "string" } } },
  required: ["company"],
};
const typed = (input_schema: Record<string, unknown>) => { const base = agentFixture("invoice-checker"); return { ...base, agent_id: "researcher", definition: { ...base.definition, input_schema } }; };

function mount(input_schema: Record<string, unknown>, result?: ReturnType<typeof startFailure>, revisions?: { revision: string; version: number; current: boolean; note: string | null; definition?: Record<string, unknown> }[]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Playground, { agents: [typed(input_schema)], efforts: [], origin: "http://serve.test", agentId: "researcher", ...(result ? { result } : {}), ...(revisions ? { revisions } : {}) })));
  const set = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const at = (key: string) => host.querySelector<HTMLElement>(`[data-field="input.${key}"]`)!;
  const tab = (label: string) => act(() => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!.click(); });
  return { host, set, at, tab };
}

describe("Playground, an agent with typed input", () => {
  it("shows the typed body in the code pane, as cURL and as JavaScript, and in the JSON view", () => {
    const m = mount(SCHEMA);
    m.set(m.at("company").querySelector("input")!, "Acme");
    m.set(m.at("limit").querySelector("input")!, "5");
    m.set(m.at("topics").querySelector("textarea")!, "pricing\nhiring");
    const code = () => [...m.host.querySelectorAll("pre")].map((p) => p.textContent).join("\n");
    expect(code()).toContain(`'{"input":{"company":"Acme","limit":5,"topics":["pricing","hiring"]}}'`);
    m.tab("JavaScript");
    expect(code()).toContain('"limit": 5');
    m.tab("JSON");
    expect(JSON.parse(m.host.querySelector("pre")!.textContent!)).toEqual({ input: { company: "Acme", limit: 5, topics: ["pricing", "hiring"] } });
  });

  it("says a refusal's input.company issue at its field", async () => {
    const refusal = Object.assign(new ClientError(422, "input_invalid", "The run's input is not valid."), { fields: [{ field: "input.company", reason: "missing", message: "input.company is required" }] });
    const m = mount(SCHEMA, startFailure(refusal, 5));
    expect(m.at("company").querySelector('[role="alert"]')?.textContent).toBe("Company is required.");
  });

  it("types a schema it can't show as fields as the whole input in JSON", () => {
    const m = mount({ type: "object", properties: { rows: { type: "array", items: { type: "object" } } }, required: ["rows"] });
    const box = m.host.querySelector("textarea")!;
    expect(JSON.parse(box.value)).toEqual({ rows: [] });
    m.set(box, '{"rows":[{"a":1}]}');
    expect(m.host.textContent).toContain(`'{"input":{"rows":[{"a":1}]}}'`);
  });

  it("draws the fields of the revision picked, not the current one's, and starts them again on a change", async () => {
    const CURRENT = { type: "object", properties: { account: { type: "string" } }, required: ["account"] };
    const base = typed(CURRENT).definition;
    const m = mount(CURRENT, undefined, [
      { revision: "rev-2", version: 2, current: true, note: null, definition: { ...base, input_schema: CURRENT } },
      { revision: "rev-1", version: 1, current: false, note: null, definition: { ...base, input_schema: SCHEMA } },
    ]);
    expect([!!m.at("account"), !!m.at("company")]).toEqual([true, false]);
    await pick(picker(m.host, "Revision")!, "rev-1");
    expect([!!m.at("account"), !!m.at("company")]).toEqual([false, true]);
    m.set(m.at("company").querySelector("input")!, "Acme");
    expect(m.host.textContent).toContain(`'{"input":{"company":"Acme"},"revision":"rev-1"}'`);
  });
});
