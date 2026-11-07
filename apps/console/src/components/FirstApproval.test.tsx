import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { ApprovalCard } from "./ApprovalCard";
import { NeedsYouStrip } from "./NeedsYouStrip";
import { ToolsPage } from "./ToolsPage";
import type { Agent } from "@/lib/agentForm";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { PendingApproval, Run, ToolSettings } from "@/lib/v2";

// A first-time user's approval path: the card's Allow says it is for this call only; a call's arguments read as a list,
// not as JSON; a tool's description in the agent editor stays two lines until asked for more; Settings → Tools puts each
// tool's permission beside its name.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const mount = (el: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttons = (host: Element) => [...host.querySelectorAll("button")].map((b) => b.textContent);

const PENDING: PendingApproval = { kind: "approval", id: "ap_1", tool: "web_fetch", call_id: "c1", args_preview: "{\"url\":\"https://example.com/\",\"max_chars\":4000,\"headers\":{\"accept\":\"text/html\"}}", requested_at: "2026-11-05T10:00:00.000Z" };

describe("the approval card's Allow", () => {
  it("reads Allow once on the run page's card and on Mission Control's", () => {
    const card = mount(createElement(ApprovalCard, { pending: PENDING, onAnswer: async () => null }));
    expect(buttons(card)).toEqual(["Allow once", "Deny"]);
    act(() => root?.unmount());
    const run: Run = { run_id: "r1", agent_id: "a", agent_version: 1, revision: "rv", kind: "agentic", status: "input_required", state: "waiting", title: "T", created_at: "2026-11-05T10:00:00Z", ended_at: null, result: null, error: null, cost: null, archived_at: null, pending: PENDING };
    const strip = mount(createElement(NeedsYouStrip, { asking: [run], failed: [], live: [], agentName: () => "A", onAnswer: async () => null, onApprove: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null }));
    expect(buttons(strip.querySelector("section[aria-label='Approval required']")!)).toEqual(["Allow once", "Deny"]);
  });
});

describe("the call's arguments", () => {
  it("read as one key: value line each, a string unquoted, a nested value as JSON; the whole arguments one hover away", () => {
    const card = mount(createElement(ApprovalCard, { pending: PENDING, onAnswer: async () => null }));
    const args = card.querySelector("pre")!;
    expect(args.textContent).toBe("url: https://example.com/\nmax_chars: 4000\nheaders: {\"accept\":\"text/html\"}");
    expect(args.getAttribute("title")).toBe(PENDING.args_preview);
  });

  it("a preview the server cut (not whole JSON) is shown as it came", () => {
    const cut = `{"query":"${"x".repeat(30)}…`;
    const card = mount(createElement(ApprovalCard, { pending: { ...PENDING, args_preview: cut }, onAnswer: async () => null }));
    expect(card.querySelector("pre")!.textContent).toBe(cut);
  });
});

describe("a tool's description in the agent editor", () => {
  const LONG = "Read one public web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked (falling back to the direct fetch, saying why, when Parallel answers no page), a part at a time.";
  const agent: Agent = { agent_id: "a1", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "A", instructions: "x", harness: "pi", skills: [], tools: [] } };
  const caps = { harnesses: [{ id: "pi", available: true }], tools: [{ name: "web_fetch", available: true, summary: LONG }], thinking: [] };
  it("is clamped to two lines (no display override), with more to show it whole", async () => {
    const host = mount(createElement(AgentEditor, { agent, caps, step: "tools", onSave: async () => null }));
    await settle();
    const text = [...host.querySelectorAll("span")].find((s) => s.textContent === LONG)!;
    expect(text.classList.contains("line-clamp-2")).toBe(true);
    expect(text.classList.contains("block")).toBe(false);
    const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "more")!;
    expect(more).toBeTruthy();
    await act(async () => { more.click(); });
    expect(text.classList.contains("line-clamp-2")).toBe(false);
    // Asking for more never ticks the tool.
    expect(host.querySelector<HTMLInputElement>("input[value='web_fetch']")!.checked).toBe(false);
  });
});

describe("Settings → Tools", () => {
  it("puts each tool's permission right after its name: Tool | Permission | Provider | Resolves to", async () => {
    const raw = [{ name: "web_fetch", available: true, providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", resolves: { pi: "kernel" }, permission: "allow", default_permission: "allow", permissions: ["allow", "ask", "deny"] }];
    const v2 = { toolSettings: async (): Promise<ToolSettings> => ({ web_fetch: { provider: "kernel" } }), saveToolSettings: async (b: ToolSettings) => b };
    const host = mount(createElement(ToolsPage, { v2: v2 as never, choices: toolChoices(raw), gates: toolGates(raw), onSaved: () => {} }));
    await settle();
    expect([...host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Tool", "Permission", "Provider", "Resolves to", "Reset"]);
    const cells = host.querySelectorAll("tr[data-tool='web_fetch'] td");
    expect(cells[1]!.querySelector("button[aria-haspopup=listbox]")!.getAttribute("aria-label")).toBe("web_fetch permission");
    expect(cells[2]!.querySelector("button[aria-haspopup=listbox]")!.getAttribute("aria-label")).toBe("web_fetch provider");
  });
});
