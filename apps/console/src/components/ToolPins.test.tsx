import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { ToolsPage } from "./ToolsPage";
import type { Agent } from "@/lib/agentForm";
import { pinLine } from "@/lib/toolSettings";
import type { ToolSettings } from "@/lib/v2";
import { servedAgent } from "@/test/agent";

// A tool's pin (tool_settings[tool].pin: {arg: value | [values]}) bounds its calls: one outside it is refused before it
// runs or asks. A pin that doesn't read (pin_broken) fails closed: every call is refused. Settings → Tools says the
// server's; the agent editor says the agent's own, and that the server's holds too where both pin the tool. The words are
// in the gate's canonical order (tool-gate.ts pinWords: arguments sorted, null first, then by JSON text).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = () => { const host = document.body.appendChild(document.createElement("div")); root = createRoot(host); return host; };

const REVIEW = "mcp:github/pull_request_review_write";
// code-review's pin, as written in any order.
const CODE_REVIEW = { method: ["submit_pending", "create", "delete_pending"], event: ["COMMENT", null] };
const WORDS = "event must be left out or COMMENT; method must be one of create, delete_pending, submit_pending";
const REFUSED = "Calls outside it are refused before they run or ask.";
const BROKEN = "This pin doesn't read, so every call to this tool is refused. Set the pin again, or remove the tool's setting.";

describe("a pin in words", () => {
  it("says code-review's pin in the gate's order", () => {
    expect(pinLine(CODE_REVIEW)).toBe(WORDS);
  });
  it("says one value, a lone null, and null in a list", () => {
    expect(pinLine({ channel_id: "C0123" })).toBe("channel_id must be C0123");
    expect(pinLine({ cc: null })).toBe("cc must be left out");
    expect(pinLine({ cc: [null, "a@x.test", "b@x.test"] })).toBe("cc must be left out or one of a@x.test, b@x.test");
    expect(pinLine({ limit: [10, 9] })).toBe("limit must be one of 10, 9");
  });
});

describe("pins in Settings → Tools", () => {
  async function open(held: ToolSettings) {
    const v2 = { toolSettings: async () => held, saveToolSettings: async (body: ToolSettings) => body };
    const host = mount();
    act(() => { root!.render(createElement(ToolsPage, { v2: v2 as never, choices: [], gates: [], onSaved: () => {} })); });
    await settle();
    return host;
  }

  it("says the server's pin by the tool it bounds, and a broken one as refusing every call", async () => {
    const host = await open({ [REVIEW]: { pin: CODE_REVIEW }, "mcp:slack/post_message": { pin_broken: true } } as never);
    const pins = host.querySelector('[aria-label="Pinned tools"]')!;
    const review = pins.querySelector(`[data-pin="${REVIEW}"]`)!;
    expect(review.textContent).toContain(`Pinned: ${WORDS}. ${REFUSED}`);
    expect(pins.querySelector('[data-pin="mcp:slack/post_message"]')!.textContent).toContain(BROKEN);
  });

  it("shows no pins section where nothing is pinned", async () => {
    const host = await open({ bash: { permission: "ask" } });
    expect(host.querySelector('[aria-label="Pinned tools"]')).toBeNull();
  });
});

describe("pins in the agent editor", () => {
  const ALL: ("allow" | "ask" | "deny")[] = ["allow", "ask", "deny"];
  const GITHUB = { name: "github", url: "https://mcp.example.test/mcp", auth: { type: "none" }, credential: null, protocol: "2025-06-18", server_info: null, listed_at: "2026-11-08T00:00:00Z", updated_at: "2026-11-08T00:00:00Z",
    tools: [{ name: "pull_request_review_write", input_schema: {}, permission: "ask", default_permission: "ask", permissions: ALL }] };
  const caps = { harnesses: [{ id: "pi", available: true }], tools: [], thinking: [], mcp: true, mcpHarnesses: ["pi"] };
  const agentWith = (toolSettings: Record<string, unknown>): Agent => servedAgent({
    agent_id: "reviewer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
    definition: { version: 1, name: "Reviewer", instructions: "Review it.", harness: "pi", skills: [], tools: [REVIEW], tool_settings: toolSettings as never },
  });
  async function open(agent: Agent, serverToolSettings?: ToolSettings) {
    const host = mount();
    act(() => root!.render(createElement(AgentEditor, { agent, caps, mcpServers: [GITHUB] as never, step: "tools", serverToolSettings, onSave: async () => null })));
    await settle();
    return host.querySelector(`section[aria-label="Tool settings"]`)!;
  }

  it("says the agent's own pin, and that the server's holds too where it also pins the tool", async () => {
    const section = await open(agentWith({ [REVIEW]: { pin: CODE_REVIEW } }), { [REVIEW]: { pin: { event: "COMMENT" } } } as never);
    expect(section.textContent).toContain(`Pinned for this agent: ${WORDS}. ${REFUSED}`);
    expect(section.textContent).toContain("This server pins it too; both hold.");
  });

  it("says nothing of the server where only the agent pins it", async () => {
    const section = await open(agentWith({ [REVIEW]: { pin: CODE_REVIEW } }), {});
    expect(section.textContent).toContain(`Pinned for this agent: ${WORDS}.`);
    expect(section.textContent).not.toContain("This server pins it too");
  });

  it("says a broken pin refuses every call", async () => {
    const section = await open(agentWith({ [REVIEW]: { pin_broken: true } }));
    expect(section.textContent).toContain(BROKEN);
  });
});
