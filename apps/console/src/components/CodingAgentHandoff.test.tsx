import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CodingAgentHandoff } from "./CodingAgentHandoff";
import { codingAgentPrompt } from "@/lib/codingAgentHandoff";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); history.replaceState(null, "", "/"); document.body.innerHTML = ""; });

it.each([
  ["https://server.example", "https://server.example", ""],
  ["", location.origin, ""],
  ["https://server.example/proxy/v2/", "https://server.example/proxy/v2", "/proxy/v2"],
  ["https://server.example/native-api/", "https://server.example/native-api", "/native-api"],
  ["/native-api", `${location.origin}/native-api`, "/native-api"],
  ["native-api", `${location.origin}/console/native-api`, "/console/native-api"],
])("carries the pinned operation at %s without URL credentials", (endpoint, api, path) => {
  history.replaceState(null, "", "/console/");
  const address = new URL(endpoint, location.href);
  address.username = "owner"; address.password = "secret";
  address.search = "?token=private"; address.hash = "credential";
  const source = endpoint.startsWith("https:") ? address.href : endpoint ? `${endpoint}${address.search}${address.hash}` : "";
  const prompt = codingAgentPrompt({ kind: "run", agentId: "citer /", revision: "r1", input: { content: "Check this." } }, source);
  const context = JSON.parse(prompt.split("```json\n")[1].split("\n```")[0]);
  expect(context).toEqual({ server: api, operation: `POST ${path}/agents/citer%20%2F/runs`, agent_id: "citer /", revision: "r1", request: { input: { content: "Check this." }, revision: "r1" } });
  expect(prompt).toContain(`${api}/openapi.json`);
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
    const picker = host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Application"]')!;
    expect(picker).toBeTruthy();
    act(() => picker.click());
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Claude Code app", "Claude Code CLI", "Codex app", "Codex CLI"]);
    act(() => options.find((option) => option.textContent === "Codex CLI")!.click());
    act(() => button(/^Close$/).click());
    render("second");
    act(() => button(/^Use your coding agent$/).click());
    expect(host.querySelector('[role="combobox"][aria-label="Application"]')!.textContent).toContain("Codex CLI");
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
