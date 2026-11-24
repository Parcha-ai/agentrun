import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRequest } from "./AgentRequest";
import { AgentEditor, type EditorCaps } from "./AgentEditor";
import { BuildAgent } from "./BuildAgent";
import { agentDraftHref, briefAgentDraft } from "@/lib/agentDraft";
import { createClient } from "@/lib/client";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import { optionsOf, pick, picker, valueOf } from "@/test/picker";

// The API playground's agent requests (POST · Create an agent, PUT · Edit agent) name the agent's model with the
// editor's own Model picker: the models the server offers for the form's harness (capabilities' harnesses[].models), the
// server default first and Custom... last, the free-text box only once Custom... is picked, and a model the harness
// can't run refused at the field in the same words the editor shows.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const origin = "https://console.example.test";
const CUSTOM = "custom";
const harnesses: EditorCaps["harnesses"] = [
  { id: "pi", available: true, default_model: "anthropic/claude-sonnet-5-5", models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"] },
  { id: "codex", available: true, default_model: "openai/gpt-6.1-sol", models: ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-luna"] },
];
// The server's refusal of a model named in a form pi doesn't take (serve's validate.ts, modelFormIssue).
const REFUSAL = 'On pi, a model is <provider>/<model id>, like anthropic/claude-sonnet-5-5 or openrouter/anthropic/claude-sonnet-5.5: "Sonnet 5.5" is not one. Did you mean anthropic/claude-sonnet-5-5?';
const agentOn = (harness: string, model?: string): Agent => ({ ...SERVED_AGENT, agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness, skills: [], tools: [], ...(model ? { model } : {}) } });
const json = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });

type Call = { path: string; method: string; body: unknown };
let root: Root | undefined;
let host: HTMLDivElement;
let calls: Call[];
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); });

const mount = async (props: Omit<ComponentProps<typeof AgentRequest>, "v2" | "origin">, answer: (call: Call) => Response | Promise<Response>) => {
  calls = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { path: new URL(url, origin).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(AgentRequest, { ...props, origin, v2: createClient({ fetch }) })));
};
/** The Model field, which must be a picker. */
const model = () => { const field = picker(host, "Model"); expect(field, "the Model field is a picker").not.toBeNull(); return field!; };
const custom = () => host.querySelector<HTMLInputElement>('input[aria-label="Custom model"]');
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const send = () => act(async () => button("Send request").click());
const sent = () => (calls.filter((c) => c.method !== "GET").at(-1)?.body as { definition: Agent["definition"] } | undefined)?.definition;
/** What the page says at a field: the alerts of the Field whose label names its control. */
const said = (field: HTMLElement) => {
  const label = [...document.querySelectorAll("label")].find((l) => field.id && l.htmlFor === field.id);
  expect(label, "the field has its label").not.toBeNull();
  const box = label!.parentElement!.parentElement!;
  return [...box.querySelectorAll(':scope > [role="alert"]')].map((e) => e.textContent);
};
const blankDraft = JSON.stringify(briefAgentDraft("Answer support questions."));

