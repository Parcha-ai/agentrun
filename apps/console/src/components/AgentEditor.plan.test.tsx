import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { modelLabel } from "@/lib/models";
import { optionsOf, picker } from "@/test/picker";

// A server signed in to a ChatGPT plan offers the plan's models by name and by who pays ("gpt-6.1-sol · ChatGPT plan",
// ref chatgpt/<id>), beside a key's models as they were; and the spend cap says it counts dollars, which a plan's
// requests are not.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: (() => void)[] = [];
afterEach(() => { roots.splice(0).forEach((u) => u()); document.body.innerHTML = ""; });

const NOTE = "Counts dollars. Requests on your ChatGPT plan cost no dollars here; your plan's own limits apply.";
const tools = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }];
const onPlan = { harnesses: [{ id: "codex", available: true, default_model: "chatgpt/gpt-6.1-sol", models: ["chatgpt/gpt-6.1-sol", "chatgpt/gpt-6-luna", "openai/gpt-6.1-sol"] }], tools, thinking: [] };
const keysOnly = { harnesses: [{ id: "codex", available: true, default_model: "openai/gpt-6.1-sol", models: ["openai/gpt-6.1-sol"] }], tools, thinking: [] };
const agent = { agent_id: "a", kind: "agentic" as const, revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "A", instructions: "Do.", harness: "codex", skills: [], tools: ["read"] } };

function mount(caps: unknown) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(createElement(AgentEditor, { agent, caps, step: "settings" } as never)));
  roots.push(() => act(() => root.unmount()));
  return host;
}
const described = (host: HTMLElement, id: string) => host.querySelector(`#${id}`)?.getAttribute("aria-describedby")?.split(" ").map((d) => document.getElementById(d)?.textContent ?? "").join(" ") ?? "";

describe("the model picker and the spend cap on a ChatGPT plan", () => {
  it("names a plan model by its id and the plan, and a key's model as it was", () => {
    expect(modelLabel("chatgpt/gpt-6.1-sol", null).text).toBe("gpt-6.1-sol · ChatGPT plan");
    expect(modelLabel("chatgpt/gpt-6.1-sol", null).title).toBe("chatgpt/gpt-6.1-sol");
    expect(modelLabel("openai/gpt-6.1-sol", null).text).toBe("openai/gpt-6.1-sol");
  });

  it("the picker lists the plan's models as the plan's, beside the key's, and its default as the plan's", async () => {
    const host = mount(onPlan);
    const options = await optionsOf(picker(host, "Model")!);
    expect(options.map((o) => [o.text, o.value])).toEqual([
      ["Server default (gpt-6.1-sol · ChatGPT plan)", ""],
      ["gpt-6.1-sol · ChatGPT plan", "chatgpt/gpt-6.1-sol"],
      ["gpt-6-luna · ChatGPT plan", "chatgpt/gpt-6-luna"],
      ["openai/gpt-6.1-sol", "openai/gpt-6.1-sol"],
      ["Custom...", "custom"],
    ]);
  });

  it("the spend cap says it counts dollars, on a server with a plan", () => {
    expect(described(mount(onPlan), "agent-max-cost")).toContain(NOTE);
    expect(described(mount(keysOnly), "agent-max-cost")).not.toContain("ChatGPT");
  });
});
