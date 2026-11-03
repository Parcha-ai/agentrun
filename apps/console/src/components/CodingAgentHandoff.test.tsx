import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CodingAgentHandoff } from "./CodingAgentHandoff";
import { codingAgentPrompt } from "@/lib/codingAgentHandoff";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

it("carries the pinned native operation and input, with a credential-free server origin", () => {
  const address = new URL("https://server.example/console?token=private#credential");
  address.username = "owner"; address.password = "secret";
  const prompt = codingAgentPrompt({ kind: "run", agentId: "citer", revision: "r1", input: { content: "Check this." } }, address.href);
  const context = JSON.parse(prompt.split("```json\n")[1].split("\n```")[0]);
  expect(context).toEqual({ server: "https://server.example/v2", operation: "POST /v2/agents/citer/runs", agent_id: "citer", revision: "r1", request: { input: { content: "Check this." }, revision: "r1" } });
  for (const secret of ["owner:", "secret", "token=private", "#credential"]) expect(prompt).not.toContain(secret);
});

it("remembers the distinct CLI destination and leaves an editable, selectable prompt after clipboard failure", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const context = { kind: "edit" as const, agentId: "citer", revision: "r1" };
  const render = (key: string) => act(() => root.render(createElement(CodingAgentHandoff, { key, context })));
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!;
  try {
    render("first");
    act(() => button(/^Use your coding agent$/).click());
    const picker = host.querySelector("select")!;
    expect([...picker.options].map((o) => o.text)).toEqual(["Claude Code app", "Claude Code CLI", "Codex app", "Codex CLI"]);
    act(() => { picker.value = "codex-cli"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    act(() => button(/^Close$/).click());
    render("second");
    act(() => button(/^Use your coding agent$/).click());
    expect(host.querySelector("select")!.value).toBe("codex-cli");
    const text = host.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(text, "Review this agent before revising.");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(/^Copy prompt$/).click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Review this agent before revising.");
    expect(document.activeElement).toBe(text);
    expect(text.selectionEnd).toBe(text.value.length);
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
  } finally { act(() => root.unmount()); host.remove(); }
});