describe("the playground's Create an agent, the Model field", () => {
  it("lists the draft harness's models, the server default first and Custom... last, with no free-text box until Custom... is picked", async () => {
    await mount({ operation: "create-agent", draft: blankDraft, harnesses }, () => json({}, 500));
    expect(model(), "a Model picker").not.toBeNull();
    expect(custom(), "no free-text box").toBeNull();
    expect(model()!.textContent).toContain("Server default (anthropic/claude-sonnet-5-5)");
    const options = await optionsOf(model()!);
    expect(options.map((o) => o.value)).toEqual(["", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "openai/gpt-6.1-sol", CUSTOM]);
    expect(options.at(-1)?.text).toBe("Custom...");
    await pick(model()!, CUSTOM);
    expect(custom(), "Custom... opens the box").not.toBeNull();
    expect(custom()!.placeholder).toBe("provider/model");
  });

  it("a listed model picked is the request's model", async () => {
    await mount({ operation: "create-agent", draft: blankDraft, harnesses }, (call) => json({ ...agentOn("pi"), definition: { ...agentOn("pi").definition, ...(call.body as { definition: object }).definition } }, 201));
    await pick(model()!, "anthropic/claude-opus-5-5");
    expect(valueOf(model()!)).toBe("anthropic/claude-opus-5-5");
    await send();
    expect(sent()?.model).toBe("anthropic/claude-opus-5-5");
  });

  it("the list follows the harness the form has: codex's models, not pi's", async () => {
    await mount({ operation: "create-agent", draft: blankDraft, harnesses }, () => json({}, 500));
    await pick(picker(host, "Harness")!, "codex");
    expect((await optionsOf(model()!)).map((o) => o.value)).toEqual(["", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-luna", CUSTOM]);
  });

  it("a model the harness can't run is refused at the Model field, in the editor's words, until the model changes", async () => {
    await mount({ operation: "create-agent", draft: blankDraft, harnesses }, () => json({ error: { code: "invalid_request", message: "The definition is not valid.", retryable: false, fields: [{ field: "definition.model", reason: "bad_format", message: REFUSAL }] } }, 422));
    await pick(model()!, CUSTOM);
    await type(custom()!, "Sonnet 5.5");
    await send();
    expect(sent()?.model).toBe("Sonnet 5.5");
    expect(said(model()!)).toEqual([REFUSAL]);
    // The editor, given the same refusal, says the same words at its Model field.
    const editorHost = document.body.appendChild(document.createElement("div"));
    const editor = createRoot(editorHost);
    await act(async () => editor.render(createElement(AgentEditor, { agent: agentOn("pi", "Sonnet 5.5"), caps: { harnesses, tools: [], thinking: [] }, step: "settings", problem: { kind: "invalid", message: "The definition is not valid.", fields: { "definition.model": REFUSAL } } })));
    expect(said(picker(editorHost, "Model")!)).toEqual(said(model()!));
    act(() => editor.unmount());
    await pick(model()!, "anthropic/claude-sonnet-5-5");
    expect(said(model()!), "a changed model is not the refused one").toEqual([]);
  });

  // The server's words depend on the harness ("On pi, a model is ..."): they belong to the harness and model sent.
  const refused = () => json({ error: { code: "invalid_request", message: "The definition is not valid.", retryable: false, fields: [{ field: "definition.model", reason: "bad_format", message: REFUSAL }] } }, 422);
  const harness = () => picker(host, "Harness")!;

  it("a refusal said on pi is not shown once the harness is codex, the model the same; back on pi it is", async () => {
    await mount({ operation: "create-agent", draft: blankDraft, harnesses }, refused);
    await pick(model(), CUSTOM);
    await type(custom()!, "Sonnet 5.5");
    await send();
    expect(said(model())).toEqual([REFUSAL]);
    await pick(harness(), "codex");
    expect(custom()?.value, "the model is still the one refused").toBe("Sonnet 5.5");
    expect(said(model()), "pi's words, not codex's").toEqual([]);
    await pick(harness(), "pi");
    expect(said(model()), "the harness and model sent").toEqual([REFUSAL]);
  });

  it("a refusal that arrives after the harness changed is not shown at the field", async () => {
    let answer: ((response: Response) => void) | undefined;
    await mount({ operation: "create-agent", draft: blankDraft, harnesses }, (call) => call.method === "POST" ? new Promise<Response>((resolve) => { answer = resolve; }) : json({}, 500));
    await pick(model(), CUSTOM);
    await type(custom()!, "Sonnet 5.5");
    await send();
    expect(sent()?.harness ?? "pi", "sent on pi").toBe("pi");
    expect(answer, "the request is waiting for its answer").toBeDefined();
    await pick(harness(), "codex");
    await act(async () => answer!(refused()));
    expect(said(model()), "said of pi, the form on codex").toEqual([]);
    await pick(harness(), "pi");
    expect(said(model()), "the harness and model sent").toEqual([REFUSAL]);
  });
});

describe("the playground's Edit agent, the Model field", () => {
  it("lists the agent's harness's models and opens on its model", async () => {
    await mount({ operation: "edit-agent", agentId: "calc", harnesses }, () => json(agentOn("codex", "openai/gpt-6-luna"), 200, '"r1"'));
    expect(custom()).toBeNull();
    expect(valueOf(model()!)).toBe("openai/gpt-6-luna");
    expect((await optionsOf(model()!)).map((o) => o.value)).toEqual(["", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-luna", CUSTOM]);
  });

  it("an agent on a model its harness's list lacks opens on Custom..., its model in the box", async () => {
    await mount({ operation: "edit-agent", agentId: "calc", harnesses }, () => json(agentOn("pi", "anthropic/claude-sonnet-5.5"), 200, '"r1"'));
    expect(valueOf(model()!)).toBe(CUSTOM);
    expect(custom()?.value).toBe("anthropic/claude-sonnet-5.5");
  });
});

describe("Build's blank agent", () => {
  it("still opens the playground's Create an agent", async () => {
    host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
    await act(async () => root!.render(createElement(BuildAgent, { origin, v2: { listTemplates: async () => ({ templates: [] }), listMarketplaceTemplates: async () => ({ url: null, state: "off" as const, read_at: null, templates: [] }) } })));
    const href = [...host.querySelectorAll("a")].find((a) => a.textContent === "start from a blank agent")!.getAttribute("href")!;
    expect(href.startsWith("#/playground?operation=create-agent")).toBe(true);
    expect(href).toBe(agentDraftHref(briefAgentDraft("")));
  });
});
